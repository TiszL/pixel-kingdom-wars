import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // landing-art/test: the Cloudfall showcase layouts and art pipeline (M47),
    // folded into the package run so CI and `pnpm -r test` execute them.
    include: ['src/**/*.test.ts', 'landing-art/test/**/*.test.ts'],
    // beforeAll may run the full 337-sprite pipeline when output is absent.
    hookTimeout: 600_000,
    testTimeout: 120_000,
  },
});
