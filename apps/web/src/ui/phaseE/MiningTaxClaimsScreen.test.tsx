// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Buffer } from 'buffer';
import { MiningTaxClaimRecoveryEnvelopeSchema } from '@shardkeep/shared/miningTaxClaimRecoveryApi';
import fixtures from '../../../../../packages/shared/src/testFixtures/miningTaxClaimRecoveryApi.json';
import type { MiningTaxClaimState } from '../../lib/miningTaxClaims/controller';
import { useMiningTaxClaims } from '../../lib/miningTaxClaims/useMiningTaxClaims';
import { MiningTaxClaimsScreen } from './MiningTaxClaimsScreen';

vi.mock('../../lib/miningTaxClaims/useMiningTaxClaims', () => ({ useMiningTaxClaims: vi.fn() }));
let root: Root, host: HTMLDivElement, state: MiningTaxClaimState;
const commands = { begin: vi.fn(), review: vi.fn(), sign: vi.fn(), submit: vi.fn(), check: vi.fn(), archive: vi.fn(), archiveFailed:vi.fn(),prepareContinuation:vi.fn(),resumeContinuation:vi.fn(),activateContinuation:vi.fn() };
const dismiss = vi.fn(), openHistory = vi.fn();
const button = (text: string) => [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === text);
const click = async (text: string) => { expect(button(text)?.disabled).toBe(false); await act(async () => button(text)!.click()); };
function saved(kind: keyof typeof fixtures = 'combined') {
 const recovery = MiningTaxClaimRecoveryEnvelopeSchema.parse(structuredClone(fixtures[kind])), p = recovery.preparation!;
 const operation = { request: { idempotencyKey: p.idempotencyKey, round: p.round, spot: p.spot, caps: p.caps }, prepareAttempted: true, preparation: p,
  transactions: [], observed: [], unattributedObserved: false, setup: null, settlement: null };
 state.journal = { version: 1, revision: 1, identity: { origin: 'https://game.test', api: 'https://api.test', cluster: 'devnet', wallet: p.wallet }, operation };
 return { p, recovery, op: state.journal.operation! };
}
const render = async (allowed = true) => {
 vi.mocked(useMiningTaxClaims).mockReturnValue({ state, actionsAllowed: allowed, run: action => void action(commands as never), dismiss,
  held: ordinal => !!state.journal?.operation?.unattributedObserved || !!state.journal?.operation?.observed.some(o => o >= ordinal), history: null, historyError: null, openHistory });
 await act(async () => root.render(<MiningTaxClaimsScreen actionsEnabled={allowed} onClose={() => undefined} />));
};
beforeEach(() => {
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); for (const fn of [...Object.values(commands), dismiss, openHistory]) fn.mockReset();
 state = { loaded: true, busy: false, journal: null, review: null, settlementHeld: false, error: null };
 host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

it('requires explicit historical selection and all original SOL limits before preparing; rendering performs no effect', async () => {
 await render(); expect(button('PREPARE TAX CLAIM')?.disabled).toBe(true); expect(commands.begin).not.toHaveBeenCalled();
 for (const [label, value] of [['Historical round', '42'], ['Network fee limit (SOL)', '0.000000010'], ['Account rent limit (SOL)', '0.000001'], ['Total cost limit (SOL)', '0.00000101']]) {
  const input = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
 }
 await click('PREPARE TAX CLAIM');
 expect(commands.begin).toHaveBeenCalledExactlyOnceWith('42', 0, { maxFeeLamports: '10', maxRentLamports: '1000', maxTotalLamports: '1010' });
 expect(commands.sign).not.toHaveBeenCalled(); expect(commands.submit).not.toHaveBeenCalled();
});
it('renders immutable round, spot, quote and caps and separates review from wallet approval', async () => {
 const { p } = saved(); await render(); expect(host.textContent).toContain(`Round ${p.round} · Spot ${p.spot + 1}`);
 expect(host.textContent).toContain('Original total cost limit: 0.00000101 SOL'); expect(host.textContent).toContain('Original network fee estimate: 0.000000005 SOL');
 await click('REVIEW TAX PACKET'); expect(commands.review).toHaveBeenCalledExactlyOnceWith(0); expect(button('APPROVE IN WALLET')).toBeUndefined();
 state.review = { preparation: p, ordinal: 0, current: { review: { feeLamports: '6', rentLamports: '200', paidFeeLamports: '0', paidRentLamports: '0' } } as never };
 await render(); expect(host.textContent).toContain('Current packet fee estimate: 0.000000006 SOL'); await click('APPROVE IN WALLET');
 expect(commands.sign).toHaveBeenCalledOnce(); expect(commands.submit).not.toHaveBeenCalled();
});
it('keeps verified setup nonterminal and requires separate ordinal1 review and submission', async () => {
 const { recovery, op } = saved('split'); op.setup = MiningTaxClaimRecoveryEnvelopeSchema.parse(fixtures.setup); op.observed = [0]; state.settlementHeld = true;
 op.transactions = recovery.wires.map(w => ({ ordinal: w.ordinal, signingStarted: true, submitAttempted: w.ordinal === 0,
  signed: { ordinal: w.ordinal, wire: Buffer.from(w.signedTransactionHex, 'hex').toString('base64'), signature: w.signature, messageSha256: w.messageSha256, wireSha256: w.wireSha256 } }));
 op.transactions.pop(); await render(); expect(host.textContent).toContain('SETUP RECEIPT VERIFIED'); expect(host.textContent).toContain('No KEEP payment is confirmed by setup.');
 expect(host.textContent).toContain('Actual setup network fee:'); expect(button('ARCHIVE VERIFIED TAX PAYMENT')).toBeUndefined();
 await click('REVIEW TAX PACKET'); expect(commands.review).toHaveBeenCalledExactlyOnceWith(1);
 const w = recovery.wires[1]!; op.transactions.push({ ordinal: 1, signingStarted: true, submitAttempted: false, signed: { ordinal: 1, wire: Buffer.from(w.signedTransactionHex, 'hex').toString('base64'), signature: w.signature, messageSha256: w.messageSha256, wireSha256: w.wireSha256 } });
 await render(); await click('SUBMIT SAVED TAX PACKET'); expect(commands.submit).toHaveBeenCalledExactlyOnceWith(1);
});
it.each(['unknown', 'wallet uncertainty', 'submit uncertainty', 'positive hold'])('offers GET-only recovery for %s without a retry or archive shortcut', async mode => {
 const { op, recovery } = saved();
 if (mode === 'unknown') op.preparation = null;
 else if (mode === 'positive hold') { op.unattributedObserved = true; state.settlementHeld = true; }
 else { const w = recovery.wires[0]!; op.transactions = [{ ordinal: 0, signingStarted: true, submitAttempted: mode === 'submit uncertainty', signed: mode === 'wallet uncertainty' ? null : { ordinal: 0, wire: Buffer.from(w.signedTransactionHex, 'hex').toString('base64'), signature: w.signature, messageSha256: w.messageSha256, wireSha256: w.wireSha256 } }]; }
 await render(false); expect(button('REVIEW TAX PACKET')).toBeUndefined(); expect(button('APPROVE IN WALLET')).toBeUndefined(); expect(button('SUBMIT SAVED TAX PACKET')).toBeUndefined(); expect(button('ARCHIVE VERIFIED TAX PAYMENT')).toBeUndefined();
 await click('CHECK ORIGINAL TAX CLAIM'); expect(commands.check).toHaveBeenCalledOnce(); expect(commands.begin).not.toHaveBeenCalled();
});
it('archives only a bound complete payment while paused and exposes history explicitly', async () => {
 const { op, recovery } = saved('aboveQuote'); op.settlement = recovery;
 await render(false); expect(host.textContent).toContain('TAX PAYMENT RECEIPT VERIFIED'); expect(host.textContent).toContain('attested by the game server');
 expect(host.textContent).toContain('Actual network fee: 0.000000006 SOL'); await click('ARCHIVE VERIFIED TAX PAYMENT'); expect(commands.archive).toHaveBeenCalledOnce();
 state.journal!.operation = null; state.journal!.lastArchivedKey = recovery.idempotencyKey; await render(false);
 await click('OPEN TAX CLAIM HISTORY'); expect(openHistory).toHaveBeenCalledExactlyOnceWith(recovery.idempotencyKey);
});
it.each([false,true])('shows failed packet costs and offers explicit archival only for complete outcomes: %s',async complete=>{
 const {op,recovery}=saved('split');if(complete)op.setup=MiningTaxClaimRecoveryEnvelopeSchema.parse(fixtures.setup);
 op.failure={recovery,failures:[{ordinal:1,receipt:{feeLamports:'6'}}]} as never;op.observed=[1];await render(false);
 expect(host.textContent).toContain('PACKET 2 FAILED');expect(host.textContent).toContain('0 KEEP paid');expect(host.textContent).toContain('0.000000006 SOL');
 expect(button('REVIEW TAX PACKET')).toBeUndefined();expect(button('APPROVE IN WALLET')).toBeUndefined();expect(button('ARCHIVE VERIFIED TAX PAYMENT')).toBeUndefined();
 expect(commands.archiveFailed).not.toHaveBeenCalled();
 if(complete){expect(host.textContent).toContain('Actual setup account rent:');await click('ARCHIVE FAILED TAX CLAIM');expect(commands.archiveFailed).toHaveBeenCalledOnce();}
 else expect(button('ARCHIVE FAILED TAX CLAIM')).toBeUndefined();
});

it('asks for separate additional caps before requesting fresh split consent; rendering does not POST',async()=>{
 const {op}=saved('split');op.setup=MiningTaxClaimRecoveryEnvelopeSchema.parse(fixtures.setup);op.observed=[0];await render();expect(button('PREPARE FRESH CLAIM')?.disabled).toBe(true);expect(commands.prepareContinuation).not.toHaveBeenCalled();
 for(const [label,value] of [['Additional network fee limit (SOL)','0.00000001'],['Additional account rent limit (SOL)','0.000001'],['Additional total cost limit (SOL)','0.00000101']]){const input=host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;expect(input).not.toBeNull();await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));});}
 await click('PREPARE FRESH CLAIM');expect(commands.prepareContinuation).toHaveBeenCalledExactlyOnceWith({maxFeeLamports:'10',maxRentLamports:'1000',maxTotalLamports:'1010'});expect(commands.sign).not.toHaveBeenCalled();
});
it.each([false,true])('shows saved additional consent with explicit resume or adoption only, bound=%s',async bound=>{
 const {default:data}=await import('../../../../../packages/shared/src/testFixtures/miningTaxClaimContinuationApi.json'),{op}=saved('split');op.setup=MiningTaxClaimRecoveryEnvelopeSchema.parse(fixtures.setup);op.observed=[0];op.continuation={request:{idempotencyKey:data.continuation.childPreparation.idempotencyKey,caps:data.continuation.childPreparation.caps},attempted:true,envelope:bound?data as never:null};op.continuationObserved=bound;await render();
 expect(button('REVIEW TAX PACKET')).toBeUndefined();expect(button('PREPARE FRESH CLAIM')).toBeUndefined();expect(button('APPROVE IN WALLET')).toBeUndefined();expect(host.textContent).toContain('Additional total cost limit:');expect(host.textContent).toContain('Actual setup network fee:');
 if(bound){await render(false);await click('USE PREPARED CLAIM');expect(commands.activateContinuation).toHaveBeenCalledOnce();expect(button('RESUME SAVED PREPARATION')).toBeUndefined();}else{await click('RESUME SAVED PREPARATION');expect(commands.resumeContinuation).toHaveBeenCalledOnce();expect(button('USE PREPARED CLAIM')).toBeUndefined();}expect(commands.sign).not.toHaveBeenCalled();expect(commands.submit).not.toHaveBeenCalled();
});

