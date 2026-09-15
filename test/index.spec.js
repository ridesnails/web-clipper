import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import worker, { isValidUrl, extractTitle, makeSlug, cleanJinaBody, buildNote, stripEmptyLinks } from '../src';
import { fetchArticleFromUrl, parseFrontmatter } from '../src/jina.js';
import { signParam, verifyParam, timingSafeEqualStrings } from '../src/signing.js';
import { isPrivateHostname, isSsrfSafeUrl } from '../src/ssrf.js';

const mockEnv = {
	API_KEY: 'test-api-key',
	FNS_BASE: 'https://fns.oba.plus',
	FNS_TOKEN: 'test-fns-token',
	FNS_VAULT: 'Clip',
	CLIP_FOLDER: 'Clippings',
};

const telegraphPublicBaseUrl = 'https://clip.example.com';

function createRequest(body, method = 'POST', auth = `Bearer ${mockEnv.API_KEY}`) {
	const headers = { 'Content-Type': 'application/json' };
	if (auth) headers.Authorization = auth;
	return new Request('http://example.com', {
		method,
		headers,
		body: body ? JSON.stringify(body) : undefined,
	});
}

const jinaMarkdown = `Title: Test Article
URL Source: https://example.com/article
Published Time: 2024-01-01
Markdown Content:

# Test Article

This is the body content.`;

let originalFetch;
let fetchMock;

function createExecutionContext() {
	return {
		waitUntil: vi.fn(),
		passThroughOnException: vi.fn(),
	};
}

async function waitOnExecutionContext() {}

function jsonResponse(body, status = 200) {
	return new Response(JSON.stringify(body), { status });
}

function fnsListResponse(list = []) {
	return jsonResponse({
		status: true,
		data: {
			list,
			pager: { page: 1, pageSize: 10, totalRows: list.length },
		},
	});
}

function fnsCreateResponse(path = 'Clippings/2026-05/existing.md') {
	return jsonResponse({ status: true, data: { path } });
}

function fnsFailureResponse(message = 'vault not found') {
	return jsonResponse({ status: false, error: message });
}

function fnsGetNoteResponse(content, path = 'Clippings/2026-05/existing.md') {
	return jsonResponse({
		status: true,
		data: {
			path,
			content,
		},
	});
}

function installFetchRouter(routes) {
	fetchMock.mockImplementation((input, init = {}) => {
		const url = typeof input === 'string' ? input : input.url;
		for (const route of routes) {
			if (route.match(url, init)) {
				return Promise.resolve(typeof route.response === 'function' ? route.response(url, init) : route.response);
			}
		}
		throw new Error(`Unexpected fetch: ${url}`);
	});
}

beforeEach(() => {
	originalFetch = globalThis.fetch;
	fetchMock = vi.fn();
	globalThis.fetch = fetchMock;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	vi.restoreAllMocks();
});

// 1. Auth tests
describe('Auth', () => {
	it('Missing Authorization header -> 401', async () => {
		const request = createRequest({ url: 'https://example.com' }, 'POST', null);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, mockEnv, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: 'Unauthorized' });
	});

	it('Wrong Bearer token - 401', async () => {
		const request = createRequest({ url: 'https://example.com' }, 'POST', 'Bearer wrong-token');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, mockEnv, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(401);
	});

	it('Correct token - proceeds', async () => {
		fetchMock
			.mockResolvedValueOnce(new Response(jinaMarkdown, { status: 200 }))
			.mockResolvedValueOnce(fnsListResponse([]))
			.mockResolvedValueOnce(fnsCreateResponse());

		const request = createRequest({ url: 'https://example.com/article' });
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, mockEnv, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		const json = await response.json();
		expect(json.ok).toBe(true);
	});
});

// 2. Method tests
describe('Method', () => {
	it('GET - 405', async () => {
		const request = new Request('http://example.com', { method: 'GET' });
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, mockEnv, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(405);
	});

	it('PUT - 405', async () => {
		const request = new Request('http://example.com', { method: 'PUT' });
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, mockEnv, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(405);
	});

	it('DELETE - 405', async () => {
		const request = new Request('http://example.com', { method: 'DELETE' });
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, mockEnv, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(405);
	});

	it('POST with correct headers - proceeds', async () => {
		fetchMock
			.mockResolvedValueOnce(new Response(jinaMarkdown, { status: 200 }))
			.mockResolvedValueOnce(fnsListResponse([]))
			.mockResolvedValueOnce(fnsCreateResponse());

		const request = createRequest({ url: 'https://example.com/article' });
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, mockEnv, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
	});
});

