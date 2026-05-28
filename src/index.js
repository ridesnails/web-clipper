import { sendPhoto, sendMessage, getFile } from './telegram.js';
import { parseSingleFileUpload } from './singlefile.js';
import { buildTelegraphNodes, createPage } from './telegraph.js';
import { fetchArticleFromUrl, extractTitle, cleanJinaBody, stripEmptyLinks } from './jina.js';
import { writeToFns } from './fns.js';
import { makeSlug, buildNote } from './note.js';
import { generateAiMetadata } from './ai.js';
import { isValidUrl, escapeHtml, escapeHtmlAttr, getHostname, resolveUrl, formatTagLine } from './utils.js';

const MAX_SINGLEFILE_INLINE_IMAGES = 6;
const INLINE_IMAGE_UPLOAD_CONCURRENCY = 3;

function corsHeaders(env) {
	return {
		'Access-Control-Allow-Origin': env.CORS_ORIGIN || '*',
		'Access-Control-Allow-Methods': 'POST, OPTIONS',
		'Access-Control-Allow-Headers': 'Authorization, Content-Type',
	};
}

const worker = {
	async fetch(request, env) {
		const { pathname } = new URL(request.url);

		if (pathname === '/favicon.ico') {
			return new Response(null, { status: 204 });
		}

		if (pathname === '/image-proxy') {
			return handleImageProxy(request, env);
		}

		if (pathname === '/telegram-webhook') {
			return handleTelegramWebhook(request, env);
		}

		if (request.method === 'OPTIONS') {
			return new Response(null, { status: 204, headers: corsHeaders(env) });
		}

		if (request.method !== 'POST') {
			return Response.json({ error: 'Method not allowed. Use POST.' }, { status: 405, headers: corsHeaders(env) });
		}

		const auth = request.headers.get('Authorization');
		if (auth !== `Bearer ${env.API_KEY}`) {
			return Response.json({ error: 'Unauthorized' }, { status: 401, headers: corsHeaders(env) });
		}

		if (pathname === '/upload-html') {
			return handleSingleFileClipRequest(request, env);
		}
		return handleJsonClipRequest(request, env);
	},
};

export default worker;

export { isValidUrl } from './utils.js';
export { extractTitle, cleanJinaBody, stripEmptyLinks } from './jina.js';
export { makeSlug, buildNote } from './note.js';

async function handleImageProxy(request, env) {
	const fileId = new URL(request.url).searchParams.get('file_id');
	if (!fileId) {
		return Response.json({ error: 'Missing file_id' }, { status: 400 });
	}
	try {
		const fileInfo = await getFile(fileId, env);
		const fileRes = await fetch(fileInfo.file_url, { signal: AbortSignal.timeout(15000) });
		if (!fileRes.ok) {
			return Response.json({ error: 'Image fetch failed' }, { status: 502 });
		}
		return new Response(fileRes.body, {
			headers: {
				'Content-Type': fileRes.headers.get('Content-Type') || 'image/jpeg',
				'Cache-Control': 'public, max-age=86400',
			},
		});
	} catch (e) {
		return Response.json({ error: e.message }, { status: 502 });
	}
}

async function handleJsonClipRequest(request, env) {
	let reqBody;
	try {
		reqBody = await request.json();
	} catch {
		return Response.json({ error: 'Invalid JSON body' }, { status: 400, headers: corsHeaders(env) });
	}

	const url = reqBody.url;
	if (!url || typeof url !== 'string') {
		return Response.json({ error: "Missing 'url' field" }, { status: 400, headers: corsHeaders(env) });
	}
	if (!isValidUrl(url)) {
		return Response.json({ error: 'Invalid url (must be http or https)' }, { status: 400, headers: corsHeaders(env) });
	}

	try {
		const article = await fetchArticleFromUrl(url, env);
		return await clipArticle({
			requestUrl: request.url,
			article,
			env,
			clipMethod: normalizeClipMethod(request.headers.get('X-Clip-Method')),
		});
	} catch (e) {
		console.error('Jina fetch failed:', url, e.message);
		return Response.json({ error: `Jina error: ${e.message}` }, { status: 502, headers: corsHeaders(env) });
	}
}

