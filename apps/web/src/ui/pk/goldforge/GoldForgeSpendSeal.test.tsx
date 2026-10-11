/** @vitest-environment happy-dom */
import { act, startTransition, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GoldForgeSpendSeal, type GoldForgeSpendReview, type GoldForgeSpendSnapshot } from './GoldForgeSpendSeal';
import { PK_KIT, UNKNOWN } from '../kitLogic';
import type { MoneyStage, PriceStatus } from '../types';

const original = (): GoldForgeSpendReview => ({
  identity: { requestId: 'original-spend', wallet: 'wallet-not-for-display', baseId: 'base-a', epoch: 1, generation: 1 },
  ui: { kind: 'FINISH', title: 'FINISH NOW?', subjectArt: 'workshop', subjectName: 'WORKSHOP',
    subjectLine: 'Lv 2 › 3', progress: null, timeLeft: '2h 14m',
    price: { currency: 'GEMS', amount: '120', status: 'OK' }, have: '1,250', after: '1,130', short: null,
    quotedAtMs: 1_000, stage: 'READY' },
});
const admitted = (review: GoldForgeSpendReview): GoldForgeSpendSnapshot => ({
  review, current: true, actionsAllowed: true, freshActionsAllowed: true, retryAllowed: false,
});
const raised = (review: GoldForgeSpendReview, armedAtMs: number): GoldForgeSpendReview => ({
  ...review, ui: { ...review.ui, armedAtMs },
});
let host: HTMLDivElement, root: ReturnType<typeof createRoot>, defaultNow: number;
const defaultClock = () => defaultNow;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  defaultNow = 1_000;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const primary = () => host.querySelector<HTMLButtonElement>('.pk-seal__primary')!;
async function mount(review: GoldForgeSpendReview | null, getSnapshot: () => GoldForgeSpendSnapshot | null,
  onConfirm = vi.fn(), onCancel = vi.fn(), clock = defaultClock) {
  await act(async () => root.render(<GoldForgeSpendSeal review={review} getSnapshot={getSnapshot}
    onConfirm={onConfirm} onCancel={onCancel} clock={clock} />));
  // WHY cbe4a25b: old timestamps no longer skip the first committed picture's
  // full delay. Legacy guard fixtures explicitly finish that delay AFTER commit
  // to isolate their intended guard. Custom-clock cases control every wait.
  if (clock === defaultClock) defaultNow += PK_KIT.SEAL_ARM_MS;
  return { onConfirm, onCancel };
}

it('shows exact quoted strings without displaying the owner wallet or invoking callbacks on mount', async () => {
  const review = original(), { onConfirm, onCancel } = await mount(review, () => admitted(review));
  expect(host.textContent).toContain('120'); expect(host.textContent).toContain('1,250');
  expect(host.textContent).toContain('1,130'); expect(host.textContent).toContain('WORKSHOP');
  expect(host.textContent).not.toContain(review.identity.wallet);
  expect(onConfirm).not.toHaveBeenCalled(); expect(onCancel).not.toHaveBeenCalled();
});

it.each(['requestId', 'wallet', 'baseId', 'epoch', 'generation'] as const)
('refuses a live original %s change before React paints', async field => {
  const review = original(); let live = admitted(review);
  const { onConfirm } = await mount(review, () => live);
  const identity = { ...review.identity };
  if (field === 'epoch' || field === 'generation') identity[field]++;
  else identity[field] = 'different-original';
  live = { ...live, review: { ...review, identity } };
  act(() => primary().click()); expect(onConfirm).not.toHaveBeenCalled();
});

it.each(['amount', 'currency', 'quotedAtMs', 'armedAtMs', 'have', 'after', 'title', 'subject', 'time'] as const)
('refuses changed %s terms, including in-place mutations', async field => {
  const review = original(), { onConfirm } = await mount(review, () => admitted(review));
  if (field === 'amount') review.ui.price.amount = '121';
  if (field === 'currency') review.ui.price.currency = 'KEEP';
  if (field === 'quotedAtMs') review.ui.quotedAtMs++;
  if (field === 'armedAtMs') review.ui.armedAtMs = 1_001;
  if (field === 'have') review.ui.have = '1,251';
  if (field === 'after') review.ui.after = '1,131';
  if (field === 'title') review.ui.title = 'BUY NOW?';
  if (field === 'subject') review.ui.subjectName = 'BARRACKS';
  if (field === 'time') review.ui.timeLeft = '2h 13m';
  act(() => primary().click()); expect(onConfirm).not.toHaveBeenCalled();
});

it.each(['current', 'actionsAllowed', 'freshActionsAllowed'] as const)
('holds fresh confirmation when the owner closes %s', async field => {
  const review = original(), live = { ...admitted(review), [field]: false };
  const { onConfirm } = await mount(review, () => live);
  expect(primary().disabled).toBe(true); act(() => primary().click()); expect(onConfirm).not.toHaveBeenCalled();
  expect(host.textContent).toContain('1,250');
});

it.each(['missing', 'unreviewed', 'throws'] as const)
('keeps cancellation while the live owner is %s', async state => {
  const review = original(), { onConfirm, onCancel } = await mount(review, () => {
    if (state === 'throws') throw Error('owner unavailable');
    return state === 'missing' ? null : { ...admitted(review), review: null };
  });
  expect(primary().disabled).toBe(true);
  act(() => host.querySelector<HTMLButtonElement>('button[aria-label="BACK"]')!.click());
  expect(onCancel).toHaveBeenCalledOnce(); expect(onConfirm).not.toHaveBeenCalled();
});

const statuses: PriceStatus[] = ['CHECKING', 'UNAVAILABLE', 'SHORT', 'SERVER_ZERO'];
it.each(statuses)('holds %s: helper price status is not admission or a new shared Seal API', async status => {
  const review = original(); review.ui.price = { ...review.ui.price, status, amount: status === 'SERVER_ZERO' ? '0' : null };
  const { onConfirm } = await mount(review, () => admitted(review));
  expect(primary().disabled).toBe(true); act(() => primary().click()); expect(onConfirm).not.toHaveBeenCalled();
  expect(host.textContent).toContain(status === 'SHORT' ? 'Not enough Gems' : 'Return to the original review');
});
it('does not treat a zero OK price, unknown amount or another currency as an admitted Gems quote', async () => {
  for (const price of [
    { currency: 'GEMS', amount: '0', status: 'OK' },
    { currency: 'GEMS', amount: UNKNOWN, status: 'OK' },
    { currency: 'KEEP', amount: '120', status: 'OK' },
  ] as const) {
    const review = original(); review.ui.price = price;
    const { onConfirm } = await mount(review, () => admitted(review));
    expect(primary().disabled).toBe(true); act(() => primary().click()); expect(onConfirm).not.toHaveBeenCalled();
  }
});

