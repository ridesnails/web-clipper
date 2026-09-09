import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/jina.js', () => ({
	fetchArticleFromUrl: vi.fn(),
}));
// passthrough：defuddle leg 的 content HTML 直接当 markdownBody 用，方便断言
vi.mock('../src/singlefile.js', () => ({
	htmlFragmentToMarkdown: vi.fn((html) => html),
}));

import { extractArticleViaChain } from '../src/extractor-chain.js';
import { fetchArticleFromUrl } from '../src/jina.js';
import { htmlFragmentToMarkdown } from '../src/singlefile.js';

const URL = 'https://example.com/article';

const goodArticle = (overrides = {}) => ({
	title: 'Real Title',
	url: URL,
	markdownBody: 'one two three four five six seven eight nine ten '.repeat(9), // 90 words
	sourceHtml: '',
	...overrides,
});

const weakArticle = () => goodArticle({ markdownBody: '# Real Title\n\nshort body text' });

const envBase = () => ({ DEFUDDLE_FALLBACK: 'true' });

beforeEach(() => {
	fetchArticleFromUrl.mockReset();
	htmlFragmentToMarkdown.mockClear();
});

describe('extractArticleViaChain', () => {
	it('returns L1 untouched when quality gate passes', async () => {
		fetchArticleFromUrl.mockResolvedValue(goodArticle());
		const env = envBase();
		const article = await extractArticleViaChain(URL, env);
		expect(article.markdownBody).toContain('one two three');
		expect(article.extractorDebug.selected).toBe('jina');
		expect(article.extractorDebug.attempts).toEqual([]);
		expect(fetchArticleFromUrl).toHaveBeenCalledTimes(1);
	});

	it('rethrows L1 error even when fallback is enabled (502 contract)', async () => {
		fetchArticleFromUrl.mockRejectedValue(new Error('Jina error'));
		await expect(extractArticleViaChain(URL, envBase())).rejects.toThrow('Jina error');
	});

	it('degrades to L1 when DEFUDDLE_FALLBACK is not enabled', async () => {
		fetchArticleFromUrl.mockResolvedValue(weakArticle());
		const article = await extractArticleViaChain(URL, {});
		expect(article.extractorDebug.selected).toBe('jina-degraded');
		expect(article.extractorDebug.attempts).toEqual([
			{ leg: 'l2', skipped: true, reason: 'DEFUDDLE_FALLBACK not enabled' },
		]);
	});

	it('falls back to defuddle leg when L1 is thin and flag is on', async () => {
		fetchArticleFromUrl.mockResolvedValue(weakArticle());
		global.fetch = vi.fn().mockResolvedValue(new Response(
			'<html><body><article><h1>Defuddle Title</h1><p>' + 'word '.repeat(90) + '</p></article></body></html>',
			{ status: 200 },
		));
		const article = await extractArticleViaChain(URL, envBase());
		expect(article.extractorDebug.selected).toBe('defuddle');
		expect(article.markdownBody).toContain('<p>');
		expect(article.sourceHtml).toContain('<article>');
	});

	it('degrades to L1 when every L2 leg fails', async () => {
		fetchArticleFromUrl.mockResolvedValue(weakArticle());
		global.fetch = vi.fn().mockRejectedValue(new Error('source down'));
		const article = await extractArticleViaChain(URL, envBase());
		expect(article.extractorDebug.selected).toBe('jina-degraded');
		expect(article.extractorDebug.attempts.map((a) => a.leg)).toEqual(['defuddle', 'ai', 'browser']);
		expect(article.extractorDebug.attempts[0].ok).toBe(false);
		expect(article.extractorDebug.attempts[1].reason).toBe('binding unavailable');
	});

	it('uses AI leg when defuddle fails and AI binding is present', async () => {
		fetchArticleFromUrl.mockResolvedValue(weakArticle());
		global.fetch = vi.fn()
			.mockRejectedValueOnce(new Error('source down')) // defuddle leg
			.mockResolvedValueOnce(new Response('<html><body><p>x</p></body></html>', { status: 200 })); // ai leg
		const env = { ...envBase(), AI: { toMarkdown: vi.fn(async () => 'ai prose '.repeat(90)) } };
		const article = await extractArticleViaChain(URL, env);
		expect(article.extractorDebug.selected).toBe('ai');
		expect(article.markdownBody).toContain('ai prose');
		expect(article.title).toBe('Real Title'); // AI leg 无标题 → 回填 L1 标题
	});

	it('uses browser leg via BROWSER.quickAction(markdown)', async () => {
		fetchArticleFromUrl.mockResolvedValue(weakArticle());
		global.fetch = vi.fn().mockRejectedValue(new Error('source down'));
		const env = {
			...envBase(),
			BROWSER: { quickAction: vi.fn(async () => new Response('# Captured\n\n' + 'bword '.repeat(90))) },
		};
		const article = await extractArticleViaChain(URL, env);
		expect(article.extractorDebug.selected).toBe('browser');
		expect(env.BROWSER.quickAction).toHaveBeenCalledWith('markdown', { url: URL });
		expect(article.markdownBody).toContain('bword');
	});

	it('forwards jinaOptions to L1', async () => {
		fetchArticleFromUrl.mockResolvedValue(goodArticle());
		const env = envBase();
		await extractArticleViaChain(URL, env, { targetSelector: 'main' });
		expect(fetchArticleFromUrl).toHaveBeenCalledWith(URL, env, { targetSelector: 'main' });
	});
});
