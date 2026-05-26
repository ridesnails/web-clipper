// Telegraph API 封装与 HTML 主链路 / Markdown fallback → Telegraph Node 转换
import { marked } from 'marked';
import { parseHTML } from 'linkedom';
import { normalizeCodeBlocksHtml } from './code-blocks.js';

const SUPPORTED_TAGS = new Set(['a', 'aside', 'b', 'blockquote', 'br', 'code', 'em', 'figcaption', 'figure', 'h3', 'h4', 'hr', 'i', 'iframe', 'img', 'li', 'ol', 'p', 'pre', 's', 'strong', 'u', 'ul', 'video']);
const VOID_TAGS = new Set(['br', 'hr', 'img', 'iframe', 'video']);
const BLOCK_TAGS = new Set(['p', 'blockquote', 'pre', 'ul', 'ol', 'li', 'h3', 'h4', 'figure', 'figcaption', 'aside', 'hr']);

/**
 * 在 Telegraph 上创建页面
 * @param {string} title - 页面标题
 * @param {Array} contentNodes - Telegraph Node 数组
 * @param {object} env - 环境变量，需包含 TELEGRAPH_ACCESS_TOKEN
 * @returns {Promise<{url: string, path: string, title: string}>}
 */
export async function createPage(title, contentNodes, env) {
	const res = await fetch('https://api.telegra.ph/createPage', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			access_token: env.TELEGRAPH_ACCESS_TOKEN,
			title,
			content: JSON.stringify(contentNodes),
			return_content: false,
		}),
	});

	if (!res.ok) {
		throw new Error(`Telegraph createPage failed: ${res.status}`);
	}

	const data = await res.json();
	if (!data.ok) {
		throw new Error(`Telegraph createPage failed: ${data.error}`);
	}

	return {
		url: data.result.url,
		path: data.result.path,
		title: data.result.title,
	};
}

/**
 * 将 Markdown 转成 Telegraph Node。
 * 参考 dcdunkan/telegraph 的工作流：Markdown 先转 HTML，再按 Telegraph 允许标签清洗并转换成 Node。
 * @param {string} markdown - Markdown 文本
 * @returns {Array} Telegraph Node 数组
 */
export function markdownToTelegraphNodes(markdown) {
	if (!markdown || !markdown.trim()) return [];
	const processed = preprocessTables(markdown);
	const html = marked.parse(processed, { async: false });
	return htmlToTelegraphNodes(html);
}

/**
 * Telegraph 内容构建策略：
 * 1. 优先直接使用 HTML 转 Node
 * 2. 只有拿不到 HTML 时，才退回 Markdown fallback
 */
export function buildTelegraphNodes({ html = '', markdown = '', summary = '', tags = [] }) {
	const bodyHtml = String(html || '').trim();
	if (bodyHtml) {
		return htmlToTelegraphNodes(buildTelegraphHtml({ body: extractTelegraphContentHtml(bodyHtml), summary, tags }));
	}

	const blocks = [];
	if (summary) {
		blocks.push('#### 摘要', '', summary.trim(), '');
	}

	const tagLine = formatTagLine(tags);
	if (tagLine) {
		blocks.push(`标签：${tagLine}`, '');
	}

	const bodyMarkdown = String(markdown || '').trim();
	if (bodyMarkdown) {
		blocks.push(bodyMarkdown);
	}

	return markdownToTelegraphNodes(blocks.join('\n\n'));
}

/**
 * 将 HTML 转成 Telegraph Node。
 * 只保留 Telegraph 支持的标签/属性，h1/h5 映射为 h3，h2/h6 映射为 h4，del 映射为 s。
 * @param {string} html - HTML 文本
 * @returns {Array} Telegraph Node 数组
 */
export function htmlToTelegraphNodes(html) {
	if (!html || !html.trim()) return [];
	const normalizedHtml = normalizeCodeBlocksHtml(html);
	const { document } = parseHTML('<html><body><div id="root">' + normalizedHtml + '</div></body></html>');
	const root = document.getElementById('root');
	const nodes = [];
	for (const child of root.childNodes) {
		const node = domToNode(child);
		if (node) {
			if (Array.isArray(node)) nodes.push(...node);
			else nodes.push(node);
		}
	}
	return compactNodes(nodes);
}

export function extractTelegraphContentHtml(html) {
	if (!html || !html.trim()) return '';
	const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
	const selectors = ['#VPContent .vp-doc', 'main .vp-doc', 'article .vp-doc', '.theme-default-content', 'main article', 'article', '[role="main"]', 'main'];

	for (const selector of selectors) {
		const node = document.querySelector(selector);
		if (node?.innerHTML?.trim()) return node.innerHTML;
	}

	return document.body?.innerHTML || html;
}

/* ─── 内部实现 ─── */

/**
 * 将 Markdown 中的 GFM 表格语法临时转换为围栏代码块，
 * 因为 Telegraph 不支持 table 标签，保留原始文本更友好。
 */
function preprocessTables(markdown) {
	const lines = markdown.replace(/\r\n/g, '\n').split('\n');
	const result = [];
	let i = 0;
	while (i < lines.length) {
		if (lines[i].includes('|')) {
			const tableLines = [];
			let j = i;
			while (j < lines.length && lines[j].includes('|')) {
				tableLines.push(lines[j]);
				j++;
			}
			const isSeparator = (s) => /^\s*\|?[\s\-:|]+\|?[\s\-:|]*$/.test(s);
			const isTable = tableLines.length >= 2 && (isSeparator(tableLines[1]) || tableLines.every((l) => l.includes('|')));
			if (isTable) {
				result.push('```');
				result.push(...tableLines);
				result.push('```');
				i = j;
				continue;
			}
		}
		result.push(lines[i]);
		i++;
	}
	return result.join('\n');
}

