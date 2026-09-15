import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {buildTelegraphHtml, buildTelegraphNodes, createPage, extractTelegraphContentHtml, htmlToTelegraphNodes, markdownToTelegraphNodes, editPage, TelegraphPageNotFoundError, telegraphApiRoot} from '../src/telegraph.js';

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

	it('图片 ![alt](http://img.jpg) → 提升为 figure + figcaption（alt 为图注）', () => {
		const result = markdownToTelegraphNodes('![alt](http://img.jpg)');
		expect(result).toEqual([
			{ tag: 'figure', children: [{ tag: 'img', attrs: { src: 'http://img.jpg' } }, { tag: 'figcaption', children: ['alt'] }] },
		]);
	});

	it('图片空 alt → figure 内仅 img，无空 figcaption', () => {
		const result = markdownToTelegraphNodes('![](http://img.jpg)');
		expect(result).toEqual([{ tag: 'figure', children: [{ tag: 'img', attrs: { src: 'http://img.jpg' } }] }]);
	});

	it('段落内图片 + 前后文字 → 保持 p 不提升（防内联图误变 figure）', () => {
		const result = markdownToTelegraphNodes('text ![alt](http://img.jpg) after');
		expect(result).toEqual([
			{ tag: 'p', children: ['text ', { tag: 'img', attrs: { src: 'http://img.jpg' } }, ' after'] },
		]);
	});

	it('纯嵌套引用 > > x → 扁平化为单层引用并加层级前缀', () => {
		const result = markdownToTelegraphNodes('> > x');
		expect(result).toEqual([{ tag: 'blockquote', children: [{ tag: 'p', children: ['› x'] }] }]);
	});

	it('混合嵌套引用（外层有文字）→ 兄弟引用块，内层加 › 前缀', () => {
		const result = markdownToTelegraphNodes('> a\n> > b');
		expect(result).toEqual([
			{ tag: 'blockquote', children: [{ tag: 'p', children: ['a'] }] },
			{ tag: 'blockquote', children: [{ tag: 'p', children: ['› b'] }] },
		]);
	});

	it('Markdown Alerts [!NOTE] → strong 标记替代残留原文', () => {
		const result = markdownToTelegraphNodes('> [!NOTE]\n> Useful info');
		expect(result).toEqual([
			{
				tag: 'blockquote',
				children: [{ tag: 'p', children: [{ tag: 'strong', children: ['Note'] }, 'Useful info'] }],
			},
		]);
	});

	it('GitHub 渲染后的 div.markdown-alert → blockquote + 加粗标题（svg 图标丢弃）', () => {
		const html =
			'<div class="markdown-alert markdown-alert-note" dir="auto"><p class="markdown-alert-title" dir="auto"><svg viewBox="0 0 16 16"><path d="M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Z"/></svg>Note</p><p dir="auto">Body text</p></div>';
		const result = htmlToTelegraphNodes(html);
		expect(result).toEqual([
			{
				tag: 'blockquote',
				children: [
					{ tag: 'p', children: [{ tag: 'strong', children: ['Note'] }] },
					{ tag: 'p', children: ['Body text'] },
				],
			},
		]);
	});

	it('GitHub Alert 内嵌引用 → 标题块与 › 前缀引用块平级', () => {
		const html =
			'<div class="markdown-alert markdown-alert-warning" dir="auto"><p class="markdown-alert-title" dir="auto"><svg viewBox="0 0 16 16"></svg>Warning</p><blockquote dir="auto"><p dir="auto">inner quote</p></blockquote></div>';
		const result = htmlToTelegraphNodes(html);
		expect(result).toEqual([
			{ tag: 'blockquote', children: [{ tag: 'p', children: [{ tag: 'strong', children: ['Warning'] }] }] },
			{ tag: 'blockquote', children: [{ tag: 'p', children: ['› inner quote'] }] },
		]);
	});

	it('Rouge 高亮表（gutter+code 双 td）→ 仍降级为纯净 pre>code（回归）', () => {
		const html =
			'<div class="highlight"><table class="rouge-table"><tbody><tr><td class="gutter gl"><pre class="lineno">1\n2\n</pre></td><td class="code"><pre>puts <span class="nb">hi</span>\n</pre></td></tr></tbody></table></div>';
		const result = htmlToTelegraphNodes(html);
		expect(result).toEqual([{ tag: 'pre', children: [{ tag: 'code', children: ['puts hi'] }] }]);
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

	it('文档站 HTML 优先抽取 vp-doc 正文区域', () => {
		const html = `
			<body>
				<a href="#VPContent">Skip to content</a>
				<div id="VPContent">
					<main>
						<div class="vp-doc">
							<h1>第 6 章 进阶功能</h1>
							<p>正文段落</p>
							<pre><code class="language-bash">echo hello</code></pre>
						</div>
					</main>
				</div>
			</body>
		`;

		const extracted = extractTelegraphContentHtml(html);
		expect(extracted).toContain('第 6 章 进阶功能');
		expect(extracted).toContain('正文段落');
		expect(extracted).toContain('echo hello');
		expect(extracted).not.toContain('Skip to content');
	});

	it('带注释和脚本壳的文档站 HTML 不应在转换时崩溃', () => {
		const html = `
			<!--before-->
			<div id="VPContent">
				<div class="vp-doc">
					<h1>标题</h1>
					<p>正文</p>
					<pre><code class="language-js">console.log(1)</code></pre>
				</div>
			</div>
			<script>console.log('x')</script>
			<!--after-->
		`;

		const nodes = htmlToTelegraphNodes(html);
		const serialized = JSON.stringify(nodes);
		expect(serialized).toContain('"tag":"pre"');
		expect(serialized).toContain('console.log(1)');
		expect(serialized).toContain('正文');
	});
});

