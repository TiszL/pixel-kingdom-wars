import {boundCosmeticQueueError} from './boundCosmeticCollection';
import {settleDueOrdinaryEquipment,assertNoPendingOrdinaryEquipment} from './ordinaryEquipment';
/** D153.27 ordinary conversion. SHARDS ingredients use the existing base ledger; no new market or
 * scheduler. Starts consume inputs irreversibly in their outer transaction;
 * automatic completion only converts protected pending output to available.
 * Callers of completion already hold base locks (sorted for multiple bases).
 * Stock is an application-maintained projection, like raw stock: SQL protects
 * bounds and original evidence, not arbitrary administrator projection edits. */
import { randomUUID } from 'node:crypto';
import { BuildingType, PHASE_E_ORDINARY_CRAFTING, PHASE_E_ORDINARY_CRAFTING_V2 } from '@shardkeep/shared';
import { ordinaryCraftingRecipe, OrdinaryCraftingRecipeSnapshotSchema, OrdinaryCraftingItemIdSchema, OrdinaryRecipeIdSchema, ORDINARY_CRAFTING_ITEM_IDS, ORDINARY_CRAFTING_ITEM_IDS_V2, ORDINARY_RECIPE_IDS_V1 } from '@shardkeep/shared/phaseEOrdinaryCrafting';
import { PhaseERawResourceIdSchema, RAW_RESOURCE_STORAGE_MAX } from '@shardkeep/shared/phaseEResources';
import { and, asc, eq, isNotNull, isNull, lte } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, DbOrTx, DbTx } from '../db/client';
import { ordinaryCraftingEnabled } from '../config';
import { bases, players, buildings, builderJobs, craftingStocks, ordinaryCraftingJobs as jobs,
  ordinaryCraftingInputs as inputs, ordinaryCraftingCompletions as completions, accounts, ledgerEntries, ledgerTransactions } from '../db/schema';
import { spendBaseShards } from './baseEconomy';
import { HttpError } from '../lib/errors';
import { reserveRawStock, consumeRawStockReservation, readResourceStockProof } from './resourceStock';
import { lockStablePrerequisiteBase, type StableBaseMutationContext } from './stableBasePrerequisites';

const uuid = z.string().uuid().transform(s => s.toLowerCase());
export const OrdinaryCraftingCommandSchema = z.object({ id: uuid, baseId: uuid,
  recipeId: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), recipeVersion: z.number().int().positive().max(2_147_483_647),
  quantity: z.number().int().positive().max(2_147_483_647) }).strict();
export type OrdinaryCraftingCommand = z.infer<typeof OrdinaryCraftingCommandSchema>;
const mismatch = () => new HttpError(409, 'Crafting key belongs to another original command', 'IDEMPOTENCY_BODY_MISMATCH');

/** Internal original evidence. An HTTP adapter must bind the original actor;
 * this read deliberately has no current owner/catalogue/facility prerequisite. */
