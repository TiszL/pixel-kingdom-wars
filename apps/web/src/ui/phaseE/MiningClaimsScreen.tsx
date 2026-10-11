import { useEffect, useRef, useState } from 'react';
import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import { TOKEN } from '@shardkeep/shared';
import { useMiningClaims } from '../../lib/miningClaims/useMiningClaims';
import { miningClaimArchivableFailure,miningClaimOrdinal,miningClaimStep,type MiningClaimOperation } from '../../lib/miningClaims/journal';
import type { MiningClaimSigningTrust } from '../../lib/miningClaims/signing';
import { explorerUrl } from '../../lib/cluster';
import { Btn } from '../primitives';
import { EconomyPanel } from './EconomyPanel';

function units(value: string | null | undefined, scale: bigint): string {
  if (value == null) return 'Unavailable';
  const n = BigInt(value), fraction = (n % scale).toString().padStart(scale.toString().length - 1, '0').replace(/0+$/, '');
  return `${n / scale}${fraction ? `.${fraction}` : ''}`;
}
const keep = (value: string | null | undefined) => units(value, 10n ** BigInt(TOKEN.decimals));
const sol = (value: string) => units(value, BigInt(LAMPORTS_PER_SOL));
const controls = { minHeight: 48, width: '100%' };
const time = (iso: string) => new Date(iso).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
function Receipt({ operation }: { operation: MiningClaimOperation }): React.JSX.Element {
  const claim = operation.claim, signatures = [...new Set([operation.signed?.signature,operation.ordered?.remainder.signed?.signature, ...(claim?.transactions.map(t => t.signature) ?? [])].filter((s): s is string => !!s))];
  return <>
    {claim?.state === 'settled' && <section aria-label="Actual mining payment"><p role="status">PAYMENT FINALIZED</p><div className="sk-economy-hero"><div><span>ACTUAL KEEP RECEIVED</span><strong>{keep(claim.settledBaseUnits)} KEEP</strong><span>From this finalized claim</span></div></div></section>}
    {operation.ordered?.continuation&&<p>Setup kept · a new claim estimate was created. This original paid no KEEP.</p>}
    {claim?.state === 'failed' && <p role="status">CLAIM FAILED. No KEEP was paid by this transaction. A network fee may apply. Archiving keeps its evidence; it does not retry or refund the fee.</p>}
    {!!signatures.length && <details><summary>Original transaction records</summary>{signatures.map(signature => <p key={signature}>Transaction signature: <a href={explorerUrl('tx', signature)} target="_blank" rel="noopener noreferrer">{signature}</a></p>)}</details>}
    {claim?.transactions.filter(t => t.landing === 'finalized').map(t => <p key={t.ordinal}>{t.kind === 'setup' ? 'Account setup finalized' : 'Claim finalized'} · {t.settledAt&&time(t.settledAt)}</p>)}
    {claim?.transactions.filter(t => t.landing === 'failed').map(t => <p key={t.ordinal}>{t.kind === 'setup' ? 'Account setup failed' : 'Claim transaction failed'} · {t.settledAt&&time(t.settledAt)}</p>)}
  </>;
}
function OriginalFees({operation}:{operation:MiningClaimOperation}):React.JSX.Element|null {
  const preparation=operation.preparation;if(!preparation)return null;
  return <section aria-label="Original fee estimate"><div className="sk-economy-hero"><div><span>ORIGINAL SOL ESTIMATE</span><strong>{sol(preparation.fees.totalLamports)} SOL</strong><span>Network fee and any account rent</span></div></div>
    <dl className="sk-economy-values"><div><dt>Network fee estimate</dt><dd>{sol(preparation.fees.feeLamports)} SOL</dd></div><div><dt>Account rent estimate</dt><dd>{sol(preparation.fees.rentLamports)} SOL</dd></div><div><dt>Wallet SOL at estimate</dt><dd>{sol(preparation.fees.payerBalanceLamports)} SOL</dd></div></dl>
    {preparation.version===2&&<dl className="sk-economy-values" aria-label="Costs by approval">{preparation.transactions.map(t=><div key={t.ordinal}><dt>{t.kind==='setup'?'Account setup':'KEEP claim'} · network + rent</dt><dd>{sol((BigInt(t.feeLamports)+BigInt(t.rentLamports)).toString())} SOL</dd></div>)}</dl>}
    <p>Estimate expires: {time(preparation.expiresAt)}. Actual network charges may differ.</p>
    <p>Saved cumulative entitlement: <strong>{keep(preparation.leaf.cumulativeKeepBaseUnits)} KEEP</strong>. This includes earlier claims; it is not the amount this transaction will pay.</p>
    <details><summary>Original claim and receiving wallet</summary><p>Receiving wallet: {preparation.wallet}</p><p>Claim: {preparation.claimId}</p><p>Original request: {operation.request.idempotencyKey}</p><p>Root sequence: {preparation.rootSequence}</p><p>Original expiry (UTC): {preparation.expiresAt}</p></details>
  </section>;
}
export function MiningClaimsScreen({ actionsEnabled, onClose, trust = null }: { actionsEnabled: boolean; onClose(): void; trust?: MiningClaimSigningTrust | null }): React.JSX.Element {
  const [twoStep,setTwoStep]=useState(false);
  const { state, actionsAllowed, run, dismiss } = useMiningClaims(actionsEnabled, trust), reviewNode = useRef<HTMLElement>(null);
  const op = state.journal?.operation, preparation = op?.preparation, finalized = op?.claim?.state === 'settled', failed = op?.claim?.state === 'failed', disabled = !state.loaded || state.busy;
  const ordinal=op?miningClaimOrdinal(op):0,step=op?miningClaimStep(op,ordinal):null,ordered=!!op?.ordered,blocked=!!(op?.ordered?.held||op?.ordered?.continuationRequest),setup=preparation?.transactions[ordinal]?.kind==='setup';
  const continuationReady=op?.ordered?.continuation,canRetry=!!op?.ordered?.continuationRefusal&&op.ordered.continuationAbsent;
  const close = () => { dismiss(); onClose(); };
  useEffect(() => { if (state.review) { reviewNode.current?.focus({preventScroll:true}); reviewNode.current?.scrollIntoView?.({ block: 'start' }); } }, [state.review]);
  return <EconomyPanel title="Mining Claims" eyebrow="EARNED KEEP · WALLET CLAIMS" onClose={close} error={state.error}>
      <p>Claim earned KEEP into your connected wallet. SOL pays the network fee and any account rent.</p>
      {!actionsAllowed && <p role="status">New claim actions are unavailable. Saved claims can still be checked.</p>}
      {!state.loaded && <p role="status">Loading saved claims…</p>}
      {state.busy && <p role="status" aria-live="polite">Checking your claim or waiting for wallet approval…</p>}
      <section aria-label="Current mining allocation" className="sk-equipment-card"><div className="sk-economy-hero"><div><span>UNCLAIMED KEEP · CONNECTED WALLET</span><strong>{keep(state.status?.claimableBaseUnits)}{state.status?.claimableBaseUnits != null ? ' KEEP' : ''}</strong><span>Current server observation</span></div></div>
        {(!state.status || state.status.state==='unavailable') && <p>Current allocation could not be verified. This does not mean your balance is zero. Saved claims remain recoverable.</p>}
        {state.status?.state === 'claimed' && <p>The observed cumulative allocation has already been claimed. Check again after new earnings are published.</p>}
        {state.status?.state === 'delayed' && <p>Your allocation is waiting for its claim window.</p>}
        {state.status?.state === 'paused' && <p>New claims are paused.</p>}
        {state.status?.state === 'revoked' && <p>This allocation is unavailable. Keep any saved claim for recovery.</p>}
        {state.status?.state === 'no_allocation' && <p>No mining allocation is available yet.</p>}
        {!op&&state.status?.features.claims.ordered===1&&trust?.orderedLookupTable&&<fieldset><legend>Claim method</legend><label style={{display:'flex',gap:12,minHeight:48,alignItems:'center'}}><input type="checkbox" checked={twoStep} onChange={e=>setTwoStep(e.target.checked)} disabled={disabled||!actionsAllowed}/>Use separate setup and claim approvals</label><p>The first claim uses two transactions and costs an extra network fee. Review both estimates before approving. Existing accounts need only the claim.</p></fieldset>}
        {!op && <Btn style={controls} disabled={disabled || !actionsAllowed || !state.status?.preparationAllowed || state.status.state !== 'ready'} onClick={() => run(c => c.begin(twoStep?'ordered-v0':undefined))}>ESTIMATE FEES</Btn>}
        {state.status&&<details><summary>Current allocation details</summary><p>Cumulative entitlement: {keep(state.status.cumulativeKeepBaseUnits)} KEEP</p><p>Already claimed: {keep(state.status.claimedBaseUnits)} KEEP</p><p>Observed: {time(state.status.serverNow)}</p><p>Receiving wallet: {state.status.wallet}</p></details>}
      </section>
      {op && <section aria-label="Saved mining claim" className="sk-equipment-card"><h3>{finalized?'Finalized claim':failed?'Failed claim':step?.submitAttempted?'Submitted · check receipt':step?.signed?'Signed · ready to submit':step?.signingStarted?'Wallet approval started':preparation?'Saved fee estimate':'Saved claim request'}</h3>{ordered?<ol aria-label="Claim progress" style={{display:'grid',gridTemplateColumns:'repeat(2,minmax(0,1fr))',gap:12,padding:0,listStyle:'none'}}>{['Set up accounts','Receive KEEP'].map((label,i)=><li className="sk-equipment-card" key={label} aria-current={i===(preparation?.transactions.length===1?1:ordinal)?'step':undefined}><span>STEP {i+1}</span><h4>{label}</h4><p>{i===0?(op.claim?.transactions[0]?.kind==='setup'&&op.claim.transactions[0].landing==='finalized'?'Confirmed · no KEEP paid':preparation?.transactions.length===1?'Already set up':'Separate wallet approval'):(finalized?'Payment finalized':'Payment requires a finalized claim')}</p></li>)}</ol>:<p>Estimate → review → wallet approval → submit → check receipt</p>}
        {!finalized && !failed && <p>{step?.signed ? 'Your signed claim is saved. Payment is not confirmed; check its receipt.' : step?.signingStarted ? 'Wallet approval was started. Keep this claim and check its receipt.' : op.prepareRefusal ? 'The fee request was declined. Check it before closing the saved request.' : preparation ? 'Review the estimated SOL costs before wallet approval.' : 'Your fee request is saved. Check for its original result.'}</p>}
        {preparation&&!state.review&&<details><summary>Original fees and cumulative entitlement</summary><OriginalFees operation={op}/></details>}
        <Receipt operation={op} />
        {state.review && !step?.signed && !finalized && !failed && !blocked && <section ref={reviewNode} tabIndex={-1} aria-label="Approve reviewed claim" className="sk-equipment-card sk-equipment-review"><h3>{setup?'Review account setup':'Review the original claim'}</h3><OriginalFees operation={op}/>
          <p>{setup?'This approval sets up your accounts. It pays no KEEP. You will approve the claim separately after setup is confirmed.':'Review these fees in your wallet before approving the KEEP claim.'}</p>
          <Btn style={controls} disabled={disabled || !actionsAllowed} onClick={() => run(c => c.sign())}>APPROVE IN WALLET</Btn>
          <Btn style={controls} variant="sec" disabled={state.busy} onClick={dismiss}>CANCEL REVIEW</Btn>
        </section>}
        {preparation && !state.review && !step?.signed && !finalized && !failed && !blocked && <Btn style={controls} disabled={disabled || !actionsAllowed} onClick={() => run(c => c.review())}>{setup?'REVIEW SETUP':'REVIEW CLAIM'}</Btn>}
        {step?.signed && !step.submitAttempted && !finalized && !failed && !blocked && <Btn style={controls} disabled={disabled || !actionsAllowed} onClick={() => run(c => c.submit())}>{setup?'SUBMIT SAVED SETUP':'SUBMIT SAVED CLAIM'}</Btn>}
        <Btn style={controls} variant="sec" disabled={disabled} onClick={() => run(c => c.open())}>CHECK CLAIM</Btn>
        {op.ordered?.held&&<p role="alert">A terminal reply could not be verified. Your original records are kept; approval and submission are held.</p>}
        {ordered&&!finalized&&!continuationReady&&(ordinal===1||preparation?.transactions.length===1)&&<section aria-label="Continue after setup"><h4>Keep completed setup</h4><p>If the unsigned claim expires or a signed claim has a verified failure, check eligibility for a new claim estimate. It needs fresh approval and a new network fee. An uncertain signed claim stays on hold.</p>{op.ordered?.continuationRequest&&!canRetry?<p>Checking the original continuation request. Use Check claim; no request will be repeated.</p>:<Btn style={controls} variant="sec" disabled={disabled||!actionsAllowed||!!op.ordered?.held} onClick={()=>run(c=>c.continueClaim())}>{canRetry?'CHECK ELIGIBILITY AGAIN':'CHECK CONTINUATION ELIGIBILITY'}</Btn>}</section>}
        {continuationReady&&<section aria-label="New claim estimate ready"><h4>Setup kept · new claim estimate ready</h4><p>Continue to review {sol(continuationReady.childPreparation.fees.totalLamports)} SOL in estimated network costs. All original records stay in history.</p><Btn style={controls} disabled={disabled||!!op.ordered?.held} onClick={()=>run(c=>c.useContinuation())}>REVIEW NEW CLAIM ESTIMATE</Btn></section>}
        {miningClaimArchivableFailure(op) && <Btn style={controls} variant="sec" disabled={disabled||!!op.ordered?.held} onClick={() => run(c => c.archiveFailed())}>CHECK & ARCHIVE FAILED CLAIM</Btn>}
        {finalized && <Btn style={controls} disabled={disabled||!!op.ordered?.held} onClick={() => run(c => c.finish())}>DONE</Btn>}
        {op.prepareRefusal && !preparation && !op.signed && !op.claim && <Btn style={controls} variant="sec" disabled={disabled} onClick={() => run(c => c.archiveRefusal())}>CLOSE DECLINED REQUEST</Btn>}
      </section>}
      {!!state.journal?.archives.length && <details><summary className="interactive" style={{ minHeight: 44 }}>Claim history ({state.journal.archives.length})</summary>
        {state.journal.archives.map(a => <section key={a.request.idempotencyKey} className="sk-equipment-card">
          {a.prepareRefusal && !a.preparation && <p>Declined fee request closed after checking for its result.</p>}<Receipt operation={a} />
        </section>)}
      </details>}
      {!op && <Btn style={controls} variant="sec" disabled={state.busy} onClick={() => run(c => c.open())}>CHECK CLAIMS</Btn>}
      <Btn style={controls} variant="sec" onClick={close}>CLOSE</Btn>
  </EconomyPanel>;
}
