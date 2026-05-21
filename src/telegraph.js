// Telegraph API 封装与 Markdown 转换

/**
 * 创建 Telegraph 页面
 * @param {string} title - 页面标题
 * @param {Array} contentNodes - Telegraph Node 数组
 * @param {object} env - 环境变量，包含 TELEGRAPH_ACCESS_TOKEN
 * @returns {Promise<{url: string, path: string, title: string}>}
 */
export async function createPage(title, contentNodes, env) {
	const res = await fetch('https://api.telegra.ph/createPage', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			access_token: env.TELEGRAPH_ACCESS_TOKEN,
			title,
			author_name: 'web-clipper',
			author_url: '',
			content: JSON.stringify(contentNodes),
		}),
	});

	const data = await res.json();
	if (!data.ok) {
		throw new Error(`Telegraph createPage failed: ${data.error}`);
	}

	return {
		url: data.result.url,
		path: data.result.path,
		title: data.result.title,
	};
}

/**
 * 将 Markdown 字符串转换为 Telegraph Node 数组
 * @param {string} markdown - Markdown 文本
 * @returns {Array} Telegraph Node 数组
 */
export function markdownToTelegraphNodes(markdown) {
	const lines = markdown.split('\n');
	const nodes = [];
	let i = 0;

	while (i < lines.length) {
		const line = lines[i];
		const trimmed = line.trim();

		if (trimmed === '') {
			i++;
			continue;
		}

		// 代码块
		if (trimmed.startsWith('```')) {
			i++;
			const codeLines = [];
			while (i < lines.length && !lines[i].trim().startsWith('```')) {
				codeLines.push(lines[i]);
				i++;
			}
			nodes.push({
				tag: 'pre',
				children: [{ tag: 'code', children: [codeLines.join('\n')] }],
			});
			i++; // skip closing ```
			continue;
		}

		// 表格：当前行包含 | 且下一行是分隔符
		if (trimmed.includes('|') && i + 1 < lines.length && /^[\s|:-]+$/.test(lines[i + 1].trim())) {
			const tableLines = [line];
			i++;
			while (i < lines.length && lines[i].trim().includes('|')) {
				tableLines.push(lines[i]);
				i++;
			}
			nodes.push({
				tag: 'pre',
				children: [{ tag: 'code', children: [tableLines.join('\n')] }],
			});
			continue;
		}

		// 标题
		const headingMatch = trimmed.match(/^(#{1,6})\s+(.*)$/);
		if (headingMatch) {
			const level = headingMatch[1].length;
			const text = headingMatch[2].trim();
			if (level === 1) {
				nodes.push({ tag: 'h3', children: [text] });
			} else if (level === 2) {
				nodes.push({ tag: 'h4', children: [text] });
			} else {
				nodes.push({ tag: 'p', children: [{ tag: 'b', children: [text] }] });
			}
			i++;
			continue;
		}

		// 分隔线
		if (/^(---+|\*\*\*+)$/.test(trimmed)) {
			nodes.push({ tag: 'hr' });
			i++;
			continue;
		}

		// 引用
		if (trimmed.startsWith('>')) {
			const text = trimmed.slice(1).trim();
			nodes.push({ tag: 'blockquote', children: parseInline(text) });
			i++;
			continue;
		}

		// 列表项（嵌套列表扁平化为普通 li）
		const listMatch = trimmed.match(/^([-*+]|\d+\.)\s+(.*)$/);
		if (listMatch) {
			const text = listMatch[2];
			nodes.push({ tag: 'li', children: parseInline(text) });
			i++;
			continue;
		}

		// 独立图片行
		const imgLineMatch = trimmed.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
		if (imgLineMatch) {
			nodes.push({ tag: 'img', attrs: { src: imgLineMatch[2] } });
			i++;
			continue;
		}

		// 普通段落
		nodes.push({ tag: 'p', children: parseInline(trimmed) });
		i++;
	}

	return nodes;
}

/**
 * 解析行内元素（链接、代码、粗体等）
 * @param {string} text - 纯文本
 * @returns {Array} 混合 children 数组
 */
function parseInline(text) {
	const children = [];
	let remaining = text;

	while (remaining.length > 0) {
		// 行内代码（优先匹配，避免与链接冲突）
		const codeMatch = remaining.match(/^`([^`]+)`/);
		if (codeMatch) {
			children.push({ tag: 'code', children: [codeMatch[1]] });
			remaining = remaining.slice(codeMatch[0].length);
			continue;
		}

		// 粗体 **text**
		const boldMatch = remaining.match(/^\*\*([^*]+)\*\*/);
		if (boldMatch) {
			children.push({ tag: 'b', children: [boldMatch[1]] });
			remaining = remaining.slice(boldMatch[0].length);
			continue;
		}

		// 斜体 *text*（避免与粗体冲突）
		const italicMatch = remaining.match(/^\*([^*]+)\*/);
		if (italicMatch) {
			children.push({ tag: 'i', children: [italicMatch[1]] });
			remaining = remaining.slice(italicMatch[0].length);
			continue;
		}

		// 图片（行内）
		const imgMatch = remaining.match(/^!\[([^\]]*)\]\(([^)]+)\)/);
		if (imgMatch) {
			children.push({ tag: 'img', attrs: { src: imgMatch[2] } });
			remaining = remaining.slice(imgMatch[0].length);
			continue;
		}

		// 链接
		const linkMatch = remaining.match(/^\[([^\]]+)\]\(([^)]+)\)/);
		if (linkMatch) {
			children.push({ tag: 'a', attrs: { href: linkMatch[2] }, children: [linkMatch[1]] });
			remaining = remaining.slice(linkMatch[0].length);
			continue;
		}

		// 没有匹配到行内元素，收集普通文本直到下一个特殊标记
		const nextSpecial = remaining.search(/`|\*\*|\*|!\[|\[/);
		if (nextSpecial === -1) {
			children.push(remaining);
			break;
		} else if (nextSpecial === 0) {
			// 遇到了不认识的特殊标记开头，跳过第一个字符防止死循环
			children.push(remaining[0]);
			remaining = remaining.slice(1);
		} else {
			children.push(remaining.slice(0, nextSpecial));
			remaining = remaining.slice(nextSpecial);
		}
	}

	return children;
}
