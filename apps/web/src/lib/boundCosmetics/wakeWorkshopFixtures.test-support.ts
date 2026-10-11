import metadata from '../../../../../docs/evidence/2026-09-30-bound-cosmetic-visuals/pe_cosmetics.manifest.json';
import { BoundCosmeticWakeWorkshopViewSchema } from '@shardkeep/shared/boundCosmeticWakeWorkshopApi';
import { boundCosmeticRecipe } from '@shardkeep/shared/phaseEBoundCosmetics';
import type { WorkshopCommand } from './workshopJournal';
import { id, identity, proof, view } from './workshopFixtures.test-support';
export const wakeIdentity = { ...identity, wallet: '11111111111111111111111111111112' };
export function wakeCommand(): WorkshopCommand {
  const recipe = boundCosmeticRecipe('craft_aurora_wake_v1', 1), b = metadata.bindings.aurora_wake;
  return { recipe, appearance: { version: 1, outputId: 'aurora_wake', sourceId: 'auroraWake', sourceManifestSha256: b.value.sourceManifestSha256, sourceIndexSha256: b.value.sourceIndexSha256, bindingSha256: b.sha256 },
    request: { idempotencyKey: id(6), baseId: id(1), recipeId: recipe.recipeId, recipeVersion: recipe.recipeVersion, appearanceBindingSha256: b.sha256 } };
}
export function wakeView() {
  const a = view(), c = wakeCommand(), base = a.selectedBase; if (base?.state !== 'available') throw Error('Fixture');
  return BoundCosmeticWakeWorkshopViewSchema.parse({ version: 1, wallet: wakeIdentity.wallet, serverNow: a.serverNow, applicationReady: true, acceptingJobs: true, blueprint: a.blueprint.state === 'eligible' ? { ...a.blueprint, proof: { ...a.blueprint.proof, actorWallet: wakeIdentity.wallet } } : a.blueprint,
    recipe: { recipe: c.recipe, appearance: c.appearance }, original: null, preference: { enabled: false, revision: '0', visual: { state: 'available', visual: { version: 1, wake: null } } },
    selectedBase: { state: 'available', baseId: base.baseId, craftingStock: base.craftingStock, workshops: base.workshops,
      lodges: [{ buildingId: id(4), level: c.recipe.requiredFacility.level, completedAt: base.workshops[0]!.completedAt }], queue: [] } });
}
export function wakeProof(complete = false, accepted = true) {
  const raw = proof(wakeCommand(), accepted);
  if (raw.status !== 'accepted') return { ...raw, wallet: wakeIdentity.wallet };
  const p = { ...raw, wallet: wakeIdentity.wallet, receipt: { ...raw.receipt, wallet: wakeIdentity.wallet, blueprint: { ...raw.receipt.blueprint, actorWallet: wakeIdentity.wallet } } };
  return complete ? { ...p, serverNow: p.receipt.readyAt, completion: { completedAt: p.receipt.readyAt } } : p;
}