// 3. Body/URL validation
describe('Body/URL validation', () => {
	it('Missing JSON body - 400', async () => {
		const request = new Request('http://example.com', {
			method: 'POST',
			headers: { Authorization: `Bearer ${mockEnv.API_KEY}`, 'Content-Type': 'application/json' },
			body: 'not valid json',
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, mockEnv, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(400);
	});

	it('Missing url field - 400', async () => {
		const request = createRequest({});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, mockEnv, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(400);
	});

	it('url is not a string - 400', async () => {
		const request = createRequest({ url: 123 });
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, mockEnv, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(400);
	});

	it('url is empty string - 400', async () => {
		const request = createRequest({ url: '' });
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, mockEnv, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(400);
	});

	it('Invalid URL (not http/https) - 400', async () => {
		const request = createRequest({ url: 'ftp://example.com/file' });
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, mockEnv, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(400);
	});
});

// 4. Unit tests for tool functions
describe('isValidUrl', () => {
	it('accepts valid http URL', () => {
		expect(isValidUrl('http://example.com')).toBe(true);
	});

	it('accepts valid https URL', () => {
		expect(isValidUrl('https://example.com/path?query=1')).toBe(true);
	});

	it('rejects ftp URL', () => {
		expect(isValidUrl('ftp://example.com/file')).toBe(false);
	});

	it('rejects javascript: scheme', () => {
		expect(isValidUrl('javascript:alert(1)')).toBe(false);
	});

	it('rejects mailto: scheme', () => {
		expect(isValidUrl('mailto:test@example.com')).toBe(false);
	});

	it('rejects empty string', () => {
		expect(isValidUrl('')).toBe(false);
	});

	it('rejects garbage string', () => {
		expect(isValidUrl('not a url at all')).toBe(false);
	});
});

describe('extractTitle', () => {
	it('extracts Title: prefix', () => {
		expect(extractTitle('Title: My Great Article\n\nSome body')).toBe('My Great Article');
	});

	it('falls back to first H1', () => {
		expect(extractTitle('# Hello World\n\nBody')).toBe('Hello World');
	});

	it('returns null when no title found', () => {
		expect(extractTitle('Just some plain text without headers')).toBeNull();
	});

	it('rejects URL-as-title and falls back to H1', () => {
		const md = 'Title: https://example.com\n# Real Title\nBody';
		expect(extractTitle(md)).toBe('Real Title');
	});

	it('rejects URL-as-title and returns null when no H1', () => {
		const md = 'Title: https://example.com\nBody';
		expect(extractTitle(md)).toBeNull();
	});
});

describe('makeSlug', () => {
	it('removes special chars', () => {
		expect(makeSlug('Hello / \\ : * ? " < > | # [ ] World')).toBe('Hello-World');
	});

	it('converts spaces to dashes', () => {
		expect(makeSlug('Hello World Test')).toBe('Hello-World-Test');
	});

	it('collapses multiple dashes', () => {
		expect(makeSlug('Hello    World')).toBe('Hello-World');
	});

	it('limits length to 80 chars', () => {
		const long = 'A'.repeat(100);
		expect(makeSlug(long).length).toBe(80);
	});

	it('returns untitled for empty string', () => {
		expect(makeSlug('')).toBe('untitled');
	});

	it('returns untitled when result is empty after stripping', () => {
		expect(makeSlug('???')).toBe('untitled');
	});
});

describe('cleanJinaBody', () => {
	it('splits on Markdown Content: marker', () => {
		const md = `Title: Foo
URL Source: https://example.com
Markdown Content:

Body here
More body`;
		expect(cleanJinaBody(md)).toBe('Body here\nMore body');
	});

	it('falls back to regex removal when no marker', () => {
		const md = `Title: Foo
URL Source: https://example.com
Body content here`;
		expect(cleanJinaBody(md)).toBe('Body content here');
	});
});

describe('buildNote', () => {
	it('formats frontmatter correctly', () => {
		const note = buildNote({
			title: 'My Title',
			url: 'https://example.com',
			date: '2024-01-01T00:00:00.000Z',
			body: 'Body text',
		});
		expect(note).toBe(`---
title: "My Title"
url: https://example.com
date: 2024-01-01T00:00:00.000Z
source: clipper
clip_method: url
clip_count: 1
last_clipped_at: 2024-01-01T00:00:00.000Z
---

# My Title

> [!info] 📌 信息
> - **来源**：[example.com](https://example.com)
> - **时间**：2024-01-01T00:00:00.000Z
> - **链接**：[原文链接](https://example.com)

## 📄 正文

Body text`);
	});

	it('escapes double quotes in title', () => {
		const note = buildNote({
			title: 'Say "Hello"',
			url: 'https://example.com',
			date: '2024-01-01T00:00:00.000Z',
			body: 'Body',
		});
		expect(note).toContain('title: "Say \\"Hello\\""');
	});
});

describe('stripEmptyLinks', () => {
	it('removes empty anchor links like [](url)', () => {
		const md = '## Heading [](https://example.com/anchor)';
		expect(stripEmptyLinks(md)).toBe('## Heading ');
	});

	it('removes links with only whitespace or zero-width space', () => {
		const md = 'Text [\u200B](https://example.com) more';
		expect(stripEmptyLinks(md)).toBe('Text  more');
	});

	it('leaves normal links untouched', () => {
		const md = '[link](https://example.com)';
		expect(stripEmptyLinks(md)).toBe('[link](https://example.com)');
	});
});

// 5. Integration tests with mocked fetch
describe('Integration with mocked fetch', () => {
	it('Mock Jina success - mock FNS success - verify 200 response with ok/title/path', async () => {
		fetchMock
			.mockResolvedValueOnce(new Response(jinaMarkdown, { status: 200 }))
			.mockResolvedValueOnce(fnsListResponse([]))
			.mockResolvedValueOnce(fnsCreateResponse());

		const request = createRequest({ url: 'https://example.com/article' });
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, mockEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const json = await response.json();
		expect(json.ok).toBe(true);
		expect(json.mode).toBe('created');
		expect(json.title).toBe('Test Article');
		expect(json.path).toMatch(/^Clippings\/\d{4}-\d{2}\/\d{8}T\d{6}Z-Test-Article\.md$/);
	});

	it('Mock Jina failure (non-200) - verify 502', async () => {
		vi.useFakeTimers();
		fetchMock
			.mockResolvedValueOnce(new Response('Jina error', { status: 500 }))
			.mockResolvedValueOnce(new Response('Jina error', { status: 500 }))
			.mockResolvedValueOnce(new Response('Jina error', { status: 500 }));

		try {
			const request = createRequest({ url: 'https://example.com/article' });
			const ctx = createExecutionContext();
			const responsePromise = worker.fetch(request, mockEnv, ctx);
			await vi.runAllTimersAsync();
			const response = await responsePromise;
			await waitOnExecutionContext(ctx);

			expect(response.status).toBe(502);
		} finally {
			vi.useRealTimers();
		}
	});

	it('Mock Jina success - mock FNS failure - verify 502', async () => {
		fetchMock
			.mockResolvedValueOnce(new Response(jinaMarkdown, { status: 200 }))
			.mockResolvedValueOnce(fnsListResponse([]))
			.mockResolvedValueOnce(fnsFailureResponse('vault not found'));

		const request = createRequest({ url: 'https://example.com/article' });
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, mockEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(502);
	});

	it('existing URL -> patch frontmatter and append update log instead of creating a new note', async () => {
		const existingPath = 'Clippings/2026-05/existing-note.md';
		const existingContent = `---
title: "Test Article"
url: https://example.com/article
date: 2024-01-01T00:00:00.000Z
source: clipper
clip_method: url
clip_count: 1
last_clipped_at: 2024-01-01T00:00:00.000Z
---

# Test Article

> [!info] 📌 信息
> - **链接**：[原文链接](https://example.com/article)

## 📄 正文

old body`;

		fetchMock
			.mockResolvedValueOnce(new Response(jinaMarkdown, { status: 200 }))
			.mockResolvedValueOnce(fnsListResponse([{ path: existingPath, pathHash: 'hash-1' }]))
			.mockResolvedValueOnce(fnsGetNoteResponse(existingContent, existingPath))
			.mockResolvedValueOnce(jsonResponse({ status: true }))
			.mockResolvedValueOnce(jsonResponse({ status: true }));

		const request = createRequest({ url: 'https://example.com/article' });
		const response = await worker.fetch(request, mockEnv, createExecutionContext());

		expect(response.status).toBe(200);
		const json = await response.json();
		expect(json.ok).toBe(true);
		expect(json.mode).toBe('updated');
		expect(json.path).toBe(existingPath);
		expect(fetchMock.mock.calls[3][0]).toBe(`${mockEnv.FNS_BASE}/api/note/frontmatter`);
		expect(fetchMock.mock.calls[4][0]).toBe(`${mockEnv.FNS_BASE}/api/note/append`);
		const patchBody = JSON.parse(fetchMock.mock.calls[3][1].body);
		expect(patchBody.path).toBe(existingPath);
		expect(patchBody.updates.clip_count).toBe(2);
		expect(patchBody.updates.clip_method).toBe('url');
		const appendBody = JSON.parse(fetchMock.mock.calls[4][1].body);
		expect(appendBody.path).toBe(existingPath);
		expect(appendBody.content).toContain('## 🔄 剪藏更新记录');
		expect(appendBody.content).toContain('再次剪藏，来源 post');
		expect(fetchMock.mock.calls.map((call) => call[0])).not.toContain(`${mockEnv.FNS_BASE}/api/note`);
	});

	it('direct handler invocation returns 405 for GET', async () => {
		const response = await worker.fetch(new Request('http://example.com', { method: 'GET' }), mockEnv, createExecutionContext());
		expect(response.status).toBe(405);
		expect(await response.json()).toEqual({ error: 'Method not allowed. Use POST.' });
	});
});

// 6. Telegraph + Telegram 集成测试（index.js 集成后开启）
describe('Telegraph + Telegram integration', () => {
	const telegraphEnv = {
		...mockEnv,
		TELEGRAPH_ACCESS_TOKEN: 'test-telegraph-token',
		IMG_BOT: '111111:IMGbotToken',
		TELEGRAM_CHAT_ID: '-1001234567890',
		CLIP_BOT: '222222:CLIPbotToken',
		USER_ID: '987654321',
		PUBLIC_BASE_URL: telegraphPublicBaseUrl,
	};

	it('POST / with Telegraph config - success returns telegraphUrl and telegramMessageId', async () => {
		const sourceHtml = `<!doctype html>
<html>
	<head><script>ignored()</script><style>.x{color:red}</style></head>
	<body>
		<article>
			<h2>HTML Source Heading</h2>
			<p>HTML-only body used by Telegraph.</p>
			<a href="/relative/path">relative link</a>
		</article>
		</body>
</html>`;
		const telegraphAiEnv = { ...telegraphEnv, AI_API_KEY: 'test-ai-key' };

		installFetchRouter([
			{
				match: (url, init) => url === 'https://r.jina.ai/' && init.method === 'POST',
				response: new Response(jinaMarkdown, { status: 200 }),
			},
			{
				match: (url) => url.includes('/chat/completions'),
				response: jsonResponse({
					choices: [
						{
							message: {
								content: JSON.stringify({ summary: '一段摘要', tags: ['云服务', 'Docker Deploy'] }),
							},
						},
					],
				}),
			},
			{
				match: (url) => url.includes('/api/notes?'),
				response: fnsListResponse([]),
			},
			{
				match: (url) => url === `${mockEnv.FNS_BASE}/api/note`,
				response: fnsCreateResponse(),
			},
			{
				match: (url) => url === 'https://example.com/article',
				response: new Response(sourceHtml, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }),
			},
			{
				match: (url) => url === 'https://api.telegra.ph/createPage',
				response: jsonResponse({
					ok: true,
					result: { url: 'https://telegra.ph/Test-05-21', path: 'Test-05-21', title: 'Test' },
				}),
			},
			{
				match: (url) => url === `https://api.telegram.org/bot${telegraphAiEnv.CLIP_BOT}/sendMessage`,
				response: jsonResponse({ ok: true, result: { message_id: 99 } }),
			},
		]);

		const request = createRequest({ url: 'https://example.com/article' });
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, telegraphAiEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const json = await response.json();
		expect(json.ok).toBe(true);
		expect(json.fnsOk).toBe(true);
		expect(json.telegraphOk).toBe(true);
		expect(json.telegraphUrl).toBe('https://telegra.ph/Test-05-21');
		expect(json.telegramMessageId).toBe(99);

		const telegraphCall = fetchMock.mock.calls.find((call) => call[0] === 'https://api.telegra.ph/createPage');
		const telegramCall = fetchMock.mock.calls.find((call) => call[0] === `https://api.telegram.org/bot${telegraphAiEnv.CLIP_BOT}/sendMessage`);
		const fnsCreateCall = fetchMock.mock.calls.find((call) => call[0] === `${mockEnv.FNS_BASE}/api/note`);
		expect(telegraphCall).toBeTruthy();
		expect(telegramCall).toBeTruthy();
		expect(fnsCreateCall).toBeTruthy();
		const telegraphPayload = JSON.parse(telegraphCall[1].body);
		expect(telegraphPayload.title).toBe('Test Article');
		const telegraphNodes = JSON.parse(telegraphPayload.content);
		const serializedNodes = JSON.stringify(telegraphNodes);
		expect(serializedNodes).toContain('HTML-only body used by Telegraph.');
		expect(serializedNodes).toContain('https://example.com/relative/path');
		expect(serializedNodes).not.toContain('This is the body content.');
		expect(serializedNodes).not.toContain('ignored()');
		const telegramPayload = JSON.parse(telegramCall[1].body);
		expect(telegramPayload.chat_id).toBe(telegraphAiEnv.USER_ID);
		const sentText = telegramPayload.text;
		expect(sentText.startsWith('https://telegra.ph/Test-05-21\n\n')).toBe(true);
		expect(sentText).toContain('一段摘要');
		expect(sentText).toContain('#云服务 #Docker_Deploy');
		expect(sentText).toContain('example.com');
		expect(telegramPayload.link_preview_options).toEqual({
			is_disabled: false,
			url: 'https://telegra.ph/Test-05-21',
			prefer_large_media: true,
		});

		const fnsPayload = JSON.parse(fnsCreateCall[1].body);
		expect(fnsPayload.content).toContain('> [!abstract] ✨ 摘要');
		expect(fnsPayload.content).toContain('> - **标签**：#云服务 #Docker_Deploy');
		expect(fnsPayload.content).toContain('> [!info] 📌 信息');
	});


	it('二次剪藏同 URL → 走 editPage 更新原页而非新建（KV 幂等记录）', async () => {
		const sourceHtml = '<article><h1>HTML Source Heading</h1><p>Body v1.</p></article>';
		const kvStore = new Map();
		const kvEnv = {
			...telegraphEnv,
			AI_API_KEY: 'test-ai-key',
			CLIP_KV: {
				async get(key) {
					return kvStore.has(key) ? kvStore.get(key) : null;
				},
				async put(key, value) {
					kvStore.set(key, value);
				},
			},
		};
		const jinaRoute = {
			match: (url, init) => url === 'https://r.jina.ai/' && init.method === 'POST',
			response: () => new Response(jinaMarkdown, { status: 200 }),
		};
		const summaryRoute = {
			match: (url) => url.includes('/chat/completions'),
			response: () => jsonResponse({
				choices: [{ message: { content: JSON.stringify({ summary: '一段摘要', tags: ['云服务'] }) } }],
			}),
		};
		const fnsRoutes = [
			{ match: (url) => url.includes('/api/notes?'), response: () => fnsListResponse([]) },
			{ match: (url) => url === `${mockEnv.FNS_BASE}/api/note`, response: () => fnsCreateResponse() },
		];
		const sourceRoute = {
			match: (url) => url === 'https://example.com/article',
			response: () => new Response(sourceHtml, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }),
		};
		const sendMessageRoute = {
			match: (url) => url === `https://api.telegram.org/bot${kvEnv.CLIP_BOT}/sendMessage`,
			response: () => jsonResponse({ ok: true, result: { message_id: 100 } }),
		};

		// 第一次剪藏：无 KV 记录 → createPage，双写后落 KV 记录
		installFetchRouter([
			jinaRoute,
			summaryRoute,
			...fnsRoutes,
			sourceRoute,
			{
				match: (url) => url === 'https://api.telegra.ph/createPage',
				response: () => jsonResponse({
					ok: true,
					result: { url: 'https://telegra.ph/Test-05-21', path: 'Test-05-21', title: 'Test' },
				}),
			},
			sendMessageRoute,
		]);

		const ctx1 = createExecutionContext();
		const firstResponse = await worker.fetch(createRequest({ url: 'https://example.com/article' }), kvEnv, ctx1);
		await waitOnExecutionContext(ctx1);

		expect(firstResponse.status).toBe(200);
		const firstJson = await firstResponse.json();
		expect(firstJson.telegraphOk).toBe(true);
		expect(firstJson.telegraphMode).toBe('created');
		expect(firstJson.telegraphPath).toBe('Test-05-21');

		expect(kvStore.size).toBe(1);
		const record = JSON.parse([...kvStore.values()][0]);
		expect(record.url).toBe('https://example.com/article');
		expect(record.telegraphPath).toBe('Test-05-21');
		expect(record.fnsPath).toBeTruthy();
		expect(record.updatedAt).toBeTruthy();

		// 第二次剪藏：同 URL 命中 KV 记录 → editPage；故意不注册 createPage 路由，
		// 若回退新建会因 Unexpected fetch 抛错而 telegraphOk=false，测试即失败
		installFetchRouter([
			jinaRoute,
			summaryRoute,
			...fnsRoutes,
			sourceRoute,
			{
				match: (url) => url === 'https://api.telegra.ph/editPage/Test-05-21',
				response: () => jsonResponse({
					ok: true,
					result: { url: 'https://telegra.ph/Test-05-21', path: 'Test-05-21', title: 'Test' },
				}),
			},
			sendMessageRoute,
		]);

		const ctx2 = createExecutionContext();
		const secondResponse = await worker.fetch(createRequest({ url: 'https://example.com/article' }), kvEnv, ctx2);
		await waitOnExecutionContext(ctx2);

		expect(secondResponse.status).toBe(200);
		const secondJson = await secondResponse.json();
		expect(secondJson.telegraphOk).toBe(true);
		expect(secondJson.telegraphMode).toBe('updated');
		expect(secondJson.telegraphUrl).toBe('https://telegra.ph/Test-05-21');

		const editCall = fetchMock.mock.calls.find((call) => call[0] === 'https://api.telegra.ph/editPage/Test-05-21');
		expect(editCall).toBeTruthy();
		const editPayload = JSON.parse(editCall[1].body);
		expect(editPayload.title).toBe('Test Article');
		const createCalls = fetchMock.mock.calls.filter((call) => call[0] === 'https://api.telegra.ph/createPage');
		expect(createCalls.length).toBe(1); // 仅第一次剪藏

		const sendMessageCalls = fetchMock.mock.calls.filter((call) => String(call[0]).includes('/sendMessage'));
		const lastPayload = JSON.parse(sendMessageCalls[sendMessageCalls.length - 1][1].body);
		expect(lastPayload.text).toContain('🔄 内容已更新');
	});
	it('POST / with localhost request origin rewrites Telegraph HTML images to PUBLIC_BASE_URL', async () => {
		const markdownWithImage = `Title: Test Article
URL Source: https://example.com/article
Published Time: 2024-01-01
Markdown Content:

# Test Article

![cover](https://img.example.com/cover.jpg)

Body.`;
		const sourceHtml = '<article><h1>HTML Article</h1><img src="/cover.jpg"><p>Body.</p></article>';

		installFetchRouter([
			{
				match: (url, init) => url === 'https://r.jina.ai/' && init.method === 'POST',
				response: new Response(markdownWithImage, { status: 200 }),
			},
			{
				match: (url) => url.includes('/api/notes?'),
				response: fnsListResponse([]),
			},
			{
				match: (url) => url === `${mockEnv.FNS_BASE}/api/note`,
				response: fnsCreateResponse(),
			},
			{
				match: (url) => url === 'https://example.com/article',
				response: new Response(sourceHtml, { status: 200, headers: { 'Content-Type': 'text/html' } }),
			},
			{
				match: (url) => url === 'https://example.com/cover.jpg',
				response: new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'Content-Type': 'image/jpeg' } }),
			},
			{
				match: (url) => url === `https://api.telegram.org/bot${telegraphEnv.IMG_BOT}/sendPhoto`,
				response: jsonResponse({
					ok: true,
					result: {
						message_id: 77,
						photo: [{ file_id: 'photo-file-1', file_unique_id: 'uniq-1', width: 800 }],
					},
				}),
			},
			{
				match: (url) => url === 'https://api.telegra.ph/createPage',
				response: jsonResponse({
					ok: true,
					result: { url: 'https://telegra.ph/Test-05-21', path: 'Test-05-21', title: 'Test' },
				}),
			},
			{
				match: (url) => url === `https://api.telegram.org/bot${telegraphEnv.CLIP_BOT}/sendMessage`,
				response: jsonResponse({ ok: true, result: { message_id: 100 } }),
			},
			{
				match: (url) => url === `https://api.telegram.org/bot${telegraphEnv.CLIP_BOT}/sendPhoto`,
				response: jsonResponse({ ok: true, result: { message_id: 555 } }),
			},
		]);

		const request = new Request('http://127.0.0.1:8787', {
			method: 'POST',
			headers: { Authorization: `Bearer ${mockEnv.API_KEY}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ url: 'https://example.com/article' }),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, telegraphEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const json = await response.json();
		expect(json.fnsOk).toBe(true);
		expect(json.telegraphOk).toBe(true);
		const telegraphCall = fetchMock.mock.calls.find((call) => call[0] === 'https://api.telegra.ph/createPage');
		expect(fetchMock.mock.calls.some((call) => call[0] === 'https://example.com/article')).toBe(true);
		expect(fetchMock.mock.calls.some((call) => call[0] === 'https://example.com/cover.jpg')).toBe(true);
		expect(fetchMock.mock.calls.some((call) => call[0] === `https://api.telegram.org/bot${telegraphEnv.IMG_BOT}/sendPhoto`)).toBe(true);
		const telegraphPayload = JSON.parse(telegraphCall[1].body);
		const telegraphNodes = JSON.parse(telegraphPayload.content);
		const serializedNodes = JSON.stringify(telegraphNodes);
		expect(serializedNodes).toContain(`${telegraphPublicBaseUrl}/image-proxy?file_id=photo-file-1&sig=`);
		expect(serializedNodes).not.toContain('https://example.com/cover.jpg');
		expect(serializedNodes).not.toContain('127.0.0.1:8787/image-proxy');
	});

	it('POST / respects IMAGE_PROXY_LIMIT - proxies first N images, keeps rest as original URLs (方案A subrequest guard)', async () => {
		const markdownWithImage = `Title: Test Article
URL Source: https://example.com/article
Published Time: 2024-01-01
Markdown Content:

# Test Article

Body.`;
		const sourceHtml = '<article><h1>HTML Article</h1><img src="/img-1.jpg"><img src="/img-2.jpg"><img src="/img-3.jpg"><p>Body.</p></article>';
		const limitedEnv = { ...telegraphEnv, IMAGE_PROXY_LIMIT: '2' };

		installFetchRouter([
			{
				match: (url, init) => url === 'https://r.jina.ai/' && init.method === 'POST',
				response: new Response(markdownWithImage, { status: 200 }),
			},
			{
				match: (url) => url.includes('/api/notes?'),
				response: fnsListResponse([]),
			},
			{
				match: (url) => url === `${mockEnv.FNS_BASE}/api/note`,
				response: fnsCreateResponse(),
			},
			{
				match: (url) => url === 'https://example.com/article',
				response: new Response(sourceHtml, { status: 200, headers: { 'Content-Type': 'text/html' } }),
			},
			{
				match: (url) => url.startsWith('https://example.com/img-'),
				// 函数式：Response body 一次性，多图 fetch 各需新实例
				response: () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'Content-Type': 'image/jpeg' } }),
			},
			{
				match: (url) => url === `https://api.telegram.org/bot${telegraphEnv.IMG_BOT}/sendPhoto`,
				response: () => jsonResponse({
					ok: true,
					result: {
						message_id: 77,
						photo: [{ file_id: 'photo-file-1', file_unique_id: 'uniq-1', width: 800 }],
					},
				}),
			},
			{
				match: (url) => url === 'https://api.telegra.ph/createPage',
				response: jsonResponse({
					ok: true,
					result: { url: 'https://telegra.ph/Test-05-21', path: 'Test-05-21', title: 'Test' },
				}),
			},
			{
				match: (url) => url === `https://api.telegram.org/bot${telegraphEnv.CLIP_BOT}/sendMessage`,
				response: jsonResponse({ ok: true, result: { message_id: 100 } }),
			},
			{
				match: (url) => url === `https://api.telegram.org/bot${telegraphEnv.CLIP_BOT}/sendPhoto`,
				response: jsonResponse({ ok: true, result: { message_id: 555 } }),
			},
		]);

		const request = new Request('http://127.0.0.1:8787', {
			method: 'POST',
			headers: { Authorization: `Bearer ${mockEnv.API_KEY}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ url: 'https://example.com/article' }),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, limitedEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const json = await response.json();
		expect(json.fnsOk).toBe(true);
		expect(json.telegraphOk).toBe(true);

		// 只有前 2 张被 fetch+sendPhoto，第 3 张不产生任何 subrequest
		const sendPhotoCalls = fetchMock.mock.calls.filter((call) => call[0] === `https://api.telegram.org/bot${telegraphEnv.IMG_BOT}/sendPhoto`);
		expect(sendPhotoCalls.length).toBe(2);

		const telegraphCall = fetchMock.mock.calls.find((call) => call[0] === 'https://api.telegra.ph/createPage');
		const telegraphNodes = JSON.parse(JSON.parse(telegraphCall[1].body).content);
		const serializedNodes = JSON.stringify(telegraphNodes);
		// 前 2 张替换为代理 URL
		expect(serializedNodes).toContain(`${telegraphPublicBaseUrl}/image-proxy?file_id=photo-file-1&sig=`);
		expect(serializedNodes).not.toContain('https://example.com/img-1.jpg');
		expect(serializedNodes).not.toContain('https://example.com/img-2.jpg');
		// 超限第 3 张保留原 URL，正文照常返回
		expect(serializedNodes).toContain('https://example.com/img-3.jpg');
	});

	it('POST / sends photo notification via CLIP_BOT sendPhoto', async () => {
		const markdownWithImage = `Title: Test Article
URL Source: https://example.com/article
Published Time: 2024-01-01
Markdown Content:

# Test Article

Body.`;
		const sourceHtml = '<article><h1>HTML Article</h1><img src="/img-1.jpg"><p>Body.</p></article>';
		installFetchRouter([
			{
				match: (url, init) => url === 'https://r.jina.ai/' && init.method === 'POST',
				response: new Response(markdownWithImage, { status: 200 }),
			},
			{
				match: (url) => url.includes('/api/notes?'),
				response: fnsListResponse([]),
			},
			{
				match: (url) => url === `${mockEnv.FNS_BASE}/api/note`,
				response: fnsCreateResponse(),
			},
			{
				match: (url) => url === 'https://example.com/article',
				response: new Response(sourceHtml, { status: 200, headers: { 'Content-Type': 'text/html' } }),
			},
			{
				match: (url) => url.startsWith('https://example.com/img-'),
				response: () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'Content-Type': 'image/jpeg' } }),
			},
			{
				match: (url) => url === `https://api.telegram.org/bot${telegraphEnv.IMG_BOT}/sendPhoto`,
				response: () => jsonResponse({
					ok: true,
					result: {
						message_id: 77,
						photo: [{ file_id: 'photo-file-1', file_unique_id: 'uniq-1', width: 800 }],
					},
				}),
			},
			{
				match: (url) => url === 'https://api.telegra.ph/createPage',
				response: jsonResponse({
					ok: true,
					result: { url: 'https://telegra.ph/Test-05-21', path: 'Test-05-21', title: 'Test' },
				}),
			},
			{
				match: (url) => url === `https://api.telegram.org/bot${telegraphEnv.CLIP_BOT}/sendPhoto`,
				response: jsonResponse({ ok: true, result: { message_id: 555 } }),
			},
			{
				match: (url) => url === `https://api.telegram.org/bot${telegraphEnv.CLIP_BOT}/sendMessage`,
				response: jsonResponse({ ok: true, result: { message_id: 100 } }),
			},
		]);
		const request = new Request('http://127.0.0.1:8787', {
			method: 'POST',
			headers: { Authorization: `Bearer ${mockEnv.API_KEY}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ url: 'https://example.com/article' }),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, telegraphEnv, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		const json = await response.json();
		expect(json.telegraphOk).toBe(true);
		expect(json.telegramMessageId).toBe(555);
		const clipSendPhotoCalls = fetchMock.mock.calls.filter((call) => call[0] === `https://api.telegram.org/bot${telegraphEnv.CLIP_BOT}/sendPhoto`);
		expect(clipSendPhotoCalls.length).toBe(1);
		const notifyPayload = JSON.parse(clipSendPhotoCalls[0][1].body);
		expect(notifyPayload.chat_id).toBe('987654321');
		expect(notifyPayload.photo.startsWith(`${telegraphPublicBaseUrl}/image-proxy?file_id=photo-file-1&sig=`)).toBe(true);
		// 通知 URL 带一次性 cache-buster（&cb=），规避 Telegram 抓取器按 URL 缓存的旧 octet-stream 响应
		expect(/&cb=[a-z0-9]+$/.test(notifyPayload.photo)).toBe(true);
		expect(notifyPayload.caption.startsWith('https://telegra.ph/Test-05-21')).toBe(true);
		expect(notifyPayload.parse_mode).toBe('HTML');
		const clipSendMessageCalls = fetchMock.mock.calls.filter((call) => call[0] === `https://api.telegram.org/bot${telegraphEnv.CLIP_BOT}/sendMessage`);
		expect(clipSendMessageCalls.length).toBe(0);
	});

	it('POST / falls back to sendMessage when CLIP_BOT sendPhoto fails', async () => {
		const markdownWithImage = `Title: Test Article
URL Source: https://example.com/article
Published Time: 2024-01-01
Markdown Content:

# Test Article

Body.`;
		const sourceHtml = '<article><h1>HTML Article</h1><img src="/img-1.jpg"><p>Body.</p></article>';
		installFetchRouter([
			{
				match: (url, init) => url === 'https://r.jina.ai/' && init.method === 'POST',
				response: new Response(markdownWithImage, { status: 200 }),
			},
			{
				match: (url) => url.includes('/api/notes?'),
				response: fnsListResponse([]),
			},
			{
				match: (url) => url === `${mockEnv.FNS_BASE}/api/note`,
				response: fnsCreateResponse(),
			},
			{
				match: (url) => url === 'https://example.com/article',
				response: new Response(sourceHtml, { status: 200, headers: { 'Content-Type': 'text/html' } }),
			},
			{
				match: (url) => url.startsWith('https://example.com/img-'),
				response: () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'Content-Type': 'image/jpeg' } }),
			},
			{
				match: (url) => url === `https://api.telegram.org/bot${telegraphEnv.IMG_BOT}/sendPhoto`,
				response: () => jsonResponse({
					ok: true,
					result: {
						message_id: 77,
						photo: [{ file_id: 'photo-file-1', file_unique_id: 'uniq-1', width: 800 }],
					},
				}),
			},
			{
				match: (url) => url === 'https://api.telegra.ph/createPage',
				response: jsonResponse({
					ok: true,
					result: { url: 'https://telegra.ph/Test-05-21', path: 'Test-05-21', title: 'Test' },
				}),
			},
			{
				match: (url) => url === `https://api.telegram.org/bot${telegraphEnv.CLIP_BOT}/sendPhoto`,
				response: jsonResponse({ ok: false, description: 'Bad Request: PHOTO_INVALID_DIMENSIONS' }, 400),
			},
			{
				match: (url) => url === `https://api.telegram.org/bot${telegraphEnv.CLIP_BOT}/sendMessage`,
				response: jsonResponse({ ok: true, result: { message_id: 100 } }),
			},
		]);
		const request = new Request('http://127.0.0.1:8787', {
			method: 'POST',
			headers: { Authorization: `Bearer ${mockEnv.API_KEY}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ url: 'https://example.com/article' }),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, telegraphEnv, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		const json = await response.json();
		expect(json.telegraphOk).toBe(true);
		expect(json.telegramMessageId).toBe(100);
		const clipSendPhotoCalls = fetchMock.mock.calls.filter((call) => call[0] === `https://api.telegram.org/bot${telegraphEnv.CLIP_BOT}/sendPhoto`);
		expect(clipSendPhotoCalls.length).toBe(1);
		const clipSendMessageCalls = fetchMock.mock.calls.filter((call) => call[0] === `https://api.telegram.org/bot${telegraphEnv.CLIP_BOT}/sendMessage`);
		expect(clipSendMessageCalls.length).toBe(1);
		const fallbackPayload = JSON.parse(clipSendMessageCalls[0][1].body);
		expect(fallbackPayload.chat_id).toBe('987654321');
		expect(fallbackPayload.link_preview_options.url).toBe('https://telegra.ph/Test-05-21');
		expect(fallbackPayload.text.startsWith('https://telegra.ph/Test-05-21')).toBe(true);
	});

	it('POST / when Telegraph fails - FNS still succeeds, no telegraphUrl in response', async () => {
		installFetchRouter([
			{
				match: (url, init) => url === 'https://r.jina.ai/' && init.method === 'POST',
				response: new Response(jinaMarkdown, { status: 200 }),
			},
			{
				match: (url) => url.includes('/api/notes?'),
				response: fnsListResponse([]),
			},
			{
				match: (url) => url === `${mockEnv.FNS_BASE}/api/note`,
				response: fnsCreateResponse(),
			},
			{
				match: (url) => url === 'https://example.com/article',
				response: new Response('<article><p>HTML body</p></article>', { status: 200, headers: { 'Content-Type': 'text/html' } }),
			},
			{
				match: (url) => url === 'https://api.telegra.ph/createPage',
				response: () => {
					throw new Error('Telegraph API error');
				},
			},
		]);

		const request = createRequest({ url: 'https://example.com/article' });
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, telegraphEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const json = await response.json();
		expect(json.ok).toBe(true);
		expect(json.fnsOk).toBe(true);
		expect(json.telegraphOk).toBe(false);
		expect(json.telegraphUrl).toBeUndefined();
	});

	it('POST / when FNS fails - Telegraph still succeeds, returns telegraphUrl without path', async () => {
		const sourceHtml = '<article><p>HTML body</p></article>';

		installFetchRouter([
			{
				match: (url, init) => url === 'https://r.jina.ai/' && init.method === 'POST',
				response: new Response(jinaMarkdown, { status: 200 }),
			},
			{
				match: (url) => url.includes('/api/notes?'),
				response: fnsListResponse([]),
			},
			{
				match: (url) => url === `${mockEnv.FNS_BASE}/api/note`,
				response: fnsFailureResponse('vault not found'),
			},
			{
				match: (url) => url === 'https://example.com/article',
				response: new Response(sourceHtml, { status: 200, headers: { 'Content-Type': 'text/html' } }),
			},
			{
				match: (url) => url === 'https://api.telegra.ph/createPage',
				response: jsonResponse({
					ok: true,
					result: { url: 'https://telegra.ph/Test-05-21', path: 'Test-05-21', title: 'Test' },
				}),
			},
			{
				match: (url) => url === `https://api.telegram.org/bot${telegraphEnv.CLIP_BOT}/sendMessage`,
				response: jsonResponse({ ok: true, result: { message_id: 101 } }),
			},
		]);

		const request = createRequest({ url: 'https://example.com/article' });
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, telegraphEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const json = await response.json();
		expect(json.ok).toBe(true);
		expect(json.fnsOk).toBe(false);
		// FNS 写失败但 Telegraph 成功 = 部分成功，partial 必须为 true（客户端可据补齐）
		expect(json.partial).toBe(true);
		expect(json.path).toBeUndefined();
		expect(json.telegraphOk).toBe(true);
		expect(json.telegraphUrl).toBe('https://telegra.ph/Test-05-21');
		expect(json.telegramMessageId).toBe(101);
	});

	it('POST / when FNS and Telegraph both fail - returns 502', async () => {
		fetchMock
			.mockResolvedValueOnce(new Response(jinaMarkdown, { status: 200 }))
			.mockResolvedValueOnce(fnsListResponse([]))
			.mockResolvedValueOnce(fnsFailureResponse('vault not found'))
			.mockResolvedValueOnce(new Response('<article><p>HTML body</p></article>', { status: 200, headers: { 'Content-Type': 'text/html' } }))
			.mockRejectedValueOnce(new Error('Telegraph API error'));

		const request = createRequest({ url: 'https://example.com/article' });
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, telegraphEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(502);
		const json = await response.json();
		expect(json.error).toContain('FNS failed:');
		expect(json.error).toContain('Telegraph failed:');
	});
});

