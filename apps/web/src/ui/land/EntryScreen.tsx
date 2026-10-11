/**
 * CLAIM YOUR LAND — the land purchase screen (M35 lane D, D-103).
 *
 * ONE JOB: pick a cell → the server reserves it → pay 0.2 SOL → the deed.
 * The parcel card is the centre of the screen and the four-stage rail says
 * where the player is; funding takes priority whenever the known balance cannot
 * cover the frozen price. The owner called the previous version "too much text".
 *
 * WHAT DID NOT CHANGE, on purpose:
 *  - usePayEntry owns the money state machine and the verify poll; this file
 *    only renders its outputs and calls reserve/submit.
 *  - The globe path (`CHOOSE YOUR LAND ON THE GLOBE` → map/world, back here
 *    with `landPurchase.earthCell` drafted) and the secure-random path are the
 *    hybrid the owner asked for; no wallet prompt opens before the server has
 *    shown the exact cell.
 *  - EXIT is always available. Leaving preserves the wallet-scoped intent;
 *    reopening resumes canonical verification without another payment.
 *    Sign-out retains its explicit confirmation.
 *  - The three contexts: the paywall (no base), a base without land, and an
 *    additional deed (FOUND ANOTHER KEEP, returns to BASES).
 *
 * `enterGame` and the faucet control are INJECTED by Overlay.tsx: they live
 * there next to the loader/recovery seam and the pinned faucet labels, and an
 * import back into Overlay would be a cycle through a module the tests mock.
 */
import { ECONOMY } from '@shardkeep/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useDevnetFaucet } from '../../auth/useDevnetFaucet';
import { usePayEntry, type LandReservation } from '../../auth/useEntry';
import { useGameEntryState } from '../../auth/gameEntry';
import { useLandFunding } from '../../auth/useLandFunding';
import { useSignOut } from '../../auth/useSignOut';
import { EVENTS, track } from '../../lib/analytics';
import { api, ApiError, type BasesDto } from '../../lib/api';
import { SOLANA_CLUSTER } from '../../lib/cluster';
import { bus } from '../../lib/events';
import { versionedPublicAsset } from '../../lib/version';
import { LAND_NO_MAP_NOTE } from '../../state/land';
import { clearBaseSnapshot, useApp } from '../../state/store';
import { HudPrimaryButton } from '../hudChrome';
import { MobileBackConfirm } from '../MobileBackConfirm';
import { usePortrait } from '../layout';
import { BarMini, Btn, COLORS as C, Icon, Phead } from '../primitives';
import { deedImageUrl } from '../screens/globe/parcelDetail';
import { useFetch } from '../useFetch';
import { useSolBalance } from '../useSolBalance';
import { fundingBalance, FundingChip, type FaucetControl, type FaucetView } from './FundingChip';
import { landFlowEvent, landStage } from './landFlow';
import { ParcelCard, type ParcelView } from './ParcelCard';
import { StageRail } from './StageRail';
import { UnlockTiles } from './UnlockTiles';

interface ClaimableDto { claimable: boolean; deedAssetId: string | null; reason: string }

// The TITLE key art, dimmed well below the panels: same brand PNGs, no new image.
const BG_PORTRAIT = versionedPublicAsset('/brand/brand_title_bg_portrait.png');
const BG_LANDSCAPE = versionedPublicAsset('/brand/brand_title_bg_landscape.png');

export interface EntryScreenProps {
  /** Overlay's post-payment entry: loads server state, recovers a live raid. */
  enterGame: () => Promise<{ ok: boolean }>;
  /** Overlay's DevnetSolClaim (D-098) and its view resolver, unchanged. */
  FaucetControl: FaucetControl;
  faucetView: FaucetView;
}

