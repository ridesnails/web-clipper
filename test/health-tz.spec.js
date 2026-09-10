import { describe, it, expect } from 'vitest';
import worker from '../src';
import { chinaYearMonth, formatChinaDateTime } from '../src/utils.js';
import { truncateBodyForPrompt } from '../src/ai.js';

// ---- TZ：北京 = UTC+8，统一落盘路径与剪藏日志口径 ----
describe('china tz helpers', () => {
	it('chinaYearMonth flips month across UTC month boundary', () => {
		// UTC 01-31 17:30 → 北京 02-01 01:30：旧实现按 UTC 算落上月，新统一到北京月
		expect(chinaYearMonth(new Date('2026-01-31T17:30:00Z'))).toBe('2026-02');
	});

	it('chinaYearMonth stays stable mid-month', () => {
		expect(chinaYearMonth(new Date('2026-03-15T00:00:00Z'))).toBe('2026-03');
	});

	it('formatChinaDateTime renders Beijing wall clock', () => {
		expect(formatChinaDateTime(new Date('2026-01-31T17:30:00Z'))).toBe('2026-02-01 01:30:00');
	});
});

describe('truncateBodyForPrompt keeps head+tail', () => {
	it('returns short bodies untouched', () => {
		expect(truncateBodyForPrompt('short body')).toBe('short body');
	});

	it('keeps head and tail of long bodies with omission marker', () => {
		const body = 'A'.repeat(9000) + 'MIDDLE'.repeat(2000) + 'Z'.repeat(3000);
		const out = truncateBodyForPrompt(body);
		expect(out.startsWith('A'.repeat(9000))).toBe(true);
		expect(out.endsWith('Z'.repeat(3000))).toBe(true);
		expect(out).toContain('……（中间内容省略）……');
		expect(out.includes('MIDDLE')).toBe(false);
	});
});

describe('GET /health', () => {
	it('without auth returns bare ok', async () => {
		const res = await worker.fetch(new Request('http://example.com/health'), {});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
	});

	it('with bearer token lists capability booleans', async () => {
		const env = {
			API_KEY: 'test-api-key',
			FNS_API_KEY: 'x',
			TELEGRAPH_ACCESS_TOKEN: 't',
			IMG_BOT: 'i',
			CLIP_BOT: 'c',
			AI_API_KEY: 'a',
			CLIP_KV: {},
			BROWSER: {},
			DEFUDDLE_FALLBACK: 'true',
		};
		const res = await worker.fetch(
			new Request('http://example.com/health', { headers: { Authorization: `Bearer ${env.API_KEY}` } }),
			env
		);
		expect(await res.json()).toEqual({
			ok: true,
			capabilities: {
				fns: true,
				telegraph: true,
				telegramImg: true,
				telegramClip: true,
				ai: true,
				kv: true,
				browser: true,
				defuddleFallback: true,
			},
		});
	});
});
