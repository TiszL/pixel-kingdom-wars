/** @vitest-environment happy-dom */
import { fmtDur } from '@shardkeep/shared';
import { IDBFactory } from 'fake-indexeddb';
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api, ApiError } from '../../lib/api';
import { authCookies } from '../../auth/authCookieCoordinator';
import { useApp } from '../../state/store';
import { unpaidOriginal } from '../../lib/unpaidResources/transport';
import { HarvesterJournalStore } from '../../lib/harvester/journal';
import { harvesterIdentity } from '../../lib/harvester/browser';
import { deferred, head, id, identity, proof, start, view, type SettlementOptions } from '../../lib/harvester/fixtures.test-support';
import { base, directory, funds } from '../../lib/workshop/snapshot.test-support';
import { HarvesterScreen } from './HarvesterScreen';
import { HarvesterDoor } from './HarvesterDoor';

vi.mock('../../lib/unpaidResources/transport', () => ({ unpaidOriginal: vi.fn() }));
let root: Root, host: HTMLDivElement, accepted: boolean, observation: SettlementOptions;
let currentView: ReturnType<typeof view>, visibility: DocumentVisibilityState;
const until = (fn: () => void | Promise<void>) => vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); await fn(); });
const button = (label: string) => [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === label);
const click = async (label: string) => { expect(button(label)?.disabled).toBe(false); await act(async () => button(label)!.click()); };
const saved = async () => { const store = new HarvesterJournalStore(harvesterIdentity(identity.wallet)); try { return await store.read(); } finally { await store.close(); } };
const posts = () => vi.mocked(unpaidOriginal).mock.calls.filter(([input]) => input.method === 'POST');
const originalGets = () => vi.mocked(unpaidOriginal).mock.calls.filter(([input]) => input.method === 'GET');
const stock = () => [...host.querySelectorAll('[aria-label="Current Harvester stock"] dd')]
  .map(row => row.textContent).filter(text => text?.includes(' available · '));
const mount = async (strict = false, actionsEnabled = true) => {
  await act(async () => root.render(strict ? <StrictMode><HarvesterScreen actionsEnabled={actionsEnabled} /></StrictMode> : <HarvesterScreen actionsEnabled={actionsEnabled} />));
  await until(() => expect(button('REFRESH STOCK & RECEIPTS')?.disabled).toBe(false));
};
async function review() {
  await click('REVIEW SELECTION'); await until(() => expect(button('CONFIRM SELECTION')?.disabled).toBe(false));
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('indexedDB', new IDBFactory());
  const held = new Set<string>(); Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: async (name: string, _options: unknown, run: (lock: object | null) => Promise<unknown>) => {
    if (held.has(name)) return run(null); held.add(name); try { return await run({}); } finally { held.delete(name); }
  } } });
  visibility = 'visible'; Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  vi.spyOn(authCookies, 'assertSession').mockReturnValue('session'); vi.spyOn(authCookies, 'assertResponse').mockImplementation(() => undefined);
  useApp.getState().setAuth(identity.wallet, true); useApp.getState().setScreen('harvesters');
  useApp.getState().setSelectedBaseId(id(1), false); useApp.getState().setBase(base());
  accepted = false; observation = {}; currentView = view();
  vi.spyOn(api, 'get').mockImplementation(async path => {
    if (path === '/me') return { wallet: identity.wallet } as never;
    if (path === '/bases') return directory() as never;
    if (path.startsWith('/base?')) return base() as never;
    if (path.startsWith('/balances?')) return funds as never;
    if (path.startsWith('/harvesters?')) return currentView as never;
    throw new Error(`Unexpected ${path}`);
  });
  vi.mocked(unpaidOriginal).mockReset().mockImplementation(async input => {
    input.isCurrent(); if (input.command.kind !== 'harvester') throw new Error('Unexpected command family');
    const journal = await saved(), key = input.command.request.idempotencyKey;
    const operation = journal.operation?.command.request.idempotencyKey === key ? journal.operation
      : journal.archives.find(row => row.operation.command.request.idempotencyKey === key)?.operation;
    if (!operation) throw new Error('Original selection must be durable before transport');
    if (input.method === 'POST') {
      expect(operation.attemptRevision).not.toBeNull(); expect(operation.command.request).toEqual(input.command.request); accepted = true;
    }
    const result = proof(operation.command, accepted, observation);
    if (result.status === 'accepted') await input.retainAccepted(result);
    input.isCurrent(); return result;
  });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); Reflect.deleteProperty(document, 'visibilityState'); Reflect.deleteProperty(navigator, 'locks'); useApp.getState().setAuth(null); });

