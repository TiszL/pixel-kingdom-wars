/** R4: authored before the isolated runner; no runtime admission is inferred. */
import { expect } from 'chai';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { parseRunnerArgs, validateFixtureSelection, leagueTestFiles } from './runnerOptions';

describe('league isolated runner selection / R4', () => {
  it('requires both an explicit fixture module and matching receipt selection', () => {
    expect(parseRunnerArgs(['--fixture', './admitted-fixture.ts', '--admission-receipt', 'owner-row-local-1']))
      .to.deep.equal({ fixtureModule: './admitted-fixture.ts', admissionReceipt: 'owner-row-local-1' });
    expect(parseRunnerArgs(['--admission-receipt', 'row', '--fixture', './fixture.ts']))
      .to.deep.equal({ fixtureModule: './fixture.ts', admissionReceipt: 'row' });
  });

  for (const args of [[], ['--fixture', 'fixture.ts'], ['--fixture', 'f', '--admission-receipt', ''],
    ['--fixture', 'f', '--fixture', 'g'], ['--fixture', 'f', '--unknown', 'row'],
    ['--fixture', 'f', '--admission-receipt', 'row', 'extra']]) {
    it(`refuses incomplete, duplicate or unknown runner arguments ${JSON.stringify(args)}`, () => {
      expect(() => parseRunnerArgs(args)).to.throw('Explicit fixture and admission receipt are required');
    });
  }

  const selected = (endpoint: string, receipt = 'row') => ({
    admissionReceipt: receipt, provider: { connection: { rpcEndpoint: endpoint } },
  });
  it('accepts local endpoint metadata only when its receipt matches the explicit selection', () => {
    for (const endpoint of ['http://127.0.0.1:18899', 'http://localhost:18899', 'http://[::1]:18899']) {
      expect(() => validateFixtureSelection(selected(endpoint), 'row')).not.to.throw();
    }
  });
  it('rejects missing fixtures and mismatched receipt metadata before suite loading', () => {
    for (const fixture of [null, {}, selected('http://localhost:18899', 'different')]) {
      expect(() => validateFixtureSelection(fixture, 'row')).to.throw('Fixture selection does not match');
    }
  });
  it('rejects public RPC and authenticated URLs before suite loading', () => {
    for (const endpoint of ['https://api.devnet.solana.com', 'http://example.com:18899',
      'http://user:password@localhost:18899', 'file:///tmp/local-validator']) {
      expect(() => validateFixtureSelection(selected(endpoint), 'row')).to.throw('Fixture RPC must be local');
    }
  });
  it('selects only explicit league files outside the established tests glob', () => {
    const directory = resolve(process.cwd(), 'league-tests');
    const files = leagueTestFiles(directory);
    expect(files).to.deep.equal(['runnerOptions.test.ts', 'runnerLifecycle.test.ts', 'leagueFixtureLifecycle.test.ts', 'leagueFixture.test.ts', 'committedFailure.test.ts', 'shardkeep-league.ts']
      .map((name) => resolve(directory, name)));
    expect(files.every((file) => dirname(file) === directory)).to.equal(true);
    expect(files.some((file) => file.endsWith('/run.ts'))).to.equal(false);
    expect(existsSync(resolve(process.cwd(), 'tests/shardkeep-league.ts'))).to.equal(false);
    const anchor = readFileSync(resolve(process.cwd(), 'Anchor.toml'), 'utf8');
    expect(anchor).to.include('tests/**/*.ts');
    expect(anchor).not.to.include('league-tests/');
    const tsconfig = JSON.parse(readFileSync(resolve(process.cwd(), 'tsconfig.json'), 'utf8'));
    expect(tsconfig.include).to.include('tests/**/*.ts');
    expect(tsconfig.include).not.to.include('league-tests/**/*.ts');
    const isolated = JSON.parse(readFileSync(resolve(directory, 'tsconfig.json'), 'utf8'));
    expect(isolated.extends).to.equal('../tsconfig.json');
    expect(isolated.compilerOptions.noEmit).to.equal(true);
    expect(isolated.include).to.deep.equal(['./*.ts', '../target/types/shardkeep_league.ts']);
  });
});
