# 部署指南

从零部署一套 Web Clipper 的完整步骤。如果你严格按顺序操作，应该能在 30-60 分钟内跑通。

## 0. 前置条件

部署之前请确认你已经有：

- [x] **一台已部署并能访问的 Fast Note Sync Service**（FNS）。如果还没有，参考 [FNS 官方部署文档](https://github.com/haierkeys/fast-note-sync-service)。本指南假设你的 FNS 已经能在浏览器打开管理面板并创建过至少一个 Vault。
- [x] **Node.js 18+** 装在本机。验证：`node -v` 输出 `v18.x` 或更高。
- [x] **一个 Cloudflare 账号**（免费版即可）。注册：https://dash.cloudflare.com/sign-up
- [x] **一个 Jina AI 账号**（免费）。后面会用，先记下来。
- [x] **一个文本编辑器**（VS Code、Sublime、vim 都行）。

## 1. 取得三把钥匙

部署需要三个外部凭证。**先把它们都拿到，写在一张纸上**，比中途回来翻文档省事。

### 1.1 FNS 的 REST API Token

⚠️ **重要**：FNS 管理面板里「Copy API Config」给的那个 Token 是**插件用的**，scope 受限，**不能调用 REST API**（会返回 `code: 315 Auth token Scope restricted`）。你需要的是**登录返回的会话 Token**。

获取方式（任选一种）：

**方式 A（推荐）：通过登录接口获取**

```bash
curl -X POST "https://<你的FNS地址>/api/user/login" \
  -H "Content-Type: application/json" \
  -d '{"username":"<你的FNS用户名>","password":"<你的FNS密码>"}'
```

返回 JSON 的 `data.token` 字段就是。这个 Token 默认有效期 365 天（可在 FNS 配置文件 `security.token-expiry` 调整）。

**方式 B：从浏览器开发者工具复制**

登录 FNS Web 管理面板 → F12 打开 DevTools → Network 标签 → 在面板里点任意一个操作（比如刷新文件列表）→ 找到任意一个 `/api/...` 请求 → Headers → Request Headers → 复制 `Authorization` 后面那一长串（去掉 `Bearer ` 前缀）。

记下这个 Token，下面叫它 `FNS_TOKEN`。

### 1.2 你的 FNS Vault 名字

登录 FNS Web 管理面板，左侧「Note Vaults」，记下你想用来接收剪藏的 Vault 名字（比如 `Clip`、`MyVault`）。下面叫它 `FNS_VAULT`。

如果还没有 Vault，先在面板里创建一个。

### 1.3 Jina API Key

去 https://jina.ai/ 用 Google 或 GitHub 登录。登录后首页直接显示 API Key（`jina_xxxxxxxx...`）。免费用户自带 1M tokens 额度，日常使用够用 1000+ 次剪藏。

复制下来，下面叫它 `JINA_API_KEY`。

### 1.4 自己编一个 API_KEY

这是**你自己设的密码**，将来调用 Worker 时用。建议长一点、没规律：

```
clip-7x9k2m-bird-2026-q3p8r5t1
```

下面叫它 `API_KEY`，记到密码管理器里。

---

**到这里你应该有 5 个值**：

| 名字 | 来源 | 示例 |
|---|---|---|
| `FNS_BASE` | 你的 FNS 地址 | `https://fns.example.com` |
| `FNS_VAULT` | FNS 里的 Vault 名 | `Clip` |
| `FNS_TOKEN` | FNS 登录接口返回的 token | `eyJhbGc...` |
| `JINA_API_KEY` | Jina 账号 | `jina_xxx...` |
| `API_KEY` | 自己编的 | `clip-xxx-xxx` |

## 2. 初始化项目

### 2.1 登录 Cloudflare

```bash
npx wrangler login
```

浏览器自动打开 → 点 Allow → 终端显示 `Successfully logged in.`。

### 2.2 创建项目

到你想放代码的目录，跑：

```bash
npm create cloudflare@latest web-clipper
```

交互式问答按以下选择：

- `What would you like to start with?` → **Hello World example**
- `Which template would you like to use?` → **Worker only**
- `Which language do you want to use?` → **JavaScript**
- `Do you want to use git for version control?` → **Yes**
- `Do you want to deploy your application?` → **No**

跑完进入项目：

```bash
cd web-clipper
```

### 2.3 验证骨架能跑

```bash
npx wrangler dev
```

看到 `Ready on http://localhost:8787` → 新开终端 → `curl http://localhost:8787` 应返回 `Hello World!`。

成功后回到第一个窗口 `Ctrl+C` 停掉。

## 3. 配置环境变量

### 3.1 创建本地开发用的 `.dev.vars`

在项目根目录新建 `.dev.vars` 文件：

```
FNS_TOKEN=<你的FNS Token>
API_KEY=<你自己编的API_KEY>
JINA_API_KEY=<你的Jina API Key>
```

### 3.2 把 `.dev.vars` 加入 `.gitignore`

⚠️ **关键步骤，防止 Token 泄露到 GitHub**

```bash
echo ".dev.vars" >> .gitignore
```

### 3.3 修改 `wrangler.jsonc`，写入非敏感配置

打开 `wrangler.jsonc`，在最外层大括号里追加 `vars` 字段。改完后整体长这样：

```jsonc
{
  "$schema": "node_modules/wrangler/schema.json",
  "name": "web-clipper",
  "main": "src/index.js",
  "compatibility_date": "2025-XX-XX",
  "observability": {
    "enabled": true
  },
  "vars": {
    "FNS_BASE": "https://<你的FNS地址>",
    "FNS_VAULT": "<你的Vault名>",
    "CLIP_FOLDER": "Clippings"
  }
}
```

注意：

- `FNS_BASE` **不带末尾斜杠**，**不带 `/api`**
- `compatibility_date` 保持文件原值不动
- JSON 格式严格，每个键值对之间逗号分隔，最后一项后面**不要**逗号

### 3.4 给 Cloudflare 部署环境也设置 secrets

```bash
npx wrangler secret put FNS_TOKEN
# 提示后粘贴 FNS_TOKEN，回车

npx wrangler secret put API_KEY
# 提示后粘贴 API_KEY（要和 .dev.vars 里完全一致），回车

npx wrangler secret put JINA_API_KEY
# 提示后粘贴 JINA_API_KEY，回车
```

如果第一次 `wrangler secret put` 时提示 worker 不存在询问是否创建，选 **Yes**。

每次成功会显示 `✨ Success! Uploaded secret`。

## 4. 写入主代码

把仓库里的 `src/index.js`（或参考 [README 上面那段完整代码](./src/index.js)）整体内容确认存在并保存。

> 如果你是**从 0 开始而不是 clone 这个仓库**，需要把 `src/index.js` 的完整内容从项目仓库中复制过来。

## 5. 本地验证

```bash
npx wrangler dev
```

启动后日志会打印加载到的 vars，确认 `FNS_BASE` / `FNS_VAULT` / `CLIP_FOLDER` 三个变量都正确显示。

新开终端测试：

```bash
curl -X POST http://localhost:8787 \
  -H "Authorization: Bearer <你的API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com"}'
```

预期返回：

```json
{"ok":true,"title":"Example Domain","path":"Clippings/2026-05/Example-Domain.md"}
```

打开 Obsidian → 你的 Vault → `Clippings/2026-05/` 应该出现 `Example-Domain.md`，内容带完整 frontmatter。

✅ **检查点**：Obsidian 里出现这个文件 → 核心功能跑通了。

## 6. 部署到 Cloudflare

```bash
npx wrangler deploy
```

完成后终端会显示部署 URL，类似：

```
https://web-clipper.<你的Cloudflare用户名>.workers.dev
```

**这就是你的剪藏服务公网地址。**

用公网地址再测一次：

```bash
curl -X POST https://web-clipper.<your>.workers.dev \
  -H "Authorization: Bearer <你的API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com"}'
```

成功 → 部署完成。

## 7. 配置客户端入口

参见主 README 的「客户端接入示例」一节。最常用的两个：

- **iOS Shortcut**（手机分享菜单一键剪藏）
- **浏览器 Bookmarklet**（电脑书签栏一键剪藏）

## 8. 日常运维

### 看实时日志

任何剪藏失败都可以通过实时日志定位：

```bash
npx wrangler tail
```

成功剪藏会打印 `Clipped: 标题 -> 路径`，失败会打印 `Jina fetch failed:` 或 `FNS write failed:` + 详细原因。

### 更新代码后重新部署

```bash
npx wrangler deploy
```

### 更新某个 secret

```bash
npx wrangler secret put <SECRET_NAME>
```

直接覆盖旧值。

### FNS Token 过期了怎么办

FNS 默认 token 有效期 365 天。过期后剪藏会失败、`wrangler tail` 会看到 FNS 返回 `code: 507/508 Not logged in / Session expired`。

解决：重新走 [1.1](#11-fns-的-rest-api-token) 拿新 token，然后：

```bash
npx wrangler secret put FNS_TOKEN
```

也可以在 FNS 配置里把 `security.token-expiry` 设大（例如 `36500d`），但这降低安全性，自己权衡。

## 9. 常见问题

### Q: 剪藏返回 `Jina fetch failed: 429 RateLimitTriggeredError`

Jina 限速触发。如果你已经按 [1.3](#13-jina-api-key) 配了 `JINA_API_KEY`，正常使用应该极少触发；如果是连续测试触发的，等几分钟自动恢复。

### Q: 剪藏返回 `FNS write failed: ... code: 315 Auth token Scope restricted`

你用的是「Copy API Config」给的 Token，scope 受限。回去看 [1.1](#11-fns-的-rest-api-token)，换成登录接口返回的会话 Token。

### Q: 剪藏返回 `FNS write failed: ... code: 414 Note Vault does not exist`

`FNS_VAULT` 配错了，去 FNS 面板核对 Vault 名字（区分大小写）。

### Q: Worker 部署后但 Obsidian 里看不到笔记

依次检查：
1. `npx wrangler tail` 看 Worker 日志，确认是否 `Clipped: ...` 成功打印
2. FNS Web 管理面板里点开对应 Vault，看笔记是否在 FNS 服务端
3. 如果 FNS 服务端有笔记但本地 Obsidian 没有，重启 Obsidian 让插件重新同步

### Q: 想改剪藏的目录命名规则（比如不要按月份分）

修改 `src/index.js` 里这一段：

```javascript
const yyyymm = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
const path = `${env.CLIP_FOLDER}/${yyyymm}/${slug}.md`;
```

改成你想要的命名规则后 `npx wrangler deploy` 即可。

### Q: 想剪藏需要登录态的页面

当前架构无法在服务端带登录态抓取（jina 是匿名抓取）。短期解决方案：登录态页面用浏览器装 [SingleFile 扩展](https://github.com/gildas-lormeau/SingleFile) 直接保存为 HTML，不走 Worker。

如果未来扩展功能，可以加一个 `POST /upload-html` 端点接收浏览器扩展上传的完整 HTML，跳过 jina 直接转 Markdown 写 FNS。

## 10. 卸载

如果某天你不想用了：

```bash
npx wrangler delete web-clipper
```

会从 Cloudflare 完全删除 Worker。本地代码自行删除。所有已剪藏的笔记**仍然保留在 FNS / Obsidian 里**，不受影响。
