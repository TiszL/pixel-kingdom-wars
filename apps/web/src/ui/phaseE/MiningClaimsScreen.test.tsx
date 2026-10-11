// @vitest-environment happy-dom
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PublicKey, Transaction } from '@solana/web3.js';
import { buildMiningClaimMessages } from '../../../../../packages/chain/src/miningClaimMessage';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api } from '../../lib/api';
import { authCookies } from '../../auth/authCookieCoordinator';
import { useApp } from '../../state/store';
import { MiningClaimJournalStore, type MiningClaimOperation } from '../../lib/miningClaims/journal';
import { miningClaimIdentity } from '../../lib/miningClaims/browser';
import { miningClaimFixture } from '../../lib/miningClaims/fixtures.test-support';
import { prepareMiningClaimOriginal, claimMiningOriginal, submitMiningOriginal } from '../../lib/miningClaims/transport';
import { MiningClaimsScreen } from './MiningClaimsScreen';
import { MiningClaimsEntry } from './MiningClaimsEntry';

const mocks = vi.hoisted(() => ({ connection: { getGenesisHash: vi.fn(), getBlockHeight: vi.fn() }, wallet: { publicKey: null as unknown, signTransaction: vi.fn() } }));
vi.mock('@solana/wallet-adapter-react', () => ({ useConnection: () => ({ connection: mocks.connection }) }));
vi.mock('../../auth/useGameWallet', () => ({ useGameWallet: () => mocks.wallet }));
vi.mock('../../lib/miningClaims/transport', () => ({ prepareMiningClaimOriginal: vi.fn(), claimMiningOriginal: vi.fn(), submitMiningOriginal: vi.fn() }));
let host: HTMLDivElement, root: Root, fixture: ReturnType<typeof miningClaimFixture>, finalized: boolean, available: boolean;
const button = (label: string) => [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === label);
const until = (check: () => void) => vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); check(); });
const click = async (label: string) => { expect(button(label)?.disabled).toBe(false); await act(async () => button(label)!.click()); };
const saved = async () => { const store = new MiningClaimJournalStore(miningClaimIdentity(fixture.identity.wallet)); try { return await store.read(); } finally { await store.close(); } };
const posts = () => vi.mocked(prepareMiningClaimOriginal).mock.calls.filter(([v]) => v.method === 'POST');
const draft = (): MiningClaimOperation => ({ request: { idempotencyKey: fixture.preparation.idempotencyKey }, prepareAttempted: false, prepareRefusal: null,
  refusalConfirmedAbsent: false, preparation: null, signingStarted: false, signed: null, submitAttempted: false, claim: null });
