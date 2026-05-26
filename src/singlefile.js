import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';
import { fenceCodeBlock, extractCodeLanguage, normalizeCodeBlocksHtml } from './code-blocks.js';

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
				// 保留代码高亮类名，方便后续恢复 fenced code 的语言标记
				keepClasses: true,
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
	const normalizedHtml = normalizeCodeBlocksHtml(articleHtml);
	const { document, window } = parseHTML(`<!doctype html><html><body>${normalizedHtml}</body></html>`);
	const root = document.body || document.firstElementChild || document.documentElement;
	if (!root) return '';

	const turndown = createTurndownService(options);
	return withDomGlobals(window, () => turndown.turndown(root.innerHTML || normalizedHtml).trim());
}

function withDomGlobals(window, fn) {
	const keys = ['window', 'document', 'Node', 'NodeFilter', 'HTMLElement', 'HTMLImageElement', 'HTMLAnchorElement', 'Text', 'DOMParser'];
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

function normalizeInlineText(text) {
	return String(text || '').replace(/\s+/g, ' ');
}

function createTurndownService(options) {
	const service = new TurndownService({
		codeBlockStyle: 'fenced',
		headingStyle: 'atx',
		bulletListMarker: '-',
		emDelimiter: '*',
		strongDelimiter: '**',
		br: '\n',
	});

	service.addRule('preserve-pre-code', {
		filter(node) {
			return node.nodeName === 'PRE';
		},
		replacement(content, node) {
			const codeNode = node.querySelector?.('code') || node;
			return `\n\n${fenceCodeBlock(codeNode.textContent || '', extractCodeLanguage(codeNode))}\n\n`;
		},
	});

	service.addRule('inline-code', {
		filter(node) {
			return node.nodeName === 'CODE' && node.parentNode?.nodeName !== 'PRE';
		},
		replacement(content, node) {
			const text = String(node.textContent || '').replace(/\r\n/g, ' ').replace(/\n/g, ' ');
			if (!text) return '';
			const maxTicks = Math.max(0, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length));
			const fence = '`'.repeat(Math.max(1, maxTicks + 1));
			return `${fence}${text}${fence}`;
		},
	});

	service.addRule('keep-images', {
		filter(node) {
			return node.nodeName === 'IMG';
		},
		replacement(content, node) {
			const src = resolveImageSource(node, options);
			const alt = node.getAttribute('alt') || '';
			if (!shouldKeepImage(src, options)) return '';
			return src ? `![${alt}](${src})` : '';
		},
	});

	service.addRule('strip-empty-links', {
		filter(node) {
			return node.nodeName === 'A';
		},
		replacement(content, node) {
			const href = node.getAttribute('href') || '';
			const text = String(content || '').replace(/\u200B/g, '').trim();
			if (!href) return content;
			if (!text) return '';
			return `[${content}](${href})`;
		},
	});

	return service;
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
