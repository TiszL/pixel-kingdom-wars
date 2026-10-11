/**
 * FUNDING — one compact row: the wallet's SOL, the D-098 faucet control while
 * the wallet cannot cover the deed, and the deposit address (shortened; the
 * full address and a clipboard copy on tap).
 *
 * The faucet CONTROL and its view resolver are injected rather than imported:
 * both live in Overlay.tsx (their labels are pinned by devnetSolClaim.test.tsx
 * and cluster.test.ts reads that source), and Overlay mounts this screen — an
 * import back would be a cycle through a module the tests mock.
 */
import { useState } from 'react';
import type { useDevnetFaucet } from '../../auth/useDevnetFaucet';
import { SOLANA_CLUSTER } from '../../lib/cluster';
import { bus } from '../../lib/events';
import { hudChipStyle } from '../hudChrome';
import { COLORS as C, Icon } from '../primitives';

export type FaucetHandle = ReturnType<typeof useDevnetFaucet>;
export type FaucetControl = (props: { wallet: string; faucet: FaucetHandle }) => React.JSX.Element | null;
export type FaucetView = (faucet: Pick<FaucetHandle, 'phase' | 'status'>) => string | null;

export function shortWallet(wallet: string): string {
  return `${wallet.slice(0, 4)}…${wallet.slice(-4)}`;
}

/**
 * Which balance to show. The client's own RPC read polls every 10 s on this
 * screen precisely so a fresh wallet SEES funds arrive, so it leads whenever it
 * has answered; the faucet status DTO's `balanceSol` (the server's read, D-098)
 * covers the case where the client RPC has not answered or cannot — the
 * installed shell, a blocked endpoint — so the row is never blank for a wallet
 * the server can see.
 */
export function fundingBalance(faucet: Pick<FaucetHandle, 'status'>, rpcSol: number | null): number | null {
  if (rpcSol !== null) return rpcSol;
  const server = faucet.status?.balanceSol;
  return typeof server === 'number' ? server : null;
}

export function FundingChip({ wallet, rpcSol, faucet, FaucetControl, faucetView, requiredLamports, feeKnown }: {
  wallet: string;
  rpcSol: number | null;
  faucet: FaucetHandle;
  FaucetControl: FaucetControl;
  faucetView: FaucetView;
  requiredLamports: number;
  feeKnown: boolean;
}): React.JSX.Element {
  const [full, setFull] = useState(false);
  const delayed = faucet.phase === 'unavailable' && faucet.status?.last?.status === 'requested';
  const sol = fundingBalance(faucet, rpcSol);
  const requiredSol = requiredLamports / 1e9;
  const requiredSolLabel = requiredSol.toFixed(9).replace(/\.?0+$/, '');
  const funded = sol !== null && sol >= requiredSol;
  const claim = !funded && faucetView(faucet) !== null;
  const copyAddr = (): void => {
    setFull((v) => !v);
    void navigator.clipboard?.writeText(wallet)
      .then(() => bus.emit('ui:toast', { msg: 'ADDRESS COPIED' }))
      .catch(() => bus.emit('ui:toast', { msg: 'COPY FAILED — LONG-PRESS THE ADDRESS' }));
  };
  return (
    <div data-funding style={{ ...hudChipStyle('shard'), padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0 }}>
        <span style={{ color: C.textFaint, fontSize: 12, letterSpacing: '2px' }}>FUNDING</span>
        <span role="status" style={{ display: 'flex', alignItems: 'center', gap: 5, color: funded ? C.success : C.gold, fontSize: 17 }}>
          <Icon name="sol" size={16} />
          {sol === null ? 'BALANCE UNAVAILABLE' : `${sol.toFixed(4)} SOL`}
        </span>
        {!funded && sol !== null && (
          <span style={{ color: C.textFaint, fontSize: 12, letterSpacing: '1px' }}>NEEDS {requiredSolLabel} SOL{feeKnown ? ' INCLUDING FEES' : ' + FEES'}</span>
        )}
        <button type="button" className="interactive" onClick={copyAddr}
          aria-label={`Your game wallet ${wallet} — tap to copy`}
          style={{
            marginLeft: 'auto', maxWidth: '100%', minHeight: 32, padding: '4px 8px', cursor: 'pointer',
            background: 'transparent', border: `2px solid ${C.border}`, color: C.textDim,
            fontFamily: 'inherit', fontSize: 13, letterSpacing: '1px', textAlign: 'left', overflowWrap: 'anywhere',
          }}>
          <span style={{ fontFamily: 'monospace', color: C.text }}>{full ? wallet : shortWallet(wallet)}</span>
          {' · TAP TO COPY'}
        </button>
      </div>
      {claim && <FaucetControl wallet={wallet} faucet={faucet} />}
      {delayed && <div role="status" style={{ color: C.textDim, fontSize: 14 }}>
        YOUR FREE SOL IS STILL REQUESTED. WE WILL KEEP CHECKING.
        <button type="button" className="interactive" data-tutorial-target="land-funding-retry" onClick={faucet.refresh} style={{ minHeight: 44, display: 'block', marginTop: 6 }}>CHECK FUNDING AGAIN</button>
      </div>}
      {!funded && !claim && (
        <div style={{ color: C.textFaint, fontSize: 12, lineHeight: 1.35 }}>
          {SOLANA_CLUSTER === 'devnet'
            ? 'DEVNET — FREE TEST SOL. SEND DEVNET SOL TO THIS ADDRESS.'
            : `SEND AT LEAST ${requiredSolLabel} SOL${feeKnown ? '' : ' PLUS FEES'} TO THIS ADDRESS.`}
        </div>
      )}
    </div>
  );
}