async function seedSigned() {
  const store = new MiningClaimJournalStore(miningClaimIdentity(fixture.identity.wallet)); let j = await store.compareAndSet(0, row => ({ ...row, operation: draft() }));
  for (const delta of [{ prepareAttempted: true }, { preparation: fixture.preparation }, { signingStarted: true }, { signed: fixture.signed() }])
    j = await store.compareAndSet(j.revision, row => ({ ...row, operation: { ...row.operation!, ...delta } }));
  await store.close();
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('indexedDB', new IDBFactory());
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  const held = new Set<string>(); Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: async (name: string, _options: unknown, run: (lock: object | null) => Promise<unknown>) => {
    if (held.has(name)) return run(null); held.add(name); try { return await run({}); } finally { held.delete(name); }
  } } });
  vi.spyOn(authCookies, 'assertSession').mockReturnValue('session'); vi.spyOn(authCookies, 'assertResponse').mockImplementation(() => undefined);
  fixture = miningClaimFixture(); finalized = false; available = true;
  mocks.wallet.publicKey = fixture.signer.publicKey; mocks.wallet.signTransaction.mockReset().mockImplementation(async (tx: Transaction) => { tx.partialSign(fixture.signer); return tx; });
  mocks.connection.getGenesisHash.mockReset().mockResolvedValue(fixture.trust.genesisHash); mocks.connection.getBlockHeight.mockReset().mockResolvedValue(240);
  useApp.getState().setAuth(fixture.identity.wallet, true); useApp.getState().setScreen('bases');
  vi.spyOn(api, 'get').mockImplementation(async () => available ? fixture.status() as never : { ...fixture.status(), state: 'unavailable', preparationAllowed: false,
    reason: 'Claims unavailable', rootSequence: null, cumulativeKeepBaseUnits: null, claimedBaseUnits: null, claimableBaseUnits: null,
    observedSlot: null, chainUnixTimestamp: null, claimableAfterUnixTimestamp: null, needsAta: null, needsMinerRecords: null } as never);
  vi.mocked(prepareMiningClaimOriginal).mockReset().mockImplementation(async input => {
    input.isCurrent();
    if (input.method === 'POST') { expect((await saved()).operation?.prepareAttempted).toBe(true); fixture.preparation.idempotencyKey = input.request.idempotencyKey; await input.retain(fixture.preparation); return fixture.preparation; }
    const result = { wallet: fixture.identity.wallet, idempotencyKey: input.request.idempotencyKey, status: 'prepared', receipt: fixture.preparation, serverNow: fixture.preparation.serverNow };
    await input.retain(result); input.isCurrent(); return result;
  });
  vi.mocked(claimMiningOriginal).mockReset().mockImplementation(async input => { const result = fixture.claim(finalized ? 'settled' : 'prepared'); await input.retain(result); input.isCurrent(); return result; });
  vi.mocked(submitMiningOriginal).mockReset().mockImplementation(async input => { expect((await saved()).operation?.submitAttempted).toBe(true); return { signature: fixture.signed().signature, claimId: input.request.claimId, serverNow: fixture.preparation.serverNow, delivery: 'held' }; });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); Reflect.deleteProperty(document, 'visibilityState'); Reflect.deleteProperty(navigator, 'locks'); useApp.getState().setAuth(null); });

it('StrictMode and foreground only GET; explicit fee review, wallet approval, one submit and final receipt stay distinct', async () => {
  await act(async () => root.render(<StrictMode><MiningClaimsScreen actionsEnabled trust={fixture.trust} onClose={() => undefined} /></StrictMode>));
  await until(() => expect(button('ESTIMATE FEES')?.disabled).toBe(false)); await act(async () => window.dispatchEvent(new Event('focus')));
  await until(() => expect(button('ESTIMATE FEES')?.disabled).toBe(false)); expect(posts()).toHaveLength(0); expect(mocks.wallet.signTransaction).not.toHaveBeenCalled();
  await click('ESTIMATE FEES'); await until(() => expect(button('REVIEW CLAIM')?.disabled).toBe(false)); expect(posts()).toHaveLength(1); expect(button('APPROVE IN WALLET')).toBeUndefined();
  await click('REVIEW CLAIM'); await until(() => expect(button('APPROVE IN WALLET')?.disabled).toBe(false));
  const review=host.querySelector('[aria-label="Approve reviewed claim"]')!;expect(review.querySelector('.sk-economy-hero strong')?.textContent).toBe('0.000015 SOL');for(const [label,value]of [['Network fee estimate','0.000005 SOL'],['Account rent estimate','0.00001 SOL']])expect([...review.querySelectorAll('dt')].find(n=>n.textContent===label)?.nextElementSibling?.textContent).toBe(value);
  expect(host.textContent).toContain('0.00000008 KEEP'); await click('APPROVE IN WALLET'); await until(() => expect(button('SUBMIT SAVED CLAIM')?.disabled).toBe(false));
  expect(mocks.wallet.signTransaction).toHaveBeenCalledTimes(1); expect(host.textContent).not.toContain('PAYMENT FINALIZED');
  await click('SUBMIT SAVED CLAIM'); await until(() => expect(button('CHECK CLAIM')?.disabled).toBe(false)); expect(vi.mocked(submitMiningOriginal)).toHaveBeenCalledTimes(1); expect(button('SUBMIT SAVED CLAIM')).toBeUndefined();
  finalized = true; await click('CHECK CLAIM'); await until(() => expect(host.textContent).toContain('PAYMENT FINALIZED'));
  await click('DONE'); await until(() => expect(host.textContent).toContain('Claim history')); expect((await saved()).archives).toHaveLength(1); expect(host.textContent).toContain(fixture.signed().signature);
});

