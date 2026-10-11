/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authCookies } from '../../auth/authCookieCoordinator';
import { captureBaseBalanceCommit } from '../../state/baseSnapshot';
import { useApp, type BaseStateDto } from '../../state/store';
import { api, ApiError } from '../api';
import { createTrainingFinishBrowserPorts, trainingFinishIdentity, refreshTrainingFinishSnapshot } from './browser';
import { id, identity, training } from './fixtures.test-support';
const funds = () => ({ keep: '100', gems: '100', shards: '500', keepRate: 1, features: { gameCurrency: { version: 1, exactSpendCurrency: 1 }, gems: { version: 1, receipts: 1 } } });
const directory = () => ({ enabled: true, capabilities: { baseScopedReads: true, baseScopedMutations: true }, bases: [{ id: id(1), status: 'active', slot: 1 }] });
const army = () => ({ counts: { bowman: 1 }, levels: { bowman: 1 }, queue: training.consent.queue.map(row => ({ ...row, troop: 'bowman' })),
  finishAllQuote: structuredClone(training.consent), freeFinishAllOffer: null as unknown, freeFinishAllReviewRequired: false,
  features: { trainingScheduling: { version: 2, mode: 'sequential', lanes: 1, consentRequired: true }, trainingFinishReceipts: { version: 1 } } });
const base = () => ({ baseId: id(1), player: { wallet: identity.wallet, keepLevel: 5 }, buildings: [], army: [{ troop: 'bowman', count: 1, level: 1 }], jobs: [], obstacles: [] }) as unknown as BaseStateDto;
let rows: ReturnType<typeof army>, balances: ReturnType<typeof funds>, dirs: ReturnType<typeof directory>;
const read = async (path: string): Promise<unknown> => {
  if (path === '/me') return { wallet: identity.wallet };
  if (path === '/bases') return dirs;
  if (path.startsWith('/base?')) return base();
  if (path.startsWith('/army?')) return rows;
  if (path.startsWith('/balances?')) return balances;
  throw new Error(`Unexpected test GET ${path}`);
};
const setup = () => { const page = { active: true, visible: true, epoch: 0, actionsEnabled: true }, scoped = trainingFinishIdentity(identity.wallet);
  return { page, scoped, ports: createTrainingFinishBrowserPorts({ identity: scoped, lifecycle: () => page }) }; };
