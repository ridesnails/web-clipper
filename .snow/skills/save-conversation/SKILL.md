---
name: save-conversation
description: 将 AI Agent 对话（Claude、ChatGPT 等）通过 /save-md 端点保存到 Obsidian，支持同时保存 HTML artifact 并返回可直接打开的浏览器链接
allowed-tools: terminal-execute, filesystem-read
---

# AI 对话保存技能

将当前对话或 AI 生成内容保存到 Obsidian Vault，走完整剪藏主链路（FNS 去重、AI 摘要、Telegraph 推送）。

## 端点

```
POST /save-md          保存 Markdown 对话，可附带 HTML artifact
GET  /html-view?path=  无鉴权代理，浏览器直接打开 HTML 文件
```

## 请求格式

```bash
curl -X POST "$WORKER_URL/save-md" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "对话标题",
    "content": "## User\n\n...\n\n## Assistant\n\n...",
    "html": "<html>...</html>",
    "tags": ["claude", "topic"],
    "conversation_id": "唯一标识符"
  }'
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `title` | ✅ | 笔记标题，用于生成文件名 slug |
| `content` | ✅ | Markdown 正文，直接写入，不经过 Jina |
| `html` | ❌ | HTML artifact，单独存为 `.html` 文件，响应返回 `htmlViewUrl` |
| `tags` | ❌ | 标签数组，与 AI 自动生成标签合并去重 |
| `conversation_id` | ❌ | 去重 ID；相同 ID 再次保存时软更新（不新建笔记） |

## 响应示例

```json
{
  "ok": true,
  "title": "Claude 对话：重构 web-clipper",
  "fnsOk": true,
  "mode": "created",
  "path": "Clippings/2026-05/20260529T120000Z-Claude-对话.md",
  "htmlPath": "Clippings/2026-05/20260529T120000Z-Claude-对话.html",
  "htmlViewUrl": "https://web-clipper.xxx.workers.dev/html-view?path=...",
  "telegraphOk": true,
  "telegraphUrl": "https://telegra.ph/..."
}
```

`htmlViewUrl` 仅在请求包含 `html` 字段时返回，可直接粘贴到浏览器打开。

## 使用场景

### 场景 1：保存纯文字对话

```bash
curl -X POST "$WORKER_URL/save-md" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d "$(jq -n \
    --arg title "Claude 对话：$(date +%Y-%m-%d)" \
    --arg content "$CONVERSATION_MARKDOWN" \
    --arg conv_id "$(date +%Y%m%d-%H%M%S)" \
    '{title: $title, content: $content, conversation_id: $conv_id, tags: ["claude"]}'
  )"
```

### 场景 2：保存带 HTML artifact 的对话

AI 生成了图表、报告等 HTML 内容时，同时保存 Markdown 摘要和 HTML 原文：

```bash
curl -X POST "$WORKER_URL/save-md" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d "$(jq -n \
    --arg title "数据分析报告" \
    --arg content "## 分析结果\n\n详见 HTML 版本。" \
    --arg html "$(cat report.html)" \
    '{title: $title, content: $content, html: $html, tags: ["analysis", "report"]}'
  )"
# 响应中的 htmlViewUrl 即为可直接打开的链接
```

### 场景 3：更新已有对话（软更新）

同一 `conversation_id` 再次调用时，不新建笔记，而是更新 frontmatter 并追加更新记录：

```bash
# 第一次：mode: "created"
# 再次调用相同 conversation_id：mode: "updated"
curl -X POST "$WORKER_URL/save-md" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "项目讨论",
    "content": "更新后的内容...",
    "conversation_id": "project-discussion-001"
  }'
```

## 行为说明

- **跳过 Jina**：直接使用传入的 Markdown，不抓取外部 URL
- **AI 摘要**：如果配置了 `AI_API_KEY`，仍会自动生成摘要；用户传入的 `tags` 与 AI 标签合并
- **Telegraph 推送**：如果配置了 Telegraph/Telegram，对话也会推送到 Telegram 频道
- **HTML 存储**：HTML 文件与 Markdown 笔记存在同一目录，后缀 `.html`，FNS 会同步到 Obsidian
- **`/html-view` 无鉴权**：路径不可枚举（含时间戳+slug），适合个人使用

## 环境变量

使用此功能无需额外配置，复用现有 secrets：

```
API_KEY          必须，Bearer 鉴权
FNS_BASE         必须，FNS 服务地址
FNS_VAULT        必须，Obsidian Vault 名称
FNS_TOKEN        必须，FNS API Token
CLIP_FOLDER      必须，笔记存储目录（如 Clippings）
PUBLIC_BASE_URL  可选，Worker 公网地址；未设置时从请求 URL 自动推断
```