it('paused discovery stays hidden without history, but null-trust saved recovery remains visible and GET-only', async () => {
  available = false; await act(async () => root.render(<MiningClaimsEntry actionsEnabled={false} />)); await until(() => expect(vi.mocked(api.get)).toHaveBeenCalled()); expect(host.querySelector('button')).toBeNull();
  await seedSigned(); await act(async () => root.render(<MiningClaimsEntry key="reopen" actionsEnabled={false} />));
  await until(() => expect(button('MINING CLAIMS & HISTORY')).toBeDefined()); await click('MINING CLAIMS & HISTORY');
  await until(() => expect(button('CHECK CLAIM')?.disabled).toBe(false)); expect(button('SUBMIT SAVED CLAIM')?.disabled).toBe(true);
  await click('CHECK CLAIM'); expect(posts()).toHaveLength(0); expect(mocks.wallet.signTransaction).not.toHaveBeenCalled(); expect(vi.mocked(submitMiningOriginal)).not.toHaveBeenCalled();
});

it('known status exposes discovery, but absent trusted configuration never enables a new action', async () => {
  await act(async () => root.render(<MiningClaimsEntry actionsEnabled />)); await until(() => expect(button('MINING CLAIMS')).toBeDefined()); await click('MINING CLAIMS');
  await until(() => expect(button('ESTIMATE FEES')).toBeDefined()); expect(button('ESTIMATE FEES')?.disabled).toBe(true); expect(host.textContent).toContain('Saved claims can still be checked'); expect(posts()).toHaveLength(0);
});

it('failed receipt stays recoverable with null trust and archives only after an explicit fresh check without retrying', async () => {
  await seedSigned();
  vi.mocked(claimMiningOriginal).mockImplementation(async input => { const result=fixture.claim('failed');await input.retain(result);input.isCurrent();return result; });
  await act(async()=>root.render(<MiningClaimsScreen actionsEnabled={false} onClose={()=>undefined}/>));
  await until(()=>expect(button('CHECK & ARCHIVE FAILED CLAIM')?.disabled).toBe(false));
  expect(host.textContent).toContain('CLAIM FAILED');expect(host.textContent).toContain('No KEEP was paid by this transaction');expect(host.textContent).toContain('network fee may apply');
  expect(host.textContent).not.toContain('PAYMENT FINALIZED');expect(button('SUBMIT SAVED CLAIM')).toBeUndefined();expect(button('REVIEW CLAIM')).toBeUndefined();expect(button('APPROVE IN WALLET')).toBeUndefined();
  const reads=vi.mocked(claimMiningOriginal).mock.calls.length;await click('CHECK & ARCHIVE FAILED CLAIM');await until(()=>expect(host.textContent).toContain('Claim history (1)'));
  expect(vi.mocked(claimMiningOriginal)).toHaveBeenCalledTimes(reads+1);expect((await saved()).archives[0]?.signed).toEqual(fixture.signed());
  expect(host.textContent).toContain('CLAIM FAILED');expect(button('ESTIMATE FEES')?.disabled).toBe(true);
  expect(posts()).toHaveLength(0);expect(mocks.wallet.signTransaction).not.toHaveBeenCalled();expect(vi.mocked(submitMiningOriginal)).not.toHaveBeenCalled();
});

