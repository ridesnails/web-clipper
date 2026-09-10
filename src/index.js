import { sendPhoto, sendMessage, getFile } from './telegram.js';
import { signParam, verifyParam, timingSafeEqualStrings } from './signing.js';
import { isPrivateHostname, isSsrfSafeUrl } from './ssrf.js';
import { parseSingleFileUpload } from './singlefile.js';
import { buildTelegraphNodes, createPage, editPage, TelegraphPageNotFoundError } from './telegraph.js';
import { getClipRecord, putClipRecord } from './idempotency.js';
import { acquireClipLock, waitForConcurrentClip, releaseClipLock } from './clip-lock.js';
import { fetchArticleFromUrl, extractTitle, cleanJinaBody, stripEmptyLinks } from './jina.js';
import { extractArticleViaChain } from './extractor-chain.js';
import { writeToFns, fetchFnsFileContent, saveFileToFns } from './fns.js';
import { makeSlug, buildNote } from './note.js';
import { generateAiMetadata } from './ai.js';
import { isValidUrl, escapeHtml, escapeHtmlAttr, getHostname, resolveUrl, formatTagLine, chinaYearMonth } from './utils.js';
import { registerClipHandler } from './clip-workflow.js';

// Durable Object classes must be exported from the worker entry to receive bindings.
export { ClipLock } from './clip-lock.js';
// Workflow classes must be exported from the worker entry to receive bindings (wrangler 会在启动时校验).
export { ClipWorkflow } from './clip-workflow.js';

// 阶段四C：把剪藏主体注册给异步 Workflow（函数声明已提升，顶层注册安全）。
registerClipHandler(performJsonClip);

// 图片上限配置：从环境变量读取，默认 6 张（兼容原有行为）
// 可通过 IMG_MAX_IMAGES 调整，无需改代码重新部署
const MAX_SINGLEFILE_INLINE_IMAGES = Number(env.IMG_MAX_IMAGES || 6);
// 图片上传并发配置：从环境变量读取，默认 3  concurrent
const INLINE_IMAGE_UPLOAD_CONCURRENCY = Number(env.IMG_UPLOAD_CONCURRENCY || 3);

function corsHeaders(env) {
	return {
		'Access-Control-Allow-Origin': env.CORS_ORIGIN || '*',
		'Access-Control-Allow-Methods': 'POST, OPTIONS',
		'Access-Control-Allow-Headers': 'Authorization, Content-Type',
	};
}

/** 统一错误响应格式
 * @param {string} message - 错误描述
 * @param {string} [code] - rejection_code，客户端可据此决定重试策略
 * @param {number} [status=400] - HTTP 状态码
 * @returns {Response}
 */
function jsonError(message, code, status = 400) {
	const body = { error: message };
	if (code) {
		body.rejection_code = code;
	}
	return new Response(JSON.stringify(body), {
		status,
		headers: corsHeaders(env),
	});
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

		if (pathname === '/html-view') {
			return handleHtmlView(request, env);
		}

		if (pathname === '/telegram-webhook') {
			return handleTelegramWebhook(request, env);
		}

		if (pathname === '/health' && request.method === 'GET') {
			return handleHealthRequest(request, env);
		}

		if (pathname === '/clip-status' && request.method === 'GET') {
			return handleClipStatusRequest(request, env);
		}

		if (request.method === 'OPTIONS') {
			return new Response(null, { status: 204, headers: corsHeaders(env) });
		}

		if (request.method !== 'POST') {
			return jsonError("Method not allowed. Use POST.", "method-not-allowed", 405);
		}

		const auth = request.headers.get('Authorization') || '';
		if (!env.API_KEY) {
			// Fail closed: an unset API_KEY would otherwise accept "Bearer undefined".
			return jsonError("Server auth not configured (set API_KEY)", "auth-not-configured", 500);
		}
		if (!timingSafeEqualStrings(auth, `Bearer ${env.API_KEY}`)) {
			return jsonError("Unauthorized", "unauthorized", 401);
		}

		if (pathname === '/upload-html') {
			return handleSingleFileClipRequest(request, env);
		}
		if (pathname === '/save-md') {
			return handleSaveMdRequest(request, env);
		}
		if (pathname === '/json-async') {
			return handleAsyncClipRequest(request, env);
		}
		return handleJsonClipRequest(request, env);
	},
};

