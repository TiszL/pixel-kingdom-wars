/**
 * PROFILE › WALLET tab (owner 2026-08-15 + round-3 2026-08-16).
 *
 * Balances come from GET /wallet/balances — the SERVER reads both clusters
 * (owner: "does not load balances except devnet sol"; browser reads of public
 * RPCs die on CORS/rate limits, the api's don't, and it caches 30s/wallet).
 * `null` from the server means THAT read failed or mainnet is unconfigured —
 * rendered as retryable, never as a fake 0.
 *
 * EXCHANGE is the Jupiter Plugin embedded INSIDE the tab (owner round-3: the
 * floating modal clashed with the HUD and asked for its own wallet connect):
 * displayMode 'integrated' into a div this tab owns, with WALLET PASSTHROUGH —
 * the game's already-connected wallet-adapter context signs the swaps, synced
 * via window.Jupiter.syncProps on every wallet change. Script still injected
 * on demand; nothing loads at first paint. Swaps settle on MAINNET; selling
 * KEEP remains withdrawal→DEX per ONRAMP-WALLETS-PLAN D2.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { WALLET_HUB } from '@shardkeep/shared';
import { api } from '../../lib/api';
import { COLORS as C, Btn, Chip, Icon, Sp } from '../primitives';
import { bus } from '../../lib/events';
import { EVENTS, track } from '../../lib/analytics';

function toast(msg: string): void {
  bus.emit('ui:toast', { msg });
}

/** GET /wallet/balances response (apps/api game/walletBalances.ts). */
export interface WalletBalancesDto {
  sol: number | null;
  tokens: Record<string, number | null>;
  asOf: number;
}

/** Balance formatting: whole-ish numbers stay short, dust keeps 4 decimals.
 * Pure; pinned by wallet.test.tsx. */
export function fmtBalance(n: number | null): string {
  if (n === null) return '…';
  if (n === 0) return '0';
  const s = n >= 1 ? n.toLocaleString('en-US', { maximumFractionDigits: 2 })
    : n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  return s;
}

/** One promise per page load — a second EXCHANGE tap must not inject a second
 * script tag. */
let jupiterLoad: Promise<void> | null = null;
function loadJupiter(): Promise<void> {
  jupiterLoad ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = WALLET_HUB.jupiterPluginUrl;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => { jupiterLoad = null; reject(new Error('jupiter script failed')); };
    document.head.appendChild(s);
  });
  return jupiterLoad;
}

declare global {
  interface Window {
    Jupiter?: {
      init: (opts: Record<string, unknown>) => void;
      syncProps?: (opts: Record<string, unknown>) => void;
    };
  }
}

const JUPITER_TARGET_ID = 'jupiter-plugin-target';