it.each(['CHECK_WALLET', 'SENDING', 'SENT'] as const)
('never derives confirmation or terminal success from stage %s', async (stage: MoneyStage) => {
  const review = original(); review.ui.stage = stage;
  const { onConfirm } = await mount(review, () => admitted(review));
  expect(primary().disabled).toBe(true); act(() => primary().click()); expect(onConfirm).not.toHaveBeenCalled();
  expect(host.textContent).not.toContain('DONE'); expect(host.textContent).not.toContain('SENT');
});
it('requires an authoritative refusal and explicit original-owner admission for FAILED retry', async () => {
  const review = original(); review.ui.stage = 'FAILED';
  for (const [failure, retryAllowed] of [[null, true], ['UNCERTAIN', true], ['REFUSED', false]] as const) {
    review.ui.failure = failure;
    const { onConfirm } = await mount(review, () => ({ ...admitted(review), retryAllowed }));
    expect(primary().disabled).toBe(true); act(() => primary().click()); expect(onConfirm).not.toHaveBeenCalled();
  }
});

it('normalizes a missing arm but waits from first commit, ignores early taps, and never queues confirmation', async () => {
  // WHY cbe4a25b: the quote supplies identity, never an already-elapsed UI delay.
  const review = original(); let now = 2_000;
  const { onConfirm } = await mount(review, () => admitted(review), vi.fn(), vi.fn(), () => now);
  act(() => primary().click()); expect(onConfirm).not.toHaveBeenCalled();
  now += PK_KIT.SEAL_ARM_MS - 1; act(() => primary().click()); expect(onConfirm).not.toHaveBeenCalled();
  now++; expect(onConfirm).not.toHaveBeenCalled(); act(() => primary().click());
  expect(onConfirm).toHaveBeenCalledOnce(); expect(onConfirm).toHaveBeenCalledWith(review.identity);
});
it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5])
('holds an invalid arming time %s and retains BACK', async armedAtMs => {
  const review = original(); review.ui.armedAtMs = armedAtMs;
  const { onConfirm, onCancel } = await mount(review, () => admitted(review));
  expect(primary().disabled).toBe(true); act(() => primary().click());
  act(() => host.querySelector<HTMLButtonElement>('button[aria-label="BACK"]')!.click());
  expect(onConfirm).not.toHaveBeenCalled(); expect(onCancel).toHaveBeenCalledOnce();
});
it('rechecks owner eligibility again immediately before its callback', async () => {
  const review = original(); let reads = 0, racing = false;
  const { onConfirm } = await mount(review, () => ({ ...admitted(review), current: !racing || ++reads === 1 }));
  racing = true; act(() => primary().click()); expect(onConfirm).not.toHaveBeenCalled();
});
it('latches synchronously so two taps in one React frame issue one original callback', async () => {
  const review = original(), { onConfirm } = await mount(review, () => admitted(review));
  act(() => { primary().click(); primary().click(); });
  expect(onConfirm).toHaveBeenCalledOnce(); expect(onConfirm).toHaveBeenCalledWith(review.identity);
  await mount(review, () => admitted(review), onConfirm); act(() => primary().click());
  expect(onConfirm).toHaveBeenCalledOnce();
});
it('releases only one retry after admitted FAILED and requires a new failure observation after that retry', async () => {
  // WHY1088ff5e: refusal/retry admission no longer permits a second consent on
  // the first arm. Preserve refusal, duplicate and failure-episode assertions,
  // with a fresh fully elapsed arm for each admitted original retry.
  const review = original(); let live = admitted(review), now = 2_000;
  const { onConfirm } = await mount(review, () => live, vi.fn(), vi.fn(), () => now); now += PK_KIT.SEAL_ARM_MS; act(() => primary().click());
  const failed = { ...review, ui: { ...review.ui, stage: 'FAILED' as const, failure: 'REFUSED' as const } };
  live = { ...admitted(failed), retryAllowed: false };
  await mount(failed, () => live, onConfirm, vi.fn(), () => now); act(() => primary().click()); expect(onConfirm).toHaveBeenCalledTimes(1);
  const retry = raised(failed, now); live = { ...admitted(retry), retryAllowed: true };
  await mount(retry, () => live, onConfirm, vi.fn(), () => now);
  act(() => primary().click()); expect(onConfirm).toHaveBeenCalledTimes(1);
  now += PK_KIT.SEAL_ARM_MS; act(() => { primary().click(); primary().click(); });
  expect(onConfirm).toHaveBeenCalledTimes(2);
  await mount(retry, () => live, onConfirm, vi.fn(), () => now); act(() => primary().click()); expect(onConfirm).toHaveBeenCalledTimes(2);
  const sending = { ...retry, ui: { ...retry.ui, stage: 'SENDING' as const } };
  live = { ...admitted(sending), retryAllowed: false }; await mount(sending, () => live, onConfirm, vi.fn(), () => now);
  const nextRetry = raised(failed, ++now); live = { ...admitted(nextRetry), retryAllowed: true };
  await mount(nextRetry, () => live, onConfirm, vi.fn(), () => now);
  act(() => primary().click()); expect(onConfirm).toHaveBeenCalledTimes(2);
  now += PK_KIT.SEAL_ARM_MS;
  act(() => primary().click()); expect(onConfirm).toHaveBeenCalledTimes(3);
  for (const call of onConfirm.mock.calls) expect(call[0]).toEqual(review.identity);
});
it('never resets an issued request by changing its quote, dismissing, or revisiting its identity', async () => {
  const review = original(), { onConfirm } = await mount(review, () => admitted(review));
  act(() => primary().click());
  const changed = { ...review, ui: { ...review.ui, price: { ...review.ui.price, amount: '119' }, quotedAtMs: 999 } };
  await mount(changed, () => admitted(changed), onConfirm); act(() => primary().click());
  await mount(null, () => admitted(review), onConfirm);
  await mount(review, () => admitted(review), onConfirm); act(() => primary().click());
  expect(onConfirm).toHaveBeenCalledOnce();
});
it.each(['BACK', 'Escape', 'scrim'] as const)
('forwards %s even while a request is SENDING and its snapshot throws', async action => {
  const review = original(); review.ui.stage = 'SENDING';
  const { onCancel, onConfirm } = await mount(review, () => { throw Error('unavailable'); });
  act(() => {
    if (action === 'BACK') host.querySelector<HTMLButtonElement>('button[aria-label="BACK"]')!.click();
    else if (action === 'Escape') host.querySelector('[role="alertdialog"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    else host.querySelector<HTMLElement>('.pk-seal__scrim')!.click();
  });
  expect(onCancel).toHaveBeenCalledOnce(); expect(onConfirm).not.toHaveBeenCalled();
});
it('leaves an exiting picture unable to confirm', async () => {
  const review = original(), { onConfirm } = await mount(review, () => admitted(review));
  await mount(null, () => admitted(review), onConfirm); expect(primary().disabled).toBe(true);
  act(() => primary().click()); expect(onConfirm).not.toHaveBeenCalled();
});

it.each(['0', '0.00', UNKNOWN, '', '-5', '1x'])('shows an invalid price %s as unknown, including its accessibility description', async amount => {
  for (const status of ['OK', 'SHORT'] as const) {
    const review = original(); review.ui.price = { ...review.ui.price, amount, status, description: 'STALE PRICE DESCRIPTION' };
    const { onConfirm } = await mount(review, () => admitted(review));
    expect(host.querySelector('.pk-seal__amount')!.textContent).toBe(UNKNOWN);
    expect(host.innerHTML).not.toContain('STALE PRICE DESCRIPTION');
    expect(primary().disabled).toBe(true); act(() => primary().click()); expect(onConfirm).not.toHaveBeenCalled();
  }
});
it('does not offer GET GEMS when the shared Seal cannot provide its navigation action', async () => {
  const review = original(); review.ui.price.status = 'SHORT'; review.ui.short = '40';
  const { onConfirm } = await mount(review, () => admitted(review));
  expect(primary().textContent).toContain('NOT ENOUGH'); expect(primary().disabled).toBe(true);
  expect(host.textContent).not.toContain('GET GEMS'); act(() => primary().click()); expect(onConfirm).not.toHaveBeenCalled();
});
it.each(['epoch', 'generation'] as const)('refuses non-finite owner %s identities without serialization collisions', async field => {
  const review = original(); review.identity[field] = Number.NaN;
  const { onConfirm } = await mount(review, () => admitted({ ...review, identity: { ...review.identity, [field]: Number.POSITIVE_INFINITY } }));
  expect(primary().disabled).toBe(true); act(() => primary().click()); expect(onConfirm).not.toHaveBeenCalled();
});
it('never releases a refused original for a substituted quote or arming time', async () => {
  // WHY1088ff5e: raw arm 999 normalizes to the original quote's 1000, so it
  // remains the same arm and must stay closed. A later arm is tested separately.
  const review = original(), { onConfirm } = await mount(review, () => admitted(review));
  act(() => primary().click());
  for (const delta of [{ price: { ...review.ui.price, amount: '119' } }, { armedAtMs: 999 }]) {
    const failed: GoldForgeSpendReview = { ...review, ui: { ...review.ui, ...delta, stage: 'FAILED', failure: 'REFUSED' } };
    await mount(failed, () => ({ ...admitted(failed), retryAllowed: true }), onConfirm);
    expect(primary().disabled).toBe(true); act(() => primary().click());
  }
  expect(onConfirm).toHaveBeenCalledOnce();
});
it.each(['BACK', 'Escape', 'scrim'] as const)('%s closes admission synchronously before the owner clears its prompt', async action => {
  const review = original(), { onCancel, onConfirm } = await mount(review, () => admitted(review));
  act(() => {
    if (action === 'BACK') host.querySelector<HTMLButtonElement>('button[aria-label="BACK"]')!.click();
    else if (action === 'Escape') host.querySelector('[role="alertdialog"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    else host.querySelector<HTMLElement>('.pk-seal__scrim')!.click();
    primary().click();
  });
  expect(onCancel).toHaveBeenCalledOnce(); expect(onConfirm).not.toHaveBeenCalled();
  await mount(review, () => admitted(review), onConfirm, onCancel); act(() => primary().click());
  expect(onConfirm).not.toHaveBeenCalled();
});
it('directs an explicit shortfall back to the original review even when the price status is OK', async () => {
  const review = original(); review.ui.short = '40';
  const { onConfirm } = await mount(review, () => admitted(review));
  expect(primary().disabled).toBe(true); expect(host.textContent).toContain('Return to the original review');
  act(() => primary().click()); expect(onConfirm).not.toHaveBeenCalled();
});

it('admits an initial review only after its first-commit delay without another owner render', async () => {
  // WHY cbe4a25b: structural eligibility stays usable while shared Seal blocks
  // early taps; an old producer timestamp cannot make first paint confirmable.
  const review = original(); let now = 2_000;
  const { onConfirm } = await mount(review, () => admitted(review), vi.fn(), vi.fn(), () => now);
  expect(primary().disabled).toBe(false); act(() => primary().click()); expect(onConfirm).not.toHaveBeenCalled();
  now += PK_KIT.SEAL_ARM_MS - 1; act(() => primary().click()); expect(onConfirm).not.toHaveBeenCalled();
  now++; act(() => primary().click()); expect(onConfirm).toHaveBeenCalledOnce();
});
it('keeps the first quote for an arm time and requires a fresh full arming interval for a changed amount', async () => {
  const review = original(); let now = 2_000;
  const { onConfirm } = await mount(review, () => admitted(review), vi.fn(), vi.fn(), () => now);
  now += PK_KIT.SEAL_ARM_MS; // cbe4a25b: isolate first-terms mismatch from time.
  const changed = { ...review, ui: { ...review.ui, price: { ...review.ui.price, amount: '121' } } };
  await mount(changed, () => admitted(changed), onConfirm, vi.fn(), () => now);
  expect(primary().disabled).toBe(true); act(() => primary().click()); expect(onConfirm).not.toHaveBeenCalled();
  const rearmed = { ...changed, ui: { ...changed.ui, armedAtMs: now } };
  await mount(rearmed, () => admitted(rearmed), onConfirm, vi.fn(), () => now);
  now += PK_KIT.SEAL_ARM_MS - 1; act(() => primary().click()); expect(onConfirm).not.toHaveBeenCalled();
  now++; act(() => { primary().click(); primary().click(); }); expect(onConfirm).toHaveBeenCalledOnce();
});
it('does not arm CHECKING to OK on an old timestamp even when the old interval has elapsed', async () => {
  const review = original(); review.ui.price = { ...review.ui.price, status: 'CHECKING', amount: null };
  let now = 2_000;
  const { onConfirm } = await mount(review, () => admitted(review), vi.fn(), vi.fn(), () => now);
  now += PK_KIT.SEAL_ARM_MS; // cbe4a25b: isolate first-terms mismatch from time.
  const priced = { ...review, ui: { ...review.ui, price: { ...review.ui.price, status: 'OK' as const, amount: '120' } } };
  await mount(priced, () => admitted(priced), onConfirm, vi.fn(), () => now);
  expect(primary().disabled).toBe(true); act(() => primary().click()); expect(onConfirm).not.toHaveBeenCalled();
  const rearmed = { ...priced, ui: { ...priced.ui, armedAtMs: now } };
  await mount(rearmed, () => admitted(rearmed), onConfirm, vi.fn(), () => now);
  act(() => primary().click()); expect(onConfirm).not.toHaveBeenCalled();
  now += PK_KIT.SEAL_ARM_MS; act(() => { primary().click(); primary().click(); });
  expect(onConfirm).toHaveBeenCalledOnce();
});
it('keeps an issued READY original disabled across READY rerenders, terms changes and new arm times', async () => {
  const review = original(); let now = 2_000;
  const { onConfirm } = await mount(review, () => admitted(review), vi.fn(), vi.fn(), () => now);
  now += PK_KIT.SEAL_ARM_MS; // cbe4a25b: finish this first committed picture.
  act(() => primary().click()); expect(onConfirm).toHaveBeenCalledOnce();
  await mount(review, () => admitted(review), onConfirm, vi.fn(), () => now);
  expect(primary().disabled).toBe(true);
  for (const change of [{}, { price: { ...review.ui.price, amount: '121' } }]) {
    const rearmed = { ...review, ui: { ...review.ui, ...change, armedAtMs: now } };
    now += PK_KIT.SEAL_ARM_MS;
    await mount(rearmed, () => admitted(rearmed), onConfirm, vi.fn(), () => now);
    now += PK_KIT.SEAL_ARM_MS; // cbe4a25b: isolate the issued identity latch.
    expect(primary().disabled).toBe(true); act(() => primary().click());
  }
  expect(onConfirm).toHaveBeenCalledOnce();
});
it('observes a non-FAILED attempt by original identity even while current and quote terms are unavailable', async () => {
  // WHY1088ff5e: observing progress releases only the attempt condition; the
  // subsequent consent also needs its own new arm and complete delay.
  const review = original(); review.ui.stage = 'FAILED'; review.ui.failure = 'REFUSED';
  let now = 2_000;
  const { onConfirm } = await mount(review, () => ({ ...admitted(review), retryAllowed: true }), vi.fn(), vi.fn(), () => now);
  now += PK_KIT.SEAL_ARM_MS; // cbe4a25b: finish this first committed picture.
  act(() => primary().click()); expect(onConfirm).toHaveBeenCalledOnce();
  const sending = { ...review, ui: { ...review.ui, stage: 'SENDING' as const, price: { ...review.ui.price, status: 'CHECKING' as const, amount: null } } };
  await mount(sending, () => ({ ...admitted(sending), current: false }), onConfirm, vi.fn(), () => now);
  expect(primary().disabled).toBe(true);
  const retry = raised(review, now);
  await mount(retry, () => ({ ...admitted(retry), retryAllowed: true }), onConfirm, vi.fn(), () => now);
  act(() => primary().click()); expect(onConfirm).toHaveBeenCalledOnce();
  now += PK_KIT.SEAL_ARM_MS;
  act(() => { primary().click(); primary().click(); }); expect(onConfirm).toHaveBeenCalledTimes(2);
});
it('does not treat a different original non-FAILED stage as release of the first original', async () => {
  // WHY1088ff5e: use an otherwise eligible new, fully armed view so the original
  // identity observation gate remains the reason this retry is refused.
  const review = original(); review.ui.stage = 'FAILED'; review.ui.failure = 'REFUSED';
  let now = 2_000;
  const { onConfirm } = await mount(review, () => ({ ...admitted(review), retryAllowed: true }), vi.fn(), vi.fn(), () => now);
  now += PK_KIT.SEAL_ARM_MS; // cbe4a25b: finish this first committed picture.
  act(() => primary().click());
  const other = { ...review, identity: { ...review.identity, requestId: 'another-original' }, ui: { ...review.ui, stage: 'SENDING' as const } };
  await mount(other, () => ({ ...admitted(other), current: false }), onConfirm, vi.fn(), () => now);
  const retry = raised(review, now); now += PK_KIT.SEAL_ARM_MS;
  await mount(retry, () => ({ ...admitted(retry), retryAllowed: true }), onConfirm, vi.fn(), () => now);
  now += PK_KIT.SEAL_ARM_MS; // cbe4a25b: isolate original-identity observation.
  expect(primary().disabled).toBe(true); act(() => primary().click()); expect(onConfirm).toHaveBeenCalledOnce();
});
it('retains same-arm cancellation across dismissal but permits a newly armed unissued original', async () => {
  const review = original(); let now = 2_000;
  const { onConfirm, onCancel } = await mount(review, () => admitted(review), vi.fn(), vi.fn(), () => now);
  act(() => host.querySelector<HTMLButtonElement>('button[aria-label="BACK"]')!.click());
  await mount(null, () => admitted(review), onConfirm, onCancel, () => now);
  await mount(review, () => admitted(review), onConfirm, onCancel, () => now);
  now += PK_KIT.SEAL_ARM_MS; // cbe4a25b: finish this first committed picture.
  expect(primary().disabled).toBe(true); act(() => primary().click()); expect(onConfirm).not.toHaveBeenCalled();
  const rearmed = { ...review, ui: { ...review.ui, armedAtMs: now } };
  await mount(rearmed, () => admitted(rearmed), onConfirm, onCancel, () => now);
  act(() => primary().click()); expect(onConfirm).not.toHaveBeenCalled();
  now += PK_KIT.SEAL_ARM_MS; act(() => primary().click());
  expect(onConfirm).toHaveBeenCalledOnce(); expect(onCancel).toHaveBeenCalledOnce();
});
it('permits a rearmed original refused retry without changing the original financial quote', async () => {
  const review = original(); let now = 2_000;
  const { onConfirm } = await mount(review, () => admitted(review), vi.fn(), vi.fn(), () => now);
  now += PK_KIT.SEAL_ARM_MS; // cbe4a25b: finish this first committed picture.
  act(() => primary().click());
  const failed = { ...review, ui: { ...review.ui, stage: 'FAILED' as const, failure: 'REFUSED' as const, armedAtMs: now } };
  await mount(failed, () => ({ ...admitted(failed), retryAllowed: true }), onConfirm, vi.fn(), () => now);
  act(() => primary().click()); expect(onConfirm).toHaveBeenCalledOnce();
  now += PK_KIT.SEAL_ARM_MS; act(() => { primary().click(); primary().click(); });
  expect(onConfirm).toHaveBeenCalledTimes(2);
  for (const call of onConfirm.mock.calls) expect(call[0]).toEqual(review.identity);
});
it('uses the original owner attempt counter for coalesced failures and refuses repeats or backtracking', async () => {
  // WHY1088ff5e: a counter advance proves a failure episode, not a fresh consent.
  // Counter regression assertions use a fully armed new view to isolate that gate.
  const review = original(); review.ui.stage = 'FAILED'; review.ui.failure = 'REFUSED';
  let now = 2_000;
  const snapshot = (r: GoldForgeSpendReview, attemptCounter: number): GoldForgeSpendSnapshot => ({ ...admitted(r), retryAllowed: true, attemptCounter });
  const { onConfirm } = await mount(review, () => snapshot(review, 0), vi.fn(), vi.fn(), () => now); now += PK_KIT.SEAL_ARM_MS; act(() => primary().click());
  expect(onConfirm).toHaveBeenCalledOnce();
  // The owner synchronously started and completed another failed attempt between paints.
  await mount(review, () => snapshot(review, 1), onConfirm, vi.fn(), () => now);
  now += PK_KIT.SEAL_ARM_MS; // cbe4a25b: finish this first committed picture.
  expect(primary().disabled).toBe(true); act(() => primary().click()); expect(onConfirm).toHaveBeenCalledOnce();
  const retry = raised(review, now);
  await mount(retry, () => snapshot(retry, 1), onConfirm, vi.fn(), () => now);
  act(() => primary().click()); expect(onConfirm).toHaveBeenCalledOnce();
  now += PK_KIT.SEAL_ARM_MS; act(() => { primary().click(); primary().click(); });
  expect(onConfirm).toHaveBeenCalledTimes(2);
  const nextRetry = raised(review, ++now); now += PK_KIT.SEAL_ARM_MS;
  for (const counter of [1, 0]) {
    await mount(nextRetry, () => snapshot(nextRetry, counter), onConfirm, vi.fn(), () => now);
    now += PK_KIT.SEAL_ARM_MS; // cbe4a25b: isolate the counter fence.
    expect(primary().disabled).toBe(true);
    act(() => primary().click()); expect(onConfirm).toHaveBeenCalledTimes(2);
  }
  await mount(nextRetry, () => snapshot(nextRetry, 2), onConfirm, vi.fn(), () => now); act(() => { primary().click(); primary().click(); });
  expect(onConfirm).toHaveBeenCalledTimes(3);
});
it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, 2 ** 53])('refuses an invalid original owner attempt counter %s', async attemptCounter => {
  const review = original();
  const snapshot = (): GoldForgeSpendSnapshot => ({ ...admitted(review), attemptCounter });
  const { onConfirm } = await mount(review, snapshot);
  expect(primary().disabled).toBe(true); act(() => primary().click()); expect(onConfirm).not.toHaveBeenCalled();
});
it('cannot downgrade a counter-bound retry to stage-only release or use a backtracked counter', async () => {
  // WHY1088ff5e: test downgrade/backtracking only after a fresh consent arm has
  // elapsed, so the new retry-arm requirement cannot mask a counter regression.
  const review = original(); review.ui.stage = 'FAILED'; review.ui.failure = 'REFUSED';
  let now = 2_000;
  const snapshot = (r: GoldForgeSpendReview, attemptCounter?: number): GoldForgeSpendSnapshot => ({
    ...admitted(r), retryAllowed: true, ...(attemptCounter === undefined ? {} : { attemptCounter }),
  });
  const { onConfirm } = await mount(review, () => snapshot(review, 2), vi.fn(), vi.fn(), () => now); now += PK_KIT.SEAL_ARM_MS; act(() => primary().click());
  const sending = { ...review, ui: { ...review.ui, stage: 'SENDING' as const } };
  await mount(sending, () => snapshot(sending, 4), onConfirm, vi.fn(), () => now);
  const retry = raised(review, now); now += PK_KIT.SEAL_ARM_MS;
  // Counter 3 exceeds issued 2 but backtracks below observed 4: this separately
  // pins the high-water guard rather than only the last-issued comparison.
  for (const counter of [undefined, 2, 3]) {
    await mount(retry, () => snapshot(retry, counter), onConfirm, vi.fn(), () => now);
    now += PK_KIT.SEAL_ARM_MS; // cbe4a25b: isolate the counter fence.
    expect(primary().disabled).toBe(true);
    act(() => primary().click()); expect(onConfirm).toHaveBeenCalledOnce();
  }
  await mount(retry, () => snapshot(retry, 4), onConfirm, vi.fn(), () => now); act(() => primary().click());
  expect(onConfirm).toHaveBeenCalledTimes(2);
});
it.each([Number.NaN, Number.POSITIVE_INFINITY])('does not conflate malformed painted progress %s with an unknown live progress', async progress => {
  const review = original(); review.ui.progress = progress;
  const live = { ...review, ui: { ...review.ui, progress: null } };
  const { onConfirm } = await mount(review, () => admitted(live));
  expect(primary().disabled).toBe(true); act(() => primary().click()); expect(onConfirm).not.toHaveBeenCalled();
  await mount(live, () => admitted(review), onConfirm);
  expect(primary().disabled).toBe(true); act(() => primary().click()); expect(onConfirm).not.toHaveBeenCalled();
});
it('observes a synchronous owner non-FAILED commit even when React only paints the later failure', async () => {
  // WHY1088ff5e: immediate stage observation prevents stranding but never skips
  // the next consent's fresh raise and arming interval.
  const review = original(); review.ui.stage = 'FAILED'; review.ui.failure = 'REFUSED';
  let live = { ...admitted(review), retryAllowed: true }, now = 2_000;
  const onConfirm = vi.fn(() => {
    const active = live.review ?? review;
    const sending = { ...active, ui: { ...active.ui, stage: 'SENDING' as const } };
    live = { ...admitted(sending), current: false, retryAllowed: false };
  });
  await mount(review, () => live, onConfirm, vi.fn(), () => now);
  now += PK_KIT.SEAL_ARM_MS; // cbe4a25b: finish this first committed picture.
  act(() => { primary().click(); primary().click(); }); expect(onConfirm).toHaveBeenCalledOnce();
  for (const expected of [2, 3]) {
    // The next failure is committed before React ever paints the SENDING view.
    const retry = raised(review, ++now); live = { ...admitted(retry), retryAllowed: true };
    await mount(retry, () => live, onConfirm, vi.fn(), () => now);
    act(() => primary().click()); expect(onConfirm).toHaveBeenCalledTimes(expected - 1);
    now += PK_KIT.SEAL_ARM_MS;
    act(() => { primary().click(); primary().click(); }); expect(onConfirm).toHaveBeenCalledTimes(expected);
  }
});

