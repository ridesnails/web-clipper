/**
 * Shared HTTP helpers for external calls (Jina / FNS / AI / Telegraph / Telegram).
 * Prefer these over ad-hoc AbortSignal.timeout loops so timeouts/retries stay consistent.
 */

/**
 * @param {number} ms
 * @returns {AbortSignal}
 */
export function withTimeout(ms) {
	return AbortSignal.timeout(ms);
}

/**
 * @template T
 * @param {() => Promise<T>} fn
 * @param {{
 *   retries?: number,
 *   delaysMs?: number[],
 *   shouldRetry?: (error: unknown, attempt: number) => boolean,
 * }} [options]
 * @returns {Promise<T>}
 */
export async function withRetry(fn, options = {}) {
	const retries = options.retries ?? 2;
	const delaysMs = options.delaysMs ?? [1000, 2000];
	const shouldRetry =
		options.shouldRetry ??
		((error) => {
			const msg = String(error?.message || error || '');
			return /timeout|network|fetch failed|429|5\d\d/i.test(msg);
		});

	let lastError;
	for (let attempt = 0; attempt <= retries; attempt++) {
		try {
			return await fn(attempt);
		} catch (error) {
			lastError = error;
			if (attempt === retries || !shouldRetry(error, attempt)) {
				throw error;
			}
			const delay = delaysMs[Math.min(attempt, delaysMs.length - 1)] ?? 1000;
			await new Promise((resolve) => setTimeout(resolve, delay));
		}
	}
	throw lastError;
}

/**
 * Fetch with timeout + optional retry on 429/5xx or network errors.
 * @param {string} url
 * @param {RequestInit} [init]
 * @param {{
 *   timeoutMs?: number,
 *   retries?: number,
 *   delaysMs?: number[],
 *   retryOnStatuses?: number[],
 * }} [options]
 * @returns {Promise<Response>}
 */
export async function fetchWithTimeout(url, init = {}, options = {}) {
	const timeoutMs = options.timeoutMs ?? 15000;
	const retries = options.retries ?? 0;
	const delaysMs = options.delaysMs ?? [1000, 2000];
	const retryOnStatuses = options.retryOnStatuses ?? [429, 500, 502, 503, 504];

	return withRetry(
		async () => {
			const signal = init.signal || withTimeout(timeoutMs);
			const res = await fetch(url, { ...init, signal });
			if (!res || typeof res.status !== 'number') {
				throw new Error('fetch failed: empty response');
			}
			if (retries > 0 && retryOnStatuses.includes(res.status)) {
				const errText = await res.text().catch(() => '');
				const error = new Error(`HTTP ${res.status} ${errText}`);
				error.status = res.status;
				error.responseText = errText;
				throw error;
			}
			return res;
		},
		{
			retries,
			delaysMs,
			shouldRetry: (error) => {
				if (error && typeof error.status === 'number') {
					return retryOnStatuses.includes(error.status);
				}
				const msg = String((error && error.message) || error || '');
				return /timeout|network|fetch failed|AbortError/i.test(msg);
			},
		},
	);
}
