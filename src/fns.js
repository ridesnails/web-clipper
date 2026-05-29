import { buildClipUpdateAppend } from './note.js';

const FNS_REQUEST_TIMEOUT_MS = 15000;

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
	const fnsRes = await fetch(`${env.FNS_BASE}/api/note`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${env.FNS_TOKEN}`,
			'Content-Type': 'application/json',
		},
		signal: AbortSignal.timeout(FNS_REQUEST_TIMEOUT_MS),
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
	const res = await fetch(`${env.FNS_BASE}/api/notes?${params.toString()}`, {
		headers: { Authorization: `Bearer ${env.FNS_TOKEN}` },
		signal: AbortSignal.timeout(FNS_REQUEST_TIMEOUT_MS),
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
	const res = await fetch(`${env.FNS_BASE}/api/note`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${env.FNS_TOKEN}`,
			'Content-Type': 'application/json',
		},
		signal: AbortSignal.timeout(FNS_REQUEST_TIMEOUT_MS),
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
	const res = await fetch(`${env.FNS_BASE}/api/note?${params.toString()}`, {
		headers: { Authorization: `Bearer ${env.FNS_TOKEN}` },
		signal: AbortSignal.timeout(FNS_REQUEST_TIMEOUT_MS),
	});
	const data = await safeJson(res);
	if (!res.ok || !data?.status || !data?.data?.content) {
		throw new Error(JSON.stringify(data || { status: false, message: `HTTP ${res.status}` }));
	}
	return data.data;
}

async function patchFnsFrontmatter({ path, updates, env }) {
	const res = await fetch(`${env.FNS_BASE}/api/note/frontmatter`, {
		method: 'PATCH',
		headers: {
			Authorization: `Bearer ${env.FNS_TOKEN}`,
			'Content-Type': 'application/json',
		},
		signal: AbortSignal.timeout(FNS_REQUEST_TIMEOUT_MS),
		body: JSON.stringify({ vault: env.FNS_VAULT, path, updates }),
	});
	const data = await safeJson(res);
	if (!res.ok || !data?.status) {
		throw new Error(JSON.stringify(data || { status: false, message: `HTTP ${res.status}` }));
	}
}

async function appendFnsNote({ path, content, env }) {
	const res = await fetch(`${env.FNS_BASE}/api/note/append`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${env.FNS_TOKEN}`,
			'Content-Type': 'application/json',
		},
		signal: AbortSignal.timeout(FNS_REQUEST_TIMEOUT_MS),
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

function noteContainsUrl(content, url) {
	const text = String(content || '');
	return text.includes(`url: ${url}`) || text.includes(`[原文链接](${url})`);
}

async function safeJson(response) {
	try {
		return await response.json();
	} catch {
		return null;
	}
}
