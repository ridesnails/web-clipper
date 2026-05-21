## web-clipper

一个跑在 Cloudflare Workers 上的极简网页剪藏服务，把任意网页变成一篇带 frontmatter 的 Markdown 笔记，自动写入你的 Obsidian Vault（通过 Fast Note Sync Service）。

## Overview

`web-clipper` 是一个基于 Cloudflare Workers 的无服务器边缘服务。它接收包含目标网页 URL 的 POST 请求，通过 Jina Reader 将网页内容转换为 Markdown，提取标题并清理元信息，最后生成带 YAML frontmatter 的笔记文件，通过 Fast Note Sync Service (FNS) API 写入指定的 Obsidian Vault。

整个服务的设计理念是轻量、可靠、零运维。单文件 Worker 约 165 行 JavaScript，无队列、无数据库、无依赖服务，完全跑在 Cloudflare Workers / Jina Reader / FNS 的免费层上。支持多种客户端接入：iOS Shortcut、浏览器 Bookmarklet、curl 或任何能发 HTTP 请求的客户端。

## Technology Stack

- **Language/Runtime**: JavaScript (ES Modules), Node.js compatibility enabled (`nodejs_compat`)
- **Platform**: Cloudflare Workers (edge runtime)
- **Key Dependencies**:
  - `wrangler` — CLI for local dev, deployment, and binding management
  - `vitest` — Unit and integration testing framework
  - `@cloudflare/vitest-pool-workers` — Vitest pool for testing Workers in a simulated runtime
- **Build Tools**: Wrangler (bundles and deploys the Worker; no separate build step required)
- **Quality Tools**:
  - Prettier (code formatting)
  - EditorConfig (consistent editor settings)
  - Vitest (testing with both unit-style and integration-style tests)

## Project Structure

```
.
├── src/
│   └── index.js                 # Worker entry point — exports fetch handler
├── test/
│   └── index.spec.js            # Vitest tests (unit + integration styles)
├── .vscode/
│   └── settings.json            # VS Code: treats wrangler.json as JSONC
├── .editorconfig                # EditorConfig: tabs, LF, UTF-8
├── .gitignore                   # Standard Node.js + Wrangler ignore patterns
├── .prettierrc                  # Prettier: tabs, single quotes, 140 width
├── package.json                 # Project metadata and npm scripts
├── package-lock.json            # Locked dependency tree
├── vitest.config.js             # Vitest config using @cloudflare/vitest-pool-workers
└── wrangler.jsonc               # Wrangler configuration (bindings, compatibility, observability)
```

### Key Files

| File                 | Purpose                                                                                                                    |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `src/index.js`       | 主 Worker 脚本（~165 行）。实现完整的剪藏流水线：鉴权 → 调 Jina Reader → 提取标题/清理正文 → 生成 frontmatter → 写入 FNS。 |
| `test/index.spec.js` | Vitest 测试套件，包含直接调用 handler 的单元测试和通过 `SELF.fetch` 的集成测试。                                           |
| `wrangler.jsonc`     | Declares Worker name, entry point, compatibility date, flags, and observability settings.                                  |
| `vitest.config.js`   | Configures Vitest to use the Cloudflare Workers test pool with `wrangler.jsonc`.                                           |

## Key Features