beforeEach(() => {
  vi.spyOn(authCookies, 'assertSession').mockReturnValue('session'); vi.spyOn(authCookies, 'assertResponse').mockImplementation(() => undefined);
  useApp.getState().setAuth(identity.wallet, true); useApp.setState({ selectedBaseId: id(1), baseSelectionEpoch: 0 });
  rows = army(); balances = funds(); dirs = directory(); vi.spyOn(api, 'get').mockImplementation(async path => structuredClone(await read(path)) as never);
});
afterEach(() => { vi.restoreAllMocks(); useApp.getState().setAuth(null); });
const prepare = (ports: ReturnType<typeof setup>['ports']) => ports.prepare({ baseId: training.baseId }, training.idempotencyKey, ports.capture(training.baseId));
describe('training server-authoritative paid consent', () => {
  it('freezes full server queue and price with whole Gems, otherwise whole KEEP; client clock cannot reprice it', async () => {
    const { ports } = setup(); vi.spyOn(Date, 'now').mockReturnValue(0);
    expect(await prepare(ports)).toEqual(training);
    balances.gems = '99'; expect((await prepare(ports)).expectedCurrency).toBe('KEEP');
    balances.keep = '99'; await expect(prepare(ports)).rejects.toThrow('Neither');
  });
  it.each(['currency', 'receipt', 'scheduling', 'quote', 'count-string', 'version-string'] as const)('fails closed on missing/invalid %s', async kind => {
    const { ports } = setup();
    if (kind === 'currency') balances.features = {} as never;
    if (kind === 'receipt') rows.features.trainingFinishReceipts.version = 2;
    if (kind === 'scheduling') rows.features.trainingScheduling.consentRequired = false;
    if (kind === 'quote') delete (rows as Partial<typeof rows>).finishAllQuote;
    if (kind === 'count-string') rows.counts.bowman = '1' as never;
    if (kind === 'version-string') rows.finishAllQuote.version = '2' as never;
    await expect(prepare(ports)).rejects.toThrow();
  });
  it.each(['available', 'missing', 'review', 'malformed'] as const)('never offers paid review when free eligibility is %s', async state => {
    const { ports } = setup();
    if (state === 'available') rows.freeFinishAllOffer = { offer: 'first_troops', consent: { ...training.consent, maxCostKeep: '0' } };
    if (state === 'missing') delete (rows as Partial<typeof rows>).freeFinishAllOffer;
    if (state === 'review') rows.freeFinishAllReviewRequired = true;
    if (state === 'malformed') rows.freeFinishAllOffer = false;
    await expect(prepare(ports)).rejects.toThrow('free Finish');
    await expect(ports.validate(training, ports.capture(id(1)))).rejects.toThrow('free Finish');
  });
  it('allows an exact remaining subset and lower price without ever altering the original command', async () => {
    const { ports } = setup(), original = structuredClone(training);
    rows.queue = rows.queue.slice(1); rows.finishAllQuote.queue = rows.finishAllQuote.queue.slice(1); rows.finishAllQuote.maxCostKeep = '80'; balances.gems = '80';
    await expect(ports.validate(training, ports.capture(id(1)))).resolves.toBeUndefined();
    expect(training).toEqual(original); // Server, not browser time, proves whether omitted rows completed naturally.
  });
  it.each(['new-row', 'rescheduled', 'changed-price', 'quote-omission', 'empty', 'currency'] as const)('refuses %s without retargeting or changing saved currency', async change => {
    const { ports } = setup();
    if (change === 'new-row') { rows.queue[0]!.id = id(9); rows.finishAllQuote.queue[0]!.id = id(9); }
    if (change === 'rescheduled') { rows.queue[0]!.finishesAt = '2026-09-21T12:00:01.000Z'; rows.finishAllQuote.queue[0]!.finishesAt = rows.queue[0]!.finishesAt; }
    if (change === 'changed-price') rows.finishAllQuote.maxCostKeep = '101';
    if (change === 'quote-omission') rows.finishAllQuote.queue = rows.finishAllQuote.queue.slice(1);
    if (change === 'empty') { rows.queue = []; rows.finishAllQuote.queue = []; rows.finishAllQuote.maxCostKeep = '0'; }
    if (change === 'currency') balances.gems = '0';
    await expect(ports.validate(training, ports.capture(id(1)))).rejects.toThrow();
    expect(training.consent.queue).toHaveLength(2); expect(training.expectedCurrency).toBe('GEMS');
  });
  it('brackets authority reads and never admits a legacy or inactive substitute base', async () => {
    const { ports } = setup(); let seen = 0;
    vi.mocked(api.get).mockImplementation(async path => path === '/bases' && ++seen === 2 ? { ...dirs, bases: [] } as never : structuredClone(await read(path)) as never);
    await expect(prepare(ports)).rejects.toThrow('ownership changed');
    vi.mocked(api.get).mockImplementation(async path => structuredClone(await read(path)) as never);
    dirs.capabilities.baseScopedMutations = false; await expect(prepare(ports)).rejects.toThrow('unavailable');
    dirs.capabilities.baseScopedMutations = true; dirs.bases[0]!.status = 'inactive'; await expect(prepare(ports)).rejects.toThrow('unavailable');
    useApp.setState({ selectedBaseId: null }); await expect(ports.prepare({ baseId: null }, training.idempotencyKey, ports.capture(null))).rejects.toThrow('unavailable');
  });
  it('enqueues exact currency only while original selection epoch/navigation/session are still current', async () => {
    const { ports, page } = setup(), guard = ports.capture(id(1)), body = { original: true };
    vi.spyOn(api, 'postRaw').mockResolvedValue({}); await ports.post('/army/train/speedup', body, 'GEMS', guard);
    const call = vi.mocked(api.postRaw).mock.calls[0]!; expect(call[1]).toBe(body); expect(call[2]?.expectedCurrency).toBe('GEMS');
    useApp.setState({ baseSelectionEpoch: 2 }); expect(call[2]?.isCurrent).toThrow();
    const receipt = ports.capture(); page.actionsEnabled = false; expect(receipt).not.toThrow(); expect(ports.capture(id(1))).toThrow();
    page.epoch++; expect(receipt).toThrow();
  });
  it('recognizes only exact status/code first-refusal candidates; malformed, collision and wrong-currency evidence stays uncertain', () => {
    const { ports } = setup();
    for (const [status, code] of [[404, 'TRAINING_NOT_RUNNING'], [409, 'TRAINING_FINISH_QUOTE_CHANGED'], [409, 'TRAINING_CHANGED'], [409, 'TRAINING_FINISH_SCOPE_CHANGED'], [409, 'TROOP_ROSTER_INACTIVE'], [404, 'BASE_NOT_OWNED'], [409, 'BASE_ID_REQUIRED'], [409, 'DEED_OWNERSHIP_CHANGED'], [423, 'BASE_BEING_RAIDED'], [503, 'DEED_AUTHORITY_UNAVAILABLE']] as const) {
      expect(ports.definitiveRefusal(new ApiError(status, 'refused', code), training)?.code).toBe(code);
      expect(ports.definitiveRefusal(new ApiError(status + 1, 'refused', code), training)).toBeNull();
    }
    expect(ports.definitiveRefusal(new ApiError(409, 'changed', 'CURRENCY_CONSENT_CHANGED', { expectedCurrency: 'GEMS' }), training)?.code).toBe('CURRENCY_CONSENT_CHANGED');
    for (const error of [new ApiError(404, 'nothing is training'), new ApiError(409, 'collision', 'TRAINING_FINISH_RECEIPT_INVALID'), new ApiError(409, 'body', 'IDEMPOTENCY_BODY_MISMATCH'), new ApiError(409, 'changed', 'CURRENCY_CONSENT_CHANGED', { expectedCurrency: 'KEEP' }), new Error('offline')]) expect(ports.definitiveRefusal(error, training)).toBeNull();
  });
  it('fresh base/army/balances publish together without using historic receipt troop counts', async () => {
    const { ports, scoped } = setup(); useApp.getState().setBalances({ ...balances, gems: '999' });
    const seen: string[] = [], stop = useApp.subscribe(s => seen.push(`${s.base?.baseId}/${s.balances?.gems}`));
    const snapshot = await refreshTrainingFinishSnapshot(scoped, ports); stop();
    expect(seen).toEqual([`${id(1)}/100`]); expect(snapshot?.training.counts.bowman).toBe(1);
  });
  it.each(['wallet', 'base', 'ownership', 'selection', 'newer-read', 'army'] as const)('changed %s cannot publish stale training or account state', async change => {
    const { ports, scoped } = setup(); useApp.getState().setBalances({ ...balances, gems: '999' }); let seen = 0;
    vi.mocked(api.get).mockImplementation(async path => {
      if (change === 'wallet' && path === '/me') return { wallet: 'another-wallet' } as never;
      if (change === 'base' && path.startsWith('/base?')) return { ...base(), baseId: id(2) } as never;
      if (change === 'ownership' && path === '/bases' && ++seen === 2) return { ...dirs, bases: [] } as never;
      if (change === 'army' && path.startsWith('/army?')) return { ...rows, counts: { bowman: 2 } } as never;
      if (path.startsWith('/balances?')) {
        if (change === 'selection') useApp.setState({ baseSelectionEpoch: 2 });
        if (change === 'newer-read') captureBaseBalanceCommit(id(1))({ ...balances, gems: '777' });
      }
      return structuredClone(await read(path)) as never;
    });
    await expect(refreshTrainingFinishSnapshot(scoped, ports)).rejects.toThrow();
    expect(useApp.getState().balances?.gems).toBe(change === 'newer-read' ? '777' : '999');
  });
  it('returns no snapshot for a sold/unselected original base, rather than substituting another one', async () => {
    const { ports, scoped } = setup(); dirs.bases = []; expect(await refreshTrainingFinishSnapshot(scoped, ports)).toBeNull();
    expect(vi.mocked(api.get).mock.calls.map(([path]) => path)).toEqual(['/me', '/bases']);
  });
});
