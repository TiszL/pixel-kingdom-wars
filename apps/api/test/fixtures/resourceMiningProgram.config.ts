/** One root-scheduled native-resource SQL + owned-validator boundary fixture. */
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: {
  include: ['test/fixtures/resourceMiningProgram.fixture.ts'],
  fileParallelism: false, testTimeout: 600_000, hookTimeout: 60_000,
} });