async function handleSingleFileClipRequest(request, env) {
	try {
		const article = await parseSingleFileUpload(request);
		return await clipArticle({ requestUrl: request.url, article, env, clipMethod: 'singlefile' });
	} catch (e) {
		return Response.json({ error: e.message }, { status: 400, headers: corsHeaders(env) });
	}
}

async function clipArticle({ requestUrl, article, env, clipMethod = 'url' }) {
	let { title, url, markdownBody, sourceHtml } = article;
	const slug = makeSlug(title);
	const now = new Date();
	const yyyymm = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
	const timestamp = now
		.toISOString()
		.replace(/[-:]/g, '')
		.replace(/\.\d{3}Z$/, 'Z');
	const path = `${env.CLIP_FOLDER}/${yyyymm}/${timestamp}-${slug}.md`;

	if (sourceHtml) {
		const inlineImageMappings = await externalizeInlineImages({ requestUrl, sourceHtml, env });
		if (inlineImageMappings.length > 0) {
			for (const mapping of inlineImageMappings) {
				markdownBody = markdownBody.replaceAll(mapping.original, mapping.replacement);
				sourceHtml = sourceHtml.replaceAll(mapping.original, mapping.replacement);
			}
		}
	}

	let aiMetadata = null;
	if (env.AI_API_KEY) {
		try {
			aiMetadata = await generateAiMetadata({ title, url, body: markdownBody, env });
		} catch (e) {
			console.error('AI metadata generation failed:', e.message);
		}
	}
	const summary = aiMetadata?.summary || '';
	const tags = aiMetadata?.tags || [];
	const content = buildNote({
		title,
		url,
		date: now.toISOString(),
		body: markdownBody,
		summary,
		tags,
		clipMethod,
		clipCount: 1,
		lastClippedAt: now.toISOString(),
	});

	const telegraphEnabled = Boolean(
		env.TELEGRAPH_ACCESS_TOKEN && (env.CLIP_BOT || env.TELEGRAM_BOT_TOKEN) && (env.USER_ID || env.TELEGRAM_CHAT_ID)
	);
	const [fnsResult, telegraphResult] = await Promise.allSettled([
		writeToFns({ path, content, env, url, summary, tags, clipMethod, clippedAt: now }),
		telegraphEnabled
			? pushTelegraphAndTelegram({ requestUrl, articleUrl: url, title, cleanBody: markdownBody, sourceHtml, summary, tags, env })
			: Promise.resolve(null),
	]);

	const fnsOk = fnsResult.status === 'fulfilled';
	const telegraphOk = telegraphEnabled ? telegraphResult.status === 'fulfilled' : false;
	const telegraphData = telegraphEnabled && telegraphResult.status === 'fulfilled' ? telegraphResult.value : {};

	if (!fnsOk && (!telegraphEnabled || !telegraphOk)) {
		const fnsError = fnsResult.reason instanceof Error ? fnsResult.reason.message : String(fnsResult.reason || 'unknown error');
		if (!telegraphEnabled) {
			return Response.json({ error: `FNS failed: ${fnsError}` }, { status: 502, headers: corsHeaders(env) });
		}
		const telegraphError =
			telegraphResult.reason instanceof Error ? telegraphResult.reason.message : String(telegraphResult.reason || 'unknown error');
		return Response.json(
			{ error: `FNS failed: ${fnsError}; Telegraph failed: ${telegraphError}` },
			{ status: 502, headers: corsHeaders(env) }
		);
	}

	if (!fnsOk) {
		const fnsError = fnsResult.reason instanceof Error ? fnsResult.reason.message : String(fnsResult.reason || 'unknown error');
		console.error('FNS write failed:', path, fnsError);
	}

	if (telegraphEnabled && !telegraphOk) {
		const telegraphError =
			telegraphResult.reason instanceof Error ? telegraphResult.reason.message : String(telegraphResult.reason || 'unknown error');
		console.error('Telegraph/Telegram push failed:', telegraphError);
	}

	const fnsData = fnsOk ? fnsResult.value : null;
	console.log('Clipped:', title, '->', fnsData?.path || path, fnsData?.mode || 'created');
	return Response.json(
		{
			ok: true,
			title,
			fnsOk,
			mode: fnsOk ? fnsData.mode : undefined,
			path: fnsOk ? fnsData.path : undefined,
			telegraphOk,
			telegraphUrl: telegraphData.telegraphUrl || undefined,
			telegramMessageId: telegraphData.telegramMessageId || undefined,
		},
		{ headers: corsHeaders(env) }
	);
}

