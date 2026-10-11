/** @vitest-environment happy-dom */
/** A preview is an explicit additional purchase. Network retries and account
 * switching must never change the subset the player confirmed. */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TrainingQuote } from '@shardkeep/shared';
import { useApp } from '../../state/store';
import { bus } from '../../lib/events';
const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn() }));
vi.mock('../../lib/api', async (original) => ({ ...(await original<typeof import('../../lib/api')>()), api: mocks }));
vi.mock('../sheets', () => ({ reloadBase: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../lib/audio', () => ({ playSfx: vi.fn() }));
vi.mock('../../lib/juice', () => ({ haptic: vi.fn() }));
// Navigation/confirmation use real controls; atlas downloads are unrelated.
vi.mock('../primitives', async (original) => ({ ...(await original<typeof import('../primitives')>()), Sprite: () => null }));
import { clearTrainingPurchase, readTrainingPurchase, saveTrainingPurchase, type TrainingPurchase } from './trainingPurchase';
import { ApiError } from '../../lib/api';
import { TrainingPresets } from './trainingPresets';
import { TrainTray } from './army';
let host: HTMLDivElement; let root: Root;
const trained = vi.fn(); const busy = vi.fn();
const quote: TrainingQuote = {
  requested: [{ troop: 'bowman', count: 5 }], queueable: [{ troop: 'bowman', count: 2 }],
  remaining: [{ troop: 'bowman', count: 3, reason: 'Not enough SHARDS' }],
  costShards: '10', availableShards: '10', camp: { used: 0, after: 2, capacity: 20 },
  barracks: { used: 0, after: 2, capacity: 10 }, completionSec: 120,
  consent: { version: 2, queue: [], unitDurations: [{ troop: 'bowman', durationMs: 60000 }] },
  schedule: { version: 2, mode: 'sequential', serverNow: '2026-09-06T00:00:00.000Z', startsAt: '2026-09-06T00:00:00.000Z', finishesAt: '2026-09-06T00:02:00.000Z', waitMs: 0, durationMs: 120000 },
};
const result = () => ({ queue: [1, 2].map((n) => ({ id: `00000000-0000-4000-8000-00000000000${n}`, troop: 'bowman', finishesAt: '2026-09-06T00:02:00.000Z' })), costShards: '10', replayed: false });
const flush = async (): Promise<void> => { await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); }); };
const button = (text: string): HTMLButtonElement => [...document.querySelectorAll('button')].find((el) => el.textContent === text) as HTMLButtonElement;
const mount = async (): Promise<void> => { await act(async () => root.render(<TrainingPresets onTrained={trained} onBusyChange={busy} />)); await flush(); };
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks(); mocks.get.mockReset(); mocks.post.mockReset(); localStorage.clear();
  useApp.setState({ wallet: 'test-wallet', selectedBaseId: 'test-base', baseSelectionEpoch: 0 });
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => { vi.unstubAllGlobals(); vi.restoreAllMocks(); await act(async () => root.unmount()); host.remove(); useApp.setState({ wallet: null, selectedBaseId: null }); });

