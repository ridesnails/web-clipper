// 阶段四C：异步剪藏契约测试（纯 Node，复用 index.spec.js 的 worker.fetch 范式）。
// fake step 只复现 step.do 的调用语义；真实重试/暂挂由引擎负责，不在此测。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import worker from '../src';
import { ClipWorkflow, registerClipHandler } from '../src/clip-workflow.js';

const mockEnv = {
	API_KEY: 'test-api-key',
	FNS_BASE: 'https://fns.oba.plus',
	FNS_TOKEN: 'test-fns-token',
	FNS_VAULT: 'Clip',
	CLIP_FOLDER: 'Clippings',
};

function createRequest(body, method = 'POST', auth = `Bearer ${mockEnv.API_KEY}`, path = '/json-async') {
	const headers = { 'Content-Type': 'application/json' };
	if (auth) headers.Authorization = auth;
	return new Request(`http://example.com${path}`, {
		method,
		headers,
		body: body ? JSON.stringify(body) : undefined,
	});
}

function createStatusRequest(query, auth = `Bearer ${mockEnv.API_KEY}`) {
	const headers = {};
	if (auth) headers.Authorization = auth;
	return new Request(`http://example.com/clip-status${query}`, { method: 'GET', headers });
}

function createExecutionContext() {
	return {
		waitUntil: () => {},
		passThroughOnException: () => {},
	};
}

// Fake Workflow binding：create 存 payload（供断言投递内容），status 停在 queued
// （worker 入口层不执行 run——那一步在真实环境由引擎接管）。
function makeWorkflowBinding() {
	const instances = new Map();
	return {
		instances,
		async create({ params }) {
			const id = `wf-${instances.size + 1}`;
			instances.set(id, { params: params[0] });
			return { id };
		},
		get(id) {
			const inst = instances.get(id);
			if (!inst) throw new Error(`instance ${id} not found`);
			return {
				status: async () => ({ status: 'queued' }),
				__payload: inst.params,
			};
		},
	};
}

function makeFakeStep() {
	const calls = [];
	return {
		calls,
		do: async (name, configOrFn, maybeFn) => {
			const config = typeof configOrFn === 'function' ? undefined : configOrFn;
			const fn = typeof configOrFn === 'function' ? configOrFn : maybeFn;
			calls.push({ name, config });
			return await fn();
		},
	};
}

describe('ClipWorkflow engine contract', () => {
	// registerClipHandler 是模块级单例；每例先清空，no-handler 用例放最后防污染。
	beforeEach(() => registerClipHandler(null));
	afterEach(() => registerClipHandler(null));

	it('runs the registered handler inside a step and returns a serializable result', async () => {
		registerClipHandler(async (requestBody, requestUrl, env, clipMethodHeader) =>
			Response.json({ ok: true, got: requestBody.url, via: clipMethodHeader, envKey: env.API_KEY, reqUrl: requestUrl }),
		);
		const wf = new ClipWorkflow({}, mockEnv);
		const step = makeFakeStep();
		const result = await wf.run(
			{
				payload: {
					requestBody: { url: 'https://a.example/x' },
					requestUrl: 'https://worker.example/json',
					clipMethodHeader: 'url',
				},
			},
			step,
		);
		expect(result).toEqual({
			status: 200,
			body: {
				ok: true,
				got: 'https://a.example/x',
				via: 'url',
				envKey: 'test-api-key',
				reqUrl: 'https://worker.example/json',
			},
		});
		// 契约：整个剪藏链包在单个 step 里，重试间隔(120s)必须长于 ClipLock 的 90s TTL。
		expect(step.calls).toHaveLength(1);
		expect(step.calls[0].name).toBe('perform-clip');
		expect(step.calls[0].config.retries).toEqual({ limit: 2, delay: 120000, backoff: 'constant' });
		expect(step.calls[0].config.retries.delay).toBeGreaterThan(90000);
	});

	it('throws on 5xx so the engine can retry', async () => {
		registerClipHandler(async () => Response.json({ error: 'upstream blew up' }, { status: 502 }));
		const wf = new ClipWorkflow({}, mockEnv);
		await expect(wf.run({ payload: { requestBody: { url: 'https://a.example/x' } } }, makeFakeStep())).rejects.toThrow(/status 502/);
	});

	it('returns 4xx without throwing (retry would be pointless)', async () => {
		registerClipHandler(async () => Response.json({ error: 'bad request' }, { status: 400 }));
		const wf = new ClipWorkflow({}, mockEnv);
		const result = await wf.run({ payload: { requestBody: {} } }, makeFakeStep());
		expect(result.status).toBe(400);
		expect(result.body.error).toBe('bad request');
	});

	it('falls back to event.params[0] when event.payload is absent', async () => {
		registerClipHandler(async (requestBody) => Response.json({ got: requestBody.url }));
		const wf = new ClipWorkflow({}, mockEnv);
		const result = await wf.run({ params: [{ requestBody: { url: 'https://b.example/y' } }] }, makeFakeStep());
		expect(result.body.got).toBe('https://b.example/y');
	});

	it('fails clearly when no handler was registered', async () => {
		const wf = new ClipWorkflow({}, mockEnv);
		await expect(wf.run({ payload: {} }, makeFakeStep())).rejects.toThrow(/not registered/);
	});
});

