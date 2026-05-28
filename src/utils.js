export function isValidUrl(s) {
	try {
		const u = new URL(s);
		return u.protocol === 'http:' || u.protocol === 'https:';
	} catch {
		return false;
	}
}

export function escapeHtml(str) {
	return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function escapeHtmlAttr(str) {
	return escapeHtml(String(str || '')).replace(/"/g, '&quot;');
}

export function getHostname(url) {
	try {
		return new URL(url).hostname;
	} catch {
		return String(url || '');
	}
}

export function resolveUrl(value, baseUrl) {
	try {
		const url = new URL(String(value || '').trim(), baseUrl);
		if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
		return url.href;
	} catch {
		return '';
	}
}

export function formatTagLine(tags = []) {
	return tags
		.map((tag) => normalizeHashtag(tag))
		.filter(Boolean)
		.map((tag) => `#${tag}`)
		.join(' ');
}

export function normalizeHashtag(tag) {
	return String(tag || '')
		.trim()
		.replace(/\s+/g, '_')
		.replace(/-/g, '_')
		.replace(/[^\w一-鿿]/g, '');
}

export function yamlEscape(str) {
	return String(str).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
