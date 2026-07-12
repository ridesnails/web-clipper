import { describe, it, expect } from 'vitest';
import { noteContainsUrl } from '../src/fns.js';

describe('noteContainsUrl', () => {
	it('matches exact frontmatter url: field', () => {
		const content = `---
title: demo
url: https://example.com/a
tags:
  - clip
---

body mentions https://example.com/b
`;
		expect(noteContainsUrl(content, 'https://example.com/a')).toBe(true);
		expect(noteContainsUrl(content, 'https://example.com/b')).toBe(false);
	});

	it('supports quoted url values', () => {
		const content = `---
url: "https://example.com/q"
---
`;
		expect(noteContainsUrl(content, 'https://example.com/q')).toBe(true);
		expect(noteContainsUrl(content, 'https://example.com/other')).toBe(false);
	});

	it('does not match URL only present in body', () => {
		const content = `---
title: no-url-field
---

See https://example.com/only-body
`;
		expect(noteContainsUrl(content, 'https://example.com/only-body')).toBe(false);
	});

	it('returns false for empty inputs', () => {
		expect(noteContainsUrl('', 'https://example.com')).toBe(false);
		expect(noteContainsUrl('url: https://example.com', '')).toBe(false);
	});
});