export function WalletTab({ wallet }: { wallet: string | null }): React.JSX.Element {
  const walletContext = useWallet();
  const [balances, setBalances] = useState<WalletBalancesDto | null>(null);
  const [exchangeOpen, setExchangeOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const initedRef = useRef(false);

  const refresh = useCallback((): void => {
    if (!wallet) return;
    void api.get<WalletBalancesDto>('/wallet/balances')
      .then(setBalances)
      .catch(() => null); // keep the last answer; REFRESH retries
  }, [wallet]);

  useEffect(() => { refresh(); }, [refresh]);

  const openExchange = (): void => {
    setBusy(true);
    track(EVENTS.EXCHANGE_OPENED, {});
    setExchangeOpen(true);
    void loadJupiter()
      .then(() => {
        if (!window.Jupiter) throw new Error('jupiter missing after load');
        // Integrated INTO this tab, signing with the game's connected wallet.
        window.Jupiter.init({
          displayMode: 'integrated',
          integratedTargetId: JUPITER_TARGET_ID,
          enableWalletPassthrough: true,
          passthroughWalletContextState: walletContext,
          onRequestConnectWallet: () => {
            toast('SIGN IN FIRST — THE GAME WALLET SIGNS YOUR SWAPS');
          },
        });
        initedRef.current = true;
      })
      .catch(() => {
        setExchangeOpen(false);
        toast('COULD NOT LOAD JUPITER — CHECK YOUR CONNECTION');
      })
      .finally(() => setBusy(false));
  };

  // Keep the embedded plugin's wallet in step with the game's (adapter
  // reconnects, account switches) — the documented passthrough contract.
  useEffect(() => {
    if (initedRef.current && exchangeOpen) {
      window.Jupiter?.syncProps?.({ passthroughWalletContextState: walletContext });
    }
  }, [walletContext, exchangeOpen]);

  const rows = [
    { symbol: 'SOL', amount: balances?.sol ?? null, note: 'GAME CLUSTER' },
    ...WALLET_HUB.tokens.map((t) => {
      const amount = balances ? balances.tokens[t.symbol] ?? null : null;
      const failed = balances !== null && (balances.tokens[t.symbol] ?? null) === null;
      return {
        symbol: t.symbol,
        amount,
        note: `${t.cluster === 'mainnet' ? 'MAINNET' : 'GAME CLUSTER'}${failed ? ' · UNAVAILABLE — REFRESH' : ''}`,
      };
    }),
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
      <div style={{ color: C.textFaint, fontSize: 13, lineHeight: 1.4 }}>
        ON-CHAIN BALANCES OF YOUR CONNECTED WALLET. IN-GAME KEEP &amp; SHARDS
        LIVE ON THE PROFILE TAB AND THE KEEP WALLET.
      </div>
      {rows.map((r) => (
        <Chip key={r.symbol}>
          {r.symbol === 'SOL' ? <Icon name="sol" size={22} />
            : r.symbol === 'KEEP' ? <Icon name="keep" size={22} />
              : (
                <span aria-hidden="true" style={{
                  width: 22, height: 22, display: 'grid', placeItems: 'center',
                  background: C.surface, border: `2px solid ${C.borderLt}`,
                  color: C.gold, fontSize: 11,
                }}>
                  {r.symbol.slice(0, 1)}
                </span>
              )}
          <span>{r.symbol}</span>
          <span style={{ color: C.textFaint, fontSize: 12 }}>{r.note}</span>
          <Sp />
          <span className="copyable" style={{ color: r.amount ? C.goldHi : C.textDim }}>
            {fmtBalance(r.amount)}
          </span>
        </Chip>
      ))}
      <div style={{ display: 'flex', gap: 6 }}>
        <Btn variant="sec" fontSize={15} style={{ padding: '6px 12px 8px' }} onClick={refresh}>
          REFRESH
        </Btn>
        {!exchangeOpen && (
          <Btn variant="gold" fontSize={15} style={{ flex: 1, padding: '6px 12px 8px' }}
            disabled={busy} onClick={openExchange}>
            {busy ? 'LOADING…' : 'EXCHANGE (JUPITER)'}
          </Btn>
        )}
      </div>
      {/* The plugin renders INSIDE this framed box — part of the wallet tab,
          never a floating modal over the HUD (owner 2026-08-16). */}
      {exchangeOpen && (
        <div style={{ border: `2px solid ${C.borderLt}`, background: C.card, padding: 6 }}>
          <div id={JUPITER_TARGET_ID} style={{ minHeight: 480 }} />
        </div>
      )}
      <div style={{ color: C.textFaint, fontSize: 13, lineHeight: 1.4 }}>
        SWAPS ARE SIGNED BY YOUR CONNECTED WALLET AND SETTLE ON SOLANA MAINNET —
        THEY MOVE THE MAINNET BALANCES ABOVE. KEEP TRADES ARRIVE WITH THE TOKEN
        LAUNCH: UNTIL THEN, WITHDRAW KEEP FIRST FROM THE KEEP WALLET.
      </div>
    </div>
  );
}
