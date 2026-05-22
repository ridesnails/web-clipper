// Telegraph API 封装与 HTML/Markdown → Telegraph Node 转换

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
	return htmlToTelegraphNodes(markdownToHtml(markdown));
}

/**
 * 将 HTML 转成 Telegraph Node。
 * 只保留 Telegraph 支持的标签/属性，h1/h5 映射为 h3，h2/h6 映射为 h4，del 映射为 s。
 * @param {string} html - HTML 文本
 * @returns {Array} Telegraph Node 数组
 */
export function htmlToTelegraphNodes(html) {
	if (!html || !html.trim()) return [];
	const root = { tag: 'root', children: [] };
	const stack = [root];
	const tokenRe = /<!--[\s\S]*?-->|<!DOCTYPE[\s\S]*?>|<[^>]+>|[^<]+/gi;
	let match;

	while ((match = tokenRe.exec(html)) !== null) {
		const token = match[0];
		if (!token || token.startsWith('<!--') || /^<!DOCTYPE/i.test(token)) continue;

		if (token.startsWith('</')) {
			const closing = normalizeTag(token.slice(2, -1).trim().split(/\s+/)[0]);
			for (let i = stack.length - 1; i > 0; i--) {
				if (stack[i].tag === closing) {
					stack.length = i;
					break;
				}
			}
			continue;
		}

		if (token.startsWith('<')) {
			const parsed = parseStartTag(token);
			if (!parsed) continue;
			const { tag, attrs, selfClosing } = parsed;
			if (!SUPPORTED_TAGS.has(tag)) continue;

			const node = { tag };
			const safeAttrs = sanitizeAttrs(tag, attrs);
			if (Object.keys(safeAttrs).length > 0) node.attrs = safeAttrs;

			appendChild(stack[stack.length - 1], node);
			if (!selfClosing && !VOID_TAGS.has(tag)) stack.push(node);
			continue;
		}

		const parentTag = stack[stack.length - 1].tag;
		const text = parentTag === 'pre' || parentTag === 'code' ? decodeHtml(token) : decodeHtml(token.replace(/\s+/g, ' '));
		if (text) appendChild(stack[stack.length - 1], text);
	}

	return compactNodes(root.children);
}

function markdownToHtml(markdown) {
	const lines = markdown.replace(/\r\n/g, '\n').split('\n');
	const html = [];
	let paragraph = [];
	let listType = null;
	let inCodeBlock = false;
	let codeLines = [];

	function flushParagraph() {
		if (paragraph.length > 0) {
			html.push(`<p>${parseInline(paragraph.join(' '))}</p>`);
			paragraph = [];
		}
	}

	function flushList() {
		if (listType) {
			html.push(`</${listType}>`);
			listType = null;
		}
	}

	function flushCode() {
		html.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
		codeLines = [];
	}

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const trimmed = line.trim();

		if (trimmed.startsWith('```')) {
			if (inCodeBlock) {
				flushCode();
				inCodeBlock = false;
			} else {
				flushParagraph();
				flushList();
				inCodeBlock = true;
			}
			continue;
		}

		if (inCodeBlock) {
			codeLines.push(line);
			continue;
		}

		if (!trimmed) {
			flushParagraph();
			flushList();
			continue;
		}

		if (trimmed.includes('|')) {
			const tableLines = [];
			let j = i;
			while (j < lines.length && lines[j].includes('|')) {
				tableLines.push(lines[j]);
				j++;
			}
			const isSeparator = (s) => /^\s*\|?[\s\-:|]+\|?[\s\-:|]*$/.test(s);
			const isTable = tableLines.length >= 2 && (isSeparator(tableLines[1]) || tableLines.every((l) => l.includes('|')));
			if (isTable) {
				flushParagraph();
				flushList();
				html.push(`<pre><code>${escapeHtml(tableLines.join('\n'))}</code></pre>`);
				i = j - 1;
				continue;
			}
		}

		const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
		if (heading) {
			flushParagraph();
			flushList();
			const level = heading[1].length;
			if (level === 1 || level === 2) {
				const tag = level === 1 ? 'h3' : 'h4';
				html.push(`<${tag}>${parseInline(heading[2])}</${tag}>`);
			} else {
				html.push(`<p><b>${parseInline(heading[2])}</b></p>`);
			}
			continue;
		}

		if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
			flushParagraph();
			flushList();
			html.push('<hr>');
			continue;
		}

		const quote = trimmed.match(/^>\s*(.*)$/);
		if (quote) {
			flushParagraph();
			flushList();
			html.push(`<blockquote>${parseInline(quote[1])}</blockquote>`);
			continue;
		}

		const img = trimmed.match(/^!\[([^\]]*)\]\(([^)\s]+)\)$/);
		if (img) {
			flushParagraph();
			flushList();
			html.push(`<img src="${escapeAttr(img[2])}">`);
			continue;
		}

		const list = trimmed.match(/^(-|\*|\d+\.)\s+(.+)$/);
		if (list) {
			flushParagraph();
			const nextType = /\d+\./.test(list[1]) ? 'ol' : 'ul';
			if (listType && listType !== nextType) flushList();
			if (!listType) {
				listType = nextType;
				html.push(`<${listType}>`);
			}
			html.push(`<li>${parseInline(list[2])}</li>`);
			continue;
		}

		paragraph.push(trimmed);
	}

	flushParagraph();
	flushList();
	if (inCodeBlock && codeLines.length > 0) flushCode();
	return html.join('\n');
}

