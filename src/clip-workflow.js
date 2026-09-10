// 阶段四C：异步剪藏 Workflow —— 治“客户端断开等待 = 整链全丢”。
// POST /json-async 把请求体投进 Workflow（202 + workflowId），引擎在服务端继续跑完
// 完整剪藏链（提取 → AI → 双写），客户端用 GET /clip-status 轮询拿结果。
//
// 关键约束（本地 workerd 实证，2026-09）：Workflow 类必须 extends WorkflowEntrypoint——
// plain class 能让 create() 成功，但 run() 一执行就炸
// "worker is not an actor but class name was requested"。
//
// 本仓库刻意不用 @cloudflare/vitest-pool-workers（纯 Node vitest，见 vitest.config.js），
// 两个 runtime 模块在测试环境由 test/mocks/cloudflare-workflows.js alias 提供 stub 基类。
//
// 模块指定符考证（2026-09-10 部署实证 + 官方文档 Workflows get-started/guide）：
// WorkflowEntrypoint 来自 `cloudflare:workers`，而不是 `cloudflare:workflows`！
// 后者在 prod 上传校验（10021 SyntaxError: does not provide an export named
// 'WorkflowEntrypoint'）和本地 dev（linking SyntaxError）里都没有该导出——
// 曾记录的「本地 emulation 缺 WorkflowEntrypoint」结论系误诊，真正的坑只是模块名写错。
// 另注：把类改成顶层动态 import + stub 基类同样过不了——上传校验器只认静态导出（
// "Workflow ClipWorkflow must be exported"），故必须静态 import 真模块。
import { WorkflowEntrypoint } from 'cloudflare:workers';

// 剪藏主体由 worker 入口注册进来（src/index.js 顶层 registerClipHandler(performJsonClip)）。
// 反向注入避免 clip-workflow → index.js 的循环 import。
let clipHandler = null;

export function registerClipHandler(fn) {
	clipHandler = fn;
}

export class ClipWorkflow extends WorkflowEntrypoint {
	async run(event, step) {
		return await step.do(
			'perform-clip',
			// 重试间隔 120s > ClipLock 的 90s TTL：重试时上次 attempt 的锁早已过期；
			// 幂等记录（阶段四A）+ 锁保证两次 attempt 不会双写 Telegraph/FNS。
			{ retries: { limit: 2, delay: 120000, backoff: 'constant' } },
			async () => {
				if (!clipHandler) {
					throw new Error('clip handler not registered (worker entry must call registerClipHandler)');
				}
				// 官方契约：create({ params: 对象 }) 的对象即 event.payload（不拆数组）。
				// 2026-09-10 prod 取证修正——旧版误信 params[0] 并真传数组导致 undefined.url。
				// 兼容层：payload 缺失退回 event.params；历史数组形态取 [0]。
				const raw = event.payload ?? event.params ?? {};
				const unwrapped = Array.isArray(raw) ? raw[0] : raw;
				const payload = unwrapped && typeof unwrapped === 'object' ? unwrapped : {};
				const response = await clipHandler(
					payload.requestBody,
					payload.requestUrl,
					this.env,
					payload.clipMethodHeader,
				);
				const body = await response.json();
				// 5xx = 上游/网络抖动，值得触发引擎重试；4xx = 请求本身的问题，重试无意义。
				if (response.status >= 500) {
					const preview = JSON.stringify(body ?? null)?.slice(0, 300) ?? '(unserializable body)';
					throw new Error(`clip attempt failed with status ${response.status}: ${preview}`);
				}
				// step 返回值必须可序列化（不能塞 Response 对象）。
				return { status: response.status, body };
			},
		);
	}
}
