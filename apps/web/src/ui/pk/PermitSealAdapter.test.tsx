/** @vitest-environment happy-dom */
import { act, startTransition, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PermitSealAdapter, type PermitSealReview, type PermitSealOwnerSnapshot } from './PermitSealAdapter';
import { PK_KIT } from './kitLogic';
import type { MoneyStage, PriceStatus } from './types';

const original = (status: PriceStatus = 'OK'): PermitSealReview => ({
  identity: { requestId: 'original-permit', wallet: 'wallet-a', baseId: 'base-a', epoch: 1, generation: 1 },
  ui: { title: 'Original permit', price: { currency: 'KEEP', amount: status === 'SERVER_ZERO' ? '0' : '1', status },
    lines: ['Only the original owner may confirm this review.'], armedAtMs: 0, confirmLabel: 'CONFIRM PERMIT' },
});
let host: HTMLDivElement, root: ReturnType<typeof createRoot>;
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const button = () => host.querySelector<HTMLButtonElement>('button[aria-label="CONFIRM PERMIT"]')!;
async function mount(review: PermitSealReview | null, getSnapshot: () => PermitSealOwnerSnapshot | null, onConfirm = vi.fn(), onCancel = vi.fn(), clock: () => number = () => PK_KIT.SEAL_ARM_MS, paintAt = review?.ui.armedAtMs ?? clock()) {
  // Existing scenarios commit at their raise time, then advance the explicit test
  // clock to their tap time. Late-first-commit regressions supply paintAt below.
  let painting = true; const timeline = () => painting ? paintAt : clock();
  await act(async () => root.render(<PermitSealAdapter review={review} getSnapshot={getSnapshot} onConfirm={onConfirm} onCancel={onCancel} clock={timeline} />));
  painting = false;
  return { onConfirm, onCancel };
}
const prices: PriceStatus[] = ['OK', 'SERVER_ZERO', 'CHECKING', 'UNAVAILABLE', 'SHORT'];
const stages: MoneyStage[] = ['READY', 'FAILED', 'CHECK_WALLET', 'SENDING', 'SENT'];
it.each(prices.flatMap(price => stages.map(stage => [price, stage] as const)))
('binds %s / %s to the original owner at the real Seal primary', async (price, stage) => {
  const review = original(price), { onConfirm } = await mount(review, () => ({ review, stage, current: true }));
  const allowed = (price === 'OK' || price === 'SERVER_ZERO') && (stage === 'READY' || stage === 'FAILED');
  expect(button().disabled).toBe(!allowed); act(() => button().click());
  expect(onConfirm).toHaveBeenCalledTimes(allowed ? 1 : 0);
});
it.each(['requestId', 'wallet', 'baseId', 'epoch', 'generation'] as const)
('refuses a live %s change before React paints', async field => {
  const review = original(); let live: PermitSealOwnerSnapshot = { review, current: true, stage: 'READY' };
  const { onConfirm } = await mount(review, () => live); expect(button().disabled).toBe(false);
  const identity = { ...review.identity };
  if (field === 'epoch' || field === 'generation') identity[field]++;
  else identity[field] = 'another-original';
  live = { ...live, review: { ...review, identity } };
  act(() => button().click()); expect(onConfirm).not.toHaveBeenCalled();
});
it.each(['READY', 'FAILED'] as const)('requires current owner admission even in %s', async stage => {
  const review = original(); const { onConfirm } = await mount(review, () => ({ review, current: false, stage }));
  expect(button().disabled).toBe(true); act(() => button().click()); expect(onConfirm).not.toHaveBeenCalled();
});
it.each(['missing', 'unreviewed', 'throws'] as const)('fails closed when the original owner is %s', async state => {
  const review = original(); const { onConfirm } = await mount(review, () => {
    if (state === 'throws') throw Error('owner unavailable');
    return state === 'missing' ? null : { review: null, current: true, stage: 'READY' };
  });
  expect(button().disabled).toBe(true); act(() => button().click()); expect(onConfirm).not.toHaveBeenCalled();
});
it.each(['price', 'gets', 'lines', 'arming'] as const)('refuses changed displayed %s terms without a new render', async field => {
  const review = original(); let live: PermitSealOwnerSnapshot = { review, current: true, stage: 'READY' };
  const { onConfirm } = await mount(review, () => live);
  const ui = { ...review.ui };
  if (field === 'price') ui.price = { ...ui.price, amount: '2' };
  if (field === 'gets') ui.gets = { currency: 'GEMS', amount: '3', status: 'OK' };
  if (field === 'lines') ui.lines = ['Changed destination'];
  if (field === 'arming') ui.armedAtMs = PK_KIT.SEAL_ARM_MS;
  live = { ...live, review: { ...review, ui } };
  act(() => button().click()); expect(onConfirm).not.toHaveBeenCalled();
});
it('refuses in-place owner term changes against the painted snapshot', async () => {
  const review = original(); const { onConfirm } = await mount(review, () => ({ review, current: true, stage: 'READY' }));
  review.ui.price.amount = '2'; act(() => button().click()); expect(onConfirm).not.toHaveBeenCalled();
});
it('rechecks the original owner immediately before invoking its callback', async () => {
  const review = original(); let reads = 0, raced = false;
  const { onConfirm } = await mount(review, () => ({ review, stage: 'READY', current: !raced || ++reads === 1 }));
  raced = true; act(() => button().click()); expect(reads).toBe(2); expect(onConfirm).not.toHaveBeenCalled();
});
it('does not queue an early tap and delegates one admitted original callback', async () => {
  const review = original(); let now = PK_KIT.SEAL_ARM_MS - 1;
  const { onConfirm } = await mount(review, () => ({ review, current: true, stage: 'READY' }), vi.fn(), vi.fn(), () => now);
  act(() => button().click()); expect(onConfirm).not.toHaveBeenCalled(); now = PK_KIT.SEAL_ARM_MS;
  expect(onConfirm).not.toHaveBeenCalled(); act(() => button().click()); expect(onConfirm).toHaveBeenCalledOnce();
});
it.each(['BACK', 'Escape', 'scrim'] as const)('delegates %s cancellation while money eligibility is refused', async action => {
  const review = original('SHORT'), { onConfirm, onCancel } = await mount(review, () => ({ review, current: false, stage: 'SENDING' }));
  act(() => {
    if (action === 'BACK') host.querySelector<HTMLButtonElement>('button[aria-label="BACK"]')!.click();
    else if (action === 'Escape') host.querySelector('[role="alertdialog"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    else host.querySelector<HTMLElement>('.pk-seal__scrim')!.click();
  });
  expect(onCancel).toHaveBeenCalledOnce(); expect(onConfirm).not.toHaveBeenCalled();
});
it('keeps an exiting picture incapable of confirming after logical dismissal', async () => {
  const review = original(), snapshot = () => ({ review, current: true, stage: 'READY' as const });
  const { onConfirm, onCancel } = await mount(review, snapshot);
  await mount(null, snapshot, onConfirm, onCancel); expect(button().disabled).toBe(true);
  act(() => button().click()); expect(onConfirm).not.toHaveBeenCalled();
});

it.each(['READY', 'FAILED'] as const)('admits only one synchronous tap for the same %s identity', async stage => {
  const review = original(), { onConfirm } = await mount(review, () => ({ review, current: true, stage }));
  act(() => { button().click(); button().click(); }); expect(onConfirm).toHaveBeenCalledOnce();
});
it('does not release the original latch when the owner returns to READY', async () => {
  const review = original(); let stage: MoneyStage = 'READY'; const snapshot = () => ({ review, current: true, stage });
  const { onConfirm, onCancel } = await mount(review, snapshot); act(() => button().click());
  await mount(review, snapshot, onConfirm, onCancel); expect(button().disabled).toBe(true);
  act(() => button().click()); expect(onConfirm).toHaveBeenCalledOnce();
  stage = 'SENDING'; await mount(review, snapshot, onConfirm, onCancel);
  stage = 'READY'; await mount(review, snapshot, onConfirm, onCancel);
  act(() => button().click()); expect(onConfirm).toHaveBeenCalledOnce();
});
it('releases only a same-original FAILED result and consumes that retry synchronously', async () => {
  const review = original(); let stage: MoneyStage = 'READY'; const snapshot = () => ({ review, current: true, stage });
  const { onConfirm, onCancel } = await mount(review, snapshot); act(() => button().click());
  stage = 'SENDING'; await mount(review, snapshot, onConfirm, onCancel);
  stage = 'FAILED'; await mount(review, snapshot, onConfirm, onCancel);
  act(() => { button().click(); button().click(); }); expect(onConfirm).toHaveBeenCalledTimes(2);
  expect(snapshot().review.identity.requestId).toBe('original-permit');
});
it('does not use another original FAILED snapshot to release the displayed review', async () => {
  const review = original(); let live: PermitSealOwnerSnapshot = { review, current: true, stage: 'READY' };
  const { onConfirm } = await mount(review, () => live); act(() => button().click());
  live = { review: { ...review, identity: { ...review.identity, requestId: 'different-original' } }, current: true, stage: 'FAILED' };
  act(() => button().click()); expect(onConfirm).toHaveBeenCalledOnce();
});
it('clears a refused prompt through the original cancel callback without permitting a stale retry', async () => {
  const review = original('SHORT'), onConfirm = vi.fn(); let active: PermitSealReview | null = review;
  const snapshot = () => ({ review, current: false, stage: 'SENDING' as const });
  const render = () => <PermitSealAdapter review={active} getSnapshot={snapshot} onConfirm={onConfirm} onCancel={onCancel} clock={() => PK_KIT.SEAL_ARM_MS} />;
  const onCancel = vi.fn(() => { active = null; root.render(render()); });
  await act(async () => root.render(render()));
  act(() => host.querySelector<HTMLButtonElement>('button[aria-label="BACK"]')!.click());
  expect(onCancel).toHaveBeenCalledOnce(); expect(active).toBeNull(); expect(button().disabled).toBe(true);
  act(() => button().click()); expect(onConfirm).not.toHaveBeenCalled();
});
it('retains each original latch when a controlled review switches away and back', async () => {
  const first = original(), second = { ...original(), identity: { ...first.identity, requestId: 'second-original' } };
  let current = first; const snapshot = () => ({ review: current, current: true, stage: 'READY' as const });
  const { onConfirm, onCancel } = await mount(first, snapshot); act(() => button().click());
  current = second; await mount(second, snapshot, onConfirm, onCancel); act(() => button().click());
  current = first; await mount(first, snapshot, onConfirm, onCancel); act(() => button().click());
  expect(onConfirm).toHaveBeenCalledTimes(2);
});
it('requires a fresh observed non-FAILED stage before retrying an already FAILED review again', async () => {
  const review = original(); let stage: MoneyStage = 'FAILED'; const snapshot = () => ({ review, current: true, stage });
  const { onConfirm, onCancel } = await mount(review, snapshot); act(() => button().click());
  await mount(review, snapshot, onConfirm, onCancel); act(() => button().click()); expect(onConfirm).toHaveBeenCalledOnce();
  stage = 'SENDING'; await mount(review, snapshot, onConfirm, onCancel);
  stage = 'FAILED'; await mount(review, snapshot, onConfirm, onCancel);
  act(() => { button().click(); button().click(); }); expect(onConfirm).toHaveBeenCalledTimes(2);
});

it('uses the shared default clock when optional clock and exit callbacks are absent', async () => {
  let now = Date.now(); const clockSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
  const review = original(); review.ui.armedAtMs = now - PK_KIT.SEAL_ARM_MS; const onConfirm = vi.fn();
  try {
    await act(async () => root.render(<PermitSealAdapter review={review}
      getSnapshot={() => ({ review, current: true, stage: 'READY' })} onConfirm={onConfirm} onCancel={vi.fn()} />));
    now += PK_KIT.SEAL_ARM_MS;
    act(() => button().click()); expect(onConfirm).toHaveBeenCalledOnce();
  } finally { clockSpy.mockRestore(); }
});

it.each(['amount', 'CHECKING to OK'] as const)('requires a fresh raise and full arming after %s changes', async change => {
  let review = original(change === 'amount' ? 'OK' : 'CHECKING'), now = PK_KIT.SEAL_ARM_MS;
  const snapshot = () => ({ review, current: true, stage: 'READY' as const });
  const clock = () => now, { onConfirm, onCancel } = await mount(review, snapshot, vi.fn(), vi.fn(), clock);
  review = { ...review, ui: { ...review.ui, price: { ...review.ui.price, amount: change === 'amount' ? '2' : review.ui.price.amount, status: 'OK' } } };
  await mount(review, snapshot, onConfirm, onCancel, clock);
  expect(button().disabled).toBe(true); act(() => button().click()); expect(onConfirm).not.toHaveBeenCalled();
  review = { ...review, ui: { ...review.ui, armedAtMs: now } };
  await mount(review, snapshot, onConfirm, onCancel, clock);
  now = review.ui.armedAtMs + PK_KIT.SEAL_ARM_MS - 1;
  act(() => button().click()); expect(onConfirm).not.toHaveBeenCalled();
  now++; act(() => { button().click(); button().click(); }); expect(onConfirm).toHaveBeenCalledOnce();
});
it.each(['same raise', 'new raise'] as const)('keeps a READY attempt consumed after changed terms with the %s', async raise => {
  let review = original(), now = PK_KIT.SEAL_ARM_MS;
  const snapshot = () => ({ review, current: true, stage: 'READY' as const });
  const clock = () => now, { onConfirm, onCancel } = await mount(review, snapshot, vi.fn(), vi.fn(), clock);
  act(() => button().click()); expect(onConfirm).toHaveBeenCalledOnce();
  review = { ...review, ui: { ...review.ui, price: { ...review.ui.price, amount: '2' },
    armedAtMs: raise === 'same raise' ? review.ui.armedAtMs : now } };
  await mount(review, snapshot, onConfirm, onCancel, clock);
  now = review.ui.armedAtMs + PK_KIT.SEAL_ARM_MS;
  expect(button().disabled).toBe(true); act(() => button().click()); expect(onConfirm).toHaveBeenCalledOnce();
});
it('does not admit a second READY attempt when only armedAtMs changes and the new raise finishes arming', async () => {
  let review = original(), now = PK_KIT.SEAL_ARM_MS;
  const snapshot = () => ({ review, current: true, stage: 'READY' as const }), clock = () => now;
  const { onConfirm, onCancel } = await mount(review, snapshot, vi.fn(), vi.fn(), clock);
  act(() => button().click()); review = { ...review, ui: { ...review.ui, armedAtMs: now } };
  await mount(review, snapshot, onConfirm, onCancel, clock); now += PK_KIT.SEAL_ARM_MS;
  expect(button().disabled).toBe(true); act(() => { button().click(); button().click(); });
  expect(onConfirm).toHaveBeenCalledOnce();
});
it.each(['BACK', 'Escape', 'scrim'] as const)('keeps %s cancellation available when the getter throws', async action => {
  const { onConfirm, onCancel } = await mount(original(), () => { throw Error('owner unavailable'); });
  act(() => {
    if (action === 'BACK') host.querySelector<HTMLButtonElement>('button[aria-label="BACK"]')!.click();
    else if (action === 'Escape') host.querySelector('[role="alertdialog"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    else host.querySelector<HTMLElement>('.pk-seal__scrim')!.click();
  });
  expect(onCancel).toHaveBeenCalledOnce(); expect(onConfirm).not.toHaveBeenCalled();
});
it('observes an attempt by identity while current is false and terms differ, then admits one exact FAILED retry', async () => {
  const review = original(); let live: PermitSealOwnerSnapshot = { review, current: true, stage: 'FAILED' };
  const snapshot = () => live, { onConfirm, onCancel } = await mount(review, snapshot);
  act(() => button().click());
  live = { review: { ...review, ui: { ...review.ui, lines: ['Sending original'] } }, current: false, stage: 'SENDING' };
  await mount(review, snapshot, onConfirm, onCancel); expect(button().disabled).toBe(true);
  live = { review, current: true, stage: 'FAILED' }; await mount(review, snapshot, onConfirm, onCancel);
  expect(button().disabled).toBe(false); act(() => { button().click(); button().click(); });
  expect(onConfirm).toHaveBeenCalledTimes(2);
});
it('keeps a cancelled raise closed across dismissal but admits one freshly armed re-raise', async () => {
  let review = original(), now = PK_KIT.SEAL_ARM_MS;
  const snapshot = () => ({ review, current: true, stage: 'READY' as const }), clock = () => now;
  const { onConfirm, onCancel } = await mount(review, snapshot, vi.fn(), vi.fn(), clock);
  act(() => host.querySelector<HTMLButtonElement>('button[aria-label="BACK"]')!.click());
  await mount(null, snapshot, onConfirm, onCancel, clock);
  await mount(review, snapshot, onConfirm, onCancel, clock);
  expect(button().disabled).toBe(true); act(() => button().click()); expect(onConfirm).not.toHaveBeenCalled();
  review = { ...review, ui: { ...review.ui, armedAtMs: now } };
  await mount(review, snapshot, onConfirm, onCancel, clock);
  now += PK_KIT.SEAL_ARM_MS - 1; act(() => button().click()); expect(onConfirm).not.toHaveBeenCalled();
  now++; act(() => { button().click(); button().click(); });
  expect(onConfirm).toHaveBeenCalledOnce(); expect(onCancel).toHaveBeenCalledOnce();
});
it('keeps the attempt latch when a confirmed review is dismissed and re-raised', async () => {
  let review = original(); const snapshot = () => ({ review, current: true, stage: 'READY' as const });
  const { onConfirm, onCancel } = await mount(review, snapshot); act(() => button().click());
  await mount(null, snapshot, onConfirm, onCancel);
  review = { ...review, ui: { ...review.ui, armedAtMs: PK_KIT.SEAL_ARM_MS } };
  await mount(review, snapshot, onConfirm, onCancel, () => PK_KIT.SEAL_ARM_MS * 2);
  expect(button().disabled).toBe(true); act(() => button().click()); expect(onConfirm).toHaveBeenCalledOnce();
});
it('uses advancing owner counters for two immediate failures without a painted non-FAILED stage', async () => {
  const review = original(); let stage: MoneyStage = 'FAILED', attemptCounter = 0;
  const snapshot = () => ({ review, current: true, stage, attemptCounter });
  const onConfirm = vi.fn(() => { stage = 'SENDING'; attemptCounter++; stage = 'FAILED'; });
  const onCancel = vi.fn(); await mount(review, snapshot, onConfirm, onCancel);
  act(() => button().click()); expect(onConfirm).toHaveBeenCalledOnce();
  await mount(review, snapshot, onConfirm, onCancel); act(() => button().click());
  expect(onConfirm).toHaveBeenCalledTimes(2);
  await mount(review, snapshot, onConfirm, onCancel); act(() => button().click());
  expect(onConfirm).toHaveBeenCalledTimes(3); expect(attemptCounter).toBe(3);
  expect(snapshot().review.identity.requestId).toBe('original-permit');
});
it('consumes each owner failure counter once and prefers it over a repeated non-FAILED observation', async () => {
  const review = original(); let stage: MoneyStage = 'FAILED', attemptCounter = 0;
  const snapshot = () => ({ review, current: true, stage, attemptCounter });
  const { onConfirm, onCancel } = await mount(review, snapshot); act(() => button().click());
  stage = 'SENDING'; await mount(review, snapshot, onConfirm, onCancel);
  stage = 'FAILED'; await mount(review, snapshot, onConfirm, onCancel);
  expect(button().disabled).toBe(true); act(() => button().click()); expect(onConfirm).toHaveBeenCalledOnce();
  attemptCounter++; await mount(review, snapshot, onConfirm, onCancel);
  act(() => { button().click(); button().click(); }); expect(onConfirm).toHaveBeenCalledTimes(2);
  await mount(review, snapshot, onConfirm, onCancel); expect(button().disabled).toBe(true);
  act(() => button().click()); expect(onConfirm).toHaveBeenCalledTimes(2);
});
it('never releases on READY even when the owner counter advances', async () => {
  const review = original(); let attemptCounter = 0;
  const snapshot = () => ({ review, current: true, stage: 'READY' as const, attemptCounter });
  const { onConfirm, onCancel } = await mount(review, snapshot); act(() => button().click());
  attemptCounter++; await mount(review, snapshot, onConfirm, onCancel);
  expect(button().disabled).toBe(true); act(() => button().click()); expect(onConfirm).toHaveBeenCalledOnce();
});
it('requires the same current original and exact terms even with an advancing FAILED counter', async () => {
  const review = original(); let live: PermitSealOwnerSnapshot = { review, stage: 'FAILED', current: true, attemptCounter: 0 };
  const snapshot = () => live, { onConfirm, onCancel } = await mount(review, snapshot); act(() => button().click());
  live = { ...live, current: false, attemptCounter: 1 }; await mount(review, snapshot, onConfirm, onCancel);
  expect(button().disabled).toBe(true); act(() => button().click()); expect(onConfirm).toHaveBeenCalledOnce();
  live = { ...live, current: true, review: { ...review, identity: { ...review.identity, requestId: 'other' } } };
  await mount(review, snapshot, onConfirm, onCancel); act(() => button().click()); expect(onConfirm).toHaveBeenCalledOnce();
  live = { ...live, review: { ...review, ui: { ...review.ui, price: { ...review.ui.price, amount: '2' } } } };
  await mount(review, snapshot, onConfirm, onCancel); act(() => button().click()); expect(onConfirm).toHaveBeenCalledOnce();
  live = { ...live, review }; await mount(review, snapshot, onConfirm, onCancel);
  act(() => { button().click(); button().click(); }); expect(onConfirm).toHaveBeenCalledTimes(2);
});
it.each([NaN, Infinity, -1, 0.5])('rejects an invalid owner counter %s', async attemptCounter => {
  const review = original(), { onConfirm } = await mount(review, () => ({ review, current: true, stage: 'FAILED', attemptCounter }));
  expect(button().disabled).toBe(true); act(() => button().click()); expect(onConfirm).not.toHaveBeenCalled();
});
it('refuses a missing or regressed counter after a larger counter was committed during sending', async () => {
  const review = original(); let live: PermitSealOwnerSnapshot = { review, current: true, stage: 'FAILED', attemptCounter: 0 };
  const snapshot = () => live, { onConfirm, onCancel } = await mount(review, snapshot); act(() => button().click());
  live = { review, current: false, stage: 'SENDING', attemptCounter: 2 }; await mount(review, snapshot, onConfirm, onCancel);
  live = { review, current: true, stage: 'FAILED', attemptCounter: 1 }; await mount(review, snapshot, onConfirm, onCancel);
  expect(button().disabled).toBe(true); act(() => button().click()); expect(onConfirm).toHaveBeenCalledOnce();
  live = { review, current: true, stage: 'FAILED' }; await mount(review, snapshot, onConfirm, onCancel);
  expect(button().disabled).toBe(true); act(() => button().click()); expect(onConfirm).toHaveBeenCalledOnce();
  live = { ...live, attemptCounter: 2 }; await mount(review, snapshot, onConfirm, onCancel);
  act(() => { button().click(); button().click(); }); expect(onConfirm).toHaveBeenCalledTimes(2);
});
it('does not record terms from a suspended render that never commits', async () => {
  const never = new Promise<void>(() => {}), Blocked = (): React.JSX.Element => { throw never; };
  let live = original(), suspend = false, painted: PermitSealReview | null = null, now = 0;
  const snapshot = () => ({ review: live, current: true, stage: 'READY' as const }), onConfirm = vi.fn();
  const render = () => <Suspense fallback={<span>Pending</span>}><PermitSealAdapter review={painted}
    getSnapshot={snapshot} onConfirm={onConfirm} onCancel={vi.fn()} clock={() => now} />
    {suspend ? <Blocked /> : null}</Suspense>;
  await act(async () => root.render(render()));
  painted = live; suspend = true; await act(async () => startTransition(() => root.render(render())));
  expect(button()).toBeNull();
  live = { ...live, ui: { ...live.ui, price: { ...live.ui.price, amount: '2' } } }; painted = live; suspend = false;
  await act(async () => root.render(render())); expect(button().disabled).toBe(false);
  now = PK_KIT.SEAL_ARM_MS;
  act(() => button().click()); expect(onConfirm).toHaveBeenCalledOnce();
});

it('refuses a counter disappearing before any attempt latch exists', async () => {
  const review = original(); let live: PermitSealOwnerSnapshot = { review, current: true, stage: 'READY', attemptCounter: 1 };
  const snapshot = () => live, { onConfirm, onCancel } = await mount(review, snapshot);
  expect(button().disabled).toBe(false);
  live = { review, current: true, stage: 'READY' }; await mount(review, snapshot, onConfirm, onCancel);
  expect(button().disabled).toBe(true); act(() => button().click()); expect(onConfirm).not.toHaveBeenCalled();
});
it('refuses a counter disappearing after a legacy latch observed an attempt and then a counter', async () => {
  const review = original(); let live: PermitSealOwnerSnapshot = { review, current: true, stage: 'FAILED' };
  const snapshot = () => live, { onConfirm, onCancel } = await mount(review, snapshot); act(() => button().click());
  expect(onConfirm).toHaveBeenCalledOnce();
  live = { review, current: false, stage: 'SENDING', attemptCounter: 1 }; await mount(review, snapshot, onConfirm, onCancel);
  live = { review, current: true, stage: 'FAILED', attemptCounter: 1 }; await mount(review, snapshot, onConfirm, onCancel);
  expect(button().disabled).toBe(false);
  live = { review, current: true, stage: 'FAILED' }; await mount(review, snapshot, onConfirm, onCancel);
  expect(button().disabled).toBe(true); act(() => button().click()); expect(onConfirm).toHaveBeenCalledOnce();
});
it('permanently taints a committed T1 to T2 to T1 raise until a new armedAtMs', async () => {
  const first = original(); let review = first;
  const snapshot = () => ({ review, current: true, stage: 'READY' as const });
  const { onConfirm, onCancel } = await mount(review, snapshot); expect(button().disabled).toBe(false);
  review = { ...first, ui: { ...first.ui, price: { ...first.ui.price, amount: '2' } } };
  await mount(review, snapshot, onConfirm, onCancel); expect(button().disabled).toBe(true);
  review = first; await mount(review, snapshot, onConfirm, onCancel);
  expect(button().disabled).toBe(true); act(() => button().click()); expect(onConfirm).not.toHaveBeenCalled();
  review = { ...first, ui: { ...first.ui, armedAtMs: PK_KIT.SEAL_ARM_MS } };
  await mount(review, snapshot, onConfirm, onCancel, () => PK_KIT.SEAL_ARM_MS * 2);
  act(() => button().click()); expect(onConfirm).toHaveBeenCalledOnce();
});
it('does not admit an older first-painted raise after another raise committed', async () => {
  const first = original(), second = { ...first, ui: { ...first.ui, armedAtMs: PK_KIT.SEAL_ARM_MS,
    price: { ...first.ui.price, amount: '2' } } };
  let review = first; const snapshot = () => ({ review, current: true, stage: 'READY' as const });
  const clock = () => PK_KIT.SEAL_ARM_MS * 2, { onConfirm, onCancel } = await mount(first, snapshot, vi.fn(), vi.fn(), clock);
  review = second; await mount(second, snapshot, onConfirm, onCancel, clock); expect(button().disabled).toBe(false);
  review = first; await mount(first, snapshot, onConfirm, onCancel, clock);
  expect(button().disabled).toBe(true); act(() => button().click()); expect(onConfirm).not.toHaveBeenCalled();
});
it.each(['stale', 'future'] as const)('arms from the later of first commit and %s armedAtMs, never queues the early tap', async timestamp => {
  let now = PK_KIT.SEAL_ARM_MS; const review = original();
  if (timestamp === 'future') review.ui.armedAtMs = PK_KIT.SEAL_ARM_MS * 2;
  const armFrom = Math.max(review.ui.armedAtMs, now), snapshot = () => ({ review, current: true, stage: 'READY' as const });
  const { onConfirm } = await mount(review, snapshot, vi.fn(), vi.fn(), () => now, now);
  act(() => button().click()); expect(onConfirm).not.toHaveBeenCalled();
  now = armFrom + PK_KIT.SEAL_ARM_MS - 1; act(() => button().click()); expect(onConfirm).not.toHaveBeenCalled();
  now++; expect(onConfirm).not.toHaveBeenCalled(); act(() => { button().click(); button().click(); });
  expect(onConfirm).toHaveBeenCalledOnce();
});
it('rechecks the commit-based arm time immediately before calling the original owner', async () => {
  const review = original(); let raced = false, reads = 0;
  const clock = () => !raced || ++reads === 1 ? PK_KIT.SEAL_ARM_MS : 0;
  const { onConfirm } = await mount(review, () => ({ review, current: true, stage: 'READY' }), vi.fn(), vi.fn(), clock);
  raced = true; act(() => button().click()); expect(reads).toBe(2); expect(onConfirm).not.toHaveBeenCalled();
});
it('admits one double tap while an async owner atomically publishes its counter and non-FAILED stage', async () => {
  const review = original(); let live: PermitSealOwnerSnapshot = { review, current: true, stage: 'FAILED', attemptCounter: 0 };
  let finish = () => {}; const completion = new Promise<void>(resolve => { finish = resolve; });
  const onConfirm = vi.fn(async () => {
    live = { ...live, stage: 'SENDING', attemptCounter: live.attemptCounter! + 1 };
    await completion; live = { ...live, stage: 'FAILED' };
  });
  await mount(review, () => live, onConfirm);
  act(() => { button().click(); button().click(); });
  expect(onConfirm).toHaveBeenCalledOnce(); expect(live.stage).toBe('SENDING'); expect(live.attemptCounter).toBe(1);
  await act(async () => { finish(); await completion; });
  expect(live.stage).toBe('FAILED'); expect(onConfirm).toHaveBeenCalledOnce();
});

it.each(['NaN', 'throws'] as const)('refuses a %s commit clock while retaining BACK and a freshly armed same-identity raise', async failure => {
  let review = original(), now = 0, reads = 0;
  const snapshot = () => ({ review, current: true, stage: 'READY' as const, attemptCounter: 0 });
  const onConfirm = vi.fn(), onCancel = vi.fn(), errors: unknown[] = [];
  const recordError = (event: ErrorEvent) => { errors.push(event.error ?? event.message); event.preventDefault(); };
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  // PkSeal reads once while rendering; the next read is the adapter's first
  // layout commit. Fail only that read, so this cannot pass by testing render.
  const clock = vi.fn(() => {
    if (++reads === 2) {
      if (failure === 'throws') throw Error('commit clock unavailable');
      return Number.NaN;
    }
    return now;
  });
  const render = () => <PermitSealAdapter review={review} getSnapshot={snapshot}
    onConfirm={onConfirm} onCancel={onCancel} clock={clock} />;
  window.addEventListener('error', recordError);
  try {
    await act(async () => root.render(render()));
    expect(clock.mock.results[1]?.type).toBe(failure === 'throws' ? 'throw' : 'return');
    if (failure === 'NaN') expect(clock.mock.results[1]?.value).toBeNaN();
    now = PK_KIT.SEAL_ARM_MS;
    expect(button()).not.toBeNull(); act(() => button().click());
    expect(onConfirm).not.toHaveBeenCalled();
    const back = host.querySelector<HTMLButtonElement>('button[aria-label="BACK"]');
    expect(back).not.toBeNull(); expect(back!.disabled).toBe(false);
    act(() => back!.click()); expect(onCancel).toHaveBeenCalledOnce();
    expect(errors).toEqual([]); expect(consoleError).not.toHaveBeenCalled();
    // Keep the identity/counter. Only the fresh arm can recover an invalid
    // first-commit timestamp; elapsed wall time never rehabilitates the old arm.
    review = { ...review, ui: { ...review.ui, armedAtMs: now } };
    await act(async () => root.render(render()));
    now += PK_KIT.SEAL_ARM_MS - 1; act(() => button().click());
    expect(onConfirm).not.toHaveBeenCalled();
    now++; act(() => { button().click(); button().click(); });
    expect(onConfirm).toHaveBeenCalledOnce(); expect(onCancel).toHaveBeenCalledOnce();
    expect(errors).toEqual([]); expect(consoleError).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener('error', recordError); consoleError.mockRestore();
  }
});

it.each([1, 2] as const)('refuses a throw at tap clock read %s without consuming the original attempt or losing BACK', async failingRead => {
  let review = original(), now = PK_KIT.SEAL_ARM_MS, failTap = false, tapReads = 0;
  const snapshot = () => ({ review, current: true, stage: 'READY' as const, attemptCounter: 0 });
  const onConfirm = vi.fn(), onCancel = vi.fn(), errors: unknown[] = [];
  const recordError = (event: ErrorEvent) => { errors.push(event.error ?? event.message); event.preventDefault(); };
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  // Read 1 is the real Seal's tap check; read 2 is the adapter's final check.
  const clock = () => {
    if (failTap && ++tapReads === failingRead) throw Error('tap clock unavailable');
    return now;
  };
  window.addEventListener('error', recordError);
  try {
    await mount(review, snapshot, onConfirm, onCancel, clock);
    expect(button().disabled).toBe(false);
    failTap = true; act(() => button().click());
    expect(tapReads).toBe(failingRead); expect(onConfirm).not.toHaveBeenCalled();
    const back = host.querySelector<HTMLButtonElement>('button[aria-label="BACK"]');
    expect(back).not.toBeNull(); expect(back!.disabled).toBe(false);
    act(() => back!.click()); expect(onCancel).toHaveBeenCalledOnce();
    expect(errors).toEqual([]); expect(consoleError).not.toHaveBeenCalled();
    failTap = false;
    // BACK retires this raise, not its identity. A wrongly consumed attempt
    // latch would still refuse this same-identity READY raise after full arming.
    review = { ...review, ui: { ...review.ui, armedAtMs: now } };
    await mount(review, snapshot, onConfirm, onCancel, clock);
    now += PK_KIT.SEAL_ARM_MS - 1; act(() => button().click());
    expect(onConfirm).not.toHaveBeenCalled();
    now++; act(() => { button().click(); button().click(); });
    expect(onConfirm).toHaveBeenCalledOnce(); expect(onCancel).toHaveBeenCalledOnce();
    expect(errors).toEqual([]); expect(consoleError).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener('error', recordError); consoleError.mockRestore();
  }
});

it('does not taint committed T1 when same-arm T2 renders in a suspended discarded transition', async () => {
  const first = original(), changed = { ...first, ui: { ...first.ui, price: { ...first.ui.price, amount: '2' } } };
  const never = new Promise<void>(() => {}); let suspensions = 0;
  const Blocked = (): React.JSX.Element => { suspensions++; throw never; };
  let live = first, painted = first, suspend = false, now = 0;
  const observedAmounts: string[] = [], onConfirm = vi.fn();
  const snapshot = () => {
    observedAmounts.push(live.ui.price.amount!);
    return { review: live, current: true, stage: 'READY' as const, attemptCounter: 0 };
  };
  const render = () => <Suspense fallback={<span>Pending changed terms</span>}>
    <PermitSealAdapter review={painted} getSnapshot={snapshot} onConfirm={onConfirm}
      onCancel={vi.fn()} clock={() => now} />{suspend ? <Blocked /> : null}
  </Suspense>;
  await act(async () => root.render(render()));
  expect(button().disabled).toBe(false); now = PK_KIT.SEAL_ARM_MS;
  observedAmounts.length = 0; live = changed; painted = changed; suspend = true;
  await act(async () => startTransition(() => root.render(render())));
  expect(suspensions).toBeGreaterThan(0); expect(observedAmounts).toContain('2');
  expect(host.textContent).not.toContain('Pending changed terms');
  expect(host.querySelector('.pk-seal__amount')?.textContent).toBe('1');
  expect(onConfirm).not.toHaveBeenCalled();
  live = first; painted = first; suspend = false;
  await act(async () => root.render(render()));
  expect(button().disabled).toBe(false);
  act(() => { button().click(); button().click(); });
  expect(onConfirm).toHaveBeenCalledOnce();
});
