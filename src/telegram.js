// Telegram Bot API 封装
// 注：此为占位实现，供测试使用。真实实现由 backend-dev teammate 提供。

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

	const res = await fetch(`https://api.telegram.org/bot${resolveImageBotToken(env)}/sendPhoto`, {
		method: 'POST',
		body: formData,
	});

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
	const res = await fetch(`https://api.telegram.org/bot${resolveClipBotToken(env)}/sendMessage`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(payload),
	});

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
	const res = await fetch(`https://api.telegram.org/bot${resolveImageBotToken(env)}/getFile?file_id=${encodeURIComponent(fileId)}`);

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