export async function readOrdinaryCrafting(db: DbOrTx, id: string) {
  // One MVCC snapshot: a concurrent completion must not mix an old pending job
  // with its newly committed terminal receipt. Input proofs below are immutable.
  const [row] = await db.select({ job: jobs, completion: completions }).from(jobs)
    .leftJoin(completions, eq(completions.jobId, jobs.id)).where(eq(jobs.id, uuid.parse(id)));
  if (!row) return null;
  const { job, completion } = row;
  const recipe = OrdinaryCraftingRecipeSnapshotSchema.parse(job.recipeSnapshot);
  if (job.recipeId !== recipe.recipeId || job.recipeVersion !== recipe.recipeVersion || job.quantity !== recipe.quantity
    || job.outputItemId !== recipe.output.itemId || job.outputQuantity !== BigInt(recipe.output.quantity)
    || job.readyAt.getTime() - job.startedAt.getTime() !== recipe.durationSec * 1_000) throw new Error('Invalid frozen crafting recipe');
  const consumed = await db.select().from(inputs).where(eq(inputs.jobId, job.id)).orderBy(asc(inputs.position));
  if (consumed.length !== recipe.inputs.length) throw new Error('Missing crafting input proof');
  for (const [position, input] of consumed.entries()) {
    const expected = recipe.inputs[position]!;
    if (input.position !== position || input.kind !== expected.kind || input.itemId !== expected.itemId
      || input.quantity !== BigInt(expected.quantity)) throw new Error('Crafting inputs differ from original recipe');
    if (input.kind === 'raw') {
      if (!input.reserveOperationId || !input.consumeOperationId) throw new Error('Missing raw consumption proof');
      const reserve = await readResourceStockProof(db, input.reserveOperationId);
      const consume = await readResourceStockProof(db, input.consumeOperationId);
      if (!reserve || !consume || reserve.operation.kind !== 'reserve' || consume.operation.kind !== 'consume'
        || consume.operation.reservationId !== reserve.operation.id
        || [reserve.operation, consume.operation].some(o => o.baseId !== job.baseId || o.resourceId !== input.itemId
          || o.quantity !== input.quantity || o.custodyWallet !== job.actorWallet)) throw new Error('Wrong original raw consumption');
    } else if (input.reserveOperationId !== null || input.consumeOperationId !== null) throw new Error('Crafting input cannot claim raw proof');
    if (input.kind === 'shards') {
      if (!input.shardsLedgerTxnId) throw new Error('Missing original SHARDS ingredient proof');
      const [txn] = await db.select().from(ledgerTransactions).where(eq(ledgerTransactions.id, input.shardsLedgerTxnId));
      const entries = await db.select({ entry: ledgerEntries, account: accounts }).from(ledgerEntries)
        .innerJoin(accounts, eq(accounts.id, ledgerEntries.accountId)).where(eq(ledgerEntries.txnId, input.shardsLedgerTxnId));
      const metadata = { baseId: job.baseId, jobId: job.id, wallet: job.actorWallet, position: input.position, quantity: input.quantity.toString() };
      if (!txn || txn.type !== 'ordinary.crafting.shards' || txn.idempotencyKey !== `ordinary-crafting:${job.id}:shards`
        || JSON.stringify(Object.entries(txn.metadata as object).sort()) !== JSON.stringify(Object.entries(metadata).sort())
        || entries.length !== 2 || !entries.some(({ entry, account }) => account.kind === 'base_shards' && account.baseId === job.baseId
          && account.ownerWallet === null && account.currency === 'SHARDS' && entry.delta === -input.quantity)
        || !entries.some(({ entry, account }) => account.kind === 'shard_burn' && account.baseId === null
          && account.ownerWallet === null && account.currency === 'SHARDS' && entry.delta === input.quantity)) throw new Error('Wrong original SHARDS ingredient proof');
    } else if (input.shardsLedgerTxnId !== null) throw new Error('Non-SHARDS ingredient cannot claim ledger proof');
  }
  if (Boolean(completion) !== Boolean(job.completedAt) || (completion && (!Number.isFinite(completion.completedAt.getTime())
    || completion.completedAt < job.readyAt || completion.completedAt.getTime() !== job.completedAt!.getTime()
    || completion.custodyWallet.length === 0))) throw new Error('Invalid crafting completion');
  return { job: { ...job, recipeSnapshot: recipe }, inputs: consumed, completion: completion ?? null };
}
type Proof = NonNullable<Awaited<ReturnType<typeof readOrdinaryCrafting>>>;
export function matchOrdinaryCraftingCommand(proof: Proof, wallet: string, command: OrdinaryCraftingCommand) {
  const job = proof.job;
  if (job.actorWallet !== wallet || job.baseId !== command.baseId || job.recipeId !== command.recipeId
    || job.recipeVersion !== command.recipeVersion || job.quantity !== command.quantity) throw mismatch();
  return proof;
}
export async function ordinaryWorkshop(tx: DbTx, baseId: string) {
  const rows = await tx.select().from(buildings).where(and(eq(buildings.baseId, baseId), eq(buildings.type, BuildingType.Workshop)))
    .orderBy(asc(buildings.id)).for('update');
  for (const building of rows) {
    if (building.level < 1) continue;
    const [unfinished] = await tx.select().from(builderJobs).where(and(eq(builderJobs.buildingId, building.id),
      eq(builderJobs.kind, 'build'), isNull(builderJobs.completedAt))).limit(1);
    if (unfinished) continue;
    const [completed] = await tx.select().from(builderJobs).where(and(eq(builderJobs.buildingId, building.id),
      eq(builderJobs.baseId, baseId), eq(builderJobs.kind, 'build'), isNotNull(builderJobs.completedAt), isNull(builderJobs.cancelledAt)))
      .orderBy(asc(builderJobs.completedAt), asc(builderJobs.id)).limit(1);
    if (completed?.completedAt) return { building, completed };
  }
  throw new HttpError(409, 'A completed Workshop on this base is required', 'ORDINARY_WORKSHOP_REQUIRED');
}
async function lockedStock(tx: DbTx, baseId: string, itemId: string) {
  OrdinaryCraftingItemIdSchema.parse(itemId);
  await tx.insert(craftingStocks).values({ baseId, itemId }).onConflictDoNothing();
  const [row] = await tx.select().from(craftingStocks).where(and(eq(craftingStocks.baseId, baseId), eq(craftingStocks.itemId, itemId))).for('update');
  if (!row || row.available < 0n || row.pendingOutput < 0n || row.available + row.pendingOutput > RAW_RESOURCE_STORAGE_MAX)
    throw new Error('Invalid protected crafting stock');
  return row;
}
export function assertOrdinaryCraftingStartsEnabled(): void {
  if (!ordinaryCraftingEnabled()) throw new HttpError(503, 'Ordinary crafting is not enabled', 'PHASE_E_DISABLED');
}

