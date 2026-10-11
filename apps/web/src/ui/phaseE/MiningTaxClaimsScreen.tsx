import { useEffect, useRef, useState } from 'react';
import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import { PHASE_E_POLICY, TOKEN } from '@shardkeep/shared';
import { MiningTaxClaimPrepareRequestSchema } from '@shardkeep/shared/miningTaxClaimsApi';
import { useMiningTaxClaims } from '../../lib/miningTaxClaims/useMiningTaxClaims';
import { hasCompleteMiningTaxFailure, hasCompleteMiningTaxContinuation, type MiningTaxClaimOperation } from '../../lib/miningTaxClaims/journal';
import type { MiningTaxClaimSigningTrust } from '../../lib/miningTaxClaims/signing';
import { explorerUrl } from '../../lib/cluster';
import { Btn, COLORS as C } from '../primitives';
import { EconomyPanel } from './EconomyPanel';

const controls = { minHeight: 44, width: '100%' };
const inputStyle = {...controls, background:C.surface, color:C.text, border:`2px solid ${C.borderLt}`, padding:'6px 8px', marginBottom:8};
const capLabels = { maxFeeLamports: 'Network fee limit (SOL)', maxRentLamports: 'Account rent limit (SOL)', maxTotalLamports: 'Total cost limit (SOL)' };
type Caps = Record<keyof typeof capLabels, string>;
function units(value: string, scale: bigint): string {
 const n = BigInt(value), fraction = (n % scale).toString().padStart(scale.toString().length - 1, '0').replace(/0+$/, '');
 return `${n / scale}${fraction ? `.${fraction}` : ''}`;
}
const sol = (value: string) => units(value, BigInt(LAMPORTS_PER_SOL));
const keep = (value: string) => units(value, 10n ** BigInt(TOKEN.decimals));
const time = (iso: string) => new Date(iso).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
function lamports(value: string): string | null {
 const digits = String(LAMPORTS_PER_SOL).length - 1;
 if (value.length > 30 || !new RegExp(`^(0|[1-9][0-9]*)(?:\\.[0-9]{1,${digits}})?$`).test(value)) return null;
 const [whole, fraction = ''] = value.split('.');
 return (BigInt(whole!) * BigInt(LAMPORTS_PER_SOL) + BigInt(fraction.padEnd(digits, '0'))).toString();
}
function Receipt({ operation: op }: { operation: MiningTaxClaimOperation }) {
 const setup = op.setup?.settlement?.receipt, paid = op.settlement?.settlement?.receipt;
 return <>
  {setup && <section aria-label="Verified original setup"><strong>SETUP RECEIPT VERIFIED</strong><p>No KEEP payment is confirmed by setup. {paid ? 'The KEEP payment is verified separately below.' : op.failure || op.continuation ? 'These setup costs remain in your claim history.' : 'The claim needs its own review, wallet approval and submission.'}</p>
   <p>Actual setup network fee: {sol(setup.feeLamports)} SOL</p><p>Actual setup account rent: {sol(setup.rentLamports)} SOL</p></section>}
  {paid && <section aria-label="Verified tax payment"><strong>TAX PAYMENT RECEIPT VERIFIED</strong><div className="sk-economy-hero"><div><span>ACTUAL KEEP RECEIVED</span><strong>{keep(paid.paidKeepBaseUnits)} KEEP</strong><span>From this verified claim</span></div></div><p>{keep(paid.paidKeepBaseUnits)} KEEP paid. This historical receipt is attested by the game server and bound to the original signed packets.</p>
   <p>Actual network fee: {sol(paid.feeLamports)} SOL</p><p>Actual account rent: {sol(paid.rentLamports)} SOL</p></section>}
  {op.continuation?.envelope && <section aria-label="Continued tax claim"><strong>FRESH CONSENT PREPARED</strong><p>The linked claim retires the unsigned remainder and keeps this setup history. No KEEP payment or refund is recorded here.</p><details><summary>Linked claim reference</summary><p>{op.continuation.request.idempotencyKey}</p></details></section>}
  {op.failure?.failures.map(f => <section key={f.ordinal} aria-label={`Failed tax packet ${f.ordinal + 1}`}><strong>PACKET {f.ordinal + 1} FAILED</strong>
   <p>0 KEEP paid by this packet. Its network fee was charged; no refund or replacement is created.</p><p>Actual failed packet network fee: {sol(f.receipt.feeLamports)} SOL</p>
   <p>This historical outcome is attested by the game server and bound to your saved signed packet.</p></section>)}
  {op.transactions.some(t => t.signed) && <details><summary>Original transaction records</summary>{op.transactions.filter(t => t.signed).map(t => <p key={t.ordinal}>Packet {t.ordinal + 1} signature: <a href={explorerUrl('tx', t.signed!.signature)} target="_blank" rel="noopener noreferrer">{t.signed!.signature}</a></p>)}</details>}
 </>;
}
export function MiningTaxClaimsScreen({ actionsEnabled, onClose, trust = null, recoveryTrust = trust }: {
 actionsEnabled: boolean; onClose(): void; trust?: MiningTaxClaimSigningTrust | null; recoveryTrust?: MiningTaxClaimSigningTrust | null;
}): React.JSX.Element {
 const { state, actionsAllowed, run, dismiss, held, history, historyError, openHistory } = useMiningTaxClaims(actionsEnabled, trust, recoveryTrust);
 const [round, setRound] = useState(''), [spot, setSpot] = useState(0), [limits, setLimits] = useState<Caps>({ maxFeeLamports: '', maxRentLamports: '', maxTotalLamports: '' });
 const [additionalLimits,setAdditionalLimits]=useState<Caps>({maxFeeLamports:'',maxRentLamports:'',maxTotalLamports:''});
 const reviewNode = useRef<HTMLElement>(null), op = state.journal?.operation, p = op?.preparation;
 const ordinal = op?.setup && p?.transactions.length === 2 ? 1 : 0, transaction = op?.transactions.find(t => t.ordinal === ordinal);
 const disabled = !state.loaded || state.busy, blocked = !!op?.failure || !!op?.failureObserved || !!op?.continuation || !!op?.continuationObserved || held(ordinal), complete = !!op?.settlement && !op.failureObserved && !op.continuationObserved && !op.continuation, failedComplete = !!op && hasCompleteMiningTaxFailure(op);
 const parsedRound = MiningTaxClaimPrepareRequestSchema.shape.round.safeParse(round);
 const parsedCaps = MiningTaxClaimPrepareRequestSchema.shape.caps.safeParse(Object.fromEntries(Object.entries(limits).map(([name, amount]) => [name, lamports(amount)])));
 const parsedAdditional=MiningTaxClaimPrepareRequestSchema.shape.caps.safeParse(Object.fromEntries(Object.entries(additionalLimits).map(([name,amount])=>[name,lamports(amount)])));
 const close = () => { dismiss(); onClose(); };
 useEffect(() => { if (state.review) { reviewNode.current?.focus({preventScroll:true}); reviewNode.current?.scrollIntoView?.({ block: 'start' }); } }, [state.review]);
 return <EconomyPanel title="Island KEEP Shares" eyebrow="SEEKER ISLAND · WINNING SPOTS" onClose={close} error={state.error}>
   <p>Collect the KEEP share earned by your winning spot. Earlier auction rounds remain yours after a spot changes hands. SOL covers the network fee and any account rent.</p>
   {!actionsAllowed && <p role="status">New tax claim actions are unavailable. Saved claims can still be checked.</p>}
   {!state.loaded && <p role="status">Loading original tax recovery…</p>}
   {state.busy && <p role="status">Checking the original claim or waiting for wallet approval…</p>}
   {!op && <section aria-label="Historical tax claim selection" className="sk-equipment-card"><h3>Choose your winning spot</h3><p>Enter its auction round and spot. The server checks the original winner before preparing a claim.</p>
    <label>Historical round<input aria-label="Historical round" inputMode="numeric" maxLength={20} style={inputStyle} value={round} disabled={disabled} onInput={e => setRound(e.currentTarget.value)} /></label>
    <label>Winning spot<select aria-label="Winning spot" style={inputStyle} value={spot} disabled={disabled} onChange={e => setSpot(Number(e.target.value))}>
     {Array.from({ length: PHASE_E_POLICY.seekerIsland.totalSpots }, (_, index) => <option key={index} value={index}>Spot {index + 1}</option>)}
    </select></label>
    <p>Set all three SOL limits for the complete claim, including any setup packet. These limits remain part of this original request.</p>
    {(Object.keys(capLabels) as (keyof Caps)[]).map(name => <label key={name}>{capLabels[name]}<input aria-label={capLabels[name]} inputMode="decimal" maxLength={30} style={inputStyle} value={limits[name]} disabled={disabled}
     onInput={e => { const value = e.currentTarget.value; setLimits(old => ({ ...old, [name]: value })); }} /></label>)}
    <Btn style={controls} disabled={disabled || !actionsAllowed || !parsedRound.success || !parsedCaps.success} onClick={() => {
     if (parsedRound.success && parsedCaps.success) run(c => c.begin(parsedRound.data, spot, parsedCaps.data));
    }}>PREPARE TAX CLAIM</Btn>
   </section>}
   {op && <section aria-label="Saved original tax claim" className="sk-equipment-card">
    <h3>{complete ? 'Verified KEEP payment' : failedComplete ? 'Failed claim' : transaction?.submitAttempted ? 'Submitted · check receipt' : transaction?.signed ? 'Signed · ready to submit' : transaction?.signingStarted ? 'Wallet approval started' : 'Saved KEEP claim'}</h3><p>Round {op.request.round} · Spot {op.request.spot + 1}</p><p>Prepare → review → wallet approval → submit → check receipt</p>
    <details open={!!state.review}><summary>Original amount and SOL limits</summary>
    <p>Original network fee limit: {sol(op.request.caps.maxFeeLamports)} SOL</p><p>Original account rent limit: {sol(op.request.caps.maxRentLamports)} SOL</p><p>Original total cost limit: {sol(op.request.caps.maxTotalLamports)} SOL</p>
    {p && <section aria-label="Original tax estimate"><div className="sk-economy-hero"><div><span>ORIGINAL KEEP CLAIM</span><strong>{keep(p.intended.claimBaseUnits)} KEEP</strong><span>Payment remains unconfirmed until its receipt is verified</span></div></div>
     <p>Original network fee estimate: {sol(p.fees.feeLamports)} SOL</p><p>Original account rent estimate: {sol(p.fees.rentLamports)} SOL</p><p>Original total estimate: {sol(p.fees.totalLamports)} SOL</p>
     <p>Original consent expires: {time(p.expiresAt)}. Actual charges may differ within your saved limits.</p>
     <p>{p.transactions.length === 2 ? 'Setup and claim require separate wallet approvals.' : 'This claim uses one wallet approval.'}</p></section>}</details>
    {!complete && <p>{blocked ? 'Positive or uncertain custody is held. Keep the original request and check its saved evidence.' : transaction?.submitAttempted ? 'Submission was attempted. Check its saved outcome; this packet will not be sent again.' : transaction?.signed ? 'The exact signed packet is saved. Submission is a separate action.' : transaction?.signingStarted ? 'Wallet approval was started. Check for its original signature; this packet will not be signed again.' : p ? `Review packet ${ordinal + 1} and its current costs before wallet approval.` : 'The original fee request is saved. Check for its result; no replacement request is created.'}</p>}
    <Receipt operation={op} />
    {p?.transactions.length===2 && op.setup && !transaction?.signingStarted && !blocked && !complete && <details><summary>Fresh consent after account setup</summary><section aria-label="Fresh split claim consent">
     <p>If this original consent expired, request a fresh claim for the unsigned remainder. The server must verify finalized expiry. Set additional SOL limits; your already paid setup costs remain above.</p>
     {(Object.keys(capLabels) as (keyof Caps)[]).map(name=><label key={name}>Additional {capLabels[name].toLowerCase().replace('(sol)','(SOL)')}<input aria-label={`Additional ${capLabels[name].toLowerCase().replace('(sol)','(SOL)')}`} inputMode="decimal" maxLength={30} style={inputStyle} value={additionalLimits[name]} disabled={disabled} onInput={e=>{const value=e.currentTarget.value;setAdditionalLimits(old=>({...old,[name]:value}));}} /></label>)}
     <Btn style={controls} disabled={disabled||!actionsAllowed||!parsedAdditional.success} onClick={()=>{if(parsedAdditional.success)run(c=>c.prepareContinuation(parsedAdditional.data));}}>PREPARE FRESH CLAIM</Btn>
    </section></details>}
    {op.continuation && <section aria-label="Saved additional tax consent">
     <p>Additional network fee limit: {sol(op.continuation.request.caps.maxFeeLamports)} SOL</p><p>Additional account rent limit: {sol(op.continuation.request.caps.maxRentLamports)} SOL</p><p>Additional total cost limit: {sol(op.continuation.request.caps.maxTotalLamports)} SOL</p>
     {op.continuation.envelope?.continuation ? <><p>Fresh network fee estimate: {sol(op.continuation.envelope.continuation.childPreparation.fees.feeLamports)} SOL</p><p>Fresh account rent estimate: {sol(op.continuation.envelope.continuation.childPreparation.fees.rentLamports)} SOL</p><p>Using this preparation checks the original history again, saves its link, and opens the new claim for a separate current review and wallet approval.</p>
      {hasCompleteMiningTaxContinuation(op)&&<Btn style={controls} disabled={disabled} onClick={()=>run(c=>c.activateContinuation())}>USE PREPARED CLAIM</Btn>}</> : <><p>The saved preparation has no verified result yet. Checking recovery sends no new request. Explicitly resuming uses the same key and additional limits.</p>
      {!op.continuationObserved&&!op.failureObserved&&!op.failure&&<Btn style={controls} disabled={disabled||!actionsAllowed} onClick={()=>run(c=>c.resumeContinuation())}>RESUME SAVED PREPARATION</Btn>}</>}
    </section>}
    {state.review && !transaction?.signingStarted && !blocked && !complete && <section ref={reviewNode} tabIndex={-1} aria-label="Review original tax packet" className="sk-equipment-card sk-equipment-review">
     <h3>{p?.transactions.length === 2 && state.review.ordinal === 0 ? 'Review account setup' : 'Review KEEP claim'}</h3><p>Packet {state.review.ordinal + 1} of {p?.transactions.length} · Round {op.request.round} · Spot {op.request.spot + 1}</p>
     {state.review.current.review && <><p>Current packet fee estimate: {sol(state.review.current.review.feeLamports)} SOL</p><p>Current packet rent estimate: {sol(state.review.current.review.rentLamports)} SOL</p>
      <p>Already paid setup fee: {sol(state.review.current.review.paidFeeLamports)} SOL · Already paid setup rent: {sol(state.review.current.review.paidRentLamports)} SOL</p></>}
     {p&&<p>Original KEEP claim: <strong>{keep(p.intended.claimBaseUnits)} KEEP</strong>. Original total cost limit: <strong>{sol(op.request.caps.maxTotalLamports)} SOL</strong>.</p>}
     <p>Wallet approval signs only this original packet. It does not submit it.</p>
     <Btn style={controls} disabled={disabled || !actionsAllowed} onClick={() => run(c => c.sign())}>APPROVE IN WALLET</Btn>
     <Btn style={controls} variant="sec" disabled={state.busy} onClick={dismiss}>CANCEL REVIEW</Btn>
    </section>}
    {p && !state.review && !transaction?.signingStarted && !blocked && !complete && <Btn style={controls} disabled={disabled || !actionsAllowed} onClick={() => run(c => c.review(ordinal))}>REVIEW TAX PACKET</Btn>}
    {transaction?.signed && !transaction.submitAttempted && !blocked && !complete && <Btn style={controls} disabled={disabled || !actionsAllowed} onClick={() => run(c => c.submit(ordinal))}>SUBMIT SAVED TAX PACKET</Btn>}
    <Btn style={controls} variant="sec" disabled={disabled} onClick={() => run(c => c.check())}>CHECK ORIGINAL TAX CLAIM</Btn>
    {complete && <Btn style={controls} disabled={disabled} onClick={() => run(c => c.archive())}>ARCHIVE VERIFIED TAX PAYMENT</Btn>}
    {failedComplete && <><p>Every packet has a saved outcome. Archiving checks those outcomes again and keeps the full claim history.</p>
     <Btn style={controls} disabled={disabled} onClick={() => run(c => c.archiveFailed())}>ARCHIVE FAILED TAX CLAIM</Btn></>}
    <details><summary>Original request</summary><p>{op.request.idempotencyKey}</p>{p && <p>Original expiry (UTC): {p.expiresAt}</p>}</details>
   </section>}
   {state.journal?.lastArchivedKey && <details><summary>KEEP share history</summary><Btn style={controls} variant="sec" disabled={state.busy} onClick={() => openHistory(state.journal!.lastArchivedKey!)}>OPEN TAX CLAIM HISTORY</Btn></details>}
   {historyError && <p role="alert">{historyError}</p>}
   {history?.operation && <section aria-label="Historical tax claim" className="sk-equipment-card"><p>Round {history.operation.request.round} · Spot {history.operation.request.spot + 1}</p><Receipt operation={history.operation} />
    {history.lastArchivedKey && <Btn style={controls} variant="sec" disabled={state.busy} onClick={() => openHistory(history.lastArchivedKey!)}>OLDER TAX CLAIM</Btn>}
   </section>}
   <Btn style={controls} variant="sec" onClick={close}>CLOSE</Btn>
 </EconomyPanel>;
}
