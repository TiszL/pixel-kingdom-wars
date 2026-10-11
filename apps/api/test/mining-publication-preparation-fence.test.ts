/** Pure ordering/SQL-binding contract. Actual PostgreSQL races are the content pipeline queued. */
import { PublicKey } from '@solana/web3.js';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import { SOLANA_GENESIS_HASH } from '@shardkeep/chain';
import { MINING_PROGRAM_ADDRESS, miningConfigPda } from '@shardkeep/chain/mining-program';
import type { DbTx } from '../src/db/client';

const scope = () => ({ epochId: '00000000-0000-4000-8000-000000000001',
  genesisHash: SOLANA_GENESIS_HASH.devnet, programId: MINING_PROGRAM_ADDRESS,
  configAddress: miningConfigPda(new PublicKey(MINING_PROGRAM_ADDRESS)).toBase58(), sequence: '1' });
const guard = async () => (await import('../src/mining/publicationPreparationFence')).assertMiningPublicationPreparationFence;
type Query = ReturnType<PgDialect['sqlToQuery']>;
function transaction(options: { isolation?: string; locked?: boolean; state?: unknown } = {}) {
  const queries: Query[] = [], dialect = new PgDialect();
  const execute = vi.fn(async (statement: Parameters<PgDialect['sqlToQuery']>[0]) => {
    const query = dialect.sqlToQuery(statement); queries.push(query);
    if (query.sql.includes('transaction_isolation')) return [{ isolation: options.isolation ?? 'read committed' }];
    if (query.sql.includes('pg_try_advisory_xact_lock')) return [{ locked: options.locked ?? true }];
    return options.state === undefined ? [{ originalInFlight: false, staleSequence: false }] : options.state;
  });
  return { tx: { execute, rollback: vi.fn() } as unknown as DbTx, execute, queries };
}

describe('shared mining publication preparation transaction fence', () => {
  it('checks read committed, obtains one bounded transaction scope lock, then reads both custody domains before allowing insertion', async () => {
    const f = transaction(); await (await guard())(f.tx, scope());
    expect(f.queries).toHaveLength(3);
    expect(f.queries[0]!.sql).toContain('transaction_isolation');
    expect(f.queries[1]!.sql).toContain('pg_try_advisory_xact_lock');
    expect(f.queries[1]!.sql).toContain('hashtextextended');
    const query = f.queries[2]!;
    expect(query.sql).toContain('mining_publication_attempts');
    expect(query.sql).toContain('mining_publication_manifests');
    expect(query.sql).toContain('mining_publication_settlements');
    expect(query.sql).toContain('::numeric');
    expect(query.params).toEqual(expect.arrayContaining([scope().epochId, scope().genesisHash, scope().programId, scope().configAddress, scope().sequence]));
    expect(query.sql).not.toMatch(/resource-mining|free-shadow|contributions\s+is|reservations\s+is/);
    expect(f.queries.every(query => !/\binsert\b|\bupdate\b|\bdelete\b|\bset_config\b/i.test(query.sql))).toBe(true);
  });

  it('holds any other unfinished original before a candidate attempt can be written', async () => {
    const f = transaction({ state: [{ originalInFlight: true, staleSequence: false }] });
    await expect((await guard())(f.tx, scope())).rejects.toMatchObject({ code: 'ORIGINAL_IN_FLIGHT' });
    expect(f.queries).toHaveLength(3);
  });

  it('rejects a stale sequence even when the preceding winner already settled while planning was in progress', async () => {
    const f = transaction({ state: [{ originalInFlight: false, staleSequence: true }] });
    await expect((await guard())(f.tx, scope())).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
    expect(f.queries[2]!.sql).toMatch(/>=/);
  });

  it('keeps the unfinished-original reason when both refusal conditions hold', async () => {
    const f = transaction({ state: [{ originalInFlight: true, staleSequence: true }] });
    await expect((await guard())(f.tx, scope())).rejects.toMatchObject({ code: 'ORIGINAL_IN_FLIGHT' });
  });

  it('refuses a busy scope immediately without issuing the source query or changing timeout settings', async () => {
    const f = transaction({ locked: false });
    await expect((await guard())(f.tx, scope())).rejects.toMatchObject({ code: 'ORIGINAL_IN_FLIGHT' });
    expect(f.queries).toHaveLength(2);
    expect(f.queries.map(query => query.sql).join('\n')).not.toMatch(/set_config|lock_timeout|statement_timeout/i);
  });

  it('uses the same scope lock across epochs and sequences, and a different lock for a different genesis', async () => {
    const first = transaction(), second = transaction(), foreign = transaction(), assert = await guard();
    await assert(first.tx, scope());
    await assert(second.tx, { ...scope(), epochId: '00000000-0000-4000-8000-000000000002', sequence: '2' });
    await assert(foreign.tx, { ...scope(), genesisHash: new PublicKey(new Uint8Array(32).fill(99)).toBase58() });
    expect(first.queries[1]!.params).toEqual(second.queries[1]!.params);
    expect(foreign.queries[1]!.params).not.toEqual(first.queries[1]!.params);
  });

  it.each(['repeatable read', 'serializable', 'read uncommitted'])('refuses %s before taking a lock instead of accepting a stale transaction snapshot', async isolation => {
    const f = transaction({ isolation });
    await expect((await guard())(f.tx, scope())).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
    expect(f.queries).toHaveLength(1);
  });

  it('refuses an ordinary connection because its transaction lock would otherwise end before preparation inserts', async () => {
    const f = transaction();
    await expect((await guard())({ execute: f.execute } as unknown as DbTx, scope())).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
    expect(f.execute).not.toHaveBeenCalled();
  });

  it.each([
    { epochId: 'not-an-epoch' }, { genesisHash: 'not-a-genesis' }, { programId: 'not-a-program' },
    { configAddress: new PublicKey(new Uint8Array(32).fill(98)).toBase58() },
    { sequence: '0' }, { sequence: '01' }, { sequence: '18446744073709551616' },
  ])('rejects malformed or noncanonical application scope %j without touching SQL', async patch => {
    const f = transaction();
    await expect((await guard())(f.tx, { ...scope(), ...patch })).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
    expect(f.execute).not.toHaveBeenCalled();
  });

  it.each([{ state: [] }, { state: [{ originalInFlight: false }] }, { state: [{ originalInFlight: 'false', staleSequence: false }] }])('fails closed for missing or malformed state %j', async ({ state }) => {
    const f = transaction({ state });
    await expect((await guard())(f.tx, scope())).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
  });

  it('cannot begin the source query before its lock operation resolves', async () => {
    const f = transaction(); let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const real = f.execute.getMockImplementation()!;
    f.execute.mockImplementation(async statement => {
      const query = new PgDialect().sqlToQuery(statement);
      if (query.sql.includes('pg_try_advisory_xact_lock')) await waiting;
      return real(statement);
    });
    const assert = await guard(), pending = assert(f.tx, scope());
    await Promise.resolve(); await Promise.resolve();
    expect(f.queries).toHaveLength(1);
    release(); await pending;
    expect(f.queries).toHaveLength(3);
  });
});
