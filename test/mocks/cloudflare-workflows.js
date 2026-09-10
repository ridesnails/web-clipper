// `cloudflare:workers`（WorkflowEntrypoint 真身所在，2026-09-10 考证）与 `cloudflare:workflows`
// （无 WorkflowEntrypoint 导出）的纯 Node stub，vitest.config.js 双 alias 都指到这。
// 只提供语法面：WorkflowEntrypoint 基类持有 ctx/env；
// 重试/暂挂/可观测性等真实行为由 workerd 引擎负责，测试里用 fake step 复现调用语义。
export class WorkflowEntrypoint {
	constructor(ctx, env) {
		this.ctx = ctx;
		this.env = env;
	}
}
