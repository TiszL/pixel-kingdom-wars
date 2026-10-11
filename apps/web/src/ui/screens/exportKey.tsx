/**
 * EXPORT PRIVATE KEY (docs/ONRAMP-WALLETS-PLAN.md Flow B) — Privy embedded
 * wallets only. The raw key is assembled inside Privy's cross-origin modal and
 * NEVER touches app JS, apps/api, or logs. Privy MFA is the vendor-enforced
 * export factor. SHARDKEEP's recent-auth/account-factor challenge is a separate
 * defense-in-depth gate around this UI; it cannot govern other Privy clients.
 *
 * Render-gated: mount ONLY when PRIVY_ENABLED (the Privy hooks need the
 * provider that App.tsx mounts under the same env condition).
 */
import { useState } from 'react';
import { useMfaEnrollment, usePrivy } from '@privy-io/react-auth';
import { useExportWallet, useWallets } from '@privy-io/react-auth/solana';
import { ApiError, api } from '../../lib/api';
import { bus } from '../../lib/events';
import { PRIVY_HELP_URL, supportMailto, supportSubject } from '../../lib/support';
import { useLoginChallenge } from '../../auth/loginChallenge';
import { useApp } from '../../state/store';
import { findPrivyEmbeddedWallet } from '../../auth/privyWallet';
import { useRecentAuth } from '../../auth/useRecentAuth';
import { useFreshPrivyMfa } from '../../auth/useFreshPrivyMfa';
import { Btn, COLORS as C, Icon, Phead } from '../primitives';
import { useFetch } from '../useFetch';

export const PRIVY_ENABLED = !!import.meta.env.VITE_PRIVY_APP_ID;

const CODE_STYLE: React.CSSProperties = {
  fontFamily: 'inherit', fontSize: 16, background: C.surface, color: C.text,
  border: `2px solid ${C.border}`, padding: '8px 10px', width: '100%', minHeight: 44,
};

function toast(msg: string): void {
  bus.emit('ui:toast', { msg });
}

/**
 * Privy Wallet MFA has no reset: the developer cannot remove a user's method
 * and no server API exists (K-074), so a lost Privy authenticator is lost for
 * good. The warning stands BEFORE enrolment, when the setup key can still be
 * saved, and again at the moment of reveal (D-098, owner 2026-09-02). The
 * links are the two honest ways out: Privy's own help centre and our support.
 */
function LostPrivyMfaWarning({ wallet }: { wallet: string | null }): React.JSX.Element {
  return (
    <div role="note" style={{ display: 'flex', flexDirection: 'column', gap: 6, color: C.gold, fontSize: 12, lineHeight: 1.5 }}>
      <span>
        PRIVY WALLET SECURITY IS A SEPARATE AUTHENTICATOR. IF YOU LOSE IT, NEITHER PRIVY NOR
        PIXEL KINGDOM WARS CAN RESET IT — SIGNING, EXPORT AND NEW-DEVICE RECOVERY ALL NEED IT.
        KEEP THE SETUP KEY SOMEWHERE SAFE.
      </span>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <a className="interactive" href={PRIVY_HELP_URL} target="_blank" rel="noopener noreferrer"
          style={{ color: C.gold }}>PRIVY HELP CENTRE ↗</a>
        <a className="interactive" href={supportMailto(supportSubject('Lost Privy Wallet MFA', wallet))}
          style={{ color: C.gold }}>LOST IT? EMAIL SUPPORT</a>
      </div>
    </div>
  );
}

/**
 * EXPORTING YOUR KEY IS NEVER PURCHASE-GATED (security review F8, 2026-08-09).
 *
 * This section used to read `GET /2fa/status` (passed down from SecurityScreen) to
 * decide whether a code was needed, and refused to arm until it answered. At the
 * time that route was land-gated, so a wallet that paid, enrolled 2FA and then
 * SOLD its base could be locked out of its own private-key export. Account 2FA is
 * auth-only now, but export deliberately keeps its narrower status contract so it
 * never depends on withdrawal/profile response shape.
 *
 * The whole flow now runs on the three AUTH-ONLY routes the API carved out for
 * exactly this (auth/routes.ts, "KEY EXPORT IS A CUSTODY RIGHT"):
 *   GET  /auth/export/status     — is a factor enrolled, and which;
 *   POST /auth/export/send-code  — a session-bound key-export email challenge;
 *   POST /auth/export/challenge  — proves it.
 * Nothing here touches `/2fa/*` or `/withdrawals/*`, so no land state can reach it.
 *
 * The status read is a CONVENIENCE, never a barrier: if it fails for any reason the
 * button still arms, and a codeless challenge that comes back 422 becomes the code
 * prompt. That inference is on the STATUS plus what we sent — never on the message
 * text, which is the habit that produced the 401→"session expired" lie.
 */
