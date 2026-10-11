/**
 * Resend (https://resend.com) implementation of the injected EmailSender seam
 * (auth/twofa.ts). One module, one fetch — no SDK dependency for a single POST.
 * Every mail carries a plain-text part (survives every spam filter and
 * clients' dark modes unchanged); the alpha mails additionally pass a branded
 * HTML part (game/alphaEmails.ts). 2FA stays text-only on purpose.
 *
 * Wired at boot by server.ts when RESEND_API_KEY + EMAIL_FROM are both set.
 * The fallback logs only in development and rejects everywhere else, so a
 * production challenge can never claim delivery through a console line.
 */
import type { EmailSender } from '../auth/twofa';

const RESEND_URL = 'https://api.resend.com/emails';

export function makeResendEmailSender(
  apiKey: string, from: string, fetchImpl: typeof fetch = fetch,
): EmailSender {
  return async (to, subject, body, html, options) => {
    const res = await fetchImpl(RESEND_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...(options?.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {}),
      },
      // text is always sent — it is the fallback part for clients that block
      // HTML, and the only part when a caller (2FA) passes no html.
      body: JSON.stringify({ from, to, subject, text: body, ...(html ? { html } : {}) }),
      // A hung provider must never pin a request handler open indefinitely —
      // the apply route used to await this in-line, and approve still does
      // (security review 2026-08-05 finding 6).
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      // Callers decide whether a failed send fails the operation (2FA does,
      // alpha application does not) — so this must THROW, never swallow.
      // STATUS ONLY, no response body: Resend's invalid-recipient errors echo
      // the `to` address, and these errors land in server logs — that would be
      // applicant PII in the log stream (security review finding 7).
      throw new Error(`resend: ${res.status} ${res.statusText}`);
    }
  };
}
