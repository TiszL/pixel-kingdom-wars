/**
 * The connect sheet — the replacement for `useWalletModal().setVisible(true)`.
 *
 * wallet-adapter's modal lists wallet-standard wallets and nothing else, so on
 * iOS (no injected provider, and MWA never registers there) it renders its empty
 * state and the player is stranded on the title screen with no route forward.
 * This sheet is built from `connectOptions()` — a pure model of what THIS device
 * can do — so every branch ends somewhere useful.
 *
 * What this is NOT: it is discovery/entry UI only. Connecting still goes through
 * wallet-adapter/wallet-standard (select → connect), and signing in still goes
 * through useAuth / useSocialAuth untouched.
 */
import { useWallet } from '@solana/wallet-adapter-react';
import { WalletReadyState, type WalletName } from '@solana/wallet-adapter-base';
import { useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { bus, type WalletErrorNotice } from '../lib/events';
import { caps, playOrigin, playUrl } from '../lib/platform';
import {
  MOBILE_PHANTOM_WALLET_NAME, MobilePhantomAdapter,
} from '../auth/mobilePhantomAdapter';
import {
  connectError, connectOptions, orderInjected, PHANTOM_INTERNAL_ERROR_COPY,
  type ConnectOption, type SheetGroup,
} from './connectOptions';
import { Btn, COLORS as C, LinkBtn, ModalWrap, Phead } from './primitives';

/** wallet-standard-mobile's own adapter names (verified in the 0.5.3 bundle).
 *  They are wallet-standard wallets like any other, so they have to be filtered
 *  out of "injected" or an Android player sees CONNECT MOBILE WALLET ADAPTER
 *  twice — once as a fake extension row. */
const MWA = 'Mobile Wallet Adapter';
const MWA_REMOTE = 'Remote Mobile Wallet Adapter';

export interface ConnectUiState {
  pending: string | null;
  errors: Record<string, string>;
}

export type ConnectUiAction =
  | { type: 'choose'; walletName: string }
  | { type: 'provider-error'; notice: WalletErrorNotice }
  | { type: 'clear-pending' };

export const INITIAL_CONNECT_UI_STATE: ConnectUiState = { pending: null, errors: {} };

export function walletAttemptBusy(
  pending: string | null,
  providerConnecting: boolean,
  adapterConnecting = false,
): boolean {
  return pending !== null || providerConnecting || adapterConnecting;
}

/** Stable reconciliation identity. Wallet Standard adapters announce
 * asynchronously and supported wallets may insert ahead of an existing row;
 * index keys can otherwise turn the focused MetaMask button into Phantom. */
export function connectOptionKey(option: ConnectOption): string {
  switch (option.kind) {
    case 'adapter': return `adapter:${option.walletName}`;
    case 'mwa': return 'mwa';
    case 'deeplink': return `deeplink:${option.wallet}`;
    case 'social': return 'social';
    case 'install': return `install:${option.href}`;
    case 'refresh': return 'refresh';
  }
}

/** The provider owns connection; this reducer only associates its asynchronous
 * rejection with the row the player actually chose. Errors from another wallet
 * (or from a later transaction while no row is pending) are intentionally ignored. */
export function connectUiReducer(state: ConnectUiState, action: ConnectUiAction): ConnectUiState {
  switch (action.type) {
    case 'choose': {
      const errors = { ...state.errors };
      delete errors[action.walletName];
      return { pending: action.walletName, errors };
    }
    case 'provider-error': {
      const pending = state.pending;
      if (!pending) return state;
      if (action.notice.walletName !== null && action.notice.walletName !== pending) return state;
      return {
        pending: null,
        errors: { ...state.errors, [pending]: connectError(action.notice) },
      };
    }
    case 'clear-pending':
      return state.pending === null ? state : { ...state, pending: null };
  }
}

export function ConnectSheet({ onClose, social }: {
  onClose: () => void;
  /** the Privy social button, passed in by the caller. A prop rather than an
   *  import so this file has no dependency on Overlay (which imports it), and so
   *  the SEEKER call site — where a social login would mean linking the wrong
   *  wallet entirely — can simply not offer it. */
  social?: ReactNode;
}): React.JSX.Element {
  const {
    wallets, wallet, select, connect: connectSelectedWallet, connected, connecting,
  } = useWallet();
  const [{ pending, errors }, dispatchConnect] = useReducer(connectUiReducer, INITIAL_CONNECT_UI_STATE);
  const [mwaNotFound, setMwaNotFound] = useState(false);
  const [openGroup, setOpenGroup] = useState<number | null>(null);
  // React state disables rows after render; this ref closes the smaller window
  // in which two taps from one gesture can arrive before that render commits.
  const attemptStarted = useRef(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // Wallet presence is read HERE, reactively, not snapshotted in lib/platform:
  // wallet-standard wallets register asynchronously, so a load-time snapshot
  // says "no wallet" for any extension that announced itself 200ms late.
  const injected = useMemo(() => {
    const hasDirectMobilePhantom = caps.platform !== 'desktop'
      && wallets.some((candidate) => candidate.adapter.name === MOBILE_PHANTOM_WALLET_NAME);
    return orderInjected(wallets
      .filter((w) => w.adapter.name !== MWA && w.adapter.name !== MWA_REMOTE)
      // The custom adapter and Wallet Standard twin are both present in
      // Phantom's mobile browser. Only the direct injected adapter may be
      // selected there; rendering the twin recreates the confirmed-then-failed
      // double-connect race.
      .filter((w) => !(hasDirectMobilePhantom && w.adapter.name === 'Phantom'))
      .filter((w) => w.readyState === WalletReadyState.Installed || w.readyState === WalletReadyState.Loadable)
      .map((w) => ({ name: w.adapter.name, installed: w.readyState === WalletReadyState.Installed })),
    caps.platform === 'desktop',
    );
  }, [wallets]);
  const hasMwa = wallets.some((w) => w.adapter.name === MWA);

  const model = useMemo(() => connectOptions({
    caps, injected, hasMwa, privyEnabled: social != null, mwaNotFound,
    target: playUrl(), ref: playOrigin(),
  }), [injected, hasMwa, social, mwaNotFound]);

  // MWA's own "wallet not found" UI is an unbranded modal pointing at
  // solanamobile.com; mwa.ts routes it here instead so the answer is the deep
  // links and store links already on screen.
  useEffect(() => bus.on('wallet:not-found', () => {
    setMwaNotFound(true);
    dispatchConnect({ type: 'clear-pending' });
  }), []);

  // WalletProvider/autoConnect is the sole connection owner. It reports a small,
  // sanitized error notice here; only the currently pending row consumes it.
  useEffect(() => bus.on('wallet:error', (notice) => {
    dispatchConnect({ type: 'provider-error', notice });
  }), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') closeRef.current(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // The sheet's job ends at "connected". Signing (SIWS) stays an explicit second
  // tap on the title screen — auto-firing a signature on connect is hostile and
  // gets popup-blocked by some wallets.
  useEffect(() => { if (connected) closeRef.current(); }, [connected]);

  useEffect(() => {
    if (pending === null) attemptStarted.current = false;
  }, [pending]);

  // An extension can unregister while its prompt is open (disable/reload).
  // Do not leave every row locked around a pending adapter that no longer
  // exists; the provider has nothing left that could settle that attempt.
  useEffect(() => {
    if (!pending) return;
    const stillPresent = pending === MWA
      ? hasMwa
      : injected.some((wallet) => wallet.name === pending);
    if (!stillPresent) dispatchConnect({ type: 'clear-pending' });
  }, [pending, injected, hasMwa]);

  // WalletProvider's StrictMode effect replay can briefly reset its React-level
  // `connecting` flag while the adapter promise itself is still open. The
  // adapter is authoritative for that interval; never permit a second wallet
  // selection until both layers agree the attempt settled.
  const walletBusy = walletAttemptBusy(pending, connecting, wallet?.adapter.connecting === true);

  const choose = (name: string): void => {
    if (walletBusy || attemptStarted.current) return;
    attemptStarted.current = true;
    // Phantom's in-app browser opens its native account dialog only while the
    // provider call still has this tap's user activation. Prime the exact
    // direct adapter synchronously; WalletProvider remains the selected-wallet
    // owner and consumes the same promise from its later adapter.connect().
    if (name === MOBILE_PHANTOM_WALLET_NAME) {
      const direct = wallets.find((candidate) => candidate.adapter.name === name)?.adapter;
      if (direct instanceof MobilePhantomAdapter) {
        direct.primeConnectFromUserGesture();
        // Selecting an already-selected name is intentionally a WalletProvider
        // no-op. Let that same provider own its explicit reconnect so the
        // primed promise cannot be orphaned behind a permanently pending row.
        if (wallet?.adapter === direct && !connected) {
          dispatchConnect({ type: 'choose', walletName: name });
          select(name as WalletName);
          void connectSelectedWallet().catch(() => undefined);
          return;
        }
      }
    }
    dispatchConnect({ type: 'choose', walletName: name });
    // `autoConnect` sees this user selection and calls exactly this adapter's
    // connect(). On Phantom mobile that adapter directly owns the injected
    // provider; the duplicate Wallet Standard Phantom is never selected.
    select(name as WalletName);
  };

  const row = (o: ConnectOption, key: string): React.JSX.Element => {
    switch (o.kind) {
      case 'adapter':
        return (
          <div key={key} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <Btn fontSize={19} variant={o.primary ? 'gold' : 'sec'} disabled={walletBusy}
              style={{ width: '100%' }} onClick={() => choose(o.walletName)}>
              {pending === o.walletName ? 'CONNECTING…' : o.label}
            </Btn>
            {o.sub && <div style={{ color: C.textFaint, fontSize: 13, textAlign: 'center' }}>{o.sub}</div>}
          </div>
        );
      case 'mwa':
        return (
          <div key={key} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <Btn fontSize={19} disabled={walletBusy} style={{ width: '100%' }} onClick={() => choose(MWA)}>
              {pending === MWA ? 'OPENING…' : o.label}
            </Btn>
            {o.sub && <div style={{ color: C.textFaint, fontSize: 13, textAlign: 'center' }}>{o.sub}</div>}
          </div>
        );
      case 'deeplink':
        return (
          <div key={key} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {/* _self: the app takeover replaces this navigation. _blank would
                strand a blank tab whenever the takeover fails. */}
            <LinkBtn href={o.href} target="_self" variant="ghost" fontSize={19}
              style={{ width: '100%', color: C.gold, border: `2px solid ${C.goldDp}` }}>
              {o.label}
            </LinkBtn>
            <a className="interactive" href={o.installHref} target="_blank" rel="noopener noreferrer"
              style={{ color: C.textFaint, fontSize: 13, textAlign: 'center', textDecoration: 'none' }}>
              {o.installLabel} ↗
            </a>
          </div>
        );
      case 'social':
        return (
          <div key={key} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {social}
            {o.sub && <div style={{ color: C.textFaint, fontSize: 13, textAlign: 'center' }}>{o.sub}</div>}
          </div>
        );
      case 'install':
        return (
          <LinkBtn key={key} href={o.href} target="_blank" variant="ghost" fontSize={17} style={{ width: '100%' }}>
            {o.label} ↗
          </LinkBtn>
        );
      case 'refresh':
        return (
          <Btn key={key} variant="sec" fontSize={17} style={{ width: '100%' }} onClick={() => window.location.reload()}>
            {o.label}
          </Btn>
        );
    }
  };

  const group = (g: SheetGroup, gi: number): React.JSX.Element => {
    const shown = g.collapsed ? openGroup === gi : true;
    const groupKey = g.heading ?? `group:${g.options.map(connectOptionKey).join('|')}`;
    return (
      <div key={groupKey} style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
        {g.heading && (g.collapsed ? (
          <span className="interactive" onClick={() => setOpenGroup(shown ? null : gi)}
            style={{ color: C.textDim, fontSize: 15, letterSpacing: '1px', cursor: 'pointer' }}>
            {shown ? '▴' : '▾'} {g.heading}
          </span>
        ) : (
          <span style={{ color: C.textDim, fontSize: 15, letterSpacing: '1px' }}>{g.heading}</span>
        ))}
        {shown && g.danger && <div style={{ color: C.danger, fontSize: 13, lineHeight: 1.3 }}>{g.danger}</div>}
        {shown && g.options.map((o) => {
          const optionKey = connectOptionKey(o);
          return (
          <div key={optionKey} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {row(o, optionKey)}
            {o.kind === 'adapter' && errors[o.walletName] && (
              <div role="alert" style={{ color: C.danger, fontSize: 13, lineHeight: 1.3 }}>{errors[o.walletName]}</div>
            )}
            {/* Phantom's in-app browser keeps a broken bridge until the page is
                recreated; after the adapter's own retry also failed, a reload is
                the recovery that has worked on device, so offer it right here. */}
            {o.kind === 'adapter' && errors[o.walletName] === PHANTOM_INTERNAL_ERROR_COPY && (
              <Btn variant="ghost" fontSize={14} style={{ width: '100%', color: C.gold }}
                onClick={() => window.location.reload()}>
                RELOAD AND TRY AGAIN
              </Btn>
            )}
            {o.kind === 'mwa' && errors[MWA] && (
              <div role="alert" style={{ color: C.danger, fontSize: 13, lineHeight: 1.3 }}>{errors[MWA]}</div>
            )}
          </div>
          );
        })}
      </div>
    );
  };

  // Portalled to <body> on purpose: ModalWrap is position:absolute, and the
  // SEEKER call site sits deep inside ScrollPage's own scrolling absolute box —
  // rendered in place the sheet would be pinned to that box's scroll origin and
  // land off-screen. #root does not scroll, so absolute-on-body behaves as fixed.
  return createPortal(
    <ModalWrap onBackdrop={onClose}>
      <Phead title={model.title} onClose={onClose} fontSize={21} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '12px 14px' }}>
        {model.note && <div style={{ color: C.textFaint, fontSize: 14, lineHeight: 1.35 }}>{model.note}</div>}
        {model.groups.map(group)}
      </div>
      {/* An explicit CLOSE as well as the backdrop and Escape: backdrop-only
          close is not discoverable on a phone. */}
      <div style={{ padding: '0 14px 14px' }}>
        <Btn variant="ghost" fontSize={17} style={{ width: '100%' }} onClick={onClose}>CLOSE</Btn>
      </div>
    </ModalWrap>,
    document.body,
  );
}
