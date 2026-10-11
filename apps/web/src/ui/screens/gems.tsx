import { phaseEWebEnabled } from '../phaseEWebHold';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { GemsJournalStore } from '../../lib/gems/journal';
import { gemsIdentity } from '../../lib/gems/browser';
import { GemsBuyJournalStore } from '../../lib/gemsBuy/journal';
import { gemsBuyIdentity } from '../../lib/gemsBuy/browser';
import { GEM_ICONS } from '../icons';
import { useApp } from '../../state/store';
import { useGemsRecovery } from '../../lib/gems/useGemsRecovery';
import { parseGemsReceipt } from '../../lib/gems/contracts';
import { Btn, Chip, COLORS as C, ModalWrap, Phead, Sp } from '../primitives';
import { EconomyPanel } from '../phaseE/EconomyPanel';
const home = (): void => useApp.getState().setScreen('base');
const whole = (value: string): string => BigInt(value).toLocaleString('en-US');

const WalletPurchase = lazy(() => import('../GemsBuyScreen').then(module => ({ default: module.GemsBuyScreen })));
export function GemsWalletScreen(): React.JSX.Element {
  const [walletPurchase, setWalletPurchase] = useState(false);
  return walletPurchase ? <Suspense fallback={<ModalWrap onBackdrop={home}><Phead title="WALLET PURCHASES" onClose={home} /><p role="status" style={{ padding: 20 }}>Loading saved wallet purchases…</p><Btn style={{ minHeight: 44 }} onClick={() => setWalletPurchase(false)}>BACK TO GEMS WALLET</Btn></ModalWrap>}>
    <WalletPurchase onBack={() => setWalletPurchase(false)} />
  </Suspense> : <GemsLedgerWalletScreen onWalletPurchase={() => setWalletPurchase(true)} />;
}
/** Server currency stays truthful without opening a fresh Gems controller. */
export function GemsHeldBalance({ onRecovery }: { onRecovery: () => void }): React.JSX.Element {
  const gems = useApp(s => s.balances?.gems), owned = useApp(s => s.entryPaid);
  return <ModalWrap onBackdrop={home}><Phead title="GEMS BALANCE" onClose={home} />
    <div style={{ padding: 20 }}><strong>{gems === undefined ? '…' : whole(gems)} GEMS</strong>
      <p>Available in the Android app for now. Saved requests remain recoverable.</p>
      <GemsRecoveryDoor onOpen={onRecovery} />
      <Btn variant="sec" onClick={() => useApp.getState().setScreen('profile')}>CONNECTED WALLET</Btn>
      {owned && <Btn variant="sec" onClick={() => useApp.getState().setScreen('withdraw')}>WITHDRAW CUSTODIAL KEEP</Btn>}
      <Btn variant="ghost" onClick={home}>CLOSE</Btn>
    </div>
  </ModalWrap>;
}
function GemsLedgerWalletScreen({ onWalletPurchase }: { onWalletPurchase: () => void }): React.JSX.Element {
  const { controller, state, actionsAllowed } = useGemsRecovery();
  const fresh = phaseEWebEnabled();
  const baseId = useApp(s => s.selectedBaseId), balances = useApp(s => s.balances), owned = useApp(s => s.entryPaid);
  const [keep, setKeep] = useState(''), [gems, setGems] = useState('');
  const overview = state.overview, journal = state.journal, pending = !!journal?.intent && !journal.finished;
  const review = state.review;
  const reviewNode = useRef<HTMLElement>(null), receiptNode = useRef<HTMLParagraphElement>(null);
  const accepted = journal?.receipt && journal.intent ? parseGemsReceipt(journal.receipt, journal.intent, journal.identity.wallet) : null;
  useEffect(() => { const node=review?reviewNode.current:journal?.finished&&accepted?receiptNode.current:null;node?.focus();node?.scrollIntoView?.({block:'nearest'}); }, [review,journal?.finished,accepted?.receiptId]);
  const disabled = !actionsAllowed || state.busy || !state.enabled || pending || !!review;
  const positive = (value: string): boolean => /^[1-9][0-9]{0,31}$/.test(value);
  const output = review?.consent ? `${whole(review.consent.output)} ${review.kind === 'gems-to-shards' ? 'SHARDS' : 'GEMS'}` : null;
  return <EconomyPanel title="Gems wallet" eyebrow="GAME CURRENCY" onClose={home} error={state.error}>
      <div className="sk-economy-hero"><img src={GEM_ICONS[32]} width={48} height={48} alt="" style={{imageRendering:'pixelated'}}/><div><span>GEMS AVAILABLE</span><strong>{overview ? whole(overview.gems) : '…'}</strong><span>For your in-game purchases</span></div></div>
      <p className="sk-equipment-muted">Gems cannot be withdrawn or converted back to KEEP.</p>
      <dl className="sk-economy-values"><div><dt>Custodial KEEP · last loaded</dt><dd>{balances ? whole(balances.keep) : '…'}</dd></div></dl>
      <p className="sk-equipment-muted">On-chain KEEP stays in your connected wallet.</p>
      <Btn variant="sec" style={{ minHeight: 44 }} onClick={onWalletPurchase}>{fresh ? 'WALLET KEEP PURCHASES & RECOVERY' : 'CHECK SAVED WALLET PURCHASES'}</Btn>
      {(!fresh || !state.enabled || !actionsAllowed) && !state.busy && <p style={{ margin: 0, color: C.textDim }}>Gems actions are unavailable. Saved requests remain recoverable.</p>}
      {fresh && review && <section ref={reviewNode} role="region" tabIndex={-1} aria-label="Confirm Gems operation" className="sk-equipment-card sk-equipment-review">
        <strong>{review.kind === 'gems-from-keep' ? `${whole(review.keep)} CUSTODIAL KEEP` : review.kind === 'gems-to-shards' ? `${whole(review.gems)} GEMS` : 'CLAIM TASK REWARD'} → {output}</strong>
        <p>{review.kind === 'gems-from-keep' ? 'This spends in-game KEEP. Gems never convert back to KEEP.' : review.kind === 'gems-to-shards' ? `Destination: ${review.baseId ? 'the originally selected kingdom' : 'legacy wallet pool'}. Gems become nonwithdrawable SHARDS.` : 'This reward can be claimed once per account.'}</p>
        {review.kind === 'gems-to-shards' && review.baseId && <details><summary>Confirm destination</summary><p>Base: {review.baseId}</p></details>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Btn disabled={state.busy || !actionsAllowed} onClick={() => { if (phaseEWebEnabled()) void controller?.confirm(); }}>CONFIRM {review.kind === 'gems-from-keep' ? `${whole(review.keep)} KEEP` : review.kind === 'gems-to-shards' ? `${whole(review.gems)} GEMS` : 'CLAIM'}</Btn>
          <Btn variant="sec" disabled={state.busy} onClick={() => controller?.dismiss()}>CANCEL</Btn>
        </div>
      </section>}
      {journal?.refusal && <section aria-label="Gems request declined" className="sk-equipment-card">
        <strong>REQUEST DECLINED</strong><p>No currency was moved by this request. {fresh ? 'You can review a new request.' : 'Available in the Android app for now.'}</p>
        <details><summary>Original request details</summary><p>Saved reference: {journal.intent?.idempotencyKey}</p></details>
      </section>}
      {pending && journal?.intent && <section aria-label="Saved Gems request" className="sk-equipment-card">
        <strong>{accepted ? 'RECEIPT VERIFIED · REFRESH PENDING' : 'REQUEST OUTCOME PENDING'}</strong>
        <p>The original amount and key are saved. Check the receipt before sending again.</p>
        <details><summary>Original request details</summary><p>{journal.intent.idempotencyKey}</p>
        {journal.intent.kind === 'gems-to-shards' && <p>Original base: {journal.intent.baseId ?? 'legacy wallet pool'}</p>}</details>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <Btn variant="sec" disabled={state.busy} onClick={() => { void controller?.check(); }}>CHECK ORIGINAL RECEIPT</Btn>
          {!accepted && <Btn variant="sec" disabled={state.busy || !actionsAllowed} onClick={() => { void controller?.retry(); }}>RETRY SAME REQUEST</Btn>}
        </div>
      </section>}
      {accepted && journal?.finished && <p ref={receiptNode} tabIndex={-1} role="status" style={{ margin: 0, color: C.sky }}>
        Original receipt confirmed: +{whole(accepted.amount)} {accepted.currency}.
        {journal.intent?.kind === 'gems-to-shards' ? ' Credited to the original conversion destination.' : ''}
      </p>}
      {fresh && <div className="sk-economy-grid">
      {overview?.sources.includes('ledger-keep') && <section aria-label="Get Gems from custodial KEEP" className="sk-equipment-card">
        <h3>Get Gems</h3>
        <p>Convert in-game KEEP to Gems. {overview.gemsPerKeep} Gems per KEEP.</p>
        <label>KEEP amount<input className="interactive" aria-label="KEEP amount" inputMode="numeric" value={keep} maxLength={32}
          onChange={event => setKeep(event.target.value.replace(/[^0-9]/g, ''))}  /></label>
        <p style={{ fontSize: 18, color: C.textDim }}>Minimum {whole(String(overview.minConvertKeep))}; maximum {whole(String(overview.maxConvertKeepPerTx))} KEEP per request.</p>
        <Btn disabled={disabled || !positive(keep)} onClick={() => { if (phaseEWebEnabled()) void controller?.review({ kind: 'gems-from-keep', keep }); }}>REVIEW GET GEMS</Btn>
      </section>}
      <section aria-label="Convert Gems to SHARDS" className="sk-equipment-card">
        <h3>Gems → SHARDS</h3>
        {overview && <p>{overview.shardsPerGem} SHARDS per Gem. SHARDS go to the selected base; this cannot be reversed.</p>}
        <label>Gems amount<input className="interactive" aria-label="Gems amount" inputMode="numeric" value={gems} maxLength={32}
          onChange={event => setGems(event.target.value.replace(/[^0-9]/g, ''))}  /></label>
        <Btn disabled={disabled || !positive(gems)} onClick={() => { if (phaseEWebEnabled()) void controller?.review({ kind: 'gems-to-shards', gems, baseId }); }}>REVIEW CONVERSION</Btn>
      </section>
      </div>}
      {fresh && overview && overview.tasks.length > 0 && <section aria-label="Gems tasks"><h3>Gems tasks</h3>
        {overview.tasks.map(task => <Chip key={task.id} style={{ flexWrap: 'wrap' }}><span>{task.title ?? task.id}</span><Sp /><span>{whole(task.gems)} GEMS</span>
          <Btn variant="sec" disabled={disabled || task.claimed} onClick={() => { if (phaseEWebEnabled()) void controller?.review({ kind: 'gems-task-claim', taskId: task.id }); }}>{task.claimed ? 'CLAIMED' : 'REVIEW CLAIM'}</Btn>
        </Chip>)}
      </section>}

      <Btn variant="sec" disabled={state.busy} onClick={() => { void controller?.open(); }}>REFRESH GEMS</Btn>
      <Btn variant="sec" onClick={() => useApp.getState().setScreen('profile')}>CONNECTED WALLET</Btn>
      {owned && <Btn variant="sec" onClick={() => useApp.getState().setScreen('withdraw')}>WITHDRAW CUSTODIAL KEEP</Btn>}
      <Btn variant="ghost" onClick={home}>CLOSE</Btn>
  </EconomyPanel>;
}


/** Read only local evidence so a server pause cannot hide an unresolved request.
 * Old clients with no Gems history do not fetch Gems routes or show a new lane. */
export function GemsRecoveryDoor({ onOpen }: { onOpen: () => void }): React.JSX.Element | null {
  const wallet = useApp(s => s.wallet), authed = useApp(s => s.authed);
  const [foundFor, setFoundFor] = useState<string | null>(null);
  useEffect(() => {
    if (!wallet || !authed) return;
    let current = true;
    const store = new GemsJournalStore(gemsIdentity(wallet));
    let purchases: GemsBuyJournalStore | null = null;
    const readPurchases = Promise.resolve().then(() => { purchases = new GemsBuyJournalStore(gemsBuyIdentity(wallet)); return purchases.read(); });
    void Promise.all([store.read(), readPurchases]).then(([saved, bought]) => {
      if (current && (saved.intent || bought.purchase || bought.archives.length)) setFoundFor(wallet);
    }, () => { if (current) setFoundFor(wallet); }).finally(() => {
      void store.close().catch(() => undefined); void purchases?.close().catch(() => undefined);
    });
    return () => { current = false; };
  }, [wallet, authed]);
  return wallet && authed && foundFor === wallet ? <Btn variant="sec" onClick={onOpen}>CHECK SAVED GEMS REQUEST</Btn> : null;
}
