import { isValidUrl } from './utils.js';

export function extractTitle(md) {
	const titleMatch = md.match(/^Title:\s*(.+)$/m);
	if (titleMatch) {
		const t = titleMatch[1].trim();
		if (t && !t.startsWith('http')) return t;
	}
	const h1Match = md.match(/^#\s+(.+)$/m);
	if (h1Match) return h1Match[1].trim();
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
	let lastErr;
	for (let attempt = 0; attempt <= 2; attempt++) {
		if (attempt > 0) {
			const delay = attempt === 1 ? 1000 : 2000;
			await new Promise((r) => setTimeout(r, delay));
		}
		jinaRes = await fetch(`https://r.jina.ai/${url}`, {
			headers: jinaHeaders,
			signal: AbortSignal.timeout(25000),
		});
		if (jinaRes.ok) break;

		const errText = await jinaRes.text();
		lastErr = `${jinaRes.status} ${errText}`;
		console.error('Jina returned non-200:', url, jinaRes.status, errText);
		const shouldRetry = jinaRes.status === 429 || jinaRes.status >= 500;
		if (!shouldRetry || attempt === 2) {
			throw new Error(`Jina fetch failed: ${lastErr}`);
		}
	}

	const markdown = await jinaRes.text();
	return {
		title: extractTitle(markdown) || 'untitled',
		url,
		markdownBody: stripEmptyLinks(cleanJinaBody(markdown)),
		sourceHtml: '',
	};
}