it.each(['empty', 'other-base-expired'] as const)('explicit %s source consent freezes full policy and replacement while foreground stays GET-only', async kind => {
  if (kind === 'other-base-expired') currentView = view(head(id(20), true));
  await mount(true); await review();
  const terms = host.querySelector('[aria-label="Confirm Harvester selection"]')!.textContent!, policy = currentView.policy;
  const whole = (value: string | number) => BigInt(value).toLocaleString('en-US');
  expect(terms).toContain(`${whole(policy.producingSourcesPerWallet)} producing source per wallet`);
  expect(terms).toContain(`${whole(policy.grossPerCadence)} gross every ${fmtDur(policy.cadenceSec)}`);
  expect(terms).toContain(`${whole(policy.grossPerWalletUtcDay)} gross limit per wallet per UTC day`);
  expect(terms).toContain(`${whole(policy.islandPoolBps)} of every ${whole(policy.taxBasisPoints)}`);
  expect(terms).toContain(`${fmtDur(policy.maxLeaseSec)}`); expect(terms).toContain(`Policy version ${policy.policyVersion}`);
  expect(terms).toContain(start.request.baseId); expect(terms).toContain(start.request.harvesterId); expect(terms).toContain('No SOL, KEEP, Gems or SHARDS payment');
  const original = (await saved()).operation!.command;
  expect(original.policy).toEqual(policy); expect(original.replacedSource).toEqual(currentView.walletSource);
  expect(original.request.expectedSourceId).toBe(currentView.walletSource?.sourceId ?? null);
  if (kind === 'other-base-expired') { expect(terms).toContain(id(20)); expect(terms).toContain('unfinished earning period is discarded'); }
  else expect(terms).toContain('No existing wallet source will be replaced');
  expect(posts()).toHaveLength(0); await act(async () => window.dispatchEvent(new Event('focus')));
  await until(() => expect(button('CONFIRM SELECTION')).toBeUndefined()); expect(posts()).toHaveLength(0);
});

it('one explicit confirmation retains the complete original source independently of live stock and has no Collect action', async () => {
  await mount(); const before = stock(); expect(before).toHaveLength(currentView.rawStock.length);
  await review(); const original = (await saved()).operation!.command;
  await click('CONFIRM SELECTION'); await until(() => expect(host.textContent).toContain('ORIGINAL SOURCE ACCEPTED'));
  await until(() => expect(button('REFRESH STOCK & RECEIPTS')?.disabled).toBe(false));
  expect(posts()).toHaveLength(1); expect((await saved()).operation?.command).toEqual(original);
  expect((await saved()).operation?.proof).toEqual(proof(original, true)); expect(stock()).toEqual(before);
  expect([...host.querySelectorAll('button')].some(b => /collect/i.test(b.textContent ?? ''))).toBe(false);
  expect(useApp.getState().balances).toEqual(funds);
});

it('an archived source continues GET settlement after a custody stop and stops automatic observation only at closure', async () => {
  await mount(); await review(); await click('CONFIRM SELECTION');
  await until(() => expect(button('ARCHIVE ACCEPTED SOURCE')?.disabled).toBe(false));
  const original = (await saved()).operation!.proof, before = stock();
  await click('ARCHIVE ACCEPTED SOURCE'); await until(() => expect(host.textContent).toContain('EARNING HISTORY (1)'));
  observation = { events: 0, stopAfter: 1 }; currentView.acceptingSelections = false;
  await act(async () => window.dispatchEvent(new Event('focus')));
  await until(async () => expect((await saved()).archives[0]?.operation.proof).toMatchObject({ status: 'accepted', settlement: { custodyStop: { sourceId: (await saved()).archives[0]!.operation.command.request.idempotencyKey }, closure: null } }));
  await until(() => expect(button('REFRESH STOCK & RECEIPTS')?.disabled).toBe(false));
  observation = { events: 1, stopAfter: 1, closed: true };
  await act(async () => window.dispatchEvent(new Event('focus')));
  await until(async () => expect((await saved()).archives[0]?.operation.proof).toMatchObject({ status: 'accepted', settlement: { closure: { reason: 'custody_change', processedOrdinal: 1 } } }));
  await until(() => expect(button('REFRESH STOCK & RECEIPTS')?.disabled).toBe(false));
  const final = (await saved()).archives[0]!.operation.proof;
  if (final?.status === 'accepted' && original?.status === 'accepted') expect(final.originalReceipt).toEqual(original.originalReceipt);
  expect(host.textContent).toContain('Source closed: custody change'); expect(stock()).toEqual(before); expect(useApp.getState().balances).toEqual(funds); expect(posts()).toHaveLength(1);
  const recovered = originalGets().length; await act(async () => window.dispatchEvent(new Event('focus')));
  await until(() => expect(button('REFRESH STOCK & RECEIPTS')?.disabled).toBe(false)); expect(originalGets()).toHaveLength(recovered);
  await click('CHECK EARNING OBSERVATIONS'); await until(() => expect(originalGets()).toHaveLength(recovered + 1)); expect(posts()).toHaveLength(1);
});

