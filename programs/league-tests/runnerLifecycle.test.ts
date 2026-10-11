/** N2 C1: lifecycle assertions authored before runner integration. No runtime. */
import { expect } from 'chai';
import { resolve } from 'node:path';
import { runLeagueSuite } from './runnerLifecycle';
import type { LeagueValidatorFixture } from './shardkeep-league';

const options = { fixtureModule: '/admitted/leagueFixture.ts', admissionReceipt: 'lantern-C1-admitted' };
const directory = '/owned/programs/league-tests';
const fixture = (receipt = options.admissionReceipt) => ({
  admissionReceipt: receipt,
  provider: { connection: { rpcEndpoint: 'http://127.0.0.1:18899' } },
}) as unknown as LeagueValidatorFixture;

function harness(overrides: { value?: LeagueValidatorFixture; failureCount?: number; suiteError?: Error; cleanupError?: Error } = {}) {
  const calls: string[] = [];
  const value = overrides.value ?? fixture();
  const factory = async (selection: unknown) => {
    calls.push('create');
    expect(selection).to.deep.equal({ admissionReceipt: options.admissionReceipt, programsDirectory: resolve(directory, '..') });
    return { fixture: value, dispose: async () => {
      calls.push('dispose');
      if (overrides.cleanupError) throw overrides.cleanupError;
    } };
  };
  return { calls, value, dependencies: {
    loadBootstrap: async (url: string) => {
      expect(url).to.equal('file:///admitted/leagueFixture.ts'); calls.push('load'); return { leagueFixture: factory };
    },
    runTests: async (files: string[]) => {
      calls.push('tests');
      expect(globalThis.__SHARDKEEP_LEAGUE_VALIDATOR_FIXTURE__).to.equal(value);
      expect(files).to.include(resolve(directory, 'leagueFixture.test.ts'));
      expect(files).to.include(resolve(directory, 'shardkeep-league.ts'));
      if (overrides.suiteError) throw overrides.suiteError;
      return overrides.failureCount ?? 0;
    },
  } };
}
const capture = async (run: () => Promise<unknown>) => {
  try { await run(); } catch (error) { return error; }
  throw new Error('Expected runner refusal');
};

