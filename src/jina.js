import { isValidUrl } from './utils.js';
import { withRetry, withTimeout } from './http.js';

// 统一走 POST + JSON body：GET 拼接会让 hash 路由的 # 后内容被 Web 标准剥掉，
// 也不需要再做 URL encode
const JINA_ENDPOINT = 'https://r.jina.ai/';
// browser 引擎比 curl 慢，放宽本地超时；服务端 x-timeout 上限 180s，默认 30s 会先到期
const JINA_TIMEOUT_MS = 45000;

// X-Respond-With: frontmatter 响应格式：
// ---
// title: "..."
// url: "..."
// publishedTime: "..."
// warning: "..."（可选，缓存快照提示）
// ---
// <正文 markdown，不再有 "Markdown Content:" 标记>
export function parseFrontmatter(md) {
	const m = md.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
	if (!m) return { meta: null, body: md };
	const meta = {};
	for (const line of m[1].split('\n')) {
		const kv = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
		if (kv) {
			const value = kv[2].trim().replace(/^"([\s\S]*)"$/, '$1').replace(/^'([\s\S]*)'$/, '$1');
			meta[kv[1].trim().toLowerCase()] = value;
		}
	}
	// 守卫：正文本身以 --- 开头的普通 markdown（无 frontmatter）不该被误截
	if (!meta.title && !meta.url) return { meta: null, body: md };
	return { meta, body: md.slice(m[0].length).replace(/^\s+/, '') };
}

// 降级用：仅当响应没带 frontmatter（老格式/异常响应）时从文本里找标题。
// X-Engine: browser 根治了登录/校验页占位标题问题，原黑名单 hack 已删。
export function extractTitle(md) {
	const titleMatch = md.match(/^Title:\s*(.+)$/m);
	if (titleMatch) {
		const t = titleMatch[1].trim();
		if (t && !t.startsWith('http')) return t;
	}
	// 兜底：扫描正文 h1~h4，取首个标题
	const headingMatches = md.matchAll(/^#{1,4}\s+(.+)$/gm);
	for (const m of headingMatches) {
		const t = m[1].trim();
		if (t) return t;
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

function buildJinaHeaders({ env, options, noCache }) {
	const headers = {
		'Content-Type': 'application/json',
		Accept: 'text/plain',
		'X-Engine': 'browser',
		'X-Respond-With': 'frontmatter',
		// 与 Turndown 侧 bulletListMarker: '-' 对齐，两条入口产出风格一致
		'X-Md-Bullet-List-Marker': '-',
	};
	if (env.JINA_API_KEY) {
		headers.Authorization = `Bearer ${env.JINA_API_KEY}`;
	}
	// 仅调用方显式提供时才发：selector 未命中会让 Reader 直接 422，不能盲发
	if (options.targetSelector) {
		headers['X-Target-Selector'] = String(options.targetSelector);
	}
	if (options.waitForSelector) {
		headers['X-Wait-For-Selector'] = String(options.waitForSelector);
	}
	if (noCache) {
		headers['X-No-Cache'] = 'true';
	}
	return headers;
}

export async function fetchArticleFromUrl(url, env, options = {}) {
	if (!isValidUrl(url)) {
		throw new Error(`Jina fetch failed: invalid url ${url}`);
	}

	const doFetch = async (attempt) => {
		// 首次走 Reader 缓存；重试强制绕过（缓存 3600s，否则反复拿到同一份坏结果）
		const headers = buildJinaHeaders({ env, options, noCache: attempt > 0 });
		const res = await fetch(JINA_ENDPOINT, {
			method: 'POST',
			headers,
			body: JSON.stringify({ url }),
			signal: withTimeout(JINA_TIMEOUT_MS),
		});
		if (!res.ok) {
			const errText = await res.text().catch(() => '');
			const error = new Error(`Jina fetch failed: ${res.status} ${errText.slice(0, 300)}`);
			error.status = res.status;
			throw error;
		}
		return res;
	};

	let jinaRes;
	try {
		jinaRes = await withRetry(doFetch, {
			retries: 2,
			delaysMs: [1000, 2000],
			shouldRetry: (error) => {
				if (error && typeof error.status === 'number') {
					return error.status === 429 || (error.status >= 500 && error.status <= 599);
				}
				const msg = String((error && error.message) || error || '');
				return /timeout|abort|network|fetch failed/i.test(msg);
			},
		});
	} catch (error) {
		const detail = error?.message || String(error);
		console.error('Jina fetch failed:', url, detail);
		throw new Error(`Jina fetch failed: ${detail}`);
	}

	const markdown = await jinaRes.text();
	const { meta, body } = parseFrontmatter(markdown);
	if (meta?.warning) {
		console.warn('Jina frontmatter warning:', url, meta.warning);
	}
	return {
		title: (meta?.title || extractTitle(markdown) || 'untitled').trim(),
		url: meta?.url || url,
		markdownBody: stripEmptyLinks(cleanJinaBody(body)),
		sourceHtml: '',
	};
}
