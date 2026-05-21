// Telegraph API 封装与 Markdown → Telegraph Node 转换
// 注：此为占位实现，供测试使用。真实实现由 backend-dev teammate 提供。

/**
 * 在 Telegraph 上创建页面
 * @param {string} title - 页面标题
 * @param {Array} contentNodes - Telegraph Node 数组
 * @param {object} env - 环境变量，需包含 TELEGRAPH_ACCESS_TOKEN
 * @returns {Promise<{url: string, path: string, title: string}>}
 */
export async function createPage(title, contentNodes, env) {
	const res = await fetch('https://api.telegra.ph/createPage', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			access_token: env.TELEGRAPH_ACCESS_TOKEN,
			title,
			content: JSON.stringify(contentNodes),
			return_content: false,
		}),
	});

	if (!res.ok) {
		throw new Error(`Telegraph createPage failed: ${res.status}`);
	}

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
 * 将 Markdown 文本转换为 Telegraph Node 数组
 * @param {string} markdown - Markdown 文本
 * @returns {Array} Telegraph Node 数组
 */
export function markdownToTelegraphNodes(markdown) {
	if (!markdown || !markdown.trim()) {
		return [];
	}

	const lines = markdown.split('\n');
	const nodes = [];
	let inCodeBlock = false;
	let codeContent = [];
	let inList = false;
	let listItems = [];

	function flushList() {
		if (listItems.length > 0) {
			nodes.push({ tag: 'ul', children: listItems });
			listItems = [];
			inList = false;
		}
	}

	function parseInline(text) {
		// 处理行内代码
		const parts = [];
		const codeRegex = /`([^`]+)`/g;
		let lastIndex = 0;
		let match;

		while ((match = codeRegex.exec(text)) !== null) {
			if (match.index > lastIndex) {
				parts.push(...parseLinksAndBold(text.slice(lastIndex, match.index)));
			}
			parts.push({ tag: 'code', children: [match[1]] });
			lastIndex = match.index + match[0].length;
		}

		if (lastIndex < text.length) {
			parts.push(...parseLinksAndBold(text.slice(lastIndex)));
		}

		return parts.length === 0 ? [text] : parts;
	}

	function parseLinksAndBold(text) {
		// 先处理链接 [text](url)
		const parts = [];
		const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
		let lastIndex = 0;
		let match;

		while ((match = linkRegex.exec(text)) !== null) {
			if (match.index > lastIndex) {
				parts.push(text.slice(lastIndex, match.index));
			}
			parts.push({ tag: 'a', attrs: { href: match[2] }, children: [match[1]] });
			lastIndex = match.index + match[0].length;
		}

		if (lastIndex < text.length) {
			parts.push(text.slice(lastIndex));
		}

		return parts.length === 0 ? [text] : parts;
	}

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		// 代码块
		if (line.startsWith('```')) {
			if (inCodeBlock) {
				nodes.push({ tag: 'pre', children: [{ tag: 'code', children: [codeContent.join('\n')] }] });
				codeContent = [];
				inCodeBlock = false;
			} else {
				flushList();
				inCodeBlock = true;
			}
			continue;
		}

		if (inCodeBlock) {
			codeContent.push(line);
			continue;
		}

		// 空行
		if (line.trim() === '') {
			flushList();
			continue;
		}

		// 水平线
		if (/^(---|___|\*\*\*)$/.test(line.trim())) {
			flushList();
			nodes.push({ tag: 'hr' });
			continue;
		}

		// 一级标题
		const h1Match = line.match(/^#\s+(.+)$/);
		if (h1Match) {
			flushList();
			nodes.push({ tag: 'h3', children: [h1Match[1]] });
			continue;
		}

		// 二级标题
		const h2Match = line.match(/^##\s+(.+)$/);
		if (h2Match) {
			flushList();
			nodes.push({ tag: 'h4', children: [h2Match[1]] });
			continue;
		}

		// 三级及以上标题 → 加粗段落
		const h3Match = line.match(/^###+\s+(.+)$/);
		if (h3Match) {
			flushList();
			nodes.push({ tag: 'p', children: [{ tag: 'b', children: [h3Match[1]] }] });
			continue;
		}

		// 引用块
		const quoteMatch = line.match(/^>\s*(.*)$/);
		if (quoteMatch) {
			flushList();
			nodes.push({ tag: 'blockquote', children: [quoteMatch[1]] });
			continue;
		}

		// 图片
		const imgMatch = line.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
		if (imgMatch) {
			flushList();
			nodes.push({ tag: 'img', attrs: { src: imgMatch[2] } });
			continue;
		}

		// 列表项
		const listMatch = line.match(/^(?:-\s+|\*\s+|\d+\.\s+)(.+)$/);
		if (listMatch) {
			inList = true;
			listItems.push({ tag: 'li', children: parseInline(listMatch[1]) });
			continue;
		}

		// 普通段落（处理行内格式）
		flushList();
		const children = parseInline(line);
		nodes.push({ tag: 'p', children });
	}

	flushList();

	// 如果还在代码块中， flush 它
	if (inCodeBlock && codeContent.length > 0) {
		nodes.push({ tag: 'pre', children: [{ tag: 'code', children: [codeContent.join('\n')] }] });
	}

	return nodes;
}
