/**
 * Seeker identity UI (owner 2026-07-29: "there is 0 indication that I am a
 * seeker user").
 *
 * Exports:
 *  - <SeekerBadge/> — the glyph shown next to a username EVERYWHERE a player is
 *    identified (own HUD, profile, map nametags, map search, clan roster, raid
 *    log). One component so the badge can never mean two different things.
 *  - <SeekerSection/> — the profile block that links/unlinks and shows proof.
 *  - <SeekerDoor/> — SeekerSection behind a one-line door for the UNLINKED
 *    (owner 2026-08-08: Seekers are auto-detected at the alpha gate after sign-in, so no one should
 *    face a VERIFY SEEKER block — but split-wallet owners still need a way in).
 *
 * The badge is rendered from SERVER state only. `seeker` on a roster row and
 * `/me.seeker` both come from `players.seeker_verified`, which is written only
 * after a mainnet SGT read. Nothing here decides anything.
 */
import { useState } from 'react';
import { SEEKER } from '@shardkeep/shared';
import { useWallet } from '@solana/wallet-adapter-react';
import { useSeekerLink, type SeekerStatus } from '../../auth/useSeekerLink';
import { api } from '../../lib/api';
import { bus } from '../../lib/events';
import { ConnectSheet } from '../ConnectSheet';
import { Btn, Chip, COLORS as C, Phead, Sp } from '../primitives';

const toast = (msg: string): void => bus.emit('ui:toast', { msg });

/**
 * The Seeker mark. Deliberately a text glyph rather than a sprite: it needs to
 * ship today, at any size, in a nametag and in a pill, and `assets-v2/` is the
 * art source of truth (never hand-edit generated atlases). Swap the innards for
 * a `ui_badge_seeker` master later — every call site keeps working.
 */
export function SeekerBadge({ size = 14, title }: { size?: number; title?: string }): React.JSX.Element {
  return (
    <span
      title={title ?? 'VERIFIED SOLANA MOBILE SEEKER'}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: size, height: size, flex: 'none', lineHeight: 1,
        fontSize: Math.round(size * 0.78), color: C.ink, background: C.gold,
        border: `1px solid ${C.goldDp}`, boxShadow: `inset 0 1px 0 ${C.goldHi}`,
      }}>
      ◈
    </span>
  );
}

/** Badge + name in one run, for list rows. Falls back to the short wallet. */
export function PlayerName({
  name, wallet, seeker, size = 14, style,
}: {
  name: string | null | undefined; wallet?: string | null; seeker?: boolean | undefined;
  size?: number; style?: React.CSSProperties | undefined;
}): React.JSX.Element {
  const shown = name && name.length > 0
    ? name
    : wallet ? `${wallet.slice(0, 4)}…${wallet.slice(-4)}` : '—';
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0, ...style }}>
      {seeker && <SeekerBadge size={size} />}
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{shown}</span>
    </span>
  );
}

function shortAddr(a: string): string {
  return `${a.slice(0, 4)}…${a.slice(-4)}`;
}

/**
 * Profile → SEEKER block.
 *
 * Flow A: the session wallet IS the Seeker wallet → one signMessage.
 * Flow B: a Privy/social session → connect the Seeker wallet through the normal
 *   connect sheet, sign, done. The session and the payment wallet do NOT change.
 */
