// CORS 响应头
function corsHeaders(env) {
	return {
		'Access-Control-Allow-Origin': env.CORS_ORIGIN || '*',
		'Access-Control-Allow-Methods': 'POST, OPTIONS',
		'Access-Control-Allow-Headers': 'Authorization, Content-Type',
	};
}

export default {
	async fetch(request, env) {
		const { pathname } = new URL(request.url);

		// 浏览器自动请求的 favicon.ico 直接返回 204，避免日志噪音
		if (pathname === '/favicon.ico') {
			return new Response(null, { status: 204 });
		}

		// 处理 CORS 预检请求
		if (request.method === 'OPTIONS') {
			return new Response(null, { status: 204, headers: corsHeaders(env) });
		}

		// HEAD、GET、PUT、DELETE 等不允许的方法统一返回 405
		if (request.method !== 'POST') {
			return Response.json({ error: 'Method not allowed. Use POST.' }, { status: 405, headers: corsHeaders(env) });
		}

		// —— 第一关：密码校验 ——
		const auth = request.headers.get('Authorization');
		if (auth !== `Bearer ${env.API_KEY}`) {
			return Response.json({ error: 'Unauthorized' }, { status: 401, headers: corsHeaders(env) });
		}

		// —— 第二关：解析 body ——
		let reqBody;
		try {
			reqBody = await request.json();
		} catch {
			return Response.json({ error: 'Invalid JSON body' }, { status: 400, headers: corsHeaders(env) });
		}
		const url = reqBody.url;
		if (!url || typeof url !== 'string') {
			return Response.json({ error: "Missing 'url' field" }, { status: 400, headers: corsHeaders(env) });
		}
		if (!isValidUrl(url)) {
			return Response.json({ error: 'Invalid url (must be http or https)' }, { status: 400, headers: corsHeaders(env) });
		}

		// —— 第三关：用 jina 把网页转成 Markdown ——
		let markdown;
		try {
			const jinaHeaders = { Accept: 'text/plain' };
			// 如果配置了 JINA_API_KEY，则添加认证头
			if (env.JINA_API_KEY) {
				jinaHeaders.Authorization = `Bearer ${env.JINA_API_KEY}`;
			}

			let jinaRes;
			let lastErr;
			for (let attempt = 0; attempt <= 2; attempt++) {
				if (attempt > 0) {
					const delay = attempt === 1 ? 1000 : 2000;
					await new Promise((r) => setTimeout(r, delay));
				}
				jinaRes = await fetch(`https://r.jina.ai/${url}`, {
					headers: jinaHeaders,
					signal: AbortSignal.timeout(25000), // 25 秒超时
				});
				if (jinaRes.ok) {
					break;
				}
				const errText = await jinaRes.text();
				lastErr = `${jinaRes.status} ${errText}`;
				console.error('Jina returned non-200:', url, jinaRes.status, errText);
				const shouldRetry = jinaRes.status === 429 || jinaRes.status >= 500;
				if (!shouldRetry || attempt === 2) {
					return Response.json({ error: `Jina fetch failed: ${lastErr}` }, { status: 502, headers: corsHeaders(env) });
				}
			}
			markdown = await jinaRes.text();
		} catch (e) {
			console.error('Jina fetch failed:', url, e.message);
			return Response.json({ error: `Jina error: ${e.message}` }, { status: 502, headers: corsHeaders(env) });
		}

		// —— 第四关：抽标题、清理正文、生成文件路径 ——
		const title = extractTitle(markdown) || 'untitled';
		const slug = makeSlug(title);
		const now = new Date();
		const yyyymm = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
		const path = `${env.CLIP_FOLDER}/${yyyymm}/${slug}.md`;

		// 剥掉 jina 的元信息头，拼带 frontmatter 的最终内容
		const cleanBody = cleanJinaBody(markdown);
		const content = buildNote({ title, url, date: now.toISOString(), body: cleanBody });

		// —— 第五关：写入 FNS ——
		try {
			const fnsRes = await fetch(`${env.FNS_BASE}/api/note`, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${env.FNS_TOKEN}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					vault: env.FNS_VAULT,
					path: path,
					content: content,
				}),
			});
			const fnsData = await fnsRes.json();
			if (!fnsData.status) {
				console.error('FNS write failed:', path, JSON.stringify(fnsData));
				return Response.json({ error: `FNS write failed: ${JSON.stringify(fnsData)}` }, { status: 502, headers: corsHeaders(env) });
			}
			console.log('Clipped:', title, '->', path);
			return Response.json(
				{
					ok: true,
					title: title,
					path: path,
				},
				{ headers: corsHeaders(env) }
			);
		} catch (e) {
			console.error('FNS write failed:', path, e.message);
			return Response.json({ error: `FNS error: ${e.message}` }, { status: 502, headers: corsHeaders(env) });
		}
	},
};

// —— 工具函数 ——

// 检查 URL 是否合法且是 http/https
function isValidUrl(s) {
	try {
		const u = new URL(s);
		return u.protocol === 'http:' || u.protocol === 'https:';
	} catch {
		return false;
	}
}

// 从 jina 返回的 markdown 抽标题
// 1) 优先 "Title: xxx"，但要求非空且不是 URL
// 2) 否则找第一个 H1
// 3) 都没有就返回 null
function extractTitle(md) {
	const titleMatch = md.match(/^Title:\s*(.+)$/m);
	if (titleMatch) {
		const t = titleMatch[1].trim();
		if (t && !t.startsWith('http')) return t;
	}
	const h1Match = md.match(/^#\s+(.+)$/m);
	if (h1Match) return h1Match[1].trim();
	return null;
}

// 把任意字符串变成安全的文件名
function makeSlug(title) {
	return (
		title
			.replace(/[\/\\:*?"<>|#\[\]]/g, '') // 去掉文件系统和 Obsidian 不允许的字符
			.replace(/\s+/g, '-') // 空格 → 横线
			.replace(/-+/g, '-') // 多个横线合并
			.slice(0, 80) // 最长 80 字符
			.trim() || 'untitled'
	);
}

// 剥掉 jina 返回里的元信息头，只保留正文
// jina 通常的格式是：
//   Title: xxx
//   URL Source: xxx
//   Published Time: xxx
//   Markdown Content:
//   <空行>
//   <真正的正文>
function cleanJinaBody(md) {
	// 找 "Markdown Content:" 这个分界线，从它之后开始截
	const marker = /^Markdown Content:\s*$/m;
	const m = md.match(marker);
	if (m) {
		return md.slice(m.index + m[0].length).replace(/^\s+/, '');
	}
	// 没找到分界线就保守地剥掉开头几行已知的 jina 元信息
	return md
		.replace(/^Title:.*$/m, '')
		.replace(/^URL Source:.*$/m, '')
		.replace(/^Published Time:.*$/m, '')
		.replace(/^Markdown Content:.*$/m, '')
		.replace(/^\s+/, '');
}

// 拼带 frontmatter 的 markdown 文件
function buildNote({ title, url, date, body }) {
	// YAML frontmatter 里的字符串需要转义双引号
	const safeTitle = title.replace(/"/g, '\\"');
	return `---\ntitle: "${safeTitle}"\nurl: ${url}\ndate: ${date}\nsource: clipper\n---\n\n${body}`;
}

export { isValidUrl, extractTitle, makeSlug, cleanJinaBody, buildNote };