describe('league admitted fixture lifecycle / N2 C1', () => {
  it('loads only the explicit factory, runs the selected suite and disposes exactly once', async () => {
    const h = harness();
    expect(await runLeagueSuite(options, directory, h.dependencies)).to.equal(0);
    expect(h.calls).to.deep.equal(['load', 'create', 'tests', 'dispose']);
  });
  it('returns a nonzero test count after disposing rather than turning failures into success', async () => {
    const h = harness({ failureCount: 3 });
    expect(await runLeagueSuite(options, directory, h.dependencies)).to.equal(3);
    expect(h.calls.at(-1)).to.equal('dispose');
  });
  it('disposes on suite loading or execution failure and preserves the original error', async () => {
    const failure = new Error('suite could not load'), h = harness({ suiteError: failure });
    expect(await capture(() => runLeagueSuite(options, directory, h.dependencies))).to.equal(failure);
    expect(h.calls.filter((x) => x === 'dispose')).to.have.length(1);
  });
  it('disposes an acquired fixture when receipt validation refuses before tests', async () => {
    const h = harness({ value: fixture('wrong-receipt') });
    const error = await capture(() => runLeagueSuite(options, directory, h.dependencies));
    expect((error as Error).message).to.include('Fixture selection does not match');
    expect(h.calls).to.deep.equal(['load', 'create', 'dispose']);
  });
  it('disposes an acquired fixture when its endpoint is not local', async () => {
    const value = fixture();
    (value.provider.connection as unknown as { rpcEndpoint: string }).rpcEndpoint = 'https://api.devnet.solana.com';
    const h = harness({ value });
    expect((await capture(() => runLeagueSuite(options, directory, h.dependencies)) as Error).message).to.include('Fixture RPC must be local');
    expect(h.calls).not.to.include('tests'); expect(h.calls.at(-1)).to.equal('dispose');
  });
  it('restores the earlier global fixture on successful and failed suite exits', async () => {
    const previous = globalThis.__SHARDKEEP_LEAGUE_VALIDATOR_FIXTURE__, sentinel = fixture('previous');
    globalThis.__SHARDKEEP_LEAGUE_VALIDATOR_FIXTURE__ = sentinel;
    try {
      const success = harness(); await runLeagueSuite(options, directory, success.dependencies);
      expect(globalThis.__SHARDKEEP_LEAGUE_VALIDATOR_FIXTURE__).to.equal(sentinel);
      const failure = harness({ suiteError: new Error('failed') });
      await capture(() => runLeagueSuite(options, directory, failure.dependencies));
      expect(globalThis.__SHARDKEEP_LEAGUE_VALIDATOR_FIXTURE__).to.equal(sentinel);
    } finally { globalThis.__SHARDKEEP_LEAGUE_VALIDATOR_FIXTURE__ = previous; }
  });
  it('surfaces cleanup failure even when tests succeeded', async () => {
    const failure = new Error('child failed to stop'), h = harness({ cleanupError: failure });
    expect(await capture(() => runLeagueSuite(options, directory, h.dependencies))).to.equal(failure);
  });
  it('retains a nonzero Mocha failure count alongside a cleanup error', async () => {
    const cleanupError = new Error('cleanup error'), h = harness({ failureCount: 3, cleanupError });
    const error = await capture(() => runLeagueSuite(options, directory, h.dependencies));
    expect(error).to.be.instanceOf(AggregateError);
    expect((error as Error).message).to.include('3 failed tests');
    expect((error as AggregateError).errors[1]).to.equal(cleanupError);
  });
  it('retains both test and cleanup errors if both fail', async () => {
    const suiteError = new Error('suite error'), cleanupError = new Error('cleanup error');
    const h = harness({ suiteError, cleanupError });
    const error = await capture(() => runLeagueSuite(options, directory, h.dependencies));
    expect(error).to.be.instanceOf(AggregateError);
    expect((error as AggregateError).errors).to.deep.equal([suiteError, cleanupError]);
  });
  it('refuses an eager fixture object instead of silently starting an unknown lifecycle', async () => {
    const h = harness();
    const error = await capture(() => runLeagueSuite(options, directory, { ...h.dependencies, loadBootstrap: async () => ({ leagueFixture: fixture() }) }));
    expect((error as Error).message).to.include('explicit leagueFixture factory');
    expect(h.calls).to.deep.equal([]);
  });
  it('requires an owned disposer before exposing the fixture to tests', async () => {
    const h = harness();
    const error = await capture(() => runLeagueSuite(options, directory, { ...h.dependencies,
      loadBootstrap: async () => ({ leagueFixture: async () => ({ fixture: fixture() }) }) }));
    expect((error as Error).message).to.include('fixture and disposer'); expect(h.calls).to.deep.equal([]);
  });
  it('does not run tests after factory startup failure', async () => {
    const h = harness(), failure = new Error('factory startup failed after owned cleanup');
    const error = await capture(() => runLeagueSuite(options, directory, { ...h.dependencies,
      loadBootstrap: async () => ({ leagueFixture: async () => { throw failure; } }) }));
    expect(error).to.equal(failure); expect(h.calls).to.deep.equal([]);
  });
  it('refuses invalid reported counts after disposing rather than accepting a false green', async () => {
    for (const failureCount of [-1, NaN, 1.5]) {
      const h = harness({ failureCount });
      expect((await capture(() => runLeagueSuite(options, directory, h.dependencies)) as Error).message).to.include('invalid failure count');
      expect(h.calls.at(-1)).to.equal('dispose');
    }
  });
});
