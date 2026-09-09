import { describe, it, expect } from 'vitest';
import {
	stripNonProse,
	countWords,
	countTables,
	countCodeBlocks,
	isPlaceholderTitle,
	evaluateArticleQuality,
	isWeakHtmlFragment,
} from '../src/quality-gate.js';

describe('countWords', () => {
	it('counts latin words', () => {
		expect(countWords('hello world foo-bar')).toBe(3);
	});

	it('counts CJK chars as words', () => {
		expect(countWords('正文是一段链接文字带加上的内容')).toBe(15);
	});

	it('excludes urls, inline code and images but keeps link text', () => {
		const md = 'see [the docs](https://example.com/a) and https://raw.url/x plus `let x=1` code';
		// latin: see, the, docs, and, plus, code  (raw url, link target and inline code all excluded)
		expect(countWords(md)).toBe(6);
	});

	it('excludes fenced code blocks entirely', () => {
		const md = 'real prose here\n\n```js\nlet ignored = "lots of words in code";\n```\n';
		expect(countWords(md)).toBe(3);
	});
});

describe('stripNonProse', () => {
	it('keeps link text, drops link target', () => {
		expect(stripNonProse('[label](https://x.com)')).toBe('label');
	});
	it('drops images and html tags', () => {
		const out = stripNonProse('![alt](https://x.com/i.png) <b>bold</b> tail');
		expect(out).not.toContain('x.com');
		expect(out).not.toContain('<b>');
		expect(out).toContain('bold');
		expect(out).toContain('tail');
	});
});

describe('countTables', () => {
	it('returns 0 without delimiter row', () => {
		expect(countTables('| a | b |\n| c | d |')).toBe(0);
	});

	it('counts one table with delimiter row', () => {
		expect(countTables('| a | b |\n|---|---|\n| 1 | 2 |')).toBe(1);
	});

	it('counts two separated tables', () => {
		const md = '| a |\n|---|\n| 1 |\n\ntext\n\n| b |\n|:--:|\n| 2 |';
		expect(countTables(md)).toBe(2);
	});
});

describe('countCodeBlocks', () => {
	it('counts balanced fences', () => {
		expect(countCodeBlocks('```js\nx\n```\n\n```py\ny\n```')).toBe(2);
	});

	it('returns 0 for a lone fence', () => {
		expect(countCodeBlocks('```js\nx')).toBe(0);
	});
});

describe('isPlaceholderTitle', () => {
	it('flags empty and placeholder titles', () => {
		for (const t of ['', '  ', 'Untitled', '无标题', 'untitled document', 'WeChat', 'login', 'Just a moment...']) {
			expect(isPlaceholderTitle(t), t).toBe(true);
		}
	});

	it('flags login-ish titles', () => {
		expect(isPlaceholderTitle('Sign in to continue')).toBe(true);
		expect(isPlaceholderTitle('Log in')).toBe(true);
	});

	it('accepts real titles', () => {
		expect(isPlaceholderTitle('Real Title')).toBe(false);
		expect(isPlaceholderTitle('微信 Bot 实战笔记')).toBe(false);
	});
});

describe('evaluateArticleQuality', () => {
	const prose = 'one two three four five six seven eight nine ten '.repeat(9); // 90 words

	it('passes plain prose >= 80 words', () => {
		const q = evaluateArticleQuality({ title: 'Real Title', markdownBody: prose });
		expect(q.passed).toBe(true);
		expect(q.words).toBe(90);
		expect(q.score).toBe(90);
		expect(q.reasons).toEqual([]);
	});

	it('fails thin prose without structure', () => {
		const q = evaluateArticleQuality({ title: 'Real Title', markdownBody: '# t\n\nshort text' });
		expect(q.passed).toBe(false);
		expect(q.reasons.length).toBeGreaterThan(0);
	});

	it('passes thin prose when it carries a table', () => {
		const md = '| a | b |\n|---|---|\n| 1 | 2 |\n\n' + 'word '.repeat(30); // 30 words meets MIN_STRUCT_WORDS
		const q = evaluateArticleQuality({ title: 'Real Title', markdownBody: md });
		expect(q.passed).toBe(true);
		expect(q.tables).toBe(1);
		expect(q.score).toBe(q.words + 100);
	});

	it('fails placeholder titles regardless of length', () => {
		const q = evaluateArticleQuality({ title: 'Untitled', markdownBody: prose });
		expect(q.passed).toBe(false);
		expect(q.reasons).toContain('placeholder-title');
	});
});

describe('isWeakHtmlFragment', () => {
	it('flags empty and short fragments', () => {
		expect(isWeakHtmlFragment('')).toBe(true);
		expect(isWeakHtmlFragment('<p>hi</p>')).toBe(true);
	});

	it('flags navigation residue', () => {
		expect(isWeakHtmlFragment('<div>' + 'x '.repeat(120) + 'Skip to content</div>')).toBe(true);
	});

	it('accepts substantial fragments', () => {
		expect(isWeakHtmlFragment('<p>' + 'word '.repeat(60) + '</p>')).toBe(false);
	});
});
