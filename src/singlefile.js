import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';

const MAX_HTML_SIZE = 10 * 1024 * 1024;

export async function parseSingleFileUpload(request) {
	const form = await request.formData();
	const rawUrl = String(form.get('url') || '').trim();
	const file = form.get('singlehtmlfile');

	if (!isUploadableFile(file)) {
		throw new Error('Missing singlehtmlfile');
	}
	if (file.size > MAX_HTML_SIZE) {
		throw new Error('singlehtmlfile too large');
	}

	const filename = file.name || 'singlefile.html';
	if (!/\.(html?|xhtml)$/i.test(filename)) {
		throw new Error('singlehtmlfile must be an .html file');
	}

	const html = await file.text();
	if (!html.trim()) {
		throw new Error('singlehtmlfile is empty');
	}

	return normalizeSingleFileHtml({
		html,
		url: rawUrl,
		filename,
	});
}

export function normalizeSingleFileHtml({ html, url, filename = 'singlefile.html' }) {
	const { document, window } = parseHTML(html);
	const docUrl = resolveDocumentUrl(document, url, filename);
	const preserveRichImages = shouldPreserveRichImages(docUrl);
	const imageVariableMap = extractSingleFileImageVariableMap(document);
	hydrateSingleFileImageSources(document, imageVariableMap);

	let article = null;
	try {
		article = withDomGlobals(window, () =>
			new Readability(document, {
				keepClasses: false,
			}).parse(),
		);
	} catch {
		article = null;
	}

	const title = normalizeTitle(article?.title || document.title || stripHtmlExtension(filename) || 'untitled');
	const articleHtml = preserveRichImages ? extractPreservedArticleHtml(document, docUrl) || article?.content || extractBodyInnerHtml(document) : article?.content || extractReadableFallbackHtml(document) || extractBodyInnerHtml(document);
	const markdownBody = htmlFragmentToMarkdown(articleHtml, { preserveRichImages, imageVariableMap });

	if (!markdownBody.trim()) {
		throw new Error('singlehtmlfile produced empty article');
	}

	return {
		title,
		url: docUrl,
		markdownBody: markdownBody.trim(),
		sourceHtml: articleHtml || document.documentElement?.outerHTML || html,
		window,
	};
}

function resolveDocumentUrl(document, fallbackUrl, filename) {
	const fromMeta = document.querySelector('meta[property="og:url"]')?.getAttribute('content');
	const fromCanonical = document.querySelector('link[rel="canonical"]')?.getAttribute('href');
	const candidate = fromMeta || fromCanonical || fallbackUrl;
	if (!candidate) return `https://singlefile.local/${encodeURIComponent(stripHtmlExtension(filename) || 'document')}`;
	try {
		return new URL(candidate).href;
	} catch {
		return `https://singlefile.local/${encodeURIComponent(stripHtmlExtension(filename) || 'document')}`;
	}
}

function extractBodyInnerHtml(document) {
	return document.body?.innerHTML || document.documentElement?.innerHTML || '';
}

function extractReadableFallbackHtml(document) {
	return document.querySelector('article, main, [role="main"]')?.innerHTML || '';
}

function stripHtmlExtension(filename) {
	return String(filename || '').replace(/\.(html?|xhtml)$/i, '');
}

function normalizeTitle(value) {
	return String(value || '')
		.replace(/\s+/g, ' ')
		.trim();
}

function htmlFragmentToMarkdown(articleHtml, options = {}) {
	if (!articleHtml || !articleHtml.trim()) return '';
	const { document } = parseHTML(`<!doctype html><html><body>${articleHtml}</body></html>`);
	const root = document.body || document.firstElementChild || document.documentElement;
	if (!root) return '';
	const parts = [];
	for (const child of Array.from(root.childNodes || [])) {
		const chunk = renderNode(child, 0, options);
		if (chunk.trim()) parts.push(chunk.trim());
	}
	return parts.join('\n\n').trim();
}

function withDomGlobals(window, fn) {
	const keys = ['document', 'Node', 'NodeFilter', 'HTMLElement', 'HTMLImageElement', 'HTMLAnchorElement', 'Text'];
	const previous = new Map();

	for (const key of keys) {
		previous.set(key, globalThis[key]);
		if (window?.[key] !== undefined) {
			globalThis[key] = window[key];
		}
	}

	try {
		return fn();
	} finally {
		for (const key of keys) {
			if (previous.get(key) === undefined) {
				delete globalThis[key];
			} else {
				globalThis[key] = previous.get(key);
			}
		}
	}
}

function renderNode(node, listDepth, options) {
	if (!node) return '';
	if (node.nodeType === 3) {
		return normalizeInlineText(node.textContent || '');
	}
	if (node.nodeType !== 1) return '';

	const tag = String(node.tagName || '').toLowerCase();
	switch (tag) {
		case 'article':
		case 'main':
		case 'section':
		case 'div':
		case 'body':
			return joinBlocks(node.childNodes, listDepth, options);
		case 'h1':
		case 'h2':
		case 'h3':
		case 'h4':
		case 'h5':
		case 'h6':
			return `${'#'.repeat(Number(tag[1]))} ${renderInlineChildren(node)}`.trim();
		case 'p':
			return renderInlineChildren(node);
		case 'blockquote':
			return renderInlineChildren(node)
				.split('\n')
				.map((line) => `> ${line}`.trimEnd())
				.join('\n');
		case 'pre': {
			const code = node.textContent || '';
			return `\`\`\`\n${code.trimEnd()}\n\`\`\``;
		}
		case 'ul':
			return Array.from(node.children)
				.map((child) => renderListItem(child, listDepth, '-', options))
				.join('\n');
		case 'ol':
			return Array.from(node.children)
				.map((child, index) => renderListItem(child, listDepth, `${index + 1}.`, options))
				.join('\n');
		case 'img': {
			const src = resolveImageSource(node, options);
			const alt = node.getAttribute('alt') || '';
			if (!shouldKeepImage(src, options)) return '';
			return src ? `![${alt}](${src})` : '';
		}
		case 'hr':
			return '---';
		case 'br':
			return '\n';
		default:
			return renderInlineChildren(node, options);
	}
}

