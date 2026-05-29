import { getHostname, formatTagLine, yamlEscape } from './utils.js';

export function makeSlug(title) {
	return (
		title
			.replace(/[\/\\:*?"<>|#\[\]]/g, '')
			.replace(/\s+/g, '-')
			.replace(/-+/g, '-')
			.slice(0, 80)
			.trim() || 'untitled'
	);
}

export function buildNote({ title, url, date, body, summary, tags = [], clipMethod = 'url', clipCount = 1, lastClippedAt = date }) {
	const safeTitle = yamlEscape(title);
	const normalizedBody = stripLeadingDuplicateTitle(body, title);
	const hostname = getHostname(url);
	const tagLine = formatTagLine(tags);
	const frontmatter = [
		'---',
		`title: "${safeTitle}"`,
		`url: ${url}`,
		`date: ${date}`,
		'source: clipper',
		`clip_method: ${clipMethod}`,
		`clip_count: ${clipCount}`,
		`last_clipped_at: ${lastClippedAt}`,
	];
	if (tags.length > 0) {
		frontmatter.push('tags:');
		for (const tag of tags) {
			frontmatter.push(`  - ${yamlEscape(tag)}`);
		}
	}
	if (summary) {
		frontmatter.push(`summary: "${yamlEscape(summary)}"`);
	}
	frontmatter.push('---');

	const sections = [`# ${title}`, ''];
	if (summary) {
		sections.push('> [!abstract] ✨ 摘要', `> ${summary}`, '');
	}

	sections.push('> [!info] 📌 信息');
	if (hostname) sections.push(`> - **来源**：[${hostname}](${url})`);
	sections.push(`> - **时间**：${date}`);
	if (tagLine) sections.push(`> - **标签**：${tagLine}`);
	sections.push(`> - **链接**：[原文链接](${url})`, '');
	sections.push('## 📄 正文', '', normalizedBody);
	return [...frontmatter, '', ...sections].join('\n');
}

export function buildClipUpdateAppend(existingContent, clippedAt, clipMethod) {
	const line = `- ${formatClipLogTime(clippedAt)} 再次剪藏，来源 ${describeClipMethod(clipMethod)}`;
	if (String(existingContent || '').includes('## 🔄 剪藏更新记录')) {
		return `\n${line}`;
	}
	return `\n\n## 🔄 剪藏更新记录\n\n${line}`;
}

function formatClipLogTime(date) {
	const china = new Date(date.getTime() + 8 * 60 * 60 * 1000);
	const year = china.getUTCFullYear();
	const month = String(china.getUTCMonth() + 1).padStart(2, '0');
	const day = String(china.getUTCDate()).padStart(2, '0');
	const hour = String(china.getUTCHours()).padStart(2, '0');
	const minute = String(china.getUTCMinutes()).padStart(2, '0');
	const second = String(china.getUTCSeconds()).padStart(2, '0');
	return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

function describeClipMethod(clipMethod) {
	if (clipMethod === 'telegram') return 'telegram';
	if (clipMethod === 'singlefile') return 'singlefile';
	if (clipMethod === 'markdown') return 'markdown';
	return 'post';
}

function stripLeadingDuplicateTitle(body, title) {
	const normalizedTitle = normalizeComparableText(title);
	if (!normalizedTitle) return body;
	const match = body.match(/^(\s*#\s+(.+?)\s*)(?:\n+|$)/);
	if (!match) return body;
	if (normalizeComparableText(match[2]) !== normalizedTitle) return body;
	return body.slice(match[0].length).replace(/^\s+/, '');
}

function normalizeComparableText(str) {
	return String(str || '')
		.trim()
		.toLowerCase()
		.replace(/[\s\-–—_]+/g, ' ');
}
