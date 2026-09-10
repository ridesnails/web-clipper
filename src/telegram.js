// Telegram Bot API 封装
import { fetchWithTimeout, withRetry } from './http.js';

const TG_TIMEOUT_MS = 15000;

function resolveImageBotToken(env) {
	return env.IMG_BOT || env.TELEGRAM_BOT_TOKEN;
}

function resolveImageChatId(env) {
	return env.IMG_CHAT_ID || env.TELEGRAM_CHAT_ID;
}

function resolveClipBotToken(env) {
	return env.CLIP_BOT || env.TELEGRAM_BOT_TOKEN;
}

function resolveClipChatId(chatId, env) {
	return chatId || env.USER_ID || env.TELEGRAM_CHAT_ID;
}

/**
 * 通过 multipart/form-data 发送图片到 Telegram 频道/群组
 * @param {ArrayBuffer|Uint8Array} fileBuffer - 图片二进制数据
 * @param {string} fileName - 文件名
 * @param {object} env - 环境变量，需包含 IMG_BOT 和 TELEGRAM_CHAT_ID（兼容旧 TELEGRAM_BOT_TOKEN）
 * @returns {Promise<{file_id: string, file_unique_id: string, message_id: number}>}
 */
export async function sendPhoto(fileBuffer, fileName, env) {
	const formData = new FormData();
	formData.append('chat_id', resolveImageChatId(env));
	const blob = new Blob([fileBuffer], { type: 'image/jpeg' });
	formData.append('photo', blob, fileName);

	const res = await fetchWithTimeout(
		`https://api.telegram.org/bot${resolveImageBotToken(env)}/sendPhoto`,
		{
			method: 'POST',
			body: formData,
		},
		{ timeoutMs: TG_TIMEOUT_MS, retries: 0 }
	);

	if (!res.ok) {
		const err = await res.json().catch(() => ({}));
		throw new Error(`Telegram sendPhoto failed: ${err.description || res.status}`);
	}

	const data = await res.json();
	if (!data.ok) {
		throw new Error(`Telegram sendPhoto failed: ${data.description}`);
	}

	const photos = data.result.photo;
	const largest = photos[photos.length - 1];
	return {
		file_id: largest.file_id,
		file_unique_id: largest.file_unique_id,
		message_id: data.result.message_id,
	};
}

/**
 * 带重试的 sendPhoto——专门处理 Telegram 429 限流
 * - 429 时指数退避：1s → 2s → 4s → 8s（最多 4 次重试）
 * - 其他网络错误也重试，但有总超时限制（~30s）
 * @param {ArrayBuffer|Uint8Array} fileBuffer - 图片二进制数据
 * @param {string} fileName - 文件名
 * @param {object} env - 环境变量
 * @param {{maxRetries?: number}} [options] - 重试选项
 * @returns {Promise<{file_id: string, file_unique_id: string, message_id: number}>}
 */
export async function sendPhotoWithRetry(fileBuffer, fileName, env, { maxRetries = 4 } = {}) {
	let lastError;

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		try {
			return await sendPhoto(fileBuffer, fileName, env);
		} catch (e) {
			lastError = e;

			// Telegram 429 限流，指数退避
			if (e.message && e.message.includes('429') && attempt < maxRetries) {
				const delay = 1000 * Math.pow(2, attempt); // 1s, 2s, 4s, 8s
				console.warn('Telegram 429 rate limit, retrying in ' + delay + 'ms (attempt ' + (attempt + 1) + '/' + (maxRetries + 1) + ')');
				await new Promise(r => setTimeout(r, delay));
				continue;
			}

			// 其他错误也重试，但有基础延迟
			if (attempt < maxRetries) {
				console.warn('Telegram sendPhoto error (attempt ' + (attempt + 1) + '/' + (maxRetries + 1) + '): ' + e.message);
				await new Promise(r => setTimeout(r, 1000)); // 1s 基础延迟
				continue;
			}
		}
	}

	throw lastError;
}

/**
 * 发送 HTML 格式文本消息到 Telegram 频道/群组
 * @param {string} text - 消息文本（支持 HTML）
 * @param {string} chatId - 目标聊天 ID
 * @param {object} env - 环境变量，需包含 CLIP_BOT（兼容旧 TELEGRAM_BOT_TOKEN）
 * @param {{linkPreviewUrl?: string}=} options - 可选消息参数
 * @returns {Promise<{message_id: number}>}
 */
export async function sendMessage(text, chatId, env, options = {}) {
	const payload = {
		chat_id: resolveClipChatId(chatId, env),
		text,
		parse_mode: 'HTML',
		disable_web_page_preview: false,
	};
	if (options.linkPreviewUrl) {
		payload.link_preview_options = {
			is_disabled: false,
			url: options.linkPreviewUrl,
			prefer_large_media: true,
		};
	}
	const res = await fetchWithTimeout(
		`https://api.telegram.org/bot${resolveClipBotToken(env)}/sendMessage`,
		{
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload),
		},
		{ timeoutMs: TG_TIMEOUT_MS, retries: 0 }
	);

	if (!res.ok) {
		const err = await res.json().catch(() => ({}));
		throw new Error(`Telegram sendMessage failed: ${err.description || res.status}`);
	}

	const data = await res.json();
	if (!data.ok) {
		throw new Error(`Telegram sendMessage failed: ${data.description}`);
	}

	return { message_id: data.result.message_id };
}

/**
 * 调用 getFile API 获取 Telegram 文件信息
 * @param {string} fileId - Telegram 文件 ID
 * @param {object} env - 环境变量，需包含 IMG_BOT（兼容旧 TELEGRAM_BOT_TOKEN）
 * @returns {Promise<{file_path: string, file_url: string}>}
 */
export async function getFile(fileId, env) {
	const res = await fetchWithTimeout(
		`https://api.telegram.org/bot${resolveImageBotToken(env)}/getFile?file_id=${encodeURIComponent(fileId)}`,
		{},
		{ timeoutMs: TG_TIMEOUT_MS, retries: 0 }
	);

	if (!res.ok) {
		const err = await res.json().catch(() => ({}));
		throw new Error(`Telegram getFile failed: ${err.description || res.status}`);
	}

	const data = await res.json();
	if (!data.ok) {
		throw new Error(`Telegram getFile failed: ${data.description || 'invalid file_id'}`);
	}

	const filePath = data.result.file_path;
	return {
		file_path: filePath,
		file_url: `https://api.telegram.org/file/bot${resolveImageBotToken(env)}/${filePath}`,
	};
}
