import { isValidUrl } from './utils.js';
import { fetchWithTimeout } from './http.js';

// 平台通用占位标题：jina 抓取微信等站点遇登录/校验页时返回的无意义标题，需跳过
const PLACEHOLDER_TITLES = [
	'Weixin Official Accounts Platform',
	'微信公众平台',
	'微信公众号',
];

function isPlaceholderTitle(t) {
	if (!t) return true;
	return PLACEHOLDER_TITLES.some((p) => t === p || t.includes(p));
}

export function extractTitle(md) {
	const titleMatch = md.match(/^Title:\s*(.+)$/m);
	if (titleMatch) {
		const t = titleMatch[1].trim();
		if (t && !t.startsWith('http') && !isPlaceholderTitle(t)) return t;
	}
	// 降级：Title 字段缺失或为占位符时，扫描正文 h1~h4，取首个非占位标题
	// （微信文章真实标题常在 h2/h3，而 h1 多为平台占位）
	const headingMatches = md.matchAll(/^#{1,4}\s+(.+)$/gm);
	for (const m of headingMatches) {
		const t = m[1].trim();
		if (t && !isPlaceholderTitle(t)) return t;
	}
	return null;
}

export function cleanJinaBody(md) {
	const marker = /^Markdown Content:\s*$/m;
	const m = md.match(marker);
	if (m) {
		return md.slice(m.index + m[0].length).replace(/^\s+/, '');
	}
	return md
		.replace(/^Title:.*$/m, '')
		.replace(/^URL Source:.*$/m, '')
		.replace(/^Published Time:.*$/m, '')
		.replace(/^Markdown Content:.*$/m, '')
		.replace(/^\s+/, '');
}

export function stripEmptyLinks(md) {
	return md.replace(/\[(?:\s|​)*\]\(https?:\/\/[^)]+\)/g, '');
}

export async function fetchArticleFromUrl(url, env) {
	const jinaHeaders = { Accept: 'text/plain' };
	if (env.JINA_API_KEY) {
		jinaHeaders.Authorization = `Bearer ${env.JINA_API_KEY}`;
	}

	let jinaRes;
	try {
		jinaRes = await fetchWithTimeout(
			`https://r.jina.ai/${url}`,
			{ headers: jinaHeaders },
			{ timeoutMs: 25000, retries: 2, delaysMs: [1000, 2000], retryOnStatuses: [429, 500, 502, 503, 504] }
		);
	} catch (error) {
		const detail = error?.responseText || error?.message || String(error);
		const status = error?.status ? `${error.status} ` : '';
		console.error('Jina fetch failed:', url, status, detail);
		throw new Error(`Jina fetch failed: ${status}${detail}`);
	}
	if (!jinaRes.ok) {
		const errText = await jinaRes.text();
		console.error('Jina returned non-200:', url, jinaRes.status, errText);
		throw new Error(`Jina fetch failed: ${jinaRes.status} ${errText}`);
	}

	const markdown = await jinaRes.text();
	return {
		title: extractTitle(markdown) || 'untitled',
		url,
		markdownBody: stripEmptyLinks(cleanJinaBody(markdown)),
		sourceHtml: '',
	};
}