function domToNode(element) {
	if (!element) return null;
	if (element.nodeType === 3) {
		if (!element.nodeValue) return null;
		const parentTag = element.parentElement?.tagName?.toLowerCase();
		if (parentTag !== 'pre' && parentTag !== 'code') {
			if (/^\s*$/.test(element.nodeValue) && element.nodeValue.includes('\n')) {
				return null;
			}
		}
		if (parentTag === 'p' && element.nodeValue) {
			return element.nodeValue.replace(/\n/g, ' ');
		}
		return element.nodeValue;
	}
	if (element.nodeType !== 1) return null;

	const rawTag = element.tagName.toLowerCase();
	const tag = normalizeTag(rawTag);

	if (!SUPPORTED_TAGS.has(tag)) {
		const children = [];
		for (const child of element.childNodes) {
			const childNode = domToNode(child);
			if (childNode) {
				if (Array.isArray(childNode)) children.push(...childNode);
				else children.push(childNode);
			}
		}
		return children.length ? children : null;
	}

	const node = { tag };

	if (tag === 'a') {
		const href = element.getAttribute('href');
		if (href && isSafeUrl(href)) {
			node.attrs = { href };
		}
	}
	if (tag === 'img' || tag === 'video' || tag === 'iframe') {
		const src = element.getAttribute('src');
		if (src && isSafeUrl(src)) {
			node.attrs = { src: tag === 'iframe' ? transformToIframeUrl(src) : src };
		}
	}

	if (!VOID_TAGS.has(tag) && element.childNodes.length) {
		node.children = [];
		for (const child of element.childNodes) {
			const childNode = domToNode(child);
			if (childNode) {
				if (Array.isArray(childNode)) node.children.push(...childNode);
				else node.children.push(childNode);
			}
		}
	}

	// 过滤没有有意义内容的 <a> 标签（空链接、零宽空格链接）
	if (tag === 'a') {
		const hasContent = node.children?.some((child) => {
			if (typeof child === 'string') return child.replace(/\u200B/g, '').trim().length > 0;
			return true;
		});
		if (!hasContent) return null;
	}

	return node;
}

function normalizeTag(tag) {
	const t = String(tag || '').toLowerCase();
	if (t === 'h1' || t === 'h5') return 'h3';
	if (t === 'h2' || t === 'h6') return 'h4';
	if (t === 'del') return 's';
	return t;
}

function transformToIframeUrl(url) {
	const patterns = {
		twitter: /(https?:\/\/)?(www\.)?twitter\.com\/([a-zA-Z0-9_]+\/)*status\/([0-9]+)/,
		telegram: /^(https?):\/\/(t\.me|telegram\.me|telegram\.dog)\/([a-zA-Z0-9_]+)\/(\d+)/,
		vimeo: /(https?:\/\/)?(www\.)?(player\.)?vimeo\.com\/([a-z]*\/)*([0-9]{6,11})/,
		youtube: /^.*(?:(?:youtu\.be\/|v\/|vi\/|u\/\w\/|embed\/)|(?:(?:watch)?\?v(?:i)?=|&v(?:i)?=))([^#&?]+).*/,
	};
	for (const [site, re] of Object.entries(patterns)) {
		if (re.test(url)) return `/embed/${site}?url=${encodeURIComponent(url)}`;
	}
	return url;
}

function isSafeUrl(url) {
	return typeof url === 'string' && (/^https?:\/\//i.test(url) || url.startsWith('/embed/'));
}

function compactNodes(nodes, parentTag = '') {
	return nodes
		.map((node) => {
			if (typeof node === 'string') {
				if (parentTag === 'pre' || parentTag === 'code') {
					return node.length ? node : null;
				}
				return node.trim() ? node : null;
			}
			if (node.children) node.children = compactNodes(node.children, node.tag);
			if (!VOID_TAGS.has(node.tag) && (!node.children || node.children.length === 0) && BLOCK_TAGS.has(node.tag)) return null;
			return node;
		})
		.filter(Boolean);
}

function escapeHtml(str) {
	return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildTelegraphHtml({ body, summary, tags = [] }) {
	const prefix = [];
	if (summary) {
		prefix.push(`<h4>摘要</h4>`, `<p>${escapeHtml(summary)}</p>`);
	}
	const tagLine = formatTagLine(tags);
	if (tagLine) {
		prefix.push(`<p>标签：${escapeHtml(tagLine)}</p>`);
	}
	if (!prefix.length) return body;
	return `${prefix.join('\n')}\n${body || ''}`;
}

function escapeAttr(str) {
	return escapeHtml(str).replace(/"/g, '&quot;');
}

function decodeHtml(str) {
	return String(str)
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&amp;/g, '&');
}

function formatTagLine(tags = []) {
	return tags
		.map((tag) => normalizeHashtag(tag))
		.filter(Boolean)
		.map((tag) => `#${tag}`)
		.join(' ');
}

function normalizeHashtag(tag) {
	return String(tag || '')
		.trim()
		.replace(/\s+/g, '_')
		.replace(/-/g, '_')
		.replace(/[^\w\u4e00-\u9fff]/g, '');
}
