import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import worker, { isValidUrl, extractTitle, makeSlug, cleanJinaBody, buildNote, stripEmptyLinks } from '../src';

// 预 mock Telegraph/Telegram 模块，供后续集成测试使用
vi.mock('../src/telegraph.js', async () => {
	const actual = await vi.importActual('../src/telegraph.js');
	return {
		...actual,
		createPage: vi.fn(),
	};
});
vi.mock('../src/telegram.js', async () => {
	const actual = await vi.importActual('../src/telegram.js');
	return {
		...actual,
		sendMessage: vi.fn(),
		getFile: vi.fn(),
	};
});

const mockEnv = {
	API_KEY: 'test-api-key',
	FNS_BASE: 'https://fns.oba.plus',
	FNS_TOKEN: 'test-fns-token',
	FNS_VAULT: 'Clip',
	CLIP_FOLDER: 'Clippings',
};

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
			.mockResolvedValueOnce(new Response(JSON.stringify({ status: true }), { status: 200 }));

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
			.mockResolvedValueOnce(new Response(JSON.stringify({ status: true }), { status: 200 }));

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
---

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
			.mockResolvedValueOnce(new Response(JSON.stringify({ status: true }), { status: 200 }));

		const request = createRequest({ url: 'https://example.com/article' });
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, mockEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const json = await response.json();
		expect(json.ok).toBe(true);
		expect(json.title).toBe('Test Article');
		expect(json.path).toMatch(/^Clippings\/\d{4}-\d{2}\/Test-Article\.md$/);
	});

	it('Mock Jina failure (non-200) - verify 502', async () => {
		fetchMock
			.mockResolvedValueOnce(new Response('Jina error', { status: 500 }))
			.mockResolvedValueOnce(new Response('Jina error', { status: 500 }))
			.mockResolvedValueOnce(new Response('Jina error', { status: 500 }));

		const request = createRequest({ url: 'https://example.com/article' });
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, mockEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(502);
	});

	it('Mock Jina success - mock FNS failure - verify 502', async () => {
		fetchMock
			.mockResolvedValueOnce(new Response(jinaMarkdown, { status: 200 }))
			.mockResolvedValueOnce(new Response(JSON.stringify({ status: false, error: 'vault not found' }), { status: 200 }));

		const request = createRequest({ url: 'https://example.com/article' });
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, mockEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(502);
	});

	it('integration style with SELF.fetch', async () => {
		const response = await SELF.fetch('http://example.com', { method: 'GET' });
		expect(response.status).toBe(405);
		expect(await response.json()).toEqual({ error: 'Method not allowed. Use POST.' });
	});
});

// 6. Telegraph + Telegram 集成测试（index.js 集成后开启）
describe('Telegraph + Telegram integration', () => {
	const telegraphEnv = {
		...mockEnv,
		TELEGRAPH_ACCESS_TOKEN: 'test-telegraph-token',
		TELEGRAM_BOT_TOKEN: '123456:ABCdef',
		TELEGRAM_CHAT_ID: '-1001234567890',
	};

	it('POST / with Telegraph config - success returns telegraphUrl and telegramMessageId', async () => {
		const { createPage } = await import('../src/telegraph.js');
		const { sendMessage } = await import('../src/telegram.js');
		createPage.mockResolvedValueOnce({ url: 'https://telegra.ph/Test-05-21', path: 'Test-05-21', title: 'Test' });
		sendMessage.mockResolvedValueOnce({ message_id: 99 });

		fetchMock
			.mockResolvedValueOnce(new Response(jinaMarkdown, { status: 200 }))
			.mockResolvedValueOnce(new Response(JSON.stringify({ status: true }), { status: 200 }));

		const request = createRequest({ url: 'https://example.com/article' });
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, telegraphEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const json = await response.json();
		expect(json.ok).toBe(true);
		expect(json.telegraphUrl).toBe('https://telegra.ph/Test-05-21');
		expect(json.telegramMessageId).toBe(99);

		expect(sendMessage).toHaveBeenCalledTimes(1);
		const sentText = sendMessage.mock.calls[0][0];
		expect(sentText).toContain('#webclipper');
		expect(sentText).toContain('https://telegra.ph/Test-05-21');
		expect(sentText).toContain('example.com');
	});

	it('POST / when Telegraph fails - FNS still succeeds, no telegraphUrl in response', async () => {
		const { createPage } = await import('../src/telegraph.js');
		createPage.mockRejectedValueOnce(new Error('Telegraph API error'));

		fetchMock
			.mockResolvedValueOnce(new Response(jinaMarkdown, { status: 200 }))
			.mockResolvedValueOnce(new Response(JSON.stringify({ status: true }), { status: 200 }));

		const request = createRequest({ url: 'https://example.com/article' });
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, telegraphEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const json = await response.json();
		expect(json.ok).toBe(true);
		expect(json.telegraphUrl).toBeUndefined();
	});
});

// 7. Image proxy 路由测试
describe('Image proxy route', () => {
	it('GET /image-proxy?file_id=xxx - success returns image with correct headers', async () => {
		const { getFile } = await import('../src/telegram.js');
		getFile.mockResolvedValueOnce({
			file_path: 'photos/file_1.jpg',
			file_url: 'https://api.telegram.org/file/bot123/photos/file_1.jpg',
		});

		fetchMock.mockResolvedValueOnce(
			new Response(new Uint8Array([1, 2, 3]), {
				status: 200,
				headers: { 'Content-Type': 'image/jpeg' },
			})
		);

		const request = new Request('http://example.com/image-proxy?file_id=abc123');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, mockEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toBe('image/jpeg');
		expect(response.headers.get('Cache-Control')).toContain('max-age=86400');
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
		const { getFile } = await import('../src/telegram.js');
		getFile.mockRejectedValueOnce(new Error('invalid file_id'));

		const request = new Request('http://example.com/image-proxy?file_id=invalid');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, mockEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(502);
	});
});