// 7. Image proxy 路由测试
describe('Image proxy route', () => {
	it('GET /image-proxy?file_id=xxx - success returns image with correct headers', async () => {
		fetchMock
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						ok: true,
						result: {
							file_path: 'photos/file_1.jpg',
						},
					}),
					{ status: 200 },
				),
			)
			.mockResolvedValueOnce(
				new Response(new Uint8Array([1, 2, 3]), {
					status: 200,
					headers: { 'Content-Type': 'image/jpeg' },
				}),
			);

		const sig = await signParam('abc123', mockEnv);
		const request = new Request(`http://example.com/image-proxy?file_id=abc123&sig=${sig}`);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, mockEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toBe('image/jpeg');
		expect(response.headers.get('Cache-Control')).toContain('max-age=86400');
	});

	it('GET /image-proxy - rewrites octet-stream to image/* by file_path extension (Telegram file server always serves octet-stream)', async () => {
		fetchMock
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						ok: true,
						result: {
							file_path: 'photos/file_124.jpg',
						},
					}),
					{ status: 200 },
				),
			)
			.mockResolvedValueOnce(
				new Response(new Uint8Array([1, 2, 3]), {
					status: 200,
					headers: { 'Content-Type': 'application/octet-stream' },
				}),
			);

		const sig = await signParam('cover-jpg', mockEnv);
		const request = new Request(`http://example.com/image-proxy?file_id=cover-jpg&sig=${sig}`);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, mockEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		// 上游 octet-stream 会被 sendPhoto URL 模式拒收（failed to get HTTP URL content），
		// 必须按 file_path 扩展名推导 image/*。
		expect(response.headers.get('Content-Type')).toBe('image/jpeg');
	});

	it('GET /image-proxy - passes through upstream image/* content type untouched', async () => {
		fetchMock
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						ok: true,
						result: {
							file_path: 'photos/file_9.png',
						},
					}),
					{ status: 200 },
				),
			)
			.mockResolvedValueOnce(
				new Response(new Uint8Array([4, 5, 6]), {
					status: 200,
					headers: { 'Content-Type': 'image/png' },
				}),
			);

		const sig = await signParam('cover-png', mockEnv);
		const request = new Request(`http://example.com/image-proxy?file_id=cover-png&sig=${sig}`);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, mockEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toBe('image/png');
	});

	it('GET /image-proxy without file_id - returns 400', async () => {
		const request = new Request('http://example.com/image-proxy');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, mockEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: 'Missing file_id' });
	});

	it('GET /image-proxy?file_id=invalid - getFile fails returns 502', async () => {
		fetchMock.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					ok: false,
					description: 'invalid file_id',
				}),
				{ status: 200 },
			),
		);

		const sig = await signParam('invalid', mockEnv);
		const request = new Request(`http://example.com/image-proxy?file_id=invalid&sig=${sig}`);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, mockEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(502);
	});

	it('GET /image-proxy without signature - returns 403', async () => {
		const request = new Request('http://example.com/image-proxy?file_id=abc123');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, mockEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ error: 'Invalid or missing signature' });
	});

	it('GET /image-proxy with wrong signature - returns 403', async () => {
		const request = new Request(
			`http://example.com/image-proxy?file_id=abc123&sig=${await signParam('other-file', mockEnv)}`,
		);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, mockEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(403);
	});
});

