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

| 名字           | 来源                     | 示例                      |
| -------------- | ------------------------ | ------------------------- |
| `FNS_BASE`     | 你的 FNS 地址            | `https://fns.example.com` |
| `FNS_VAULT`    | FNS 里的 Vault 名        | `Clip`                    |
| `FNS_TOKEN`    | FNS 登录接口返回的 token | `eyJhbGc...`              |
| `JINA_API_KEY` | Jina 账号                | `jina_xxx...`             |
| `API_KEY`      | 自己编的                 | `clip-xxx-xxx`            |

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

在项目根目录新建 `.dev.vars` 文件。先按“所有入口共用的主链路配置”填写，后面的 Telegraph / Telegram / Bot 入口配置按需补充：

```
# 所有入口共用：主剪藏链路
FNS_BASE=https://<你的FNS地址>
FNS_VAULT=<你的Vault名>
CLIP_FOLDER=Clippings
FNS_TOKEN=<你的FNS Token>
API_KEY=<你自己编的API_KEY>
JINA_API_KEY=<你的Jina API Key>

# 可选：Telegraph / Telegram 通知
PUBLIC_BASE_URL=https://<你的Worker公开地址>
TELEGRAPH_ACCESS_TOKEN=<你的Telegraph access_token>
IMG_BOT=<图片Bot Token>
IMG_CHAT_ID=<图片频道/群组ID，可省略并 fallback 到 TELEGRAM_CHAT_ID>
CLIP_BOT=<剪藏通知Bot Token>
USER_ID=<剪藏通知接收者ID>

# 可选：Telegram Bot 入口
TELEGRAM_WEBHOOK_SECRET=<随机32字节hex字符串>

# 兼容旧配置：TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID 仍可作为 fallback
```

注意：

- `FNS_BASE` **不带末尾斜杠**，**不带 `/api`**
- `FNS_VAULT` 是 FNS/Obsidian 中的 Vault/仓库名
- `CLIP_FOLDER` 是剪藏落盘目录，例如 `Clippings`
- `PUBLIC_BASE_URL` 只在启用 Telegraph 图片代理时需要；本地先不填也能跑通主链路，等第 6 步拿到公网 Worker 地址后再补上
- 如果填写 `PUBLIC_BASE_URL`，必须是外网可访问的 Worker 地址，**不要**填 `localhost`、`127.0.0.1` 或局域网地址，且**不带末尾斜杠**

### 3.2 把 `.dev.vars` 加入 `.gitignore`

⚠️ **关键步骤，防止 Token 和个人 FNS 配置泄露到 GitHub**

```bash
echo ".dev.vars" >> .gitignore
```

### 3.3 确认 `wrangler.jsonc` 不写 FNS 配置

`wrangler.jsonc` 只保留 Worker 运行所需的非个人化配置，例如 `name`、`main`、`compatibility_date`、`observability`、`compatibility_flags` 等。

不要在 `wrangler.jsonc` 里写入以下变量：

```jsonc
// 不要提交这些到 wrangler.jsonc
// "vars": {
//   "FNS_BASE": "https://<你的FNS地址>",
//   "FNS_VAULT": "<你的Vault名>",
//   "CLIP_FOLDER": "Clippings",
//   "PUBLIC_BASE_URL": "https://<你的Worker公开地址>"
// }
```

### 3.4 给 Cloudflare 部署环境也设置变量/Secrets

由于 `.dev.vars` 只用于本地开发，部署到 Cloudflare 时需要把同名变量设置到 Worker 环境中。建议按“共用主链路”先配一遍，确认 `POST /` 能用，再继续配置 Telegram / Telegraph：

#### 3.4.1 先配置所有入口共用的主链路 secrets

```bash
npx wrangler secret put FNS_BASE
# 提示后粘贴 FNS_BASE，例如 https://fns.example.com，回车

npx wrangler secret put FNS_VAULT
# 提示后粘贴 FNS_VAULT，回车

npx wrangler secret put CLIP_FOLDER
# 提示后粘贴 CLIP_FOLDER，例如 Clippings，回车

npx wrangler secret put FNS_TOKEN
# 提示后粘贴 FNS_TOKEN，回车

npx wrangler secret put API_KEY
# 提示后粘贴 API_KEY（要和 .dev.vars 里完全一致），回车

npx wrangler secret put JINA_API_KEY
# 提示后粘贴 JINA_API_KEY，回车
```

如果第一次 `wrangler secret put` 时提示 worker 不存在询问是否创建，选 **Yes**。

每次成功会显示 `✨ Success! Uploaded secret`。

