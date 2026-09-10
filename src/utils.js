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

// ---- 时区 helper ----
// 方案阶段四：落盘路径（原 getFullYear/getMonth = Worker UTC）与剪藏日志（原手动 +8h）并存，
// UTC 月末 17:00 剪藏会「文件夹算上月、日志算本月」。统一以北京时间（UTC+8）为准。
const CHINA_TZ_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * 把任意 Date 映射到北京时间后取各字段。
 * @param {Date} date
 * @returns {{year: number, month: number, day: number, hour: number, minute: number, second: number}}
 */
export function chinaTimeParts(date) {
	const shifted = new Date(date.getTime() + CHINA_TZ_OFFSET_MS);
	return {
		year: shifted.getUTCFullYear(),
		month: shifted.getUTCMonth() + 1,
		day: shifted.getUTCDate(),
		hour: shifted.getUTCHours(),
		minute: shifted.getUTCMinutes(),
		second: shifted.getUTCSeconds(),
	};
}

/**
 * 北京时间年月（用于 FNS 落盘目录 Clippings/YYYY-MM）。
 * @param {Date} date
 * @returns {string} "YYYY-MM"
 */
export function chinaYearMonth(date) {
	const { year, month } = chinaTimeParts(date);
	return `${year}-${String(month).padStart(2, '0')}`;
}

/**
 * 北京时间完整时间串（用于剪藏更新记录等日志行）。
 * @param {Date} date
 * @returns {string} "YYYY-MM-DD HH:mm:ss"
 */
export function formatChinaDateTime(date) {
	const p = chinaTimeParts(date);
	const pad = (n) => String(n).padStart(2, '0');
	return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
}
