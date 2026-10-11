// @vitest-environment happy-dom
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { IDBFactory } from 'fake-indexeddb';
import { expect, it, vi } from 'vitest';
import { BoundCosmeticWakeWorkshopViewSchema } from '@shardkeep/shared/boundCosmeticWakeWorkshopApi';
import { BoundCosmeticEnvelopeSchema } from '@shardkeep/shared/boundCosmeticApi';
import { BoundCosmeticWakeWorkshopController, type WakeWorkshopPorts } from './wakeWorkshopController';
import { parseWorkshopCommand, WorkshopJournalStore } from './workshopJournal';
import { identity } from './workshopFixtures.test-support';
function capture(): Record<string, unknown> {
  const bytes = readFileSync(resolve(process.cwd(), 'src/lib/boundCosmetics/wake-workshop-actual.test-fixture.json'));
  expect(createHash('sha256').update(bytes).digest('hex')).toBe('75259751b8d535b2af449ee7a0a752d29754dac21c61746a4fa26cb788181766');
  return JSON.parse(bytes.toString()) as Record<string, unknown>;
}
function ports(view: unknown, original?: unknown): WakeWorkshopPorts {
  return { capture: () => () => undefined, applicationReady: () => false, capturePreference: () => () => undefined,
    view: async () => view, original: async (_r, _g, retain) => { if (!original) throw Error('No original expected'); await retain(original); return original; },
    start: vi.fn(async () => { throw Error('No C5 application capability'); }), preference: vi.fn(async () => { throw Error('No preference mutation in pairing'); }),
    preview: vi.fn(async () => { throw Error('No C5 preview'); }), lock: async (_n, run) => run(), key: () => { throw Error('Never replace original'); } };
}
it('reads actual normal-runtime closed application without synthesizing ownership or a new craft', async () => {
  const source = capture(), runtime = BoundCosmeticWakeWorkshopViewSchema.parse(source.runtime);
  const store = new WorkshopJournalStore({ ...identity, wallet: runtime.wallet }, new IDBFactory(), 'wake'), p = ports(source.runtime);
  try { const c = new BoundCosmeticWakeWorkshopController(store, p); await c.open(runtime.selectedBase?.baseId ?? null);
    expect(c.currentView()).toEqual(runtime); expect(c.currentView()?.applicationReady).toBe(false); expect(c.currentView()?.acceptingJobs).toBe(false);
    expect(c.currentPreference()).toEqual(runtime.preference); expect(c.snapshot().journal?.operation).toBeNull();
    await c.begin(runtime.selectedBase!.baseId, runtime.recipe.recipe.recipeId); expect(p.start).not.toHaveBeenCalled(); expect(p.preview).not.toHaveBeenCalled();
  } finally { await store.close(); }
});
it('recovers actual completed Aurora terms separately from synthetic application admission and preserves the original', async () => {
  const source = capture(), completed = BoundCosmeticWakeWorkshopViewSchema.parse(source.completed), original = BoundCosmeticEnvelopeSchema.parse(source.original);
  if (original.status !== 'accepted' || completed.original?.status !== 'accepted' || !completed.original.completion) throw Error('Actual original and completed view required');
  const store = new WorkshopJournalStore({ ...identity, wallet: original.wallet }, new IDBFactory(), 'wake'), p = ports(source.completed, completed.original);
  try { const command = parseWorkshopCommand({ request: original.receipt.request, recipe: original.receipt.recipe, appearance: original.receipt.appearance }, 'wake');
    await store.compareAndSet(0, old => ({ ...old, operation: { command, attempted: false, proof: null } }));
    const c = new BoundCosmeticWakeWorkshopController(store, p); await c.open(completed.selectedBase?.baseId ?? null);
    expect(c.snapshot().journal?.operation?.proof).toEqual(completed.original); expect(completed.original.receipt).toEqual(original.receipt);
    await c.reviewOriginal(); await c.confirm(); expect(p.start).not.toHaveBeenCalled(); expect(p.preview).not.toHaveBeenCalled();
    expect((await store.read()).operation?.proof).toEqual(completed.original);
  } finally { await store.close(); }
});
// These are unchanged captured source objects, not a browser HTTP replay or C5
// pixel proof. The completed-source case explicitly had synthetic server admission;
// normal runtime is a different captured account and is tested independently.