function renderListItem(node, listDepth, marker, options) {
	const content = renderInlineChildren(node, options).trim() || joinBlocks(node.childNodes, listDepth + 1, options).trim();
	const indent = '  '.repeat(listDepth);
	return `${indent}${marker} ${content}`.trimEnd();
}

function renderInlineChildren(node, options) {
	const parts = [];
	for (const child of Array.from(node.childNodes)) {
		if (child.nodeType === 3) {
			parts.push(normalizeInlineText(child.textContent || ''));
			continue;
		}
		if (child.nodeType !== 1) continue;
		const tag = String(child.tagName || '').toLowerCase();
		if (tag === 'a') {
			const href = child.getAttribute('href') || '';
			const text = renderInlineChildren(child, options) || normalizeInlineText(child.textContent || '');
			parts.push(href ? `[${text}](${href})` : text);
			continue;
		}
		if (tag === 'strong' || tag === 'b') {
			parts.push(`**${renderInlineChildren(child, options)}**`);
			continue;
		}
		if (tag === 'em' || tag === 'i') {
			parts.push(`*${renderInlineChildren(child, options)}*`);
			continue;
		}
		if (tag === 'code') {
			parts.push(`\`${child.textContent || ''}\``);
			continue;
		}
		if (tag === 'br') {
			parts.push('\n');
			continue;
		}
		if (tag === 'img') {
			const src = resolveImageSource(child, options);
			const alt = child.getAttribute('alt') || '';
			if (shouldKeepImage(src, options)) {
				parts.push(`![${alt}](${src})`);
			}
			continue;
		}
		const blockLike = ['p', 'div', 'section', 'article', 'ul', 'ol', 'pre', 'blockquote'].includes(tag);
		parts.push(blockLike ? `\n${renderNode(child, 0, options)}\n` : renderInlineChildren(child, options));
	}
	return normalizeInlineText(parts.join('')).replace(/\n{3,}/g, '\n\n').trim();
}

function joinBlocks(childNodes, listDepth, options) {
	return Array.from(childNodes)
		.map((child) => renderNode(child, listDepth, options))
		.filter((chunk) => chunk && chunk.trim())
		.join('\n\n');
}

function normalizeInlineText(text) {
	return String(text || '').replace(/\s+/g, ' ');
}

function isUploadableFile(value) {
	return Boolean(
		value &&
			typeof value === 'object' &&
			typeof value.name === 'string' &&
			typeof value.size === 'number' &&
			typeof value.text === 'function',
	);
}

function shouldPreserveRichImages(url) {
	try {
		const hostname = new URL(url).hostname;
		return hostname === 'www.nodeseek.com' || hostname === 'nodeseek.com';
	} catch {
		return false;
	}
}

function extractPreservedArticleHtml(document, url) {
	try {
		const hostname = new URL(url).hostname;
		if (hostname === 'www.nodeseek.com' || hostname === 'nodeseek.com') {
			return selectBestHtmlBlock(document.querySelectorAll('article.post-content, .post-content'));
		}
	} catch {}
	return document.querySelector('article, [class*="post-content"], [class*="content-item"]')?.innerHTML || '';
}

function shouldKeepImage(src, options) {
	if (!src) return false;
	if (src.startsWith('data:image/svg+xml')) return false;
	return true;
}

function extractSingleFileImageVariableMap(document) {
	const map = new Map();
	for (const styleEl of Array.from(document.querySelectorAll('style'))) {
		const css = styleEl.textContent || '';
		const regex = /--(sf-img-\d+)\s*:\s*url\((["']?)(.*?)\2\)/g;
		let match;
		while ((match = regex.exec(css)) !== null) {
			map.set(`--${match[1]}`, match[3]);
		}
	}
	return map;
}

function hydrateSingleFileImageSources(document, imageVariableMap) {
	for (const img of Array.from(document.querySelectorAll('img'))) {
		const src = img.getAttribute('src') || '';
		if (!src.startsWith('data:image/svg+xml')) continue;
		const style = img.getAttribute('style') || '';
		const varMatch = style.match(/background-image:\s*var\((--sf-img-\d+)\)/);
		if (!varMatch) continue;
		const realSrc = imageVariableMap.get(varMatch[1]);
		if (realSrc) {
			img.setAttribute('src', realSrc);
		}
	}
}

function resolveImageSource(node, options) {
	const directSrc = node.getAttribute('src') || '';
	if (directSrc && !directSrc.startsWith('data:image/svg+xml')) {
		return directSrc;
	}

	const style = node.getAttribute('style') || '';
	const varMatch = style.match(/background-image:\s*var\((--sf-img-\d+)\)/);
	if (!varMatch) return directSrc;

	return options?.imageVariableMap?.get(varMatch[1]) || directSrc;
}

function selectBestHtmlBlock(nodeList) {
	let bestHtml = '';
	let bestScore = -1;
	for (const node of Array.from(nodeList || [])) {
		const textLength = normalizeInlineText(node.textContent || '').length;
		const imageCount = node.querySelectorAll?.('img').length || 0;
		const score = textLength + imageCount * 40;
		if (score > bestScore) {
			bestScore = score;
			bestHtml = node.innerHTML || '';
		}
	}
	return bestHtml;
}