export default worker;

export { isValidUrl } from './utils.js';
export { extractTitle, cleanJinaBody, stripEmptyLinks } from './jina.js';
export { makeSlug, buildNote } from './note.js';

async function handleImageProxy(request, env) {
	const requestUrl = new URL(request.url);
	const fileId = requestUrl.searchParams.get('file_id');
	if (!fileId) {
		return Response.json({ error: 'Missing file_id' }, { status: 400 });
	}
	if (!(await verifyParam(fileId, requestUrl.searchParams.get('sig') || '', env))) {
		return Response.json({ error: 'Invalid or missing signature' }, { status: 403 });
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
		return jsonError("Invalid JSON body", "invalid-json-body", 400);
	}
	return performJsonClip(reqBody, request.url, env, request.headers.get('X-Clip-Method'));
}

// 同步 /json 与异步 /json-async（Workflow step 内）共用的剪藏主体。
// requestUrl 是原始请求 URL 字符串（Workflow 里没有真实 Request 对象），
// clipMethodHeader 来自 X-Clip-Method（异步路径从 requestBody.clipMethod 透传）。
async function performJsonClip(reqBody, requestUrl, env, clipMethodHeader) {
	const url = reqBody.url;
	if (!url || typeof url !== 'string') {
		return jsonError("Missing url field", "missing-url-field", 400);
	}
	if (!isValidUrl(url)) {
		return jsonError("Invalid url (must be http or https)", "invalid-url", 400);
	}

	try {
		const article = await extractArticleViaChain(url, env, {
			targetSelector: reqBody.targetSelector,
			waitForSelector: reqBody.waitForSelector,
		});
		return await clipArticle({
			requestUrl,
			article,
			env,
			clipMethod: normalizeClipMethod(clipMethodHeader),
		});
	} catch (e) {
		console.error('Jina fetch failed:', url, e.message);
		return jsonError("Source fetch failed", "jina-fetch-failed", 502);
	}
}

// 阶段四C：异步剪藏入口——把请求体投进 Workflow，立刻 202，不等剪藏结果。
// 明显坏的请求（缺/坏 url）在入队前就拒绝，不烧 Workflow 配额。
async function handleAsyncClipRequest(request, env) {
	const workflow = env.CLIP_WORKFLOW;
	if (!workflow || typeof workflow.create !== 'function') {
		return jsonError("Async clip not available (CLIP_WORKFLOW binding missing)", "async-not-available", 501);

	}

	let reqBody;
	try {
		reqBody = await request.json();
	} catch {
		return jsonError("Invalid JSON body", "invalid-json-body", 400);
	}

	const url = reqBody.url;
	if (!url || typeof url !== 'string' || !isValidUrl(url)) {
		return jsonError("Missing or invalid url field", "missing-invalid-url", 400);

	}

	const instance = await workflow.create({
		// 2026-09-10 prod 取证：params 传对象（官方契约），run() 侧 event.payload 即此对象。
		// 旧版误传 [{}] 数组 → payload.requestBody undefined → step 'undefined.url' 反复重试。
		params: {
			requestBody: reqBody,
			requestUrl: request.url,
			// Workflow 里没有 headers；X-Clip-Method 的异步等价物放 body 里。
			clipMethodHeader: reqBody.clipMethod || '',
		},
	});

	return Response.json(
		{ ok: true, workflowId: instance.id, statusUrl: `/clip-status?id=${encodeURIComponent(instance.id)}` },
		{ status: 202, headers: corsHeaders(env) },
	);
}