#### 3.4.2 再配置 Telegraph / Telegram（可选）

如需启用 Telegraph 页面生成和 Telegram 推送，需要配置以下 secrets。推荐拆成两个 Bot：`IMG_BOT` 负责 Telegraph 图片中转，`CLIP_BOT` + `USER_ID` 负责剪藏通知；旧的 `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` 仍作为兼容 fallback。

启用后，主流程仍然是 Jina Markdown → 生成笔记内容。然后 Worker 会把两条链路并行执行：

- FNS：写入 Obsidian
- Telegraph / Telegram：生成 Telegraph 页面并发送通知

两条链路互不依赖。如果原网页 HTML 抓取失败，Telegraph 链路会降级使用 Jina Markdown 正文生成简化 HTML。

##### 1. TELEGRAPH_ACCESS_TOKEN

Telegraph 账号的 access token。

获取方式：

```bash
curl "https://api.telegra.ph/createAccount?short_name=YourApp&author_name=YourName"
```

在响应中获取 `result.access_token`。

设置命令：

```bash
npx wrangler secret put TELEGRAPH_ACCESS_TOKEN
```

##### 2. IMG_BOT / IMG_CHAT_ID（图片中转）

`IMG_BOT` 是用于上传文章图片的 Telegram Bot API Token；`IMG_CHAT_ID` 是图片 Bot 所在频道或群组 ID。Worker 会优先从原网页 HTML 的 `<img src="...">` 提取图片，先上传到 Telegram，再通过 Worker 的 `/image-proxy?file_id=...` 给 Telegraph 引用。

获取方式：

1. 在 Telegram 搜索 @BotFather
2. 发送 `/newbot` 创建图片 Bot，复制 Token（格式：`123456789:ABCdef...`）
3. 把 Bot 加入图片频道/群组并设为管理员
4. 在频道/群组发送一条消息
5. 访问 `https://api.telegram.org/bot<IMG_BOT>/getUpdates`
6. 找到 `channel_post.chat.id`（频道通常以 `-100` 开头）

设置命令：

```bash
npx wrangler secret put IMG_BOT
npx wrangler secret put IMG_CHAT_ID
npx wrangler secret put PUBLIC_BASE_URL
# 如启用 Telegraph 图片代理，提示后粘贴 Worker 公网地址，回车
```

> 如果未设置 `IMG_CHAT_ID`，图片链路会 fallback 到旧 `TELEGRAM_CHAT_ID`。

##### 3. CLIP_BOT / USER_ID（剪藏通知 + Bot 剪藏入口）

`CLIP_BOT` 是用于发送剪藏完成通知的 Telegram Bot API Token，也可以作为新的剪藏入口：直接把网页链接发给这个 Bot。`USER_ID` 是接收剪藏通知的用户、频道或群组 ID，同时作为 Bot 剪藏入口的白名单。消息首行会放 Telegraph 裸链接，并同时传 `link_preview_options.url`，用于触发 Telegram 即时预览。

获取方式：

1. 用 @BotFather 创建剪藏通知 Bot，复制 Token
2. 把 Bot 加入目标频道/群组并设为管理员；如果推送给个人，先给 Bot 发一条消息
3. 访问 `https://api.telegram.org/bot<CLIP_BOT>/getUpdates`
4. 找到目标 `chat.id` 或用户 ID，填入 `USER_ID`

设置命令：

```bash
npx wrangler secret put CLIP_BOT
npx wrangler secret put USER_ID
```

> 兼容旧配置：如果没有拆分 Bot，也可以只设置 `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`，代码会作为 fallback 使用；推荐新部署使用 `IMG_BOT` + `CLIP_BOT` + `USER_ID`。

#### 3.4.3 最后配置 Telegram Bot 入口（可选）

只有当你想把 `CLIP_BOT` 作为第二个剪藏入口时，才需要这一组配置。

##### 1. TELEGRAM_WEBHOOK_SECRET（Bot 入口防伪造）

`TELEGRAM_WEBHOOK_SECRET` 用于校验 `/telegram-webhook` 请求确实来自 Telegram。`USER_ID` 负责白名单，`TELEGRAM_WEBHOOK_SECRET` 负责请求来源校验，两者都需要。

生成本地随机值：

```bash
openssl rand -hex 32
```

写入本地 `.dev.vars`：

```bash
TELEGRAM_WEBHOOK_SECRET=<上一步生成的随机值>
```

写入 Cloudflare Secret：

```bash
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
```

部署 Worker 后，设置 Telegram Webhook：

