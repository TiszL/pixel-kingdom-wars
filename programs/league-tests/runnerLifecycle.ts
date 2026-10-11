import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { leagueTestFiles, validateFixtureSelection } from './runnerOptions';
import type { LeagueRunnerOptions } from './runnerOptions';
import type { LeagueValidatorFixture } from './shardkeep-league';

export interface LeagueFixtureSelection { admissionReceipt: string; programsDirectory: string }
export interface LeagueFixtureHandle { fixture: LeagueValidatorFixture; dispose(): Promise<void> }
export interface LeagueRunnerDependencies {
  loadBootstrap(url: string): Promise<unknown>;
  runTests(files: string[]): Promise<number>;
}

/** Only Cedar3 invokes the reviewed factory. A module import alone owns no
 * validator. Once a handle exists, every exit path awaits its owned cleanup. */
export async function runLeagueSuite(
  options: LeagueRunnerOptions,
  runnerDirectory: string,
  dependencies: LeagueRunnerDependencies,
): Promise<number> {
  const bootstrap = await dependencies.loadBootstrap(pathToFileURL(resolve(options.fixtureModule)).href);
  const create = (bootstrap as { leagueFixture?: unknown } | null)?.leagueFixture;
  if (typeof create !== 'function') throw new Error('Bootstrap must export an explicit leagueFixture factory');
  const handle = await (create as (selection: LeagueFixtureSelection) => Promise<LeagueFixtureHandle>)({
    admissionReceipt: options.admissionReceipt,
    programsDirectory: resolve(runnerDirectory, '..'),
  });
  if (!handle || typeof handle !== 'object' || typeof handle.dispose !== 'function') {
    throw new Error('Bootstrap must return its fixture and disposer');
  }
  const previous = globalThis.__SHARDKEEP_LEAGUE_VALIDATOR_FIXTURE__;
  let failed = false, failure: unknown, count = 0;
  try {
    validateFixtureSelection(handle.fixture, options.admissionReceipt);
    globalThis.__SHARDKEEP_LEAGUE_VALIDATOR_FIXTURE__ = handle.fixture;
    count = await dependencies.runTests(leagueTestFiles(runnerDirectory));
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('League suite reported an invalid failure count');
  } catch (error: unknown) {
    failed = true; failure = error;
  } finally {
    globalThis.__SHARDKEEP_LEAGUE_VALIDATOR_FIXTURE__ = previous;
  }
  try {
    await handle.dispose();
  } catch (cleanupError: unknown) {
    if (failed) throw new AggregateError([failure, cleanupError], 'League suite and fixture cleanup failed');
    if (count > 0) throw new AggregateError([new Error(`League suite reported ${count} failed tests`), cleanupError],
      `League suite reported ${count} failed tests and fixture cleanup failed`);
    throw cleanupError;
  }
  if (failed) throw failure;
  return count;
}