// 阶段四C：异步剪藏状态轮询。挂在外圈路由（GET 不走 POST 门禁），自带同款 Bearer 校验。
async function handleClipStatusRequest(request, env) {
	const requestUrl = new URL(request.url);
	const id = requestUrl.searchParams.get('id');
	if (!id) {
		return jsonError("Missing id param", "missing-id-param", 400);
	}

	const auth = request.headers.get('Authorization') || '';
	if (!env.API_KEY) {
		// Fail closed: an unset API_KEY would otherwise accept "Bearer undefined".
		return jsonError("Server auth not configured (set API_KEY)", "auth-not-configured", 500);
	}
	if (!timingSafeEqualStrings(auth, `Bearer ${env.API_KEY}`)) {
		return jsonError("Unauthorized", "unauthorized", 401);
	}

	const workflow = env.CLIP_WORKFLOW;
	if (!workflow || typeof workflow.get !== 'function') {
		return jsonError("Async clip not available (CLIP_WORKFLOW binding missing)", "async-not-available", 501);

	}

	try {
		// 2026-09-10 prod 取证：binding 的 get() 返回 Promise，必须 await——
		// 漏 await 时 instance 是没有 status() 的 Promise，会误走下面的守卫并给出错误文案。
		const instance = await workflow.get(id);
		if (!instance || typeof instance.status !== 'function') {
			// 真实 Workers runtime 的 instance 恒有 status()；此守卫兜住异常 binding。
			return Response.json(
				{
					workflowId: id,
					status: 'errored',
					error: 'workflow status() unavailable on this instance/runtime (unexpected)',
				},
				{ headers: corsHeaders(env) },
			);
		}
		const status = await instance.status();
		const out = { workflowId: id, status: status.status };
		if (status.status === 'complete' && status.output) {
			// run() 的返回值 = step 结果 { status, body }。
			out.result = status.output;
		} else if (status.status === 'errored') {
			out.error = status.error?.message || 'workflow errored';
		}
		return Response.json(out, { headers: corsHeaders(env) });
	} catch (e) {
		// 本地/远端对不存在的 id 都会炸（instance.not_found）。
		return jsonError("instance not found", "instance-not-found", 404);

	}
}

async function handleSingleFileClipRequest(request, env) {
	try {
		const article = await parseSingleFileUpload(request);
		return await clipArticle({ requestUrl: request.url, article, env, clipMethod: 'singlefile' });
	} catch (e) {
		return jsonError("Invalid request body", "invalid-request-body", 400);
	}
}

async function handleSaveMdRequest(request, env) {
	let body;
	try {
		body = await request.json();
	} catch {
		return jsonError("Invalid JSON body", "invalid-json-body", 400);
	}

	const title = String(body.title || '').trim();
	const content = String(body.content || '').trim();
	if (!title) return jsonError("Missing title field", "missing-title-field", 400);
	if (!content) return jsonError("Missing content field", "missing-content-field", 400);

	const conversationId = String(body.conversation_id || '').trim();
	const extraTags = Array.isArray(body.tags) ? body.tags.map(String).filter(Boolean) : [];
	const html = String(body.html || '').trim();

	const slug = makeSlug(title);
	const now = new Date();
	const yyyymm = chinaYearMonth(now);
	const timestamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
	const convUrl = conversationId ? `ai://conv/${conversationId}` : `ai://conv/${timestamp}`;

	let markdownBody = content;
	const extraResponseFields = {};

	if (html) {
		const htmlPath = `${env.CLIP_FOLDER}/${yyyymm}/${timestamp}-${slug}.html`;
		const publicBaseUrl = resolvePublicBaseUrl(request.url, env.PUBLIC_BASE_URL);
		const htmlViewSig = await signParam(htmlPath, env);
		const htmlViewUrl = publicBaseUrl
			? `${publicBaseUrl}/html-view?path=${encodeURIComponent(htmlPath)}&sig=${htmlViewSig}`
			: '';

		try {
			await saveFileToFns({ path: htmlPath, content: html, env });
			extraResponseFields.htmlPath = htmlPath;
			if (htmlViewUrl) {
				extraResponseFields.htmlViewUrl = htmlViewUrl;
				markdownBody = `${content}\n\n---\n\n[🌐 查看 HTML 渲染版本](${htmlViewUrl})`;
			}
		} catch (e) {
			console.error('HTML file save failed:', htmlPath, e.message);
		}
	}

	return clipArticle({
		requestUrl: request.url,
		article: { title, url: convUrl, markdownBody, sourceHtml: '' },
		env,
		clipMethod: 'markdown',
		extraTags,
		extraResponseFields,
	});
}

