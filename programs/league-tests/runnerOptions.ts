import { resolve } from 'node:path';

export interface LeagueRunnerOptions { fixtureModule: string; admissionReceipt: string }

/** An explicit selection prevents accidental discovery by existing regressions.
 * The receipt string is metadata, never proof of owner authorization. */
export function parseRunnerArgs(args: readonly string[]): LeagueRunnerOptions {
  const values = new Map<string, string>();
  const invalid = () => new Error('Explicit fixture and admission receipt are required');
  if (args.length !== 4) throw invalid();
  for (let at = 0; at < args.length; at += 2) {
    const flag = args[at], value = args[at + 1];
    if (!['--fixture', '--admission-receipt'].includes(flag) || values.has(flag)
      || typeof value !== 'string' || value.trim() === '') throw invalid();
    values.set(flag, value);
  }
  if (!values.has('--fixture') || !values.has('--admission-receipt')) throw invalid();
  return { fixtureModule: values.get('--fixture')!, admissionReceipt: values.get('--admission-receipt')! };
}

export function validateFixtureSelection(value: unknown, receipt: string): void {
  const fixture = value as { admissionReceipt?: unknown; provider?: { connection?: { rpcEndpoint?: unknown } } } | null;
  if (!fixture || !receipt.trim() || fixture.admissionReceipt !== receipt
    || typeof fixture.provider?.connection?.rpcEndpoint !== 'string') {
    throw new Error('Fixture selection does not match the explicit receipt');
  }
  let endpoint: URL;
  try { endpoint = new URL(fixture.provider.connection.rpcEndpoint); }
  catch { throw new Error('Fixture RPC must be local'); }
  if (endpoint.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)
    || endpoint.username !== '' || endpoint.password !== '') throw new Error('Fixture RPC must be local');
}

export function leagueTestFiles(directory: string): string[] {
  return ['runnerOptions.test.ts', 'runnerLifecycle.test.ts', 'leagueFixtureLifecycle.test.ts', 'leagueFixture.test.ts', 'committedFailure.test.ts', 'shardkeep-league.ts']
    .map((name) => resolve(directory, name));
}
