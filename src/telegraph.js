// Telegraph API 封装与 Markdown → Telegraph Node 转换

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
			const linkMatch = remaining.match(/^\[([^\]]*)\]\(([^)]+)\)/);
			if (linkMatch) {
				const linkText = linkMatch[1].trim();
				// 跳过空文本链接（Jina heading anchor links）
				if (linkText && !/^\u200B*$/.test(linkText)) {
					children.push({ tag: 'a', attrs: { href: linkMatch[2] }, children: [linkText] });
				}
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
			nodes.push({ tag: 'blockquote', children: parseInline(quoteMatch[1]) });
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

		// 表格检测（Telegraph 不支持 table 标签，转为 pre/code 块保留原始格式）
		if (line.includes('|')) {
			// 向前看：检查当前行和后续行是否构成表格
			const tableLines = [];
			let j = i;
			while (j < lines.length && lines[j].includes('|')) {
				tableLines.push(lines[j]);
				j++;
			}

			// 至少需要两行，且第二行是分格线，或者所有行都是表格行（Jina 有时省略分隔行）
			const isSeparator = (line) => /^\s*\|?[\s\-:|]+\|?[\s\-:|]*$/.test(line);
			const hasSeparator = tableLines.length >= 2 && isSeparator(tableLines[1]);
			const isTable = hasSeparator || (tableLines.length >= 2 && tableLines.every((l) => l.includes('|')));
			if (isTable) {
				flushList();
				nodes.push({ tag: 'pre', children: [{ tag: 'code', children: [tableLines.join('\n')] }] });
				i = j - 1; // 跳过已处理的行
				continue;
			}
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