it('holds paid archival when a contradictory continuation has been observed',async()=>{
 const {op,recovery}=saved('combined');op.settlement=recovery;op.continuationObserved=true;await render(false);expect(button('ARCHIVE VERIFIED TAX PAYMENT')).toBeUndefined();expect(button('CHECK ORIGINAL TAX CLAIM')).toBeDefined();
});

it('focuses the review and keeps its exact original amount and total limit beside wallet approval',async()=>{
 const {p}=saved();state.review={preparation:p,ordinal:0,current:{review:{feeLamports:'6',rentLamports:'200',paidFeeLamports:'0',paidRentLamports:'0'}} as never};await render();
 const review=host.querySelector<HTMLElement>('[aria-label="Review original tax packet"]')!;expect(document.activeElement).toBe(review);
 expect(review.textContent).toContain('Original KEEP claim:');expect(review.textContent).toContain('Original total cost limit: 0.00000101 SOL');expect(review.textContent).toContain('does not submit it');
 expect(host.querySelector('details[open]')?.textContent).toContain('Original consent expires:');expect(host.querySelector('details[open]')?.textContent).not.toContain(p.expiresAt);
 expect(commands.sign).not.toHaveBeenCalled();expect(commands.submit).not.toHaveBeenCalled();
});
it('keeps original signatures collapsed and distinguishes setup costs from verified KEEP received',async()=>{
 const {op,recovery}=saved('split');op.setup=MiningTaxClaimRecoveryEnvelopeSchema.parse(fixtures.setup);op.transactions=recovery.wires.map(w=>({ordinal:w.ordinal,signingStarted:true,submitAttempted:true,signed:{ordinal:w.ordinal,wire:Buffer.from(w.signedTransactionHex,'hex').toString('base64'),signature:w.signature,messageSha256:w.messageSha256,wireSha256:w.wireSha256}}));await render(false);
 const records=[...host.querySelectorAll('details')].find(d=>d.querySelector('summary')?.textContent==='Original transaction records')!;expect(records.open).toBe(false);expect(records.textContent).toContain(recovery.wires[0]!.signature);
 expect(host.textContent).not.toContain('ACTUAL KEEP RECEIVED');expect(host.textContent).toContain('No KEEP payment is confirmed by setup.');expect(commands.sign).not.toHaveBeenCalled();
});
it('focuses an unavailable error while keeping historical recovery controls accessible',async()=>{
 saved();state.error='Original claim could not be checked.';await render(false);expect(document.activeElement).toBe(host.querySelector('[role="alert"]'));await click('CHECK ORIGINAL TAX CLAIM');expect(commands.check).toHaveBeenCalledOnce();expect(commands.begin).not.toHaveBeenCalled();
});
