# Web Clipper

一个跑在 Cloudflare Workers 上的极简网页剪藏服务，把任意网页变成一篇带 frontmatter 的 Markdown 笔记，自动写入你的 Obsidian Vault（通过 [Fast Note Sync Service](https://github.com/haierkeys/fast-note-sync-service)）。

**核心理念**：轻量、可靠、零运维。整套服务跑在 Cloudflare 免费版上，不需要任何 always-on 服务器。

## 特性

- 🪶 **轻量** —— 3 个核心源码模块（入口 + Telegraph + Telegram），无队列、无数据库、无依赖服务
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
summary: "一段可选 AI 摘要"
---

# 服务器与网站的开荒入坑

> [!abstract] ✨ 摘要
> 一段可选 AI 摘要

> [!info] 📌 信息
> - **来源**：[blog.huan666.de](https://blog.huan666.de/posts/server-website-getting-started)
> - **时间**：2026-05-14T15:18:39.538Z
> - **链接**：[原文链接](https://blog.huan666.de/posts/server-website-getting-started)

## 📄 正文

（jina 抽取出的正文 markdown，元信息头已剥离）
```

## API

### `POST /`

唯一端点。请求剪藏一个 URL。

**Headers**

| Name            | Required | Description        |
| --------------- | -------- | ------------------ |
| `Authorization` | ✅       | `Bearer <API_KEY>` |
| `Content-Type`  | ✅       | `application/json` |

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
	"path": "Clippings/2026-05/Article-Title.md",
	"telegraphUrl": "https://telegra.ph/Article-Title-05-21",
	"telegramMessageId": 123
}
```

- `telegraphUrl` 和 `telegramMessageId` 仅在配置了 Telegraph + Telegram 环境变量且推送成功时返回。若未配置或推送失败，这两个字段不存在。

**Response（失败）**

非 2xx 状态码 + JSON 错误信息 `{ "error": "..." }`。常见状态码：

- `400` —— 请求格式错误（URL 缺失、不是 http/https）
- `401` —— `API_KEY` 错误或缺失
- `502` —— Jina 抓取失败 / FNS 写入失败（详细信息在 `wrangler tail` 日志里）

**CORS 支持**

所有响应均包含 CORS 头，支持浏览器 Bookmarklet 直接调用：

- `Access-Control-Allow-Origin: *`
- `Access-Control-Allow-Methods: POST, OPTIONS`
- `Access-Control-Allow-Headers: Authorization, Content-Type`

Worker 会自动处理 `OPTIONS` 预检请求，无需客户端额外配置。

**其他行为**

- `GET /favicon.ico` —— 返回 `204 No Content`（避免浏览器请求图标时产生 404 噪音）

### Telegraph 与 Telegram 推送

当 Worker 同时配置了 `TELEGRAPH_ACCESS_TOKEN`、剪藏通知 Bot（`CLIP_BOT` + `USER_ID`，兼容旧 `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`）时，FNS 写入成功后 Worker 会自动：

1. 将 Markdown 正文转换为 Telegraph Node 格式
2. 调用 Telegraph `createPage` 创建可阅读的在线页面
3. 通过剪藏通知 Bot 发送消息到指定用户/频道/群组，消息包含：
   - Telegraph 链接（放在首行，并通过 `link_preview_options.url` 强制即时预览）
   - 页面标题
   - AI 摘要（如果已配置 AI）
   - 原文链接
   - AI 标签（如果已生成）

**图片处理**：Telegraph 原生图片上传已废弃。Worker 会将文章中的图片通过图片 Bot（优先 `IMG_BOT`，兼容旧 `TELEGRAM_BOT_TOKEN`；聊天目标优先 `IMG_CHAT_ID`，兼容旧 `TELEGRAM_CHAT_ID`）上传到 Telegram 频道获取 `file_id`，再通过 `/image-proxy?file_id=xxx` 路由代理访问。Telegram 频道相当于免费图床。

**失败不影响主流程**：如果 Telegraph 创建页面或 Telegram 发送消息失败，Worker 仍然会返回 FNS 写入成功的结果（`ok: true`），只是响应中不包含 `telegraphUrl` 和 `telegramMessageId`。FNS 写入始终优先，Telegraph/Telegram 推送是附加的"锦上添花"。

**环境变量**：推荐使用 `IMG_BOT` 负责图片、`CLIP_BOT` + `USER_ID` 负责剪藏通知；旧的 `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` 仍作为兼容 fallback。配置方法参见 [DEPLOYMENT.md](./DEPLOYMENT.md)。

## 项目结构

```text
src/
├── index.js      # Worker 入口：鉴权、抓取、摘要、FNS 写入、推送编排
├── telegraph.js  # Markdown/HTML -> Telegraph Node 转换 + createPage API 封装
└── telegram.js   # Telegram sendPhoto / sendMessage / getFile API 封装
```

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
javascript: (function () {
	const u = location.href;
	fetch('WORKER_URL', {
		method: 'POST',
		headers: { Authorization: 'Bearer API_KEY', 'Content-Type': 'application/json' },
		body: JSON.stringify({ url: u }),
	})
		.then((r) => r.json())
		.then((d) => {
			alert(d.ok ? '✓ 已剪藏: ' + d.title : '✗ 失败: ' + JSON.stringify(d));
		})
		.catch((e) => alert('✗ 错误: ' + e.message));
})();
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
- **AI 增强可选、失败不阻塞** —— 摘要和自动打标只在配置了 AI 变量时启用；失败时剪藏、FNS 写入、Telegraph/Telegram 主链路继续降级运行
- **HTML 高保真存档不做** —— 个人剪藏场景下"高保真存档"通常是仓鼠症，回看率极低；如果将来真需要，可由 FNS 的附件同步 + Git 自动提交免费提供

## 致谢

- [Jina Reader](https://jina.ai/reader/) —— URL → Markdown 的事实标准
- [Fast Note Sync Service](https://github.com/haierkeys/fast-note-sync-service) —— 让 Obsidian 真正可编程

## License

MIT
