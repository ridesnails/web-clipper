// 阶段四B：并发剪藏互斥锁（Durable Object）。
// KV 是最终一致的，"二次剪藏走 editPage"的幂等在并发场景有竞态窗口：
// 两个同 URL 请求都会读到"无记录"然后各自 createPage，产生重复 Telegraph 页。
// DO 是单实例强一致的，用它做互斥：先到者获锁剪藏，后到者等 KV 记录出现（=持锁者已完成），
// 然后按"已有记录"路径走 editPage。锁 90s TTL 自动过期，防持锁方崩溃导致死锁。
// CLIP_LOCK 未绑定（本地 vitest）或 DO 异常时全部静默降级，行为与无锁版完全一致——锁永不应阻塞剪藏。

import { getClipKey, getClipRecord } from './idempotency.js';

const LOCK_TTL_MS = 90_000; // 持锁上限：剪藏链路偶发 60s+（browser 渲染），90s 足够且兜底防死锁
const LOCK_WAIT_TIMEOUT_MS = 40_000; // 等待侧上限：等不到就降级直接剪（宁重复勿阻塞）
const LOCK_WAIT_INTERVAL_MS = 2_000;

/**
 * Durable Object：单 key 互斥锁。
 * - POST /acquire {key, ttlMs?, owner?} → 200 {granted:true, owner} 或 409 {granted:false, expiresAt}
 * - POST /release {key, owner}         → 200 {released:true|false, reason?}（owner 不匹配不释放）
 * - GET  /peek?key=...                 → 200 锁条目或 null（诊断/测试用）
 * 过期锁条目不会被主动清理，acquire 时惰性覆盖（expiresAt 已过的 key 视为空闲）。
 */
export class ClipLock {
	constructor(state, env) {
		this.state = state;
		this.env = env;
	}

	async fetch(request) {
		const url = new URL(request.url);
		if (request.method === 'POST' && url.pathname === '/acquire') {
			const body = await request.json().catch(() => ({}));
			if (typeof body.key !== 'string' || !body.key) {
				return Response.json({ error: 'missing key' }, { status: 400 });
			}
			const now = Date.now();
			const ttlMs = Number(body.ttlMs) > 0 ? Math.min(Number(body.ttlMs), 10 * LOCK_TTL_MS) : LOCK_TTL_MS;
			const owner = body.owner || crypto.randomUUID();
			const current = await this.state.storage.get(body.key);
			if (current && current.expiresAt > now) {
				return Response.json({ granted: false, expiresAt: current.expiresAt }, { status: 409 });
			}
			await this.state.storage.put(body.key, { owner, expiresAt: now + ttlMs });
			return Response.json({ granted: true, owner, expiresAt: now + ttlMs });
		}
		if (request.method === 'POST' && url.pathname === '/release') {
			const body = await request.json().catch(() => ({}));
			if (typeof body.key !== 'string' || !body.key) {
				return Response.json({ error: 'missing key' }, { status: 400 });
			}
			const current = await this.state.storage.get(body.key);
			if (current && current.owner && current.owner === body.owner) {
				await this.state.storage.delete(body.key);
				return Response.json({ released: true });
			}
			return Response.json({ released: false, reason: current ? 'owner-mismatch' : 'not-held' });
		}
		if (request.method === 'GET' && url.pathname === '/peek') {
			const key = url.searchParams.get('key');
			if (!key) return Response.json({ error: 'missing key' }, { status: 400 });
			const current = await this.state.storage.get(key);
			return Response.json(current ?? null);
		}
		return Response.json({ error: 'not found' }, { status: 404 });
	}
}

/**
 * 尝试获取该 URL 的剪藏锁。
 * @returns {Promise<{key, owner, granted}|null>} null = 无锁设施/DO 异常（调用方按无锁路径继续）
 */
export async function acquireClipLock(url, env) {
	try {
		const stub = env?.CLIP_LOCK;
		if (!stub || typeof stub.fetch !== 'function') return null;
		const key = await getClipKey(url);
		const owner = crypto.randomUUID();
		const res = await stub.fetch('https://clip-lock.internal/acquire', {
			method: 'POST',
			body: JSON.stringify({ key, owner }),
		});
		const data = await res.json().catch(() => null);
		if (!data || typeof data.granted !== 'boolean') return null;
		if (!data.granted) {
			console.log('Clip lock busy, waiting for concurrent clip:', url);
		}
		return { key, owner, granted: data.granted };
	} catch (e) {
		console.warn('Clip lock acquire failed (ignored, clipping without lock):', e.message);
		return null;
	}
}

/**
 * 等待侧：另一个请求持锁剪藏同 URL。轮询 KV 直到剪藏记录出现（=对方完成）或超时。
 * 超时返回 null，调用方降级为直接剪藏（最坏退化为旧行为：可能的重复页）。
 */
export async function waitForConcurrentClip(url, env, opts = {}) {
	const timeoutMs = opts.timeoutMs ?? LOCK_WAIT_TIMEOUT_MS;
	const intervalMs = opts.intervalMs ?? LOCK_WAIT_INTERVAL_MS;
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const record = await getClipRecord(url, env);
		if (record) return record;
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
	console.warn('Clip lock wait timed out, clipping anyway (concurrent duplicate possible):', url);
	return null;
}

/** 释放锁。仅持锁者有效；失败静默（TTL 兜底）。 */
export async function releaseClipLock(lock, env) {
	if (!lock?.granted) return;
	try {
		await env?.CLIP_LOCK?.fetch('https://clip-lock.internal/release', {
			method: 'POST',
			body: JSON.stringify({ key: lock.key, owner: lock.owner }),
		});
	} catch (e) {
		console.warn('Clip lock release failed (TTL will expire it):', e.message);
	}
}