export function EntryScreen({ enterGame, FaucetControl, faucetView }: EntryScreenProps): React.JSX.Element {
  const entryPaid = useApp((s) => s.entryPaid);
  const landPurchase = useApp((s) => s.landPurchase);
  const setLandPurchase = useApp((s) => s.setLandPurchase);
  const setBaseDirectory = useApp((s) => s.setBaseDirectory);
  const setScreen = useApp((s) => s.setScreen);
  const setMapTab = useApp((s) => s.setMapTab);
  const setWorldIntent = useApp((s) => s.setWorldIntent);
  const wallet = useApp((s) => s.wallet);
  // The third state, from the server: a base the deedless player can go back to.
  // `base` is only ever set by a SUCCESSFUL GET /base (loadServerState), so this
  // is "the server opened a base for me", not "I hope it did".
  const hasBase = useApp((s) => s.base !== null);
  const purchaseKind = landPurchase?.kind ?? 'entry';
  const additionalDeed = purchaseKind === 'deed';
  const port = usePortrait();
  const signOut = useSignOut();
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const { busy: entering, error: entryError } = useGameEntryState();

  // Payment credit permits play. Only the server deed asset marks minting done.
  const [creditedWallet, setCreditedWallet] = useState<string | null>(null);
  const purchaseDone = useCallback((r: LandReservation) => {
    setCreditedWallet(wallet);
    track(EVENTS.LAND_CREDITED, { kind: r.kind });
    setLandPurchase(null);
    if (!additionalDeed) return;
    setBaseDirectory(null);
    setScreen('bases');
    bus.emit('ui:toast', { msg: 'PAYMENT CONFIRMED — YOUR DEED IS MINTING' });
  }, [wallet, additionalDeed, setBaseDirectory, setLandPurchase, setScreen]);
  const { reserve, submit, retryPayment, canRetryEntry, retryEntryInSec, reservationRetryInSec: retryRemaining, reservation, phase, error, paymentSignature, isEmbedded } = usePayEntry(purchaseKind, purchaseDone);
  /** A globe cell chosen but not yet reserved (the map's CHOOSE THIS LAND). */
  const fantasy = import.meta.env.VITE_FEATURE_FANTASY_WORLD === '1';
  // An old unreserved draft cannot become a new Earth quote after cutover.
  // Existing paid/pending reservations are restored separately by usePayEntry.
  const drafted = landPurchase?.landAddress ?? (fantasy ? null : landPurchase?.earthCell ?? null);
  const draftedLabel = typeof drafted === 'object' && drafted !== null ? `TILE ${drafted.tileId}` : `CELL ${drafted}`;

  // A wallet that BOUGHT a Land Deed on an external marketplace already owns a
  // base — it must claim it, not pay entry again. The server verifies deed
  // ownership on-chain at claim time; this is only the affordance.
  const { data: claim, reload: reloadClaim } = useFetch<ClaimableDto>(
    () => api.get<ClaimableDto>('/base/claimable'), [wallet],
  );
  const [claiming, setClaiming] = useState(false);
  const doClaim = (): void => {
    setClaiming(true);
    void api.postRaw<{ claimed: boolean }>('/base/claim')
      .then((r) => {
        if (useApp.getState().wallet !== wallet) return;
        if (!r.claimed) { bus.emit('ui:toast', { msg: 'NOTHING TO CLAIM YET' }); reloadClaim(); return; }
        bus.emit('ui:toast', { msg: 'BASE CLAIMED' });
        useApp.getState().setEntryPaid(true);
        return enterGame();
      })
      .catch((e: unknown) => bus.emit('ui:toast', {
        msg: e instanceof ApiError ? e.message.toUpperCase() : 'CLAIM FAILED — TRY AGAIN',
      }))
      .finally(() => setClaiming(false));
  };

  // Live SOL balance so a freshly funded wallet (faucet / transfer / on-ramp)
  // shows up without a reload. Fast 10 s cadence is deliberate: this screen is
  // short-lived and funding-latency-critical.
  const rpcSol = useSolBalance(wallet, 10_000);
  // D-098: the in-game faucet lives where the SOL is needed. On any cluster but
  // devnet the hook is inert and the injected control renders nothing.
  const faucet = useDevnetFaucet(wallet, SOLANA_CLUSTER === 'devnet');

  const paymentCredited = (wallet !== null && creditedWallet === wallet) || phase === 'credited' || (entryPaid && !additionalDeed);
  const retryEntry = useCallback(() => {
    void enterGame().then((result) => {
      if (!result.ok) bus.emit('ui:toast', { msg: 'STILL CONNECTING — RETRY ENTERING GAME' });
    }).catch(() => bus.emit('ui:toast', { msg: 'STILL CONNECTING — RETRY ENTERING GAME' }));
  }, [enterGame]);
  const fundingQuote = useLandFunding(wallet, paymentCredited ? null : reservation);
  const sol = fundingBalance(faucet, rpcSol);
  const requiredLamports = fundingQuote.estimate?.requiredLamports
    ?? reservation?.amountLamports ?? Math.round(ECONOMY.entryFeeSol * 1e9);
  const needsFunding = sol !== null && sol < requiredLamports / 1e9;
  const { data: paidDirectory, reload: refreshDeed } = useFetch<BasesDto | null>(
    () => paymentCredited ? api.get<BasesDto>('/bases') : Promise.resolve(null), [wallet, paymentCredited],
  );
  const deedAssetId = reservation && paidDirectory?.bases?.find((base) => base.id === reservation.baseId)?.deedAssetId;
  const deedReady = Boolean(deedAssetId);
  useEffect(() => {
    if (!paymentCredited || deedReady) return;
    const timer = setInterval(refreshDeed, 10_000);
    return () => clearInterval(timer);
  }, [paymentCredited, deedReady, refreshDeed]);
  // A credit is final even while deed authority or base loading catches up.
  useEffect(() => {
    if (!entryPaid || additionalDeed) return;
    setLandPurchase(null);
    retryEntry();
  }, [entryPaid, additionalDeed, setLandPurchase, retryEntry]);

  // Expired / failed are reported by the hook's SHAPE, not a callback; the
  // pure rule in landFlow.ts turns the transition into one event each.
  const prevPhase = useRef(phase);
  useEffect(() => {
    const event = landFlowEvent(prevPhase.current, { phase, reservation, error });
    prevPhase.current = phase;
    if (event) track(event, { kind: purchaseKind });
  }, [phase, reservation, error, purchaseKind]);

  const toGlobe = (): void => { setMapTab('world'); setWorldIntent('choose-land'); setScreen('map'); };
  const reserveDrafted = (): void => {
    if (drafted === null) return;
    track(EVENTS.LAND_RESERVE, { kind: purchaseKind, mode: 'globe' });
    void reserve(drafted);
  };
  const reserveRandom = (): void => {
    track(EVENTS.LAND_RESERVE, { kind: purchaseKind, mode: 'random' });
    void reserve();
  };
  const pay = (): void => {
    track(EVENTS.LAND_PAY, { kind: purchaseKind });
    void submit();
  };
  const back = (): void => {
    // A missing cached base must go through fresh ownership selection. The
    // authenticated title auto-enters the game and would reopen this checkout.
    if (!hasBase) clearBaseSnapshot(false);
    setScreen(additionalDeed || !hasBase ? 'bases' : 'base');
    if (hasBase && !additionalDeed) bus.emit('base:refresh', undefined);
  };

  const stage = landStage({ phase, reservation, drafted: drafted !== null, paymentCredited, deedReady });
  const parcel: ParcelView = paymentCredited && reservation
    ? deedReady ? { kind: 'minted', reservation, imageUrl: deedAssetId ? deedImageUrl(`/deed/asset/${encodeURIComponent(deedAssetId)}.png`) : null }
      : { kind: 'paid', reservation }
    : reservation ? { kind: 'reserved', reservation }
      : drafted !== null ? typeof drafted === 'number' ? { kind: 'drafted', earthCell: drafted } : { kind: 'fantasy-drafted', tileId: drafted.tileId }
        : { kind: 'empty' };
  // Signing out still uses its existing confirmation; EXIT preserves recovery.
  const busy = phase === 'paying' || phase === 'confirming';
  const reserving = phase === 'reserving';
  // The pitch is for someone deciding whether to buy land at all; a player
  // founding ANOTHER keep already owns it.
  const showPitch = !additionalDeed;
  const headline = additionalDeed ? 'FOUND ANOTHER KEEP' : 'CLAIM YOUR LAND';

  const networkLabel = SOLANA_CLUSTER === 'devnet' ? 'DEVNET' : 'MAINNET';

  const actions = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {/* Deed buyer: claim the base the deed conveys instead of paying entry.
          Only shown when the SERVER says this wallet has one waiting. */}
      {!additionalDeed && claim?.claimable && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ color: C.textFaint, fontSize: 13, textAlign: 'center', lineHeight: 1.35 }}>
            THIS WALLET HOLDS A LAND DEED FOR AN EXISTING BASE. CLAIMING MOVES ITS STRUCTURES,
            LAND AND PROGRESS TO YOU — NEVER THE SELLER&apos;S BALANCES.
          </div>
          <Btn variant="gold" fontSize={22} disabled={claiming} onClick={doClaim}>
            {claiming ? 'CLAIMING…' : 'CLAIM YOUR BASE'}
          </Btn>
        </div>
      )}
      {paymentCredited ? (
        <div data-tutorial-target="land-enter">
          <div role="status" style={{ color: C.success, textAlign: 'center', marginBottom: 8 }}>PAYMENT COMPLETE — YOUR LAND IS SECURED</div>
          {reservation && !deedReady && <div role="status" style={{ color: C.textDim, textAlign: 'center', marginBottom: 8 }}>YOUR DEED IS MINTING. YOU CAN ENTER AND KEEP PLAYING.</div>}
          <HudPrimaryButton disabled={entering} onClick={retryEntry}>
            {entering ? 'ENTERING GAME…' : 'RETRY ENTERING GAME'}
          </HudPrimaryButton>
          {entryError && <div role="alert" style={{ color: C.gold, marginTop: 8 }}>{entryError}</div>}
        </div>
      ) : phase === 'restoring' ? (
        <div role="status">RESTORING YOUR RESERVED LAND…</div>
      ) : phase === 'confirming' ? (
        <div data-tutorial-target="land-confirming" role="status" style={{ color: C.gold, fontSize: 19, textAlign: 'center', letterSpacing: '2px' }}>
          CONFIRMING ON-CHAIN… <BarMini pct={100} />
          <div style={{ color: C.textFaint, fontSize: 14, marginTop: 6, letterSpacing: 0 }}>
            {paymentSignature
              ? `Checking finality on ${networkLabel} — your payment signature is saved.`
              : `CHECKING YOUR PAYMENT ON ${networkLabel}. A wallet response does not yet confirm that payment reached this network.`}
            <div style={{ marginTop: 6 }}>
              If you changed wallet networks, we still check the original reservation before allowing another payment.
              {!additionalDeed && retryEntryInSec !== null && retryEntryInSec !== undefined && retryEntryInSec > 0
                ? ` First-land retry available in ${Math.floor(retryEntryInSec / 60)}:${String(retryEntryInSec % 60).padStart(2, '0')}.`
                : retryRemaining !== null && retryRemaining > 0 && !canRetryEntry
                  ? ` Reservation release check in ${Math.floor(retryRemaining / 60)}:${String(retryRemaining % 60).padStart(2, '0')}.`
                  : ' Checking whether payment completed or the unpaid reservation can be released.'}
              {' '}A delayed network check can take longer. Your reservation is saved; reloading resumes this check.
            </div>
            {canRetryEntry && <div style={{ marginTop: 10 }}>
              <Btn variant="gold" fontSize={17} onClick={() => { void retryPayment(); }}>RETRY FIRST-LAND PAYMENT</Btn>
              <div style={{ fontSize: 13, marginTop: 6 }}>SAME PARCEL · WE CHECK PAYMENT FIRST. THE FIRST-LAND PRICE CANNOT BE CHARGED TWICE; NETWORK FEES MAY APPLY.</div>
            </div>}
            {paymentSignature && <button type="button" className="interactive" onClick={() => {
              void navigator.clipboard?.writeText(paymentSignature).then(() => bus.emit('ui:toast', { msg: 'PAYMENT SIGNATURE COPIED' })).catch(() => null);
            }} style={{ display: 'block', margin: '8px auto', minHeight: 44, background: C.surface, color: C.text, border: `2px solid ${C.border}`, overflowWrap: 'anywhere' }}>
              {paymentSignature.slice(0, 8)}…{paymentSignature.slice(-8)} · COPY PAYMENT
            </button>}
          </div>
        </div>
      ) : reservation ? (
        phase !== 'failed' && (
          <div data-tutorial-target={needsFunding ? undefined : 'land-pay'}
            data-tutorial-pending={phase === 'paying' ? (isEmbedded ? 'signing' : 'wallet-approval') : undefined}>
          <div role="note" style={{ color: C.gold, fontSize: 14, lineHeight: 1.4, marginBottom: 8 }}>
            {isEmbedded ? `THIS PAYMENT USES SOLANA ${networkLabel}.` : SOLANA_CLUSTER === 'devnet'
              ? 'USE SOLANA DEVNET IN YOUR WALLET. In Backpack, turn on Developer Mode and select Devnet before confirming.'
              : 'USE SOLANA MAINNET IN YOUR WALLET.'}
          </div>
          <HudPrimaryButton disabled={phase === 'paying' || needsFunding} onClick={pay}>
            <Icon name="sol" size={20} />
            {phase === 'paying' ? (isEmbedded ? 'SIGNING…' : 'CONFIRM IN WALLET…') : `PAY ${(reservation.amountLamports / 1e9).toFixed(2)} SOL`}
          </HudPrimaryButton>
          {needsFunding && <div role="status" style={{ color: C.gold, fontSize: 14, marginTop: 6 }}>ADD SOL ABOVE TO ENABLE PAYMENT. YOUR CELL IS RESERVED.</div>}
          {phase === 'ready' && <div role="status" style={{ color: C.textDim, fontSize: 13, marginTop: 6 }}>
            {fundingQuote.estimate
              ? `ESTIMATED TOTAL ${(fundingQuote.estimate.requiredLamports / 1e9).toFixed(6)} SOL · PAYMENT + NETWORK FEE${fundingQuote.estimate.accountRentLamports ? ' + ACCOUNT RENT' : ''}`
              : fundingQuote.unavailable ? 'FEE ESTIMATE UNAVAILABLE. PAY CHECKS FUNDING BEFORE WALLET APPROVAL.' : 'CHECKING NETWORK FEE AND ACCOUNT RENT…'}
            {fundingQuote.unavailable && <button type="button" className="interactive" onClick={fundingQuote.refresh} style={{ minHeight: 44, display: 'block' }}>RETRY FEE CHECK</button>}
          </div>}
          {isEmbedded && <div style={{ color: C.textDim, fontSize: 13, marginTop: 6 }}>ONE TAP PAYS {(reservation.amountLamports / 1e9).toFixed(2)} SOL PLUS NETWORK FEE — NO SECOND PROMPT.</div>}
          </div>
        )
      ) : drafted !== null ? (
        <>
          <div data-tutorial-target="land-reserve"><HudPrimaryButton disabled={reserving} onClick={reserveDrafted}>
            {reserving ? 'CHECKING AVAILABILITY…' : `RESERVE ${draftedLabel}`}
          </HudPrimaryButton></div>
          <Btn variant="sec" fontSize={17} disabled={reserving} onClick={toGlobe}>PICK A DIFFERENT SPOT</Btn>
          <Btn variant="ghost" fontSize={17} disabled={reserving} onClick={reserveRandom}>
            {reserving ? 'SECURING LAND…' : fantasy ? 'SECURE A RANDOM TILE' : 'SECURE A RANDOM CELL'}
          </Btn>
        </>
      ) : (
        <>
          {/* GLOBE FIRST (owner 2026-08-16): raw cell numbers mean nothing to a
              human; the globe shows the pixel Earth and returns here with the
              chosen cell drafted. */}
          <div data-tutorial-target="land-pick"><HudPrimaryButton disabled={reserving} onClick={toGlobe}>
            <Icon name="map" size={20} />
            CHOOSE YOUR LAND ON THE GLOBE
          </HudPrimaryButton></div>
          <Btn variant="sec" fontSize={17} disabled={reserving} onClick={reserveRandom}>
            {reserving ? 'SECURING LAND…' : fantasy ? 'SECURE A RANDOM TILE' : 'SECURE A RANDOM CELL'}
          </Btn>
          <div style={{ color: C.textFaint, fontSize: 12, lineHeight: 1.35, textAlign: 'center' }}>
            NO WALLET PROMPT OPENS UNTIL THE SERVER SHOWS YOUR EXACT {fantasy ? 'TILE' : 'CELL'}.
          </div>
        </>
      )}
      {error && (
        <div role="alert" style={{ color: C.danger, textAlign: 'center', fontSize: 15, lineHeight: 1.35 }}>{error}</div>
      )}
    </div>
  );

  const funding = wallet && !busy && !paymentCredited && phase !== 'restoring' && phase !== 'failed' && (
    <div data-tutorial-target={needsFunding ? "land-funding" : undefined}><FundingChip wallet={wallet} rpcSol={rpcSol} faucet={faucet} FaucetControl={FaucetControl} faucetView={faucetView}
      requiredLamports={requiredLamports} feeKnown={fundingQuote.estimate !== null} /></div>
  );

  const pitch = showPitch && (
    <>
      <UnlockTiles columns={port ? 3 : 2} />
      <div style={{ color: C.textFaint, fontSize: 12, lineHeight: 1.35, textAlign: 'center' }}>{LAND_NO_MAP_NOTE}</div>
    </>
  );

  // Navigation never discards a payment. An unmounted hook stops its local
  // requests; the worker and the next checkout mount reconcile the same intent.
  const nav = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'center' }}>
      {hasBase && (
        <Btn variant="sec" fontSize={17} style={{ alignSelf: 'stretch' }} onClick={back}>
          {additionalDeed ? 'BACK TO YOUR BASES' : 'BACK TO BASE'}
        </Btn>
      )}
      {!busy && <Btn variant="ghost" fontSize={15} style={{ color: C.textFaint, border: 'none', padding: '6px 10px', minHeight: 44 }}
        onClick={() => setConfirmSignOut(true)}>
        SIGN OUT / SWITCH ACCOUNT
      </Btn>}
      {(busy || phase === 'restoring') && <div style={{ color: C.textFaint, fontSize: 13, lineHeight: 1.4, textAlign: 'center' }}>
        EXIT KEEPS YOUR RESERVATION AND PAYMENT SAVED. RETURN HERE TO RESUME CHECKING.
      </div>}
    </div>
  );

  const column = (children: React.ReactNode, style?: React.CSSProperties): React.JSX.Element => (
    <div style={{
      flex: '1 1 0', minWidth: 0, minHeight: 0, overflowY: 'auto',
      display: 'flex', flexDirection: 'column', gap: 10, ...style,
    }}>
      {children}
    </div>
  );

  return (
    <div className="interactive" style={{ position: 'absolute', inset: 0, background: C.bg, overflow: 'hidden' }}>
      <img src={port ? BG_PORTRAIT : BG_LANDSCAPE} alt="" aria-hidden="true" loading="eager" decoding="sync"
        style={{
          position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover',
          imageRendering: 'pixelated', filter: 'brightness(.35)',
        }} />
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column' }}>
        {/* Safe-area is INNER padding on the ink header so the plate still
            reaches the physical edges on a notched device. */}
        <div style={{
          background: C.ink, flex: 'none',
          paddingTop: 'env(safe-area-inset-top)', paddingLeft: 'env(safe-area-inset-left)', paddingRight: 'env(safe-area-inset-right)',
        }}>
          <Phead title={headline} fontSize={port ? 24 : 20} right={
            <button type="button" className="interactive" aria-label="Exit land purchase" onClick={back}
              style={{ minWidth: 64, minHeight: 44, marginLeft: 8, flexShrink: 0, border: `2px solid ${C.borderLt}`, background: C.surface, color: C.gold, fontFamily: 'inherit', fontSize: 17, cursor: 'pointer' }}>
              EXIT
            </button>
          } />
          <div style={{ padding: port ? '7px 14px 8px' : '5px 14px 6px', borderBottom: `2px solid ${C.borderLt}` }}>
            <StageRail stage={stage} />
          </div>
        </div>
        {port ? (
          // PORTRAIT: one scrolling column — card, actions, funding, pitch, nav.
          <div style={{
            flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10,
            padding: '10px 14px calc(14px + env(safe-area-inset-bottom))',
          }}>
            <div data-onboarding-caption-slot="entry" />
            {(!paymentCredited || reservation) && <ParcelCard view={parcel} />}
            {needsFunding && !paymentCredited && funding}
            {actions}
            {(!needsFunding || paymentCredited) && funding}
            {pitch}
            {nav}
          </div>
        ) : (
          // LANDSCAPE: parcel card (and the pitch) left, actions right. Each
          // column scrolls on its own — a ~311px Seeker webview cannot show
          // either whole, and a player who cannot reach PAY cannot buy.
          <div style={{
            flex: 1, minHeight: 0, display: 'flex', gap: 14,
            padding: '8px calc(14px + env(safe-area-inset-right)) calc(8px + env(safe-area-inset-bottom)) calc(14px + env(safe-area-inset-left))',
          }}>
            {column(<>{(!paymentCredited || reservation) && <ParcelCard view={parcel} />}{pitch}</>)}
            {column(<><div data-onboarding-caption-slot="entry" />{needsFunding && !paymentCredited && funding}{actions}{(!needsFunding || paymentCredited) && funding}{nav}</>, { maxWidth: 420 })}
          </div>
        )}
      </div>
      {confirmSignOut && <MobileBackConfirm title="SIGN OUT?" body="Your progress and reserved land stay with this wallet. Sign in with the same account to continue." confirmLabel="SIGN OUT"
        onCancel={() => setConfirmSignOut(false)} onConfirm={() => { setConfirmSignOut(false); void signOut(); }} />}
    </div>
  );
}
