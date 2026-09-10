// `cloudflare:workflows` 的纯 Node stub（vitest.config.js 的 alias 指到这）。
// 只提供语法面：WorkflowEntrypoint 基类持有 ctx/env；
// 重试/暂挂/可观测性等真实行为由 workerd 引擎负责，测试里用 fake step 复现调用语义。
export class WorkflowEntrypoint {
	constructor(ctx, env) {
		this.ctx = ctx;
		this.env = env;
	}
}
