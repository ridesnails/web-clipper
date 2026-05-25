# Web Clipper

一个跑在 Cloudflare Workers 上的极简网页剪藏服务，把任意网页变成一篇带 frontmatter 的 Markdown 笔记，自动写入你的 Obsidian Vault（通过 [Fast Note Sync Service](https://github.com/haierkeys/fast-note-sync-service)）。

**核心理念**：轻量、可靠、零运维。整套服务跑在 Cloudflare 免费版上，不需要任何 always-on 服务器。

## 一眼看懂

这个项目现在有 3 个正式入口：

| 入口 | 适合场景 | 实际走法 |
| --- | --- | --- |
| `POST /` | 普通网页、脚本调用、快捷指令 | URL -> Jina -> 剪藏 |
| `POST /upload-html` | SingleFile、登录态页面、强前端页面 | HTML -> 直接解析 -> 剪藏 |
| `CLIP_BOT` | Telegram 里直接发链接 | Telegram -> 提取 URL -> 剪藏 |

三种入口最后都会汇入同一条主链路：

1. 标准化文章内容
2. 生成 Markdown 和 frontmatter
3. `FNS` 与 `Telegraph / Telegram` 并行执行

同一条 URL 再次剪藏时，`FNS` 不会重复新建笔记，而是：

1. 先查找已有笔记
2. 命中后更新 frontmatter
3. 追加一条剪藏更新记录

如果你只想快速开始：

1. 配好 `FNS_BASE`、`FNS_VAULT`、`FNS_TOKEN`
2. 配好 `API_KEY`、`JINA_API_KEY`
3. 部署 Worker
4. 先用 `POST /` 验证主链路
5. 再逐步启用 Telegram / SingleFile / Telegraph

## 特性

- 🪶 **轻量** —— 3 个核心源码模块（入口 + Telegraph + Telegram），无队列、无数据库、无依赖服务
- 🆓 **零成本** —— 完全跑在 Cloudflare Workers / Jina Reader / FNS 的免费层
- 🌐 **多入口** —— iOS Shortcut、浏览器 Bookmarklet、curl、任何能发 HTTP 请求的客户端
- 📝 **真·主存储** —— 笔记直接进 FNS，通过 Obsidian 实时同步到所有设备
- 🔒 **私有部署** —— Token 走 Cloudflare Secrets 加密存储，源站只暴露 Worker 公网地址
- ⚡ **快** —— 单次剪藏典型耗时 3-8 秒（取决于源站响应速度）

## 工作原理

```
┌─────────────────────────────┐
│ 入口 A：POST /              │
│ 传 URL                      │
└──────────────┬──────────────┘
               │
┌──────────────▼──────────────┐
│ 入口 B：POST /upload-html   │
│ 传 SingleFile HTML          │
└──────────────┬──────────────┘
               │
┌──────────────▼──────────────┐
│ 入口 C：Telegram Bot        │
│ 发链接给 CLIP_BOT           │
└──────────────┬──────────────┘
               │
               ┌─────────────────────────────┐
│ Cloudflare Worker           │
│ web-clipper                 │
│                             │
│ 1. 标准化文章内容           │
│ 2. 生成 Markdown/frontmatter│
│ 3. FNS 与 Telegraph 并行    │
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────┐
│ Fast Note Sync Service      │
│ 写入 Obsidian Vault         │
└─────────────────────────────┘
```

## 三个入口

### 1. HTTP 入口：`POST /`

适合：

- iOS Shortcut
- 浏览器 Bookmarklet
- `curl`
- 任何能发 HTTP 请求的客户端

请求格式：

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

**成功响应**

```json
{
	"ok": true,
	"title": "Article Title",
	"fnsOk": true,
	"mode": "created",
	"path": "Clippings/2026-05/Article-Title.md",
	"telegraphOk": true,
	"telegraphUrl": "https://telegra.ph/Article-Title-05-21",
	"telegramMessageId": 123
}
```

- `fnsOk` 表示 FNS 是否成功。
- `mode` 取值为 `created` 或 `updated`。
- `telegraphOk` 表示 Telegraph / Telegram 是否成功。
- `path` 仅在 FNS 成功时返回。
- `telegraphUrl` 和 `telegramMessageId` 仅在 Telegraph / Telegram 成功时返回。

**失败响应**

非 2xx 状态码 + JSON 错误信息 `{ "error": "..." }`。常见状态码：

- `400` —— 请求格式错误（URL 缺失、不是 http/https）
- `401` —— `API_KEY` 错误或缺失
- `502` —— Jina 抓取失败 / FNS 写入失败

### 2. Telegram 入口：`CLIP_BOT`

适合：

- 手机上直接转发链接
- Telegram 作为日常剪藏入口

工作方式：

- 你把网页链接直接发给 `CLIP_BOT`
- Telegram 把消息投递到 Worker 的 `/telegram-webhook`
- Worker 校验 `TELEGRAM_WEBHOOK_SECRET`
- Worker 校验 `USER_ID` 白名单
- Worker 提取消息里的第一个 URL
- 然后复用和 `POST /` 完全相同的剪藏主流程

行为约定：

- 成功时：**不额外回复一条“成功”消息**
- 成功通知：仍沿用原有 Telegraph/Telegram 正常通知
- 无链接时：Bot 回复简短提示
- 剪藏失败时：Bot 回复简短错误

### 3. SingleFile 入口：`POST /upload-html`

适合：

- 登录态页面
- Jina 抓不到正文的页面
- 希望直接上传浏览器里已经保存好的完整 HTML

请求格式：

**Headers**

| Name            | Required | Description        |
| --------------- | -------- | ------------------ |
| `Authorization` | ✅       | `Bearer <API_KEY>` |

**Body**

`multipart/form-data`

- `singlehtmlfile`：SingleFile 导出的 `.html`
- `url`：原始网页 URL

行为约定：

- 这个入口会跳过 `Jina`
- 直接从上传 HTML 中提取正文，再走同一条剪藏主链路
- Telegraph 也会优先复用这份上传 HTML，而不是重新抓网页
- 对论坛贴、公众号和图片较多的页面，会尽量保留正文中的真实图片，并过滤明显的占位 SVG 图
- 对 `data:image/...` 这类 SingleFile 内联图片，会按现有图片链路外部化成 Worker `/image-proxy` 链接，而不是把 base64 直接写进 Markdown

## 剪藏主链路

不管入口来自 `POST /`、`POST /upload-html` 还是 `CLIP_BOT`，真正执行的都是同一条链路：

1. 标准化文章内容
2. URL 入口走 `Jina`
3. SingleFile 入口走上传 HTML 解析
4. 生成 Markdown 和 frontmatter
5. FNS 和 Telegraph / Telegram 并行执行
6. 任一链路成功都尽量返回结果

### URL 去重与软更新

`FNS` 是主存储，所以 Worker 会优先在 `FNS` 里按 URL 查重。

- 首次剪藏：创建新笔记，返回 `mode: "created"`
- 再次剪藏同一 URL：不覆盖正文，不新建第二篇，返回 `mode: "updated"`
- 软更新内容：更新 `last_clipped_at`、`clip_count`、`clip_method`，并在文末追加一条剪藏记录

## 响应与输出

每次剪藏在 FNS Vault 的 `Clippings/YYYY-MM/` 目录下生成一个 Markdown 文件：

```markdown
---
title: "服务器与网站的开荒入坑"
url: https://blog.huan666.de/posts/server-website-getting-started
date: 2026-05-14T15:18:39.538Z
source: clipper
clip_method: url
clip_count: 1
last_clipped_at: 2026-05-14T15:18:39.538Z
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

如果后续再次剪藏同一 URL，Worker 会在原笔记末尾追加：

```markdown
## 🔄 剪藏更新记录

- 2026-05-26 10:00:00 再次剪藏，来源 post
```

### CORS

`POST /` 的所有响应均包含 CORS 头，支持浏览器 Bookmarklet 直接调用：

- `Access-Control-Allow-Origin: *`
- `Access-Control-Allow-Methods: POST, OPTIONS`
- `Access-Control-Allow-Headers: Authorization, Content-Type`

Worker 会自动处理 `OPTIONS` 预检请求，无需客户端额外配置。

**其他行为**

- `GET /favicon.ico` —— 返回 `204 No Content`（避免浏览器请求图标时产生 404 噪音）

### Telegraph 与 Telegram 推送

当 Worker 同时配置了 `TELEGRAPH_ACCESS_TOKEN`、剪藏通知 Bot（`CLIP_BOT` + `USER_ID`，兼容旧 `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`）时，Worker 会独立执行 Telegraph / Telegram 这条链路：

1. 重新抓取原网页 HTML，清理并转换为 Telegraph Node 格式
2. 调用 Telegraph `createPage` 创建可阅读的在线页面
3. 通过剪藏通知 Bot 发送消息到指定用户/频道/群组，消息包含：
   - Telegraph 链接（放在首行，并通过 `link_preview_options.url` 强制即时预览）
   - 页面标题
   - AI 摘要（如果已配置 AI）
   - 原文链接
   - AI 标签（如果已生成）

**图片处理**：Telegraph 原生图片上传已废弃。Worker 会优先从原网页 HTML 的 `<img src="...">` 提取图片，通过图片 Bot（优先 `IMG_BOT`，兼容旧 `TELEGRAM_BOT_TOKEN`；聊天目标优先 `IMG_CHAT_ID`，兼容旧 `TELEGRAM_CHAT_ID`）上传到 Telegram 频道获取 `file_id`，再通过 `/image-proxy?file_id=xxx` 路由代理访问。Telegram 频道相当于免费图床。

**降级行为**：如果原网页 HTML 抓取失败，Worker 才会用 Jina Markdown 正文生成简化 HTML，再转换为 Telegraph Node。FNS 笔记仍使用 Jina Markdown，不受 Telegraph HTML 链路影响。

**并行语义**：FNS 和 Telegraph / Telegram 互不依赖。可能出现：

- `fnsOk=true` 且 `telegraphOk=true`
- `fnsOk=true` 且 `telegraphOk=false`
- `fnsOk=false` 且 `telegraphOk=true`

只有当两条链路都失败时，接口才会返回 `502`。

**环境变量**：推荐使用 `IMG_BOT` 负责图片、`CLIP_BOT` + `USER_ID` 负责剪藏通知；旧的 `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` 仍作为兼容 fallback。配置方法参见 [DEPLOYMENT.md](./DEPLOYMENT.md)。

## 项目结构

```text
src/
├── index.js      # Worker 入口：鉴权、抓取、摘要、FNS 写入、推送编排
├── telegraph.js  # HTML/Markdown -> Telegraph Node 转换 + createPage API 封装
└── telegram.js   # Telegram sendPhoto / sendMessage / getFile API 封装
```

## 使用示例

### HTTP 入口示例

#### iOS Shortcut

「快捷指令」app → 新建 → 添加「获取 URL 内容」动作：

- URL：`https://web-clipper.<your>.workers.dev`
- Method：`POST`
- Body 类型：JSON，字段 `url` = 「快捷指令输入」
- Headers：
  - `Authorization`: `Bearer <your-api-key>`
  - `Content-Type`: `application/json`

启用「在分享菜单中显示」，接受类型勾选「URL」。从 Safari 分享菜单一键剪藏。

#### 浏览器 Bookmarklet

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

#### curl

```bash
curl -X POST https://web-clipper.<your>.workers.dev \
  -H "Authorization: Bearer <your-api-key>" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com"}'
```

#### SingleFile REST 表单上传

```bash
curl -X POST https://web-clipper.<your>.workers.dev/upload-html \
  -H "Authorization: Bearer <your-api-key>" \
  -F "singlehtmlfile=@webpage.html" \
  -F "url=https://example.com"
```

#### SingleFile 插件设置

浏览器安装 SingleFile 扩展后，建议这样配置：

1. 打开 SingleFile 设置
2. 选择：`保存到 REST 表单 API`
3. 网址：`https://web-clipper.<your>.workers.dev/upload-html`
4. 授权令牌：你的 `API_KEY`
5. 文件字段名称：`singlehtmlfile`
6. 网址字段名称：`url`

可选但推荐：

1. 文件名模版：`{url-host}{url-pathname-flat}.{filename-extension}`
2. 文件名最大长度：`384`
3. 文件名替换字符：`$`

这样 SingleFile 保存网页时，会直接把完整 HTML 上传到 Worker。

### Telegram 入口示例

直接给 `CLIP_BOT` 发以下任意一种消息：

```text
https://example.com/article
```

或：

```text
帮我剪藏这个：https://example.com/article
```

Worker 会提取消息中的第一个 `http/https` 链接并执行剪藏。

## 部署

### 一键部署到 Cloudflare

你可以先把这个仓库导入到 Cloudflare Workers：

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://github.com/ridesnails/web-clipper)

说明：这个按钮/入口的作用是**快速导入仓库并创建 Worker 项目**，不是把整套剪藏服务无配置跑起来。这个项目依赖多组运行 secrets，所以导入后仍然需要你在 Cloudflare 里补配置。

最少需要补的主链路 secrets：

- `FNS_BASE`
- `FNS_VAULT`
- `FNS_TOKEN`
- `API_KEY`
- `JINA_API_KEY`

如果你还要启用 Telegraph / Telegram / SingleFile 完整能力，通常还需要继续配置：

- `PUBLIC_BASE_URL`
- `TELEGRAPH_ACCESS_TOKEN`
- `IMG_BOT`
- `IMG_CHAT_ID`
- `CLIP_BOT`
- `USER_ID`
- `TELEGRAM_WEBHOOK_SECRET`

完整部署和验证步骤见 [DEPLOYMENT.md](./DEPLOYMENT.md)。

### GitHub Actions 自动部署

仓库内已包含两套 GitHub Actions：

- `CI`：`push` / `pull_request` 时自动跑 `npm test`
- `Deploy`：`push` 到 `main` 或手动触发时自动同步 Worker secrets 并部署到 Cloudflare

#### 先创建 `CLOUDFLARE_API_TOKEN`

给 GitHub Actions 用的 `CLOUDFLARE_API_TOKEN` 不是 `.dev.vars` 里的内容，需要你在 Cloudflare Dashboard 里单独创建：

1. 打开 Cloudflare Dashboard
2. 进入 `My Profile`
3. 打开 `API Tokens`
4. 选择 `Create Token`
5. 选择自定义模板
6. 至少给这些权限：
   - `Account Settings: Read`
   - `Workers Scripts: Edit`
7. 生成后，把 token 存进 GitHub：
   - `Settings -> Secrets and variables -> Actions`
   - 名称填：`CLOUDFLARE_API_TOKEN`

使用前，你需要先在 GitHub 仓库 `Settings -> Secrets and variables -> Actions` 中配置至少这些 secrets：

- `CLOUDFLARE_API_TOKEN`
- `FNS_BASE`
- `FNS_VAULT`
- `CLIP_FOLDER`
- `FNS_TOKEN`
- `API_KEY`
- `JINA_API_KEY`

如果你还要启用 Telegraph / Telegram / SingleFile 完整能力，通常还需要继续配置：

- `PUBLIC_BASE_URL`
- `TELEGRAPH_ACCESS_TOKEN`
- `IMG_BOT`
- `IMG_CHAT_ID`
- `TELEGRAM_CHAT_ID`
- `CLIP_BOT`
- `USER_ID`
- `TELEGRAM_WEBHOOK_SECRET`
- `AI_API_KEY`
- `AI_BASE_URL`
- `AI_MODEL`

建议顺序：

1. 先只配置主链路 secrets
2. 推一个小改动到 `main`
3. 确认 `CI` 和 `Deploy` workflow 都成功
4. 再继续补 Telegraph / Telegram / SingleFile 相关 secrets

完整部署步骤仍然看 [DEPLOYMENT.md](./DEPLOYMENT.md)。

## 设计取舍

这套系统刻意做了几个反直觉的简化：

- **没有队列、没有数据库、没有状态机** —— 个人单用户场景下 QPS ≈ 0，引入这些只增加复杂度，FNS 自己已经有完整的存储和同步层
- **多源输入，统一主链路** —— URL 入口依赖 Jina；SingleFile 入口直接上传 HTML；两者最后都汇入同一套 FNS / Telegraph 并行链路
- **AI 增强可选、失败不阻塞** —— 摘要和自动打标只在配置了 AI 变量时启用；失败时剪藏、FNS 写入、Telegraph/Telegram 主链路继续降级运行
- **HTML 高保真存档不做** —— 个人剪藏场景下"高保真存档"通常是仓鼠症，回看率极低；如果将来真需要，可由 FNS 的附件同步 + Git 自动提交免费提供

## 致谢

- [Jina Reader](https://jina.ai/reader/) —— URL → Markdown 的事实标准
- [Fast Note Sync Service](https://github.com/haierkeys/fast-note-sync-service) —— 让 Obsidian 真正可编程

## License

MIT