async function pushTelegraphAndTelegram({ requestUrl, articleUrl, title, cleanBody, sourceHtml, summary, tags, env }) {
	const uploadedHtml = sourceHtml ? prepareSourceHtmlForTelegraph(sourceHtml, articleUrl) : '';
	const fetchedHtml = uploadedHtml ? '' : await fetchSourceHtml(articleUrl);
	const telegraphHtmlSource = uploadedHtml || (fetchedHtml ? prepareSourceHtmlForTelegraph(fetchedHtml, articleUrl) : '');

	const imageItems =
		uploadedHtml || fetchedHtml
			? extractHtmlImageUrls(uploadedHtml || fetchedHtml, articleUrl)
			: extractImageUrls(cleanBody).map((imgUrl) => ({ raw: imgUrl, absolute: imgUrl }));

	const imageMappings = [];
	for (const imageItem of imageItems) {
		try {
			const imgUrl = imageItem.absolute;
			const imgRes = await fetch(imgUrl, { signal: AbortSignal.timeout(15000) });
			if (imgRes.ok) {
				const buffer = new Uint8Array(await imgRes.arrayBuffer());
				const uploadResult = await sendPhoto(buffer, 'image.jpg', env);
				imageMappings.push({ raw: imageItem.raw, absolute: imgUrl, file_id: uploadResult.file_id });
			}
		} catch (e) {
			console.error('Image upload failed:', imageItem.absolute, e.message);
		}
	}

	let telegraphHtml = telegraphHtmlSource;
	const publicBaseUrl = resolvePublicBaseUrl(requestUrl, env.PUBLIC_BASE_URL);
	if (publicBaseUrl) {
		for (const mapping of imageMappings) {
			const proxyUrl = `${publicBaseUrl}/image-proxy?file_id=${encodeURIComponent(mapping.file_id)}`;
			telegraphHtml = telegraphHtml.replaceAll(mapping.raw, proxyUrl).replaceAll(mapping.absolute, proxyUrl);
		}
	} else if (imageMappings.length > 0) {
		console.warn('Skip Telegraph image proxy replacement: no public base URL available');
	}

	const nodes = buildTelegraphNodes({ html: telegraphHtml, markdown: cleanBody, summary, tags });

	const pageResult = await createPage(title, nodes, env);
	const telegraphUrl = pageResult.url;

	const hostname = escapeHtml(getHostname(articleUrl));
	const sourceLink = escapeHtmlAttr(articleUrl);
	const summaryBlock = summary ? `\n\n${escapeHtml(summary)}` : '';
	const tagLine = formatTagLine(tags);
	const tagBlock = tagLine ? `\n\n${escapeHtml(tagLine)}` : '';
	const msgText = `${escapeHtml(telegraphUrl)}\n\n<b>${escapeHtml(
		title
	)}</b>${summaryBlock}\n\n<a href="${sourceLink}">${hostname}</a>${tagBlock}\n\n#webclipper`;
	const msgResult = await sendMessage(msgText, env.USER_ID || env.TELEGRAM_CHAT_ID, env, { linkPreviewUrl: telegraphUrl });
	const telegramMessageId = msgResult.message_id;

	console.log('Telegraph/Telegram pushed:', telegraphUrl, telegramMessageId);
	return { telegraphUrl, telegramMessageId };
}