it('lost acknowledgement recovers after transfer and provider pause without another POST or buyer-stock publication', async () => {
  const send = vi.mocked(unpaidOriginal).getMockImplementation()!;
  vi.mocked(unpaidOriginal).mockImplementation(async input => { if (input.method === 'POST') { accepted = true; throw new Error('lost acknowledgement'); } return send(input); });
  await mount(); await review(); await click('CONFIRM SELECTION');
  await until(() => expect(button('CHECK ORIGINAL RECEIPT')?.disabled).toBe(false));
  expect(host.textContent).toContain('ORIGINAL OUTCOME UNKNOWN'); expect(posts()).toHaveLength(1);
  expect((await saved()).operation?.attemptRevision).not.toBeNull();
  await act(async () => root.render(null)); currentView.acceptingSelections = false;
  const read = vi.mocked(api.get).getMockImplementation()!;
  vi.mocked(api.get).mockImplementation(async (path, options) => path === '/bases' ? { ...directory(), bases: [] } as never : read(path, options));
  await mount(false, false); await until(() => expect(host.textContent).toContain('ORIGINAL SOURCE ACCEPTED'));
  expect(host.textContent).toContain('Current kingdom stock and Harvesters are unavailable');
  expect(host.querySelector('[aria-label="Current selected kingdom Harvesters"]')).toBeNull(); expect(posts()).toHaveLength(1);
});

it('owned acceptance after unmount is saved before journal close and cannot publish obsolete balances', async () => {
  const writes = vi.spyOn(HarvesterJournalStore.prototype, 'compareAndSet'), closes = vi.spyOn(HarvesterJournalStore.prototype, 'close');
  const waiting = deferred(), entered = deferred(), send = vi.mocked(unpaidOriginal).getMockImplementation()!;
  vi.mocked(unpaidOriginal).mockImplementation(async input => {
    if (input.method !== 'POST') return send(input);
    input.isCurrent(); entered.resolve(); await waiting.promise; accepted = true;
    const result = proof((await saved()).operation!.command, true);
    if (result.status === 'accepted') await input.retainAccepted(result);
    input.isCurrent(); return result;
  });
  try {
    await mount(); await review(); const originalStore = writes.mock.contexts[0]!;
    await click('CONFIRM SELECTION'); await entered.promise;
    await act(async () => root.render(null)); useApp.getState().setBalances({ ...funds, shards: '98765' });
    expect(closes.mock.contexts).not.toContain(originalStore);
    await act(async () => waiting.resolve()); await until(() => expect(closes.mock.contexts).toContain(originalStore));
    expect((await saved()).operation?.proof?.status).toBe('accepted'); expect(useApp.getState().balances?.shards).toBe('98765');
    await mount(); await until(() => expect(host.textContent).toContain('ORIGINAL SOURCE ACCEPTED')); expect(posts()).toHaveLength(1);
  } finally { waiting.resolve(); }
});

it('cancelling during confirmation recovery preserves an unsent draft and prevents enqueue', async () => {
  await mount(); await review(); const waiting = deferred(), entered = deferred(), send = vi.mocked(unpaidOriginal).getMockImplementation()!;
  let delayed = false;
  vi.mocked(unpaidOriginal).mockImplementation(async input => { if (input.method === 'GET' && !delayed) { delayed = true; entered.resolve(); await waiting.promise; } return send(input); });
  try {
    await click('CONFIRM SELECTION'); await entered.promise; await click('CANCEL REVIEW');
    await act(async () => waiting.resolve()); await until(() => expect(button('REVIEW ORIGINAL REQUEST')?.disabled).toBe(false));
    expect((await saved()).operation?.attemptRevision).toBeNull(); expect(posts()).toHaveLength(0);
  } finally { waiting.resolve(); }
});