export function SeekerSection({
  status, onChange,
}: { status: SeekerStatus | null; onChange: (s: SeekerStatus | null) => void }): React.JSX.Element {
  const { connected } = useWallet();
  const { link, unlink, findSkr, busy, error, candidate } = useSeekerLink();
  const [skr, setSkr] = useState('');
  const [connectOpen, setConnectOpen] = useState(false);

  const doLink = (): void => {
    void link(skr.trim() || undefined).then((s) => {
      if (!s) return;
      onChange(s);
      toast('SEEKER VERIFIED');
    });
  };
  const doUnlink = (): void => {
    void unlink().then(async () => {
      const fresh = await api.get<SeekerStatus>('/seeker/status').catch(() => null);
      onChange(fresh);
      toast('SEEKER UNLINKED');
    });
  };
  // Manual re-check: the badge must never depend on background workers running.
  const doRefresh = (): void => {
    void api.get<SeekerStatus>('/seeker/status?refresh=1')
      .then((s) => { onChange(s); toast(s.linked ? 'SEEKER RE-VERIFIED' : 'SEEKER TOKEN NO LONGER HELD'); })
      .catch((e: Error) => toast(e.message.toUpperCase()));
  };
  // Late discovery for a linked account with no domain on file (e.g. the .skr
  // was registered after linking). The server proves ownership; we just render.
  const doFindSkr = (): void => {
    void findSkr().then((s) => {
      if (!s) return;
      onChange(s);
      toast(s.skrDomain ? `ADOPTED ${s.skrDomain.toUpperCase()}` : 'NO .SKR FOUND FOR THIS WALLET');
    });
  };

  return (
    <>
      <Phead title={<span style={{ fontSize: 19 }}>SEEKER</span>} fontSize={19} />
      {status?.linked ? (
        <>
          <Chip>
            <SeekerBadge size={22} />
            <span style={{ color: C.goldHi }}>
              VERIFIED SEEKER{status.memberNumber !== null ? ` #${status.memberNumber}` : ''}
            </span>
            <Sp />
            <Btn variant="ghost" fontSize={14} style={{ padding: '3px 8px 5px' }} onClick={doRefresh}>RE-CHECK</Btn>
          </Chip>
          {status.skrDomain ? (
            <Chip><span style={{ color: C.textDim }}>DOMAIN</span><Sp /><span style={{ color: C.gold }}>{status.skrDomain}</span></Chip>
          ) : (
            <Btn variant="ghost" fontSize={14} disabled={busy} onClick={doFindSkr}>
              {busy ? 'SEARCHING…' : 'FIND MY .SKR'}
            </Btn>
          )}
          <Chip>
            <span style={{ color: C.textDim }}>GENESIS TOKEN</span><Sp />
            {/* MAINNET explorer — the SGT does not live on our devnet cluster. */}
            <a className="interactive" style={{ fontSize: 13, color: C.gold }}
              href={`https://explorer.solana.com/address/${status.sgtMint}`}
              target="_blank" rel="noreferrer">{shortAddr(status.sgtMint!)} ↗</a>
          </Chip>
          <Chip>
            <span style={{ color: C.textDim }}>SEEKER WALLET</span><Sp />
            <span style={{ color: C.textFaint, fontSize: 13 }}>{shortAddr(status.seekerWallet!)}</span>
          </Chip>
          {status.stale && (
            <div style={{ color: C.textFaint, fontSize: 13 }}>
              LAST ON-CHAIN CHECK OVER {SEEKER.recheckHours}H AGO — RE-CHECK TO REFRESH
            </div>
          )}
          <Btn variant="ghost" fontSize={15} disabled={busy}
            style={{ color: C.blood, border: `2px solid ${C.blood}` }} onClick={doUnlink}>
            UNLINK SEEKER
          </Btn>
        </>
      ) : (
        <>
          <Chip>
            <SeekerBadge size={22} title="NOT VERIFIED" />
            <span style={{ color: C.textDim }}>NOT VERIFIED</span>
          </Chip>
          <div style={{ color: C.textFaint, fontSize: 13, lineHeight: 1.35 }}>
            OWN A SOLANA MOBILE SEEKER? LINK THE WALLET THAT HOLDS YOUR GENESIS TOKEN
            TO EARN THE BADGE. IT ONLY SIGNS A MESSAGE — NEVER A PAYMENT, AND IT DOES
            NOT BECOME YOUR GAME WALLET.
          </div>
          <Chip style={{ gap: 6 }}>
            {/* An OVERRIDE, not a requirement: blank means the server discovers
                and forward-proves the wallet's own .skr during the link. */}
            <input className="interactive" value={skr} onChange={(e) => setSkr(e.target.value)}
              placeholder=".SKR DOMAIN (AUTO-DETECTED IF BLANK)" maxLength={70}
              // 16px floor: iOS Safari zooms into a smaller text field and stays zoomed (2026-09-17).
              style={{ flex: 1, fontFamily: 'inherit', fontSize: 16, background: C.surface, color: C.text, border: `2px solid ${C.border}`, padding: '4px 8px' }} />
          </Chip>
          {connected ? (
            <Btn fontSize={18} disabled={busy} onClick={doLink}>
              {busy ? 'VERIFYING…' : `VERIFY ${candidate ? shortAddr(candidate) : 'WALLET'}`}
            </Btn>
          ) : (
            <Btn variant="sec" fontSize={18} onClick={() => setConnectOpen(true)}>CONNECT SEEKER WALLET</Btn>
          )}
          {/* No `social` prop: a Privy embedded wallet is created FOR the player
              and can never be the wallet holding their Genesis Token, so offering
              it here would only produce a failed verification. */}
          {connectOpen && <ConnectSheet onClose={() => setConnectOpen(false)} />}
          {error && <div style={{ color: C.danger, fontSize: 13 }}>{error}</div>}
        </>
      )}
    </>
  );
}

/**
 * SeekerSection behind a one-line door (owner 2026-08-08: "for users without a
 * Seeker phone, VERIFY SEEKER should not exist").
 *
 * A LINKED account renders the full section — a live badge is never hidden.
 * Everyone else sees a single low-key line, because the common cases need no
 * UI at all: a Seeker signing in with the Seed Vault wallet is detected and
 * admitted by the automatic alpha-gate probe. The door exists for exactly the players
 * auto-detect can NEVER reach — a Privy/social session (the embedded wallet
 * cannot hold an SGT) or a game wallet that is not the Seeker one.
 */
export function SeekerDoor({
  status, onChange,
}: { status: SeekerStatus | null; onChange: (s: SeekerStatus | null) => void }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  if (status?.linked || open) return <SeekerSection status={status} onChange={onChange} />;
  return (
    <button className="interactive" onClick={() => setOpen(true)}
      style={{
        background: 'none', border: 'none', padding: 0, textAlign: 'left',
        fontFamily: 'inherit', fontSize: 13, color: C.textFaint, cursor: 'pointer',
      }}>
      OWN A SOLANA MOBILE SEEKER ON ANOTHER WALLET? <span style={{ color: C.gold }}>LINK IT</span>
    </button>
  );
}
