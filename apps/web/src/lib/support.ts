/**
 * The ONE support contact the app carries (D-098, owner 2026-09-02): the
 * address the Terms already promise, plus the Discord invite. Every
 * "contact support" in the client resolves to these strings, so a player who
 * hits a custody dead end (lost authenticator, no verified email, failed
 * payout) is never left with a sentence and no address.
 *
 * Pure string building, no DOM, no state. support.test.ts pins SUPPORT_EMAIL
 * to the address in landing/terms.html so the app and the Terms cannot drift.
 */

export const SUPPORT_EMAIL = 'support@pixelkingdomwars.com';

export const DISCORD_URL = 'https://discord.gg/PWb65fg3mN';

/** Privy's own help centre — the only place a lost Privy Wallet MFA can be
 * raised with the vendor. There is no developer reset and no server API
 * (K-074), so the app links the player there rather than pretending we can. */
export const PRIVY_HELP_URL = 'https://www.privy.io/user-help-center';

/** The wallet is the first thing support needs; put it in the subject so a
 * one-line mail is already actionable. Public key only — never a code. */
export function supportSubject(topic: string, wallet: string | null | undefined): string {
  return wallet ? `${topic} · ${wallet}` : topic;
}

/**
 * mailto: with percent-encoded subject/body (RFC 6068). encodeURIComponent,
 * not URLSearchParams: the latter writes a space as '+', which mail clients
 * show literally. Encoding also means a subject containing '&' or '#' cannot
 * smuggle extra header fields into the link.
 */
export function supportMailto(subject: string, body?: string): string {
  const query = [`subject=${encodeURIComponent(subject)}`];
  if (body) query.push(`body=${encodeURIComponent(body)}`);
  return `mailto:${SUPPORT_EMAIL}?${query.join('&')}`;
}