export async function startOrdinaryCrafting(db: DbOrTx, wallet: string, command: OrdinaryCraftingCommand,
  authority: StableBaseMutationContext, dependencies: { clock?: () => Date } = {}): Promise<Proof> {
  const cmd = OrdinaryCraftingCommandSchema.parse(command);
  const prior = await readOrdinaryCrafting(db, cmd.id);
  if (prior) return matchOrdinaryCraftingCommand(prior, wallet, cmd);
  assertOrdinaryCraftingStartsEnabled();
  return (db as Db).transaction(async tx => {
    const [player] = await tx.select().from(players).where(eq(players.wallet, wallet)).for('update');
    if (!player) throw new HttpError(404, 'player not found');
    const replay = await readOrdinaryCrafting(tx, cmd.id);
    if (replay) return matchOrdinaryCraftingCommand(replay, wallet, cmd);
    if (uuid.parse(authority.baseId) !== cmd.baseId) throw mismatch();
    await lockStablePrerequisiteBase(tx, wallet, { ...authority, baseId: cmd.baseId });
    assertOrdinaryCraftingStartsEnabled();
    const facility = await ordinaryWorkshop(tx, cmd.baseId);
    const now = new Date((dependencies.clock ?? (() => new Date()))().getTime());
    if (!Number.isFinite(now.getTime()) || facility.completed.completedAt! > now) throw new Error('Invalid crafting start time');
    await settleDueOrdinaryCrafting(tx, cmd.baseId, now);
    await assertNoPendingOrdinaryEquipment(tx,cmd.baseId);
    const [pending] = await tx.select().from(jobs).where(and(eq(jobs.baseId, cmd.baseId), isNull(jobs.completedAt))).limit(1);
    if (pending) throw new HttpError(409, 'This base already has an unfinished crafting job', 'ORDINARY_CRAFTING_BUSY');
    if (cmd.recipeVersion !== PHASE_E_ORDINARY_CRAFTING.v1.recipeVersion && cmd.recipeVersion !== PHASE_E_ORDINARY_CRAFTING_V2.recipeVersion)
      throw new HttpError(409, 'Ordinary recipe review is stale', 'ORDINARY_RECIPE_CHANGED');
    let recipe: ReturnType<typeof ordinaryCraftingRecipe>;
    try {
      const recipeId = OrdinaryRecipeIdSchema.parse(cmd.recipeId);
      if (cmd.recipeVersion === PHASE_E_ORDINARY_CRAFTING.v1.recipeVersion && !(ORDINARY_RECIPE_IDS_V1 as readonly string[]).includes(recipeId))
        throw new HttpError(409, 'This recipe requires the newer crafting catalogue', 'ORDINARY_RECIPE_CHANGED');
      recipe = ordinaryCraftingRecipe(recipeId, cmd.recipeVersion, cmd.quantity);
    }
    catch (error) {
      if (error instanceof z.ZodError) throw new HttpError(400, 'Invalid ordinary recipe or batch quantity', 'ORDINARY_RECIPE_INVALID');
      throw error;
    }
    const readyAt = new Date(now.getTime() + recipe.durationSec * 1_000);
    if (!Number.isFinite(readyAt.getTime())) throw new Error('Crafting deadline overflow');
    const output = await lockedStock(tx, cmd.baseId, recipe.output.itemId), outputQuantity = BigInt(recipe.output.quantity);
    if (output.available + output.pendingOutput + output.marketOutgoing + output.marketIncoming + output.miningPending + outputQuantity > RAW_RESOURCE_STORAGE_MAX)
      throw new HttpError(409, 'Protected crafting storage cannot hold this output', 'CRAFTING_STORAGE_FULL');
    await tx.insert(jobs).values({ ...cmd, actorWallet: wallet, recipeSnapshot: recipe, outputItemId: recipe.output.itemId,
      outputQuantity, workshopId: facility.building.id, workshopCompletedJobId: facility.completed.id, startedAt: now, readyAt });
    for (const [position, ingredient] of recipe.inputs.entries()) {
      const quantity = BigInt(ingredient.quantity);
      let reserveOperationId: string | null = null, consumeOperationId: string | null = null, shardsLedgerTxnId: string | null = null;
      if (ingredient.kind === 'raw') {
        reserveOperationId = randomUUID(); consumeOperationId = randomUUID();
        await reserveRawStock(tx, wallet, { operationId: reserveOperationId, baseId: cmd.baseId,
          resourceId: PhaseERawResourceIdSchema.parse(ingredient.itemId), quantity }, authority);
        await consumeRawStockReservation(tx, consumeOperationId, reserveOperationId);
      } else if (ingredient.kind === 'shards') {
        const posted = await spendBaseShards(tx, cmd.baseId, quantity, 'ordinary.crafting.shards', `ordinary-crafting:${cmd.id}:shards`,
          { jobId: cmd.id, wallet, position, quantity: quantity.toString() });
        if (posted.duplicate) throw new Error('SHARDS ingredient exists without its original crafting job');
        shardsLedgerTxnId = posted.transaction.id;
      } else {
        const stock = await lockedStock(tx, cmd.baseId, ingredient.itemId);
        if (stock.available < quantity) throw new HttpError(422, 'Insufficient refined crafting stock', 'INSUFFICIENT_CRAFTING_STOCK');
        await tx.update(craftingStocks).set({ available: stock.available - quantity })
          .where(and(eq(craftingStocks.baseId, cmd.baseId), eq(craftingStocks.itemId, ingredient.itemId)));
      }
      await tx.insert(inputs).values({ jobId: cmd.id, position, kind: ingredient.kind, itemId: ingredient.itemId,
        quantity, reserveOperationId, consumeOperationId, shardsLedgerTxnId });
    }
    await tx.update(craftingStocks).set({ pendingOutput: output.pendingOutput + outputQuantity })
      .where(and(eq(craftingStocks.baseId, cmd.baseId), eq(craftingStocks.itemId, recipe.output.itemId)));
    const proof = await readOrdinaryCrafting(tx, cmd.id);
    if (!proof) throw new Error('Crafting acceptance not persisted');
    return proof;
  }).catch(error => { throw boundCosmeticQueueError(error); });
}

