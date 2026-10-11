/**
 * The support address is a promise made in the Terms; if the app ever showed a
 * different one, players would write to a mailbox nobody reads (D-098).
 */
import { describe, expect, it } from 'vitest';
import {
  DISCORD_URL, PRIVY_HELP_URL, SUPPORT_EMAIL, supportMailto, supportSubject,
} from './support';

describe('supportMailto — a link that reaches the mailbox intact', () => {
  it('percent-encodes subject and body, never as "+" (mail clients show that literally)', () => {
    const link = supportMailto('Lost authenticator · Wallet1', 'line one\nline two');
    expect(link).toBe(
      `mailto:${SUPPORT_EMAIL}?subject=Lost%20authenticator%20%C2%B7%20Wallet1&body=line%20one%0Aline%20two`,
    );
    expect(link).not.toContain('+');
  });

  it('cannot smuggle extra header fields through a crafted subject', () => {
    const link = supportMailto('a&cc=x@y.z#frag?to=q', 'b&bcc=x');
    // Exactly one subject and one body field, every delimiter encoded away.
    expect(link).toMatch(new RegExp(`^mailto:${SUPPORT_EMAIL}\\?subject=[^&#?]*&body=[^&#?]*$`));
    const [, subject, body] = link.match(/subject=([^&]*)&body=(.*)$/)!;
    expect(decodeURIComponent(subject!)).toBe('a&cc=x@y.z#frag?to=q');
    expect(decodeURIComponent(body!)).toBe('b&bcc=x');
  });

  it('omits the body field when there is nothing to say', () => {
    expect(supportMailto('Hello')).toBe(`mailto:${SUPPORT_EMAIL}?subject=Hello`);
    expect(supportMailto('Hello', '')).toBe(`mailto:${SUPPORT_EMAIL}?subject=Hello`);
  });

  it('puts the wallet, and only the wallet, into the subject', () => {
    // A public key is what support needs first; a code or secret never belongs
    // in a link. The URL-shape assertion above is what pins "subject and body
    // only" — there is no third field for anything else to ride in on.
    expect(supportSubject('Lost authenticator', 'Wallet1')).toBe('Lost authenticator · Wallet1');
    expect(supportSubject('Lost authenticator', null)).toBe('Lost authenticator');
    expect(supportSubject('Lost authenticator', undefined)).toBe('Lost authenticator');
  });
});