```bash
curl "https://api.telegram.org/bot<CLIP_BOT>/setWebhook" \
  -d "url=https://web-clipper.ridesnail-6a2.workers.dev/telegram-webhook" \
  -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>"
```

设置成功后，你给 `CLIP_BOT` 发送一个网页链接即可触发剪藏。成功通知仍走正常 Telegraph/Telegram 通知逻辑；无链接或失败时，Bot 会回复简短提示。

## 4. 写入代码并安装依赖

如果你是直接 clone 这个仓库，确认以下文件存在即可：

- `src/index.js`
- `src/telegraph.js`
- `src/telegram.js`
- `package.json`
- `wrangler.jsonc`

如果你是**从 0 开始而不是 clone 这个仓库**，不要只复制 `src/index.js`。至少要把上面 5 个文件按仓库当前版本一起对齐，否则 Telegraph / Telegram 相关逻辑和脚本依赖会缺失。

然后安装依赖：

```bash
npm install
```

可选但推荐先跑一遍测试：

```bash
npm test -- --run
```

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
{ "ok": true, "title": "Example Domain", "path": "Clippings/2026-05/20260522T172855Z-Example-Domain.md" }
```

打开 Obsidian → 你的 Vault → `Clippings/2026-05/` 应该出现一篇带时间戳前缀的 `Example-Domain.md` 笔记，内容带完整 frontmatter。

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

如果你要启用 Telegraph 图片代理，这时把部署后拿到的公网地址回填到：

- 本地 `.dev.vars` 里的 `PUBLIC_BASE_URL`
- Cloudflare secret `PUBLIC_BASE_URL`

## 7. 部署后的三个入口

### 7.1 HTTP 入口：`POST /`

这是默认入口。只要你已经完成：

- `FNS_BASE`
- `FNS_VAULT`
- `CLIP_FOLDER`
- `FNS_TOKEN`
- `API_KEY`
- `JINA_API_KEY`

那么现在就可以通过：

- iOS Shortcut
- 浏览器 Bookmarklet
- `curl`

调用 `POST /` 开始剪藏。

### 7.2 Telegram Bot 入口：`CLIP_BOT`

这是附加入口。只有你额外完成了：

- `CLIP_BOT`
- `USER_ID`
- `TELEGRAM_WEBHOOK_SECRET`
- `setWebhook`

之后，给 `CLIP_BOT` 发送网页链接才会触发剪藏。

### 7.3 SingleFile 入口：`POST /upload-html`

这是浏览器扩展入口。适合：

- 登录态页面
- Jina 抓不到的页面
- 希望浏览器端先完整保存页面再上传

配置完成后，SingleFile 会把完整 HTML 直接上传到：

```text
https://web-clipper.<your>.workers.dev/upload-html
```

请求协议：

- `Authorization: Bearer <API_KEY>`
- `multipart/form-data`
- 文件字段名：`singlehtmlfile`
- URL 字段名：`url`

### 7.4 客户端配置参考

参见主 README 的「使用示例」一节。最常用的三个：

- **iOS Shortcut**（手机分享菜单一键剪藏）
- **浏览器 Bookmarklet**（电脑书签栏一键剪藏）
- **SingleFile REST 表单上传**（登录态 / 完整 HTML 页面）

如果你要配置 SingleFile，建议这样填：

1. 保存位置：`保存到 REST 表单 API`
2. 网址：`https://web-clipper.<your>.workers.dev/upload-html`
3. 授权令牌：你的 `API_KEY`
4. 文件字段名称：`singlehtmlfile`
5. 网址字段名称：`url`

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
const yyyymm = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
const path = `${env.CLIP_FOLDER}/${yyyymm}/${slug}.md`;
```

改成你想要的命名规则后 `npx wrangler deploy` 即可。

### Q: 想剪藏需要登录态的页面

当前架构无法在服务端带登录态抓取。URL 入口里的 Jina 是匿名抓取；Telegraph 回退抓原网页 HTML 也是 Worker 端匿名请求。

登录态页面请直接使用 **SingleFile 入口**：

1. 浏览器安装 [SingleFile 扩展](https://github.com/gildas-lormeau/SingleFile)
2. 配置 REST 表单上传到 `POST /upload-html`
3. 用 `singlehtmlfile` 作为文件字段名，用 `url` 作为网址字段名

这样 Worker 会直接使用浏览器里保存下来的完整 HTML，跳过服务端匿名抓取。

## 10. 卸载

如果某天你不想用了：

```bash
npx wrangler delete web-clipper
```

会从 Cloudflare 完全删除 Worker。本地代码自行删除。所有已剪藏的笔记**仍然保留在 FNS / Obsidian 里**，不受影响。
