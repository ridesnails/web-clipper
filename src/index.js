import { sendPhoto, sendMessage, getFile } from './telegram.js';
import { createPage, htmlToTelegraphNodes } from './telegraph.js';

// CORS 响应头
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

		// 浏览器自动请求的 favicon.ico 直接返回 204，避免日志噪音
		if (pathname === '/favicon.ico') {
			return new Response(null, { status: 204 });
		}

		// Telegraph 图片代理：将 Telegram file_id 转为可直接访问的图片 URL
		if (pathname === '/image-proxy') {
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

		// Telegram Bot 剪藏入口：CLIP_BOT 收到链接后由 webhook 转入现有剪藏流程
		if (pathname === '/telegram-webhook') {
			return handleTelegramWebhook(request, env);
		}

		// 处理 CORS 预检请求
		if (request.method === 'OPTIONS') {
			return new Response(null, { status: 204, headers: corsHeaders(env) });
		}

		// HEAD、GET、PUT、DELETE 等不允许的方法统一返回 405
		if (request.method !== 'POST') {
			return Response.json({ error: 'Method not allowed. Use POST.' }, { status: 405, headers: corsHeaders(env) });
		}

		// —— 第一关：密码校验 ——
		const auth = request.headers.get('Authorization');
		if (auth !== `Bearer ${env.API_KEY}`) {
			return Response.json({ error: 'Unauthorized' }, { status: 401, headers: corsHeaders(env) });
		}

		// —— 第二关：解析 body ——
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

		// —— 第三关：用 jina 把网页转成 Markdown ——
		let markdown;
		try {
			const jinaHeaders = { Accept: 'text/plain' };
			// 如果配置了 JINA_API_KEY，则添加认证头
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
					signal: AbortSignal.timeout(25000), // 25 秒超时
				});
				if (jinaRes.ok) {
					break;
				}
				const errText = await jinaRes.text();
				lastErr = `${jinaRes.status} ${errText}`;
				console.error('Jina returned non-200:', url, jinaRes.status, errText);
				const shouldRetry = jinaRes.status === 429 || jinaRes.status >= 500;
				if (!shouldRetry || attempt === 2) {
					return Response.json({ error: `Jina fetch failed: ${lastErr}` }, { status: 502, headers: corsHeaders(env) });
				}
			}
			markdown = await jinaRes.text();
		} catch (e) {
			console.error('Jina fetch failed:', url, e.message);
			return Response.json({ error: `Jina error: ${e.message}` }, { status: 502, headers: corsHeaders(env) });
		}

		// —— 第四关：抽标题、清理正文、生成文件路径 ——
		const title = extractTitle(markdown) || 'untitled';
		const slug = makeSlug(title);
		const now = new Date();
		const yyyymm = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
		const timestamp = now
			.toISOString()
			.replace(/[-:]/g, '')
			.replace(/\.\d{3}Z$/, 'Z');
		const path = `${env.CLIP_FOLDER}/${yyyymm}/${timestamp}-${slug}.md`;

		// 剥掉 jina 的元信息头，拼带 frontmatter 的最终内容
		const cleanBody = stripEmptyLinks(cleanJinaBody(markdown));
		let aiMetadata = null;
		if (env.AI_API_KEY) {
			try {
				aiMetadata = await generateAiMetadata({ title, url, body: cleanBody, env });
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
			body: cleanBody,
			summary,
			tags,
		});

		// —— 第五关：写入 FNS ——
		try {
			const fnsRes = await fetch(`${env.FNS_BASE}/api/note`, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${env.FNS_TOKEN}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					vault: env.FNS_VAULT,
					path: path,
					content: content,
				}),
			});
			const fnsData = await fnsRes.json();
			if (!fnsData.status) {
				console.error('FNS write failed:', path, JSON.stringify(fnsData));
				return Response.json({ error: `FNS write failed: ${JSON.stringify(fnsData)}` }, { status: 502, headers: corsHeaders(env) });
			}
			// 在 FNS 成功之后，尝试 Telegraph + Telegram 推送
			let telegraphUrl = null;
			let telegramMessageId = null;

			if (env.TELEGRAPH_ACCESS_TOKEN && (env.CLIP_BOT || env.TELEGRAM_BOT_TOKEN) && (env.USER_ID || env.TELEGRAM_CHAT_ID)) {
				try {
					// 1. Telegraph 内容优先参考原始网页 HTML，而不是 Jina Markdown。
					const sourceHtml = await fetchSourceHtml(url);
					const telegraphHtmlSource = sourceHtml ? prepareSourceHtmlForTelegraph(sourceHtml, url) : markdownBodyToHtml(cleanBody);

					// 2. 从 HTML 中提取图片 URL；HTML 获取失败时降级提取 Markdown 图片。
					const imageItems = sourceHtml ? extractHtmlImageUrls(sourceHtml, url) : extractImageUrls(cleanBody).map((imgUrl) => ({ raw: imgUrl, absolute: imgUrl }));

					// 3. 下载每张图片并上传到 Telegram 频道，收集 file_id
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

					// 4. 替换图片 URL 为 Worker 代理链接，并补充 AI 摘要/标签
					let telegraphHtml = buildTelegraphHtml({ body: telegraphHtmlSource, summary, tags });
					const publicBaseUrl = resolvePublicBaseUrl(request.url, env.PUBLIC_BASE_URL);
					if (publicBaseUrl) {
						for (const mapping of imageMappings) {
							const proxyUrl = `${publicBaseUrl}/image-proxy?file_id=${encodeURIComponent(mapping.file_id)}`;
							telegraphHtml = telegraphHtml.replaceAll(mapping.raw, proxyUrl).replaceAll(mapping.absolute, proxyUrl);
						}
					} else if (imageMappings.length > 0) {
						console.warn('Skip Telegraph image proxy replacement: no public base URL available');
					}

					// 5. 转换 HTML 为 Telegraph Node 数组
					const nodes = htmlToTelegraphNodes(telegraphHtml);

					// 6. 创建 Telegraph 页面
					const pageResult = await createPage(title, nodes, env);
					telegraphUrl = pageResult.url;

					// 7. 发送 Telegram 消息
					const hostname = escapeHtml(getHostname(url));
					const sourceLink = escapeHtmlAttr(url);
					const summaryBlock = summary ? `\n\n${escapeHtml(summary)}` : '';
					const tagLine = formatTagLine(tags);
					const tagBlock = tagLine ? `\n\n${escapeHtml(tagLine)}` : '';
					const msgText = `${escapeHtml(telegraphUrl)}\n\n<b>${escapeHtml(title)}</b>${summaryBlock}\n\n<a href="${sourceLink}">${hostname}</a>${tagBlock}\n\n#webclipper`;
					const msgResult = await sendMessage(msgText, env.USER_ID || env.TELEGRAM_CHAT_ID, env, { linkPreviewUrl: telegraphUrl });
					telegramMessageId = msgResult.message_id;

					console.log('Telegraph/Telegram pushed:', telegraphUrl, telegramMessageId);
				} catch (e) {
					console.error('Telegraph/Telegram push failed:', e.message);
					// 推送失败不影响主流程
				}
			}

			console.log('Clipped:', title, '->', path);
			return Response.json(
				{
					ok: true,
					title: title,
					path: path,
					telegraphUrl: telegraphUrl || undefined,
					telegramMessageId: telegramMessageId || undefined,
				},
				{ headers: corsHeaders(env) },
			);
		} catch (e) {
			console.error('FNS write failed:', path, e.message);
			return Response.json({ error: `FNS error: ${e.message}` }, { status: 502, headers: corsHeaders(env) });
		}
	},
};

