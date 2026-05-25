import { describe, it, expect } from 'vitest';
import { normalizeSingleFileHtml } from '../src/singlefile.js';

describe('normalizeSingleFileHtml code blocks', () => {
	it('保留 pre > code 为 fenced code，并尽量带上 language', () => {
		const html = `
			<html>
				<head>
					<title>Code Sample</title>
					<meta property="og:url" content="https://example.com/code" />
				</head>
				<body>
					<article>
						<h1>Code Sample</h1>
						<p>Install with <code>npm install</code>.</p>
						<pre><code class="language-js">const x = 1;
console.log(x);</code></pre>
					</article>
				</body>
			</html>
		`;

		const article = normalizeSingleFileHtml({ html, url: 'https://example.com/code' });
		expect(article.markdownBody).toContain('Install with `npm install`.');
		expect(article.markdownBody).toContain('```js');
		expect(article.markdownBody).toContain('const x = 1;\nconsole.log(x);');
	});

	it('常见 table 高亮代码块去掉行号，只保留真实代码', () => {
		const html = `
			<html>
				<head>
					<title>Highlighted Code</title>
					<meta property="og:url" content="https://example.com/highlight" />
				</head>
				<body>
					<article>
						<h1>Highlighted Code</h1>
						<table class="rouge-table">
							<tr>
								<td class="gutter gl">
									<pre class="lineno">1
2</pre>
								</td>
								<td class="code">
									<pre><code class="language-python">print("hi")
print("bye")</code></pre>
								</td>
							</tr>
						</table>
					</article>
				</body>
			</html>
		`;

		const article = normalizeSingleFileHtml({ html, url: 'https://example.com/highlight' });
		expect(article.markdownBody).toContain('```python');
		expect(article.markdownBody).toContain('print("hi")\nprint("bye")');
		expect(article.markdownBody).not.toContain('1\n2');
	});
});
