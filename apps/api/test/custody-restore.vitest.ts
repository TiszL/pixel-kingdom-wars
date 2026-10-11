/** Explicit destructive-fixture rehearsal only; ordinary Vitest discovery does
 * not select *.rehearsal.ts. The test verifies its disposable container first. */
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: {
 include: ['./test/fixtures/custodyRestore.rehearsal.ts'],
 fileParallelism: false, testTimeout: 240_000, hookTimeout: 60_000,
} });
