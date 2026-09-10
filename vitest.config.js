import { defineConfig } from 'vitest/config';

export default defineConfig({
	resolve: {
		// `cloudflare:workflows` 只在 workerd 里存在；纯 Node vitest 用 stub 基类顶替。
		// 两个 runtime 模块（cloudflare:workers / cloudflare:workflows）都指到同一 stub。
		alias: [
			{ find: 'cloudflare:workers', replacement: new URL('./test/mocks/cloudflare-workflows.js', import.meta.url).pathname },
			{ find: 'cloudflare:workflows', replacement: new URL('./test/mocks/cloudflare-workflows.js', import.meta.url).pathname },
		],
	},
	test: {
		environment: 'node',
		exclude: ['**/.snow/**', '**/node_modules/**'],
	},
});
