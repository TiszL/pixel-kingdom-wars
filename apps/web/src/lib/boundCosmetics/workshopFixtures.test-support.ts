import metadata from '../../../../../docs/evidence/2026-09-30-bound-cosmetic-visuals/pe_cosmetics.manifest.json';
import { BoundCosmeticWorkshopViewSchema } from '@shardkeep/shared/boundCosmeticWorkshopApi';
import { boundCosmeticRecipe } from '@shardkeep/shared/phaseEBoundCosmetics';
import { ORDINARY_CRAFTING_ITEM_IDS_V2 } from '@shardkeep/shared/phaseEOrdinaryCrafting';
import type { BoundCosmeticEnvelope } from '@shardkeep/shared/boundCosmeticApi';
import type { WorkshopCommand, WorkshopIdentity } from './workshopJournal';
export const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const identity: WorkshopIdentity = { origin: 'http://localhost:3000', api: 'http://localhost:3000/api', cluster: 'devnet', wallet: '2'.repeat(32) };
export const now = '2026-09-30T12:00:00.000Z';
export function view() {
  return BoundCosmeticWorkshopViewSchema.parse({ version: 1, wallet: identity.wallet, serverNow: now, acceptingJobs: true, applicationReady: true,
    blueprint: { state: 'eligible', proof: { blueprintId: 'architect_blueprint_artisan_finishes_v1', jobId: id(8), baseId: id(1), actorWallet: identity.wallet, completedAt: '2026-09-30T11:00:00.000Z' } },
    recipes: [1, 2, 3, 4].map(tier => {
      const outputId = `artisan_market_awning_t${tier}`, binding = metadata.bindings[outputId as keyof typeof metadata.bindings];
      return { recipe: boundCosmeticRecipe(`craft_artisan_market_awning_t${tier}_v1` as Parameters<typeof boundCosmeticRecipe>[0], 1),
        appearance: { version: 1, outputId, sourceId: binding.value.sourceId, sourceManifestSha256: binding.value.sourceManifestSha256, sourceIndexSha256: binding.value.sourceIndexSha256, bindingSha256: binding.sha256 } };
    }), originals: [], selectedBase: { state: 'available', baseId: id(1), craftingStock: ORDINARY_CRAFTING_ITEM_IDS_V2.map(itemId => ({ itemId, available: '100', pendingOutput: '0' })),
      workshops: [{ buildingId: id(2), level: 1, completedAt: '2026-09-30T11:00:00.000Z' }], markets: [{ buildingId: id(3), level: 20, completedAt: '2026-09-30T11:00:00.000Z' }],
      queue: [], preference: { enabled: false, revision: '0' }, visual: { state: 'available', visual: { version: 1, marketAwnings: [] } } } });
}
export const command = (): WorkshopCommand => { const row = view().recipes[0]!; return { ...row, request: { idempotencyKey: id(5), baseId: id(1), recipeId: row.recipe.recipeId, recipeVersion: row.recipe.recipeVersion, appearanceBindingSha256: row.appearance.bindingSha256 } }; };
export function proof(c = command(), accepted = true, completed = false): BoundCosmeticEnvelope {
  const serverNow = completed ? '2026-09-30T12:10:00.000Z' : now;
  if (!accepted) return { version: 1, wallet: identity.wallet, idempotencyKey: c.request.idempotencyKey, serverNow, status: 'unknown', receipt: null, completion: null };
  const v = view(); if (v.blueprint.state !== 'eligible') throw Error('Fixture blueprint unavailable');
  return { version: 1, wallet: identity.wallet, idempotencyKey: c.request.idempotencyKey, serverNow, status: 'accepted',
    receipt: { wallet: identity.wallet, jobId: c.request.idempotencyKey, request: c.request, recipe: c.recipe, appearance: c.appearance, blueprint: v.blueprint.proof,
      startedAt: now, readyAt: new Date(Date.parse(now) + c.recipe.durationSec * 1000).toISOString() }, completion: completed ? { completedAt: serverNow } : null };
}
export function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
