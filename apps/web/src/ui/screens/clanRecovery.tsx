import { useEffect } from 'react';
import type { ClanController, ClanState } from '../../lib/clans/controller';
import type { ClanIntent } from '../../lib/clans/journal';
import { Btn, Card, COLORS as C } from '../primitives';
const destination = (intent: ClanIntent): string => intent.kind === 'kick' ? `Member: ${intent.request.wallet}`
  : intent.request.baseId ? `Original payout base: ${intent.request.baseId}` : 'Original payout destination: wallet SHARDS';
export function ClanRecoveryPanel({ controller, state }: { controller: ClanController; state: ClanState }): React.JSX.Element {
  useEffect(() => {
    const back = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && controller.snapshot().review) { event.preventDefault(); event.stopPropagation(); controller.dismiss(); }
    };
    window.addEventListener('keydown', back, true); return () => window.removeEventListener('keydown', back, true);
  }, [controller]);
  const saved = state.journal; const proof = saved?.receipt; const review = state.review;
  return <section aria-label="Clan command recovery"><Card style={{ padding: 12, gap: 10, overflowWrap: 'anywhere' }}>
    <strong style={{ color: C.goldHi }}>CLAN MANAGEMENT</strong>
    {state.error && <div role="status">{state.error}</div>}
    {!state.loaded ? <span>Reading saved clan command…</span> : review ? <>
      <strong>REVIEW {review.kind === 'leave' ? 'LEAVE / DISBAND' : 'REMOVE MEMBER'}</strong>
      <span>{review.clanName} · {review.request.clanId}</span><span>{destination(review)}</span>
      <span>{review.kind === 'leave' ? 'Leave this original clan. A sole leader disbands it; any chest payout and exact amount are determined by the server.'
        : 'Remove this exact member from the original clan. The server checks your current authority.'}</span>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <Btn disabled={state.busy} onClick={() => void controller.confirm()}>CONFIRM {review.kind === 'leave' ? 'LEAVE / DISBAND' : 'REMOVE MEMBER'}</Btn>
        <Btn variant="ghost" onClick={() => controller.dismiss()}>BACK</Btn>
      </div>
    </> : saved?.intent ? <>
      <span>ORIGINAL CLAN · {saved.intent.clanName} · {saved.intent.request.clanId}</span>
      <span>{destination(saved.intent)}</span><span>Command: {saved.intent.request.idempotencyKey}</span>
      {proof ? <>
        <strong>{proof.state === 'disbanded' ? `CLAN DISBANDED · ${proof.payoutShards} SHARDS credited to the original destination`
          : proof.state === 'left' ? 'LEFT ORIGINAL CLAN' : proof.state === 'kicked' ? 'ORIGINAL MEMBER REMOVED' : 'ORIGINAL COMMAND REFUSED — NO CHANGE'}</strong>
        {proof.refusalCode && <span>Server reason: {proof.refusalCode.replaceAll('_', ' ')}</span>}
        <span>Recorded: {proof.createdAt}</span>{proof.ledgerTransactionId && <span>Payout receipt: {proof.ledgerTransactionId}</span>}
        {saved.hydrated?.originalPayout === 'unavailable' && <span>The original payout balance is unavailable in the current account directory. The saved receipt still confirms its exact payout; no other base balance substitutes for it.</span>}
        {saved.hydrated && !saved.hydrated.membershipAvailable && <span>Current clan roster and standings need owned land. Historical command proof remains available.</span>}
        {!saved.hydrated && <span>The command is confirmed. Refresh its original account and destination before finishing.</span>}
        {!saved.finished && <Btn disabled={state.busy || !saved.hydrated} onClick={() => void controller.finish()}>FINISH REVIEW</Btn>}
        {saved.finished && <span>Review finished. This receipt stays saved until you explicitly review and confirm a new command.</span>}
      </> : <>
        <span>The original result is unconfirmed. Missing history or a changed roster does not prove failure.</span>
        <Btn disabled={state.busy || !state.supported} onClick={() => void controller.retry()}>RETRY ORIGINAL COMMAND</Btn>
      </>}
    </> : <span>Review leave or remove-member consent from your current roster before submitting.</span>}
    {state.loaded && !state.supported && <span>Saved clan management is unavailable on this server. Management stays read-only and any original command remains saved.</span>}
    <Btn variant="ghost" disabled={state.busy} onClick={() => void controller.open()}>CHECK ORIGINAL RECEIPT</Btn>
  </Card></section>;
}