describe('saved army purchase confirmation', () => {
  it('shows requested, queueable and remainder, then submits only the explicitly displayed subset', async () => {
    mocks.get.mockResolvedValue({ raidId: 'last', composition: quote.requested, message: null });
    mocks.post.mockImplementation((path: string) => Promise.resolve(path.endsWith('quote') ? quote : result()));
    await mount(); await act(async () => button('RETRAIN PREVIOUS ARMY').click()); await flush();
    expect(document.body.textContent).toContain('REQUESTED 5 · QUEUE 2');
    expect(document.body.textContent).toContain('REMAINING 3 · Not enough SHARDS');
    expect(document.body.textContent).toContain('will not train automatically');
    expect(mocks.post.mock.calls.filter(([path]) => path.endsWith('batch'))).toHaveLength(0);
    await act(async () => button('ADD TO QUEUE · 2 · 10 SHARDS').click()); await flush();
    expect(mocks.post).toHaveBeenLastCalledWith('/army/training/batch', expect.objectContaining({ composition: quote.queueable, confirmedCostShards: '10', baseId: 'test-base', idempotencyKey: expect.any(String) }));
    expect(trained).toHaveBeenCalledOnce();
  });

  it('retries a lost response using exactly the same key, composition and confirmed price', async () => {
    mocks.get.mockResolvedValue({ raidId: 'last', composition: quote.requested, message: null });
    let attempts = 0;
    mocks.post.mockImplementation((path: string) => path.endsWith('quote') ? Promise.resolve(quote) : ++attempts === 1 ? Promise.reject(new Error('connection lost')) : Promise.resolve({ ...result(), replayed: true }));
    await mount(); await act(async () => button('RETRAIN PREVIOUS ARMY').click()); await flush();
    await act(async () => button('ADD TO QUEUE · 2 · 10 SHARDS').click()); await flush();
    await act(async () => button('RETRY CONFIRMED BATCH').click()); await flush();
    const purchases = mocks.post.mock.calls.filter(([path]) => path.endsWith('batch'));
    expect(purchases).toHaveLength(2); expect(purchases[0]![1]).toEqual(purchases[1]![1]);
    expect(trained).toHaveBeenCalledOnce();
  });

  it('closes the refused key before offering the changed quote for a second confirmation', async () => {
    mocks.get.mockResolvedValue({ raidId: 'last', composition: quote.requested, message: null });
    const changed = { ...quote, queueable: [{ troop: 'bowman', count: 1 }], costShards: '5', completionSec: 60, schedule: { ...quote.schedule, durationMs: 60000, finishesAt: '2026-09-06T00:01:00.000Z' } };
    mocks.post.mockImplementation((path: string) => path.endsWith('quote') ? Promise.resolve(quote) : Promise.reject(new ApiError(409, 'conditions changed', 'TRAINING_QUOTE_CHANGED', { quote: changed })));
    await mount(); await act(async () => button('RETRAIN PREVIOUS ARMY').click()); await flush();
    await act(async () => button('ADD TO QUEUE · 2 · 10 SHARDS').click()); await flush();
    expect(button('ADD TO QUEUE · 1 · 5 SHARDS')).toBeUndefined();
    const intent = readTrainingPurchase('test-wallet')!;
    mocks.post.mockResolvedValue({ version: 1, status: 'closed', idempotencyKey: intent.idempotencyKey, closedAt: '2026-09-06T00:00:00.000Z' });
    await act(async () => button('CLOSE UNACCEPTED REQUEST').click());
    await act(async () => button('CONFIRM CLOSE REQUEST').click()); await flush();
    expect(button('ADD TO QUEUE · 1 · 5 SHARDS')).toBeDefined();
    expect(mocks.post.mock.calls.filter(([path]) => path.endsWith('batch'))).toHaveLength(1);
    expect(trained).not.toHaveBeenCalled();
  });

  it('drops an old-wallet history response before it can request a quote for the newly selected base', async () => {
    let resolve!: (value: unknown) => void;
    mocks.get.mockImplementation(() => new Promise((r) => { resolve = r; }));
    await mount(); await act(async () => button('RETRAIN PREVIOUS ARMY').click()); await flush();
    useApp.setState({ wallet: 'other-wallet', selectedBaseId: 'other-base', baseSelectionEpoch: 1 });
    await act(async () => resolve({ raidId: 'old', composition: quote.requested })); await flush();
    expect(mocks.post).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain('TRAINING PREVIEW');
  });

  it('does not reinterpret a hero-only previous attack as an older troop army', async () => {
    mocks.get.mockResolvedValue({ raidId: 'hero-only', composition: [], message: 'Your previous attack used heroes only; no troops need retraining.' });
    await mount(); await act(async () => button('RETRAIN PREVIOUS ARMY').click()); await flush();
    expect(document.body.textContent).toContain('heroes only'); expect(mocks.post).not.toHaveBeenCalled();
  });

  it.each(['same-base epoch', 'different base'] as const)('the real training tray discards old history and permits a new retrain after a %s change', async (change) => {
    // TrainTray keys its child by wallet/base/epoch. A fresh operation therefore
    // gets a fresh component guard AND no old quote or pending receipt to reuse.
    // Keeping only a per-operation guard would not fence those existing values.
    let resolveOld!: (value: unknown) => void;
    let historyReads = 0;
    mocks.get.mockImplementation((path: string) => {
      if (path.startsWith('/army/previous')) return ++historyReads === 1
        ? new Promise((resolve) => { resolveOld = resolve; })
        : Promise.resolve({ raidId: 'new', composition: quote.requested, message: null });
      return Promise.resolve({ counts: {}, levels: {}, research: [], queue: [], rosterPts: 0,
        campCapacityPts: 20, barracksQueuePts: 10, eliteUnlocks: {}, features: {} });
    });
    mocks.post.mockImplementation((path: string) => Promise.resolve(path.endsWith('quote') ? quote
      : result()));
    await act(async () => root.render(<TrainTray />)); await flush();
    await act(async () => button('RETRAIN PREVIOUS ARMY').click()); await flush();
    const nextBase = change === 'different base' ? 'next-base' : 'test-base';
    await act(async () => useApp.setState({ selectedBaseId: nextBase, baseSelectionEpoch: 1 })); await flush();
    expect(button('RETRAIN PREVIOUS ARMY').disabled).toBe(false);
    await act(async () => button('RETRAIN PREVIOUS ARMY').click()); await flush();
    expect(mocks.get).toHaveBeenCalledWith(`/army/previous?baseId=${nextBase}`);
    expect(document.body.textContent).toContain('REQUESTED 5 · QUEUE 2');
    await act(async () => resolveOld({ raidId: 'old', composition: [{ troop: 'highlander', count: 1 }] })); await flush();
    expect(mocks.post.mock.calls.filter(([path]) => path.endsWith('quote'))).toHaveLength(1);
    await act(async () => button('ADD TO QUEUE · 2 · 10 SHARDS').click()); await flush();
    expect(mocks.post).toHaveBeenLastCalledWith('/army/training/batch', expect.objectContaining({
      baseId: nextBase, composition: quote.queueable, confirmedCostShards: '10', idempotencyKey: expect.any(String),
    }));
    expect(document.body.textContent).toContain('2 TROOPS PURCHASED');
  });
});

