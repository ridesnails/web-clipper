## web-clipper

A Cloudflare Worker for clipping and processing web content at the edge.

## Overview

`web-clipper` is a serverless edge worker built on the Cloudflare Workers platform. It is designed to intercept HTTP requests, process web content, and return clipped or transformed responses — all running at the edge, close to end users for minimal latency.

The project is currently in early initialization. The core worker entry point is located at `src/index.js`, and the infrastructure is configured for rapid iteration with local development via Wrangler, automated testing via Vitest, and observability via Cloudflare's built-in logging and source map upload.

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

| File | Purpose |
|------|---------|
| `src/index.js` | Main Worker script. Exports a `fetch` handler that receives `request`, `env`, and `ctx`. |
| `test/index.spec.js` | Test suite demonstrating both direct `worker.fetch()` unit tests and `SELF.fetch()` integration tests. |
| `wrangler.jsonc` | Declares Worker name, entry point, compatibility date, flags, and observability settings. |
| `vitest.config.js` | Configures Vitest to use the Cloudflare Workers test pool with `wrangler.jsonc`. |

## Key Features

- **Edge Worker Runtime**: Runs on Cloudflare's global edge network for low-latency request handling.
- **Node.js Compatibility**: Enabled via `compatibility_flags: ["nodejs_compat"]` for access to Node.js APIs.
- **Observability**: Source maps uploaded automatically; Cloudflare observability enabled in `wrangler.jsonc`.
- **Test Coverage**: Supports both unit-style tests (calling the handler directly) and integration-style tests (via `SELF.fetch`).
- **Developer Experience**: Prettier + EditorConfig ensure consistent formatting across editors.

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

| Script | Command | Purpose |
|--------|---------|---------|
| `dev` | `wrangler dev` | Start local development server |
| `start` | `wrangler dev` | Alias for `dev` |
| `deploy` | `wrangler deploy` | Deploy the Worker to Cloudflare |
| `test` | `vitest` | Run the Vitest test suite |

### Development Workflow

1. Edit `src/index.js` to implement request handling logic.
2. Add or update tests in `test/index.spec.js`.
3. Run `npm test` to verify behavior.
4. Run `npm run dev` to test locally in a real Workers runtime.
5. When ready, run `npm run deploy` to publish.

**Note**: After changing bindings or configuration in `wrangler.jsonc`, run `npx wrangler types` to regenerate TypeScript types (if TypeScript is adopted later).

## Configuration

### Wrangler (`wrangler.jsonc`)

| Key | Value | Description |
|-----|-------|-------------|
| `name` | `web-clipper` | Worker name in Cloudflare |
| `main` | `src/index.js` | Entry point |
| `compatibility_date` | `2026-05-14` | Workers runtime compatibility date |
| `compatibility_flags` | `["nodejs_compat"]` | Enables Node.js API compatibility |
| `observability.enabled` | `true` | Turns on Cloudflare observability |
| `upload_source_maps` | `true` | Uploads source maps for better stack traces |

### Prettier (`.prettierrc`)

| Key | Value |
|-----|-------|
| `printWidth` | `140` |
| `singleQuote` | `true` |
| `semi` | `true` |
| `useTabs` | `true` |

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

This project is private (`"private": true` in `package.json`). Licensing terms are not specified.
