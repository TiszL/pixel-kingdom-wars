import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createDb } from './client';
import { fundWelcomeGemsBudget, validCohortDay, type WelcomeBudgetRequest } from './welcomeGemsBudget';

/** Deliberately no .env/config defaults: an operator must name the target and
 * every spending input. Do not print the URL (it contains credentials). */
export function parseWelcomeBudgetArgs(argv: readonly string[]): {
  databaseUrl: string; request: Omit<WelcomeBudgetRequest, 'buildSha'>;
} {
  const values = new Map<string, string>();
  let apply = false;
  const flags = new Set(['--database-url', '--expected-db', '--cluster', '--keep', '--max-keep', '--cohort-day', '--idempotency-key']);
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (flag === '--apply' && !apply) { apply = true; continue; }
    if (!flags.has(flag) || values.has(flag) || !argv[i + 1] || argv[i + 1]!.startsWith('--')) throw new Error('unknown, duplicate, or incomplete argument');
    values.set(flag, argv[++i]!);
  }
  for (const flag of flags) if (!values.has(flag)) throw new Error(`explicit ${flag} is required`);
  let url: URL;
  try { url = new URL(values.get('--database-url')!); } catch { throw new Error('invalid database URL'); }
  const expectedDatabase = values.get('--expected-db')!;
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || decodeURIComponent(url.pathname.slice(1)) !== expectedDatabase
    || !url.hostname || !url.username || !/^[A-Za-z0-9_-]+$/.test(expectedDatabase)) throw new Error('database URL does not name the expected database');
  const amount = (flag: string) => {
    const value = values.get(flag)!;
    if (!/^[1-9][0-9]{0,18}$/.test(value) || BigInt(value) > 9_223_372_036_854_775_807n) throw new Error(`${flag} requires a positive whole KEEP amount`);
    return BigInt(value);
  };
  const cohortDay = values.get('--cohort-day')!;
  if (!validCohortDay(cohortDay)) throw new Error('invalid cohort day');
  if (values.get('--cluster') !== 'devnet') throw new Error('this policy is devnet only');
  return { databaseUrl: url.toString(), request: { expectedDatabase, cluster: 'devnet', keep: amount('--keep'), maxKeep: amount('--max-keep'),
    cohortDay, idempotencyKey: values.get('--idempotency-key')!, apply } };
}

async function main(): Promise<void> {
  const parsed = parseWelcomeBudgetArgs(process.argv.slice(2));
  const buildSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fileURLToPath(new URL('../../../../', import.meta.url)), encoding: 'utf8' }).trim();
  const connection = createDb(parsed.databaseUrl, { max: 1 });
  try { console.log(JSON.stringify(await fundWelcomeGemsBudget(connection.db, { ...parsed.request, buildSha }), null, 2)); }
  finally { await connection.sql.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'funding failed'); process.exitCode = 1; });
}
