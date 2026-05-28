const AI_REQUEST_TIMEOUT_MS = 20000;

export async function generateAiMetadata({ title, url, body, env }) {
	if (!env.AI_API_KEY) return null;
	const baseUrl = (env.AI_BASE_URL || 'https://api.siliconflow.cn/v1').replace(/\/$/, '');
	const model = env.AI_MODEL || 'Qwen/Qwen3-8B';
	const prompt = [
		'请根据以下网页剪藏内容生成中文摘要和标签。',
		'要求：只返回 JSON，不要解释，不要 markdown 代码块。',
		'JSON 格式：{"summary":"不超过120字","tags":["标签1","标签2"]}',
		'标签要求：2到6个，简短，不带#。',
		`标题：${title}`,
		`原始链接：${url}`,
		'正文：',
		body.slice(0, 12000),
	].join('\n');
	const res = await fetch(`${baseUrl}/chat/completions`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${env.AI_API_KEY}`,
			'Content-Type': 'application/json',
		},
		signal: AbortSignal.timeout(AI_REQUEST_TIMEOUT_MS),
		body: JSON.stringify({
			model,
			temperature: 0.2,
			response_format: { type: 'json_object' },
			messages: [
				{ role: 'system', content: 'You generate concise article metadata in JSON.' },
				{ role: 'user', content: prompt },
			],
		}),
	});
	if (!res.ok) {
		const errText = await res.text();
		throw new Error(`AI metadata failed: ${res.status} ${errText}`);
	}
	const data = await res.json();
	const content = data?.choices?.[0]?.message?.content;
	if (!content) {
		throw new Error('AI metadata failed: empty response');
	}
	return parseAiJsonResponse(content);
}

function parseAiJsonResponse(text) {
	const trimmed = String(text || '').trim();
	const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
	const jsonText = fenced ? fenced[1] : trimmed;
	const parsed = JSON.parse(jsonText);
	const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
	const tags = Array.isArray(parsed.tags) ? [...new Set(parsed.tags.map((tag) => String(tag).trim()).filter(Boolean))].slice(0, 8) : [];
	return { summary, tags };
}