const savedIntent = (): TrainingPurchase => ({ version: 1, wallet: 'test-wallet', baseId: 'test-base',
  idempotencyKey: '10000000-0000-4000-8000-000000000001', composition: quote.queueable,
  confirmedCostShards: quote.costShards, consent: quote.consent });
const acceptedReceipt = (intent: TrainingPurchase) => ({ version: 1, status: 'accepted',
  idempotencyKey: intent.idempotencyKey, baseId: intent.baseId, acceptedAt: '2026-09-06T00:00:00.000Z',
  request: { composition: intent.composition, confirmedCostShards: intent.confirmedCostShards },
  result: { ...result(), replayed: true },
});

describe('durable training purchase recovery', () => {
  it('persists the exact consent and request before its first POST; storage failure cannot spend', async () => {
    mocks.get.mockResolvedValue({ composition: quote.requested });
    mocks.post.mockImplementation((path: string, body: unknown) => {
      if (path.endsWith('quote')) return Promise.resolve(quote);
      const saved = readTrainingPurchase('test-wallet');
      expect(saved).toMatchObject(body as object);
      return Promise.resolve(result());
    });
    await mount(); await act(async () => button('RETRAIN PREVIOUS ARMY').click()); await flush();
    const originalStorage = localStorage;
    vi.stubGlobal('localStorage', { getItem: originalStorage.getItem.bind(originalStorage), setItem: () => { throw new Error('storage unavailable'); }, removeItem: originalStorage.removeItem.bind(originalStorage) });
    await act(async () => button('ADD TO QUEUE · 2 · 10 SHARDS').click()); await flush();
    expect(mocks.post.mock.calls.filter(([path]) => path.endsWith('batch'))).toHaveLength(0);
    vi.unstubAllGlobals();
    await act(async () => button('RETRAIN PREVIOUS ARMY').click()); await flush();
    await act(async () => button('ADD TO QUEUE · 2 · 10 SHARDS').click()); await flush();
    expect(trained).toHaveBeenCalledOnce();
  });

  it('reload recovers acceptance without reposting or publishing an old queue as current', async () => {
    const intent = savedIntent(); saveTrainingPurchase(intent);
    mocks.get.mockResolvedValue(acceptedReceipt(intent));
    await mount();
    expect(mocks.get).toHaveBeenCalledWith(`/army/training/receipt?idempotencyKey=${intent.idempotencyKey}`);
    expect(mocks.post).not.toHaveBeenCalled(); expect(trained).toHaveBeenCalledOnce();
    expect(readTrainingPurchase(intent.wallet)).toBeNull();
    expect(document.body.textContent).toContain('REFRESHING LIVE ARMY');
    expect(document.body.textContent).not.toContain('ALL READY IN');
  });

  it.each(['unknown', 'unsupported', 'malformed', 'wrong base', 'wrong composition', 'wrong cost', 'wrong key'] as const)(
    '%s receipt retains the original key and blocks a replacement purchase', async (kind) => {
      const intent = savedIntent(); saveTrainingPurchase(intent);
      const accepted = acceptedReceipt(intent);
      if (kind === 'unsupported') mocks.get.mockRejectedValue(new ApiError(404, 'unavailable'));
      else mocks.get.mockResolvedValue(kind === 'unknown' ? { version: 1, status: 'unknown', idempotencyKey: intent.idempotencyKey }
        : kind === 'malformed' ? {} : kind === 'wrong base' ? { ...accepted, baseId: 'different-base' }
          : kind === 'wrong key' ? { ...accepted, idempotencyKey: 'different-key' }
            : kind === 'wrong composition' ? { ...accepted, request: { ...accepted.request, composition: [{ troop: 'highlander', count: 2 }] } }
              : { ...accepted, result: { ...accepted.result, costShards: '11' } });
      await mount();
      expect(readTrainingPurchase(intent.wallet)).toEqual(intent);
      expect(button('RETRAIN PREVIOUS ARMY').disabled).toBe(true);
      expect(trained).not.toHaveBeenCalled(); expect(mocks.post).not.toHaveBeenCalled();
    },
  );

  it('unknown needs an explicit close confirmation; a lost close response recovers by GET', async () => {
    const intent = savedIntent(); saveTrainingPurchase(intent);
    mocks.get.mockResolvedValue({ version: 1, status: 'unknown', idempotencyKey: intent.idempotencyKey });
    mocks.post.mockRejectedValue(new Error('lost close response'));
    await mount(); await act(async () => button('CLOSE UNACCEPTED REQUEST').click());
    expect(mocks.post).not.toHaveBeenCalled();
    await act(async () => button('CONFIRM CLOSE REQUEST').click()); await flush();
    expect(mocks.post).toHaveBeenCalledWith('/army/training/close', { idempotencyKey: intent.idempotencyKey, confirmed: true });
    expect(readTrainingPurchase(intent.wallet)).toEqual(intent);
    await act(async () => button('KEEP REQUEST').click());
    mocks.get.mockResolvedValue({ version: 1, status: 'closed', idempotencyKey: intent.idempotencyKey, closedAt: '2026-09-06T00:00:00.000Z' });
    await act(async () => button('CHECK PURCHASE STATUS').click()); await flush();
    expect(readTrainingPurchase(intent.wallet)).toBeNull(); expect(trained).not.toHaveBeenCalled();
  });

  it('acceptance winning the close race is acknowledgement, never cancellation or refund', async () => {
    const intent = savedIntent(); saveTrainingPurchase(intent);
    mocks.get.mockResolvedValue({ version: 1, status: 'unknown', idempotencyKey: intent.idempotencyKey });
    mocks.post.mockResolvedValue(acceptedReceipt(intent));
    await mount(); await act(async () => button('CLOSE UNACCEPTED REQUEST').click());
    await act(async () => button('CONFIRM CLOSE REQUEST').click()); await flush();
    expect(trained).toHaveBeenCalledOnce(); expect(readTrainingPurchase(intent.wallet)).toBeNull();
    expect(mocks.post.mock.calls.map(([path]) => path)).toEqual(['/army/training/close']);
  });

  it('changing wallets during an uncertain purchase preserves its original identity for a later login', async () => {
    mocks.get.mockResolvedValue({ composition: quote.requested });
    let resolvePurchase!: (value: unknown) => void;
    mocks.post.mockImplementation((path: string) => path.endsWith('quote') ? Promise.resolve(quote) : new Promise((resolve) => { resolvePurchase = resolve; }));
    await mount(); await act(async () => button('RETRAIN PREVIOUS ARMY').click()); await flush();
    await act(async () => button('ADD TO QUEUE · 2 · 10 SHARDS').click()); await flush();
    const intent = readTrainingPurchase('test-wallet')!;
    await act(async () => useApp.setState({ wallet: 'other-wallet', selectedBaseId: 'other-base', baseSelectionEpoch: 1 }));
    await act(async () => resolvePurchase(result())); await flush();
    expect(readTrainingPurchase('test-wallet')).toEqual(intent); expect(trained).not.toHaveBeenCalled();
    expect(readTrainingPurchase('other-wallet')).toBeNull();
  });

  it('a sold-base receipt remains recoverable without posting into the new selected base', async () => {
    const intent = savedIntent(); saveTrainingPurchase(intent);
    useApp.setState({ selectedBaseId: 'other-base' });
    mocks.get.mockResolvedValue({ version: 1, status: 'unknown', idempotencyKey: intent.idempotencyKey });
    await mount();
    expect(button('RETRY CONFIRMED BATCH').disabled).toBe(true);
    expect(document.body.textContent).toContain('FOR ANOTHER BASE');
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it.each(['missing', 'future'] as const)('refuses a %s training schedule before confirmation', async (kind) => {
    mocks.get.mockResolvedValue({ composition: quote.requested });
    mocks.post.mockResolvedValue({ ...quote, consent: kind === 'missing' ? undefined : { ...quote.consent, version: 99 } });
    await mount(); await act(async () => button('RETRAIN PREVIOUS ARMY').click()); await flush();
    expect(button('ADD TO QUEUE · 2 · 10 SHARDS')).toBeUndefined();
    expect(document.body.textContent).toContain('requires a game update');
    expect(readTrainingPurchase('test-wallet')).toBeNull();
  });
});

it.each(['empty response', 'wrong count', 'duplicate units'] as const)('a %s acknowledgement retains the purchase for receipt recovery', async (kind) => {
  mocks.get.mockResolvedValue({ composition: quote.requested });
  const invalid = kind === 'empty response' ? {} : kind === 'wrong count' ? { ...result(), queue: result().queue.slice(0, 1) }
    : { ...result(), queue: [result().queue[0], result().queue[0]] };
  mocks.post.mockImplementation((path: string) => Promise.resolve(path.endsWith('quote') ? quote : invalid));
  await mount(); await act(async () => button('RETRAIN PREVIOUS ARMY').click()); await flush();
  await act(async () => button('ADD TO QUEUE · 2 · 10 SHARDS').click()); await flush();
  expect(readTrainingPurchase('test-wallet')).not.toBeNull();
  expect(trained).not.toHaveBeenCalled();
  expect(button('RETRAIN PREVIOUS ARMY').disabled).toBe(true);
});

it('two tabs observing an empty wallet preserve both immutable purchase intents; clearing one never clears the other', () => {
  // Interleave the two tabs at their pre-confirmation read. The old single
  // wallet slot let the second writer destroy the first purchase's only key.
  expect(readTrainingPurchase('test-wallet')).toBeNull();
  expect(readTrainingPurchase('test-wallet')).toBeNull();
  const a = savedIntent(); const b = { ...a, idempotencyKey: '20000000-0000-4000-8000-000000000002' };
  saveTrainingPurchase(a); saveTrainingPurchase(b);
  expect(readTrainingPurchase(a.wallet, a.idempotencyKey)).toEqual(a);
  expect(readTrainingPurchase(b.wallet, b.idempotencyKey)).toEqual(b);
  clearTrainingPurchase(b);
  expect(readTrainingPurchase(a.wallet)).toEqual(a);
  expect(readTrainingPurchase(b.wallet, b.idempotencyKey)).toBeNull();
  clearTrainingPurchase(a); expect(readTrainingPurchase(a.wallet)).toBeNull();
});

it('migrates the earlier wallet slot only after verifying the new immutable copy', () => {
  const intent = savedIntent(); const legacy = `pkw:training-purchase:v1:${intent.wallet}`;
  localStorage.setItem(legacy, JSON.stringify(intent));
  expect(readTrainingPurchase(intent.wallet)).toEqual(intent);
  expect(localStorage.getItem(legacy)).toBeNull();
  expect(localStorage.getItem(`${legacy}:${intent.idempotencyKey}`)).toBe(JSON.stringify(intent));
});

it('corrupt saved JSON gives an actionable recovery error and preserves the data without a purchase', async () => {
  const key = 'pkw:training-purchase:v1:test-wallet';
  localStorage.setItem(key, '{broken'); await mount();
  expect(document.body.textContent).toContain('Saved training purchase could not be verified');
  expect(document.body.textContent).not.toContain('SyntaxError');
  expect(button('RETRY SAVED PURCHASE')).toBeDefined();
  expect(localStorage.getItem(key)).toBe('{broken'); expect(mocks.post).not.toHaveBeenCalled();
});

it('rounds fractional durations up consistently and shows the next completion plus total tail time', async () => {
  const fractional = { ...quote, completionSec: 15,
    consent: { ...quote.consent, unitDurations: [{ troop: 'bowman', durationMs: 7500 }] },
    schedule: { ...quote.schedule, durationMs: 15000, finishesAt: '2026-09-06T00:00:15.000Z' } };
  mocks.get.mockResolvedValue({ composition: quote.requested }); mocks.post.mockResolvedValue(fractional);
  await mount(); await act(async () => button('RETRAIN PREVIOUS ARMY').click()); await flush();
  expect(document.body.textContent).toContain('NEXT TROOP IN 8s');
  expect(document.body.textContent).toContain('ALL READY IN 15s');
  expect(document.body.textContent).toContain('STARTS'); expect(document.body.textContent).toContain('FINISHES');
});

it('an unavailable batch with an occupied lane shows reasons and no misleading completion promise', async () => {
  mocks.get.mockResolvedValue({ composition: quote.requested });
  mocks.post.mockResolvedValue({ ...quote, queueable: [], costShards: '0', completionSec: 0,
    consent: { ...quote.consent, unitDurations: [] },
    schedule: { ...quote.schedule, startsAt: '2026-09-06T00:02:00.000Z', finishesAt: '2026-09-06T00:02:00.000Z', waitMs: 120000, durationMs: 0 } });
  await mount(); await act(async () => button('RETRAIN PREVIOUS ARMY').click()); await flush();
  expect(document.body.textContent).toContain('NO TROOPS AVAILABLE TO QUEUE');
  expect(document.body.textContent).not.toContain('ALL READY IN');
  expect(button('ADD TO QUEUE · 0 · 0 SHARDS').disabled).toBe(true);
});

it('the real guide follows the actual training review dialog, confirmed queue and zero-KEEP free finish', async () => {
  const { default: OnboardingGuide } = await import('../tutorial/OnboardingGuide');
  let measured: Element | null = null;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this.matches('button, input, select, textarea')) measured = this;
    return { x: 40, y: 180, left: 40, top: 180, right: 240, bottom: 224,
      width: 200, height: 44, toJSON: () => ({}) };
  });
  vi.spyOn(document, 'elementFromPoint').mockImplementation(() => {
    const dialog = document.querySelector('[data-training-confirmation]');
    return dialog && measured && !dialog.contains(measured) ? dialog : measured;
  });
  useApp.setState({ authed: true, screen: 'base', balances: { shards: '1000', keep: '0', keepRate: 0 },
    base: { player: { keepLevel: 1 }, buildings: [], jobs: [], army: [] } as never });
  const step = { questId: 'first-army', templateCode: 'first_troops', target: 20, rewardShards: 25, progress: 0, completed: false, claimed: false };
  let purchased = false;
  const queue = result().queue.map((row) => ({ ...row, startedAt: new Date().toISOString(), finishesAt: new Date(Date.now() + 60_000).toISOString(), canCancel: true, refundShards: '10' }));
  const finishConsent = { version: 2, maxCostKeep: '0', queue: queue.map(({ id, startedAt, finishesAt }) => ({ id, startedAt, finishesAt })) };
  mocks.get.mockImplementation(() => Promise.resolve({ counts: {}, levels: {}, research: [], queue: purchased ? queue : [], rosterPts: 0,
    campCapacityPts: 20, barracksQueuePts: 10, eliteUnlocks: {}, features: {},
    freeFinishAllOffer: purchased ? { offer: 'first_troops', consent: finishConsent } : null }));
  mocks.post.mockImplementation((path: string) => {
    if (path.endsWith('/quote')) return Promise.resolve({ ...quote, requested: [{ troop: 'bowman', count: 2 }], remaining: [], costShards: '20', availableShards: '1000' });
    if (path.endsWith('/batch')) { purchased = true; return Promise.resolve({ ...result(), costShards: '20' }); }
    return Promise.resolve({ cost: '0', completed: [{ troop: 'bowman', count: 2 }] });
  });
  const settleGuide = async () => act(async () => { await new Promise((r) => setTimeout(r, 300)); });
  await act(async () => root.render(<><TrainTray /><OnboardingGuide step={step} onDone={() => {}} onState={() => {}} /></>));
  await flush();
  const card = document.querySelector('[data-train-troop="bowman"]') as HTMLButtonElement;
  await act(async () => { card.click(); card.click(); }); await settleGuide();
  expect(document.body.textContent).toContain('TAP REVIEW TRAINING');
  await act(async () => button('REVIEW TRAINING · 2').click()); await flush(); await settleGuide();
  expect(document.body.textContent).toContain('REVIEW THE SHARDS COST, THEN TAP ADD TO QUEUE');
  const dialogCaption = document.querySelector('[data-training-confirmation] [data-onboarding-caption-slot="training"]');
  expect(dialogCaption?.textContent).toContain('REVIEW THE SHARDS COST, THEN TAP ADD TO QUEUE');
  expect(dialogCaption?.textContent).toContain('SKIP');
  expect(document.querySelectorAll('[data-onboarding-bubble]')).toHaveLength(1);
  expect(document.querySelector('[data-training-confirmation] [data-tutorial-target="training-add-to-queue"]')).not.toBeNull();
  await act(async () => button('ADD TO QUEUE · 2 · 20 SHARDS').click()); await flush(); await settleGuide();
  expect(document.body.textContent).toContain('TAP FINISH ALL · FREE — NO KEEP NEEDED');
  expect(document.querySelector('[data-training-confirmation]')).toBeNull();
  expect(document.querySelector('[data-onboarding-caption-slot="training"]')?.textContent).toContain('TAP FINISH ALL · FREE');
  const free = document.querySelector('[data-tutorial-target="training-free-finish"]') as HTMLButtonElement;
  expect(free.disabled).toBe(false); await act(async () => free.click()); await flush();
  expect(mocks.post).toHaveBeenLastCalledWith('/army/train/speedup', expect.objectContaining({ freeOffer: 'first_troops', consent: finishConsent }));
});

