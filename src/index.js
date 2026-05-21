/**
 * Web Clipper Worker
 * 接收 URL，使用 Jina Reader 提取网页内容
 */

/**
 * 生成 CORS 响应头
 * @param {Object} env - 环境变量
 * @returns {Object} CORS headers
 */
function corsHeaders(env) {
	return {
		'Access-Control-Allow-Origin': env.CORS_ORIGIN || '*',
		'Access-Control-Allow-Methods': 'POST, OPTIONS',
		'Access-Control-Allow-Headers': 'Authorization, Content-Type',
	};
}

/**
 * 调用 Jina Reader API 提取网页内容，带重试机制
 * @param {string} targetUrl - 目标网页 URL
 * @param {Object} env - 环境变量
 * @returns {Promise<string>} 提取的文本内容
 */
async function fetchJinaContent(targetUrl, env) {
	const headers = {
		Accept: 'text/plain',
	};

	// 如果配置了 JINA_API_KEY，则添加认证头
	if (env.JINA_API_KEY) {
		headers['Authorization'] = `Bearer ${env.JINA_API_KEY}`;
	}

	let lastError;
	for (let attempt = 0; attempt <= 2; attempt++) {
		const res = await fetch(`https://r.jina.ai/${targetUrl}`, { headers });

		if (res.ok) {
			return await res.text();
		}

		// 遇到 429 或 5xx 错误时进行重试，最多重试 2 次
		if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
			lastError = new Error(`Jina returned ${res.status}`);
			if (attempt < 2) {
				// 指数退避：第一次 1s，第二次 2s
				await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
				continue;
			}
		}

		// 其他错误直接抛出，不再重试
		throw new Error(`Jina request failed: ${res.status}`);
	}

	throw lastError;
}

export default {
	async fetch(request, env, ctx) {
		const { pathname } = new URL(request.url);

		// 浏览器自动请求的 favicon.ico 直接返回 204，避免日志噪音
		if (pathname === '/favicon.ico') {
			return new Response(null, { status: 204 });
		}

		// 处理 CORS 预检请求
		if (request.method === 'OPTIONS') {
			return new Response(null, {
				status: 204,
				headers: corsHeaders(env),
			});
		}

		// HEAD、GET、PUT、DELETE 等不允许的方法统一返回 405
		if (request.method !== 'POST') {
			return new Response(`Method ${request.method} not allowed`, { status: 405 });
		}

		try {
			const { url: targetUrl } = await request.json();

			if (!targetUrl) {
				return new Response(JSON.stringify({ error: 'Missing url parameter' }), {
					status: 400,
					headers: {
						...corsHeaders(env),
						'Content-Type': 'application/json',
					},
				});
			}

			const content = await fetchJinaContent(targetUrl, env);

			return new Response(JSON.stringify({ content }), {
				status: 200,
				headers: {
					...corsHeaders(env),
					'Content-Type': 'application/json',
				},
			});
		} catch (err) {
			return new Response(JSON.stringify({ error: err.message }), {
				status: 500,
				headers: {
					...corsHeaders(env),
					'Content-Type': 'application/json',
				},
			});
		}
	},
};