// 8. Telegram webhook 剪藏入口测试
describe('Telegram webhook clip entry', () => {
	const webhookEnv = {
		...mockEnv,
		TELEGRAM_WEBHOOK_SECRET: 'test-webhook-secret',
		CLIP_BOT: '222222:CLIPbotToken',
		USER_ID: '987654321',
	};

	function createTelegramWebhookRequest(update, secret = webhookEnv.TELEGRAM_WEBHOOK_SECRET) {
		const headers = { 'Content-Type': 'application/json' };
		if (secret) headers['X-Telegram-Bot-Api-Secret-Token'] = secret;
		return new Request('https://clip.example.com/telegram-webhook', {
			method: 'POST',
			headers,
			body: JSON.stringify(update),
		});
	}

	function createTelegramUpdate(text, fromId = webhookEnv.USER_ID, chatId = webhookEnv.USER_ID) {
		return {
			update_id: 1,
			message: {
				message_id: 10,
				from: { id: Number(fromId) },
				chat: { id: Number(chatId), type: 'private' },
				text,
			},
		};
	}

	it('secret 不匹配时静默忽略', async () => {
		const request = createTelegramWebhookRequest(createTelegramUpdate('https://example.com/article'), 'wrong-secret');
		const response = await worker.fetch(request, webhookEnv, createExecutionContext());

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('非 USER_ID 白名单用户时静默忽略', async () => {
		const request = createTelegramWebhookRequest(createTelegramUpdate('https://example.com/article', '123456', '123456'));
		const response = await worker.fetch(request, webhookEnv, createExecutionContext());

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('无链接时回复提示', async () => {
		fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: { message_id: 20 } }), { status: 200 }));

		const request = createTelegramWebhookRequest(createTelegramUpdate('hello'));
		const response = await worker.fetch(request, webhookEnv, createExecutionContext());

		expect(response.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0][0]).toBe(`https://api.telegram.org/bot${webhookEnv.CLIP_BOT}/sendMessage`);
		const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
		expect(String(payload.chat_id)).toBe(webhookEnv.USER_ID);
		expect(payload.text).toContain('请发送一个 http/https 网页链接');
	});

	it('收到链接时复用剪藏流程，成功后不额外回复', async () => {
		fetchMock
			.mockResolvedValueOnce(new Response(jinaMarkdown, { status: 200 }))
			.mockResolvedValueOnce(fnsListResponse([]))
			.mockResolvedValueOnce(fnsCreateResponse());

		const request = createTelegramWebhookRequest(createTelegramUpdate('请剪藏 https://example.com/article'));
		const response = await worker.fetch(request, webhookEnv, createExecutionContext());

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true });
		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(fetchMock.mock.calls[0][0]).toBe('https://r.jina.ai/');
		expect(fetchMock.mock.calls[0][1].method).toBe('POST');
		expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ url: 'https://example.com/article' });
		expect(fetchMock.mock.calls[1][0]).toContain(`${webhookEnv.FNS_BASE}/api/notes?`);
		expect(fetchMock.mock.calls[2][0]).toBe(`${webhookEnv.FNS_BASE}/api/note`);
	});
});