- 🪶 **轻量** —— 单文件 Worker，无队列、无数据库、无依赖服务
- 🆓 **零成本** —— 完全跑在 Cloudflare Workers / Jina Reader / FNS 的免费层
- 🌐 **多入口** —— 支持 iOS Shortcut、浏览器 Bookmarklet、curl 等任何能发 HTTP 请求的客户端
- 📝 **真·主存储** —— 笔记直接进 FNS，通过 Obsidian 实时同步到所有设备
- 🔒 **私有部署** —— Token 走 Cloudflare Secrets 加密存储，源站只暴露 Worker 公网地址
- ⚡ **快** —— 单次剪藏典型耗时 3-8 秒（取决于源站响应速度）
- 🧪 **可测试** —— Vitest + `@cloudflare/vitest-pool-workers` 提供 Workers 运行时仿真测试

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (LTS recommended)
- A [Cloudflare account](https://dash.cloudflare.com/) (for deployment)

### Installation

```bash
npm install
```

### Usage

**Local development:**

```bash
npm run dev
# or
npx wrangler dev
```

The Worker will be available at `http://localhost:8787/` by default.

**Run tests:**

```bash
npm test
# or
npx vitest
```

**Deploy to Cloudflare:**

```bash
npm run deploy
# or
npx wrangler deploy
```

## Development

### Available Scripts

| Script   | Command           | Purpose                         |
| -------- | ----------------- | ------------------------------- |
| `dev`    | `wrangler dev`    | Start local development server  |
| `start`  | `wrangler dev`    | Alias for `dev`                 |
| `deploy` | `wrangler deploy` | Deploy the Worker to Cloudflare |
| `test`   | `vitest`          | Run the Vitest test suite       |

### Development Workflow

1. Edit `src/index.js` to implement request handling logic.
2. Add or update tests in `test/index.spec.js`.
3. Run `npm test` to verify behavior.
4. Run `npm run dev` to test locally in a real Workers runtime.
5. When ready, run `npm run deploy` to publish.

**Note**: After changing bindings or configuration in `wrangler.jsonc`, run `npx wrangler types` to regenerate TypeScript types (if TypeScript is adopted later).

## Configuration

### Wrangler (`wrangler.jsonc`)

| Key                     | Value               | Description                                 |
| ----------------------- | ------------------- | ------------------------------------------- |
| `name`                  | `web-clipper`       | Worker name in Cloudflare                   |
| `main`                  | `src/index.js`      | Entry point                                 |
| `compatibility_date`    | `2026-05-14`        | Workers runtime compatibility date          |
| `compatibility_flags`   | `["nodejs_compat"]` | Enables Node.js API compatibility           |
| `observability.enabled` | `true`              | Turns on Cloudflare observability           |
| `upload_source_maps`    | `true`              | Uploads source maps for better stack traces |

### Prettier (`.prettierrc`)

| Key           | Value  |
| ------------- | ------ |
| `printWidth`  | `140`  |
| `singleQuote` | `true` |
| `semi`        | `true` |
| `useTabs`     | `true` |

### EditorConfig (`.editorconfig`)

- Indent style: `tab`
- End of line: `lf`
- Charset: `utf-8`
- Trim trailing whitespace: `true`
- Insert final newline: `true`

## Architecture

The project follows the standard Cloudflare Workers module pattern:

- **Entry Point**: `src/index.js` exports a default object with an `async fetch(request, env, ctx)` method.
- **Request Lifecycle**: Incoming HTTP requests are routed to the `fetch` handler, which can inspect the request, interact with bindings (KV, R2, D1, etc.), and return a `Response`.
- **Testing**: Tests use `@cloudflare/vitest-pool-workers` to spin up a simulated Workers runtime, allowing both direct handler invocation and full HTTP-style integration tests.

### Cloudflare Resources & Limits

Your knowledge of Cloudflare Workers APIs and limits may be outdated. Always retrieve current documentation before any Workers, KV, R2, D1, Durable Objects, Queues, Vectorize, AI, or Agents SDK task.

**Docs:**

- https://developers.cloudflare.com/workers/
- MCP: `https://docs.mcp.cloudflare.com/mcp`

For all limits and quotas, retrieve from the product's `/platform/limits/` page, e.g. `/workers/platform/limits`.

**Node.js Compatibility:** https://developers.cloudflare.com/workers/runtime-apis/nodejs/

**Common Errors:**

- **Error 1102** (CPU/Memory exceeded): Retrieve limits from `/workers/platform/limits/`
- **All errors**: https://developers.cloudflare.com/workers/observability/errors/

**Product API References:**

- `/kv/` · `/r2/` · `/d1/` · `/durable-objects/` · `/queues/` · `/vectorize/` · `/workers-ai/` · `/agents/`

**Best Practices (conditional):**

- Durable Objects: https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/
- Workflows: https://developers.cloudflare.com/workflows/build/rules-of-workflows/

## Contributing

1. Create a feature branch.
2. Follow the existing code style (Prettier + EditorConfig).
3. Add tests for new functionality.
4. Ensure all tests pass (`npm test`).
5. Submit a pull request.

## License

MIT License
