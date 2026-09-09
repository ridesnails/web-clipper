// URL → KV 剪藏记录：双写幂等的第二支柱（阶段三）
// FNS 侧幂等靠 findExistingNoteByUrl（读 vault 内容查 URL），Telegraph 侧此前永远 createPage
// 造成重复页。这里把 url → { fnsPath, telegraphPath, telegraphUrl } 落 KV，
// 二次剪藏时 clipArticle 据此走 editPage 而非新建页面。
// key = clip:<sha256(url)>；CLIP_KV 未绑定（本地 vitest / 未部署 KV）时全部静默降级，不影响主链路。

export async function sha256Hex(text) {
	const data = new TextEncoder().encode(String(text));
	const digest = await crypto.subtle.digest('SHA-256', data);
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function getClipKey(url) {
	return `clip:${await sha256Hex(url)}`;
}

/**
 * 读取剪藏记录。任何失败（未绑定 KV / 网络损坏 / JSON 损坏）都返回 null，绝不阻断剪藏主链路。
 * @returns {Promise<{url?, title?, fnsPath?, telegraphPath?, telegraphUrl?, updatedAt?}|null>}
 */
export async function getClipRecord(url, env) {
	if (!env?.CLIP_KV || typeof env.CLIP_KV.get !== 'function') return null;
	try {
		const raw = await env.CLIP_KV.get(await getClipKey(url));
		if (!raw) return null;
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === 'object' ? parsed : null;
	} catch (e) {
		console.warn('Clip record read failed (ignored):', e.message);
		return null;
	}
}

/**
 * 写入剪藏记录。失败只告警不抛出——KV 故障不应让一次成功的剪藏返回 5xx。
 * @returns {Promise<boolean>}
 */
export async function putClipRecord(url, record, env) {
	if (!env?.CLIP_KV || typeof env.CLIP_KV.put !== 'function') return false;
	try {
		await env.CLIP_KV.put(await getClipKey(url), JSON.stringify(record));
		return true;
	} catch (e) {
		console.warn('Clip record write failed (ignored):', e.message);
		return false;
	}
}