function parseInline(text) {
	let s = escapeHtml(text);
	s = s.replace(/!\[([^\]]*)\]\((https?:\/\/[^)\s]+)(?:\s+"[^"]*")?\)/g, '<img src="$2">');
	s = s.replace(/\[([^\]]*)\]\((https?:\/\/[^)\s]+)(?:\s+"[^"]*")?\)/g, (_match, label, href) => {
		const visibleLabel = label.replace(/\u200B/g, '').trim();
		if (!visibleLabel) return '';
		return `<a href="${href}">${label}</a>`;
	});
	s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
	s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
	s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
	s = s.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');
	s = s.replace(/(?<!_)_([^_]+)_(?!_)/g, '<em>$1</em>');
	s = s.replace(/~~([^~]+)~~/g, '<s>$1</s>');
	return s;
}

function parseStartTag(token) {
	const selfClosing = /\/\s*>$/.test(token);
	const inner = token.slice(1, token.length - (selfClosing ? 2 : 1)).trim();
	if (!inner) return null;
	const space = inner.search(/\s/);
	const rawTag = space === -1 ? inner : inner.slice(0, space);
	const tag = normalizeTag(rawTag);
	const attrText = space === -1 ? '' : inner.slice(space + 1);
	return { tag, attrs: parseAttrs(attrText), selfClosing };
}

function normalizeTag(tag) {
	const t = String(tag || '').toLowerCase();
	if (t === 'h1' || t === 'h5') return 'h3';
	if (t === 'h2' || t === 'h6') return 'h4';
	if (t === 'del') return 's';
	return t;
}

function parseAttrs(attrText) {
	const attrs = {};
	const attrRe = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
	let match;
	while ((match = attrRe.exec(attrText)) !== null) {
		attrs[match[1].toLowerCase()] = decodeHtml(match[3] ?? match[4] ?? match[5] ?? '');
	}
	return attrs;
}

function sanitizeAttrs(tag, attrs) {
	const safe = {};
	if (tag === 'a' && isSafeUrl(attrs.href)) safe.href = attrs.href;
	if ((tag === 'img' || tag === 'video' || tag === 'iframe') && isSafeUrl(attrs.src)) {
		safe.src = tag === 'iframe' ? transformToIframeUrl(attrs.src) : attrs.src;
	}
	return safe;
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

function appendChild(parent, child) {
	parent.children ??= [];
	parent.children.push(child);
}

function compactNodes(nodes) {
	return nodes
		.map((node) => {
			if (typeof node === 'string') return node.trim() ? node : null;
			if (node.children) node.children = compactNodes(node.children);
			if (!VOID_TAGS.has(node.tag) && (!node.children || node.children.length === 0) && BLOCK_TAGS.has(node.tag)) return null;
			return node;
		})
		.filter(Boolean);
}

function escapeHtml(str) {
	return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
