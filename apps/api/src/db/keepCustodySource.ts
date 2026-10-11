/** D153.186 prospective source retention. Private local rehearsals only. */
import { sql } from 'drizzle-orm';
import { createDb, type Db, type DbTx } from './client';

export interface KeepCustodySourceProof {
  genesisHash: string; mint: string; custodyOwner: string; destination: string;
  signature: string; observedAt: string; amountBaseUnits: string; messageHash: string;
  transaction: Record<string, unknown>;
}
export type KeepSourceConnect = (url: string) => { db: Db; close: () => Promise<void> };
export const connectKeepSource: KeepSourceConnect = url => {
  const c = createDb(url, { max: 1 }); return { db: c.db, close: () => c.sql.end() };
};
export function keepSourceFixtureUrl(env: NodeJS.ProcessEnv): string {
  if (env['HOLD_BEFORE_MIGRATE'] !== '1' || !env['TEST_DATABASE_URL']) throw new Error('CUSTODY_FIXTURE_REQUIRED');
  const url = new URL(env['TEST_DATABASE_URL']);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || !/^shardkeep_custody_apply_[0-9a-f]{32}_test$/.test(url.pathname.slice(1)) || url.search || url.hash)
    throw new Error('CUSTODY_FIXTURE_REQUIRED');
  return url.toString();
}
export function assertKeepSourceId(id: string): void {
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) throw new Error('KEEP_SOURCE_INPUT');
}

/** Called only on a new positive /paid pin, in the same transaction. */
export async function retainKeepCustodyConfirmed(tx: DbTx, depositId: string, proof: KeepCustodySourceProof): Promise<void> {
  await tx.execute(sql`select public.shardkeep_retain_keep_source(${depositId}::uuid,'confirmed',${JSON.stringify(proof)}::jsonb)`);
}

export async function closeFixtureKeepCustodyWindow(request: { windowId: string }, env: NodeJS.ProcessEnv,
  connect: KeepSourceConnect = connectKeepSource): Promise<{ windowId: string; closedAt: string; inventory: unknown[] }> {
  assertKeepSourceId(request.windowId);
  const c = connect(keepSourceFixtureUrl(env));
  try { return await c.db.transaction(async tx => {
    const [row] = await tx.execute<{ result: { windowId: string; closedAt: string; inventory: unknown[] } }>(sql`
      select public.shardkeep_close_keep_source_window(${request.windowId}::uuid) result`);
    if (!row) throw new Error('KEEP_SOURCE_WINDOW_REQUIRED');
    return row.result;
  }); } finally { await c.close(); }
}