/** All due jobs, original base/current custody; no player lock, RPC, current
 * recipe, facility, raid gate or independent commit. Savepoint protects callers
 * that catch a failure; a failed batch never partially credits output. */
export async function settleDueOrdinaryCrafting(tx: DbTx, originalBaseId: string, cutoff: Date): Promise<Proof[]> {
  const baseId = uuid.parse(originalBaseId), at = new Date(z.date().parse(cutoff).getTime());
  return tx.transaction(async locked => {
    const [base] = await locked.select().from(bases).where(eq(bases.id, baseId)).for('update');
    if (!base) throw new Error('Original crafting base is missing');
    const due = await locked.select().from(jobs).where(and(eq(jobs.baseId, baseId), isNull(jobs.completedAt), lte(jobs.readyAt, at)))
      .orderBy(asc(jobs.readyAt), asc(jobs.id)).for('update');
    const result: Proof[] = [];
    for (const job of due) {
      const original = await readOrdinaryCrafting(locked, job.id);
      if (!original || original.completion) throw new Error('Original crafting obligation changed');
      const stock = await lockedStock(locked, baseId, job.outputItemId);
      if (stock.pendingOutput < job.outputQuantity) throw new Error('Crafting pending output is missing');
      await locked.update(craftingStocks).set({ available: stock.available + job.outputQuantity, pendingOutput: stock.pendingOutput - job.outputQuantity })
        .where(and(eq(craftingStocks.baseId, baseId), eq(craftingStocks.itemId, job.outputItemId)));
      await locked.insert(completions).values({ jobId: job.id, custodyWallet: base.ownerWallet, completedAt: at });
      await locked.update(jobs).set({ completedAt: at }).where(eq(jobs.id, job.id));
      result.push((await readOrdinaryCrafting(locked, job.id))!);
    }
    await settleDueOrdinaryEquipment(locked,baseId,at);
    return result;
  });
}


/** Current protected stock projection, never historical payment/recipe proof.
 * The caller must hold this exact base's lock and current read authority, then
 * settle due work at its post-lock cutoff. Pending output is not spendable.
 * Decimal strings preserve int64 precision in the authorized base response. */
export async function readProtectedCraftingStock(tx: DbTx, baseId: string, catalogueVersion: 1 | 2 = 1) {
  baseId = uuid.parse(baseId);
  const rows = await tx.select().from(craftingStocks).where(eq(craftingStocks.baseId, baseId));
  for (const row of rows) {
    OrdinaryCraftingItemIdSchema.parse(row.itemId);
    if (row.available < 0n || row.pendingOutput < 0n || row.available + row.pendingOutput > RAW_RESOURCE_STORAGE_MAX)
      throw new Error('Invalid protected crafting stock');
  }
  return (catalogueVersion === 2 ? ORDINARY_CRAFTING_ITEM_IDS_V2 : ORDINARY_CRAFTING_ITEM_IDS).map(itemId => {
    const row = rows.find(row => row.itemId === itemId);
    return { itemId, available: (row?.available ?? 0n).toString(), pendingOutput: (row?.pendingOutput ?? 0n).toString() };
  });
}