describe('buildTelegraphHtml / buildTelegraphNodes prefix', () => {
	it('prefix 含原文链接、摘要 aside、标签与 hr', () => {
		const html = buildTelegraphHtml({
			body: '<p>正文</p>',
			summary: '这是摘要',
			tags: ['clip', 'web'],
			sourceUrl: 'https://example.com/article',
		});
		expect(html).toContain('<a href="https://example.com/article">原文链接</a>');
		expect(html).toContain('<aside>');
		expect(html).toContain('这是摘要');
		expect(html).toContain('标签：');
		expect(html).toContain('<hr>');
		expect(html).toContain('<p>正文</p>');
	});

	it('无 prefix 字段时只返回 body', () => {
		expect(buildTelegraphHtml({ body: '<p>only</p>' })).toBe('<p>only</p>');
	});

	it('buildTelegraphNodes 输出原文链接节点', () => {
		const nodes = buildTelegraphNodes({
			html: '<p>body</p>',
			summary: 'sum',
			tags: ['t1'],
			sourceUrl: 'https://example.com/x',
		});
		const serialized = JSON.stringify(nodes);
		expect(serialized).toContain('原文链接');
		expect(serialized).toContain('https://example.com/x');
		expect(serialized).toContain('"tag":"aside"');
		expect(serialized).toContain('"tag":"hr"');
	});
});

// ---------- 阶段三：editPage 幂等更新 + API root 镜像 ----------

describe('telegraphApiRoot', () => {
	const savedFetch = globalThis.fetch;

	beforeEach(() => {
		vi.stubGlobal('fetch', vi.fn());
	});

	afterEach(() => {
		globalThis.fetch = savedFetch;
		vi.unstubAllGlobals();
	});

	it('未配置 TELEGRAPH_API_ROOT → 官方域 api.telegra.ph', () => {
		expect(telegraphApiRoot({})).toBe('https://api.telegra.ph');
		expect(telegraphApiRoot({ TELEGRAPH_API_ROOT: '' })).toBe('https://api.telegra.ph');
	});

	it('配置镜像域 → 使用镜像并剥离尾部斜杠', () => {
		expect(telegraphApiRoot({ TELEGRAPH_API_ROOT: 'https://api.graph.org' })).toBe('https://api.graph.org');
		expect(telegraphApiRoot({ TELEGRAPH_API_ROOT: 'https://api.graph.org/' })).toBe('https://api.graph.org');
		expect(telegraphApiRoot({ TELEGRAPH_API_ROOT: 'https://api.graph.org//' })).toBe('https://api.graph.org');
	});
});

