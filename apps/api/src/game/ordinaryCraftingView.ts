/** Original receipts never query current custody or stock. Current projections
 * are read only while getBaseState holds this exact authorized base's locks. */
import { OrdinaryCraftingEnvelopeSchema, OrdinaryCraftingPendingJobSchema, OrdinaryCraftingReceiptSchema,
  type OrdinaryCraftingEnvelope } from '@shardkeep/shared/ordinaryCraftingApi';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { DbOrTx, DbTx } from '../db/client';
import { ordinaryCraftingJobs } from '../db/schema';
import { readOrdinaryCrafting } from './ordinaryCrafting';

type Proof = NonNullable<Awaited<ReturnType<typeof readOrdinaryCrafting>>>;
export function ordinaryCraftingEnvelope(wallet: string, idempotencyKey: string, proof: Proof | null,
  now = new Date()): OrdinaryCraftingEnvelope {
  if (!proof || proof.job.actorWallet !== wallet) return OrdinaryCraftingEnvelopeSchema.parse({
    wallet, idempotencyKey, status: 'unknown', receipt: null, completion: null, serverNow: now.toISOString(),
  });
  const job = proof.job;
  const receipt = OrdinaryCraftingReceiptSchema.parse({ wallet: job.actorWallet,
    request: { idempotencyKey: job.id, baseId: job.baseId, recipeId: job.recipeId, recipeVersion: job.recipeVersion, quantity: job.quantity },
    jobId: job.id, recipe: job.recipeSnapshot, startedAt: job.startedAt.toISOString(), readyAt: job.readyAt.toISOString(),
  });
  return OrdinaryCraftingEnvelopeSchema.parse({ wallet, idempotencyKey, status: 'accepted', receipt,
    completion: proof.completion ? { completedAt: proof.completion.completedAt.toISOString() } : null, serverNow: now.toISOString() });
}

export async function readOrdinaryCraftingEnvelope(db: DbOrTx, wallet: string, idempotencyKey: string) {
  // A foreign key takes the same path as an unknown key, even if its owner's
  // historical evidence needs repair. Never validate or disclose buyer state.
  const [owned] = await db.select({ id: ordinaryCraftingJobs.id }).from(ordinaryCraftingJobs)
    .where(and(eq(ordinaryCraftingJobs.id, idempotencyKey), eq(ordinaryCraftingJobs.actorWallet, wallet)));
  return ordinaryCraftingEnvelope(wallet, idempotencyKey, owned ? await readOrdinaryCrafting(db, owned.id) : null);
}

export async function readPendingOrdinaryCrafting(tx: DbTx, baseId: string) {
  const rows = await tx.select({ id: ordinaryCraftingJobs.id }).from(ordinaryCraftingJobs)
    .where(and(eq(ordinaryCraftingJobs.baseId, baseId), isNull(ordinaryCraftingJobs.completedAt)))
    .orderBy(asc(ordinaryCraftingJobs.readyAt), asc(ordinaryCraftingJobs.id));
  const result = [];
  for (const row of rows) {
    const proof = await readOrdinaryCrafting(tx, row.id);
    if (!proof || proof.completion) throw new Error('Locked pending crafting job changed');
    result.push(OrdinaryCraftingPendingJobSchema.parse({ jobId: proof.job.id, recipe: proof.job.recipeSnapshot,
      startedAt: proof.job.startedAt.toISOString(), readyAt: proof.job.readyAt.toISOString() }));
  }
  return result;
}