it.each(['stage', 'counter'] as const)('requires a new full retry arm even when %s evidence admits the same refused original', async mode => {
  // WHY1088ff5e: the same idempotency key avoids a duplicate charge, but a
  // second consent still requires its own new raise and complete arming window.
  const review = original(); let now = 2_000;
  const snapshot = (r: GoldForgeSpendReview, counter: number): GoldForgeSpendSnapshot => ({
    ...admitted(r), retryAllowed: true, ...(mode === 'counter' ? { attemptCounter: counter } : {}),
  });
  const { onConfirm } = await mount(review, () => snapshot(review, 0), vi.fn(), vi.fn(), () => now);
  now += PK_KIT.SEAL_ARM_MS; // cbe4a25b: finish this first committed picture.
  act(() => primary().click()); expect(onConfirm).toHaveBeenCalledOnce();
  const failed = { ...review, ui: { ...review.ui, stage: 'FAILED' as const, failure: 'REFUSED' as const } };
  for (const sameArm of [failed, raised(failed, 999)]) {
    await mount(sameArm, () => snapshot(sameArm, 1), onConfirm, vi.fn(), () => now);
    expect(primary().disabled).toBe(true); act(() => primary().click()); expect(onConfirm).toHaveBeenCalledOnce();
  }
  const retry = raised(failed, now);
  await mount(retry, () => snapshot(retry, 1), onConfirm, vi.fn(), () => now);
  now += PK_KIT.SEAL_ARM_MS - 1; act(() => primary().click()); expect(onConfirm).toHaveBeenCalledOnce();
  now++; act(() => { primary().click(); primary().click(); }); expect(onConfirm).toHaveBeenCalledTimes(2);
  const sending = { ...retry, ui: { ...retry.ui, stage: 'SENDING' as const } };
  await mount(sending, () => ({ ...snapshot(sending, 2), current: false }), onConfirm, vi.fn(), () => now);
  // Returning to an older already-armed timestamp cannot create a third consent.
  await mount(failed, () => snapshot(failed, 2), onConfirm, vi.fn(), () => now);
  expect(primary().disabled).toBe(true); act(() => primary().click()); expect(onConfirm).toHaveBeenCalledTimes(2);
  for (const call of onConfirm.mock.calls) expect(call[0]).toEqual(review.identity);
});
it.each(['price', 'subject', 'quotedAt'] as const)('refuses substituted original %s terms even after a legitimate fresh retry arm', async field => {
  // WHY1088ff5e: the new arm is necessary, but does not replace the original
  // immutable-quote check. This fixture satisfies the full delay independently.
  const review = original(); let now = 2_000;
  const { onConfirm } = await mount(review, () => admitted(review), vi.fn(), vi.fn(), () => now);
  now += PK_KIT.SEAL_ARM_MS; // cbe4a25b: finish this first committed picture.
  act(() => primary().click());
  const failed: GoldForgeSpendReview = { ...review, ui: { ...review.ui, stage: 'FAILED', failure: 'REFUSED', armedAtMs: now } };
  if (field === 'price') failed.ui.price = { ...failed.ui.price, amount: '119' };
  if (field === 'subject') failed.ui.subjectName = 'BARRACKS';
  if (field === 'quotedAt') failed.ui.quotedAtMs++;
  now += PK_KIT.SEAL_ARM_MS;
  await mount(failed, () => ({ ...admitted(failed), retryAllowed: true }), onConfirm, vi.fn(), () => now);
  now += PK_KIT.SEAL_ARM_MS; // cbe4a25b: isolate immutable original quote.
  expect(primary().disabled).toBe(true); act(() => primary().click()); expect(onConfirm).toHaveBeenCalledOnce();
});

