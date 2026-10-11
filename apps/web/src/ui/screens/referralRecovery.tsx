import { useEffect, useState } from 'react';
import { useReferralRecovery } from '../../auth/useReferralRecovery';
import { clearStoredReferralCode, readStoredReferralCode } from '../../lib/referral';
import type { ReferralController, ReferralState } from '../../lib/referrals/controller';
import { Btn, Card, COLORS as C } from '../primitives';

export function ReferralRecoveryPanel({ controller, state, legacy, retryLegacy, initialCode = '' }: {
  controller: ReferralController; state: ReferralState; legacy(code: string): Promise<void>; retryLegacy(): Promise<void>; initialCode?: string;
}): React.JSX.Element {
  const [input, setInput] = useState(initialCode); const [legacyBusy, setLegacyBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const runLegacyRetry = async (): Promise<void> => {
    setLegacyBusy(true); setNotice(null);
    try { await retryLegacy(); } catch (error) { setNotice(error instanceof Error ? error.message : 'The original referral remains saved.'); }
    finally { setLegacyBusy(false); }
  };
  const saved = state.journal; const busy = state.busy || legacyBusy;
  useEffect(() => {
    const back = (event: KeyboardEvent): void => { if (event.key === 'Escape' && controller.snapshot().review) { event.preventDefault(); event.stopPropagation(); controller.dismiss(); } };
    window.addEventListener('keydown', back, true); return () => window.removeEventListener('keydown', back, true);
  }, [controller]);
  useEffect(() => {
    // An observed existing binding does not identify which captured code made it.
    if (saved?.code && ['applied', 'already_applied'].includes(saved.outcome ?? '')) clearStoredReferralCode(saved.code);
  }, [saved?.code, saved?.outcome]);
  const submitLegacy = async (): Promise<void> => {
    if (!input.trim() || busy) return;
    setLegacyBusy(true); setNotice(null);
    try { await legacy(input.trim()); setNotice('Referral submitted. This server does not provide saved attribution receipts.'); clearStoredReferralCode(input.trim()); }
    catch (error) { setNotice(error instanceof Error ? error.message : 'Referral did not complete.'); }
    finally { setLegacyBusy(false); }
  };
  return <section aria-label="Optional referral"><Card style={{ padding: 12, gap: 10, overflowWrap: 'anywhere' }}>
    <strong style={{ color: C.goldHi }}>OPTIONAL REFERRAL</strong>
    {(state.error || notice) && <div role="status" style={{ color: C.textDim }}>{state.error ?? notice}</div>}
    {!state.loaded ? <span>Reading saved referral status…</span> : saved?.legacy && (saved.code || !saved.relationship) ? <>
      <span>SAVED ORIGINAL CODE · {saved.legacy.code}</span>
      <span>{saved.legacy.result ? saved.legacy.route === '/alpha/referral' ? 'The original alpha admission response was confirmed. Current access is checked by the server.' : 'The original referral submission was confirmed by the server.'
        : saved.legacy.route === '/alpha/referral' ? 'The original alpha admission request is unconfirmed. Return to the invite screen to retry its exact code. Referral attribution alone does not prove admission.' : 'The original referral submission is unconfirmed. Check status or explicitly retry its same original route and code.'}</span>
      {saved.relationship && <span>The server confirms attribution to {saved.relationship.referrerWallet}. This does not identify which code created it.</span>}
      {!saved.legacy.result && saved.legacy.route === '/referrals/use' && !saved.relationship && <Btn disabled={busy} onClick={() => void runLegacyRetry()}>RETRY ORIGINAL CODE</Btn>}
      {saved.code && (saved.legacy.result || saved.relationship && saved.legacy.route === '/referrals/use') && <Btn disabled={busy} onClick={() => void controller.finish()}>FINISH REVIEW</Btn>}
    </> : saved?.relationship ? <>
      <span>{saved.outcome === 'applied' ? 'Your referral attribution was applied.'
        : saved.outcome === 'already_applied' ? 'This referral was already applied.'
          : saved.outcome === 'already_bound' ? 'Your account was already attributed. This code did not change its referrer.'
            : 'The server confirms your existing referral attribution. This does not prove which code created it.'}</span>
      <span>Referrer: {saved.relationship.referrerWallet}</span><span>Recorded: {saved.relationship.createdAt}</span>
      {saved.code && <><span>Submitted code: {saved.code}</span><Btn disabled={busy} onClick={() => void controller.finish()}>FINISH REVIEW</Btn></>}
      <span style={{ fontSize: 13, color: C.textFaint }}>Attribution cannot be changed later. Qualification and mining bonuses follow server state.</span>
    </> : saved?.code ? <>
      <span>SAVED CODE · {saved.code}</span><span>The result is still unconfirmed. A missing relationship does not mean the submission failed.</span>
      <Btn disabled={busy || !state.supported} onClick={() => void controller.retry()}>RETRY SAME CODE</Btn>
    </> : state.review ? <>
      <strong>REVIEW · {state.review}</strong><span>This attributes your account to the code's referrer. Attribution cannot be changed later.</span>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}><Btn disabled={busy} onClick={() => void controller.confirm()}>CONFIRM REFERRAL</Btn>
        <Btn variant="ghost" onClick={() => controller.dismiss()}>BACK</Btn></div>
    </> : !saved?.legacy && (state.supported || (!saved?.activated && !state.error)) ? <>
      {!state.supported && <span style={{ fontSize: 13 }}>This server supports the original referral entry. Saved attribution recovery is unavailable.</span>}
      <input aria-label="Optional referral code" className="interactive" value={input} onChange={(e) => setInput(e.target.value)} placeholder="OPTIONAL REFERRAL CODE"
        style={{ minWidth: 0, width: '100%', boxSizing: 'border-box', fontFamily: 'inherit', fontSize: 16, background: C.surface, color: C.text, border: `2px solid ${C.border}`, padding: 8 }} />
      <Btn disabled={busy || !input.trim()} onClick={() => state.supported ? void controller.review(input) : void submitLegacy()}>{state.supported ? 'REVIEW CODE' : 'USE CODE'}</Btn>
    </> : <span>Saved referral recovery is unavailable on this server. Your original record is retained.</span>}
    <Btn variant="ghost" disabled={busy} onClick={() => void controller.open()}>CHECK REFERRAL STATUS</Btn>
  </Card></section>;
}
export function ReferralEntry(): React.JSX.Element | null {
  const { controller, state, legacy, retryLegacy } = useReferralRecovery();
  return controller ? <ReferralRecoveryPanel key={controller.store.key} controller={controller} state={state} legacy={legacy} retryLegacy={retryLegacy} initialCode={readStoredReferralCode() ?? ''} /> : null;
}
