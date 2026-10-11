import { phaseEWebEnabled } from './phaseEWebHold';
import { useEffect, useRef, useState } from 'react';
import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import { useApp } from '../state/store';
import { gemsBuyBinding } from '../lib/gemsBuy/browser';
import { hasGemsBuyPaymentEvidence, type GemsBuyPurchase } from '../lib/gemsBuy/journal';
import { useGemsBuyRecovery } from '../lib/gemsBuy/useGemsBuyRecovery';
import { explorerUrl } from '../lib/cluster';
import { GEM_ICONS } from './icons';
import { Btn } from './primitives';
import { EconomyPanel } from './phaseE/EconomyPanel';

const whole = (n: string | number) => BigInt(n).toLocaleString('en-US');
const controls = { minHeight: 44, width: '100%' };
function PurchaseDetails({ purchase }: { purchase: GemsBuyPurchase }): React.JSX.Element {
  const quote = purchase.quote, receipt = purchase.deposit?.receipt;
  return <details style={{ overflowWrap: 'anywhere' }}><summary className="interactive" style={{ minHeight: 44, paddingTop: 12 }}>ORIGINAL PURCHASE DETAILS</summary>
    <p>Request: {purchase.request.idempotencyKey}</p><p>Wallet: {purchase.binding.wallet}</p><p>KEEP mint: {purchase.binding.mint}</p>
    {quote && <><p>Reserve token account: {quote.destination}</p><p>Reference: {quote.reference}</p><p>Quote expires: {quote.expiresAt} (UTC)</p></>}
    {purchase.signature && <p>Wallet-returned signature: <a href={explorerUrl('tx', purchase.signature)} target="_blank" rel="noopener noreferrer">{purchase.signature}</a></p>}
    {purchase.deposit?.paymentSignature && <p>Server-observed submitted signature: {purchase.deposit.paymentSignature}</p>}
    {receipt && <p>Credited transaction: <a href={explorerUrl('tx', receipt.txSignature)} target="_blank" rel="noopener noreferrer">{receipt.txSignature}</a></p>}
  </details>;
}
export function GemsBuyScreen({ onBack }: { onBack: () => void }): React.JSX.Element {
  const wallet = useApp(s => s.wallet), { state, run, dismiss, actionsAllowed } = useGemsBuyRecovery(), [input, setInput] = useState('');
  const purchase = state.journal?.purchase, receipt = purchase?.deposit?.receipt, reviewNode = useRef<HTMLElement>(null), receiptNode = useRef<HTMLDivElement>(null);
  const attempted = !!purchase && (!!purchase.prepared || hasGemsBuyPaymentEvidence(purchase.deposit));
  const fresh = phaseEWebEnabled();
  const disabled = !wallet || !state.loaded || state.busy;
  const amount = /^[1-9][0-9]{0,15}$/.test(input) && Number.isSafeInteger(Number(input)) ? Number(input) : null;
  const back = () => { dismiss(); onBack(); };
  const close = () => { dismiss(); useApp.getState().setScreen('base'); };
  useEffect(() => { const node=receipt?receiptNode.current:state.reviewed?reviewNode.current:null;node?.focus();node?.scrollIntoView?.({block:'nearest'}); }, [state.reviewed,receipt]);
  return <EconomyPanel title="Get Gems" eyebrow="CONNECTED WALLET" onClose={close} error={state.error} icon={<img src={GEM_ICONS[32]} width={40} height={40} alt="" style={{imageRendering:'pixelated'}}/>}>
      <p className="sk-equipment-muted">Use KEEP in your connected wallet. This does not spend your in-game KEEP balance. Gems stay in the game and cannot convert back to KEEP. A SOL network fee is additional.</p>
      {(!fresh || !actionsAllowed) && <p role="status">New payments are paused. Saved purchases can still be checked.</p>}
      {!state.loaded && <p role="status">Loading original purchase recovery…</p>}
      {state.busy && <p role="status" aria-live="polite">{purchase?.prepared && !purchase.signature ? 'Waiting for the original wallet approval…' : 'Checking the original purchase…'}</p>}
      {fresh && state.loaded && !purchase && <section aria-label="New wallet Gems purchase" className="sk-equipment-card"><h3>Choose your amount</h3><p className="sk-equipment-muted">The next step shows the exact Gems credit and network fee.</p>
        <label>WALLET KEEP amount<input className="interactive" aria-label="WALLET KEEP amount" inputMode="numeric" maxLength={16} value={input}
          onChange={e => setInput(e.target.value.replace(/[^0-9]/g, ''))}  /></label>
        <Btn style={controls} disabled={disabled || !actionsAllowed || amount === null} onClick={() => { if (phaseEWebEnabled() && wallet && amount !== null) run(c => c.begin(amount, gemsBuyBinding(wallet))); }}>GET ORIGINAL QUOTE</Btn>
      </section>}
      {purchase && <section aria-label="Original wallet Gems purchase" className="sk-equipment-card"><p className="sk-equipment-eyebrow">{receipt?'GEMS CREDITED':attempted?'SAVED PAYMENT':'ORIGINAL QUOTE'}</p>
        <h3>{whole(purchase.request.keepIn)} WALLET KEEP{purchase.quote ? ` → ${whole(purchase.quote.gemsOut)} GEMS` : ' · ORIGINAL QUOTE PENDING'}</h3>
        {!receipt && attempted && <p role="status">A wallet payment may already exist. Keep this record and check the original proof. Do not send another payment.</p>}
        {!receipt && !attempted && <p>The original amount and request are saved. Review the complete quote and network fee before opening your wallet.</p>}
        {receipt && <div ref={receiptNode} tabIndex={-1} role="status" aria-live="polite"><p>Original receipt confirmed: +{whole(receipt.result.amount)} GEMS.</p>
          <p>Credited from {whole(receipt.funding.amount)} whole KEEP actually received. This receipt is historical proof, not a current base stock count.</p>
          {purchase.deposit?.dustBaseUnits !== '0' && <p>Uncredited token dust: {purchase.deposit?.dustBaseUnits} base units. No refund is implied.</p>}
        </div>}
        {fresh && state.reviewed && purchase.quote && !attempted && <section ref={reviewNode} tabIndex={-1} aria-label="Approve wallet payment" className="sk-equipment-review">
          <strong>{whole(purchase.quote.keepIn)} WALLET KEEP → {whole(purchase.quote.gemsOut)} GEMS</strong>
          <dl className="sk-economy-values"><div><dt>Network fee</dt><dd>{state.networkFee === null ? 'unavailable' : `${state.networkFee / LAMPORTS_PER_SOL} SOL`}</dd></div><div><dt>Gems credited</dt><dd>{whole(purchase.quote.gemsOut)} GEMS</dd></div></dl>
          <p>Quote expires: {purchase.quote.expiresAt} (UTC). This conversion is one-way.</p><details><summary>Payment destination</summary><p>Reserve token account: {purchase.quote.destination}</p></details>
          <Btn style={controls} disabled={disabled || !actionsAllowed || state.networkFee === null} onClick={() => { if (phaseEWebEnabled()) run(c => c.pay()); }}>APPROVE {whole(purchase.quote.keepIn)} WALLET KEEP</Btn>
          <Btn style={{ ...controls, marginTop: 8 }} variant="sec" disabled={state.busy} onClick={dismiss}>CANCEL REVIEW</Btn>
        </section>}
        <div className="sk-economy-actions">
          {fresh && !attempted && !state.reviewed && (!purchase.deposit || purchase.deposit.status === 'pending') && <Btn style={controls} disabled={disabled || !actionsAllowed} onClick={() => { if (phaseEWebEnabled()) run(c => c.reviewPayment()); }}>REVIEW WALLET PAYMENT</Btn>}
          <Btn style={controls} variant="sec" disabled={disabled} onClick={() => run(c => c.recoverPayment())}>CHECK ORIGINAL PAYMENT</Btn>
          {!attempted && <Btn style={controls} variant="sec" disabled={disabled} onClick={() => run(c => c.abandonDraft())}>ARCHIVE UNUSED DRAFT</Btn>}
          {receipt && <Btn style={controls} variant="sec" disabled={disabled} onClick={() => run(c => c.finish())}>ARCHIVE CONFIRMED PURCHASE</Btn>}
        </div>
        <PurchaseDetails purchase={purchase} />
      </section>}
      {!!state.journal?.archives.length && <details><summary className="interactive" style={{ minHeight: 44, paddingTop: 12 }}>SAVED PURCHASE HISTORY ({state.journal.archives.length})</summary>
        {state.journal.archives.map(a => <section key={a.purchase.request.idempotencyKey} className="sk-equipment-card">
          <strong>{a.reason === 'credited' ? `Original credit: +${whole(a.purchase.deposit!.receipt!.result.amount)} GEMS` : 'Unused draft archived before any wallet attempt'}</strong>
          <PurchaseDetails purchase={a.purchase} />
        </section>)}
      </details>}
      <Btn style={controls} variant="sec" disabled={state.busy} onClick={() => run(c => c.open())}>REFRESH SAVED PURCHASE</Btn>
      <Btn style={controls} variant="sec" onClick={back}>BACK TO GEMS WALLET</Btn>
  </EconomyPanel>;
}