it('base selection changes do not replace a wallet claim or require another fee request', async () => {
  await act(async () => root.render(<MiningClaimsScreen actionsEnabled trust={fixture.trust} onClose={() => undefined} />)); await until(() => expect(button('ESTIMATE FEES')?.disabled).toBe(false));
  await click('ESTIMATE FEES'); await until(() => expect(button('REVIEW CLAIM')?.disabled).toBe(false)); const key = (await saved()).operation!.request.idempotencyKey;
  await act(async () => useApp.getState().setSelectedBaseId(crypto.randomUUID(), false)); expect((await saved()).operation!.request.idempotencyKey).toBe(key); expect(posts()).toHaveLength(1);
});

it('keeps the original store open for a valid late wallet signature after the screen closes', async () => {
  let finish!: () => void; mocks.wallet.signTransaction.mockImplementation((tx: Transaction) => new Promise(resolve => { finish = () => { tx.partialSign(fixture.signer); resolve(tx); }; }));
  await act(async () => root.render(<MiningClaimsScreen actionsEnabled trust={fixture.trust} onClose={() => undefined} />)); await until(() => expect(button('ESTIMATE FEES')?.disabled).toBe(false));
  await click('ESTIMATE FEES'); await until(() => expect(button('REVIEW CLAIM')?.disabled).toBe(false)); await click('REVIEW CLAIM'); await until(() => expect(button('APPROVE IN WALLET')?.disabled).toBe(false)); await click('APPROVE IN WALLET');
  await until(() => expect(mocks.wallet.signTransaction).toHaveBeenCalledTimes(1)); await act(async () => root.render(null)); await act(async () => finish());
  await vi.waitFor(async () => expect((await saved()).operation?.signed?.signature).toBe(fixture.signed().signature)); expect(vi.mocked(submitMiningOriginal)).not.toHaveBeenCalled();
});

it('a visibility roundtrip queues a fresh GET after the obsolete read drains instead of leaving busy stuck', async () => {
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  vi.mocked(api.get).mockImplementationOnce(async () => { await blocked; return fixture.status() as never; });
  await act(async () => root.render(<MiningClaimsScreen actionsEnabled trust={fixture.trust} onClose={() => undefined} />));
  await until(() => expect(vi.mocked(api.get)).toHaveBeenCalled());
  await act(async () => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
  await act(async () => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); document.dispatchEvent(new Event('visibilitychange')); });
  await act(async () => release()); await until(() => expect(button('ESTIMATE FEES')?.disabled).toBe(false));
  expect(vi.mocked(api.get).mock.calls.length).toBeGreaterThan(1); expect(posts()).toHaveLength(0); expect(mocks.wallet.signTransaction).not.toHaveBeenCalled();
});

it('storage failure exposes the recovery entry and error, without inventing a zero balance or starting a POST', async () => {
  available = false; vi.stubGlobal('indexedDB', undefined);
  await act(async () => root.render(<MiningClaimsEntry actionsEnabled />)); await until(() => expect(button('MINING CLAIMS & HISTORY')).toBeDefined());
  await click('MINING CLAIMS & HISTORY'); await until(() => expect(host.querySelector('[role="alert"]')?.textContent).toContain('Durable browser storage is unavailable'));
  expect(host.querySelector('[aria-label="Current mining allocation"] strong')?.textContent).toBe('Unavailable'); expect(posts()).toHaveLength(0); expect(mocks.wallet.signTransaction).not.toHaveBeenCalled();
});


