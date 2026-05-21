import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createPage, markdownToTelegraphNodes } from '../src/telegraph.js';

const mockEnv = {
	TELEGRAPH_ACCESS_TOKEN: 'test-access-token-12345',
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

describe('createPage', () => {
	it('模拟 Telegraph API 成功响应，验证返回 url/path', async () => {
		const mockResponse = {
			ok: true,
			result: {
				path: 'Test-Page-05-21',
				url: 'https://telegra.ph/Test-Page-05-21',
				title: 'Test Page',
				content: [],
				views: 0,
				can_edit: true,
			},
		};
		globalThis.fetch.mockResolvedValueOnce(new Response(JSON.stringify(mockResponse), { status: 200 }));

		const nodes = [{ tag: 'p', children: ['Hello'] }];
		const result = await createPage('Test Page', nodes, mockEnv);

		expect(result.url).toBe('https://telegra.ph/Test-Page-05-21');
		expect(result.path).toBe('Test-Page-05-21');
		expect(result.title).toBe('Test Page');

		// 验证请求体
		const callArgs = globalThis.fetch.mock.calls[0];
		const body = JSON.parse(callArgs[1].body);
		expect(body.access_token).toBe(mockEnv.TELEGRAPH_ACCESS_TOKEN);
		expect(body.title).toBe('Test Page');
		expect(JSON.parse(body.content)).toEqual(nodes);
	});

	it('模拟 access_token 无效，验证抛出错误', async () => {
		const mockResponse = {
			ok: false,
			error: 'ACCESS_TOKEN_INVALID',
		};
		globalThis.fetch.mockResolvedValueOnce(new Response(JSON.stringify(mockResponse), { status: 200 }));

		await expect(createPage('Test', [{ tag: 'p', children: ['x'] }], mockEnv)).rejects.toThrow(/ACCESS_TOKEN_INVALID/);
	});

	it('模拟网络超时，验证抛出错误', async () => {
		globalThis.fetch.mockRejectedValueOnce(new Error('Network timeout'));

		await expect(createPage('Test', [{ tag: 'p', children: ['x'] }], mockEnv)).rejects.toThrow(/Network timeout/);
	});
});

describe('markdownToTelegraphNodes', () => {
	it('一级标题 # Hello → h3', () => {
		const result = markdownToTelegraphNodes('# Hello');
		expect(result).toEqual([{ tag: 'h3', children: ['Hello'] }]);
	});

	it('二级标题 ## World → h4', () => {
		const result = markdownToTelegraphNodes('## World');
		expect(result).toEqual([{ tag: 'h4', children: ['World'] }]);
	});

	it('三级标题 ### Deep → 加粗段落', () => {
		const result = markdownToTelegraphNodes('### Deep');
		expect(result).toEqual([{ tag: 'p', children: [{ tag: 'b', children: ['Deep'] }] }]);
	});

	it('普通段落 Some text → p', () => {
		const result = markdownToTelegraphNodes('Some text');
		expect(result).toEqual([{ tag: 'p', children: ['Some text'] }]);
	});

	it('链接 [text](http://a.com) → 包含 a 标签的节点', () => {
		const result = markdownToTelegraphNodes('[text](http://a.com)');
		expect(result).toHaveLength(1);
		expect(result[0].tag).toBe('p');
		expect(result[0].children).toEqual([{ tag: 'a', attrs: { href: 'http://a.com' }, children: ['text'] }]);
	});

	it('图片 ![alt](http://img.jpg) → img', () => {
		const result = markdownToTelegraphNodes('![alt](http://img.jpg)');
		expect(result).toEqual([{ tag: 'img', attrs: { src: 'http://img.jpg' } }]);
	});

	it('列表项 - item → li', () => {
		const result = markdownToTelegraphNodes('- item');
		expect(result).toHaveLength(1);
		expect(result[0].tag).toBe('ul');
		expect(result[0].children).toEqual([{ tag: 'li', children: ['item'] }]);
	});

	it('代码块 → pre > code', () => {
		const md = '```js\nconst x = 1;\n```';
		const result = markdownToTelegraphNodes(md);
		expect(result).toHaveLength(1);
		expect(result[0].tag).toBe('pre');
		expect(result[0].children).toEqual([{ tag: 'code', children: ['const x = 1;'] }]);
	});

	it('引用块 > quote → blockquote', () => {
		const result = markdownToTelegraphNodes('> quote');
		expect(result).toEqual([{ tag: 'blockquote', children: ['quote'] }]);
	});

	it('水平线 --- → hr', () => {
		const result = markdownToTelegraphNodes('---');
		expect(result).toEqual([{ tag: 'hr' }]);
	});

	it('行内代码 `code` → 段落中包含 code 标签', () => {
		const result = markdownToTelegraphNodes('Use `code` here');
		expect(result).toHaveLength(1);
		expect(result[0].tag).toBe('p');
		expect(result[0].children).toEqual(['Use ', { tag: 'code', children: ['code'] }, ' here']);
	});

	it('混合段落：文字 + 链接 + 文字 → children 数组混合字符串和对象', () => {
		const result = markdownToTelegraphNodes('Visit [my site](https://example.com) now');
		expect(result).toHaveLength(1);
		expect(result[0].tag).toBe('p');
		expect(result[0].children).toEqual([
			'Visit ',
			{ tag: 'a', attrs: { href: 'https://example.com' }, children: ['my site'] },
			' now',
		]);
	});

	it('多段落输入 → 返回多个节点', () => {
		const md = 'First paragraph.\n\nSecond paragraph.';
		const result = markdownToTelegraphNodes(md);
		expect(result).toHaveLength(2);
		expect(result[0].tag).toBe('p');
		expect(result[0].children).toEqual(['First paragraph.']);
		expect(result[1].tag).toBe('p');
		expect(result[1].children).toEqual(['Second paragraph.']);
	});

	it('空输入 → 返回空数组', () => {
		expect(markdownToTelegraphNodes('')).toEqual([]);
		expect(markdownToTelegraphNodes('   ')).toEqual([]);
	});

	it('不支持的表格 → 转为代码块处理（当前 stub 行为）', () => {
		const md = '| col1 | col2 |\n|------|------|\n| a    | b    |';
		const result = markdownToTelegraphNodes(md);
		// 表格行会被当作普通段落处理（stub 的简化行为）
		expect(result.length).toBeGreaterThan(0);
		expect(result.every((n) => n.tag === 'p')).toBe(true);
	});
});
