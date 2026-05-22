import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendPhoto, sendMessage, getFile } from '../src/telegram.js';

const mockEnv = {
	TELEGRAM_BOT_TOKEN: '123456:ABCdefGHIjklMNOpqrSTUvwxyz',
	TELEGRAM_CHAT_ID: '-1001234567890',
};

const splitBotEnv = {
	IMG_BOT: '111111:IMGbotToken',
	TELEGRAM_CHAT_ID: '-1001234567890',
	CLIP_BOT: '222222:CLIPbotToken',
	USER_ID: '987654321',
};

let originalFetch;

beforeEach(() => {
	originalFetch = globalThis.fetch;
	globalThis.fetch = vi.fn();
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	vi.restoreAllMocks();
});

describe('sendPhoto', () => {
	it('模拟 Telegram 成功响应，验证返回结构正确', async () => {
		const mockResponse = {
			ok: true,
			result: {
				message_id: 42,
				photo: [
					{ file_id: 'small', file_unique_id: 'usmall', width: 100 },
					{ file_id: 'large_abc', file_unique_id: 'ularge', width: 800 },
				],
			},
		};
		globalThis.fetch.mockResolvedValueOnce(new Response(JSON.stringify(mockResponse), { status: 200 }));

		const buffer = new Uint8Array([1, 2, 3]);
		const result = await sendPhoto(buffer, 'test.png', mockEnv);

		expect(result).toEqual({
			file_id: 'large_abc',
			file_unique_id: 'ularge',
			message_id: 42,
		});

		// 验证请求 URL
		expect(globalThis.fetch).toHaveBeenCalledWith(
			`https://api.telegram.org/bot${mockEnv.TELEGRAM_BOT_TOKEN}/sendPhoto`,
			expect.objectContaining({ method: 'POST' }),
		);
	});

	it('使用 IMG_BOT 发送图片，验证图片链路不使用 CLIP_BOT', async () => {
		const mockResponse = {
			ok: true,
			result: {
				message_id: 43,
				photo: [{ file_id: 'img_large', file_unique_id: 'uimg', width: 800 }],
			},
		};
		globalThis.fetch.mockResolvedValueOnce(new Response(JSON.stringify(mockResponse), { status: 200 }));

		await sendPhoto(new Uint8Array([1, 2, 3]), 'test.png', splitBotEnv);

		expect(globalThis.fetch).toHaveBeenCalledWith(
			`https://api.telegram.org/bot${splitBotEnv.IMG_BOT}/sendPhoto`,
			expect.objectContaining({ method: 'POST' }),
		);
	});

	it('模拟 Telegram 返回 400，验证抛出错误', async () => {
		const mockResponse = {
			ok: false,
			error_code: 400,
			description: 'Bad Request: chat not found',
		};
		globalThis.fetch.mockResolvedValueOnce(new Response(JSON.stringify(mockResponse), { status: 400 }));

		const buffer = new Uint8Array([1, 2, 3]);
		await expect(sendPhoto(buffer, 'test.png', mockEnv)).rejects.toThrow(/sendPhoto failed/);
	});
});

