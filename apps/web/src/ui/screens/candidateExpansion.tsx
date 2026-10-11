import { useEffect, useMemo, useRef, useState } from 'react';
import { CAPS } from '@shardkeep/shared';
import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import { api, API_URL } from '../../lib/api';
import { BUILD } from '../../lib/version';
import { CandidateExpansion, CANDIDATE_ORIGIN, candidateExpansionBuild, type SavedExpansion } from '../../lib/candidateExpansion';
import { captureBaseSnapshotGuard, isBaseSnapshotGuardCurrent, useApp } from '../../state/store';
import { reloadBase } from '../../state/baseSnapshot';
import { BODY_TEXT_STYLE, Btn, Chip, COLORS as C, ModalWrap, Phead } from '../primitives';

export const candidateExpansionConfigured = (): boolean => import.meta.env.VITE_PKW_CANDIDATE_ORIGIN !== undefined;
const home = (): void => useApp.getState().setScreen('base');

export function CandidateExpandScreen(): React.JSX.Element {
  const wallet = useApp(s => s.wallet);
  const base = useApp(s => s.base);
  const epoch = useApp(s => s.baseSelectionEpoch);
  return <CandidateExpandSelection key={JSON.stringify([wallet, base?.baseId, epoch])} />;
}

function CandidateExpandSelection(): React.JSX.Element {
  const base = useApp(s => s.base); const wallet = useApp(s => s.wallet);
  const guard = useRef(captureBaseSnapshotGuard()); const mounted = useRef(true);
  const [saved, setSaved] = useState<SavedExpansion | null>(null);
  const [busy, setBusy] = useState('Checking expansion…');
  const [error, setError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState(false);
  const [available, setAvailable] = useState(false);
  const current = (): boolean => mounted.current && isBaseSnapshotGuardCurrent(guard.current);
  const controller = useMemo(() => {
    if (!wallet || !base?.baseId || !candidateExpansionBuild(import.meta.env.VITE_PKW_CANDIDATE_ORIGIN,
      window.location.origin, API_URL, BUILD.gitSha) || !navigator.locks) return null;
    return new CandidateExpansion({ origin: CANDIDATE_ORIGIN, sourceSha: BUILD.gitSha, wallet, baseId: base.baseId }, {
      storage: { getItem: key => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value) },
      lock: async (name, work) => await navigator.locks.request(name, work), key: () => crypto.randomUUID(),
      assertCurrent: () => { if (!current()) throw new Error('Return to the original account and base to check this expansion.'); },
      get: path => api.get(path, { isCurrent: current }), post: (path, body) => api.postRaw(path, body, { isCurrent: current }),
    });
    // The parent remounts on account, base and selection epoch changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const refresh = async (): Promise<void> => {
    if (!current()) return;
    try { await reloadBase(); if (current()) setRefreshError(false); }
    catch { if (current()) setRefreshError(true); }
  };
  const apply = async (value: SavedExpansion | null): Promise<void> => {
    if (!current()) return;
    setSaved(value); setAvailable(true);
    if (value?.state?.status === 'granted') await refresh();
  };
  const run = (label: string, action: () => Promise<SavedExpansion | null>): void => {
    if (!controller || busy || !current()) return;
    setBusy(label); setError(null);
    void action().then(apply).catch((cause: unknown) => {
      if (current()) setError(cause instanceof Error ? cause.message : 'Your expansion could not be checked. Try again.');
    }).finally(() => { if (current()) setBusy(''); });
  };
  useEffect(() => {
    mounted.current = true;
    if (!controller) { setError('Test expansions are unavailable in this build or browser.'); setBusy(''); }
    else void controller.check().then(apply).catch((cause: unknown) => {
      if (current()) setError(cause instanceof Error ? cause.message : 'Your expansion could not be checked.');
    }).finally(() => { if (current()) setBusy(''); });
    return () => { mounted.current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller]);
  const state = saved?.state; const quote = state?.quote; const receipt = state?.receipt;
  const index = base?.player.expansions;
  const size = index === undefined ? undefined : CAPS.claimTilesByExpansion[index];
  const maxed = index !== undefined && index >= CAPS.expansionsMax;
  const pending = !!saved && state?.status !== 'granted' && state?.status !== 'cancelled';
  const readyQuote = state?.status === 'quoted' && quote;
  // Lamport decimal formatting is exact; no floating-point price rounding.
  const unit = BigInt(LAMPORTS_PER_SOL);
  const referencePrice = quote ? (BigInt(quote.offer.referencePriceLamports) / unit).toString()
    + (BigInt(quote.offer.referencePriceLamports) % unit ? `.${(BigInt(quote.offer.referencePriceLamports) % unit).toString().padStart(String(LAMPORTS_PER_SOL).length - 1, '0').replace(/0+$/, '')}` : '') : '';
  return <ModalWrap onBackdrop={home}>
    <Phead title="EXPAND YOUR KINGDOM" onClose={home} />
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Chip accent={C.goldDp}>TEST KINGDOM · NO SOL CHARGE</Chip>
      {size !== undefined && <div style={{ fontSize: 24 }}>Current building area · {size} × {size}</div>}
      {receipt ? <div role="status" style={{ ...BODY_TEXT_STYLE, padding: 16, border: `1px solid ${C.goldDp}` }}>
        <strong style={{ color: C.goldHi }}>Test expansion applied</strong>
        <div>{receipt.fromClaimTiles} × {receipt.fromClaimTiles} → {receipt.toClaimTiles} × {receipt.toClaimTiles}</div>
        <div>No SOL was charged.</div>
      </div> : readyQuote ? <>
        <div style={{ fontSize: 30, color: C.goldHi }}>{quote.offer.fromClaimTiles} × {quote.offer.fromClaimTiles} → {quote.offer.toClaimTiles} × {quote.offer.toClaimTiles}</div>
        <p style={{ ...BODY_TEXT_STYLE, margin: 0 }}>More room to build, available immediately. Buildings stay in place.</p>
        <p style={{ ...BODY_TEXT_STYLE, margin: 0 }}>Game price: {referencePrice} SOL. This test expansion is free.</p>
      </> : <p style={{ ...BODY_TEXT_STYLE, margin: 0 }}>{maxed ? 'Your kingdom has reached its largest building area.'
        : pending ? 'Your original expansion is saved. Check its outcome before starting another.'
          : 'Review the next expansion to make more room for your kingdom. No wallet payment is needed in this test.'}</p>}
      {busy && <div role="status" style={BODY_TEXT_STYLE}>{busy}</div>}
      {error && <div role="alert" style={{ ...BODY_TEXT_STYLE, color: C.danger }}>{error}</div>}
      {refreshError && <div role="status" style={BODY_TEXT_STYLE}>Your expansion succeeded. The base view has not refreshed yet.
        <Btn variant="ghost" onClick={() => { void refresh(); }}>REFRESH BASE</Btn></div>}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {readyQuote && saved && <Btn disabled={!!busy || !!error} onClick={() => run('Expanding your kingdom…', () => controller!.confirm(saved.request.idempotencyKey, quote.quoteHash))}>
          {saved.confirmedHash ? 'RETRY SAVED EXPANSION' : 'APPLY TEST EXPANSION'}
        </Btn>}
        {(!saved || !pending) && !maxed && <Btn disabled={!!busy || !available || !!error || refreshError || index === undefined || (!!receipt && index < receipt.toExpansions)}
          onClick={() => run('Preparing your expansion…', () => controller!.start(index!))}>REVIEW EXPANSION</Btn>}
        {saved && (!state || state.status === 'unquoted') && <Btn disabled={!!busy || !!error}
          onClick={() => run('Checking saved request…', () => controller!.retryQuote(saved.request.idempotencyKey))}>RETRY SAVED REQUEST</Btn>}
        {controller && <Btn variant="ghost" disabled={!!busy} onClick={() => run('Checking expansion…', () => controller.check())}>CHECK STATUS</Btn>}
        {pending && saved && <Btn variant="ghost" disabled={!!busy} onClick={() => run('Checking cancellation…', () => controller!.cancel(saved.request.idempotencyKey))}>CANCEL EXPANSION</Btn>}
      </div>
      {receipt && <details style={{ ...BODY_TEXT_STYLE, overflowWrap: 'anywhere' }}><summary>Expansion details</summary>
        <div>Test receipt: {receipt.id}</div><div>Base: {receipt.baseId}</div><div>Accepted: {receipt.acceptedAt}</div>
      </details>}
    </div>
  </ModalWrap>;
}