// 9. SingleFile 上传入口测试
describe('SingleFile upload entry', () => {
	function createSingleFileRequest({ html, url = 'https://example.com/article', auth = `Bearer ${mockEnv.API_KEY}` }) {
		const form = new FormData();
		form.append('singlehtmlfile', new File([html], 'article.html', { type: 'text/html' }));
		form.append('url', url);
		const headers = auth ? { Authorization: auth } : undefined;
		return new Request('http://127.0.0.1:8787/upload-html', {
			method: 'POST',
			headers,
			body: form,
		});
	}

	it('POST /upload-html - success writes FNS without calling Jina', async () => {
		const html = '<html><head><title>SingleFile Title</title></head><body><article><h1>SingleFile Title</h1><p>Hello from SingleFile.</p></article></body></html>';

		fetchMock.mockResolvedValueOnce(fnsListResponse([])).mockResolvedValueOnce(fnsCreateResponse());

		const request = createSingleFileRequest({ html });
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, mockEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const json = await response.json();
		expect(json.ok).toBe(true);
		expect(json.title).toBe('SingleFile Title');
		expect(json.fnsOk).toBe(true);
		expect(json.path).toContain('SingleFile-Title.md');
		expect(json.telegraphOk).toBe(false);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(fetchMock.mock.calls[0][0]).toContain(`${mockEnv.FNS_BASE}/api/notes?`);
		expect(fetchMock.mock.calls[1][0]).toBe(`${mockEnv.FNS_BASE}/api/note`);
		const fnsPayload = JSON.parse(fetchMock.mock.calls[1][1].body);
		expect(fnsPayload.content).toContain('Hello from SingleFile.');
		expect(fnsPayload.content).not.toContain('Markdown Content:');
	});

	it('POST /upload-html with Telegraph config - prefers uploaded HTML instead of fetching source page', async () => {
		const html = '<html><head><title>Uploaded HTML Title</title></head><body><article><h1>Uploaded HTML Title</h1><p>Body from uploaded file.</p><img src="https://img.example.com/cover.jpg"></article></body></html>';
		const singleFileTelegraphEnv = {
			...mockEnv,
			TELEGRAPH_ACCESS_TOKEN: 'tg',
			IMG_BOT: '111111:IMGbotToken',
			TELEGRAM_CHAT_ID: '-1001234567890',
			CLIP_BOT: '222222:CLIPbotToken',
			USER_ID: '123',
			PUBLIC_BASE_URL: telegraphPublicBaseUrl,
		};

		installFetchRouter([
			{
				match: (url) => url.includes('/api/notes?'),
				response: fnsListResponse([]),
			},
			{
				match: (url) => url === `${mockEnv.FNS_BASE}/api/note`,
				response: fnsCreateResponse(),
			},
			{
				match: (url) => url === 'https://img.example.com/cover.jpg',
				response: new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'Content-Type': 'image/jpeg' } }),
			},
			{
				match: (url) => url === `https://api.telegram.org/bot${singleFileTelegraphEnv.IMG_BOT}/sendPhoto`,
				response: jsonResponse({
					ok: true,
					result: {
						message_id: 88,
						photo: [{ file_id: 'photo-file-2', file_unique_id: 'uniq-2', width: 800 }],
					},
				}),
			},
			{
				match: (url) => url === 'https://api.telegra.ph/createPage',
				response: jsonResponse({
					ok: true,
					result: { url: 'https://telegra.ph/Uploaded-05-21', path: 'Uploaded-05-21', title: 'Uploaded' },
				}),
			},
			{
				match: (url) => url === `https://api.telegram.org/bot${singleFileTelegraphEnv.CLIP_BOT}/sendMessage`,
				response: jsonResponse({ ok: true, result: { message_id: 102 } }),
			},
			{
				match: (url) => url === `https://api.telegram.org/bot${singleFileTelegraphEnv.CLIP_BOT}/sendPhoto`,
				response: jsonResponse({ ok: true, result: { message_id: 555 } }),
			},
		]);

		const request = createSingleFileRequest({ html });
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, singleFileTelegraphEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const json = await response.json();
		expect(json.fnsOk).toBe(true);
		expect(json.telegraphOk).toBe(true);
		expect(fetchMock.mock.calls.some((call) => String(call[0]).includes(`${mockEnv.FNS_BASE}/api/notes?`))).toBe(true);
		expect(fetchMock.mock.calls.some((call) => call[0] === `${mockEnv.FNS_BASE}/api/note`)).toBe(true);
		expect(fetchMock.mock.calls.some((call) => call[0] === 'https://img.example.com/cover.jpg')).toBe(true);
		expect(fetchMock.mock.calls.some((call) => call[0] === `https://api.telegram.org/bot${singleFileTelegraphEnv.IMG_BOT}/sendPhoto`)).toBe(true);
		expect(fetchMock.mock.calls.some((call) => call[0] === `https://api.telegram.org/bot${singleFileTelegraphEnv.CLIP_BOT}/sendPhoto`)).toBe(true);
		const telegraphCall = fetchMock.mock.calls.find((call) => call[0] === 'https://api.telegra.ph/createPage');
		const telegraphPayload = JSON.parse(telegraphCall[1].body);
		const serializedNodes = JSON.stringify(JSON.parse(telegraphPayload.content));
		expect(serializedNodes).toContain('Body from uploaded file.');
		// 前缀会挂原文链接；正文仍应来自上传 HTML，而非再抓取源站全文
		expect(serializedNodes).toContain('原文链接');
		expect(serializedNodes).toContain('https://example.com/article');
		expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('r.jina.ai'))).toBe(false);
	});

	it('POST /upload-html for nodeseek-like rich article - keeps real images but filters svg placeholders', async () => {
		const html = `
			<html>
				<head>
					<title>Nodeseek Rich Post</title>
					<meta property="og:url" content="https://www.nodeseek.com/post-735659-1" />
				</head>
				<body>
					<article>
						<p>Before image</p>
						<img alt="placeholder" src="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'></svg>" />
						<img alt="real-image" src="data:image/webp;base64,AAAA" />
						<p>After image</p>
					</article>
				</body>
			</html>
		`;

		fetchMock.mockResolvedValueOnce(fnsListResponse([])).mockResolvedValueOnce(fnsCreateResponse());

		const request = createSingleFileRequest({ html, url: 'https://www.nodeseek.com/post-735659-1' });
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, mockEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const fnsPayload = JSON.parse(fetchMock.mock.calls[1][1].body);
		expect(fnsPayload.content).toContain('![real-image](data:image/webp;base64,AAAA)');
		expect(fnsPayload.content).not.toContain('data:image/svg+xml');
	});

	it('POST /upload-html - rewrites inline base64 images to worker proxy URLs when PUBLIC_BASE_URL is configured', async () => {
		const html = `
			<html>
				<head><title>Inline Image Post</title></head>
				<body>
					<article>
						<p>Inline image below.</p>
						<img alt="inline" src="data:image/png;base64,QUJDRA==" />
					</article>
				</body>
			</html>
		`;
		const env = {
			...mockEnv,
			IMG_BOT: '111111:IMGbotToken',
			TELEGRAM_CHAT_ID: '-1001234567890',
			PUBLIC_BASE_URL: telegraphPublicBaseUrl,
		};

		fetchMock
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						ok: true,
						result: {
							message_id: 77,
							photo: [{ file_id: 'inline-photo-file', file_unique_id: 'uniq-inline', width: 800 }],
						},
					}),
					{ status: 200 },
				),
			)
			.mockResolvedValueOnce(fnsListResponse([]))
			.mockResolvedValueOnce(fnsCreateResponse());

		const request = createSingleFileRequest({ html });
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const payload = JSON.parse(fetchMock.mock.calls[2][1].body);
		expect(payload.content).toContain(`${telegraphPublicBaseUrl}/image-proxy?file_id=inline-photo-file&sig=`);
		expect(payload.content).not.toContain('data:image/png;base64,QUJDRA==');
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it('POST /upload-html for nodeseek-like page - chooses the longest post-content block', async () => {
		const html = `
			<html>
				<head>
					<title>Nodeseek Multi Post</title>
					<meta property="og:url" content="https://www.nodeseek.com/post-735659-1" />
				</head>
				<body>
					<article class="post-content"><p>Short reply</p></article>
					<article class="post-content">
						<p>Main article first paragraph.</p>
						<p>Main article second paragraph with more content.</p>
						<img alt="real-image" src="data:image/webp;base64,BBBB" />
					</article>
				</body>
			</html>
		`;

		fetchMock.mockResolvedValueOnce(fnsListResponse([])).mockResolvedValueOnce(fnsCreateResponse());

		const request = createSingleFileRequest({ html, url: 'https://www.nodeseek.com/post-735659-1' });
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, mockEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const fnsPayload = JSON.parse(fetchMock.mock.calls[1][1].body);
		expect(fnsPayload.content).toContain('Main article first paragraph.');
		expect(fnsPayload.content).toContain('Main article second paragraph with more content.');
		expect(fnsPayload.content).toContain('![real-image](data:image/webp;base64,BBBB)');
		expect(fnsPayload.content).not.toContain('Short reply');
	});
});