it('wallet cancellation requires explicit fresh review before approving the same original message', async () => {
  const messages: string[] = [];
  mocks.wallet.signTransaction.mockImplementationOnce(async (tx: Transaction) => {
    messages.push(tx.serializeMessage().toString('base64')); throw Error('Wallet approval cancelled');
  }).mockImplementationOnce(async (tx: Transaction) => {
    messages.push(tx.serializeMessage().toString('base64')); tx.partialSign(fixture.signer); return tx;
  });
  await act(async () => root.render(<MiningClaimsScreen actionsEnabled trust={fixture.trust} onClose={() => undefined} />));
  await until(() => expect(button('ESTIMATE FEES')?.disabled).toBe(false)); await click('ESTIMATE FEES');
  await until(() => expect(button('REVIEW CLAIM')?.disabled).toBe(false)); await click('REVIEW CLAIM');
  await until(() => expect(button('APPROVE IN WALLET')?.disabled).toBe(false)); await click('APPROVE IN WALLET');
  await until(() => expect(host.textContent).toContain('Wallet approval cancelled'));
  expect((await saved()).operation?.signingStarted).toBe(true); expect((await saved()).operation?.signed).toBeNull();
  expect(button('APPROVE IN WALLET')).toBeUndefined(); expect(mocks.wallet.signTransaction).toHaveBeenCalledTimes(1);
  expect(posts()).toHaveLength(1); expect(vi.mocked(submitMiningOriginal)).not.toHaveBeenCalled();
  await click('REVIEW CLAIM'); await until(() => expect(button('APPROVE IN WALLET')?.disabled).toBe(false));
  await click('APPROVE IN WALLET'); await until(() => expect(button('SUBMIT SAVED CLAIM')?.disabled).toBe(false));
  expect(messages).toEqual([fixture.preparation.transactions[0]!.message, fixture.preparation.transactions[0]!.message]);
  expect((await saved()).operation?.signed?.signature).toBe(fixture.signed().signature);
  expect(mocks.wallet.signTransaction).toHaveBeenCalledTimes(2); expect(posts()).toHaveLength(1);
  expect(vi.mocked(submitMiningOriginal)).not.toHaveBeenCalled();
});

