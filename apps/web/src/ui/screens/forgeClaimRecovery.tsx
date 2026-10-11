import { useEffect } from 'react';
import { FORGE } from '@shardkeep/shared';
import type { ForgeClaimController, ForgeClaimState } from '../../lib/forgeClaims/controller';
import type { ForgeClaimIntent } from '../../lib/forgeClaims/journal';
import { BODY_TEXT_STYLE, Btn, Card, COLORS as C, fmtN, GAME_FONT } from '../primitives';
const selection = (intent: ForgeClaimIntent): string => intent.request.day ?? `All ready cycles, oldest first, up to ${FORGE.claimBatchMax}`;
const scope = (intent: ForgeClaimIntent): string => intent.request.baseId ? `Original allocation deed: ${intent.request.baseId}` : 'Original wallet allocations';
export function ForgeClaimRecoveryPanel({ controller, state }: { controller: ForgeClaimController; state: ForgeClaimState }): React.JSX.Element {
  useEffect(() => {
    const back = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && controller.snapshot().review) { event.preventDefault(); event.stopPropagation(); controller.dismiss(); }
    };
    window.addEventListener('keydown', back, true); return () => window.removeEventListener('keydown', back, true);
  }, [controller]);
  const saved = state.journal, proof = saved?.receipt, review = state.review;
  const shownIntent = review ?? saved?.intent;
  return <section aria-label="Forge claim recovery"><Card style={{ ...BODY_TEXT_STYLE, padding: 12, gap: 10, overflowWrap: 'anywhere' }}>
    {!state.loaded ? <span>Checking your collection…</span> : review ? <>
      <strong style={{ color: C.goldHi, fontFamily: GAME_FONT, fontSize: 24 }}>REVIEW FORGE CLAIM</strong><span>{selection(review)}</span>
      <span>Eligible allocations pay KEEP to your game wallet. The server determines the exact payout. A later claim needs a new confirmation.</span>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <Btn disabled={state.busy} onClick={() => void controller.confirm()}>CONFIRM CLAIM</Btn>
        <Btn variant="ghost" onClick={() => controller.dismiss()}>BACK</Btn>
      </div>
    </> : saved?.intent ? <>
      {proof ? <>
        <div role="status" aria-atomic="true" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <strong style={{ color: C.goldHi, fontFamily: GAME_FONT, fontSize: 32 }}>+{fmtN(proof.result.totalKeep)} KEEP</strong>
          <span>{proof.result.claimed.length ? 'Added to your game wallet' : 'Nothing was ready for this collection.'}</span>
        </div>
        {saved.hydrated?.walletKeep === 'unavailable' && <span>Collection confirmed. Your current wallet balance is unavailable.</span>}
        {!saved.hydrated && <span>{state.busy ? 'Updating balance…' : 'Collection confirmed. Check the saved receipt to update your balance.'}</span>}
        {!saved.finished && <Btn disabled={state.busy || !saved.hydrated} onClick={() => void controller.finish()}>FINISH REVIEW</Btn>}
        {saved.finished && <span>Review finished. Your receipt is saved.</span>}
      </> : <>
        <span>{state.busy ? 'Checking outcome…' : 'Your collection is saved. Check its outcome before collecting again.'}</span>
        <Btn disabled={state.busy || !state.supported || !state.enabled} onClick={() => void controller.retry()}>RETRY ORIGINAL CLAIM</Btn>
      </>}
    </> : <span>Choose a ready cycle or all ready cycles to review a claim.</span>}
    {state.error && <div role="status">{state.error}</div>}
    {shownIntent && <details key={`${saved?.identity.wallet}:${shownIntent.request.idempotencyKey}:${review ? 'review' : 'saved'}`}>
      <summary style={{ minHeight: 48, display: 'list-item', alignContent: 'center', cursor: 'pointer', color: C.goldHi }}>Claim details</summary>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingBottom: 8 }}>
        <span>Wallet: {saved?.identity.wallet}</span><span>{scope(shownIntent)}</span><span>{selection(shownIntent)}</span>
        <span>Claim: {shownIntent.request.idempotencyKey}</span>
        {!review && proof && <>
          <span>Recorded: {proof.createdAt}</span>
          {proof.result.claimed.map(row => <span key={row.day}>{row.day} · {fmtN(row.keep)} KEEP · Ledger receipt: {row.ledgerTransactionId}</span>)}
          <span>{proof.result.remaining} allocations remained when this receipt was recorded.</span>
          {proof.result.claimed.length === 0 && <span>This completed request paid zero. It cannot claim a future allocation.</span>}
          {saved?.hydrated?.walletKeep === 'unavailable' && <span>Your current wallet KEEP balance is unavailable through the original allocation scope. The saved receipt confirms its exact payout; another deed or on-chain balance does not substitute.</span>}
        </>}
      </div>
    </details>}
    {state.loaded && !state.supported && <span>Saved Forge claims are unavailable on this server. Claims stay read-only and any original request remains saved.</span>}
    {state.supported && !state.enabled && <span>New Forge claims are paused. Historical receipts remain available.</span>}
    <Btn variant="ghost" disabled={state.busy} onClick={() => void controller.open()}>CHECK ORIGINAL RECEIPT</Btn>
  </Card></section>;
}