async function externalizeInlineImages({ requestUrl, sourceHtml, env }) {
	const publicBaseUrl = resolvePublicBaseUrl(requestUrl, env.PUBLIC_BASE_URL);
	if (!publicBaseUrl) return [];

	const candidates = [];
	const seen = new Set();
	const regex = /data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g;
	let match;

	while ((match = regex.exec(sourceHtml)) !== null) {
		const dataUrl = match[0];
		if (seen.has(dataUrl)) continue;
		seen.add(dataUrl);
		if (dataUrl.startsWith('data:image/svg+xml')) continue;
		candidates.push(dataUrl);
		if (candidates.length >= MAX_SINGLEFILE_INLINE_IMAGES) break;
	}

	if (!candidates.length) return [];

	const tasks = candidates.map((dataUrl) => async () => {
		try {
			const uploadResult = await sendPhoto(dataUrlToBytes(dataUrl), 'singlefile-image', env);
			const proxyUrl = `${publicBaseUrl}/image-proxy?file_id=${encodeURIComponent(uploadResult.file_id)}`;
			return { original: dataUrl, replacement: proxyUrl };
		} catch (e) {
			console.error('Inline image upload failed:', e.message);
			return null;
		}
	});

	const mappings = await runWithConcurrency(tasks, INLINE_IMAGE_UPLOAD_CONCURRENCY);
	return mappings.filter(Boolean);
}

function dataUrlToBytes(dataUrl) {
	const commaIndex = dataUrl.indexOf(',');
	const base64 = commaIndex === -1 ? '' : dataUrl.slice(commaIndex + 1);
	return Uint8Array.from(Buffer.from(base64, 'base64'));
}

async function runWithConcurrency(tasks, concurrency) {
	const results = new Array(tasks.length);
	let nextIndex = 0;

	const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
		while (nextIndex < tasks.length) {
			const currentIndex = nextIndex;
			nextIndex += 1;
			results[currentIndex] = await tasks[currentIndex]();
		}
	});

	await Promise.all(workers);
	return results;
}

async function handleTelegramWebhook(request, env) {
	if (request.method !== 'POST') {
		return Response.json({ ok: true });
	}
	if (!isValidTelegramWebhookSecret(request, env)) {
		return Response.json({ ok: true });
	}

	let update;
	try {
		update = await request.json();
	} catch {
		return Response.json({ ok: true });
	}

	const message = update.message || update.edited_message;
	const chatId = message?.chat?.id;
	if (!message || !isAllowedTelegramUser(message, env)) {
		return Response.json({ ok: true });
	}

	const url = extractFirstUrlFromTelegramMessage(message);
	if (!url) {
		await notifyTelegramWebhookError(chatId, '请发送一个 http/https 网页链接。', env);
		return Response.json({ ok: true });
	}

	try {
		const article = await fetchArticleFromUrl(url, env);
		const clipUrl = new URL('/', request.url).toString();
		const response = await clipArticle({ requestUrl: clipUrl, article, env, clipMethod: 'telegram' });
		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(errorText.slice(0, 500));
		}
	} catch (e) {
		console.error('Telegram webhook clip failed:', e.message);
		await notifyTelegramWebhookError(chatId, `剪藏失败：${e.message}`, env);
	}

	return Response.json({ ok: true });
}

function isValidTelegramWebhookSecret(request, env) {
	const expected = String(env.TELEGRAM_WEBHOOK_SECRET || '').trim();
	if (!expected) return false;
	return request.headers.get('X-Telegram-Bot-Api-Secret-Token') === expected;
}

function isAllowedTelegramUser(message, env) {
	const allowed = String(env.USER_ID || env.TELEGRAM_CHAT_ID || '').trim();
	if (!allowed) return false;
	const fromId = String(message?.from?.id || '').trim();
	const chatId = String(message?.chat?.id || '').trim();
	return fromId === allowed || chatId === allowed;
}

function extractFirstUrlFromTelegramMessage(message) {
	const text = message?.text || message?.caption || '';
	const entities = [...(message?.entities || []), ...(message?.caption_entities || [])];
	for (const entity of entities) {
		if (entity.type === 'url') {
			const candidate = text.slice(entity.offset, entity.offset + entity.length);
			if (isValidUrl(candidate)) return candidate;
		}
		if (entity.type === 'text_link' && isValidUrl(entity.url)) return entity.url;
	}
	const match = text.match(/https?:\/\/[^\s<>()]+/i);
	if (!match) return '';
	return match[0].replace(/[\].,!?;:]+$/, '');
}