describe('editPage', () => {
	const savedFetch = globalThis.fetch;
	const editEnv = { TELEGRAPH_ACCESS_TOKEN: 'tok' };

	beforeEach(() => {
		vi.stubGlobal('fetch', vi.fn());
	});

	afterEach(() => {
		globalThis.fetch = savedFetch;
		vi.unstubAllGlobals();
	});

	it('成功编辑 → POST /editPage/<path>，返回 url/path/title', async () => {
		const mockBody = { ok: true, result: { path: 'Test-05-21', url: 'https://telegra.ph/Test-05-21', title: 'T' } };
		const fetchMock = vi.fn().mockResolvedValueOnce(
			new Response(JSON.stringify(mockEditBody(mockBody)), { status: 200 })
		);
		vi.stubGlobal('fetch', fetchMock);

		const result = await editPage('Test-05-21', 'T', [{ tag: 'p', children: ['x'] }], editEnv);
		expect(result.path).toBe('Test-05-21');
		const [calledUrl, init] = fetchMock.mock.calls[0];
		expect(calledUrl).toBe('https://api.telegra.ph/editPage/Test-05-21');
		expect(init.method).toBe('POST');
		const body = JSON.parse(init.body);
		expect(body.access_token).toBe('tok');
		expect(body.title).toBe('T');
		expect(JSON.parse(body.content)).toEqual([{ tag: 'p', children: ['x'] }]);
	});

	it('PAGE_NOT_FOUND → 抛 TelegraphPageNotFoundError，code=TELEGRAPH_PAGE_NOT_FOUND', async () => {
		const fetchMock = vi.fn().mockResolvedValueOnce(
			new Response(JSON.stringify({ ok: false, error: 'PAGE_NOT_FOUND' }), { status: 200 })
		);
		vi.stubGlobal('fetch', fetchMock);

		let caught = null;
		try {
			await editPage('Gone-05-21', 'T', [{ tag: 'p', children: ['x'] }], editEnv);
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(TelegraphPageNotFoundError);
		expect(caught.code).toBe('TELEGRAPH_PAGE_NOT_FOUND');
	});

	it('其他 API 错误 → 普通 Error 而非 NOT_FOUND 错类', async () => {
		const fetchMock = vi.fn().mockResolvedValueOnce(
			new Response(JSON.stringify({ ok: false, error: 'ACCESS_TOKEN_INVALID' }), { status: 200 })
		);
		vi.stubGlobal('fetch', fetchMock);

		let caught = null;
		try {
			await editPage('Foo-05-21', 'T', [], editEnv);
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(Error);
		expect(caught).not.toBeInstanceOf(TelegraphPageNotFoundError);
	});

	it('配置镜像域 → editPage 走镜像 URL 并对 path encodeURIComponent', async () => {
		const fetchMock = vi.fn().mockResolvedValueOnce(
			new Response(JSON.stringify(mockEditBody({ ok: true, result: { path: 'A B-05-21', url: 'u', title: 'T' } })), { status: 200 })
		);
		vi.stubGlobal('fetch', fetchMock);

		await editPage('A B-05-21', 'T', [], { ...editEnv, TELEGRAPH_API_ROOT: 'https://api.graph.org' });
		const [calledUrl] = fetchMock.mock.calls[0];
		expect(calledUrl).toBe('https://api.graph.org/editPage/A%20B-05-21');
	});
});

function mockEditBody(body) {
	// 让误粘贴的 mock 结构直接暴露原文，便于排错
	return body;
}