// cbe4a25b A-m2/A-m3 and challenger older-raise echo. No attempt is issued
// before the refusal checks: the identity latch cannot mask these regressions.
it.each(['price', 'status', 'subject', 'quotedAt'] as const)
('permanently taints committed %s changes T1 → T2 → T1 at the same normalized arm', async field => {
  const review = raised(original(), 2_000); let now = 3_000;
  const { onConfirm } = await mount(review, () => admitted(review), vi.fn(), vi.fn(), () => now);
  now += PK_KIT.SEAL_ARM_MS;
  const changed: GoldForgeSpendReview = { ...review, ui: { ...review.ui } };
  if (field === 'price') changed.ui.price = { ...review.ui.price, amount: '121' };
  if (field === 'status') changed.ui.price = { ...review.ui.price, status: 'CHECKING' };
  if (field === 'subject') changed.ui.subjectName = 'BARRACKS';
  if (field === 'quotedAt') changed.ui.quotedAtMs++;
  await mount(changed, () => admitted(changed), onConfirm, vi.fn(), () => now);
  now += PK_KIT.SEAL_ARM_MS;
  await mount(review, () => admitted(review), onConfirm, vi.fn(), () => now);
  expect(primary().disabled).toBe(true); act(() => primary().click()); expect(onConfirm).not.toHaveBeenCalled();
  await mount(null, () => admitted(review), onConfirm, vi.fn(), () => now);
  await mount(review, () => admitted(review), onConfirm, vi.fn(), () => now);
  expect(primary().disabled).toBe(true); act(() => primary().click()); expect(onConfirm).not.toHaveBeenCalled();
  const fresh = raised(review, now);
  await mount(fresh, () => admitted(fresh), onConfirm, vi.fn(), () => now);
  act(() => primary().click()); expect(onConfirm).not.toHaveBeenCalled();
  now += PK_KIT.SEAL_ARM_MS; act(() => primary().click()); expect(onConfirm).toHaveBeenCalledOnce();
});
it.each(['recorded', 'previously unseen', 'in-place'] as const)
('refuses a %s older raise after a newer committed raise without an issued attempt', async kind => {
  // WHY6f91e67a: committing an older picture also interrupts the latest arm.
  // Returning to that latest arm is no longer a fresh visible consent window.
  const first = raised(original(), 2_000), second = raised(original(), 3_000); let now = 4_000;
  const { onConfirm } = await mount(first, () => admitted(first), vi.fn(), vi.fn(), () => now);
  now += PK_KIT.SEAL_ARM_MS;
  await mount(second, () => admitted(second), onConfirm, vi.fn(), () => now);
  now += PK_KIT.SEAL_ARM_MS;
  const older = kind === 'recorded' ? first : kind === 'in-place' ? second : raised(original(), 2_500);
  if (kind === 'in-place') older.ui.armedAtMs = 2_500;
  await mount(older, () => admitted(older), onConfirm, vi.fn(), () => now);
  now += PK_KIT.SEAL_ARM_MS;
  expect(primary().disabled).toBe(true); act(() => primary().click()); expect(onConfirm).not.toHaveBeenCalled();
  if (kind === 'in-place') second.ui.armedAtMs = 3_000;
  await mount(second, () => admitted(second), onConfirm, vi.fn(), () => now);
  expect(primary().disabled).toBe(true); act(() => primary().click()); expect(onConfirm).not.toHaveBeenCalled();
  const fresh = raised(second, now);
  await mount(fresh, () => admitted(fresh), onConfirm, vi.fn(), () => now);
  now += PK_KIT.SEAL_ARM_MS - 1; act(() => primary().click()); expect(onConfirm).not.toHaveBeenCalled();
  now++; act(() => { primary().click(); primary().click(); }); expect(onConfirm).toHaveBeenCalledOnce();
});
it.each(['stale', 'future', 'late replacement'] as const)
('starts the full visible delay at max(producer arm, first commit) for a %s raise', async kind => {
  let now = 3_000;
  const review = raised(original(), kind === 'future' ? 4_000 : 2_000), onConfirm = vi.fn();
  if (kind === 'late replacement') {
    const earlier = raised(original(), 1_000);
    await mount(earlier, () => admitted(earlier), onConfirm, vi.fn(), () => now);
    now += PK_KIT.SEAL_ARM_MS;
  }
  const firstCommit = now;
  await mount(review, () => admitted(review), onConfirm, vi.fn(), () => now);
  expect(primary().disabled).toBe(false); act(() => primary().click()); expect(onConfirm).not.toHaveBeenCalled();
  now = Math.max(review.ui.armedAtMs!, firstCommit) + PK_KIT.SEAL_ARM_MS - 1;
  act(() => primary().click()); expect(onConfirm).not.toHaveBeenCalled();
  now++; act(() => { primary().click(); primary().click(); }); expect(onConfirm).toHaveBeenCalledOnce();
});
it.each(['terms', 'newer raise', 'older raise', 'null dismissal', 'identity switch', 'invalid arm'] as const)
('does not record a discarded %s render on the already-mounted consumer', async kind => {
  const review = raised(original(), 2_000); let now = 3_000, live = admitted(review), suspended = 0;
  const onConfirm = vi.fn(), onCancel = vi.fn(), pending = new Promise<void>(() => {});
  function Tail({ suspend }: { suspend: boolean }): null {
    if (suspend) { suspended++; throw pending; }
    return null;
  }
  const picture = (value: GoldForgeSpendReview | null, suspend: boolean) => <Suspense fallback={<p>WAITING</p>}>
    <GoldForgeSpendSeal review={value} getSnapshot={() => live} onConfirm={onConfirm} onCancel={onCancel} clock={() => now} />
    <Tail suspend={suspend} />
  </Suspense>;
  await act(async () => root.render(picture(review, false)));
  now += PK_KIT.SEAL_ARM_MS;
  let candidate: GoldForgeSpendReview | null = raised(review, now);
  if (kind === 'terms') candidate = { ...review, ui: { ...review.ui, price: { ...review.ui.price, amount: '121' } } };
  if (kind === 'null dismissal') candidate = null;
  if (kind === 'older raise') candidate = raised(review, 1_500);
  if (kind === 'identity switch') candidate = { ...review, identity: { ...review.identity, requestId: 'abandoned-original' } };
  if (kind === 'invalid arm') candidate = raised(review, Number.NaN);
  live = candidate === null ? { ...admitted(review), review: null } : admitted(candidate);
  await act(async () => { startTransition(() => root.render(picture(candidate, true))); });
  expect(suspended).toBeGreaterThan(0); expect(host.textContent).not.toContain('WAITING');
  live = admitted(review);
  await act(async () => root.render(picture(review, false)));
  expect(primary().disabled).toBe(false); act(() => primary().click()); expect(onConfirm).toHaveBeenCalledOnce();
});
it.each([0, 1])('refuses a missing counter after observing %s even when no attempt latch exists', async counter => {
  // WHY6f91e67a: null < 0 is false at runtime. Zero specifically isolates the
  // counter === null disjunct; the retained one case pins the complete fence.
  const review = original(), onConfirm = vi.fn();
  await mount(review, () => ({ ...admitted(review), attemptCounter: counter }), onConfirm);
  expect(primary().disabled).toBe(false);
  await mount(review, () => admitted(review), onConfirm);
  expect(primary().disabled).toBe(true); act(() => primary().click()); expect(onConfirm).not.toHaveBeenCalled();
  await mount(review, () => ({ ...admitted(review), attemptCounter: counter }), onConfirm);
  act(() => primary().click()); expect(onConfirm).toHaveBeenCalledOnce();
});
it('records an unchanged committed raise with bounded repainting and a stable pure getter', async () => {
  const review = original(), snapshot = admitted(review), getSnapshot = vi.fn(() => snapshot);
  const { onConfirm } = await mount(review, getSnapshot);
  expect(getSnapshot.mock.calls.length).toBeGreaterThan(0);
  expect(getSnapshot.mock.calls.length).toBeLessThan(20);
  const reads = getSnapshot.mock.calls.length;
  await act(async () => {});
  expect(getSnapshot).toHaveBeenCalledTimes(reads);
  act(() => primary().click()); expect(onConfirm).toHaveBeenCalledOnce();
});
it.each(['early', 'throws', 'nonfinite'] as const)
('rechecks the effective arm inside its own callback when the second clock read is %s', async kind => {
  const review = original(); let now = 3_000, racing = false, reads = 0;
  const clock = () => {
    if (!racing || reads++ === 0) return now;
    if (kind === 'throws') throw Error('clock unavailable');
    return kind === 'early' ? 3_000 : Number.NaN;
  };
  const { onConfirm } = await mount(review, () => admitted(review), vi.fn(), vi.fn(), clock);
  now += PK_KIT.SEAL_ARM_MS; racing = true;
  act(() => primary().click()); expect(onConfirm).not.toHaveBeenCalled();
  racing = false;
  act(() => primary().click()); expect(onConfirm).toHaveBeenCalledOnce();
});
it.each(['throws', 'NaN', 'Infinity', 'negative'] as const)
('fails closed with BACK intact when the first-commit clock is %s', async kind => {
  const review = original(), clock = () => {
    if (kind === 'throws') throw Error('clock unavailable');
    return kind === 'NaN' ? Number.NaN : kind === 'Infinity' ? Number.POSITIVE_INFINITY : -1;
  };
  const { onConfirm, onCancel } = await mount(review, () => admitted(review), vi.fn(), vi.fn(), clock);
  expect(primary().disabled).toBe(true); act(() => primary().click());
  act(() => host.querySelector<HTMLButtonElement>('button[aria-label="BACK"]')!.click());
  expect(onConfirm).not.toHaveBeenCalled(); expect(onCancel).toHaveBeenCalledOnce();
});

