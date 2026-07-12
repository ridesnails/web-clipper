import { buildClipUpdateAppend } from './note.js';
import { fetchWithTimeout } from './http.js';

const FNS_REQUEST_TIMEOUT_MS = 15000;

async function fnsFetch(url, init = {}) {
	return fetchWithTimeout(url, init, {
		timeoutMs: FNS_REQUEST_TIMEOUT_MS,
		retries: 1,
		delaysMs: [800],
	});
}

export async function writeToFns({ path, content, env, url, summary, tags, clipMethod, clippedAt }) {
	const existing = await findExistingNoteByUrl({ url, env });
	if (!existing) {
		await createFnsNote({ path, content, env });
		return { mode: 'created', path };
	}

	const nextClipCount = extractClipCount(existing.content) + 1;
	const updates = {
		last_clipped_at: clippedAt.toISOString(),
		clip_count: nextClipCount,
		clip_method: clipMethod,
	};
	if (summary) {
		updates.summary = summary;
	}
	if (tags.length > 0) {
		updates.tags = tags;
	}
	await patchFnsFrontmatter({ path: existing.path, updates, env });
	await appendFnsNote({
		path: existing.path,
		content: buildClipUpdateAppend(existing.content, clippedAt, clipMethod),
		env,
	});
	return { mode: 'updated', path: existing.path };
}

async function createFnsNote({ path, content, env }) {
	const fnsRes = await fnsFetch(`${env.FNS_BASE}/api/note`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${env.FNS_TOKEN}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({ vault: env.FNS_VAULT, path, content }),
	});
	const fnsData = await safeJson(fnsRes);
	if (!fnsRes.ok || !fnsData?.status) {
		throw new Error(JSON.stringify(fnsData || { status: false, message: `HTTP ${fnsRes.status}` }));
	}
	return fnsData.data || { path };
}

async function findExistingNoteByUrl({ url, env }) {
	const params = new URLSearchParams({
		vault: env.FNS_VAULT,
		page: '1',
		pageSize: '3',
		keyword: url,
		searchMode: 'content',
		searchContent: 'true',
		sortBy: 'mtime',
		sortOrder: 'desc',
	});
	const res = await fnsFetch(`${env.FNS_BASE}/api/notes?${params.toString()}`, {
		headers: { Authorization: `Bearer ${env.FNS_TOKEN}` },
	});
	const data = await safeJson(res);
	if (!res.ok || !data?.status) {
		throw new Error(JSON.stringify(data || { status: false, message: `HTTP ${res.status}` }));
	}
	const list = Array.isArray(data?.data?.list) ? data.data.list : [];
	const candidates = list.filter((item) => typeof item?.path === 'string' && item.path);
	if (candidates.length === 0) return null;

	const fetchedNotes = await Promise.all(
		candidates.map(async (item) => {
			try {
				const note = await getFnsNote({ path: item.path, env });
				return { item, note };
			} catch (e) {
				console.warn('Skip FNS dedupe candidate:', item.path, e.message);
				return null;
			}
		})
	);

	for (const entry of fetchedNotes) {
		if (entry && noteContainsUrl(entry.note.content, url)) {
			return { path: entry.item.path, pathHash: entry.item.pathHash || '', content: entry.note.content };
		}
	}
	return null;
}

export async function fetchFnsFileContent({ path, env }) {
	const note = await getFnsNote({ path, env });
	return note.content;
}

export async function saveFileToFns({ path, content, env }) {
	const res = await fnsFetch(`${env.FNS_BASE}/api/note`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${env.FNS_TOKEN}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({ vault: env.FNS_VAULT, path, content }),
	});
	const data = await safeJson(res);
	if (!res.ok || !data?.status) {
		throw new Error(JSON.stringify(data || { status: false, message: `HTTP ${res.status}` }));
	}
	return data.data || { path };
}

async function getFnsNote({ path, env }) {
	const params = new URLSearchParams({ vault: env.FNS_VAULT, path });
	const res = await fnsFetch(`${env.FNS_BASE}/api/note?${params.toString()}`, {
		headers: { Authorization: `Bearer ${env.FNS_TOKEN}` },
	});
	const data = await safeJson(res);
	if (!res.ok || !data?.status || !data?.data?.content) {
		throw new Error(JSON.stringify(data || { status: false, message: `HTTP ${res.status}` }));
	}
	return data.data;
}

async function patchFnsFrontmatter({ path, updates, env }) {
	const res = await fnsFetch(`${env.FNS_BASE}/api/note/frontmatter`, {
		method: 'PATCH',
		headers: {
			Authorization: `Bearer ${env.FNS_TOKEN}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({ vault: env.FNS_VAULT, path, updates }),
	});
	const data = await safeJson(res);
	if (!res.ok || !data?.status) {
		throw new Error(JSON.stringify(data || { status: false, message: `HTTP ${res.status}` }));
	}
}

async function appendFnsNote({ path, content, env }) {
	const res = await fnsFetch(`${env.FNS_BASE}/api/note/append`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${env.FNS_TOKEN}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({ vault: env.FNS_VAULT, path, content }),
	});
	const data = await safeJson(res);
	if (!res.ok || !data?.status) {
		throw new Error(JSON.stringify(data || { status: false, message: `HTTP ${res.status}` }));
	}
}

function extractClipCount(content) {
	const match = String(content || '').match(/^clip_count:\s*(\d+)\s*$/m);
	return match ? Number(match[1]) || 0 : 0;
}

/**
 * Only treat a note as a match when frontmatter has an exact `url:` field
 * equal to the clipped URL. Avoid loose body/text includes which can
 * false-positive on notes that merely mention the URL.
 *
 * Exported for unit tests.
 * @param {string} content
 * @param {string} url
 * @returns {boolean}
 */
export function noteContainsUrl(content, url) {
	const target = String(url || '').trim();
	if (!target) return false;

	const text = String(content || '');
	const fmMatch = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
	const frontmatter = fmMatch ? fmMatch[1] : text;

	for (const line of frontmatter.split(/\r?\n/)) {
		const match = line.match(/^url:\s*(.+?)\s*$/);
		if (!match) continue;
		const raw = match[1].trim();
		const unquoted =
			(raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))
				? raw.slice(1, -1)
				: raw;
		if (unquoted === target) return true;
	}
	return false;
}

async function safeJson(response) {
	try {
		return await response.json();
	} catch {
		return null;
	}
}