it('separates prior claims, saved cumulative entitlement and the actual smaller finalized payment',async()=>{
 // An existing miner can have earlier paid KEEP; a newly opened miner record cannot.
 const p=fixture.preparation;p.needsMinerRecords=false;
 const plan=buildMiningClaimMessages({programId:new PublicKey(p.identity.programId),keepMint:new PublicKey(p.identity.keepMint),reserveOwner:new PublicKey(p.identity.reserveOwner)},
  {wallet:fixture.signer.publicKey,root:Buffer.from(p.root,'hex'),sequence:BigInt(p.rootSequence),day:BigInt(p.day),totalCumulative:BigInt(p.totalCumulativeBaseUnits),
   leaf:{wallet:p.wallet,sequence:BigInt(p.rootSequence),cumulativeKeep:BigInt(p.leaf.cumulativeKeepBaseUnits),cumulativeRenown:BigInt(p.leaf.cumulativeRenown),cumulativeDays:BigInt(p.leaf.cumulativeDays)},proof:[],
   blockhash:p.transactions[0]!.blockhash,needsAta:p.needsAta,needsMinerRecords:false});
 p.transactions[0]!.message=Buffer.from(plan.transactions[0]!.messageBytes).toString('base64');
 vi.mocked(api.get).mockImplementation(async()=>({...fixture.status(),claimedBaseUnits:'30',claimableBaseUnits:'50'}) as never);
 vi.mocked(claimMiningOriginal).mockImplementation(async input=>{const result=fixture.claim(finalized?'settled':'prepared');if(finalized){result.settledBaseUnits='50';result.transactions[0]!.settledBaseUnits='50';}await input.retain(result);input.isCurrent();return result;});
 const focus=vi.spyOn(HTMLElement.prototype,'focus');
 await act(async()=>root.render(<MiningClaimsScreen actionsEnabled trust={fixture.trust} onClose={()=>undefined}/>));await until(()=>expect(button('ESTIMATE FEES')?.disabled).toBe(false));
 const allocation=host.querySelector('[aria-label="Current mining allocation"]')!;expect(allocation.querySelector('strong')?.textContent).toBe('0.00000005 KEEP');expect(allocation.querySelector('details')?.open).toBe(false);expect(allocation.textContent).toContain('Already claimed: 0.00000003 KEEP');
 await click('ESTIMATE FEES');await until(()=>expect(button('REVIEW CLAIM')?.disabled).toBe(false));expect([...host.querySelectorAll('details')].find(d=>d.querySelector('summary')?.textContent==='Original fees and cumulative entitlement')?.open).toBe(false);
 await click('REVIEW CLAIM');await until(()=>expect(button('APPROVE IN WALLET')?.disabled).toBe(false));const review=host.querySelector('[aria-label="Approve reviewed claim"]')!;
 expect(document.activeElement).toBe(review);expect(focus).toHaveBeenCalledWith({preventScroll:true});expect(review.textContent).toContain('Saved cumulative entitlement: 0.00000008 KEEP');expect(review.textContent).toContain('it is not the amount this transaction will pay');
 expect(review.querySelector('.sk-economy-hero strong')?.textContent).toBe('0.000015 SOL');expect(review.querySelector('details')?.open).toBe(false);expect(review.querySelector('details')?.textContent).toContain(fixture.identity.wallet);
 expect([...review.querySelectorAll('p')].find(p=>p.textContent?.startsWith('Estimate expires:'))?.textContent).not.toContain(fixture.preparation.expiresAt);
 expect(host.querySelector('[aria-label="Actual mining payment"]')).toBeNull();expect(mocks.wallet.signTransaction).not.toHaveBeenCalled();
 await click('APPROVE IN WALLET');await until(()=>expect(button('SUBMIT SAVED CLAIM')?.disabled).toBe(false));await click('SUBMIT SAVED CLAIM');await until(()=>expect(button('CHECK CLAIM')?.disabled).toBe(false));finalized=true;
 await click('CHECK CLAIM');await until(()=>expect(host.querySelector('[aria-label="Actual mining payment"] strong')?.textContent).toBe('0.00000005 KEEP'));
 expect(host.querySelector('[aria-label="Actual mining payment"]')?.textContent).not.toContain('0.00000008');expect([...host.querySelectorAll('details')].find(d=>d.querySelector('summary')?.textContent==='Original transaction records')?.open).toBe(false);
 expect(mocks.wallet.signTransaction).toHaveBeenCalledOnce();expect(submitMiningOriginal).toHaveBeenCalledOnce();
});
it.each([
 ['delayed','Your allocation is waiting for its claim window.'],['paused','New claims are paused.'],['claimed','The observed cumulative allocation has already been claimed.'],
] as const)('keeps the observed %s amount distinct from permission to start a claim',async(state,message)=>{
 vi.mocked(api.get).mockImplementation(async()=>({...fixture.status(),state,preparationAllowed:false,claimedBaseUnits:state==='claimed'?'80':'30',claimableBaseUnits:state==='claimed'?'0':'50',chainUnixTimestamp:state==='delayed'?'7199':'7201'}) as never);
 await act(async()=>root.render(<MiningClaimsScreen actionsEnabled trust={fixture.trust} onClose={()=>undefined}/>));await until(()=>expect(host.textContent).toContain(message));
 expect(host.querySelector('[aria-label="Current mining allocation"] strong')?.textContent).toBe(state==='claimed'?'0 KEEP':'0.00000005 KEEP');expect(host.textContent).toContain('UNCLAIMED KEEP');expect(host.textContent).not.toContain('AVAILABLE TO CLAIM');
 expect(button('ESTIMATE FEES')?.disabled).toBe(true);expect(host.querySelector('[aria-label="Actual mining payment"]')).toBeNull();expect(posts()).toHaveLength(0);expect(mocks.wallet.signTransaction).not.toHaveBeenCalled();
});

// R0 changes the default build policy; these retained cases exercise the enabled interface.
import { beforeEach as beforeWebHoldCase, afterEach as afterWebHoldCase, vi as webHoldFixture } from 'vitest';
beforeWebHoldCase(() => { webHoldFixture.stubEnv('VITE_PHASE_E_WEB_ENABLED', '1'); });
afterWebHoldCase(() => { webHoldFixture.unstubAllEnvs(); });
