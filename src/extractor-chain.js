/**
 * ExtractorChain —— L1 (Jina Reader) 质量失守时的多路降级提取。
 *
 * 链路：
 *   L1  fetchArticleFromUrl (Jina Reader, 现有主链路)
 *   L2  defuddle  : 原站拉HTML → linkedom+Defuddle 本地正文提取 → 双份(HTML+MD)
 *       ai        : 原站拉HTML → env.AI.toMarkdown (Workers AI 文档转换)
 *       browser   : env.BROWSER.quickAction('markdown', {url}) (Browser Rendering)
 *
 * 策略：
 *   - L1 拿到且过质量门 → 直接返回，零额外成本（绝大多数请求到此为止）；
 *   - L1 拿到但质量门不过 → 依次试 L2，score 严格大于 L1 才替换；
 *   - 全部 L2 不可用/失败 → 降级返回 L1（宁可有薄内容也不报错）；
 *   - L1 本身抛错 → 原样重抛，维持上层 502 'Jina error' 契约。
 *
 * 开关：env.DEFUDDLE_FALLBACK === 'true' 才启用 L2（无该变量时行为与旧版完全一致，
 * 既有测试的 fetch 次数断言因此全部不受影响）。
 */

import { fetchArticleFromUrl } from './jina.js';
import { evaluateArticleQuality, isWeakHtmlFragment } from './quality-gate.js';
import { htmlFragmentToMarkdown } from './singlefile.js';
import Defuddle from 'defuddle';
import { parseHTML } from 'linkedom';

const FALLBACK_FLAG = 'DEFUDDLE_FALLBACK';
const RAW_FETCH_TIMEOUT_MS = 20000; // 原站拉 HTML 的超时（走 AbortSignal）
const LEG_TIMEOUT_MS = 45000;       // 单条 L2 leg 的总超时（binding 调用无法用 signal，用 race）
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function isFallbackEnabled(env) {
	return String(env?.[FALLBACK_FLAG] || '').trim().toLowerCase() === 'true';
}

