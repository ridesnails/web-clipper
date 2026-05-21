import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
	test: {
		poolOptions: {
			workers: {
				wrangler: { configPath: './wrangler.jsonc' },
				miniflare: {
					compatibilityDate: '2026-05-14',
					compatibilityFlags: ['nodejs_compat'],
					vars: {
						API_KEY: 'test-api-key',
						FNS_BASE: 'https://fns.oba.plus',
						FNS_TOKEN: 'test-fns-token',
						FNS_VAULT: 'Clip',
						CLIP_FOLDER: 'Clippings',
					},
				},
			},
		},
	},
});