async function handleHtmlView(request, env) {
	const requestUrl = new URL(request.url);
	const path = requestUrl.searchParams.get('path');
	if (!path) {
		return new Response('Missing path parameter', { status: 400, headers: { 'Content-Type': 'text/plain' } });
	}
	if (!(await verifyParam(path, requestUrl.searchParams.get('sig') || '', env))) {
		return new Response('Invalid or missing signature', { status: 403, headers: { 'Content-Type': 'text/plain' } });
	}
	try {
		const content = await fetchFnsFileContent({ path, env });
		return new Response(content, {
			headers: {
				'Content-Type': 'text/html; charset=utf-8',
				'Cache-Control': 'public, max-age=3600',
				'X-Content-Type-Options': 'nosniff',
			},
		});
	} catch (e) {
		return new Response(`Not found: ${e.message}`, { status: 404, headers: { 'Content-Type': 'text/plain' } });
	}
}

async function clipArticle({ requestUrl, article, env, clipMethod = 'url', extraTags = [], extraResponseFields = {} }) {
	let { title, url, markdownBody, sourceHtml } = article;
	const slug = makeSlug(title);
	const now = new Date();
	const yyyymm = chinaYearMonth(now);
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
	const tags = [...new Set([...extraTags, ...(aiMetadata?.tags || [])])];
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
	// DO 互斥锁（阶段四B）：并发两次剪同 URL 时，后到者未获锁 → 轮询 KV 等持锁者落记录
	// （=对方已完成双写），随后仍走下方"已有记录"路径更新，消除 KV 最终一致窗口里的
	// 双 createPage 竞态。无 CLIP_LOCK 绑定 / DO 异常 → 静默降级为无锁（与旧版一致）；
	// 等待超时 → 降级直接剪藏（宁重复勿阻塞）；持锁方崩溃由 90s TTL 兜底。
	const clipLock = await acquireClipLock(url, env);
	// 幂等：读 KV 里该 URL 的剪藏记录（url → {fnsPath, telegraphPath, telegraphUrl}）。
	// 有 telegraphPath 则本轮走 editPage 更新原页，而不是 createPage 造重复页。
	// CLIP_KV 未绑定或记录不存在时返回 null，行为与旧版完全一致。
	// 等待侧拿到的记录同源（都是 KV），后续分支自动复用。
	let existingClipRecord;
	if (!clipLock || clipLock.granted) {
		existingClipRecord = await getClipRecord(url, env);
	} else {
		existingClipRecord = await waitForConcurrentClip(url, env);
	}

	const [fnsResult, telegraphResult] = await Promise.allSettled([
		writeToFns({ path, content, env, url, summary, tags, clipMethod, clippedAt: now }),
		telegraphEnabled
			? pushTelegraphAndTelegram({
					requestUrl,
					articleUrl: url,
					title,
					cleanBody: markdownBody,
					sourceHtml,
					summary,
					tags,
					env,
					existingRecord: existingClipRecord,
				})
			: Promise.resolve(null),
	]);

	const fnsOk = fnsResult.status === 'fulfilled';
	const telegraphOk = telegraphEnabled ? telegraphResult.status === 'fulfilled' : false;
	const telegraphData = telegraphEnabled && telegraphResult.status === 'fulfilled' ? telegraphResult.value : {};

	if (!fnsOk && (!telegraphEnabled || !telegraphOk)) {
		await releaseClipLock(clipLock, env);
		const fnsError = fnsResult.reason instanceof Error ? fnsResult.reason.message : String(fnsResult.reason || 'unknown error');
		if (!telegraphEnabled) {
			return jsonError("FNS failed", "fns-failed", 502);
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

	// 双写幂等记录：任一侧成功即落 KV（partial 记录），下次重试同 URL 就能补齐/更新另一侧。
	// writeToFns 的记录侧已自带按 URL 查重；这里主要供 Telegraph 的 editPage 路径使用。
	if (fnsOk || (telegraphEnabled && telegraphOk)) {
		await putClipRecord(
			url,
			{
				url,
				title,
				fnsPath: fnsOk ? fnsData?.path || path : existingClipRecord?.fnsPath || '',
				telegraphPath: telegraphData.telegraphPath || existingClipRecord?.telegraphPath || '',
				telegraphUrl: telegraphData.telegraphUrl || existingClipRecord?.telegraphUrl || '',
				updatedAt: now.toISOString(),
			},
			env
		);
	}

	await releaseClipLock(clipLock, env);
	// partial：请求里明确要的写（FNS 必算；Telegraph 仅在启用时算）任一失败 = true。
	// 状态码保持 200——已有写入成功就值得返回链接，客户端看 partial 决定是否重试补齐。
	const partial = !fnsOk || (telegraphEnabled && !telegraphOk);
	return Response.json(
		{
			ok: true,
			partial,
			title,
			fnsOk,
			mode: fnsOk ? fnsData.mode : undefined,
			path: fnsOk ? fnsData.path : undefined,
			telegraphOk,
			telegraphUrl: telegraphData.telegraphUrl || undefined,
			telegraphPath: telegraphData.telegraphPath || undefined,
			telegraphMode: telegraphData.telegraphMode || undefined,
			telegramMessageId: telegraphData.telegramMessageId || undefined,
			...extraResponseFields,
		},
		{ headers: corsHeaders(env) }
	);
}

async function pushTelegraphAndTelegram({ requestUrl, articleUrl, title, cleanBody, sourceHtml, summary, tags, env, existingRecord = null }) {
	const uploadedHtml = sourceHtml ? prepareSourceHtmlForTelegraph(sourceHtml, articleUrl) : '';
	const fetchedHtml = uploadedHtml ? '' : await fetchSourceHtml(articleUrl);
	const telegraphHtmlSource = uploadedHtml || (fetchedHtml ? prepareSourceHtmlForTelegraph(fetchedHtml, articleUrl) : '');

	const imageItems =
		uploadedHtml || fetchedHtml
			? extractHtmlImageUrls(uploadedHtml || fetchedHtml, articleUrl)
			: extractImageUrls(cleanBody).map((imgUrl) => ({ raw: imgUrl, absolute: imgUrl }));

	// Telegraph 路的图片上传与 inline 路共用并发上限（3）：串行循环在多图
	// 文章上会把整段剪藏拖到分钟级；runWithConcurrency 按下标保序返回。
	const imageTasks = imageItems.map((imageItem) => async () => {
		const imgUrl = imageItem.absolute;
		if (!isSsrfSafeUrl(imgUrl)) {
			console.warn('SSRF guard blocked article image fetch:', imgUrl);
			return null;
		}
		try {
			const imgRes = await fetch(imgUrl, { signal: AbortSignal.timeout(15000) });
			if (!imgRes.ok) return null;
			const buffer = new Uint8Array(await imgRes.arrayBuffer());
			const uploadResult = await sendPhotoWithRetry(buffer, 'image.jpg', env);
			return { raw: imageItem.raw, absolute: imgUrl, file_id: uploadResult.file_id };
		} catch (e) {
			console.error('Image upload failed:', imageItem.absolute, e.message);
			return null;
		}
	});
	const imageMappings = (await runWithConcurrency(imageTasks, INLINE_IMAGE_UPLOAD_CONCURRENCY)).filter(Boolean);

	let telegraphHtml = telegraphHtmlSource;
	const publicBaseUrl = resolvePublicBaseUrl(requestUrl, env.PUBLIC_BASE_URL);
	if (publicBaseUrl) {
		for (const mapping of imageMappings) {
			const proxySig = await signParam(mapping.file_id, env);
			const proxyUrl = `${publicBaseUrl}/image-proxy?file_id=${encodeURIComponent(mapping.file_id)}&sig=${proxySig}`;
			telegraphHtml = telegraphHtml.replaceAll(mapping.raw, proxyUrl).replaceAll(mapping.absolute, proxyUrl);
		}
	} else if (imageMappings.length > 0) {
		console.warn('Skip Telegraph image proxy replacement: no public base URL available');
	}

	const nodes = buildTelegraphNodes({
		html: telegraphHtml,
		markdown: cleanBody,
		summary,
		tags,
		sourceUrl: articleUrl,
	});

	// 幂等：KV 记录里有该 URL 的 Telegraph 页 → 编辑原页；仅当页面已消失（被手动删/记录过期，
	// API 返回 PAGE_NOT_FOUND）才回退新建，避免一次网络误判造成重复页。
	let pageResult = null;
	let telegraphMode = 'created';
	if (existingRecord?.telegraphPath) {
		try {
			pageResult = await editPage(existingRecord.telegraphPath, title, nodes, env);
			telegraphMode = 'updated';
		} catch (e) {
			if (!(e instanceof TelegraphPageNotFoundError)) throw e;
			console.warn('Telegraph page missing, fallback to createPage:', existingRecord.telegraphPath);
		}
	}
	if (!pageResult) {
		pageResult = await createPage(title, nodes, env);
	}
	const telegraphUrl = pageResult.url;

	const hostname = escapeHtml(getHostname(articleUrl));
	const sourceLink = escapeHtmlAttr(articleUrl);
	const summaryBlock = summary ? `\n\n${escapeHtml(summary)}` : '';
	const tagLine = formatTagLine(tags);
	const tagBlock = tagLine ? `\n\n${escapeHtml(tagLine)}` : '';
	const updateBlock = telegraphMode === 'updated' ? '\n\n🔄 内容已更新' : '';
	const msgText = `${escapeHtml(telegraphUrl)}\n\n<b>${escapeHtml(
		title
	)}</b>${summaryBlock}\n\n<a href="${sourceLink}">${hostname}</a>${tagBlock}${updateBlock}\n\n#webclipper`;
	const msgResult = await sendMessage(msgText, env.USER_ID || env.TELEGRAM_CHAT_ID, env, { linkPreviewUrl: telegraphUrl });
	const telegramMessageId = msgResult.message_id;

	console.log('Telegraph/Telegram pushed:', telegraphUrl, telegraphMode, telegramMessageId);
	return { telegraphUrl, telegramMessageId, telegraphMode, telegraphPath: pageResult.path };
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
			const uploadResult = await sendPhotoWithRetry(dataUrlToBytes(dataUrl), 'singlefile-image', env);
			const proxySig = await signParam(uploadResult.file_id, env);
			const proxyUrl = `${publicBaseUrl}/image-proxy?file_id=${encodeURIComponent(uploadResult.file_id)}&sig=${proxySig}`;
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

// /health：免鉴权只吐 {ok:true}（探活用，不泄露配置面）；
// 带正确 Bearer 才追加能力布尔 map——binding/env 存在性，不吐任何值。
// 放行在鉴权门之前（GET-only），防止“服务器没配 API_KEY 时连健康检查都 5xx”。
async function handleHealthRequest(request, env) {
	const base = { ok: true };
	const auth = request.headers.get('Authorization') || '';
	const authorized = Boolean(env.API_KEY) && timingSafeEqualStrings(auth, `Bearer ${env.API_KEY}`);
	if (!authorized) return Response.json(base);
	return Response.json({
		ok: true,
		capabilities: {
			fns: Boolean(env.FNS_BASE && env.FNS_VAULT && env.FNS_TOKEN),
			telegraph: Boolean(env.TELEGRAPH_ACCESS_TOKEN),
			telegramImg: Boolean(env.IMG_BOT || env.TELEGRAM_BOT_TOKEN),
			telegramClip: Boolean(env.CLIP_BOT || env.TELEGRAM_BOT_TOKEN),
			ai: Boolean(env.AI_API_KEY),
			kv: Boolean(env.CLIP_KV),
			browser: Boolean(env.BROWSER),
			defuddleFallback: env.DEFUDDLE_FALLBACK === 'true',
		},
	});
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
	return ['url', 'singlefile', 'telegram', 'markdown'].includes(value) ? value : 'url';
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

async function fetchSourceHtml(url) {
	if (!isSsrfSafeUrl(url)) {
		console.warn('SSRF guard blocked source HTML fetch:', url);
		return '';
	}
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
