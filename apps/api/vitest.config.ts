import { relative, sep } from 'node:path';
import { defineConfig } from 'vitest/config';
import { BaseSequencer, type TestSpecification } from 'vitest/node';
import { loadApiShardTimings, planApiShards } from './test/ciShards';

/** `--shard=i/n` (the CI API matrix) splits files by measured duration instead of
 * vitest's equal-file-count path hash; see test/ciShards.ts for why. Ordering inside a
 * shard and every run without --shard are unchanged. */
class DurationBalancedSequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const { config } = this.ctx;
    const { index, count } = config.shard!;
    const key = (spec: TestSpecification) => relative(config.root, spec.moduleId).split(sep).join('/');
    const plan = planApiShards(files.map(key), count, loadApiShardTimings().seconds);
    const mine = new Set(plan[index - 1]!.files);
    return files.filter(spec => mine.has(key(spec)));
  }
}

export default defineConfig({
  test: {
    globalSetup: ['./test/global-setup.ts'],
    setupFiles: ['./test/migrated-template-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // All suites share ONE Postgres test database (global-setup creates it).
    // Run files sequentially so a test that temporarily mutates a SHARED system
    // account (e.g. draining + restoring the emission pool to exercise the
    // lifetime-cap guard) cannot interleave with another file mid-mutation.
    fileParallelism: false,
    sequence: { sequencer: DurationBalancedSequencer },
  },
});
