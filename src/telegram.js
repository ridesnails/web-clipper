// Telegram Bot API 封装
// 注：此为占位实现，供测试使用。真实实现由 backend-dev  teammate 提供。

/**
 * 发送图片到 Telegram 频道/群组
 * @param {ArrayBuffer|Uint8Array} fileBuffer - 图片二进制数据
 * @param {string} fileName - 文件名
 * @param {object} env - 环境变量，需包含 TELEGRAM_BOT_TOKEN 和 TELEGRAM_CHAT_ID
 * @returns {Promise<{file_id: string, file_unique_id: string, message_id: number}>}
 */
export async function sendPhoto(fileBuffer, fileName, env) {
	const formData = new FormData();
	formData.append('chat_id', env.TELEGRAM_CHAT_ID);
	formData.append('photo', new Blob([fileBuffer]), fileName);

	const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendPhoto`, {
		method: 'POST',
		body: formData,
	});

	if (!res.ok) {
		const err = await res.json().catch(() => ({}));
		throw new Error(`Telegram sendPhoto failed: ${err.description || res.status}`);
	}

	const data = await res.json();
	return {
		file_id: data.result.photo.at(-1).file_id,
		file_unique_id: data.result.photo.at(-1).file_unique_id,
		message_id: data.result.message_id,
	};
}

/**
 * 发送文本消息到 Telegram 频道/群组
 * @param {string} text - 消息文本（支持 HTML）
 * @param {string} chatId - 目标聊天 ID
 * @param {object} env - 环境变量，需包含 TELEGRAM_BOT_TOKEN
 * @returns {Promise<{message_id: number}>}
 */
export async function sendMessage(text, chatId, env) {
	const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			chat_id: chatId,
			text,
			parse_mode: 'HTML',
		}),
	});

	if (!res.ok) {
		const err = await res.json().catch(() => ({}));
		throw new Error(`Telegram sendMessage failed: ${err.description || res.status}`);
	}

	const data = await res.json();
	return { message_id: data.result.message_id };
}

/**
 * 获取 Telegram 文件信息
 * @param {string} fileId - 文件 ID
 * @param {object} env - 环境变量，需包含 TELEGRAM_BOT_TOKEN
 * @returns {Promise<{file_path: string, file_url: string}>}
 */
export async function getFile(fileId, env) {
	const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${encodeURIComponent(fileId)}`);

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
		file_url: `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${filePath}`,
	};
}