interface ExportStatus {
  totpEnabled: boolean;
  emailVerified: boolean;
  gated: boolean;
  recovery: {
    status: 'email_pending' | 'holding' | 'cancelled' | 'completed' | 'expired' | null;
    reenrollmentRequired: boolean;
  };
}

export function ExportKeySection(): React.JSX.Element | null {
  const session = useApp((s) => s.wallet);
  const { wallets } = useWallets();
  const { exportWallet } = useExportWallet();
  const { prove } = useRecentAuth();
  // Privy-side wallet MFA is the only factor that can bind export at the wallet
  // vendor. A client-created wallet can be exported by another Privy client
  // holding the user's access token, so our API challenge cannot make that
  // promise. It remains useful defense in depth for SHARDKEEP's own reveal UI.
  const { ready: privyReady, user, mfaMethods: availableMfaMethods } = usePrivy();
  const { showMfaEnrollmentModal } = useMfaEnrollment();
  /** The export flow's OWN auth-only/no-land-gate status read. */
  const { data: status, error: statusError, reload: reloadStatus } =
    useFetch<ExportStatus>(() => api.get<ExportStatus>('/auth/export/status'));
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState('');
  const [emailSent, setEmailSent] = useState(false);
  /** The server told us (via a 422 on a codeless challenge) that a factor IS
   *  enrolled. Only consulted when the status read did not come back. */
  const [challengeWantsCode, setChallengeWantsCode] = useState(false);
  /** Which factor to prove with when the status read failed and we do not know
   *  which one is enrolled. Ignored whenever `status` arrived. */
  const [pick, setPick] = useState<'totp' | 'email'>('totp');

  // Only the session's own Privy embedded wallet is exportable — an external
  // (Phantom/Solflare) session has nothing to export here.
  const embedded = findPrivyEmbeddedWallet(wallets, session);
  const requireFreshPrivyMfa = useFreshPrivyMfa(Boolean(embedded));
  if (!embedded) return null;

  // Do not even render an arm/reveal action until Privy has authoritatively
  // loaded the current user and reports a vendor MFA method. This is a UI
  // assurance, not an attempt to override Privy's access-token export model.
  const privyMfaEnrolled = privyReady && Boolean(user?.mfaMethods.includes('totp'));
  const privyMfaConfigured = privyReady && availableMfaMethods.includes('totp');

  // Does this export need a code? The server's own answer when we have it, else
  // what the challenge told us. Unknown-and-not-yet-asked reads as "no", which is
  // safe: the SERVER refuses a codeless challenge for an enrolled wallet, and that
  // refusal is what flips this.
  const gated = status ? status.gated : challengeWantsCode;
  // Which factor: the authenticator when enrolled, else email. With no status read
  // we genuinely do not know, so the player picks.
  const method: 'totp' | 'email' = status ? (status.totpEnabled ? 'totp' : 'email') : pick;
  /** True while we are guessing at the factor — show the picker, not a fake fact. */
  const methodUnknown = !status && gated;
  const recoveryBlocked = status?.recovery?.status === 'holding'
    || status?.recovery?.reenrollmentRequired === true;

  const sendEmailCode = (): void => {
    // The export flow's own sender, NOT /withdrawals/send-code (land-gated).
    // Storage is shared, but the server binds this code to key export + session.
    void api.post<{ sent: boolean; devCode?: string }>('/auth/export/send-code', {})
      .then((r) => { setEmailSent(true); if (r.devCode) { setCode(r.devCode); toast(`DEV CODE: ${r.devCode}`); } else toast('CODE SENT TO YOUR EMAIL'); })
      .catch((e: Error) => toast(e.message.toUpperCase()));
  };

  const doExport = (): void => {
    setBusy(true);
    const sent = code.trim();
    void (async () => {
      try {
        await requireFreshPrivyMfa();
        // A seven-day session cookie is not primary authentication for a key
        // reveal. Re-sign with the session wallet, then prove 2FA when enrolled.
        const grant = await prove('key_export');
        await api.postRecent('/auth/export/challenge', sent ? { method, code: sent } : {}, grant);
        // The key appears ONLY in Privy's isolated modal (different origin) —
        // this app never sees it. Phantom/Solflare-importable.
        await exportWallet({ address: embedded.address });
        setArmed(false); setCode(''); setEmailSent(false);
      } catch (e) {
        // A codeless challenge that 422s means one thing: a factor is enrolled and
        // the server wants it. Turn that into the code prompt rather than an error.
        // Only reachable when the status read failed, and it is what keeps a broken
        // read from standing between a player and their key. Status-only, no
        // message matching.
        if (!sent && e instanceof ApiError && e.status === 422) {
          setChallengeWantsCode(true);
          return;
        }
        toast(e instanceof Error ? e.message.toUpperCase() : 'EXPORT FAILED');
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <>
      <Phead title={<span style={{ fontSize: 19 }}>EXPORT PRIVATE KEY</span>} fontSize={19} />
      {!privyMfaEnrolled && !privyMfaConfigured ? (
        <div style={{ color: C.textFaint, fontSize: 13, lineHeight: 1.5 }}>
          {privyReady
            ? 'PRIVATE-KEY EXPORT IS TEMPORARILY UNAVAILABLE. Pixel Kingdom Wars must enable wallet MFA in its Privy dashboard before enrollment can begin.'
            : 'CHECKING PRIVY WALLET SECURITY…'}
        </div>
      ) : !privyMfaEnrolled ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ color: C.textFaint, fontSize: 13, lineHeight: 1.5 }}>
            {privyReady
              ? 'Privy wallet MFA must be enrolled before Pixel Kingdom Wars will open its private-key export flow.'
              : 'CHECKING PRIVY WALLET SECURITY…'}
          </div>
          {privyReady && (
            <>
              <div style={{ color: C.textDim, fontSize: 13, lineHeight: 1.5 }}>
                A Privy-authenticated client can request wallet export outside
                Pixel Kingdom Wars. Privy wallet MFA protects that vendor path.
                Pixel Kingdom Wars’ own authenticator or recent-wallet check is an
                additional app-layer safeguard, not a replacement.
              </div>
              <LostPrivyMfaWarning wallet={session} />
              <Btn fontSize={15} onClick={showMfaEnrollmentModal}>SECURE WALLET WITH PRIVY MFA</Btn>
            </>
          )}
        </div>
      ) : recoveryBlocked ? (
        <div role="alert" style={{ color: C.gold, fontSize: 13, lineHeight: 1.5 }}>
          {status?.recovery?.reenrollmentRequired
            ? 'ENROLL A NEW PIXEL KINGDOM WARS AUTHENTICATOR BEFORE EXPORTING THIS KEY.'
            : 'PRIVATE-KEY EXPORT IS LOCKED DURING THE AUTHENTICATOR-RECOVERY SECURITY HOLD.'}
        </div>
      ) : !armed ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ color: C.textFaint, fontSize: 13, lineHeight: 1.5 }}>
            Move your game wallet into Phantom, Solflare, or any Solana wallet app.
          </div>
          {/* A failed status read is a NOTE, not a barrier: it only decides whether
              the code field is shown before or after the challenge asks for it. The
              button below arms either way. */}
          {statusError && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span style={{ color: C.textFaint, fontSize: 13 }}>COULDN’T CHECK YOUR 2FA SETTINGS</span>
              <Btn variant="ghost" fontSize={14} onClick={reloadStatus}>RETRY</Btn>
            </div>
          )}
          <Btn variant="ghost" fontSize={15} onClick={() => setArmed(true)}>EXPORT PRIVATE KEY…</Btn>
          <Btn variant="ghost" fontSize={13} onClick={showMfaEnrollmentModal}>
            MANAGE PRIVY WALLET MFA…
          </Btn>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, border: `2px solid ${C.blood}`, padding: 10 }}>
          <div style={{ color: C.danger, fontSize: 15, letterSpacing: '1px', display: 'flex', alignItems: 'center', gap: 6 }}>
            <Icon name="shield" size={18} />READ BEFORE REVEALING
          </div>
          <div style={{ color: C.textDim, fontSize: 13, lineHeight: 1.55 }}>
            Your private key controls this wallet and EVERYTHING in it — SOL, KEEP, your Keep.
            Anyone who sees it can take it all. Never screenshot it, never paste it in chat,
            and know that Pixel Kingdom Wars staff will NEVER ask for it. The key is revealed in a
            secure Privy window — this game never sees it.
          </div>
          <div style={{ color: C.textFaint, fontSize: 12, lineHeight: 1.5 }}>
            PIXEL KINGDOM WARS APP CHECK · DEFENSE-IN-DEPTH. Privy MFA is the
            wallet-vendor protection, including export requests outside Pixel
            Kingdom Wars; the checks below protect this game’s export button only.
          </div>
          <LostPrivyMfaWarning wallet={session} />
          {gated && (
            <>
              {/* We know a factor is enrolled but not WHICH — the status read was
                  unavailable and the challenge only says "a code is required". So
                  the player picks; both buttons prove the same export. */}
              {methodUnknown && (
                <>
                  <span style={{ color: C.textFaint, fontSize: 13, lineHeight: 1.5 }}>
                    This wallet has 2FA on. Prove it once and the key is yours.
                  </span>
                  <div style={{ display: 'flex', gap: 8 }}>
                    {(['totp', 'email'] as const).map((m) => (
                      <Btn key={m} variant={pick === m ? 'gold' : 'ghost'} fontSize={13} style={{ flex: 1 }}
                        onClick={() => { setPick(m); setCode(''); setEmailSent(false); }}>
                        {m === 'totp' ? 'AUTHENTICATOR' : 'EMAIL'}
                      </Btn>
                    ))}
                  </div>
                </>
              )}
              {method === 'email' && !emailSent ? (
                <Btn variant="sec" fontSize={14} onClick={sendEmailCode}>EMAIL ME A CODE</Btn>
              ) : (
                <>
                  <input className="interactive" value={code} onChange={(e) => setCode(e.target.value)}
                    aria-label={method === 'totp' ? 'Pixel Kingdom Wars Authenticator Code' : 'Email Code'}
                    placeholder={method === 'totp' ? 'PIXEL KINGDOM WARS AUTHENTICATOR CODE' : 'EMAIL CODE'}
                    autoComplete="one-time-code" inputMode="numeric" style={CODE_STYLE} />
                  {method === 'totp' && (
                    <span style={{ color: C.textFaint, fontSize: 12, lineHeight: 1.5 }}>
                      Enter your PKW account 2FA code. Privy Wallet Security will prompt separately.
                    </span>
                  )}
                </>
              )}
            </>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <Btn variant="ghost" fontSize={14} style={{ flex: 1 }} onClick={() => { setArmed(false); setCode(''); setEmailSent(false); }}>CANCEL</Btn>
            <Btn fontSize={14} style={{ flex: 1 }} disabled={busy || (gated && code.trim().length < 6)} onClick={doExport}>
              {busy ? 'CHECKING…' : 'REVEAL MY KEY'}
            </Btn>
          </div>
        </div>
      )}
    </>
  );
}

/** Recovery may enroll Privy's separate wallet factor without exposing the
 * private-key flow to a limited PKW login credential. */
export function RecoveryWalletMfa(): React.JSX.Element | null {
  const { ready, user, mfaMethods } = usePrivy();
  const { showMfaEnrollmentModal } = useMfaEnrollment();
  const { wallets } = useWallets();
  const wallet = useLoginChallenge((s) => s.wallet);
  if (!findPrivyEmbeddedWallet(wallets, wallet)) return null;
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
    <LostPrivyMfaWarning wallet={wallet} />
    {ready && !user?.mfaMethods.includes('totp') && mfaMethods.includes('totp') && (
      <Btn onClick={showMfaEnrollmentModal}>SECURE WALLET WITH PRIVY MFA</Btn>
    )}
  </div>;
}
