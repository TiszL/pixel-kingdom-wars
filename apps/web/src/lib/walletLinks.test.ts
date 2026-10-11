/**
 * On iOS a universal link is the ONLY route into a wallet, so a malformed one is
 * not a cosmetic bug — it is the dead end this whole change exists to remove,
 * and it fails silently (blank page inside the wallet, no error anywhere).
 *
 * Every assertion here corresponds to a mistake that produces exactly that
 * silent failure: double-encoding, a missing `ref`, the wrong version segment,
 * URL/URLSearchParams normalisation, or phantom.app instead of phantom.com.
 */
import { describe, expect, it } from 'vitest';
import { browseLink, storeLink, WALLET_KEYS } from './walletLinks';

const TARGET = 'https://play.shardkeep.io/';
const REF = 'https://play.shardkeep.io';

describe('browseLink — the encoding rules, each of which has burned someone', () => {
  it("reproduces Phantom's documented example verbatim", () => {
    expect(browseLink('phantom', 'https://magiceden.io/item-details/ED8P', 'https://magiceden.io'))
      .toBe('https://phantom.com/ul/browse/https%3A%2F%2Fmagiceden.io%2Fitem-details%2FED8P?ref=https%3A%2F%2Fmagiceden.io');
  });

  it('encodes the target EXACTLY once, scheme included', () => {
    const link = browseLink('phantom', TARGET, REF);
    expect(link).toContain('https%3A%2F%2Fplay.shardkeep.io%2F');
    expect(link).not.toContain('%253A'); // a double-encoded ':' — the classic
  });

  it('always carries the ref all three wallets require', () => {
    for (const w of WALLET_KEYS) expect(browseLink(w, TARGET, REF)).toContain(`?ref=${encodeURIComponent(REF)}`);
  });

  it('uses each wallet\'s own host and version segment (Phantom has NO /v1)', () => {
    expect(browseLink('phantom', TARGET, REF).startsWith('https://phantom.com/ul/browse/')).toBe(true);
    expect(browseLink('solflare', TARGET, REF).startsWith('https://solflare.com/ul/v1/browse/')).toBe(true);
    expect(browseLink('backpack', TARGET, REF).startsWith('https://backpack.app/ul/v1/browse/')).toBe(true);
  });

  it('never points at phantom.app — it serves no assetlinks.json, so Android opens Chrome instead of the wallet', () => {
    expect(browseLink('phantom', TARGET, REF)).not.toContain('phantom.app');
  });

  it('encodes a space as %20, never as + (the URLSearchParams trap)', () => {
    const link = browseLink('solflare', 'https://play.shardkeep.io/a b', REF);
    expect(link).toContain('%20');
    expect(link).not.toContain('+');
  });

  it('preserves query and fragment of the target as encoded payload, not as its own params', () => {
    const link = browseLink('backpack', 'https://play.shardkeep.io/?ref=abc#x', REF);
    // The target's '?' must be inside the path segment; only ONE real '?' (ours).
    expect(link.split('?')).toHaveLength(2);
    expect(link).toContain('%3Fref%3Dabc%23x');
  });
});

describe('storeLink — the install route rendered next to every deep link', () => {
  it('sends Android to the Play listing for the id in the wallet\'s assetlinks.json', () => {
    expect(storeLink('phantom', 'android')).toBe('https://play.google.com/store/apps/details?id=app.phantom');
    expect(storeLink('solflare', 'android')).toBe('https://play.google.com/store/apps/details?id=com.solflare.mobile');
    expect(storeLink('backpack', 'android')).toBe('https://play.google.com/store/apps/details?id=app.backpack.mobile');
  });

  it('has a real https destination for every wallet on every platform — an install row with no link is a dead end', () => {
    for (const w of WALLET_KEYS) {
      for (const p of ['ios', 'android', 'desktop'] as const) {
        expect(storeLink(w, p)).toMatch(/^https:\/\/\S+$/);
      }
    }
  });
});
