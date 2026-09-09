// 阶段四B：ClipLock DO 契约测试。
// vitest 里没有真实 DO runtime（单实例串行 + storage 持久化语义无法复现），
// 这里用 Map 版 fake storage 驱动真实 ClipLock 类测 HTTP 契约，
// 再用包了一层真实实例的 stub env 测三个 helper 的降级/等待/释放行为。

import { describe, it, expect, beforeEach } from 'vitest';
import { ClipLock, acquireClipLock, waitForConcurrentClip, releaseClipLock } from '../src/clip-lock.js';

function createFakeStorage() {
	const map = new Map();
	return {
		get: async (k) => map.get(k),
		put: async (k, v) => map.set(k, v),
		delete: async (k) => map.delete(k),
		_map: map,
	};
}

function createLockEnv() {
	const lock = new ClipLock({ storage: createFakeStorage() }, {});
	const requests = [];
	return {
		lock,
		requests,
		CLIP_LOCK: {
			fetch: async (url, init) => {
				requests.push({ url, init });
				return lock.fetch(new Request(url, init));
			},
		},
	};
}

function makeKv(initial = new Map()) {
	return { get: async (k) => initial.get(k) ?? null };
}

describe('ClipLock DO contract', () => {
	let env;
	beforeEach(() => {
		env = createLockEnv();
	});

	const acquire = (body) =>
		env.CLIP_LOCK.fetch('https://clip-lock.internal/acquire', {
			method: 'POST',
			body: JSON.stringify(body),
		});

	it('grants lock when free, echoes owner and expiresAt', async () => {
		const res = await acquire({ key: 'clip:abc', owner: 'o1' });
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.granted).toBe(true);
		expect(data.owner).toBe('o1');
		expect(data.expiresAt).toBeGreaterThan(Date.now());
	});

	it('rejects second acquire of the same key with 409 and expiresAt', async () => {
		await acquire({ key: 'clip:abc', owner: 'o1' });
		const res = await acquire({ key: 'clip:abc', owner: 'o2' });
		expect(res.status).toBe(409);
		const data = await res.json();
		expect(data.granted).toBe(false);
		expect(data.expiresAt).toBeGreaterThan(Date.now());
	});

	it('takes over an expired lock (lazy expiry, no tombstones)', async () => {
		await acquire({ key: 'clip:abc', owner: 'o1', ttlMs: 1 });
		await new Promise((r) => setTimeout(r, 15));
		const res = await acquire({ key: 'clip:abc', owner: 'o2' });
		expect(res.status).toBe(200);
		expect((await res.json()).granted).toBe(true);
	});

	it('release with matching owner frees the key', async () => {
		await acquire({ key: 'clip:abc', owner: 'o1' });
		const rel = await env.CLIP_LOCK.fetch('https://clip-lock.internal/release', {
			method: 'POST',
			body: JSON.stringify({ key: 'clip:abc', owner: 'o1' }),
		});
		expect((await rel.json()).released).toBe(true);
		const again = await acquire({ key: 'clip:abc', owner: 'o2' });
		expect((await again.json()).granted).toBe(true);
	});

	it('release with wrong owner does NOT free the lock', async () => {
		await acquire({ key: 'clip:abc', owner: 'o1' });
		const rel = await env.CLIP_LOCK.fetch('https://clip-lock.internal/release', {
			method: 'POST',
			body: JSON.stringify({ key: 'clip:abc', owner: 'intruder' }),
		});
		expect(await rel.json()).toEqual({ released: false, reason: 'owner-mismatch' });
		const res = await acquire({ key: 'clip:abc', owner: 'o2' });
		expect(res.status).toBe(409);
	});

	it('release of a never-held key reports not-held', async () => {
		const rel = await env.CLIP_LOCK.fetch('https://clip-lock.internal/release', {
			method: 'POST',
			body: JSON.stringify({ key: 'clip:none', owner: 'o1' }),
		});
		expect(await rel.json()).toEqual({ released: false, reason: 'not-held' });
	});

	it('acquire/release without key → 400; unknown route → 404', async () => {
		expect((await acquire({})).status).toBe(400);
		const nf = await env.CLIP_LOCK.fetch('https://clip-lock.internal/other', { method: 'POST', body: '{}' });
		expect(nf.status).toBe(404);
	});

	it('peek returns live entry or null', async () => {
		await acquire({ key: 'clip:abc', owner: 'o1' });
		const peek = await env.CLIP_LOCK.fetch('https://clip-lock.internal/peek?key=clip:abc');
		const data = await peek.json();
		expect(data.owner).toBe('o1');
		const peekEmpty = await env.CLIP_LOCK.fetch('https://clip-lock.internal/peek?key=clip:gone');
		expect(await peekEmpty.json()).toBeNull();
	});

	it('ttlMs is capped at 10x default (client cannot lock forever)', async () => {
		const res = await acquire({ key: 'clip:abc', owner: 'o1', ttlMs: 999_999_999 });
		const { expiresAt } = await res.json();
		expect(expiresAt).toBeLessThanOrEqual(Date.now() + 10 * 90_000 + 100);
	});
});