it.each(['last shown', 'earlier identity'] as const)
('closes a %s arm across owner dismissal without cancellation or an attempt and requires a fresh delayed raise', async kind => {
  const review = raised(original(), 2_000); let now = 3_000;
  const { onConfirm, onCancel } = await mount(review, () => admitted(review), vi.fn(), vi.fn(), () => now);
  now += PK_KIT.SEAL_ARM_MS;
  expect(primary().disabled).toBe(false);
  if (kind === 'earlier identity') {
    const other = { ...review, identity: { ...review.identity, requestId: 'another-original' } };
    await mount(other, () => admitted(other), onConfirm, onCancel, () => now);
    now += PK_KIT.SEAL_ARM_MS;
    expect(primary().disabled).toBe(false);
  }
  await mount(null, () => admitted(review), onConfirm, onCancel, () => now);
  await mount(null, () => admitted(review), onConfirm, onCancel, () => now);
  await mount(review, () => admitted(review), onConfirm, onCancel, () => now);
  now += PK_KIT.SEAL_ARM_MS;
  expect(primary().disabled).toBe(true); act(() => primary().click()); expect(onConfirm).not.toHaveBeenCalled();
  expect(onCancel).not.toHaveBeenCalled();
  const fresh = raised(review, now);
  await mount(fresh, () => admitted(fresh), onConfirm, onCancel, () => now);
  now += PK_KIT.SEAL_ARM_MS - 1; act(() => primary().click()); expect(onConfirm).not.toHaveBeenCalled();
  now++; act(() => { primary().click(); primary().click(); }); expect(onConfirm).toHaveBeenCalledOnce();
  expect(onCancel).not.toHaveBeenCalled();
});

