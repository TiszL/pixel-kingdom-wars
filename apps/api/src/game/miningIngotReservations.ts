/** Internal pending custody only. No route, allocation, consumption or payout. */
import { randomUUID } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import { forgeIngotsEnabled, phaseEMiningEnabled } from '../config';
import type { Db, DbOrTx } from '../db/client';
import { HttpError } from '../lib/errors';
import { lockStablePrerequisiteBase, type StableBaseMutationContext } from './stableBasePrerequisites';

interface Reservation { id: string; epochId: string; epochKey: string; baseId: string; actorWallet: string; idempotencyKey: string; ingots: number; createdAt: string; authority: 'pending' }
export interface PendingMiningIngotRequest { epochKey: string; baseId: string; ingots: number; idempotencyKey: string }
export interface PendingMiningAbortRequest { epochId: string; decisionKey: string; reason: string }
const read = async <T extends Record<string, unknown>>(db: DbOrTx, query: SQL) => await db.execute<T>(query);
function textKey(value: string): void {
  if (typeof value !== 'string' || value.length < 8 || value.length > 128 || value.trim() !== value) throw new HttpError(422, 'invalid mining custody key');
}
function time(at: Date): string { if (!Number.isFinite(at.getTime())) throw new HttpError(422, 'invalid custody time'); return at.toISOString(); }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const selection = sql`jsonb_build_object('id',r.id,'epochId',r.epoch_id,'epochKey',e.epoch_key,'baseId',r.base_id,
  'actorWallet',r.actor_wallet,'idempotencyKey',r.idempotency_key,'ingots',r.qty,
  'createdAt',to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'authority','pending') receipt`;
export async function getMiningIngotReservation(db: DbOrTx, wallet: string, key: string): Promise<Reservation | null> {
  const [row] = await read<{ receipt: Reservation }>(db, sql`select ${selection} from mining_ingot_reservations r
    join mining_ingot_epochs e on e.id=r.epoch_id where r.actor_wallet=${wallet} and r.idempotency_key=${key}`);
  return row?.receipt ?? null;
}
export async function reservePendingMiningIngots(db: Db, wallet: string, request: PendingMiningIngotRequest,
  context: StableBaseMutationContext, at = new Date()): Promise<Reservation> {
  textKey(request.epochKey); textKey(request.idempotencyKey);
  if (!uuid.test(request.baseId) || !Number.isSafeInteger(request.ingots) || request.ingots <= 0 || request.ingots > 2147483647)
    throw new HttpError(422, 'invalid ingot reservation');
  return db.transaction(async tx => {
    const player = await read(tx, sql`select wallet from players where wallet=${wallet} for update`);
    if (!player.length) throw new HttpError(404, 'player not found');
    const replay = await getMiningIngotReservation(tx, wallet, request.idempotencyKey);
    if (replay) {
      if (replay.baseId !== request.baseId || replay.ingots !== request.ingots || replay.epochKey !== request.epochKey)
        throw new HttpError(409, 'reservation key belongs to another body', 'IDEMPOTENCY_BODY_MISMATCH');
      return replay;
    }
    if (!forgeIngotsEnabled() || !phaseEMiningEnabled()) throw new HttpError(503, 'mining reservations disabled', 'PHASE_E_DISABLED');
    if (context.baseId !== request.baseId) throw new HttpError(409, 'base authority mismatch', 'BASE_NOT_OWNED');
    await lockStablePrerequisiteBase(tx, wallet, context);
    const now = time(at);
    await tx.execute(sql`insert into mining_ingot_epochs(id,epoch_key,created_at) values(${randomUUID()},${request.epochKey},${now}::timestamptz) on conflict(epoch_key) do nothing`);
    const [epoch] = await read<{ id: string }>(tx, sql`select id from mining_ingot_epochs where epoch_key=${request.epochKey} for update`);
    if ((await read(tx, sql`select epoch_id from mining_ingot_aborts where epoch_id=${epoch!.id}`)).length) throw new HttpError(409, 'epoch already aborted');
    await tx.execute(sql`insert into mining_ingot_admissions(base_id) values(${request.baseId}) on conflict do nothing`);
    const stock = await read(tx, sql`update base_items set qty=qty-${request.ingots} where base_id=${request.baseId} and item_id='forge_ingot' and qty>=${request.ingots} returning id`);
    if (!stock.length) throw new HttpError(422, 'not enough earned ingots', 'INSUFFICIENT_INGOTS');
    await tx.execute(sql`insert into mining_ingot_reservations(id,epoch_id,base_id,actor_wallet,idempotency_key,qty,created_at)
      values(${randomUUID()},${epoch!.id},${request.baseId},${wallet},${request.idempotencyKey},${request.ingots},${now}::timestamptz)`);
    return (await getMiningIngotReservation(tx, wallet, request.idempotencyKey))!;
  });
}