/** binding 调用（quickAction/toMarkdown）不吃 AbortSignal，用 Promise.race 兜底超时。 */
async function raceWithTimeout(promise, label, ms = LEG_TIMEOUT_MS) {
	let timer;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

async function fetchRawHtml(url) {
	const res = await fetch(url, {
		headers: {
			'User-Agent': BROWSER_UA,
			Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
			'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
		},
		redirect: 'follow',
		signal: AbortSignal.timeout(RAW_FETCH_TIMEOUT_MS),
	});
	if (!res.ok) {
		throw new Error(`source fetch failed: ${res.status}`);
	}
	return res.text();
}

/** L2-defuddle：本地 Readability 系提取，产出 markdownBody + sourceHtml 双份和元数据。 */
async function defuddleLeg(url) {
	const html = await fetchRawHtml(url);
	const { document } = parseHTML(html);
	const result = new Defuddle(document, { url, useAsync: false }).parse();
	const contentHtml = String(result?.content || '');
	if (!contentHtml.trim() || isWeakHtmlFragment(contentHtml)) {
		throw new Error('defuddle produced empty/weak content');
	}
	const markdownBody = htmlFragmentToMarkdown(contentHtml);
	if (!markdownBody.trim()) {
		throw new Error('defuddle produced empty markdown');
	}
	return {
		title: String(result?.title || '').trim(),
		url,
		markdownBody,
		sourceHtml: html,
		author: String(result?.author || '').trim(),
		published: String(result?.published || result?.publishedTime || '').trim(),
		description: String(result?.description || '').trim(),
		image: String(result?.image || '').trim(),
		siteName: String(result?.site || result?.siteName || '').trim(),
		language: String(result?.language || '').trim(),
	};
}

/** L2-ai：把原站 HTML 喂给 Workers AI toMarkdown。 */
async function aiLeg(url, env) {
	const html = await fetchRawHtml(url);
	const blob = new Blob([html], { type: 'text/html' });
	const out = await env.AI.toMarkdown({ files: [{ name: 'page.html', blob }] });
	let markdown = '';
	if (typeof out === 'string') {
		markdown = out;
	} else if (Array.isArray(out)) {
		markdown = out.map((x) => x?.data ?? x?.markdown ?? '').join('\n\n');
	} else {
		markdown = out?.data ?? out?.markdown ?? '';
	}
	if (!String(markdown).trim()) {
		throw new Error('AI toMarkdown produced empty markdown');
	}
	return { title: '', url, markdownBody: String(markdown), sourceHtml: html };
}

/** L2-browser：Browser Rendering Quick Actions，官方签名 quickAction('markdown', {url})，返回 Response。 */
async function browserLeg(url, env) {
	const res = await env.BROWSER.quickAction('markdown', { url });
	let markdown = '';
	if (res && typeof res.text === 'function') {
		markdown = await res.text();
	} else if (typeof res === 'string') {
		markdown = res;
	} else {
		markdown = res?.result ?? res?.data ?? res?.markdown ?? '';
	}
	if (!String(markdown).trim()) {
		throw new Error('BROWSER quickAction produced empty markdown');
	}
	return { title: '', url, markdownBody: String(markdown), sourceHtml: '' };
}

function scoreArticle(article) {
	return evaluateArticleQuality({ title: article?.title, markdownBody: article?.markdownBody }).score;
}

/**
 * 主入口：替代 handleJsonClipRequest 里裸调 fetchArticleFromUrl 的那一步。
 * 返回 article（含 extractorDebug: { selected, attempts }），L1 彻底失败时重抛。
 */
export async function extractArticleViaChain(url, env, jinaOptions = {}) {
	const attempts = [];
	const enabled = isFallbackEnabled(env);

	let l1Article = null;
	let l1Error = null;
	try {
		l1Article = await fetchArticleFromUrl(url, env, jinaOptions);
	} catch (error) {
		l1Error = error;
	}

	// L1 拿到且过质量门 → 直接用
	if (l1Article && evaluateArticleQuality({ title: l1Article.title, markdownBody: l1Article.markdownBody }).passed) {
		return { ...l1Article, extractorDebug: { selected: 'jina', attempts } };
	}

	// L1 连结果都没有 → 维持既有 502 'Jina error' 契约，原样重抛
	if (l1Error) {
		throw l1Error;
	}

	if (enabled) {
		const legs = [
			['defuddle', () => defuddleLeg(url)],
			['ai', env?.AI && typeof env.AI.toMarkdown === 'function' ? () => aiLeg(url, env) : null],
			['browser', env?.BROWSER && typeof env.BROWSER.quickAction === 'function' ? () => browserLeg(url, env) : null],
		];
		const candidates = [];
		for (const [name, run] of legs) {
			if (!run) {
				attempts.push({ leg: name, skipped: true, reason: 'binding unavailable' });
				continue;
			}
			try {
				const article = await raceWithTimeout(run(), `${name} leg`);
				const q = evaluateArticleQuality({
					title: article.title || l1Article.title,
					markdownBody: article.markdownBody,
				});
				attempts.push({ leg: name, ok: true, passed: q.passed, score: q.score, words: q.words });
				if (q.passed) candidates.push({ leg: name, article });
			} catch (error) {
				attempts.push({ leg: name, ok: false, error: String(error?.message || error).slice(0, 200) });
			}
		}

		// 择优：score 严格大于 L1 才值得换
		if (candidates.length > 0) {
			let best = candidates[0];
			for (const c of candidates.slice(1)) {
				if (scoreArticle(c.article) > scoreArticle(best.article)) best = c;
			}
			if (scoreArticle(best.article) > scoreArticle(l1Article)) {
				const winner = best.article;
				if (!winner.title) winner.title = l1Article.title;
				if (!winner.url) winner.url = l1Article.url || url;
				return { ...winner, extractorDebug: { selected: best.leg, attempts } };
			}
		}
	} else {
		attempts.push({ leg: 'l2', skipped: true, reason: `${FALLBACK_FLAG} not enabled` });
	}

	// 全军覆没 → 降级返回 L1
	return { ...l1Article, extractorDebug: { selected: 'jina-degraded', attempts } };
}
