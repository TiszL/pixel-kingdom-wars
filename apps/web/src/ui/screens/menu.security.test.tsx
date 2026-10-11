import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

vi.mock('./exportKey', () => ({ PRIVY_ENABLED: false, ExportKeySection: () => null }));
vi.mock('../../auth/useGameWallet', () => ({
  useGameWallet: () => ({ publicKey: null, sendTransaction: null, connection: null }),
}));

import {
  AccountSecuritySetting,
  emailEnrollmentStepUp,
  instantWithdrawalUiState,
  isWithdrawalPayoutPending,
  personalWithdrawalCooldownActive,
  personalWithdrawalMax,
  stableKeepConversionAttempt,
  stableWithdrawalIntent,
  TwoFaStatusNotice,
  withdrawalDisplayStatus,
  withdrawalSubmitToast,
} from './menu';

type El = { props?: Record<string, unknown> };

function textOf(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  return textOf((node as El).props?.['children']);
}

function clickFirst(node: unknown): boolean {
  if (node === null || node === undefined || typeof node !== 'object') return false;
  if (Array.isArray(node)) return node.some(clickFirst);
  const props = (node as El).props;
  if (!props) return false;
  if (typeof props['onClick'] === 'function') {
    (props['onClick'] as () => void)();
    return true;
  }
  return clickFirst(props['children']);
}

