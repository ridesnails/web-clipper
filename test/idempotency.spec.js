// 阶段三：URL → KV 剪藏记录（双写幂等第二支柱）
import { describe, it, expect, vi } from 'vitest';
import { sha256Hex, getClipKey, getClipRecord, putClipRecord } from '../src/idempotency.js';

function makeKvEnv(initial = {}) {
	const store = new Map(Object.entries(initial));
	return {
		env: {
			CLIP_KV: {
				async get(key) {
					return store.has(key) ? store.get(key) : null;
				},
				async put(key, value) {
					store.set(key, value);
				},
			},
		},
		store,
	};
}

describe('sha256Hex / getClipKey', () => {
	it('已知向量：sha256("")', async () => {
		expect(await sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
	});

	it('同一 URL key 稳定，不同 URL key 不同，且带 clip: 前缀', async () => {
		const a = await getClipKey('https://example.com/a');
		const b = await getClipKey('https://example.com/a');
		const c = await getClipKey('https://example.com/b');
		expect(a).toBe(b);
		expect(a).not.toBe(c);
		expect(a.startsWith('clip:')).toBe(true);
	});
});

describe('getClipRecord', () => {
	it('CLIP_KV 未绑定 → null（静默降级）', async () => {
		expect(await getClipRecord('https://example.com/a', {})).toBeNull();
		expect(await getClipRecord('https://example.com/a', { CLIP_KV: undefined })).toBeNull();
	});

	it('命中记录 → 返回解析后的对象', async () => {
		const { env, store } = makeKvEnv();
		const key = await getClipKey('https://example.com/a');
		store.set(key, JSON.stringify({ url: 'https://example.com/a', fnsPath: 'Cloud/Notes/x.md', telegraphPath: 'T-05-21' }));
		const rec = await getClipRecord('https://example.com/a', env);
		expect(rec).toEqual({ url: 'https://example.com/a', fnsPath: 'Cloud/Notes/x.md', telegraphPath: 'T-05-21' });
	});

	it('KV 返回损坏 JSON → null 不抛出', async () => {
		const { env, store } = makeKvEnv();
		store.set(await getClipKey('https://example.com/a'), '{"bad json');
		expect(await getClipRecord('https://example.com/a', env)).toBeNull();
	});

	it('KV 返回非对象（如字符串/数字）→ null', async () => {
		const { env, store } = makeKvEnv();
		store.set(await getClipKey('https://example.com/a'), '"just a string"');
		expect(await getClipRecord('https://example.com/a', env)).toBeNull();
	});
});

describe('putClipRecord', () => {
	it('CLIP_KV 未绑定 → false', async () => {
		expect(await putClipRecord('https://example.com/a', { url: 'x' }, {})).toBe(false);
	});

	it('写入成功 → true，KV 存 JSON 且 key=clip:<sha256(url)>', async () => {
		const { env, store } = makeKvEnv();
		const ok = await putClipRecord('https://example.com/a', { url: 'https://example.com/a', telegraphPath: 'T-05-21' }, env);
		expect(ok).toBe(true);
		const key = await getClipKey('https://example.com/a');
		expect(store.has(key)).toBe(true);
		expect(JSON.parse(store.get(key)).telegraphPath).toBe('T-05-21');
	});

	it('KV.put 抛异常 → false 不抛出', async () => {
		const env = {
			CLIP_KV: {
				async get() {
					return null;
				},
				async put() {
					throw new Error('kv down');
				},
			},
		};
		expect(await putClipRecord('https://example.com/a', { url: 'x' }, env)).toBe(false);
	});
});