describe('sendMessage', () => {
	it('模拟成功响应，验证 HTML parse_mode 被正确发送', async () => {
		const mockResponse = {
			ok: true,
			result: { message_id: 99 },
		};
		globalThis.fetch.mockResolvedValueOnce(new Response(JSON.stringify(mockResponse), { status: 200 }));

		const result = await sendMessage('<b>Hello</b> World', mockEnv.TELEGRAM_CHAT_ID, mockEnv);

		expect(result).toEqual({ message_id: 99 });

		// 验证请求体包含 parse_mode: HTML
		const callArgs = globalThis.fetch.mock.calls[0];
		const body = JSON.parse(callArgs[1].body);
		expect(body.parse_mode).toBe('HTML');
		expect(body.chat_id).toBe(mockEnv.TELEGRAM_CHAT_ID);
		expect(body.text).toBe('<b>Hello</b> World');
		expect(body.link_preview_options).toBeUndefined();
	});

	it('使用 CLIP_BOT 和 USER_ID 推送剪藏消息', async () => {
		const mockResponse = {
			ok: true,
			result: { message_id: 101 },
		};
		globalThis.fetch.mockResolvedValueOnce(new Response(JSON.stringify(mockResponse), { status: 200 }));

		await sendMessage('<b>Clip</b>', undefined, splitBotEnv);

		const callArgs = globalThis.fetch.mock.calls[0];
		expect(callArgs[0]).toBe(`https://api.telegram.org/bot${splitBotEnv.CLIP_BOT}/sendMessage`);
		const body = JSON.parse(callArgs[1].body);
		expect(body.chat_id).toBe(splitBotEnv.USER_ID);
		expect(body.text).toBe('<b>Clip</b>');
	});

	it('可传入 link_preview_options 强制 Telegraph 预览', async () => {
		const mockResponse = {
			ok: true,
			result: { message_id: 100 },
		};
		globalThis.fetch.mockResolvedValueOnce(new Response(JSON.stringify(mockResponse), { status: 200 }));

		await sendMessage('test', mockEnv.TELEGRAM_CHAT_ID, mockEnv, { linkPreviewUrl: 'https://telegra.ph/Test-05-21' });

		const callArgs = globalThis.fetch.mock.calls[0];
		const body = JSON.parse(callArgs[1].body);
		expect(body.link_preview_options).toEqual({
			is_disabled: false,
			url: 'https://telegra.ph/Test-05-21',
			prefer_large_media: true,
		});
	});

	it('模拟网络错误，验证抛出错误', async () => {
		globalThis.fetch.mockRejectedValueOnce(new Error('Network timeout'));

		await expect(sendMessage('test', mockEnv.TELEGRAM_CHAT_ID, mockEnv)).rejects.toThrow(/Network timeout/);
	});
});

describe('getFile', () => {
	it('模拟成功响应，验证 file_url 格式正确', async () => {
		const mockResponse = {
			ok: true,
			result: {
				file_id: 'abc123',
				file_unique_id: 'uniq456',
				file_size: 12345,
				file_path: 'photos/file_1.jpg',
			},
		};
		globalThis.fetch.mockResolvedValueOnce(new Response(JSON.stringify(mockResponse), { status: 200 }));

		const result = await getFile('abc123', mockEnv);

		expect(result.file_path).toBe('photos/file_1.jpg');
		expect(result.file_url).toBe(`https://api.telegram.org/file/bot${mockEnv.TELEGRAM_BOT_TOKEN}/photos/file_1.jpg`);
	});

	it('使用 IMG_BOT 获取文件信息，验证图片代理链路不使用 CLIP_BOT', async () => {
		const mockResponse = {
			ok: true,
			result: { file_path: 'photos/file_2.jpg' },
		};
		globalThis.fetch.mockResolvedValueOnce(new Response(JSON.stringify(mockResponse), { status: 200 }));

		const result = await getFile('abc456', splitBotEnv);

		expect(globalThis.fetch).toHaveBeenCalledWith(`https://api.telegram.org/bot${splitBotEnv.IMG_BOT}/getFile?file_id=abc456`);
		expect(result.file_url).toBe(`https://api.telegram.org/file/bot${splitBotEnv.IMG_BOT}/photos/file_2.jpg`);
	});

	it('模拟 file_id 无效，验证抛出错误', async () => {
		const mockResponse = {
			ok: false,
			error_code: 400,
			description: 'Bad Request: file_id must be provided',
		};
		globalThis.fetch.mockResolvedValueOnce(new Response(JSON.stringify(mockResponse), { status: 200 }));

		await expect(getFile('invalid', mockEnv)).rejects.toThrow(/getFile failed/);
	});
});
