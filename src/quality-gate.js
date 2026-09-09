/**
 * Quality Gate —— 判定"一篇 markdown 正文够不够料"。
 *
 * ExtractorChain 依赖它决定：
 *   1) L1 (Jina) 的结果是否值得直接采用，还是该动用更贵的 L2 提取器；
 *   2) 多路 L2 结果之间，谁的 score 更高就保留谁。
 *
 * 纯函数：不碰网络、不碰 DOM，全部输入输出都是字符串/数值，方便单测。
 * 词数口径：拉丁文按"词"计，CJK 按字计；统计前先剥掉代码块/链接URL/图片/内联HTML，
 * 避免代码和 URL 垃圾把字数吹起来。
 */

const LATIN_WORD_RE = /[A-Za-z0-9][A-Za-z0-9'’_-]*/g;
// 假名 + CJK扩展A + CJK统一表意 + 兼容表意 + 谚文：按"字"计数
const CJK_CHAR_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/g;

const MIN_PROSE_WORDS = 80;   // 纯文字正文的及格线
const MIN_STRUCT_WORDS = 30;  // 有表格/代码块时字数可放宽的底线
const STRUCTURE_BONUS = 100;  // 每个表格/代码块在 score 里的加权

const PLACEHOLDER_TITLES = new Set([
	'untitled',
	'untitled document',
	'untitled page',
	'无标题',
	'未命名',
	'未命名文档',
	'document',
	'login',
	'login page',
	'log in',
	'sign in',
	'signin',
	'wechat',
	'official account',
	'微信',
	'微信文章',
	'公众号',
	'点击阅读原文',
	'read more',
	'loading',
	'loading...',
	'not found',
	'404 not found',
	'页面不存在',
	'forbidden',
	'403 forbidden',
	'access denied',
	'just a moment...',
	'attention required',
]);

/** 剥掉非正文的噪音（代码块、图片、链接URL、内联HTML标签、裸URL），保留链接文字。 */
export function stripNonProse(markdown) {
	let text = String(markdown || '');
	text = text.replace(/```[\s\S]*?```/g, ' ');
	text = text.replace(/~~~[\s\S]*?~~~/g, ' ');
	text = text.replace(/`[^`\n]+`/g, ' ');
	text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
	text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
	text = text.replace(/<[^>]+>/g, ' ');
	text = text.replace(/\bhttps?:\/\/\S+/g, ' ');
	return text;
}

/** 词数：拉丁文按词 + CJK 按字。 */
export function countWords(markdown) {
	const text = stripNonProse(markdown);
	const latin = (text.match(LATIN_WORD_RE) || []).length;
	const cjk = (text.match(CJK_CHAR_RE) || []).length;
	return latin + cjk;
}

/** markdown 表格块数：连续管道行构成一个块，块内必须含 |---| 分隔行才算真表格。 */
export function countTables(markdown) {
	const lines = String(markdown || '').split('\n');
	const isPipeRow = (line) => line.includes('|') && line.trim().length > 1;
	const isDelimRow = (line) => {
		const t = line.trim();
		if (!t.includes('|')) return false;
		const bare = t.replace(/[|\s:]/g, '');
		return bare.length > 0 && /^-+$/.test(bare);
	};
	let blocks = 0;
	let inTable = false;
	let hasDelim = false;
	for (const line of lines) {
		if (isPipeRow(line)) {
			if (!inTable) {
				inTable = true;
				hasDelim = false;
			}
			if (isDelimRow(line)) hasDelim = true;
		} else if (inTable) {
			if (hasDelim) blocks += 1;
			inTable = false;
			hasDelim = false;
		}
	}
	if (inTable && hasDelim) blocks += 1;
	return blocks;
}

/** 围栏代码块数（``` 或 ~~~ 成对计）。 */
export function countCodeBlocks(markdown) {
	const fences = String(markdown || '').match(/^[ \t]*(?:```|~~~)/gm) || [];
	return Math.floor(fences.length / 2);
}

/** 标题是不是"没有真标题"：占位词 / 登录页 / 反爬页特征。 */
export function isPlaceholderTitle(title) {
	const t = String(title || '').trim().toLowerCase();
	if (!t) return true;
	if (PLACEHOLDER_TITLES.has(t)) return true;
	if (/^(log ?in|sign ?in)\b/.test(t) && t.length < 30) return true;
	return false;
}

/**
 * 综合评估：{ passed, score, words, tables, codeBlocks, reasons }
 * passed：标题非占位 且（纯文字≥80词 或 有表格/代码块且≥30词）
 * score ：words + (tables+codeBlocks)*100，供多路候选排序用。
 */
export function evaluateArticleQuality({ title, markdownBody } = {}) {
	const words = countWords(markdownBody);
	const tables = countTables(markdownBody);
	const codeBlocks = countCodeBlocks(markdownBody);
	const placeholder = isPlaceholderTitle(title);
	const structured = tables + codeBlocks;
	const passed = !placeholder && (words >= MIN_PROSE_WORDS || (words >= MIN_STRUCT_WORDS && structured > 0));
	const reasons = [];
	if (placeholder) reasons.push('placeholder-title');
	if (words < MIN_STRUCT_WORDS) reasons.push(`too-few-words(<${MIN_STRUCT_WORDS})`);
	else if (words < MIN_PROSE_WORDS && structured === 0) reasons.push(`thin-prose(<${MIN_PROSE_WORDS})-and-no-structure`);
	return {
		passed,
		score: words + structured * STRUCTURE_BONUS,
		words,
		tables,
		codeBlocks,
		reasons,
	};
}

/**
 * HTML 片段是否"弱内容"（与 singlefile.js 原 looksLikeWeakArticleHtml 逐字等义，
 * 集中到这里供 L2 defuddle 路复用）：
 * 文本为空 / 去标签后 < 200 字符 / 含 "Skip to content" 导航残留。
 */
export function isWeakHtmlFragment(html) {
	const normalized = String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
	if (!normalized) return true;
	if (normalized.length < 200) return true;
	if (normalized.includes('Skip to content')) return true;
	return false;
}