describe('a failed purchase is loud, on top, and explains blocked taps (tester reports 2026-09-16 ×2)', () => {
  // WHY: "sometimes training fails and I need to click RETRY, but there's no
  // sign unless I check the Barracks" + "move the failed panel to the top".
  // The receipt logic is untouched; what changes is that failure is announced
  // the moment it happens, the notice leads with RETRY at the top of the tray,
  // and a troop card tapped while blocked says why instead of doing nothing.
  const toasts = (): string[] => toastSpy.mock.calls.map(([e]) => (e as { msg: string }).msg);
  let toastSpy: ReturnType<typeof vi.fn>; let off: () => void;
  beforeEach(() => { toastSpy = vi.fn(); off = bus.on('ui:toast', toastSpy as never); });
  afterEach(() => off());

  it('toasts TRAINING FAILED the moment the batch is refused and titles the notice RETRY', async () => {
    mocks.get.mockResolvedValue({ raidId: 'last', composition: quote.requested, message: null });
    mocks.post.mockImplementation((path: string) => path.endsWith('quote') ? Promise.resolve(quote) : Promise.reject(new Error('connection lost')));
    await mount(); await act(async () => button('RETRAIN PREVIOUS ARMY').click()); await flush();
    await act(async () => button('ADD TO QUEUE · 2 · 10 SHARDS').click()); await flush();
    expect(toasts().some((m) => m.startsWith('TRAINING FAILED'))).toBe(true);
    const notice = document.querySelector('[data-training-recovery]')!;
    expect(notice.textContent).toContain('TRAINING FAILED · RETRY');
    expect(document.body.textContent).toContain('connection lost'); // the tray's status line still names the cause
    expect(button('RETRY CONFIRMED BATCH')).toBeDefined();
  });

  it('HIDE folds the notice to one line and SHOW brings the RETRY back', async () => {
    saveTrainingPurchase(savedIntent());
    mocks.get.mockResolvedValue({ version: 1, status: 'unknown', idempotencyKey: savedIntent().idempotencyKey });
    await mount();
    expect(button('RETRY CONFIRMED BATCH')).toBeDefined();
    await act(async () => button('HIDE').click());
    expect(button('RETRY CONFIRMED BATCH')).toBeUndefined();
    expect(document.querySelector('[data-training-recovery]')!.textContent).toContain('TRAINING FAILED · RETRY');
    await act(async () => button('SHOW').click());
    expect(button('RETRY CONFIRMED BATCH')).toBeDefined();
  });

  it('in the barracks tray the notice renders at the TOP and a blocked troop tap explains itself', async () => {
    saveTrainingPurchase(savedIntent());
    mocks.get.mockImplementation((path: string) => path.startsWith('/army/training/receipt')
      ? Promise.resolve({ version: 1, status: 'unknown', idempotencyKey: savedIntent().idempotencyKey })
      : Promise.resolve({ counts: {}, levels: {}, research: [], queue: [], rosterPts: 0,
        campCapacityPts: 200, barracksQueuePts: 100, eliteUnlocks: {}, features: {} }));
    await act(async () => root.render(<TrainTray />)); await flush();
    const tray = host.querySelector('.sk-training-tray')!;
    const notice = tray.querySelector('[data-training-recovery]')!;
    expect(notice.textContent).toContain('TRAINING FAILED · RETRY');
    // Above every troop card — the host sits right under the heading.
    const firstCard = tray.querySelector('[data-train-troop]')!;
    expect(notice.compareDocumentPosition(firstCard) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The card is NOT a disabled dead button: the tap says why.
    const card = tray.querySelector('[data-train-troop="bowman"]') as HTMLButtonElement;
    expect(card.disabled).toBe(false);
    await act(async () => card.click());
    expect(toasts()).toContain('TRAINING FAILED · RETRY OR CLOSE THE ORIGINAL PURCHASE ABOVE');
    expect(card.getAttribute('data-selected-count')).toBe('0');
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it('+10 and MAX select through the capacity gate; MAX after MAX is a no-op', async () => {
    mocks.get.mockResolvedValue({ counts: {}, levels: {}, research: [], queue: [], rosterPts: 0,
      campCapacityPts: 26, barracksQueuePts: 100, eliteUnlocks: {}, features: {} });
    await act(async () => root.render(<TrainTray />)); await flush();
    const card = (): HTMLButtonElement => host.querySelector('[data-train-troop="bowman"]') as HTMLButtonElement;
    const stepper = (label: string): HTMLButtonElement => [...host.querySelectorAll('button')]
      .find((b) => b.getAttribute('aria-label') === label) as HTMLButtonElement;
    // bowman is 1 pt: 26 pts of camp room = 26 units at most.
    await act(async () => stepper('Add ten BOWMAN').click());
    expect(card().getAttribute('data-selected-count')).toBe('10');
    await act(async () => stepper('Select the maximum BOWMAN').click());
    expect(card().getAttribute('data-selected-count')).toBe('26');
    expect(stepper('Select the maximum BOWMAN').disabled).toBe(true);
    expect(stepper('Add ten BOWMAN').disabled).toBe(true);
    expect(host.textContent).toContain('ARMY CAPACITY LIMIT');
    await act(async () => stepper('Remove one selected BOWMAN').click());
    expect(card().getAttribute('data-selected-count')).toBe('25');
    expect(mocks.post).not.toHaveBeenCalled();
  });
});
