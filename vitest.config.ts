import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['src/**/*.test.ts'],
		coverage: {
			provider: 'v8',
			include: ['src/changelistStore.ts', 'src/stashStore.ts', 'src/gitUtils.ts'],
			reporter: ['text', 'text-summary'],
			thresholds: {
				statements: 80,
				branches: 80,
				functions: 80,
				lines: 80,
			},
		},
	},
});
