import { fetchWithTimeout } from './http.js';

const AI_REQUEST_TIMEOUT_MS = 20000;

// 长文只送头尾（头 9000 + 尾 3000，总预算与旧版 12000 一致）：
// 只取头部会丢结尾，摘要/标签两端信息都有价值；中间以省略标记衔接。
const PROMPT_BODY_HEAD_CHARS = 9000;
const PROMPT_BODY_TAIL_CHARS = 3000;

export function truncateBodyForPrompt(body) {
	const text = String(body || '');
	if (text.length <= PROMPT_BODY_HEAD_CHARS + PROMPT_BODY_TAIL_CHARS) return text;
	return `${text.slice(0, PROMPT_BODY_HEAD_CHARS)}\n……（中间内容省略）……\n${text.slice(-PROMPT_BODY_TAIL_CHARS)}`;
}

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
		truncateBodyForPrompt(body),
	].join('\n');
	const res = await fetchWithTimeout(
		`${baseUrl}/chat/completions`,
		{
			method: 'POST',
			headers: {
				Authorization: `Bearer ${env.AI_API_KEY}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				model,
				temperature: 0.2,
				// json_object 模式多数 OpenAI 兼容端点支持；个别端点不认会 400，
				// 设 AI_JSON_MODE=off 关闭（未设置 = 默认开启，维持原行为）。
				...(env.AI_JSON_MODE === 'off' ? {} : { response_format: { type: 'json_object' } }),
				messages: [
					{ role: 'system', content: 'You generate concise article metadata in JSON.' },
					{ role: 'user', content: prompt },
				],
			}),
		},
		{ timeoutMs: AI_REQUEST_TIMEOUT_MS, retries: 1, delaysMs: [1000], retryOnStatuses: [429, 500, 502, 503, 504] }
	);
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
