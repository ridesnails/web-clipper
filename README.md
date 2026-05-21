# Web Clipper

一个跑在 Cloudflare Workers 上的极简网页剪藏服务，把任意网页变成一篇带 frontmatter 的 Markdown 笔记，自动写入你的 Obsidian Vault（通过 [Fast Note Sync Service](https://github.com/haierkeys/fast-note-sync-service)）。

**核心理念**：轻量、可靠、零运维。整套服务跑在 Cloudflare 免费版上，不需要任何 always-on 服务器。

## 特性

- 🪶 **轻量** —— 单文件 Worker，约 150 行 JavaScript，无队列、无数据库、无依赖服务
- 🆓 **零成本** —— 完全跑在 Cloudflare Workers / Jina Reader / FNS 的免费层
- 🌐 **多入口** —— iOS Shortcut、浏览器 Bookmarklet、curl、任何能发 HTTP 请求的客户端
- 📝 **真·主存储** —— 笔记直接进 FNS，通过 Obsidian 实时同步到所有设备
- 🔒 **私有部署** —— Token 走 Cloudflare Secrets 加密存储，源站只暴露 Worker 公网地址
- ⚡ **快** —— 单次剪藏典型耗时 3-8 秒（取决于源站响应速度）

## 工作原理

```
┌──────────────────────┐
│  iOS Shortcut /      │
│  Browser Bookmarklet │  ──── POST {url: "..."} ────┐
│  curl / Telegram     │                              │
└──────────────────────┘                              ▼
                                          ┌──────────────────────┐
                                          │  Cloudflare Worker   │
                                          │  (web-clipper)       │
                                          │                      │
                                          │  1. 鉴权             │
                                          │  2. 调 Jina Reader   │──── GET r.jina.ai/<url>
                                          │  3. 抽标题/清理正文   │
                                          │  4. 拼 frontmatter    │
                                          │  5. POST 到 FNS      │──── POST /api/note
                                          └──────────────────────┘             │
                                                                                ▼
                                                                ┌──────────────────────┐
                                                                │  Fast Note Sync       │
                                                                │  Service (FNS)        │
                                                                │                       │
                                                                │  写入 Obsidian Vault  │
                                                                │  WebSocket 推送到     │
                                                                │  所有在线设备         │
                                                                └──────────────────────┘
```

## 输出格式

每次剪藏在 FNS Vault 的 `Clippings/YYYY-MM/` 目录下生成一个 Markdown 文件：

```markdown
---
title: "服务器与网站的开荒入坑"
url: https://blog.huan666.de/posts/server-website-getting-started
date: 2026-05-14T15:18:39.538Z
source: clipper
---

（jina 抽取出的正文 markdown，元信息头已剥离）
```

## API

### `POST /`

唯一端点。请求剪藏一个 URL。

**Headers**

| Name | Required | Description |
|---|---|---|
| `Authorization` | ✅ | `Bearer <API_KEY>` |
| `Content-Type` | ✅ | `application/json` |

**Body**

```json
{
  "url": "https://example.com/article"
}
```

**Response（成功）**

```json
{
  "ok": true,
  "title": "Article Title",
  "path": "Clippings/2026-05/Article-Title.md"
}
```

**Response（失败）**

非 2xx 状态码 + 文本错误信息。常见状态码：

- `400` —— 请求格式错误（URL 缺失、不是 http/https）
- `401` —— `API_KEY` 错误或缺失
- `502` —— Jina 抓取失败 / FNS 写入失败（详细信息在 `wrangler tail` 日志里）

## 客户端接入示例

### iOS Shortcut

「快捷指令」app → 新建 → 添加「获取 URL 内容」动作：

- URL：`https://web-clipper.<your>.workers.dev`
- Method：`POST`
- Body 类型：JSON，字段 `url` = 「快捷指令输入」
- Headers：
  - `Authorization`: `Bearer <your-api-key>`
  - `Content-Type`: `application/json`

启用「在分享菜单中显示」，接受类型勾选「URL」。从 Safari 分享菜单一键剪藏。

### 浏览器 Bookmarklet

把以下代码保存为浏览器书签（替换 `WORKER_URL` 和 `API_KEY`）：

```javascript
javascript:(function(){const u=location.href;fetch('WORKER_URL',{method:'POST',headers:{'Authorization':'Bearer API_KEY','Content-Type':'application/json'},body:JSON.stringify({url:u})}).then(r=>r.json()).then(d=>{alert(d.ok?'✓ 已剪藏: '+d.title:'✗ 失败: '+JSON.stringify(d))}).catch(e=>alert('✗ 错误: '+e.message))})();
```

### curl

```bash
curl -X POST https://web-clipper.<your>.workers.dev \
  -H "Authorization: Bearer <your-api-key>" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com"}'
```

## 部署

参见 [DEPLOYMENT.md](./DEPLOYMENT.md)。

## 设计取舍

这套系统刻意做了几个反直觉的简化：

- **没有队列、没有数据库、没有状态机** —— 个人单用户场景下 QPS ≈ 0，引入这些只增加复杂度，FNS 自己已经有完整的存储和同步层
- **抓取在客户端 + Jina Reader 兜底** —— 不在服务端跑 Chromium / SingleFile，避开了 Worker 不能跑 CLI 的限制
- **LLM 增强不在 pipeline 里** —— FNS 原生支持 MCP，AI 增强（摘要、自动打标）应该在客户端通过 MCP 异步进行，而不是阻塞剪藏主链路
- **HTML 高保真存档不做** —— 个人剪藏场景下"高保真存档"通常是仓鼠症，回看率极低；如果将来真需要，可由 FNS 的附件同步 + Git 自动提交免费提供

## 致谢

- [Jina Reader](https://jina.ai/reader/) —— URL → Markdown 的事实标准
- [Fast Note Sync Service](https://github.com/haierkeys/fast-note-sync-service) —— 让 Obsidian 真正可编程

## License

MIT
