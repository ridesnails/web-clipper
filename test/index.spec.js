import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import worker from '../src';

describe('Web Clipper Worker', () => {
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		globalThis.fetch = vi.fn();
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it('handles CORS preflight (OPTIONS)', async () => {
		const request = new Request('http://example.com', { method: 'OPTIONS' });
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(204);
		expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
		expect(response.headers.get('Access-Control-Allow-Methods')).toBe('POST, OPTIONS');
		expect(response.headers.get('Access-Control-Allow-Headers')).toBe('Authorization, Content-Type');
	});

	it('rejects GET with 405', async () => {
		const request = new Request('http://example.com', { method: 'GET' });
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(405);
		expect(await response.text()).toBe('Method GET not allowed');
	});

	it('rejects HEAD with 405', async () => {
		const request = new Request('http://example.com', { method: 'HEAD' });
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(405);
		expect(await response.text()).toBe('Method HEAD not allowed');
	});

	it('returns 204 for favicon.ico', async () => {
		const request = new Request('http://example.com/favicon.ico');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(204);
	});

	it('returns 400 for missing url', async () => {
		const request = new Request('http://example.com', {
			method: 'POST',
			body: JSON.stringify({}),
			headers: { 'Content-Type': 'application/json' },
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(400);
		const body = await response.json();
		expect(body.error).toBe('Missing url parameter');
	});

	it('fetches content via Jina Reader', async () => {
		vi.mocked(globalThis.fetch).mockResolvedValueOnce(new Response('Extracted content', { status: 200 }));

		const request = new Request('http://example.com', {
			method: 'POST',
			body: JSON.stringify({ url: 'https://example.com/article' }),
			headers: { 'Content-Type': 'application/json' },
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.content).toBe('Extracted content');
	});

	it('retries Jina on 429 and succeeds', async () => {
		vi.mocked(globalThis.fetch)
			.mockResolvedValueOnce(new Response('Rate limited', { status: 429 }))
			.mockResolvedValueOnce(new Response('Extracted content', { status: 200 }));

		const request = new Request('http://example.com', {
			method: 'POST',
			body: JSON.stringify({ url: 'https://example.com/article' }),
			headers: { 'Content-Type': 'application/json' },
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		expect(globalThis.fetch).toHaveBeenCalledTimes(2);
	});

	it('retries Jina on 5xx and eventually fails', async () => {
		vi.mocked(globalThis.fetch)
			.mockResolvedValueOnce(new Response('Error', { status: 502 }))
			.mockResolvedValueOnce(new Response('Error', { status: 503 }))
			.mockResolvedValueOnce(new Response('Error', { status: 504 }));

		const request = new Request('http://example.com', {
			method: 'POST',
			body: JSON.stringify({ url: 'https://example.com/article' }),
			headers: { 'Content-Type': 'application/json' },
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(500);
		expect(globalThis.fetch).toHaveBeenCalledTimes(3);
	});

	it('sends Jina API Key when configured', async () => {
		vi.mocked(globalThis.fetch).mockResolvedValueOnce(new Response('Extracted content', { status: 200 }));

		const customEnv = { ...env, JINA_API_KEY: 'test-key' };
		const request = new Request('http://example.com', {
			method: 'POST',
			body: JSON.stringify({ url: 'https://example.com/article' }),
			headers: { 'Content-Type': 'application/json' },
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, customEnv, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		const calls = vi.mocked(globalThis.fetch).mock.calls;
		const jinaCall = calls.find(([url]) => url.toString().includes('r.jina.ai'));
		expect(jinaCall[1].headers.Authorization).toBe('Bearer test-key');
	});
});
