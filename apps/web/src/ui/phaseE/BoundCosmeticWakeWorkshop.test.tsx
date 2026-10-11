// @vitest-environment happy-dom
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BoundCosmeticEnvelopeSchema } from '@shardkeep/shared/boundCosmeticApi';
import { BoundCosmeticWakeWorkshopViewSchema } from '@shardkeep/shared/boundCosmeticWakeWorkshopApi';
import pair from '../../../../../docs/evidence/2026-10-01-bound-cosmetic-wake-workshop/bound-cosmetic-wake-workshop-pair.json';
import { useBoundCosmeticWakeWorkshop } from '../../lib/boundCosmetics/wakeWorkshopBrowser';
import { useBoundCosmeticWorkshop } from '../../lib/boundCosmetics/workshopBrowser';
import { useOrdinaryCrafting } from '../../lib/ordinaryCrafting/useOrdinaryCrafting';
import type { BoundCosmeticWakeWorkshopController } from '../../lib/boundCosmetics/wakeWorkshopController';
import { parseWorkshopCommand } from '../../lib/boundCosmetics/workshopJournal';
import { BoundCosmeticWakeWorkshop } from './BoundCosmeticWakeWorkshop';
import { OrdinaryCraftingScreen } from './OrdinaryCraftingScreen';

// Actual primary pair SHA75259751b8d535b2af449ee7a0a752d29754dac21c61746a4fa26cb788181766.
// The provider's before/completed records use explicitly synthetic test readiness;
// runtime is the real unadmitted startup. UI state variants below do not claim C5.
vi.mock('../../lib/boundCosmetics/wakeWorkshopBrowser', () => ({ useBoundCosmeticWakeWorkshop: vi.fn() }));
vi.mock('../../lib/boundCosmetics/workshopBrowser', () => ({ useBoundCosmeticWorkshop: vi.fn() }));
vi.mock('../../lib/ordinaryCrafting/useOrdinaryCrafting', () => ({ useOrdinaryCrafting: vi.fn() }));
const observed = vi.hoisted(() => ({ preview: vi.fn() }));
vi.mock('./BoundCosmeticPreview', () => ({ BoundCosmeticPreview: (props: { appearance: { bindingSha256: string }; label: string }) => {
  observed.preview(props); return <div role="img" aria-label={props.label} data-binding={props.appearance.bindingSha256} />;
} }));
const before = () => BoundCosmeticWakeWorkshopViewSchema.parse(structuredClone(pair.before));
const completed = () => BoundCosmeticWakeWorkshopViewSchema.parse(structuredClone(pair.completed));
const original = () => {
  const p = BoundCosmeticEnvelopeSchema.parse(structuredClone(pair.original));
  if (p.status !== 'accepted') throw Error('Actual fixture original is missing'); return p;
};
const command = () => { const p = original(); return parseWorkshopCommand({ request: p.receipt.request, recipe: p.receipt.recipe, appearance: p.receipt.appearance }, 'wake'); };
let root: Root, host: HTMLDivElement, model: ReturnType<typeof useBoundCosmeticWakeWorkshop>;
let actions: Record<'begin' | 'confirm' | 'checkOriginal' | 'reviewOriginal' | 'archive' | 'setPreference' | 'refreshPreference' | 'checkReceipt', ReturnType<typeof vi.fn>>;
const button = (name: string) => [...host.querySelectorAll('button')].find(b => b.textContent === name);
const render = async () => act(async () => root.render(<BoundCosmeticWakeWorkshop actionsEnabled />));
const click = async (name: string) => { const b = button(name); expect(b, name).toBeDefined(); expect(b!.disabled, name).toBe(false); await act(async () => b!.click()); };
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); observed.preview.mockClear();
  actions = { begin: vi.fn(async () => {}), confirm: vi.fn(async () => {}), checkOriginal: vi.fn(async () => {}), reviewOriginal: vi.fn(async () => {}), archive: vi.fn(async () => {}), setPreference: vi.fn(async () => {}), refreshPreference: vi.fn(async () => {}), checkReceipt: vi.fn(async () => {}) };
  const view = before(); model = { baseId: view.selectedBase!.baseId, preference: view.preference, actionsAllowed: true, preferenceAllowed: true, applicationReady: false,
    state: { loaded: true, busy: false, error: null, notice: null, review: null, view, journal: { version: 1, identity: { origin: 'https://game.example', api: 'https://game.example/api', cluster: 'devnet', wallet: view.wallet }, revision: 0, operation: null, archives: [] } },
    run: fn => { void fn(actions as unknown as BoundCosmeticWakeWorkshopController); }, refresh: vi.fn(), cancelReview: vi.fn() };
  vi.mocked(useBoundCosmeticWakeWorkshop).mockImplementation(() => model);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('shows the exact admitted-source preview and server material requirements while C5 prevents new craft and On', async () => {
  const runtime = BoundCosmeticWakeWorkshopViewSchema.parse(structuredClone(pair.runtime)); model.state.view = runtime; model.baseId = runtime.selectedBase!.baseId; model.preference = runtime.preference;
  await render(); expect(host.querySelectorAll('[role="img"]')).toHaveLength(1);
  expect(observed.preview).toHaveBeenLastCalledWith(expect.objectContaining({ appearance: runtime.recipe.appearance, label: 'Aurora Wake artwork preview' }));
  expect(button('REVIEW AURORA CRAFT')!.disabled).toBe(true); expect(button('ENABLE OWNED AURORA')!.disabled).toBe(true);
  expect(host.textContent).toContain('not available for new crafts or switching on yet');
  const rows = [...host.querySelectorAll('[aria-label="Refined material requirements"] > div')];
  for (const input of runtime.recipe.recipe.inputs) {
    const name = input.itemId.replaceAll('_', ' ').replace(/\b\w/g, c => c.toUpperCase());
    const row = rows.find(node => node.querySelector('dt')?.textContent === name); expect(row?.textContent).toContain(`${input.quantity} needed`);
  }
  // Synthetic UI variant: even a server-ready completed original cannot override absent local C5.
  model.state.view = completed(); model.baseId = model.state.view.selectedBase!.baseId; model.preference = model.state.view.preference;
  await render(); expect(button('ENABLE OWNED AURORA')!.disabled).toBe(true); expect(actions.begin).not.toHaveBeenCalled(); expect(actions.setPreference).not.toHaveBeenCalled();
});