describe('async clip endpoints (worker integration)', () => {
	it('POST /json-async accepts the job with 202 and exposes a status url', async () => {
		const binding = makeWorkflowBinding();
		const response = await worker.fetch(createRequest({ url: 'https://example.com/a', title: 'T' }), { ...mockEnv, CLIP_WORKFLOW: binding }, createExecutionContext());
		expect(response.status).toBe(202);
		const body = await response.json();
		expect(body.ok).toBe(true);
		expect(body.workflowId).toBe('wf-1');
		expect(body.statusUrl).toBe('/clip-status?id=wf-1');
		// 投递内容：请求体整体 + 原始 requestUrl + X-Clip-Method 等价物。
		expect(binding.instances.get('wf-1').params).toEqual({
			requestBody: { url: 'https://example.com/a', title: 'T' },
			requestUrl: 'http://example.com/json-async',
			clipMethodHeader: '',
		});
	});

	it('POST /json-async forwards clipMethod from the body', async () => {
		const binding = makeWorkflowBinding();
		await worker.fetch(createRequest({ url: 'https://example.com/a', clipMethod: 'markdown' }), { ...mockEnv, CLIP_WORKFLOW: binding }, createExecutionContext());
		expect(binding.instances.get('wf-1').params.clipMethodHeader).toBe('markdown');
	});

	it('POST /json-async rejects obviously bad payloads before enqueueing', async () => {
		const binding = makeWorkflowBinding();
		const response = await worker.fetch(createRequest({}), { ...mockEnv, CLIP_WORKFLOW: binding }, createExecutionContext());
		expect(response.status).toBe(400);
		expect(binding.instances.size).toBe(0);
	});

	it('POST /json-async answers 501 when the CLIP_WORKFLOW binding is missing', async () => {
		const response = await worker.fetch(createRequest({ url: 'https://example.com/a' }), { ...mockEnv }, createExecutionContext());
		expect(response.status).toBe(501);
	});

	it('GET /clip-status reports the engine status for a known id', async () => {
		const binding = makeWorkflowBinding();
		await worker.fetch(createRequest({ url: 'https://example.com/a' }), { ...mockEnv, CLIP_WORKFLOW: binding }, createExecutionContext());
		const response = await worker.fetch(createStatusRequest('?id=wf-1'), { ...mockEnv, CLIP_WORKFLOW: binding }, createExecutionContext());
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).toEqual({ workflowId: 'wf-1', status: 'queued' });
	});

	it('GET /clip-status requires auth', async () => {
		const response = await worker.fetch(createStatusRequest('?id=wf-1', 'Bearer wrong'), { ...mockEnv, CLIP_WORKFLOW: makeWorkflowBinding() }, createExecutionContext());
		expect(response.status).toBe(401);
	});

	it('GET /clip-status fails closed when API_KEY is unset', async () => {
		const response = await worker.fetch(createStatusRequest('?id=wf-1'), { ...mockEnv, API_KEY: undefined, CLIP_WORKFLOW: makeWorkflowBinding() }, createExecutionContext());
		expect(response.status).toBe(500);
	});

	it('GET /clip-status answers 400 without an id', async () => {
		const response = await worker.fetch(createStatusRequest(''), { ...mockEnv, CLIP_WORKFLOW: makeWorkflowBinding() }, createExecutionContext());
		expect(response.status).toBe(400);
	});

	it('GET /clip-status answers 404 for an unknown id', async () => {
		const response = await worker.fetch(createStatusRequest('?id=nope'), { ...mockEnv, CLIP_WORKFLOW: makeWorkflowBinding() }, createExecutionContext());
		expect(response.status).toBe(404);
	});
});