export default worker;

// —— 工具函数 ——

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
		const clipRequest = new Request(new URL('/', request.url), {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${env.API_KEY}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ url }),
		});
		const response = await worker.fetch(clipRequest, env);
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

// 检查 URL 是否合法且是 http/https
function isValidUrl(s) {
	try {
		const u = new URL(s);
		return u.protocol === 'http:' || u.protocol === 'https:';
	} catch {
		return false;
	}
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

// 从 jina 返回的 markdown 抽标题
// 1) 优先 "Title: xxx"，但要求非空且不是 URL
// 2) 否则找第一个 H1
// 3) 都没有就返回 null
function extractTitle(md) {
	const titleMatch = md.match(/^Title:\s*(.+)$/m);
	if (titleMatch) {
		const t = titleMatch[1].trim();
		if (t && !t.startsWith('http')) return t;
	}
	const h1Match = md.match(/^#\s+(.+)$/m);
	if (h1Match) return h1Match[1].trim();
	return null;
}

// 把任意字符串变成安全的文件名
function makeSlug(title) {
	return (
		title
			.replace(/[\/\\:*?"<>|#\[\]]/g, '') // 去掉文件系统和 Obsidian 不允许的字符
			.replace(/\s+/g, '-') // 空格 → 横线
			.replace(/-+/g, '-') // 多个横线合并
			.slice(0, 80) // 最长 80 字符
			.trim() || 'untitled'
	);
}

// 剥掉 jina 返回里的元信息头，只保留正文
// jina 通常的格式是：
//   Title: xxx
//   URL Source: xxx
//   Published Time: xxx
//   Markdown Content:
//   <空行>
//   <真正的正文>
function cleanJinaBody(md) {
	// 找 "Markdown Content:" 这个分界线，从它之后开始截
	const marker = /^Markdown Content:\s*$/m;
	const m = md.match(marker);
	if (m) {
		return md.slice(m.index + m[0].length).replace(/^\s+/, '');
	}
	// 没找到分界线就保守地剥掉开头几行已知的 jina 元信息
	return md
		.replace(/^Title:.*$/m, '')
		.replace(/^URL Source:.*$/m, '')
		.replace(/^Published Time:.*$/m, '')
		.replace(/^Markdown Content:.*$/m, '')
		.replace(/^\s+/, '');
}

// 拼带 frontmatter 的 markdown 文件
function buildNote({ title, url, date, body, summary, tags = [] }) {
	const safeTitle = yamlEscape(title);
	const normalizedBody = stripLeadingDuplicateTitle(body, title);
	const hostname = getHostname(url);
	const tagLine = formatTagLine(tags);
	const frontmatter = ['---', `title: "${safeTitle}"`, `url: ${url}`, `date: ${date}`, 'source: clipper'];
	if (tags.length > 0) {
		frontmatter.push('tags:');
		for (const tag of tags) {
			frontmatter.push(`  - ${yamlEscape(tag)}`);
		}
	}
	if (summary) {
		frontmatter.push(`summary: "${yamlEscape(summary)}"`);
	}
	frontmatter.push('---');

	const sections = [`# ${title}`, ''];
	if (summary) {
		sections.push('> [!abstract] ✨ 摘要', `> ${summary}`, '');
	}

	sections.push('> [!info] 📌 信息');
	if (hostname) sections.push(`> - **来源**：[${hostname}](${url})`);
	sections.push(`> - **时间**：${date}`);
	if (tagLine) sections.push(`> - **标签**：${tagLine}`);
	sections.push(`> - **链接**：[原文链接](${url})`, '');
	sections.push('## 📄 正文', '', normalizedBody);
	return [...frontmatter, '', ...sections].join('\n');
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
	return String(html || '').replace(/\b(href|src)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'<>]+))/gi, (match, attr, wrapped, doubleQuoted, singleQuoted, unquoted) => {
		const raw = doubleQuoted ?? singleQuoted ?? unquoted ?? '';
		const absolute = resolveUrl(raw, baseUrl);
		if (!absolute) return match;
		const quote = wrapped.startsWith("'") ? "'" : '"';
		return `${attr}=${quote}${escapeHtmlAttr(absolute)}${quote}`;
	});
}

function markdownBodyToHtml(markdown) {
	return String(markdown || '')
		.split(/\n{2,}/)
		.map((block) => {
			const trimmed = block.trim();
			if (!trimmed) return '';
			const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
			if (heading) return `<h3>${escapeHtml(heading[2])}</h3>`;
			const image = trimmed.match(/^!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)$/);
			if (image) return `<img src="${escapeHtmlAttr(image[1])}">`;
			return `<p>${escapeHtml(trimmed).replace(/\n/g, '<br>')}</p>`;
		})
		.filter(Boolean)
		.join('\n');
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

function getHostname(url) {
	try {
		return new URL(url).hostname;
	} catch {
		return String(url || '');
	}
}

function escapeHtmlAttr(str) {
	return escapeHtml(String(str || '')).replace(/"/g, '&quot;');
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

// 从 Markdown 中提取所有图片 URL
function extractImageUrls(md) {
	const urls = [];
	const regex = /!\[.*?\]\((https?:\/\/[^\s)]+)\)/g;
	let match;
	while ((match = regex.exec(md)) !== null) {
		urls.push(match[1]);
	}
	return [...new Set(urls)]; // 去重
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

function resolveUrl(value, baseUrl) {
	try {
		const url = new URL(String(value || '').trim(), baseUrl);
		if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
		return url.href;
	} catch {
		return '';
	}
}

function stripLeadingDuplicateTitle(body, title) {
	const normalizedTitle = normalizeComparableText(title);
	if (!normalizedTitle) return body;
	const match = body.match(/^(\s*#\s+(.+?)\s*)(?:\n+|$)/);
	if (!match) return body;
	if (normalizeComparableText(match[2]) !== normalizedTitle) return body;
	return body.slice(match[0].length).replace(/^\s+/, '');
}

function normalizeComparableText(str) {
	return String(str || '')
		.trim()
		.toLowerCase()
		.replace(/[\s\-–—_]+/g, ' ');
}

function yamlEscape(str) {
	return String(str).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// HTML 特殊字符转义（用于 Telegram HTML parse_mode）
function escapeHtml(str) {
	return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function parseAiJsonResponse(text) {
	const trimmed = String(text || '').trim();
	const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
	const jsonText = fenced ? fenced[1] : trimmed;
	const parsed = JSON.parse(jsonText);
	const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
	const tags = Array.isArray(parsed.tags) ? [...new Set(parsed.tags.map((tag) => String(tag).trim()).filter(Boolean))].slice(0, 8) : [];
	return { summary, tags };
}

async function generateAiMetadata({ title, url, body, env }) {
	if (!env.AI_API_KEY) return null;
	const baseUrl = (env.AI_BASE_URL || 'https://api.siliconflow.cn/v1').replace(/\/$/, '');
	const model = env.AI_MODEL || 'Qwen/Qwen3-8B';
	const prompt = [
		'请根据以下网页剪藏内容生成中文摘要和标签。',
		'要求：只返回 JSON，不要解释，不要 markdown 代码块。',
		'JSON 格式：{"summary":"不超过120字","tags":["标签1","标签2"]}',
		'标签要求：2到6个，简短，不带#。',
		`标题：${title}`,
		`原始链接：${url}`,
		'正文：',
		body.slice(0, 12000),
	].join('\n');
	const res = await fetch(`${baseUrl}/chat/completions`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${env.AI_API_KEY}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			model,
			temperature: 0.2,
			response_format: { type: 'json_object' },
			messages: [
				{ role: 'system', content: 'You generate concise article metadata in JSON.' },
				{ role: 'user', content: prompt },
			],
		}),
	});
	if (!res.ok) {
		const errText = await res.text();
		throw new Error(`AI metadata failed: ${res.status} ${errText}`);
	}
	const data = await res.json();
	const content = data?.choices?.[0]?.message?.content;
	if (!content) {
		throw new Error('AI metadata failed: empty response');
	}
	return parseAiJsonResponse(content);
}

export {
	isValidUrl,
	extractTitle,
	makeSlug,
	cleanJinaBody,
	buildNote,
	stripEmptyLinks,
	extractImageUrls,
	extractHtmlImageUrls,
	escapeHtml,
	buildTelegraphHtml,
	prepareSourceHtmlForTelegraph,
	markdownBodyToHtml,
};

// 过滤掉 Markdown 中空文本的链接（Jina 提取的 heading anchor links）
function stripEmptyLinks(md) {
	return md.replace(/\[(?:\s|\u200B)*\]\(https?:\/\/[^)]+\)/g, '');
}
