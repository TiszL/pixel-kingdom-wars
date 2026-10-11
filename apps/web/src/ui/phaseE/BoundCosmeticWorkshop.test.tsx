// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useBoundCosmeticWorkshop } from '../../lib/boundCosmetics/workshopBrowser';
import type { BoundCosmeticWorkshopController } from '../../lib/boundCosmetics/workshopController';
import { command, id, identity, proof, view } from '../../lib/boundCosmetics/workshopFixtures.test-support';
import { BoundCosmeticWorkshop } from './BoundCosmeticWorkshop';
vi.mock('../../lib/boundCosmetics/workshopBrowser', () => ({ useBoundCosmeticWorkshop: vi.fn() }));
vi.mock('./BoundCosmeticPreview', () => ({ BoundCosmeticPreview: ({ label }: { label: string }) => <div role="img" aria-label={label+' verified source preview'} /> }));
let root: Root, host: HTMLDivElement, model: ReturnType<typeof useBoundCosmeticWorkshop>;
let actions: { begin: ReturnType<typeof vi.fn>; confirm: ReturnType<typeof vi.fn>; checkOriginal: ReturnType<typeof vi.fn>; reviewOriginal: ReturnType<typeof vi.fn>; archive: ReturnType<typeof vi.fn>; setPreference: ReturnType<typeof vi.fn> };
const button = (name: string) => [...host.querySelectorAll('button')].find(b => b.textContent === name)!;
const render = async () => act(async () => root.render(<BoundCosmeticWorkshop actionsEnabled />));
const click = async (name: string) => { expect(button(name)?.disabled).toBe(false); await act(async () => button(name).click()); };
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  actions = { begin: vi.fn(async () => {}), confirm: vi.fn(async () => {}), checkOriginal: vi.fn(async () => {}), reviewOriginal: vi.fn(async () => {}), archive: vi.fn(async () => {}), setPreference: vi.fn(async () => {}) };
  model = { baseId: id(1), actionsAllowed: true, preferenceAllowed: true, state: { loaded: true, busy: false, error: null, notice: null, review: null, view: view(),
    journal: { version: 1, identity, revision: 0, operation: null, archives: [] } }, run: fn => { void fn(actions as unknown as BoundCosmeticWorkshopController); }, refresh: vi.fn(), cancelReview: vi.fn() };
  vi.mocked(useBoundCosmeticWorkshop).mockImplementation(() => model);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('shows all four source previews, explicit selected tier, stock/requirements and the shared queue without a purchase claim', async () => {
  await render(); expect(host.querySelectorAll('[role="img"]')).toHaveLength(4);
  expect(host.textContent).toContain('Earned from your completed refining job'); expect(host.textContent).toContain('Refining, equipment and cosmetics use the same job slot');
  expect(host.textContent).toContain('Heartwood Beams'); expect(host.textContent).toContain('100 available');
  await click('SELECT TIER 3'); expect(host.querySelector('[aria-label="Selected Awning requirements"]')?.textContent).toContain('Artisan Awning III');
  await click('REVIEW CRAFT'); expect(actions.begin).toHaveBeenCalledWith(id(1), 'craft_artisan_market_awning_t3_v1'); expect(actions.confirm).not.toHaveBeenCalled();
});
it('requires explicit material confirmation, presents irreversible terms, and focuses the review', async () => {
  const c = command(); model.state.journal!.operation = { command: c, attempted: false, proof: null }; model.state.review = { command: c, view: model.state.view! };
  await render(); expect(actions.confirm).not.toHaveBeenCalled();
  const review = host.querySelector('[aria-label="Confirm Awning craft"]'); expect(document.activeElement).toBe(review);
  expect(review?.textContent).toContain('consumed when crafting starts'); expect(review?.textContent).toContain('cannot be cancelled or refunded');
  await click('CONFIRM & USE MATERIALS'); expect(actions.confirm).toHaveBeenCalledOnce();
  await click('CANCEL REVIEW'); expect(model.cancelReview).toHaveBeenCalledOnce();
});
it('keeps unknown original recovery available while pause prevents new spending and replacement', async () => {
  model.state.journal!.operation = { command: command(), attempted: true, proof: null };
  model.actionsAllowed = false; model.state.view!.acceptingJobs = model.state.view!.applicationReady = false;
  await render(); expect(host.textContent).toContain('OUTCOME NOT YET CONFIRMED'); expect(button('REVIEW CRAFT').disabled).toBe(true);
  expect(button('ARCHIVE UNSENT DRAFT')).toBeUndefined(); expect(button('SAVE TO HISTORY')).toBeUndefined();
  await click('CHECK ORIGINAL RECEIPT'); expect(actions.checkOriginal).toHaveBeenCalledOnce(); expect(actions.begin).not.toHaveBeenCalled();
});
it('enables only an owned tier matching the completed Market, and preserves off for an unowned upgraded tier', async () => {
  model.state.view!.originals = [proof(command(), true, true)]; model.state.view!.serverNow = '2026-09-30T12:10:00.000Z';
  const base = model.state.view!.selectedBase!; if (base.state !== 'available') throw Error('Fixture');
  await render(); expect(button('ENABLE OWNED AWNING').disabled).toBe(true); // T1 owned, current completed Market T4.
  base.markets[0]!.level = 1; await render(); await click('ENABLE OWNED AWNING'); expect(actions.setPreference).toHaveBeenCalledWith(id(1), true);
  base.markets[0]!.level = 20; base.preference = { enabled: true, revision: '1' }; model.actionsAllowed = false; model.state.view!.acceptingJobs = model.state.view!.applicationReady = false;
  await render(); await click('USE ORDINARY APPEARANCE'); expect(actions.setPreference).toHaveBeenLastCalledWith(id(1), false);
  model.preferenceAllowed = false; await render(); expect(button('USE ORDINARY APPEARANCE').disabled).toBe(true);
});
it('shows missing refined stock and a busy shared queue without inferring completion from a due time', async () => {
  const v = model.state.view!, base = v.selectedBase!; if (base.state !== 'available') throw Error('Fixture');
  base.craftingStock.forEach(s => s.available = '0'); await render(); expect(host.textContent).toContain('2 missing'); expect(button('REVIEW CRAFT').disabled).toBe(true);
  base.craftingStock.forEach(s => s.available = '100'); const original = proof(); if (original.status !== 'accepted') throw Error('Fixture');
  base.queue = [{ kind: 'cosmetic', jobId: original.idempotencyKey, recipe: original.receipt.recipe, startedAt: original.receipt.startedAt, readyAt: original.receipt.readyAt }];
  v.originals = [original]; await render(); expect(host.textContent).toContain('IN PROGRESS'); expect(host.textContent).toContain('Crafting · original request accepted');
  expect(host.textContent).not.toContain('Owned · stays with your account'); expect(button('REVIEW CRAFT').disabled).toBe(true);
});
it('makes a resend explicit, keeps original identifiers collapsed, and focuses actionable failure copy', async () => {
  model.state.journal!.operation = { command: command(), attempted: true, proof: null }; model.state.review = { command: command(), view: model.state.view! };
  await render(); expect(host.textContent).toContain('explicitly resends the same original request');
  expect(host.querySelector('details[open]')).toBeNull(); await click('RESEND SAME CRAFT REQUEST'); expect(actions.confirm).toHaveBeenCalledOnce();
  model.state.review = null; model.state.error = 'The selected appearance could not be verified on this device.';
  await render(); expect(document.activeElement).toBe(host.querySelector('[role="alert"]')); expect(button('CHECK ORIGINAL RECEIPT').disabled).toBe(false);
});