it('shows an admitted REFUSED retry without directing the player away from its current review', async () => {
  const review = original(); review.ui.stage = 'FAILED'; review.ui.failure = 'REFUSED';
  const { onConfirm } = await mount(review, () => ({ ...admitted(review), retryAllowed: true }));
  expect(primary().disabled).toBe(false); expect(primary().textContent).toContain('RETRY');
  expect(host.textContent).not.toContain('Return to the original review');
  act(() => primary().click()); expect(onConfirm).toHaveBeenCalledOnce();
});

// WHY75420333 M-1: a different committed picture interrupts the consent window
// even without null dismissal, player cancellation or an issued attempt. New
// records must receive the serial AFTER it advances, preserving fresh consent.
it.each(['requestId', 'wallet', 'baseId', 'epoch', 'generation'] as const)
('closes X after a committed %s identity switch X → Y → X until X has a fresh full arm', async field => {
  const review = raised(original(), 2_000); let now = 3_000;
  const { onConfirm, onCancel } = await mount(review, () => admitted(review), vi.fn(), vi.fn(), () => now);
  now += PK_KIT.SEAL_ARM_MS;
  expect(primary().disabled).toBe(false);
  const identity = { ...review.identity };
  if (field === 'epoch' || field === 'generation') identity[field]++;
  else identity[field] = 'different-original';
  const other = { ...review, identity };
  await mount(other, () => admitted(other), onConfirm, onCancel, () => now);
  expect(primary().disabled).toBe(false);
  act(() => primary().click()); expect(onConfirm).not.toHaveBeenCalled();
  now += PK_KIT.SEAL_ARM_MS;
  await mount(review, () => admitted(review), onConfirm, onCancel, () => now);
  expect(primary().disabled).toBe(true); act(() => primary().click()); expect(onConfirm).not.toHaveBeenCalled();
  expect(onCancel).not.toHaveBeenCalled();
  const fresh = raised(review, now);
  await mount(fresh, () => admitted(fresh), onConfirm, onCancel, () => now);
  expect(primary().disabled).toBe(false);
  now += PK_KIT.SEAL_ARM_MS - 1; act(() => primary().click()); expect(onConfirm).not.toHaveBeenCalled();
  now++; act(() => { primary().click(); primary().click(); }); expect(onConfirm).toHaveBeenCalledOnce();
  expect(onConfirm).toHaveBeenCalledWith(review.identity);
});

