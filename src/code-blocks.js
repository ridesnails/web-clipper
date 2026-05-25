import { parseHTML } from 'linkedom';

const LINE_NUMBER_SELECTORS = [
	'.line-numbers-rows',
	'.hljs-ln-numbers',
	'.hljs-ln-line.hljs-ln-numbers',
	'.linenos',
	'.gutter',
	'.rouge-gutter',
	'td.gutter',
	'td.rouge-gutter',
	'td.linenos',
];

const CODE_WRAPPER_SELECTORS = [
	'figure.highlight',
	'figure[class*="highlight"]',
	'div.highlight',
	'div[class*="highlight"]',
	'div.codehilite',
	'div[class*="codehilite"]',
	'div.rouge-highlight',
	'div[class*="language-"]',
].join(', ');

export function normalizeCodeBlocksHtml(html) {
	if (!html || !html.trim()) return '';
	const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
	const root = document.body || document.documentElement;
	if (!root) return html;

	removeLineNumberArtifacts(root);
	collapseTableCodeBlocks(root);
	simplifyCodeWrappers(root);
	ensurePreCodeShape(root);

	return root.innerHTML || html;
}

export function extractCodeLanguage(node) {
	for (const candidate of collectLanguageCandidates(node)) {
		const language = parseLanguageToken(candidate);
		if (language) return language;
	}
	return '';
}

export function fenceCodeBlock(text, language = '') {
	const normalized = normalizeCodeText(text);
	const fence = normalized.includes('```') ? '````' : '```';
	const lang = language ? language.toLowerCase() : '';
	return `${fence}${lang ? lang : ''}\n${normalized}\n${fence}`;
}

export function normalizeCodeText(text) {
	return String(text || '')
		.replace(/\r\n/g, '\n')
		.replace(/\u00a0/g, ' ')
		.replace(/^\n+/, '')
		.replace(/\n+$/, '');
}

function removeLineNumberArtifacts(root) {
	for (const selector of LINE_NUMBER_SELECTORS) {
		for (const node of Array.from(root.querySelectorAll(selector))) {
			node.remove();
		}
	}
}

function collapseTableCodeBlocks(root) {
	for (const table of Array.from(root.querySelectorAll('table'))) {
		const pres = Array.from(table.querySelectorAll('pre'));
		if (pres.length < 2) continue;
		const best = chooseBestPre(pres);
		if (!best) continue;
		table.replaceWith(buildPreNode(table.ownerDocument, best.textContent || '', extractCodeLanguage(best)));
	}
}

function simplifyCodeWrappers(root) {
	for (const wrapper of Array.from(root.querySelectorAll(CODE_WRAPPER_SELECTORS))) {
		if (wrapper.querySelector('table')) continue;
		const pres = Array.from(wrapper.querySelectorAll('pre'));
		if (!pres.length) continue;

		const best = chooseBestPre(pres);
		if (!best) continue;

		const wrapperText = normalizeCodeText(wrapper.textContent || '');
		const bestText = normalizeCodeText(best.textContent || '');
		if (!bestText) continue;
		if (wrapperText.length > bestText.length + 24) continue;

		wrapper.replaceWith(buildPreNode(wrapper.ownerDocument, bestText, extractCodeLanguage(best)));
	}
}

function ensurePreCodeShape(root) {
	for (const pre of Array.from(root.querySelectorAll('pre'))) {
		if (pre.querySelector(':scope > code')) continue;
		const code = pre.ownerDocument.createElement('code');
		code.textContent = normalizeCodeText(pre.textContent || '');
		const language = extractCodeLanguage(pre);
		if (language) {
			code.setAttribute('class', `language-${language}`);
		}
		pre.replaceChildren(code);
	}
}

function buildPreNode(document, text, language = '') {
	const pre = document.createElement('pre');
	const code = document.createElement('code');
	if (language) {
		code.setAttribute('class', `language-${language}`);
	}
	code.textContent = normalizeCodeText(text);
	pre.appendChild(code);
	return pre;
}

function chooseBestPre(pres) {
	let best = null;
	let bestScore = -Infinity;
	for (const pre of pres) {
		const text = normalizeCodeText(pre.textContent || '');
		if (!text) continue;
		const classes = collectClassNames(pre);
		let score = text.length;
		if (/\b(gutter|linenos|line-?numbers?)\b/i.test(classes)) score -= 1000;
		if (/\b(code|highlight|language|lang|source)\b/i.test(classes)) score += 120;
		if (pre.querySelector('code')) score += 80;
		if (text.includes('\n')) score += 40;
		if (score > bestScore) {
			best = pre;
			bestScore = score;
		}
	}
	return best;
}

function collectClassNames(node) {
	const values = [];
	let current = node;
	let depth = 0;
	while (current && depth < 4) {
		if (current.getAttribute) {
			values.push(current.getAttribute('class') || '');
			values.push(current.getAttribute('data-language') || '');
			values.push(current.getAttribute('data-lang') || '');
		}
		current = current.parentElement;
		depth += 1;
	}
	return values.join(' ');
}

function collectLanguageCandidates(node) {
	const candidates = [];
	const related = [node, node?.querySelector?.('code'), node?.parentElement, node?.parentElement?.parentElement].filter(Boolean);
	for (const item of related) {
		if (!item?.getAttribute) continue;
		candidates.push(item.getAttribute('class') || '');
		candidates.push(item.getAttribute('data-language') || '');
		candidates.push(item.getAttribute('data-lang') || '');
	}
	return candidates.filter(Boolean);
}

function parseLanguageToken(value) {
	const text = String(value || '');
	const patterns = [
		/(?:^|\s)language-([a-z0-9#+._-]+)/i,
		/(?:^|\s)lang-([a-z0-9#+._-]+)/i,
		/(?:^|\s)highlight-source-([a-z0-9#+._-]+)/i,
		/brush:\s*([a-z0-9#+._-]+)/i,
	];
	for (const pattern of patterns) {
		const match = text.match(pattern);
		if (match) return sanitizeLanguage(match[1]);
	}
	return '';
}

function sanitizeLanguage(value) {
	return String(value || '')
		.trim()
		.replace(/[^a-z0-9#+._-]/gi, '')
		.toLowerCase();
}