it('freeze and maintenance retire consent while resumed original recovery stays GET-only', async () => {
  await mount(); await review(); await act(async () => { visibility = 'hidden'; document.dispatchEvent(new Event('freeze')); });
  expect(button('CONFIRM SELECTION')).toBeUndefined();
  await act(async () => { visibility = 'visible'; document.dispatchEvent(new Event('resume')); });
  await until(() => expect(button('REVIEW ORIGINAL REQUEST')?.disabled).toBe(false));
  await click('REVIEW ORIGINAL REQUEST'); await until(() => expect(button('CONFIRM SELECTION')).toBeDefined()); await mount(false, false);
  expect(button('CONFIRM SELECTION')).toBeUndefined(); expect(button('CHECK ORIGINAL RECEIPT')?.disabled).toBe(false); expect(posts()).toHaveLength(0);
});

it('a provider pause after review refuses the new attempt without losing its original command', async () => {
  await mount(); await review(); const original = (await saved()).operation!.command;
  currentView.acceptingSelections = false; await click('CONFIRM SELECTION');
  await until(() => expect(host.textContent).toContain('New selection requires available server admission'));
  expect(button('CONFIRM SELECTION')).toBeUndefined(); expect(posts()).toHaveLength(0);
  expect((await saved()).operation).toMatchObject({ command: original, attemptRevision: null, proof: null });
});

const unavailable: Array<{ name: string; message: string; change: (v: ReturnType<typeof view>) => void }> = [
  { name: 'home authority', message: 'Home authority is unavailable', change: v => { v.home = null; } },
  { name: 'completed Harvester', message: 'Complete a Harvester in this kingdom', change: v => { v.facilities = []; } },
  { name: 'provider admission', message: 'New selections are unavailable', change: v => { v.acceptingSelections = false; } },
];
it.each(unavailable)('missing $name refuses new selection without inventing readiness', async ({ change, message }) => {
  change(currentView); await mount(); expect(host.textContent).toContain(message);
  expect(button('REVIEW SELECTION')?.disabled ?? true).toBe(true);
  expect(stock()).toHaveLength(currentView.rawStock.length); expect(posts()).toHaveLength(0); expect((await saved()).operation).toBeNull();
});

it('a replaced wallet head changing after review refuses the POST and preserves the exact old consent', async () => {
  currentView = view(head(id(20), true)); await mount(); await review(); const original = (await saved()).operation!.command;
  currentView = view(); await click('CONFIRM SELECTION');
  await until(() => expect(host.textContent).toContain('reviewed facility, realm, policy or wallet source changed'));
  expect((await saved()).operation).toMatchObject({ command: original, attemptRevision: null }); expect(posts()).toHaveLength(0);
});

it('archived refusal can gain original acceptance while preserving the earlier refusal and absence evidence', async () => {
  const send = vi.mocked(unpaidOriginal).getMockImplementation()!;
  vi.mocked(unpaidOriginal).mockImplementation(async input => {
    if (input.method !== 'POST') return send(input);
    await input.retainRefusal({ status: 409, code: 'HARVESTER_SOURCE_CHANGED' });
    throw new ApiError(409, 'Source changed', 'HARVESTER_SOURCE_CHANGED');
  });
  await mount(); await review(); await click('CONFIRM SELECTION'); await until(() => expect(button('ARCHIVE DECLINED REQUEST')?.disabled).toBe(false));
  await click('ARCHIVE DECLINED REQUEST'); await until(() => expect(button('CHECK ARCHIVED RECEIPT')?.disabled).toBe(false));
  const old = (await saved()).archives[0]!; accepted = true; await click('CHECK ARCHIVED RECEIPT');
  await until(() => expect(host.textContent).toContain('Original acceptance recovered after archival'));
  expect((await saved()).archives[0]).toMatchObject({ reason: 'refused', evidence: old.evidence,
    operation: { refusal: old.operation.refusal, proof: { status: 'accepted' } } });
  expect(host.textContent).toContain('Original refusal: harvester source changed'); expect(posts()).toHaveLength(1);
});