/** Server decision only, owner-principal guarded by SQL. No client cancellation.
 * This schema has no consumption/allocation path, so abort releases the entire
 * epoch. A future consumer must replace this boundary before gaining writes. */
export async function abortPendingMiningEpoch(db: Db, request: PendingMiningAbortRequest, at = new Date()) {
  textKey(request.decisionKey); textKey(request.reason);
  if (!uuid.test(request.epochId)) throw new HttpError(422, 'invalid epoch');
  return db.transaction(async tx => {
    await tx.execute(sql`set local time zone 'UTC'`);
    const [operator] = await read<{ allowed: boolean }>(tx, sql`select current_user=(select pg_get_userbyid(relowner)
      from pg_catalog.pg_class where oid='public.mining_ingot_aborts'::regclass) allowed`);
    if (!operator?.allowed) throw new HttpError(403, 'internal epoch authority required');
    const [prior] = await read<{ decision_key: string; reason: string; receipt: Record<string, unknown> }>(tx, sql`
      select decision_key,reason,to_jsonb(a) receipt from mining_ingot_aborts a where epoch_id=${request.epochId}`);
    if (prior) {
      if (prior.decision_key !== request.decisionKey || prior.reason !== request.reason) throw new HttpError(409, 'abort body mismatch', 'IDEMPOTENCY_BODY_MISMATCH');
      return prior.receipt;
    }
    const discovered = await read<{ base_id: string; owner_wallet: string }>(tx, sql`select distinct r.base_id,b.owner_wallet
      from mining_ingot_reservations r join bases b on b.id=r.base_id where r.epoch_id=${request.epochId} order by r.base_id`);
    // Match transfer's wallet ordering before locking any domain row.
    for (const wallet of [...new Set(discovered.map(r => r.owner_wallet))].sort()) await tx.execute(sql`select wallet from players where wallet=${wallet} for update`);
    for (const source of discovered) {
      const [base] = await read<{ owner_wallet: string }>(tx, sql`select owner_wallet from bases where id=${source.base_id} for update`);
      if (base?.owner_wallet !== source.owner_wallet) throw new HttpError(409, 'ownership changed; retry abort');
      if ((await read(tx, sql`select raid_id from base_raid_locks where base_id=${source.base_id} for update`)).length) throw new HttpError(423, 'base is being raided', 'BASE_BEING_RAIDED');
    }
    const epoch = await read(tx, sql`select id from mining_ingot_epochs where id=${request.epochId} for update nowait`);
    if (!epoch.length) throw new HttpError(404, 'epoch not found');
    const [completed] = await read<{ decision_key: string; reason: string; receipt: Record<string, unknown> }>(tx, sql`
      select decision_key,reason,to_jsonb(a) receipt from mining_ingot_aborts a where epoch_id=${request.epochId}`);
    if (completed) {
      if (completed.decision_key !== request.decisionKey || completed.reason !== request.reason) throw new HttpError(409, 'abort body mismatch', 'IDEMPOTENCY_BODY_MISMATCH');
      return completed.receipt;
    }
    const sources = await read<{ id: string; base_id: string; qty: number }>(tx, sql`select id,base_id,qty from mining_ingot_reservations where epoch_id=${request.epochId} order by base_id,id for update`);
    if (sources.some(r => !discovered.some(d => d.base_id === r.base_id))) throw new HttpError(409, 'epoch sources changed; retry abort');
    const now = time(at);
    await tx.execute(sql`insert into mining_ingot_aborts(epoch_id,decision_key,reason,created_at) values(${request.epochId},${request.decisionKey},${request.reason},${now}::timestamptz)`);
    for (const source of sources) {
      await tx.execute(sql`insert into mining_ingot_releases(reservation_id,abort_epoch_id,created_at) values(${source.id},${request.epochId},${now}::timestamptz)`);
      await tx.execute(sql`insert into base_items(base_id,item_id,qty,acquired_via) values(${source.base_id},'forge_ingot',${source.qty},'craft')
        on conflict(base_id,item_id) do update set qty=base_items.qty+excluded.qty`);
    }
    return (await read<{ receipt: Record<string, unknown> }>(tx, sql`select to_jsonb(a) receipt from mining_ingot_aborts a where epoch_id=${request.epochId}`))[0]!.receipt;
  });
}
