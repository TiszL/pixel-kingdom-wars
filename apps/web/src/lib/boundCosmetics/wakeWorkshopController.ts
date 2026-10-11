import { BoundCosmeticWakeWorkshopViewSchema, BoundCosmeticWakePreferenceResponseSchema,
  type BoundCosmeticWakeWorkshopView } from '@shardkeep/shared/boundCosmeticWakeWorkshopApi';
import type { BoundCosmeticWakePreferenceRequest } from '@shardkeep/shared/boundCosmeticWake';
import { ApiError } from '../api';
import { sameWorkshopValue, type WorkshopCommand, type WorkshopStore } from './workshopJournal';
import { CosmeticWorkshopController, type CosmeticWorkshopPorts, type WorkshopGuard } from './workshopControllerCore';
export interface WakeWorkshopPorts extends CosmeticWorkshopPorts {
  /** Explicit C5 capability, never derived from an Awning preview or sidecar. */
  applicationReady(): boolean;
  capturePreference(enabled: boolean): WorkshopGuard;
  preference(request: BoundCosmeticWakePreferenceRequest, guard: WorkshopGuard): Promise<unknown>;
}
export function wakeCraftBlock(view: BoundCosmeticWakeWorkshopView): string | null {
  const base = view.selectedBase, row = view.recipe;
  if (!view.applicationReady) return 'Aurora Wake application is unavailable. Saved originals remain safe.';
  if (!view.acceptingJobs) return 'New cosmetic crafting is paused.';
  if (!base || base.state !== 'available') return 'Select a kingdom with verified ownership.';
  if (view.original) return 'Aurora Wake is already owned or being crafted.';
  if (view.blueprint.state !== 'eligible') return view.blueprint.state === 'not-earned'
    ? 'Complete a refining job to earn the Artisan Finishes Blueprint.' : 'Blueprint history is temporarily unavailable.';
  if (!base.workshops.length) return 'Complete a Workshop in this kingdom.';
  if (!base.lodges.some(f => f.level >= row.recipe.requiredFacility.level)) return `Requires a completed Lodge at level ${row.recipe.requiredFacility.level}.`;
  if (base.queue.length) return 'Your Workshop is busy. Refining, equipment and cosmetics share this queue.';
  if (row.recipe.inputs.some(input => BigInt(base.craftingStock.find(s => s.itemId === input.itemId)?.available ?? '0') < BigInt(input.quantity))) return 'Gather the missing refined materials.';
  return null;
}
/** Unmounted opt-in. Account preference is independent of the selected kingdom;
 * all original custody/recovery actions use the same closed journal core. */
export class BoundCosmeticWakeWorkshopController extends CosmeticWorkshopController<BoundCosmeticWakeWorkshopView> {
  private preferenceObservation: { value: BoundCosmeticWakeWorkshopView['preference']; guard: WorkshopGuard } | null = null;
  constructor(store: WorkshopStore, private readonly wakePorts: WakeWorkshopPorts) { super(store, wakePorts, 'wake'); }
  currentPreference(): BoundCosmeticWakeWorkshopView['preference'] | null {
    try { this.preferenceObservation?.guard(); return this.preferenceObservation?.value ?? null; } catch { return null; }
  }
  protected recipe(view: BoundCosmeticWakeWorkshopView, recipeId: string) { return view.recipe.recipe.recipeId === recipeId ? view.recipe : undefined; }
  protected admitRecipe(view: BoundCosmeticWakeWorkshopView): void {
    if (!this.wakePorts.applicationReady()) throw Error('Aurora Wake application is unavailable in this client.');
    const blocked = wakeCraftBlock(view); if (blocked) throw Error(blocked);
  }
  protected admitOriginal(view: BoundCosmeticWakeWorkshopView, command: WorkshopCommand): void {
    if (!sameWorkshopValue(view.recipe.recipe, command.recipe) || !sameWorkshopValue(view.recipe.appearance, command.appearance))
      throw Error('Saved terms differ from the current recipe. Keep the original request for recovery.');
    this.admitRecipe(view);
  }
  private async readView(baseId: string | null, guard: WorkshopGuard): Promise<BoundCosmeticWakeWorkshopView> {
    const account = this.ports.capture('account'); guard(); account();
    const view = BoundCosmeticWakeWorkshopViewSchema.parse(await this.ports.view(baseId, guard)); guard(); account();
    if (view.wallet !== this.store.identity.wallet || (view.selectedBase?.baseId ?? null) !== baseId) throw Error('The Workshop snapshot belongs to another account or kingdom.');
    this.preferenceObservation = { value: view.preference, guard: account };
    return view;
  }
  protected async refreshView(baseId: string | null, guard: WorkshopGuard): Promise<BoundCosmeticWakeWorkshopView> {
    const base = this.ports.capture('base', baseId ?? undefined), current = () => { guard(); base(); };
    const view = await this.readView(baseId, current);
    return this.observeView(view, view.original ? [view.original] : [], current);
  }
  refreshPreference(): Promise<void> { return this.action(async guard => {
    const view = await this.readView(null, guard);
    if (view.original) {
      const journal = this.state.journal!;
      const op = [...journal.archives, ...(journal.operation ? [journal.operation] : [])].find(o => o.command.request.idempotencyKey === view.original!.idempotencyKey);
      if (op) await this.retain(op.command, view.original);
    }
    await this.readJournal(guard); this.publish({});
  }); }
  setPreference(enabled: boolean): Promise<void> {
    const shown = this.currentPreference();
    return this.action(async guard => {
      if (!shown) throw Error('Refresh the account preference before changing it.');
      const mutation = this.wakePorts.capturePreference(enabled), current = () => {
        guard(); mutation(); if (enabled && !this.wakePorts.applicationReady()) throw Error('Aurora Wake application is unavailable in this client.');
      };
      current();
      if (enabled) {
        const view = await this.readView(null, current), original = view.original;
        if (!view.applicationReady || !original || original.status !== 'accepted' || !original.completion) throw Error('Complete Aurora Wake crafting before enabling it.');
        await this.ports.preview(original.receipt.appearance, current); current();
      }
      const request = { enabled, expectedRevision: shown.revision };
      try {
        const reply = BoundCosmeticWakePreferenceResponseSchema.parse(await this.wakePorts.preference(request, current)); current();
        if (reply.enabled !== enabled || BigInt(reply.revision) !== BigInt(request.expectedRevision) + 1n
          || reply.visual.state === 'available' && (reply.visual.visual.wake !== null) !== enabled)
          throw Error('The Wake preference could not be confirmed. Refresh its current setting.');
        // A confirmed account update remains visible even if unrelated current stock is unavailable.
        this.preferenceObservation = { value: reply, guard: this.ports.capture('account') }; this.publish({});
      } catch (error) {
        if (error instanceof ApiError && error.code === 'BOUND_COSMETIC_PREFERENCE_CHANGED') {
          await this.readView(null, current); this.publish({ notice: 'This setting changed in another window. Review the current choice before changing it again.' }); return;
        }
        throw error;
      }
      this.publish({ notice: enabled ? 'Aurora Wake is on for future departures.' : 'Aurora Wake is off for future departures.' });
    });
  }
}
