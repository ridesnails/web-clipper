import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import { parseHTML } from 'linkedom';

const MAX_HTML_SIZE = 10 * 1024 * 1024;

const turndown = new TurndownService({
	headingStyle: 'atx',
	codeBlockStyle: 'fenced',
	bulletListMarker: '-',
});

turndown.addRule('removeScriptsAndStyles', {
	filter: ['script', 'style', 'noscript'],
	replacement: () => '',
});

export async function parseSingleFileUpload(request) {
	const form = await request.formData();
	const rawUrl = String(form.get('url') || '').trim();
	const file = form.get('singlehtmlfile');

	if (!(file instanceof File)) {
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

	const article = new Readability(document, {
		keepClasses: false,
	}).parse();

	const title = normalizeTitle(article?.title || document.title || stripHtmlExtension(filename) || 'untitled');
	const articleHtml = article?.content || extractBodyInnerHtml(document);
	const markdownBody = turndown.turndown(articleHtml || '');

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

function stripHtmlExtension(filename) {
	return String(filename || '').replace(/\.(html?|xhtml)$/i, '');
}

function normalizeTitle(value) {
	return String(value || '')
		.replace(/\s+/g, ' ')
		.trim();
}
