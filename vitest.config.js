import { defineConfig } from 'vitest/config';

export default defineConfig({
	resolve: {
		// `cloudflare:workflows` 只在 workerd 里存在；纯 Node vitest 用 stub 基类顶替。
		alias: [{ find: 'cloudflare:workflows', replacement: new URL('./test/mocks/cloudflare-workflows.js', import.meta.url).pathname }],
	},
	test: {
		environment: 'node',
		exclude: ['**/.snow/**', '**/node_modules/**'],
	},
});
