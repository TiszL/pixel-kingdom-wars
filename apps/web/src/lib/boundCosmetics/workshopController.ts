import { BoundCosmeticWorkshopViewSchema, BoundCosmeticPreferenceResponseSchema,
  type BoundCosmeticWorkshopView, type BoundCosmeticPreferenceRequest } from '@shardkeep/shared/boundCosmeticWorkshopApi';
import { boundCosmeticAwningForCompletedLevel } from '@shardkeep/shared/boundCosmeticVisual';
import { ApiError } from '../api';
import { sameWorkshopValue, type WorkshopCommand, type WorkshopStore } from './workshopJournal';
import { CosmeticWorkshopController, type CosmeticWorkshopPorts, type CosmeticWorkshopReview, type CosmeticWorkshopState, type WorkshopGuard } from './workshopControllerCore';
export type { WorkshopGuard } from './workshopControllerCore';
export interface WorkshopPorts extends CosmeticWorkshopPorts {
  preference(request: BoundCosmeticPreferenceRequest, guard: WorkshopGuard): Promise<unknown>;
}
export type AwningRecipe = BoundCosmeticWorkshopView['recipes'][number];
export type AvailableWorkshopBase = Extract<NonNullable<BoundCosmeticWorkshopView['selectedBase']>, { state: 'available' }>;
export type WorkshopReview = CosmeticWorkshopReview<BoundCosmeticWorkshopView>;
export type WorkshopState = CosmeticWorkshopState<BoundCosmeticWorkshopView>;

export function awningCraftBlock(view: BoundCosmeticWorkshopView, row: AwningRecipe): string | null {
  const base = view.selectedBase;
  if (!view.applicationReady) return 'Awning application is unavailable. Existing receipts remain safe.';
  if (!view.acceptingJobs) return 'New cosmetic crafting is paused.';
  if (!base || base.state !== 'available') return 'Select a kingdom with verified ownership.';
  if (view.originals.some(o => o.status === 'accepted' && o.receipt.recipe.outputId === row.recipe.outputId)) return 'This appearance is already owned or being crafted.';
  if (view.blueprint.state !== 'eligible') return view.blueprint.state === 'not-earned'
    ? 'Complete a refining job to earn the Artisan Finishes Blueprint.' : 'Blueprint history is temporarily unavailable.';
  if (!base.workshops.length) return 'Complete a Workshop in this kingdom.';
  if (!base.markets.some(f => f.level >= row.recipe.requiredFacility.level)) return `Requires a completed Market at level ${row.recipe.requiredFacility.level}.`;
  if (base.queue.length) return 'Your Workshop is busy. Refining, equipment and cosmetics share this queue.';
  if (row.recipe.inputs.some(input => BigInt(base.craftingStock.find(s => s.itemId === input.itemId)?.available ?? '0') < BigInt(input.quantity)))
    return 'Gather the missing refined materials.';
  return null;
}
export class BoundCosmeticWorkshopController extends CosmeticWorkshopController<BoundCosmeticWorkshopView> {
  constructor(store: WorkshopStore, private readonly awningPorts: WorkshopPorts) { super(store, awningPorts, 'awning'); }
  protected recipe(view: BoundCosmeticWorkshopView, recipeId: string): AwningRecipe | undefined { return view.recipes.find(r => r.recipe.recipeId === recipeId); }
  protected admitRecipe(view: BoundCosmeticWorkshopView, row: AwningRecipe): void { const blocked = awningCraftBlock(view, row); if (blocked) throw Error(blocked); }
  protected async refreshView(baseId: string | null, guard: WorkshopGuard): Promise<BoundCosmeticWorkshopView> {
    const baseGuard = this.ports.capture('base', baseId ?? undefined), current = () => { guard(); baseGuard(); };
    current();
    const view = BoundCosmeticWorkshopViewSchema.parse(await this.ports.view(baseId, current)); current();
    if (view.wallet !== this.store.identity.wallet || (view.selectedBase?.baseId ?? null) !== baseId)
      throw Error('The Workshop snapshot belongs to another account or kingdom.');
    if (view.selectedBase?.state === 'available') view.selectedBase.markets.forEach(market => boundCosmeticAwningForCompletedLevel(market.level));
    return this.observeView(view, view.originals, current);
  }
  protected admitOriginal(view: BoundCosmeticWorkshopView, command: WorkshopCommand): void {
    const row = view.recipes.find(r => r.recipe.recipeId === command.recipe.recipeId);
    if (!row || !sameWorkshopValue(row.recipe, command.recipe) || !sameWorkshopValue(row.appearance, command.appearance))
      throw Error('Saved terms differ from the current recipe. Keep the original request for recovery.');
    this.admitRecipe(view, row);
  }
  setPreference(baseId: string, enabled: boolean): Promise<void> {
    const shown = this.state.view?.selectedBase;
    return this.action(async guard => {
      if (!shown || shown.state !== 'available' || shown.baseId !== baseId) throw Error('Refresh this kingdom before changing its appearance.');
      const preference = this.ports.capture(enabled ? 'craft' : 'preference', baseId), current = () => { guard(); preference(); };
      current(); if (enabled && !this.state.view?.applicationReady) throw Error('Awning application is unavailable.');
      if (enabled) {
        const owned = this.state.view!.originals.find(original => original.status === 'accepted' && original.completion
          && shown.markets.some(market => original.receipt.recipe.outputId === boundCosmeticAwningForCompletedLevel(market.level)));
        if (!owned || owned.status !== 'accepted') throw Error('Craft the Awning for this Market’s completed tier before enabling it.');
        await this.ports.preview(owned.receipt.appearance, current); current();
      }
      const request = { baseId, enabled, expectedRevision: shown.preference.revision };
      try {
        const reply = BoundCosmeticPreferenceResponseSchema.parse(await this.awningPorts.preference(request, current)); current();
        if (reply.baseId !== baseId || reply.enabled !== enabled || BigInt(reply.revision) !== BigInt(request.expectedRevision) + 1n)
          throw Error('The appearance update could not be confirmed. Refresh its current setting.');
      } catch (error) {
        if (error instanceof ApiError && error.code === 'BOUND_COSMETIC_PREFERENCE_CHANGED') {
          await this.refreshView(baseId, current); this.publish({ notice: 'This setting changed in another window. Review the current choice before changing it again.' }); return;
        }
        throw error;
      }
      await this.refreshView(baseId, current);
      this.publish({ notice: enabled ? 'The Awning preference is on for this kingdom.' : 'The ordinary Market preference is saved for this kingdom.' });
    });
  }
}