it('allows free account Off without selected kingdom or current stock during craft pause, but respects the global mutation fence', async () => {
  const on = BoundCosmeticWakeWorkshopViewSchema.parse(structuredClone(pair.on)); model.preference = on.preference; model.state.journal!.identity.wallet = on.wallet;
  model.state.view = null; model.baseId = null; model.actionsAllowed = false; model.applicationReady = false;
  await render(); expect(host.textContent).toContain('AURORA WAKE ON'); await click('SWITCH AURORA OFF'); expect(actions.setPreference).toHaveBeenCalledExactlyOnceWith(false);
  model.preferenceAllowed = false; await render(); expect(button('SWITCH AURORA OFF')!.disabled).toBe(true);
  await click('REFRESH ACCOUNT SETTING'); expect(actions.refreshPreference).toHaveBeenCalledOnce();
});

it('keeps an unknown saved request recoverable on current-read failure without automatic resend, replacement or archival', async () => {
  model.state.journal!.operation = { command: command(), attempted: true, proof: null }; model.state.view = null; model.state.error = 'Current Workshop details could not be verified.';
  model.baseId = null; model.actionsAllowed = false; await render();
  expect(document.activeElement).toBe(host.querySelector('[role="alert"]')); expect(host.textContent).toContain('OUTCOME NOT YET CONFIRMED');
  expect(host.textContent).toContain('Receipt recovery stays available here'); expect(button('SAVE TO HISTORY')).toBeUndefined(); expect(button('ARCHIVE UNSENT DRAFT')).toBeUndefined(); expect(button('RESEND SAME CRAFT REQUEST')).toBeUndefined();
  for (const action of Object.values(actions)) expect(action).not.toHaveBeenCalled();
  await click('CHECK ORIGINAL RECEIPT'); expect(actions.checkOriginal).toHaveBeenCalledOnce(); expect(actions.begin).not.toHaveBeenCalled(); expect(actions.confirm).not.toHaveBeenCalled(); expect(actions.archive).not.toHaveBeenCalled();
});

it('preserves completed historical proof independently of failed current reads and keeps identifiers collapsed', async () => {
  const done = completed().original!; model.state.journal!.operation = { command: command(), attempted: true, proof: done }; model.state.view = null; model.baseId = null;
  await render(); expect(host.textContent).toContain('ORIGINAL REQUEST ACCEPTED'); expect(host.textContent).toContain('Owned · stays with your account');
  expect(host.querySelector('summary')?.textContent).toBe('Aurora history · 1'); expect(host.querySelector('details[open]')).toBeNull();
  expect(host.querySelector('.sk-awning-history time')?.getAttribute('datetime')).toBe(done.completion!.completedAt);
  expect(actions.archive).not.toHaveBeenCalled(); expect(actions.confirm).not.toHaveBeenCalled();
  await click('CHECK AURORA RECEIPT'); expect(actions.checkReceipt).toHaveBeenCalledExactlyOnceWith(done.idempotencyKey);
});

