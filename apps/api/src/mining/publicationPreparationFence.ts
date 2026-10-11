/** Shared ingot/resource preparation admission, held through the caller's commit.
 * This is not an abort, replacement, signing reservation or settlement writer. */
import { PublicKey } from '@solana/web3.js';
import { sql } from 'drizzle-orm';
import { miningConfigPda } from '@shardkeep/chain/mining-program';
import type { DbTx } from '../db/client';

type Code = 'ORIGINAL_IN_FLIGHT' | 'SOURCE_CHANGED';
export class MiningPublicationPreparationFenceError extends Error {
  constructor(readonly code: Code) { super(`Mining publication preparation fence refused: ${code}`); this.name = 'MiningPublicationPreparationFenceError'; }
}
export interface MiningPublicationPreparationScope {
  epochId: string; genesisHash: string; programId: string; configAddress: string; sequence: string;
}
function fail(code: Code): never { throw new MiningPublicationPreparationFenceError(code); }
function scope(input: MiningPublicationPreparationScope): Readonly<MiningPublicationPreparationScope> {
  try {
    if (!input || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.epochId)
        || typeof input.sequence !== 'string' || !/^[1-9][0-9]{0,19}$/.test(input.sequence)
        || BigInt(input.sequence) > (1n << 64n) - 1n) fail('SOURCE_CHANGED');
    for (const value of [input.genesisHash, input.programId, input.configAddress]) {
      if (typeof value !== 'string' || value.length > 44 || new PublicKey(value).toBase58() !== value) fail('SOURCE_CHANGED');
    }
    if (miningConfigPda(new PublicKey(input.programId)).toBase58() !== input.configAddress) fail('SOURCE_CHANGED');
    return Object.freeze({ epochId: input.epochId, genesisHash: input.genesisHash, programId: input.programId,
      configAddress: input.configAddress, sequence: input.sequence });
  } catch { fail('SOURCE_CHANGED'); }
}

/** Call after the epoch lock and same-epoch replay, before either attempt or
 * manifest INSERT. All publication domains must use this common preparation
 * path. READ COMMITTED gives the post-lock query a fresh snapshot; stronger
 * isolation may retain a snapshot taken before another preparer committed.
 * A try-lock bounds admission without mutating timeouts or waiting for a signer. */
export async function assertMiningPublicationPreparationFence(tx: DbTx, input: MiningPublicationPreparationScope): Promise<void> {
  const current = scope(input);
  if (typeof tx?.rollback !== 'function') fail('SOURCE_CHANGED');
  const [mode] = await tx.execute<{ isolation: string }>(sql`select current_setting('transaction_isolation') isolation`);
  if (mode?.isolation !== 'read committed') fail('SOURCE_CHANGED');
  const lockKey = `shardkeep:mining-publication:${JSON.stringify([current.genesisHash, current.programId, current.configAddress])}`;
  const [lock] = await tx.execute<{ locked: boolean }>(sql`select pg_try_advisory_xact_lock(hashtextextended(${lockKey},0)) locked`);
  if (lock?.locked !== true) fail('ORIGINAL_IN_FLIGHT');
  const identity = sql`m.manifest_json::jsonb->'funding'->'source'->>'genesisHash'=${current.genesisHash}
    and m.publication->>'programId'=${current.programId}
    and m.manifest_json::jsonb->'funding'->'config'->>'address'=${current.configAddress}`;
  const [state] = await tx.execute<{ originalInFlight: boolean; staleSequence: boolean }>(sql`select
    exists(select 1 from mining_publication_attempts a join mining_publication_manifests m on m.epoch_id=a.epoch_id
      where ${identity} and a.epoch_id<>${current.epochId}::uuid
        and not exists(select 1 from mining_publication_settlements s where s.epoch_id=a.epoch_id)) "originalInFlight",
    exists(select 1 from mining_publication_manifests m where ${identity}
      and (m.publication->>'sequence')::numeric>=${current.sequence}::numeric) "staleSequence"`);
  if (typeof state?.originalInFlight !== 'boolean' || typeof state.staleSequence !== 'boolean') fail('SOURCE_CHANGED');
  if (state.originalInFlight) fail('ORIGINAL_IN_FLIGHT');
  if (state.staleSequence) fail('SOURCE_CHANGED');
}
