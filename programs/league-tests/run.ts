/** Explicit Cedar3 entry only, outside the default regression glob. N2 C1's
 * reviewed factory owns the local validator and in-memory test identities.
 * This entry installs no dependencies, builds nothing and never reads keys. */
import Mocha from 'mocha';
import { dirname, resolve } from 'node:path';
import { parseRunnerArgs } from './runnerOptions';
import { runLeagueSuite } from './runnerLifecycle';

async function main(): Promise<void> {
  const options = parseRunnerArgs(process.argv.slice(2));
  const runnerDirectory = dirname(resolve(process.argv[1]!));
  const failures = await runLeagueSuite(options, runnerDirectory, {
    loadBootstrap: (url) => import(url),
    runTests: async (files) => {
      const previousDirectory = process.cwd();
      try {
        process.chdir(resolve(runnerDirectory, '..'));
        const mocha = new Mocha({ ui: 'bdd', timeout: 360_000 });
        for (const file of files) mocha.addFile(file);
        await mocha.loadFilesAsync();
        return await new Promise<number>((done) => { mocha.run(done); });
      } finally {
        process.chdir(previousDirectory);
      }
    },
  });
  if (failures > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'League isolated runner failed');
  process.exitCode = 1;
});