describe('acquireClipLock / waitForConcurrentClip / releaseClipLock helpers', () => {
	it('returns null when CLIP_LOCK binding is absent (silent degrade)', async () => {
		expect(await acquireClipLock('https://example.com/a', {})).toBeNull();
		expect(await acquireClipLock('https://example.com/a', { CLIP_LOCK: {} })).toBeNull();
	});

	it('happy path: granted lock with key = clip:<sha256(url)>', async () => {
		const env = createLockEnv();
		const lock = await acquireClipLock('https://example.com/a', env);
		expect(lock.granted).toBe(true);
		expect(lock.key).toMatch(/^clip:[0-9a-f]{64}$/);
		expect(typeof lock.owner).toBe('string');
		// helper 发出的 acquire 请求体里带了自己的 owner
		expect(JSON.parse(env.requests[0].init.body).owner).toBe(lock.owner);
	});

	it('busy path: granted=false when someone else holds the lock', async () => {
		const env = createLockEnv();
		await env.CLIP_LOCK.fetch('https://clip-lock.internal/acquire', {
			method: 'POST',
			body: JSON.stringify({ key: await (await import('../src/idempotency.js')).getClipKey('https://example.com/b'), owner: 'someone-else' }),
		});
		const lock = await acquireClipLock('https://example.com/b', env);
		expect(lock.granted).toBe(false);
	});

	it('DO throwing → null, never blocks the clip path', async () => {
		const env = {
			CLIP_LOCK: {
				fetch: async () => {
					throw new Error('DO unreachable');
				},
			},
		};
		expect(await acquireClipLock('https://example.com/c', env)).toBeNull();
	});

	it('waitForConcurrentClip returns the record once KV has it', async () => {
		const record = { url: 'https://example.com/d', telegraphPath: '/p/exists' };
		let polls = 0;
		const env = {
			CLIP_KV: {
				get: async (k) => {
					polls += 1;
					return polls >= 2 ? JSON.stringify(record) : null;
				},
			},
		};
		const got = await waitForConcurrentClip('https://example.com/d', env, { intervalMs: 5, timeoutMs: 1000 });
		expect(got).toEqual(record);
		expect(polls).toBeGreaterThanOrEqual(2);
	});

	it('waitForConcurrentClip returns null on timeout (caller degrades to clip anyway)', async () => {
		const env = { CLIP_KV: { get: async () => null } };
		const got = await waitForConcurrentClip('https://example.com/e', env, { intervalMs: 5, timeoutMs: 30 });
		expect(got).toBeNull();
	});

	it('waitForConcurrentClip degrades to null when KV is unbound', async () => {
		expect(await waitForConcurrentClip('https://example.com/f', {}, { intervalMs: 5, timeoutMs: 30 })).toBeNull();
	});

	it('releaseClipLock: releases when granted, no-ops when lock is null or not granted', async () => {
		const env = createLockEnv();
		const lock = await acquireClipLock('https://example.com/g', env);
		await releaseClipLock(lock, env);
		const peek = await env.lock.fetch(new Request('https://clip-lock.internal/peek?key=' + lock.key));
		expect(await peek.json()).toBeNull();
		// 未获锁/无锁都是安全 no-op
		await releaseClipLock(null, env);
		await releaseClipLock({ granted: false, key: 'clip:x', owner: 'o' }, env);
	});
});
