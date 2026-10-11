import { useEffect, useSyncExternalStore } from 'react';
import { mutationGate } from '../lib/mutationGate';
import { HEROES, HERO_KEYS } from '@shardkeep/shared';
import type { HeroRecruitmentController, HeroRecruitmentState } from '../lib/heroRecruitment/controller';
import { useMobileBackHandler } from '../lib/mobileBackGuard';
import { Btn, COLORS as C } from './primitives';
export function HeroRecruitmentPanel({ controller, state, actionsEnabled }: {
  controller: HeroRecruitmentController; state: HeroRecruitmentState; actionsEnabled: boolean;
}): React.JSX.Element {
  const gateOpen = useSyncExternalStore(mutationGate.subscribe, mutationGate.getSnapshot);
  const saved = state.journal, intent = state.review ?? saved?.intent;
  useMobileBackHandler(() => controller.dismiss(), !!state.review, 220);
  useEffect(() => {
    const back = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && controller.snapshot().review) { event.preventDefault(); event.stopPropagation(); controller.dismiss(); }
    };
    window.addEventListener('keydown', back, true); return () => window.removeEventListener('keydown', back, true);
  }, [controller]);
  const hero = intent ? HERO_KEYS.find(value => HEROES[value].altar === intent.request.type)! : null;
  const accepted = !!saved?.receipt || !!saved?.legacyAcceptance;
  return <section aria-label="Hero placement recovery" style={{ padding: 14, display: 'grid', gap: 10, overflowWrap: 'anywhere' }}>
    <strong style={{ color: C.goldHi }}>{state.review ? 'REVIEW HERO PLACEMENT' : 'ORIGINAL HERO PLACEMENT'}</strong>
    {state.error && <span role="alert" style={{ color: C.danger }}>{state.error}</span>}
    {intent && <>
      <span>{HEROES[hero!].name} · tile {intent.request.tx}, {intent.request.ty}</span>
      <span style={{ fontSize: 13 }}>Original base: {intent.request.baseId ?? 'wallet base'}</span>
      {state.review ? <>
        <span>{intent.request.heroContractOnly ? 'Use a Hero contract only. No Gems or KEEP authorized.'
          : intent.expectedCurrency ? `Use a contract first, otherwise up to ${intent.request.maxCostKeep} ${intent.expectedCurrency}. No other currency will be charged.`
          : intent.mechanism === 'v1' ? `Original consent: use a contract first, otherwise up to ${intent.request.maxCostKeep} KEEP.`
            : `Current quote: ${intent.request.maxCostKeep} KEEP. The server uses a Hero contract first. This server does not enforce a KEEP ceiling.`}</span>
        {intent.mechanism === 'legacy' && <span>This server has no saved Hero receipts. If its reply is interrupted, keep this request for support; a payment retry will be unavailable.</span>}
        <span>Accepting starts altar construction. The Hero becomes recruited after its builder job completes.</span>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <Btn disabled={state.busy || !actionsEnabled || !gateOpen} onClick={() => void controller.confirm()}>CONFIRM HERO PLACEMENT</Btn>
          <Btn variant="ghost" onClick={() => controller.dismiss()}>BACK</Btn>
        </div>
      </> : <>
        <span style={{ fontSize: 13 }}>Request: {intent.request.idempotencyKey}</span>
        {saved?.refusal ? <span role="status">PLACEMENT REFUSED — NOTHING SPENT. Review a new placement with current balances.</span> : accepted ? <>
          <strong>ALTAR CONSTRUCTION ACCEPTED</strong>
          <span>Acceptance does not mean the Hero is ready. Its current state follows the original base and roster.</span>
          {saved?.receipt && <>
            <span>{saved.receipt.funding.kind === 'contract' ? 'Hero contract used.' : `${saved.receipt.funding.amount} ${saved.receipt.funding.kind === 'gems' ? 'GEMS' : 'KEEP'} paid.`}</span>
            <span style={{ fontSize: 13 }}>Builder job finishes: {saved.receipt.job.finishesAt}</span>
          </>}
          {saved?.legacyAcceptance && <span>The original building response was saved. This legacy response contains no exact funding receipt.</span>}
          {saved?.hydrated ? <span>Original base: {saved.hydrated.base}. Items: {saved.hydrated.items}. Hero roster: {saved.hydrated.roster}.</span>
            : <span>Refreshing the original base, items and Hero roster is still pending.</span>}
          <Btn disabled={state.busy || !saved?.hydrated} onClick={() => void controller.finish()}>FINISH REVIEW</Btn>
        </> : <>
          <span>The original result is unconfirmed. A missing receipt or a current altar does not prove whether this request was accepted.</span>
          {intent.mechanism === 'v1'
            ? <Btn disabled={state.busy || !state.supported || !state.enabled || !actionsEnabled || !gateOpen} onClick={() => void controller.retry()}>RETRY SAME HERO PLACEMENT</Btn>
            : <span>Legacy payment retry is unavailable. Keep this request and contact support. Account refresh cannot prove its original payment.</span>}
        </>}
      </>}
    </>}
    {!state.loaded && <span>Reading saved Hero placement…</span>}
    <Btn variant="ghost" disabled={state.busy} onClick={() => void controller.open()}>CHECK HERO STATUS</Btn>
  </section>;
}