it('failed current hydration keeps accepted source active rather than silently archiving or inferring stock', async () => {
  await mount(); await review(); await click('CONFIRM SELECTION'); await until(() => expect(button('ARCHIVE ACCEPTED SOURCE')?.disabled).toBe(false));
  const original = (await saved()).operation!.proof, read = vi.mocked(api.get).getMockImplementation()!;
  vi.mocked(api.get).mockImplementation(async (path, options) => { if (path.startsWith('/balances?')) throw new Error('stock refresh offline'); return read(path, options); });
  await click('ARCHIVE ACCEPTED SOURCE'); await until(() => expect(host.textContent).toContain('stock refresh offline'));
  expect((await saved()).operation?.proof).toEqual(original); expect((await saved()).archives).toHaveLength(0);
  expect(host.querySelector('[aria-label="Current selected kingdom Harvesters"]')).toBeNull(); expect(posts()).toHaveLength(1);
});

it('dark recovery discovery reads only saved history and needs no current Harvester capability', async () => {
  await act(async () => root.render(<HarvesterDoor />)); await act(async () => new Promise(resolve => setTimeout(resolve, 20)));
  expect(host.textContent).toBe(''); expect(api.get).not.toHaveBeenCalled();
  await act(async () => root.render(null)); const store = new HarvesterJournalStore(harvesterIdentity(identity.wallet));
  await store.compareAndSet(0, old => ({ ...old, operation: { command: start, attemptRevision: null, refusal: null, proof: null } })); await store.close();
  await act(async () => root.render(<HarvesterDoor />)); await until(() => expect(button('HARVESTER & SAVED RECEIPTS')).toBeDefined());
  expect(api.get).not.toHaveBeenCalled(); expect(posts()).toHaveLength(0);
});

it('game presentation keeps current stock and IDs collapsed while focusing explicit original review', async () => {
  await mount();
  expect(host.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('Realm Harvester');
  const current = host.querySelector('[aria-label="Current selected kingdom Harvesters"]')!;
  expect(current.querySelector('.sk-economy-hero')?.textContent).toContain('completed');
  expect(current.textContent).toContain('Frost Quartz');
  expect(host.querySelector('[aria-label="Current Harvester stock"]')?.closest('details')?.open).toBe(false);
  expect(host.querySelector('[aria-label="Completed Harvester"] details')?.hasAttribute('open')).toBe(false);
  await review();expect(document.activeElement).toBe(host.querySelector('[aria-label="Confirm Harvester selection"]'));
  expect(posts()).toHaveLength(0);
  const original=(await saved()).operation!.command;
  await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="Close Realm Harvester"]')!.click());
  await until(()=>expect(useApp.getState().screen).toBe('base'));
  expect((await saved()).operation!.command).toEqual(original);expect(posts()).toHaveLength(0);
});

it('expired recorded sources and accepted intervals without earning observations never display delivered or closed', async () => {
  currentView=view(head(id(20),true));await mount();
  const source=host.querySelector('[aria-label="Current wallet source"]')!;
  expect(source.textContent).toContain('Wallet source recorded');expect(source.textContent).toContain('until the server closes it');
  expect(source.textContent).not.toContain('Source closed');
  observation={events:0};await review();await click('CONFIRM SELECTION');
  await until(()=>expect(host.querySelector('[aria-label="Original earning result"]')?.textContent).toContain('No completed earning period'));
  expect(host.querySelector('[aria-label="Last observed earning period"]')).toBeNull();
  expect(host.querySelector('[aria-label="Original earning result"] h3')?.textContent).toBe('Source accepted · check earnings');
  expect(posts()).toHaveLength(1);
});

it('paused source reads keep recovery usable and focused server errors do not offer an earning action', async () => {
  await mount();await review();const read=vi.mocked(api.get).getMockImplementation()!;
  vi.mocked(api.get).mockImplementation(async(path,options)=>{if(path.startsWith('/harvesters?'))throw Error('Harvester source unavailable');return read(path,options);});
  await click('CONFIRM SELECTION');
  await until(()=>expect(host.querySelector('[role="alert"]')?.textContent).toContain('Harvester source unavailable'));
  expect(document.activeElement).toBe(host.querySelector('[role="alert"]'));
  expect(button('CHECK ORIGINAL RECEIPT')?.disabled).toBe(false);expect(button('CONFIRM SELECTION')).toBeUndefined();expect(posts()).toHaveLength(0);
});

// R0 changes the default build policy; these retained cases exercise the enabled interface.
import { beforeEach as beforeWebHoldCase, afterEach as afterWebHoldCase, vi as webHoldFixture } from 'vitest';
beforeWebHoldCase(() => { webHoldFixture.stubEnv('VITE_PHASE_E_WEB_ENABLED', '1'); });
afterWebHoldCase(() => { webHoldFixture.unstubAllEnvs(); });
