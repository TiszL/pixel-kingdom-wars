/** Explicit root-scheduled DB + owned-validator fixture; not a default API suite. */
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: {
  include: ['test/fixtures/fundedMiningProgram.fixture.ts'],
  fileParallelism: false, testTimeout: 600_000, hookTimeout: 60_000,
} });
