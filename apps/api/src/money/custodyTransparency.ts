/** Read-only phase metadata, separate from cached coverage and historical roots.
 * The only admitted journal writer is fixture-only. Its recorded arithmetic is
 * NOT proof of controlled reserves, a production cutover, or operator approval. */
import { GEMS } from '@shardkeep/shared';
import { sql } from 'drizzle-orm';
import type { Db } from '../db/client';

const phases = ['open','fenced','withdrawals_closed','frozen','retired'] as const;
type Phase = typeof phases[number];
type Evidence = {status:'none'|'unknown'} | {status:'fixture_recorded'; recordedAt:string;
  keepConverted:string; gemsMinted:string; internalKeepSwept:string};
export interface CustodyTransparency {
  phase:Phase|'unknown'; changedAt:string|null; evidence:Evidence; reserveAttested:false;
}
const unknown = (): CustodyTransparency => ({phase:'unknown',changedAt:null,
  evidence:{status:'unknown'},reserveAttested:false});
const liabilities = ['playerKeep','withdrawalEscrow','forgePayoutEscrow','leagueEntitlementEscrow','mailKeepEscrow'] as const;
const fields = [...liabilities,'emissionPool','gemsMintedRetirement'] as const;
function ledger(value: unknown): Record<typeof fields[number],bigint>|null {
  if (!value || typeof value !== 'object') return null;
  const r = value as Record<string,unknown>;
  if (!fields.every(k => typeof r[k] === 'string' && /^(0|[1-9]\d*)$/.test(r[k] as string))) return null;
  return Object.fromEntries(fields.map(k => [k,BigInt(r[k] as string)])) as Record<typeof fields[number],bigint>;
}
function timestamp(value: unknown): string|null {
  if (!(value instanceof Date) && typeof value !== 'string') return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export async function readCustodyTransparency(db: Db): Promise<CustodyTransparency> {
  try {
    // One MVCC statement observes the latch and journal together. The output
    // remains independent of /por's separately cached RPC-backed coverage.
    // A second journal is ambiguous, not another amount to sum into a claim.
    const rows = await db.execute<Record<string,unknown>>(sql`
      select s.phase,s.changed_at as "changedAt",j.scope,j.subcommand,j.dry_run as "dryRun",
        j.before_state as "beforeState",j.after_state as "afterState",j.created_at as "createdAt"
      from public.keep_custody_cutover_state s left join public.keep_custody_journal j on true
      where s.id limit 2`);
    if (rows.length !== 1) return unknown();
    const row = rows[0]!;
    if (!phases.includes(row['phase'] as Phase)) return unknown();
    const changedAt = timestamp(row['changedAt']);
    if (!changedAt) return unknown();
    const phase = row['phase'] as Phase;
    const result: CustodyTransparency = {phase,changedAt,evidence:{status:'unknown'},reserveAttested:false};
    if (row['scope'] === null && ['open','fenced','withdrawals_closed'].includes(phase)) {
      result.evidence = {status:'none'};
      return result;
    }
    const recordedAt = timestamp(row['createdAt']);
    if (!['frozen','retired'].includes(phase) || row['scope'] !== 'fixture' || row['dryRun'] !== false
      || !['retire-l1','retire-l1-mail','retire-l1-mail-forge'].includes(row['subcommand'] as string)
      || !recordedAt) return result;
    const before = ledger(row['beforeState']), after = ledger(row['afterState']);
    if (!before || !after || liabilities.some(k => after[k] !== 0n)) return result;
    const retired = liabilities.reduce((sum,k) => sum + before[k],0n);
    const gems = after.gemsMintedRetirement - before.gemsMintedRetirement;
    const rate = BigInt(GEMS.gemsPerKeep);
    if (after.emissionPool - before.emissionPool !== retired || gems < 0n
      || gems % rate !== 0n || gems / rate > retired) return result;
    result.evidence = {status:'fixture_recorded',recordedAt,keepConverted:(gems/rate).toString(),
      gemsMinted:gems.toString(),internalKeepSwept:(retired-gems/rate).toString()};
    return result;
  } catch {
    // Missing migration or revoked journal access must not break legacy PoR,
    // and must never turn inaccessible evidence into a zero or success claim.
    return unknown();
  }
}
