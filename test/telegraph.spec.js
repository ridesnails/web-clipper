import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createPage, htmlToTelegraphNodes, markdownToTelegraphNodes } from '../src/telegraph.js';

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

	it('三级标题 ### Deep → h3（marked 生成 h3，normalize 保持）', () => {
		const result = markdownToTelegraphNodes('### Deep');
		expect(result).toEqual([{ tag: 'h3', children: ['Deep'] }]);
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

	it('图片 ![alt](http://img.jpg) → p 包裹 img', () => {
		const result = markdownToTelegraphNodes('![alt](http://img.jpg)');
		expect(result).toEqual([{ tag: 'p', children: [{ tag: 'img', attrs: { src: 'http://img.jpg' } }] }]);
	});

	it('缺失 href/src 的 HTML 标签不会触发异常', () => {
		const result = htmlToTelegraphNodes('<p>before <a>link</a> <img> after</p>');
		expect(result).toEqual([{ tag: 'p', children: ['before ', { tag: 'a', children: ['link'] }, { tag: 'img' }, ' after'] }]);
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
		expect(result[0].children).toHaveLength(1);
		expect(result[0].children[0].tag).toBe('code');
		expect(result[0].children[0].children[0]).toContain('const x = 1;');
	});

	it('引用块 > quote → blockquote > p', () => {
		const result = markdownToTelegraphNodes('> quote');
		expect(result).toEqual([{ tag: 'blockquote', children: [{ tag: 'p', children: ['quote'] }] }]);
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

	it('粗体 **bold** 和斜体 *italic* → strong / em', () => {
		const result = markdownToTelegraphNodes('**bold** and *italic*');
		expect(result).toHaveLength(1);
		expect(result[0].tag).toBe('p');
		expect(result[0].children).toEqual([
			{ tag: 'strong', children: ['bold'] },
			' and ',
			{ tag: 'em', children: ['italic'] },
		]);
	});

	it('混合段落：文字 + 链接 + 文字 → children 数组混合字符串和对象', () => {
		const result = markdownToTelegraphNodes('Visit [my site](https://example.com) now');
		expect(result).toHaveLength(1);
		expect(result[0].tag).toBe('p');
		expect(result[0].children).toEqual(['Visit ', { tag: 'a', attrs: { href: 'https://example.com' }, children: ['my site'] }, ' now']);
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

	it('GFM 表格转为 pre/code 块（Telegraph 不支持 table 标签）', () => {
		const md = '| Name | Age |\n|------|-----|\n| Alice | 30 |\n| Bob | 25 |';
		const nodes = markdownToTelegraphNodes(md);
		expect(nodes).toHaveLength(1);
		expect(nodes[0].tag).toBe('pre');
		expect(nodes[0].children[0].tag).toBe('code');
		const codeText = nodes[0].children[0].children[0];
		expect(codeText).toContain('| Name | Age |');
		expect(codeText).toContain('| Alice | 30 |');
	});

	it('空文本链接 [](url) 被过滤', () => {
		const md = 'Heading [](http://example.com) text';
		const nodes = markdownToTelegraphNodes(md);
		const p = nodes[0];
		expect(p.tag).toBe('p');
		// 不应该包含 a 标签
		const hasLink = p.children.some((child) => typeof child === 'object' && child.tag === 'a');
		expect(hasLink).toBe(false);
		// 文本应该包含 "Heading" 和 "text"
		const text = p.children.filter((c) => typeof c === 'string').join('');
		expect(text).toContain('Heading');
		expect(text).toContain('text');
	});

	it('零宽空格链接 [\u200B](url) 被过滤', () => {
		const md = 'Test [\u200B](http://example.com) end';
		const nodes = markdownToTelegraphNodes(md);
		const p = nodes[0];
		const hasLink = p.children.some((child) => typeof child === 'object' && child.tag === 'a');
		expect(hasLink).toBe(false);
	});

	it('非空链接 [text](url) 正常保留', () => {
		const md = 'Click [here](http://example.com) now';
		const nodes = markdownToTelegraphNodes(md);
		const p = nodes[0];
		const link = p.children.find((child) => typeof child === 'object' && child.tag === 'a');
		expect(link).toBeDefined();
		expect(link.attrs.href).toBe('http://example.com');
		expect(link.children).toEqual(['here']);
	});

	it('带 title 的 Markdown 链接正常保留 href 和文本', () => {
		const md = '[🚀 快速部署](https://cfbed.sanyue.de/deployment/docker.html#quick "🚀 快速部署")';
		const nodes = markdownToTelegraphNodes(md);
		const link = nodes[0].children.find((child) => typeof child === 'object' && child.tag === 'a');
		expect(link).toBeDefined();
		expect(link.attrs.href).toBe('https://cfbed.sanyue.de/deployment/docker.html#quick');
		expect(link.children).toEqual(['🚀 快速部署']);
	});

	it('代码块保留换行', () => {
		const md = '```\nmkdir cloudflare-imgbed\ncd cloudflare-imgbed\n```';
		const nodes = markdownToTelegraphNodes(md);
		const codeText = nodes[0].children[0].children[0];
		expect(codeText).toContain('mkdir cloudflare-imgbed\ncd cloudflare-imgbed');
	});

	it('HTML 高亮代码块转为 pre > code，去掉行号噪音', () => {
		const html = `
			<div class="highlight">
				<table>
					<tr>
						<td class="gutter"><pre>1
2</pre></td>
						<td class="code"><pre><code class="language-js">const a = 1;
console.log(a);</code></pre></td>
					</tr>
				</table>
			</div>
		`;

		const nodes = htmlToTelegraphNodes(html);
		expect(nodes).toHaveLength(1);
		expect(nodes[0].tag).toBe('pre');
		expect(nodes[0].children[0].tag).toBe('code');
		expect(nodes[0].children[0].children[0]).toContain('const a = 1;\nconsole.log(a);');
		expect(nodes[0].children[0].children[0]).not.toContain('1\n2');
	});
});
