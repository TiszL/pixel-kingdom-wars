import { defineConfig } from 'vitest/config';

/** Dedicated .fixture.ts selection; deliberately does not import default shared-DB globalSetup. */
export default defineConfig({
  test: {
    include: ['test/migration-0146-history-repair.fixture.ts'],
    environment: 'node',
    fileParallelism: false,
    maxWorkers: 1,
    passWithNoTests: false,
  },
});
