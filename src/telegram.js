// Telegram Bot API 封装

/**
 * 通过 multipart/form-data 发送图片到 Telegram 频道
 * @param {Uint8Array} fileBuffer - 图片二进制数据
 * @param {string} fileName - 文件名
 * @param {object} env - 环境变量，包含 TELEGRAM_BOT_TOKEN 和 TELEGRAM_CHAT_ID
 * @returns {Promise<{file_id: string, file_unique_id: string, message_id: number}>}
 */
export async function sendPhoto(fileBuffer, fileName, env) {
	const formData = new FormData();
	formData.append('chat_id', env.TELEGRAM_CHAT_ID);
	const blob = new Blob([fileBuffer], { type: 'image/jpeg' });
	formData.append('photo', blob, fileName);

	const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendPhoto`, {
		method: 'POST',
		body: formData,
	});

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
 * 发送 HTML 格式消息
 * @param {string} text - 消息文本（HTML 格式）
 * @param {string} chatId - 目标聊天 ID
 * @param {object} env - 环境变量，包含 TELEGRAM_BOT_TOKEN
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
			disable_web_page_preview: false,
		}),
	});

	const data = await res.json();
	if (!data.ok) {
		throw new Error(`Telegram sendMessage failed: ${data.description}`);
	}

	return { message_id: data.result.message_id };
}

/**
 * 调用 getFile API 获取文件信息
 * @param {string} fileId - Telegram 文件 ID
 * @param {object} env - 环境变量，包含 TELEGRAM_BOT_TOKEN
 * @returns {Promise<{file_path: string, file_url: string}>}
 */
export async function getFile(fileId, env) {
	const res = await fetch(
		`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${encodeURIComponent(fileId)}`
	);
	const data = await res.json();
	if (!data.ok) {
		throw new Error(`Telegram getFile failed: ${data.description}`);
	}

	const filePath = data.result.file_path;
	const fileUrl = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${filePath}`;

	return { file_path: filePath, file_url: fileUrl };
}
