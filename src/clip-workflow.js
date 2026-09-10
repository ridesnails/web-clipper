// 阶段四C：异步剪藏 Workflow —— 治“客户端断开等待 = 整链全丢”。
// POST /json-async 把请求体投进 Workflow（202 + workflowId），引擎在服务端继续跑完
// 完整剪藏链（提取 → AI → 双写），客户端用 GET /clip-status 轮询拿结果。
//
// 关键约束（本地 workerd 实证，2026-09）：Workflow 类必须 extends WorkflowEntrypoint——
// plain class 能让 create() 成功，但 run() 一执行就炸
// "worker is not an actor but class name was requested"。
//
// 本仓库刻意不用 @cloudflare/vitest-pool-workers（纯 Node vitest，见 vitest.config.js），
// `cloudflare:workflows` 在测试环境由 test/mocks/cloudflare-workflows.js alias 提供 stub 基类。
//
// 何时拿到哪个基类（本地 workerd 实证 2026-09，wrangler 4.91/4.130 × compat-flags 全矩阵）：
// - 真实 Workers runtime（deploy 后）＋ vitest（alias 指向 mocks）：模块提供真 WorkflowEntrypoint；
// - 本地 `wrangler dev`：workerd 的 cloudflare:workflows 模块只导出 NonRetryableError、
//   不提供 WorkflowEntrypoint，静态 import 会让 dev 启动即死（linking SyntaxError）。
// 因此这里改用运行时动态 import：真类存在就用真类；拿不到就降级本地 stub，
// dev 服务器照常启动、/json-async 202 全流程可达；run() 触发本地引擎缺口时
// 由下方 localStub 保护给出明确报错并进 terminal errored（见 run 开头）。
// 另：本地 emu 的实例句柄没有 instance.status()（实证同上），/clip-status 轮询
// 由 src/index.js 的同步守卫返回明确 errored 终态（而非误导性 404）。
let WorkflowEntrypoint;
try {
	({ WorkflowEntrypoint } = await import('cloudflare:workflows'));
} catch {
	// 模块整个不可用的极端环境——直接走下方 stub 降级。
}
if (typeof WorkflowEntrypoint !== 'function') {
	class LocalWorkflowStub {
		static localStub = true;
		constructor(ctx, env) {
			this.ctx = ctx;
			this.env = env;
		}
	}
	WorkflowEntrypoint = LocalWorkflowStub;
}

// 剪藏主体由 worker 入口注册进来（src/index.js 顶层 registerClipHandler(performJsonClip)）。
// 反向注入避免 clip-workflow → index.js 的循环 import。
let clipHandler = null;

export function registerClipHandler(fn) {
	clipHandler = fn;
}

export class ClipWorkflow extends WorkflowEntrypoint {
	async run(event, step) {
		if (this.constructor.localStub === true) {
			// 本地 dev 无真 workflow 引擎（见文件头 2026-09 实证注释）：
			// 不伪装成功，直接给明确错误 → 门面发 terminal errored。
			throw new Error(
				'clip workflow requires the real Workers runtime; local `wrangler dev` cannot execute workflows (WorkflowEntrypoint unavailable in local emulation)',
			);
		}
		return await step.do(
			'perform-clip',
			// 重试间隔 120s > ClipLock 的 90s TTL：重试时上次 attempt 的锁早已过期；
			// 幂等记录（阶段四A）+ 锁保证两次 attempt 不会双写 Telegraph/FNS。
			{ retries: { limit: 2, delay: 120000, backoff: 'constant' } },
			async () => {
				if (!clipHandler) {
					throw new Error('clip handler not registered (worker entry must call registerClipHandler)');
				}
				// 官方 event.payload = create() 传入 params[0]；对 params 数组形态留一个兜底。
				const payload = event.payload ?? event.params?.[0] ?? {};
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