async function notifyTelegramWebhookError(chatId, message, env) {
	try {
		await sendMessage(escapeHtml(message), chatId, env);
	} catch (e) {
		console.error('Telegram webhook error notification failed:', e.message);
	}
}

function normalizeClipMethod(value) {
	return ['url', 'singlefile', 'telegram'].includes(value) ? value : 'url';
}

function resolvePublicBaseUrl(requestUrl, configuredBaseUrl) {
	const configured = normalizePublicBaseUrl(configuredBaseUrl);
	if (configured) return configured;
	return normalizePublicBaseUrl(requestUrl);
}

function normalizePublicBaseUrl(value) {
	if (!value) return null;
	try {
		const url = new URL(value);
		if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
		if (isPrivateHostname(url.hostname)) return null;
		return url.origin.replace(/\/$/, '');
	} catch {
		return null;
	}
}

function isPrivateHostname(hostname) {
	const host = String(hostname || '')
		.trim()
		.toLowerCase()
		.replace(/^\[|\]$/g, '');
	if (!host) return true;
	if (host === 'localhost' || host.endsWith('.localhost')) return true;
	if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
	if (!/^\d+\.\d+\.\d+\.\d+$/.test(host)) return false;
	const parts = host.split('.').map(Number);
	const [a, b] = parts;
	if (a === 10 || a === 127 || a === 0) return true;
	if (a === 169 && b === 254) return true;
	if (a === 172 && b >= 16 && b <= 31) return true;
	if (a === 192 && b === 168) return true;
	return false;
}

async function fetchSourceHtml(url) {
	try {
		const res = await fetch(url, {
			headers: {
				Accept: 'text/html,application/xhtml+xml',
				'User-Agent': 'Mozilla/5.0 (compatible; web-clipper/1.0)',
			},
			signal: AbortSignal.timeout(15000),
		});
		if (!res.ok) {
			console.warn('Source HTML fetch failed:', url, res.status);
			return '';
		}
		const contentType = res.headers.get('Content-Type') || '';
		if (contentType && !contentType.toLowerCase().includes('html')) {
			console.warn('Source HTML fetch skipped non-HTML response:', url, contentType);
			return '';
		}
		return await res.text();
	} catch (e) {
		console.warn('Source HTML fetch failed:', url, e.message);
		return '';
	}
}

function prepareSourceHtmlForTelegraph(html, baseUrl) {
	return absolutizeHtmlUrls(stripUnsafeHtml(html), baseUrl);
}

function stripUnsafeHtml(html) {
	return String(html || '')
		.replace(/<script\b[\s\S]*?<\/script>/gi, '')
		.replace(/<style\b[\s\S]*?<\/style>/gi, '')
		.replace(/<noscript\b[\s\S]*?<\/noscript>/gi, '');
}

function absolutizeHtmlUrls(html, baseUrl) {
	return String(html || '').replace(
		/\b(href|src)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'<>]+))/gi,
		(match, attr, wrapped, doubleQuoted, singleQuoted, unquoted) => {
			const raw = doubleQuoted ?? singleQuoted ?? unquoted ?? '';
			const absolute = resolveUrl(raw, baseUrl);
			if (!absolute) return match;
			const quote = wrapped.startsWith("'") ? "'" : '"';
			return `${attr}=${quote}${escapeHtmlAttr(absolute)}${quote}`;
		}
	);
}

function extractImageUrls(md) {
	const urls = [];
	const regex = /!\[.*?\]\((https?:\/\/[^\s)]+)\)/g;
	let match;
	while ((match = regex.exec(md)) !== null) {
		urls.push(match[1]);
	}
	return [...new Set(urls)];
}

function extractHtmlImageUrls(html, baseUrl) {
	const images = [];
	const seen = new Set();
	const regex = /<img\b[^>]*\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s"'<>]+))/gi;
	let match;
	while ((match = regex.exec(html)) !== null) {
		const raw = match[1] || match[2] || match[3] || '';
		const absolute = resolveUrl(raw, baseUrl);
		if (!absolute || seen.has(absolute)) continue;
		seen.add(absolute);
		images.push({ raw, absolute });
	}
	return images;
}