// 10. Jina fetch unit tests (POST + frontmatter contract)
describe('parseFrontmatter', () => {
	it('parses frontmatter keys and strips them from body', () => {
		const md = `---
title: "FM Title"
url: "https://example.com/article"
publishedTime: "Sun, 30 Aug 2026 04:11:49 GMT"
warning: "This is a cached snapshot"
---

# Heading

Body text.`;
		const { meta, body } = parseFrontmatter(md);
		expect(meta).toEqual({
			title: 'FM Title',
			url: 'https://example.com/article',
			publishedtime: 'Sun, 30 Aug 2026 04:11:49 GMT',
			warning: 'This is a cached snapshot',
		});
		expect(body).toContain('# Heading');
		expect(body).not.toContain('title:');
	});

	it('does not treat --- ruledown body as frontmatter (guard)', () => {
		const md = '---\nplain text\n---\n\nBody';
		const { meta, body } = parseFrontmatter(md);
		expect(meta).toBeNull();
		expect(body).toBe(md);
	});
});

describe('fetchArticleFromUrl unit', () => {
	it('POSTs JSON body to r.jina.ai root, keeps hash fragment, request headers', async () => {
		fetchMock.mockResolvedValueOnce(new Response('---\ntitle: "T"\nurl: "https://example.com/article"\n---\n\nBody', { status: 200 }));
		const article = await fetchArticleFromUrl('https://example.com/article#frag', mockEnv);
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe('https://r.jina.ai/');
		expect(init.method).toBe('POST');
		expect(JSON.parse(init.body)).toEqual({ url: 'https://example.com/article#frag' });
		expect(init.headers['Content-Type']).toBe('application/json');
		expect(init.headers['X-Engine']).toBe('browser');
		expect(init.headers['X-Respond-With']).toBe('frontmatter');
		expect(init.headers['X-Md-Bullet-List-Marker']).toBe('-');
		expect(init.headers['X-No-Cache']).toBeUndefined();
		expect(article.title).toBe('T');
		expect(article.url).toBe('https://example.com/article');
		expect(article.markdownBody).toBe('Body');
	});

	it('rejects invalid url before fetching', async () => {
		await expect(fetchArticleFromUrl('notaurl', mockEnv)).rejects.toThrow(/invalid url/);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('forwards targetSelector/waitForSelector headers only when provided', async () => {
		fetchMock.mockResolvedValueOnce(new Response('---\ntitle: "T"\nurl: "https://example.com/a"\n---\n\nB', { status: 200 }));
		await fetchArticleFromUrl('https://example.com/a', mockEnv, { targetSelector: '#VPContent' });
		expect(fetchMock.mock.calls[0][1].headers['X-Target-Selector']).toBe('#VPContent');
		expect(fetchMock.mock.calls[0][1].headers['X-Wait-For-Selector']).toBeUndefined();

		fetchMock.mockResolvedValueOnce(new Response('---\ntitle: "T"\nurl: "https://example.com/a"\n---\n\nB', { status: 200 }));
		await fetchArticleFromUrl('https://example.com/a', mockEnv, {});
		expect(fetchMock.mock.calls[1][1].headers['X-Target-Selector']).toBeUndefined();
	});

	it('retries a 500 with X-No-Cache on the second attempt', async () => {
		fetchMock
			.mockResolvedValueOnce(new Response('boom', { status: 500 }))
			.mockResolvedValueOnce(new Response('---\ntitle: "R"\nurl: "https://example.com/a"\n---\n\nB', { status: 200 }));
		const article = await fetchArticleFromUrl('https://example.com/a', mockEnv);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(fetchMock.mock.calls[0][1].headers['X-No-Cache']).toBeUndefined();
		expect(fetchMock.mock.calls[1][1].headers['X-No-Cache']).toBe('true');
		expect(article.title).toBe('R');
	});

	it('falls back to legacy Jina plain-text format (Title:/Markdown Content:)', async () => {
		fetchMock.mockResolvedValueOnce(new Response(jinaMarkdown, { status: 200 }));
		const article = await fetchArticleFromUrl('https://example.com/article', mockEnv);
		expect(article.title).toBe('Test Article');
		expect(article.markdownBody).toContain('This is the body content.');
		expect(article.markdownBody).not.toContain('Title:');
	});
});

describe('Signing helper', () => {
	const signingEnv = { API_KEY: 'test-api-key' };

	it('signParam is deterministic per (value, env)', async () => {
		const a = await signParam('Clippings/x.html', signingEnv);
		const b = await signParam('Clippings/x.html', signingEnv);
		expect(a).toBe(b);
		expect(a).toMatch(/^[0-9a-f]{64}$/);
	});

	it('signParam differs for different values and keys', async () => {
		const a = await signParam('a', signingEnv);
		const b = await signParam('b', signingEnv);
		const c = await signParam('a', { API_KEY: 'other-key' });
		expect(a).not.toBe(b);
		expect(a).not.toBe(c);
	});

	it('verifyParam accepts valid signature and rejects wrong value/sig', async () => {
		const sig = await signParam('file-1', signingEnv);
		await expect(verifyParam('file-1', sig, signingEnv)).resolves.toBe(true);
		await expect(verifyParam('file-2', sig, signingEnv)).resolves.toBe(false);
		await expect(verifyParam('file-1', `${sig}0`, signingEnv)).resolves.toBe(false);
		await expect(verifyParam('file-1', '', signingEnv)).resolves.toBe(false);
	});

	it('verifyParam fails closed without any configured key', async () => {
		await expect(verifyParam('file-1', 'aa', { SIGNING_SECRET: '', API_KEY: '' })).resolves.toBe(false);
	});

	it('signParam throws without any configured key', async () => {
		let threw = false;
		try {
			await signParam('x', { SIGNING_SECRET: '', API_KEY: '' });
		} catch {
			threw = true;
		}
		expect(threw).toBe(true);
	});

	it('timingSafeEqualStrings compares in constant time semantics', () => {
		expect(timingSafeEqualStrings('abc', 'abc')).toBe(true);
		expect(timingSafeEqualStrings('abc', 'abd')).toBe(false);
		expect(timingSafeEqualStrings('abc', 'abcd')).toBe(false);
		expect(timingSafeEqualStrings('', '')).toBe(true);
	});
});

describe('SSRF guard', () => {
	it('blocks loopback / private / special IPv4 ranges', () => {
		for (const host of [
			'localhost', 'foo.localhost', 'foo.local', 'foo.internal',
			'127.0.0.1', '10.0.0.1', '172.16.0.1', '172.31.255.255',
			'192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
			'192.0.2.1', '198.18.0.1', '224.0.0.1', '240.0.0.1',
			'256.1.1.1', '1.2.3',
		]) {
			expect(isPrivateHostname(host)).toBe(true);
		}
	});

	it('blocks non-canonical IPv4 spellings (decimal / hex / octal / mixed)', () => {
		expect(isPrivateHostname('2130706433')).toBe(true); // 127.0.0.1
		expect(isPrivateHostname('0x7f000001')).toBe(true);
		expect(isPrivateHostname('0177')).toBe(true);
		expect(isPrivateHostname('0177.0.0.1')).toBe(true);
		expect(isPrivateHostname('0x7f.0.0.1')).toBe(true);
		expect(isPrivateHostname('127.1')).toBe(true);
		expect(isSsrfSafeUrl('http://2130706433/')).toBe(false);
		expect(isSsrfSafeUrl('http://0x7f000001/')).toBe(false);
	});

	it('blocks local IPv6 and embedded-IPv4 forms', () => {
		expect(isPrivateHostname('::1')).toBe(true);
		expect(isPrivateHostname('[::1]')).toBe(true);
		expect(isPrivateHostname('::')).toBe(true);
		expect(isPrivateHostname('0:0:0:0:0:0:0:1')).toBe(true);
		expect(isPrivateHostname('::ffff:127.0.0.1')).toBe(true);
		expect(isPrivateHostname('fc00::1')).toBe(true);
		expect(isPrivateHostname('fd12:3456::1')).toBe(true);
		expect(isPrivateHostname('fe80::1')).toBe(true);
		expect(isPrivateHostname('::ffff:0808:0001')).toBe(true);
	});

	it('allows public hosts and rejects non-http(s) protocols / garbage', () => {
		expect(isPrivateHostname('8.8.8.8')).toBe(false);
		expect(isPrivateHostname('172.32.0.1')).toBe(false);
		expect(isPrivateHostname('100.128.0.1')).toBe(false);
		expect(isPrivateHostname('example.com')).toBe(false);
		expect(isPrivateHostname('2606:4700::1111')).toBe(false);
		expect(isSsrfSafeUrl('https://example.com/a')).toBe(true);
		expect(isSsrfSafeUrl('http://8.8.8.8/x')).toBe(true);
		expect(isSsrfSafeUrl('http://[::1]:8787/')).toBe(false);
		expect(isSsrfSafeUrl('file:///etc/passwd')).toBe(false);
		expect(isSsrfSafeUrl('ftp://example.com')).toBe(false);
		expect(isSsrfSafeUrl('not a url')).toBe(false);
	});
});

describe('HTML view route', () => {
	it('GET /html-view without signature - returns 403', async () => {
		const request = new Request('http://example.com/html-view?path=Clippings/2026-09/x.html');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, mockEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(403);
		expect(await response.text()).toContain('Invalid or missing signature');
	});

	it('GET /html-view with wrong signature - returns 403', async () => {
		const sig = await signParam('Clippings/other.html', mockEnv);
		const request = new Request(`http://example.com/html-view?path=Clippings/2026-09/x.html&sig=${sig}`);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, mockEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(403);
	});

	it('GET /html-view with valid signature - returns note content as html', async () => {
		const htmlPath = 'Clippings/2026-09/x.html';
		const sig = await signParam(htmlPath, mockEnv);
		fetchMock.mockResolvedValueOnce(
			jsonResponse({ status: true, data: { content: '<html><body>hello clip</body></html>' } }),
		);
		const request = new Request(`http://example.com/html-view?path=${encodeURIComponent(htmlPath)}&sig=${sig}`);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, mockEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toContain('text/html');
		expect(await response.text()).toContain('hello clip');
	});

	it('GET /html-view when FNS read fails - returns 404', async () => {
		const htmlPath = 'Clippings/2026-09/missing.html';
		const sig = await signParam(htmlPath, mockEnv);
		fetchMock.mockResolvedValueOnce(jsonResponse({ status: false, error: 'nope' }));
		const request = new Request(`http://example.com/html-view?path=${encodeURIComponent(htmlPath)}&sig=${sig}`);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, mockEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(404);
	});
});

describe('Auth hardening', () => {
	it('POST / with unset API_KEY fails closed with 500 instead of accepting Bearer undefined', async () => {
		const brokenEnv = { ...mockEnv, API_KEY: '' };
		const request = new Request('http://example.com/', {
			method: 'POST',
			headers: { Authorization: 'Bearer undefined', 'Content-Type': 'application/json' },
			body: JSON.stringify({ url: 'https://example.com/article' }),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, brokenEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(500);
		const payload = await response.json();
		expect(payload.error).toContain('API_KEY');
	});
});
