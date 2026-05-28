# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install          # install deps
npm test             # run full Vitest suite (test/*.spec.js)
npx vitest run test/singlefile.spec.js   # single file
npx vitest -t "title pattern"            # single test by name
npm run dev          # local Worker via wrangler dev (http://localhost:8787)
npm run deploy       # wrangler deploy to Cloudflare
```

Vitest runs under `environment: 'node'` (see `vitest.config.js`) — not the Cloudflare Workers pool. Tests import handlers directly and stub `globalThis.fetch`; there is no simulated Workers runtime in tests.

## Architecture

Single Worker (`src/index.js`) with three entry points that all funnel into one shared pipeline.

```
POST /                  ──┐
POST /upload-html       ──┼──► clipArticle() ──► Promise.allSettled([
POST /telegram-webhook  ──┘                        writeToFns(),
                                                   pushTelegraphAndTelegram()
                                                 ])
```

- `handleJsonClipRequest` — URL → Jina Reader (`r.jina.ai`) → markdown.
- `handleSingleFileClipRequest` — multipart HTML upload → `parseSingleFileUpload` (Readability + linkedom + vendored Turndown) → markdown.
- `handleTelegramWebhook` — extracts first URL from a Telegram message, then re-enters the worker through a synthetic `POST /` request (so it reuses the JSON path verbatim).

`clipArticle` is the convergence point. It builds the slug, frontmatter, and note body, optionally calls AI for summary/tags, then runs FNS write + Telegraph/Telegram push **in parallel**. Either side may fail independently; only when *both* fail does the response become 502.

### FNS dedupe + soft-update

`writeToFns` first searches FNS by URL (`findExistingNoteByUrl` → `/api/notes` then `/api/note` to confirm via `noteContainsUrl`). If a match is found, it does **not** overwrite — instead it `PATCH`es frontmatter (`last_clipped_at`, `clip_count`, `clip_method`, optional `summary`/`tags`) and appends a line under `## 🔄 剪藏更新记录`. Response carries `mode: 'created' | 'updated'`.

### Image handling (Telegram as a free image bucket)

Telegraph's native upload is gone, so images flow through Telegram:

1. Extract `<img src>` from the source HTML (or markdown image links if HTML unavailable).
2. Fetch each image and `sendPhoto` to the `IMG_BOT` channel; collect `file_id`.
3. Rewrite image URLs in HTML/markdown to `${PUBLIC_BASE_URL}/image-proxy?file_id=...`.
4. The Worker's own `/image-proxy` route streams the Telegram file back with a 24h `Cache-Control`.

`externalizeInlineImages` does the same for SingleFile `data:image/...` base64 inlines (capped at `MAX_SINGLEFILE_INLINE_IMAGES = 6`, concurrency 3) so base64 never reaches the FNS markdown.

### Module map

| File | Role |
| --- | --- |
| `src/index.js` | Routing, auth, pipeline orchestration, FNS API client, Telegram webhook, image proxy. |
| `src/singlefile.js` | SingleFile HTML → article markdown via Readability + linkedom + Turndown. Has a per-host preserve list (e.g. nodeseek) and SVG-placeholder filtering. |
| `src/telegraph.js` | HTML/markdown → Telegraph Node tree + `createPage` API. |
| `src/telegram.js` | `sendPhoto` / `sendMessage` / `getFile` wrappers around Bot API. Uses `IMG_BOT` for images and `CLIP_BOT` for notifications, falling back to legacy `TELEGRAM_BOT_TOKEN`. |
| `src/code-blocks.js` | Fenced-code helpers (language extraction, fence sizing) shared by Turndown rules. |
| `src/vendor/turndown.cjs.js` | Vendored Turndown CJS build — required because the npm `turndown` ESM build doesn't run cleanly under `nodejs_compat`. Do not replace with the npm import. |

### Auth & CORS

- Every non-webhook route requires `Authorization: Bearer ${API_KEY}`.
- `/telegram-webhook` is gated by header `X-Telegram-Bot-Api-Secret-Token === TELEGRAM_WEBHOOK_SECRET` and a `USER_ID` (or legacy `TELEGRAM_CHAT_ID`) allowlist on the message sender. Always returns `200 {ok:true}` (Telegram retries otherwise).
- All POST responses include `Access-Control-Allow-Origin: *` so browser bookmarklets work; `OPTIONS` handled with 204.
- `GET /favicon.ico` returns 204 to silence browser noise.

## Configuration

Secrets are managed via `wrangler secret` in production and `.dev.vars` locally (gitignored — do not commit). Required for the main path: `API_KEY`, `JINA_API_KEY`, `FNS_BASE`, `FNS_VAULT`, `FNS_TOKEN`, `CLIP_FOLDER`. Optional groups: `TELEGRAPH_ACCESS_TOKEN` + `IMG_BOT`/`IMG_CHAT_ID` + `CLIP_BOT`/`USER_ID` + `TELEGRAM_WEBHOOK_SECRET` for push notifications, `AI_API_KEY`/`AI_BASE_URL`/`AI_MODEL` for summary/tags, `PUBLIC_BASE_URL` for image-proxy URL rewriting (auto-derived from request URL when unset, but only if the request host is public).

`wrangler.jsonc` has no `vars` block — everything goes through secrets. `compatibility_flags: ["nodejs_compat"]` is required because `singlefile.js` uses `Buffer.from(base64)` and `linkedom`/`Readability` rely on Node-style globals.

## Code style

- Tabs, single quotes, semicolons, 140 column width (Prettier).
- Comments and identifiers freely mix Chinese and English — preserve the existing style of whatever module you're editing.
- The codebase prefers small free functions over classes. Errors propagate as thrown `Error`s and get caught at the route boundary.

## Notes for future edits

- `AGENTS.md` is older than the current code and undercounts the project (claims a single 165-line `index.js`). Trust `src/` and the tests over `AGENTS.md` when they disagree.
- A bare `http(s)://` URL pasted into chat is treated as a clip request, per the project's chat convention.
- `tmp/`, `plan_*`, `temp-*` files at the repo root are scratch — not part of the build.