it('requires an explicit irreversible review plus current action, application and original-kingdom guards for confirm or resend', async () => {
  const c = command(); model.state.journal!.operation = { command: c, attempted: false, proof: null }; model.state.review = { command: c, view: model.state.view! };
  // Synthetic future-C5 UI state only; controller/browser admission is tested separately.
  model.applicationReady = true; model.actionsAllowed = false; await render();
  const review = host.querySelector('[aria-label="Confirm Aurora craft"]'); expect(document.activeElement).toBe(review);
  expect(review?.textContent).toContain('consumed when crafting starts'); expect(review?.textContent).toContain('cannot be cancelled or refunded'); expect(actions.confirm).not.toHaveBeenCalled(); expect(button('CONFIRM & USE MATERIALS')!.disabled).toBe(true);
  model.actionsAllowed = true; model.applicationReady = false; await render(); expect(button('CONFIRM & USE MATERIALS')!.disabled).toBe(true);
  model.applicationReady = true; model.baseId = null; await render(); expect(button('CONFIRM & USE MATERIALS')!.disabled).toBe(true);
  model.baseId = c.request.baseId; await render(); await click('CONFIRM & USE MATERIALS'); expect(actions.confirm).toHaveBeenCalledOnce();
  model.state.review = null; await render(); expect(button('CONFIRM & USE MATERIALS')).toBeUndefined();
  model.state.journal!.operation!.attempted = true; model.state.review = { command: c, view: model.state.view! }; await render();
  expect(host.textContent).toContain('explicitly resends the same saved request'); expect(actions.confirm).toHaveBeenCalledTimes(1);
  await click('RESEND SAME CRAFT REQUEST'); expect(actions.confirm).toHaveBeenCalledTimes(2); await click('CANCEL REVIEW'); expect(model.cancelReview).toHaveBeenCalledOnce(); expect(actions.begin).not.toHaveBeenCalled();
});

it('mounts one ordinary Workshop section at a time and disposes the previous hook when changing sections', async () => {
  const active = new Set<string>(), lifecycle: string[] = [];
  function useSection(name: string) { useEffect(() => { active.add(name); lifecycle.push('open '+name); return () => { active.delete(name); lifecycle.push('close '+name); }; }, [name]); }
  vi.mocked(useOrdinaryCrafting).mockImplementation(function useMaterialsFixture() { useSection('materials'); return { actionsAllowed: false, state: { loaded: true, busy: false, journal: null, review: null, error: null }, snapshot: null, refreshError: null, run: vi.fn(), refresh: vi.fn(), dismiss: vi.fn(), finish: vi.fn() }; });
  vi.mocked(useBoundCosmeticWorkshop).mockImplementation(function useAwningsFixture() { useSection('awnings'); return { ...model, state: { ...model.state, view: null, review: null }, run: vi.fn<ReturnType<typeof useBoundCosmeticWorkshop>['run']>() }; });
  vi.mocked(useBoundCosmeticWakeWorkshop).mockImplementation(function useWakeFixture() { useSection('wake'); return model; });
  await act(async () => root.render(<OrdinaryCraftingScreen actionsEnabled={false} />)); expect([...active]).toEqual(['materials']);
  await click('AURORA'); await vi.waitFor(() => expect([...active]).toEqual(['wake'])); expect(lifecycle.indexOf('close materials')).toBeLessThan(lifecycle.indexOf('open wake'));
  await click('AWNINGS'); await vi.waitFor(() => expect([...active]).toEqual(['awnings'])); expect(lifecycle.indexOf('close wake')).toBeLessThan(lifecycle.indexOf('open awnings'));
  await click('MATERIALS'); await vi.waitFor(() => expect([...active]).toEqual(['materials'])); expect(lifecycle).toContain('close awnings');
});


it('keeps independently recovered completion when an older current view still shows the same craft pending', async () => {
  const done = completed().original!;
  model.state.journal!.operation = { command: command(), attempted: true, proof: done };
  model.state.view = BoundCosmeticWakeWorkshopViewSchema.parse(structuredClone(pair.pending));
  expect(model.state.view.original?.idempotencyKey).toBe(done.idempotencyKey);
  expect(model.state.view.original?.completion).toBeNull();
  await render();
  expect(host.querySelector('summary')?.textContent).toBe('Aurora history · 1');
  expect(host.querySelector('.sk-awning-history')?.textContent).toContain('Owned · stays with your account');
  expect(host.querySelector('.sk-awning-history time')?.getAttribute('datetime')).toBe(done.completion!.completedAt);
  expect(actions.confirm).not.toHaveBeenCalled(); expect(actions.archive).not.toHaveBeenCalled();
});