it.each(['armedAtMs', 'quotedAtMs'] as const)
('closes a valid arm after a committed invalid %s interlude until a fresh full arm', async field => {
  const review = raised(original(), 2_000); let now = 3_000;
  const { onConfirm, onCancel } = await mount(review, () => admitted(review), vi.fn(), vi.fn(), () => now);
  now += PK_KIT.SEAL_ARM_MS;
  expect(primary().disabled).toBe(false);
  const invalid = { ...review, ui: { ...review.ui, [field]: Number.NaN } };
  await mount(invalid, () => admitted(invalid), onConfirm, onCancel, () => now);
  expect(primary().disabled).toBe(true); act(() => primary().click()); expect(onConfirm).not.toHaveBeenCalled();
  now += PK_KIT.SEAL_ARM_MS;
  await mount(review, () => admitted(review), onConfirm, onCancel, () => now);
  expect(primary().disabled).toBe(true); act(() => primary().click()); expect(onConfirm).not.toHaveBeenCalled();
  expect(onCancel).not.toHaveBeenCalled();
  const fresh = raised(review, now);
  await mount(fresh, () => admitted(fresh), onConfirm, onCancel, () => now);
  expect(primary().disabled).toBe(false);
  now += PK_KIT.SEAL_ARM_MS - 1; act(() => primary().click()); expect(onConfirm).not.toHaveBeenCalled();
  now++; act(() => { primary().click(); primary().click(); }); expect(onConfirm).toHaveBeenCalledOnce();
  expect(onConfirm).toHaveBeenCalledWith(review.identity);
});