describe('Profile account security reachability', () => {
  it('renders and opens Account Email & 2FA without accepting a deed/land prop', () => {
    const open = vi.fn();
    const row = AccountSecuritySetting({ onOpen: open });
    expect(textOf(row)).toMatch(/ACCOUNT EMAIL.*2FA/);
    expect(Object.keys(row.props)).not.toContain('landOwned');
    (row.props['onClick'] as () => void)();
    expect(open).toHaveBeenCalledOnce();

    const source = readFileSync(new URL('./menu.tsx', import.meta.url), 'utf8');
    const profile = source.slice(source.indexOf('export function ProfileScreen'), source.indexOf('// CLANS ('));
    const accountRow = "<AccountSecuritySetting onOpen={() => setScreen('security')} />";
    const accountRowAt = profile.indexOf(accountRow);
    expect(accountRowAt).toBeGreaterThan(0);
    expect(profile.slice(accountRowAt - 250, accountRowAt)).not.toMatch(/landOwned|LandLocked|&&\s*\($/);
  });

  it('shows only the compact selected-base deed identity', () => {
    const source = readFileSync(new URL('./menu.tsx', import.meta.url), 'utf8');
    const profile = source.slice(source.indexOf('export function ProfileScreen'), source.indexOf('// CLANS ('));
    expect(profile).toContain('selectedDirectoryBase?.deedAssetId');
    expect(profile).toContain('profileDeedAssetId');
    expect(profile).not.toContain('/deed/${wallet}.png');
    expect(profile).not.toMatch(/maxHeight:\s*360|width:\s*'min\(100%, 360px\)'/);
  });

  it('never derives permanent deed history from the retired wallet raid route', () => {
    const source = readFileSync(new URL('./menu.tsx', import.meta.url), 'utf8');
    const profile = source.slice(source.indexOf('export function ProfileScreen'), source.indexOf('// CLANS ('));
    expect(profile).not.toContain("api.get<{ raids: unknown[] }>('/raids')");
    expect(profile).toContain('PERMANENT HISTORY');
  });
});

describe('factor-change route policy', () => {
  it('renders the complete lost-authenticator lifecycle with mobile-safe controls', () => {
    const source = readFileSync(new URL('./menu.tsx', import.meta.url), 'utf8');
    const security = source.slice(source.indexOf('export function SecurityScreen'), source.indexOf('// BUILDERS'));
    expect(source).toMatch(/const CODE_STYLE:[\s\S]+minHeight:\s*44/);
    // WHY (D-098): a "contact support" without an address is a dead end. Both
    // support-only states (no verified email; automation switched off) say why
    // the button is off and render the real support controls right there. The
    // custody rule itself is unchanged (D-094: no automated bypass).
    expect(security).toContain('Recovery needs a verified PKW contact email and this account has none');
    expect(security).toContain('Automated authenticator recovery is switched off right now');
    expect(security.match(/<SupportLinks topic="Lost Pixel Kingdom Wars authenticator/g)).toHaveLength(2);
    expect(security).not.toMatch(/Contact support[.\s]/);
    expect(security).toContain('CONFIRM LOST-AUTHENTICATOR RECOVERY');
    expect(security).toContain('AUTHENTICATOR RECOVERY HOLD ACTIVE');
    expect(security).toContain('SEND COMPLETION EMAIL CODE');
    expect(security).toContain('REPLACEMENT AUTHENTICATOR REQUIRED');
    expect(security.match(/CURRENT PKW AUTHENTICATOR CODE/g)).toHaveLength(2);
    expect(security.match(/autoComplete="one-time-code"/g)?.length).toBeGreaterThanOrEqual(5);
    expect(security).toMatch(/await requireFreshPrivyMfa\(\);\s*const grant = await prove\('totp_recovery', \{ recoveryId, action: 'start' \}\)/);
    expect(security.match(/await requireFreshPrivyMfa\(\);[\s\S]{0,160}prove\('totp_recovery', \{ recoveryId, action: 'complete' \}\)/g))
      .toHaveLength(2);
    expect(security).toMatch(/\/2fa\/totp\/recovery\/complete'[\s\S]+await signOut\(\)/);

    // The recovery guard surrounds the whole contact-email mutation surface,
    // not merely its heading/chip; forbidden controls never invite doomed taps.
    const guardedEmail = security.slice(
      // D-109: limited-login recovery must also hide every contact mutation.
      security.indexOf('{!loginRecovery && !recoveryHolding && !reenrollmentRequired && ('),
      security.indexOf('{/* Privy embedded wallets only'),
    );
    expect(guardedEmail).toContain('NEW EMAIL ADDRESS');
    expect(guardedEmail).toContain('NEW EMAIL CODE');
    expect(guardedEmail).toContain('CHANGE EMAIL');
  });

  it('renders checking/error/retry without pretending no factors are enrolled', () => {
    const retry = vi.fn();
    const checking = TwoFaStatusNotice({ loading: true, error: null, onRetry: retry });
    expect(textOf(checking)).toMatch(/CHECKING 2FA STATUS/);
    expect(textOf(checking)).not.toMatch(/SET UP|DISABLED/);

    const failed = TwoFaStatusNotice({ loading: false, error: 'network down', onRetry: retry });
    expect(textOf(failed)).toMatch(/SECURITY STATUS UNAVAILABLE.*RETRY/);
    expect(clickFirst(failed)).toBe(true);
    expect(retry).toHaveBeenCalledOnce();

    const source = readFileSync(new URL('./menu.tsx', import.meta.url), 'utf8');
    const security = source.slice(source.indexOf('export function SecurityScreen'), source.indexOf('// BUILDERS'));
    expect(security).toMatch(/if \(statusError \|\| !status\)[\s\S]+TwoFaStatusNotice/);
    const withdraw = source.slice(source.indexOf('function WithdrawOwnedScreen'), source.indexOf('// DEPOSIT'));
    expect(withdraw).toMatch(/!twofa \?[\s\S]+TwoFaStatusNotice/);
  });

  it('uses the existing authenticator first, then session-bound email step-up', () => {
    expect(emailEnrollmentStepUp({ totpEnabled: true, emailVerified: true }, ' 123456 '))
      .toEqual({ method: 'totp', code: '123456' });
    expect(emailEnrollmentStepUp({ totpEnabled: false, emailVerified: true }, ' 654321 '))
      .toEqual({ method: 'email', code: '654321' });
    expect(emailEnrollmentStepUp({ totpEnabled: false, emailVerified: false }, ''))
      .toBeUndefined();
  });

  it('routes email-first authenticator setup through factor step-up, never withdrawal codes', () => {
    const source = readFileSync(new URL('./menu.tsx', import.meta.url), 'utf8');
    const security = source.slice(source.indexOf('export function SecurityScreen'), source.indexOf('// BUILDERS'));
    expect(security).toContain("'/2fa/step-up/email'");
    expect(security).not.toContain("'/withdrawals/send-code'");
    expect(security).not.toMatch(/LandLocked|landOwned|useLandOwned/);
  });

  it('puts every factor mutation behind prove(factor_change) + postRecent', () => {
    const source = readFileSync(new URL('./menu.tsx', import.meta.url), 'utf8');
    const security = source.slice(source.indexOf('export function SecurityScreen'), source.indexOf('// BUILDERS'));
    expect(security).toContain("prove('factor_change')");
    expect(security).toContain('api.postRecent<T>(path, body, grant)');
    for (const route of [
      '/2fa/step-up/email', '/2fa/totp/enroll', '/2fa/totp/verify',
      '/2fa/totp/disable', '/2fa/email/start', '/2fa/email/verify',
    ]) {
      expect(security, route).toMatch(new RegExp(`factorPost(?:<[^\\n]+>)?\\('${route}'`));
    }
    // Recovery confirmation is bound to the start email code/session and
    // recovery cancellation is bound to the still-current PKW TOTP. Those two
    // intentionally do not reuse the generic factor-change wallet grant; every
    // ordinary factor mutation above still must.
    const directRoutes = [...security.matchAll(
      /\bapi\.post(?:<[^>]+>)?\(\s*['"](\/2fa\/[^'"]+)['"]/g,
    )].map((match) => match[1]);
    expect(directRoutes).toEqual([
      '/2fa/totp/recovery/confirm',
      '/2fa/totp/recovery/cancel',
    ]);
  });

  it('renders verified and pending email independently during replacement', () => {
    const source = readFileSync(new URL('./menu.tsx', import.meta.url), 'utf8');
    const security = source.slice(source.indexOf('export function SecurityScreen'), source.indexOf('// BUILDERS'));
    expect(security).toContain('status?.emailVerified &&');
    expect(security).toContain('status?.pendingEmail &&');
    expect(security).toContain('PENDING VERIFICATION');
    expect(security).toContain('VERIFIED CONTACT EMAIL');
    expect(security).toContain('AUTHENTICATOR MATURING');
    expect(security).toMatch(/\/2fa\/email\/start[\s\S]+setEmailSent\(true\); setStepCode\(''\); setStepSent\(false\)/);
  });
});

describe('withdrawal intent identity and recent-auth binding', () => {
  const base = { amount: '1250', destination: 'Dest111111111111111111111111111111111111', method: 'totp' as const, instant: true };

  it('keeps one idempotency key for an unchanged intent and resets every requested dimension', () => {
    let n = 0;
    const key = (): string => `request-${++n}`;
    const first = stableWithdrawalIntent(null, base, key);
    expect(stableWithdrawalIntent(first, { ...base }, key)).toBe(first);
    for (const changed of [
      { ...base, amount: '1251' },
      { ...base, destination: `${base.destination}x` },
      { ...base, instant: false },
    ]) {
      const next = stableWithdrawalIntent(first, changed, key);
      expect(next.idempotencyKey).not.toBe(first.idempotencyKey);
      expect(next.fingerprint).not.toBe(first.fingerprint);
    }
    expect(n).toBe(4);
  });

  it('signs the server-computed quote and submits its raw immutable proof', () => {
    const source = readFileSync(new URL('./menu.tsx', import.meta.url), 'utf8');
    const withdraw = source.slice(source.indexOf('function WithdrawOwnedScreen'), source.indexOf('// DEPOSIT'));
    expect(withdraw).toContain("'/withdrawals/prepare'");
    expect(withdraw).toContain('proveWithdrawal(quote)');
    expect(withdraw).not.toContain('/withdrawals/send-code');
    expect(withdraw).not.toContain('SEND EMAIL CODE');
    expect(withdraw).toContain("body['method'] = 'totp'");
    expect(withdraw).toMatch(/api\.postRecent<\{ id: string; status: string \}>\(\s*'\/withdrawals', body, authorization\.grant/);
    expect(withdraw).toContain("body['authorization'] = authorization.proof");
    expect(withdraw).toContain('grantRef.current?.fingerprint === intent.fingerprint');
    expect(withdraw).toContain("setAmt(0); setDest(myWallet)");
    for (const label of ['REVIEW', 'AMOUNT', 'DEST', 'FEE', 'NET']) expect(withdraw).toContain(label);
  });

  it('labels worker-queued instant payouts as processing and polls through settlement', () => {
    const now = Date.parse('2026-08-11T17:00:00Z');
    const due = { status: 'unbonding', unbondsAt: new Date(now).toISOString() };
    const standard = { status: 'unbonding', unbondsAt: new Date(now + 86_400_000).toISOString() };
    expect(isWithdrawalPayoutPending(due, now)).toBe(true);
    expect(withdrawalDisplayStatus(due, now)).toBe('PAYOUT QUEUED');
    expect(isWithdrawalPayoutPending(standard, now)).toBe(false);
    expect(withdrawalDisplayStatus(standard, now)).toBe('UNBONDING');
    expect(isWithdrawalPayoutPending({ status: 'processing', unbondsAt: null }, now)).toBe(true);
    expect(isWithdrawalPayoutPending({ status: 'sent', unbondsAt: due.unbondsAt }, now)).toBe(false);

    expect(withdrawalSubmitToast('unbonding', true)).toBe('INSTANT WITHDRAWAL QUEUED FOR PAYOUT');
    expect(withdrawalSubmitToast('unbonding', false)).toMatch(/UNBONDING 24H/);
    expect(withdrawalSubmitToast('failed', true)).toMatch(/REVIEW REQUIRED/);

    const source = readFileSync(new URL('./menu.tsx', import.meta.url), 'utf8');
    const withdraw = source.slice(source.indexOf('function WithdrawOwnedScreen'), source.indexOf('// DEPOSIT'));
    expect(withdraw).toContain('window.setInterval');
    expect(withdraw).toContain('if (!document.hidden) reload()');
    expect(withdraw).toContain("w.status === 'unbonding'");
  });

  it('exposes the authoritative failed-payout refund route in the withdrawal list', () => {
    const source = readFileSync(new URL('./menu.tsx', import.meta.url), 'utf8');
    const withdraw = source.slice(source.indexOf('function WithdrawOwnedScreen'), source.indexOf('// DEPOSIT'));
    expect(withdraw).toContain('`/withdrawals/${id}/refund`');
    expect(withdraw).toContain("w.status === 'failed' && w.refundable");
    expect(withdraw).toContain('>REFUND</Btn>');
    // WHY (D-098): a failed, non-refundable payout is money the player cannot
    // unwind alone. The row must be a real mailto with the withdrawal id in
    // the subject — an inert "CONTACT SUPPORT" span was a dead end.
    expect(withdraw).toMatch(/<a [^>]*href=\{supportMailto\(supportSubject\(`Failed withdrawal \$\{w\.id\}`, myWallet\)\)\}[^>]*>CONTACT SUPPORT<\/a>/);
    expect(withdraw).not.toContain('>CONTACT SUPPORT</span>');
  });

  it('signposts a lost authenticator from the instant code prompt itself', () => {
    // WHY (D-098): the instant code input was the only place a player without
    // their authenticator ever met the word "authenticator", and it offered no
    // way out. The prompt now links to the Security screen (where LOST
    // AUTHENTICATOR? lives) and says the standard rail never needs the code.
    const source = readFileSync(new URL('./menu.tsx', import.meta.url), 'utf8');
    const withdraw = source.slice(source.indexOf('function WithdrawOwnedScreen'), source.indexOf('// DEPOSIT'));
    const codePrompt = withdraw.slice(withdraw.indexOf('{useInstant && ('), withdraw.indexOf('{limitLoading ?'));
    expect(codePrompt).toContain('placeholder="AUTHENTICATOR CODE"');
    expect(codePrompt).toContain('STANDARD WITHDRAWALS NEVER NEED THIS CODE');
    expect(codePrompt).toMatch(/onClick=\{\(\) => useApp\.getState\(\)\.setScreen\('security'\)\}>\s*LOST AUTHENTICATOR\?/);
  });

  it('announces a recovery hold from the server DTO before a withdrawal is refused', () => {
    // WHY (D-098 / D-094): the hold blocks new withdrawals server-side; the
    // player must read that before filling the form, with the server's own
    // readyAt. The button is NOT disabled on the client: the DTO snapshot may
    // be stale and the server, not the client, decides admission.
    const source = readFileSync(new URL('./menu.tsx', import.meta.url), 'utf8');
    const withdraw = source.slice(source.indexOf('function WithdrawOwnedScreen'), source.indexOf('// DEPOSIT'));
    expect(withdraw).toContain("{twofa?.recovery?.status === 'holding' && (");
    expect(withdraw).toContain('AUTHENTICATOR RECOVERY HOLD · NEW WITHDRAWALS LOCKED UNTIL {twofa.recovery.readyAt ? new Date(twofa.recovery.readyAt).toLocaleString()');
    expect(withdraw.indexOf("recovery?.status === 'holding'")).toBeLessThan(withdraw.indexOf('placeholder="DESTINATION WALLET ADDRESS"'));
    expect(withdraw).not.toMatch(/disabled=\{busy \|\| !verifiedWithdrawalStatus[^}]*holding/);
  });

  it('keeps withdrawal history visible in the landless recovery screen', () => {
    // WHY: a player may sell their deed while a withdrawal is still escrowed.
    // Creation stays behind LandLocked; caller-scoped history/unwind does not.
    const source = readFileSync(new URL('./menu.tsx', import.meta.url), 'utf8');
    const screen = source.slice(source.indexOf('export function WithdrawScreen'), source.indexOf('function WithdrawOwnedScreen'));
    expect(screen).toMatch(/if \(!landOwned\)[\s\S]+LandLocked[\s\S]+<WithdrawalHistory \/>/);
    expect(screen.indexOf('<WithdrawalHistory />')).toBeGreaterThan(screen.indexOf('</LandLocked>'));
    const history = source.slice(source.indexOf('export function WithdrawalHistory'), source.indexOf('// DEPOSIT'));
    expect(history).toContain('WITHDRAWAL HISTORY UNAVAILABLE');
    expect(history).toContain('>RETRY</Btn>');
  });
});

describe('truthful instant-withdrawal availability', () => {
  const operational = {
    totpEnabled: true,
    totpReady: true,
    totpReadyAt: '2026-08-13T12:00:00.000Z',
    instantEligible: true,
    instantWithdrawalsEnabled: true,
  };

  it('is available but OFF by default, then ON only for an explicit request', () => {
    expect(instantWithdrawalUiState(operational, false)).toBe('available_off');
    expect(instantWithdrawalUiState(operational, true)).toBe('available_on');

    const source = readFileSync(new URL('./menu.tsx', import.meta.url), 'utf8');
    const withdraw = source.slice(source.indexOf('function WithdrawOwnedScreen'), source.indexOf('// DEPOSIT'));
    expect(withdraw).toContain('useState(false)');
    expect(withdraw).toContain('INSTANT AVAILABLE · OFF FOR THIS REQUEST');
    expect(withdraw).toContain('INSTANT ON FOR THIS REQUEST');
  });

  it('does not arm instant while the payout rail is operationally unavailable', () => {
    expect(instantWithdrawalUiState({ ...operational, instantWithdrawalsEnabled: false }, true))
      .toBe('unavailable');

    const source = readFileSync(new URL('./menu.tsx', import.meta.url), 'utf8');
    const withdraw = source.slice(source.indexOf('function WithdrawOwnedScreen'), source.indexOf('// DEPOSIT'));
    expect(withdraw).toContain("const useInstant = instantState === 'available_on'");
    expect(withdraw).toContain('instantWithdrawalUiState(verifiedTwoFa, instant)');
    expect(withdraw).toContain('const verifiedTwoFa = twofaLoading || twofaError ? null : twofa');
    expect(withdraw).toMatch(/instantState === 'available_off' \|\| instantState === 'available_on'[\s\S]+setInstant\(false\)/);
    expect(withdraw).toContain('INSTANT TEMPORARILY UNAVAILABLE · STANDARD WITHDRAWALS AVAILABLE');
  });

  it('shows authenticator maturation separately and renders the exact ready time', () => {
    expect(instantWithdrawalUiState({ ...operational, totpReady: false }, true)).toBe('maturing');

    const source = readFileSync(new URL('./menu.tsx', import.meta.url), 'utf8');
    const withdraw = source.slice(source.indexOf('function WithdrawOwnedScreen'), source.indexOf('// DEPOSIT'));
    expect(withdraw).toContain('INSTANT MATURING UNTIL {new Date(twofa.totpReadyAt!).toLocaleString()}');
    const security = source.slice(source.indexOf('export function SecurityScreen'), source.indexOf('// BUILDERS'));
    expect(security).toMatch(/status\.instantEligible && status\.instantWithdrawalsEnabled/);
    expect(security).toContain('INSTANT WITHDRAWALS AVAILABLE');
    expect(security).toContain('AUTHENTICATOR MATURING');
    expect(security).toContain('new Date(status.totpReadyAt).toLocaleString()');
    expect(security).toContain('instant withdrawals temporarily unavailable; standard withdrawals remain available');
    expect(security).toContain('SECURITY HOLD STARTED · CHECK WITHDRAW FOR AVAILABILITY');
  });

  it('uses the authoritative personal remaining allowance and fails closed without it', () => {
    const available = { personalDailyRemainingKeep: '50000', nextAvailableAt: null };
    expect(personalWithdrawalMax(80_000, available)).toBe(50_000);
    expect(personalWithdrawalMax(20_000, available)).toBe(20_000);
    expect(personalWithdrawalMax(80_000, null)).toBe(0);

    const now = Date.parse('2026-08-12T10:00:00Z');
    const coolingDown = { ...available, nextAvailableAt: '2026-08-12T11:00:00Z' };
    expect(personalWithdrawalCooldownActive(coolingDown, now)).toBe(true);
    expect(personalWithdrawalMax(80_000, coolingDown, now)).toBe(0);
    expect(personalWithdrawalCooldownActive(
      { ...available, nextAvailableAt: '2026-08-12T09:00:00Z' }, now,
    )).toBe(false);

    const source = readFileSync(new URL('./menu.tsx', import.meta.url), 'utf8');
    const withdraw = source.slice(source.indexOf('function WithdrawOwnedScreen'), source.indexOf('// DEPOSIT'));
    expect(withdraw).toContain("'/withdrawals/status'");
    expect(withdraw).toContain('personalWithdrawalMax(keep, verifiedWithdrawalStatus)');
    expect(withdraw).toContain('YOUR DAILY LIMIT');
    expect(withdraw).toContain('GOVERNING ACTIVE PAID BASE KEEP L{withdrawalStatus.governingKeepLevel}');
    expect(withdraw).toContain('YOUR WITHDRAWAL LIMIT IS UNAVAILABLE');
    expect(withdraw).toContain("cooldownActive ? ' · COOLDOWN ACTIVE' : ''");
    expect(withdraw).toContain('limitLoading || limitError ? null : withdrawalStatus');
    expect(withdraw).toContain('<Btn disabled={busy || custodyHeld || !verifiedWithdrawalStatus || amt < min || overPersonalLimit} onClick={submit}>');
    expect(withdraw).not.toContain('withdrawDailyCapForKeepLevel');
    expect(withdraw).not.toMatch(/GLOBAL[^\n]*CAP|SYSTEM[^\n]*CAP|ALL PLAYERS[^\n]*CAP/i);
  });
});

describe('auth-only KEEP to shards conversion', () => {
  it('keeps a retry key for one exact amount and replaces it when the amount changes', () => {
    let n = 0;
    const key = (): string => `convert-${++n}`;
    const first = stableKeepConversionAttempt(null, '125', key);
    expect(stableKeepConversionAttempt(first, '125', key)).toBe(first);
    expect(stableKeepConversionAttempt(first, '126', key)).toEqual({ amount: '126', key: 'convert-2' });
  });

  it('keeps the converter reachable before the deedless land lock', () => {
    const source = readFileSync(new URL('./menu.tsx', import.meta.url), 'utf8');
    const locked = source.slice(source.indexOf('function ExchangeLockedScreen'), source.indexOf('export interface KeepConversionAttempt'));
    expect(locked).toContain('<KeepToShardsPanel');
    expect(locked.indexOf('<KeepToShardsPanel')).toBeLessThan(locked.indexOf('<LandLocked'));
    const panel = source.slice(source.indexOf('function KeepToShardsPanel'), source.indexOf('function ExchangeOwnedScreen'));
    expect(panel).toContain("'/forge/convert'");
    expect(panel).toContain('idempotencyKey: attempt.key');
    expect(panel).toContain('...withSelectedBase({})');
    expect(panel).toMatch(/ONE-WAY:[\s\S]+Shards cannot be withdrawn/);
  });
});

describe('reserve-backed KEEP vending', () => {
  it('shows an unavailable state and no SOL payment action', () => {
    const source = readFileSync(new URL('./menu.tsx', import.meta.url), 'utf8');
    const exchange = source.slice(source.indexOf('function ExchangeOwnedScreen'), source.indexOf('interface EconomyStatsDto'));
    expect(exchange).toContain('TEMPORARILY UNAVAILABLE');
    expect(exchange).toContain('NO SOL PAYMENT WILL BE REQUESTED');
    expect(exchange).not.toContain('useKeepVend');
    expect(exchange).not.toContain('KEEP PURCHASED');
  });
});
