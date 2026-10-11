/**
 * Closed-alpha application + invite-code tests (owner decisions 2026-08-05).
 *
 * WHY THIS SUITE IS ADVERSARIAL: /alpha/apply is the only fully PUBLIC write
 * endpoint in the app (reachable cross-origin from the marketing site), and
 * alpha_access is half of the AUTH GATE on every request — so the properties
 * pinned here are the ones an attacker probes: email enumeration, honeypot
 * detectability, invite single-use, used-vs-unknown code oracles, and whether
 * the gate really is the UNION of env list, admins and the table (not any one
 * of them alone).
 */
import { getPublicKeyAsync, signAsync, utils } from '@noble/ed25519';
import bs58 from 'bs58';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEEKER } from '@shardkeep/shared';
import { buildApp } from '../src/app';
import { resetAutoDetectBudget } from '../src/auth/seeker';
import { SESSION_COOKIE } from '../src/auth/session';
import type { EmailSender } from '../src/auth/twofa';
import { loadConfig } from '../src/config';
import {
  alphaAccess, alphaApplications, alphaInviteBatches, alphaInviteCodes, players,
} from '../src/db/schema';
import { formatInviteCode, generateInviteCode } from '../src/game/alpha';
import { TEST_CONFIG, connectTestDb, randomWallet } from './helpers';

let conn: ReturnType<typeof connectTestDb>;

/** Captured outbound email. One shared box; tests slice by recipient. */
const sent: Array<{ to: string; subject: string; body: string; html?: string }> = [];
const fakeSender: EmailSender = async (to, subject, body, html) => {
  // Provider-outage stand-in: any 'fail-…' recipient blows up the transport.
  if (to.startsWith('fail-')) throw new Error('smtp down');
  sent.push({ to, subject, body, ...(html === undefined ? {} : { html }) });
};
const mailsTo = (to: string) => sent.filter((m) => m.to === to);

/** Fake Turnstile verifier: records the form bodies, answers `turnstileOk`. */
let turnstileOk = true;
const turnstileCalls: string[] = [];
const fakeTurnstileFetch = (async (_url: unknown, init?: RequestInit) =>
  new Response(
    JSON.stringify({ success: (turnstileCalls.push(String(init?.body)), turnstileOk) }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )) as unknown as typeof fetch;

// Keypairs whose pubkeys are baked into the gated app's env lists.
let adminKp: { secretKey: Uint8Array; wallet: string };
let envKp: { secretKey: Uint8Array; wallet: string };

let openApp: FastifyInstance; // no gate, no admin, no turnstile
let gatedApp: FastifyInstance; // ALPHA_WALLETS=[envKp], ADMIN_WALLETS=[adminKp]
let turnstileApp: FastifyInstance; // TURNSTILE_SECRET_KEY set, fake verifier

async function makeKeypair() {
  const secretKey = utils.randomSecretKey();
  return { secretKey, wallet: bs58.encode(await getPublicKeyAsync(secretKey)) };
}

/** SIWS login on `app`; sign-in is open by design (see auth/routes.ts). */
async function login(app: FastifyInstance, kp: { secretKey: Uint8Array; wallet: string }): Promise<string> {
  const ch = await app.inject({ method: 'GET', url: '/auth/challenge', query: { wallet: kp.wallet } });
  expect(ch.statusCode).toBe(200);
  const { message } = ch.json() as { message: string };
  const signature = bs58.encode(await signAsync(new TextEncoder().encode(message), kp.secretKey));
  const res = await app.inject({ method: 'POST', url: '/auth/verify', payload: { wallet: kp.wallet, signature } });
  expect(res.statusCode).toBe(200);
  return res.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
}

/** Mint an approved code via the gated app's admin — shared by hardening tests. */
async function mintCodeShared(): Promise<{ code: string; applicationId: string }> {
  const adminCookie = await login(gatedApp, adminKp);
  const a = await apply(uniqueEmail());
  const res = await gatedApp.inject({
    method: 'POST', url: `/admin/alpha/${a.id}/approve`, cookies: { [SESSION_COOKIE]: adminCookie },
  });
  expect(res.statusCode).toBe(200);
  return { code: (res.json() as { inviteCode: string }).inviteCode, applicationId: a.id };
}

/** One-off app with a custom sender (the slow-provider timing test). */
async function buildAlphaApp(deps: { emailSender: EmailSender }): Promise<FastifyInstance> {
  const app = await buildApp(TEST_CONFIG, conn.db, deps);
  await app.ready();
  return app;
}

const uniqueEmail = (): string =>
  `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}@example.com`;

/** Submit an application on openApp and return its row. */
async function apply(email: string) {
  const res = await openApp.inject({ method: 'POST', url: '/alpha/apply', payload: { email } });
  expect(res.statusCode).toBe(200);
  const [row] = await conn.db.select().from(alphaApplications)
    .where(eq(alphaApplications.email, email.trim().toLowerCase()));
  return row!;
}

beforeAll(async () => {
  conn = connectTestDb();
  adminKp = await makeKeypair();
  envKp = await makeKeypair();
  openApp = await buildApp(TEST_CONFIG, conn.db, { emailSender: fakeSender });
  gatedApp = await buildApp(
    // adminKp is DELIBERATELY NOT in ALPHA_WALLETS: the admin tests double as
    // the mutation check that the gate union includes ADMIN_WALLETS.
    { ...TEST_CONFIG, ALPHA_WALLETS: [envKp.wallet], ADMIN_WALLETS: [adminKp.wallet] },
    conn.db,
    { emailSender: fakeSender },
  );
  turnstileApp = await buildApp(
    { ...TEST_CONFIG, TURNSTILE_SECRET_KEY: 'ts-secret' },
    conn.db,
    { emailSender: fakeSender, turnstileFetch: fakeTurnstileFetch },
  );
  await Promise.all([openApp.ready(), gatedApp.ready(), turnstileApp.ready()]);
});

afterAll(async () => {
  await Promise.all([openApp.close(), gatedApp.close(), turnstileApp.close()]);
  await conn.sql.end();
});

describe('invite codes', () => {
  it('are 26-char base32 and collision-free in practice', () => {
    const codes = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const code = generateInviteCode();
      expect(code).toMatch(/^[A-Z2-7]{26}$/); // 128 bits — unguessable by construction
      codes.add(code);
    }
    expect(codes.size).toBe(200);
  });
});

describe('POST /alpha/apply (public, cross-origin)', () => {
  it('records the application (lowercased) and sends the received email', async () => {
    const email = uniqueEmail();
    const mixed = email.toUpperCase(); // form input arrives however typed
    const res = await openApp.inject({ method: 'POST', url: '/alpha/apply', payload: { email: ` ${mixed} ` } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    const rows = await conn.db.select().from(alphaApplications).where(eq(alphaApplications.email, email));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('pending');
    const mail = mailsTo(email);
    expect(mail).toHaveLength(1);
    expect(mail[0]!.subject).toMatch(/application received/i);
    expect(mail[0]!.html).toContain('https://pixelkingdomwars.com/assets/img/pkw-profile-512.png?v=1c8d0b13');
    expect(mail[0]!.html).not.toContain('/assets/img/icon-192.png');
  });

  it('a duplicate email gets the IDENTICAL response, no second row, no second email', async () => {
    // The response must not be an address-enumeration oracle, and a double
    // submit must not double anything.
    const email = uniqueEmail();
    const first = await openApp.inject({ method: 'POST', url: '/alpha/apply', payload: { email } });
    const again = await openApp.inject({ method: 'POST', url: '/alpha/apply', payload: { email: email.toUpperCase() } });
    expect(again.statusCode).toBe(first.statusCode);
    expect(again.body).toBe(first.body);
    expect(await conn.db.select().from(alphaApplications).where(eq(alphaApplications.email, email))).toHaveLength(1);
    expect(mailsTo(email)).toHaveLength(1);
  });

  it('a filled honeypot is silently accepted and dropped — same body, nothing stored, nothing sent', async () => {
    const email = uniqueEmail();
    const res = await openApp.inject({
      method: 'POST', url: '/alpha/apply',
      payload: { email, website: 'https://definitely-a-human.example' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true }); // indistinguishable from success
    expect(await conn.db.select().from(alphaApplications).where(eq(alphaApplications.email, email))).toHaveLength(0);
    expect(mailsTo(email)).toHaveLength(0);
  });

  it('an over-long or non-string honeypot value is STILL the silent drop, never a 400 naming the field', async () => {
    // The landing input carries no maxlength, and ApplyBody caps website at 256
    // — so a parse-first route answered a stuffed trap with "invalid request:
    // website: …", handing the bot the one field name it must leave empty. The
    // honeypot check runs BEFORE zod exactly so every filled-trap variant gets
    // the same success body as a real submission.
    const email = uniqueEmail();
    for (const website of ['x'.repeat(5000), 12345]) {
      const res = await openApp.inject({
        method: 'POST', url: '/alpha/apply',
        payload: { email, website },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true }); // byte-identical to success
    }
    expect(await conn.db.select().from(alphaApplications).where(eq(alphaApplications.email, email))).toHaveLength(0);
    expect(mailsTo(email)).toHaveLength(0);
  });

  it('stores handle, socials and EVERY answers key from the exact landing-form payload', async () => {
    // SEAM PIN (landing/index.html buildPayload ↔ ApplyBody): zod STRIPS unknown
    // top-level keys, so if either side renames a field or moves a question out
    // of `answers`, review data would vanish SILENTLY (the request still 200s).
    // This posts the byte-shape the landing form actually sends — if this test
    // starts failing, fix the landing form or ApplyBody together, never one side.
    const email = uniqueEmail();
    const res = await openApp.inject({
      method: 'POST', url: '/alpha/apply',
      payload: {
        email, handle: 'Torn', socials: '@torn',
        answers: {
          referral: 'a friend', baseBuilders: 'CoC since 2014',
          solanaExperience: 'active', device: 'seeker',
          hoursPerWeek: '10', breakFirst: 'the market',
        },
        website: '', turnstileToken: '',
      },
    });
    expect(res.statusCode).toBe(200);
    const [row] = await conn.db.select().from(alphaApplications).where(eq(alphaApplications.email, email));
    expect(row!.handle).toBe('Torn');
    expect(row!.socials).toBe('@torn');
    expect(row!.answers).toEqual({
      referral: 'a friend', baseBuilders: 'CoC since 2014',
      solanaExperience: 'active', device: 'seeker',
      hoursPerWeek: '10', breakFirst: 'the market',
    });
  });

  it('rejects a non-email', async () => {
    const res = await openApp.inject({ method: 'POST', url: '/alpha/apply', payload: { email: 'not-an-email' } });
    expect(res.statusCode).toBe(400);
  });

  it('an email-provider outage does NOT fail the request — the application row is the record', async () => {
    const email = `fail-${uniqueEmail()}`; // fakeSender throws for this recipient
    const res = await openApp.inject({ method: 'POST', url: '/alpha/apply', payload: { email } });
    expect(res.statusCode).toBe(200);
    expect(await conn.db.select().from(alphaApplications).where(eq(alphaApplications.email, email))).toHaveLength(1);
  });
});

describe('Turnstile (server-side, only when configured)', () => {
  it('a missing token is a 4xx and the verifier is never consulted', async () => {
    const email = uniqueEmail();
    const before = turnstileCalls.length;
    const res = await turnstileApp.inject({ method: 'POST', url: '/alpha/apply', payload: { email } });
    expect(res.statusCode).toBe(400);
    expect(turnstileCalls.length).toBe(before);
    expect(await conn.db.select().from(alphaApplications).where(eq(alphaApplications.email, email))).toHaveLength(0);
  });

  it('a token Cloudflare rejects is a 4xx and stores nothing', async () => {
    const email = uniqueEmail();
    turnstileOk = false;
    try {
      const res = await turnstileApp.inject({
        method: 'POST', url: '/alpha/apply', payload: { email, turnstileToken: 'tok-bad' },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      turnstileOk = true;
    }
    expect(turnstileCalls.at(-1)).toContain('secret=ts-secret'); // the SERVER secret was used
    expect(turnstileCalls.at(-1)).toContain('response=tok-bad');
    expect(await conn.db.select().from(alphaApplications).where(eq(alphaApplications.email, email))).toHaveLength(0);
  });

  it('a valid token passes', async () => {
    const email = uniqueEmail();
    const res = await turnstileApp.inject({
      method: 'POST', url: '/alpha/apply', payload: { email, turnstileToken: 'tok-good' },
    });
    expect(res.statusCode).toBe(200);
    expect(await conn.db.select().from(alphaApplications).where(eq(alphaApplications.email, email))).toHaveLength(1);
  });

  it('the honeypot drop happens BEFORE the challenge — a bot that skipped Turnstile learns nothing', async () => {
    const email = uniqueEmail();
    const before = turnstileCalls.length;
    const res = await turnstileApp.inject({
      method: 'POST', url: '/alpha/apply', payload: { email, website: 'spam' }, // no token at all
    });
    expect(res.statusCode).toBe(200); // NOT the 400 a missing token normally earns
    expect(res.json()).toEqual({ ok: true });
    expect(turnstileCalls.length).toBe(before);
    expect(await conn.db.select().from(alphaApplications).where(eq(alphaApplications.email, email))).toHaveLength(0);
  });
});

describe('admin routes (/admin/alpha/*)', () => {
  it('do not exist while ADMIN_WALLETS is unset — 404 with and without a session', async () => {
    expect((await openApp.inject({ url: '/admin/alpha/stats' })).statusCode).toBe(404);
    const cookie = await login(openApp, await makeKeypair());
    for (const probe of [
      { method: 'GET' as const, url: '/admin/alpha/stats' },
      { method: 'GET' as const, url: '/admin/alpha/applications' },
      { method: 'GET' as const, url: '/admin/alpha/invites' },
      { method: 'POST' as const, url: '/admin/alpha/invites' },
      { method: 'POST' as const, url: `/admin/alpha/${crypto.randomUUID()}/approve` },
      { method: 'POST' as const, url: `/admin/alpha/${crypto.randomUUID()}/reject` },
    ]) {
      const res = await openApp.inject({ ...probe, cookies: { [SESSION_COOKIE]: cookie } });
      expect(res.statusCode, probe.url).toBe(404);
    }
  });

  it('403 for an authenticated non-admin wallet', async () => {
    const cookie = await login(gatedApp, envKp); // alpha-allowed, NOT admin
    for (const probe of [
      { method: 'GET' as const, url: '/admin/alpha/stats' },
      { method: 'GET' as const, url: '/admin/alpha/invites' },
      {
        method: 'POST' as const, url: '/admin/alpha/invites',
        payload: { count: 1, idempotencyKey: crypto.randomUUID() },
      },
    ]) {
      const res = await gatedApp.inject({ ...probe, cookies: { [SESSION_COOKIE]: cookie } });
      expect(res.statusCode, probe.url).toBe(403);
      expect(res.json().error.message).toMatch(/admin/i);
    }
  });

  it('work for an admin wallet — which also proves the gate union includes ADMIN_WALLETS', async () => {
    // adminKp is NOT in ALPHA_WALLETS and has no alpha_access row: if the gate
    // union dropped the admin term, authenticate would 403 before requireAdmin
    // ever ran and this test would fail.
    const cookie = await login(gatedApp, adminKp);
    const res = await gatedApp.inject({ url: '/admin/alpha/stats', cookies: { [SESSION_COOKIE]: cookie } });
    expect(res.statusCode).toBe(200);
    const stats = res.json() as Record<string, number>;
    for (const k of ['pending', 'approved', 'rejected', 'redeemed', 'generated', 'access']) {
      expect(typeof stats[k], k).toBe('number');
    }
  });

  it('approve mints a unique 128-bit code, stamps the row and emails redeem instructions', async () => {
    const adminCookie = await login(gatedApp, adminKp);
    const a = await apply(uniqueEmail());
    const b = await apply(uniqueEmail());

    const res = await gatedApp.inject({
      method: 'POST', url: `/admin/alpha/${a.id}/approve`, cookies: { [SESSION_COOKIE]: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const out = res.json() as { inviteCode: string; email: string; emailSent: boolean };
    expect(out.inviteCode).toMatch(/^[A-Z2-7]{26}$/);
    expect(out.emailSent).toBe(true);

    const [rowA] = await conn.db.select().from(alphaApplications).where(eq(alphaApplications.id, a.id));
    expect(rowA!.status).toBe('approved');
    expect(rowA!.inviteCode).toBe(out.inviteCode);
    expect(rowA!.invitedAt).not.toBeNull();

    // The invite email carries the code (formatted) and the play URL — in BOTH
    // parts. The text part is the fallback for HTML-blocking clients: if the
    // code or link exists only in the HTML, those users get a useless email.
    const invite = mailsTo(a.email).find((m) => /you're in/i.test(m.subject));
    expect(invite).toBeDefined();
    expect(invite!.body).toContain(formatInviteCode(out.inviteCode));
    expect(invite!.body).toContain(TEST_CONFIG.WEB_ORIGIN[0]!);
    expect(invite!.html).toBeDefined();
    expect(invite!.html).toContain(formatInviteCode(out.inviteCode));
    expect(invite!.html).toContain(`href="${TEST_CONFIG.WEB_ORIGIN[0]!}`);

    // Distinct codes per application.
    const res2 = await gatedApp.inject({
      method: 'POST', url: `/admin/alpha/${b.id}/approve`, cookies: { [SESSION_COOKIE]: adminCookie },
    });
    expect((res2.json() as { inviteCode: string }).inviteCode).not.toBe(out.inviteCode);

    // Re-approving must NOT silently rotate the already-emailed code.
    const again = await gatedApp.inject({
      method: 'POST', url: `/admin/alpha/${a.id}/approve`, cookies: { [SESSION_COOKIE]: adminCookie },
    });
    expect(again.statusCode).toBe(409);
    const [rowA2] = await conn.db.select().from(alphaApplications).where(eq(alphaApplications.id, a.id));
    expect(rowA2!.inviteCode).toBe(out.inviteCode);
  });

  it('reject stores the note, sends NO email, and refuses to reject an approved application', async () => {
    const adminCookie = await login(gatedApp, adminKp);
    const a = await apply(uniqueEmail());
    const sentBefore = sent.length;

    const res = await gatedApp.inject({
      method: 'POST', url: `/admin/alpha/${a.id}/reject`, cookies: { [SESSION_COOKIE]: adminCookie },
      payload: { note: 'obvious farm cluster' },
    });
    expect(res.statusCode).toBe(200);
    const [row] = await conn.db.select().from(alphaApplications).where(eq(alphaApplications.id, a.id));
    expect(row!.status).toBe('rejected');
    expect(row!.reviewerNote).toBe('obvious farm cluster');
    expect(sent.length).toBe(sentBefore); // NO email by default (owner-locked)

    // Approved rows are not rejectable — that would strand or lie about an
    // emailed code; revoking access is a manual alpha_access delete instead.
    const b = await apply(uniqueEmail());
    await gatedApp.inject({
      method: 'POST', url: `/admin/alpha/${b.id}/approve`, cookies: { [SESSION_COOKIE]: adminCookie },
    });
    const reject = await gatedApp.inject({
      method: 'POST', url: `/admin/alpha/${b.id}/reject`, cookies: { [SESSION_COOKIE]: adminCookie },
    });
    expect(reject.statusCode).toBe(409);

    // A rejected application can be approved after all (admin changed their mind).
    const rehab = await gatedApp.inject({
      method: 'POST', url: `/admin/alpha/${a.id}/approve`, cookies: { [SESSION_COOKIE]: adminCookie },
    });
    expect(rehab.statusCode).toBe(200);
  });

  it('404 for an unknown application id', async () => {
    const adminCookie = await login(gatedApp, adminKp);
    const res = await gatedApp.inject({
      method: 'POST', url: `/admin/alpha/${crypto.randomUUID()}/approve`, cookies: { [SESSION_COOKIE]: adminCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it('generates every preset, an arbitrary count and the 100-code maximum atomically', async () => {
    const adminCookie = await login(gatedApp, adminKp);
    const all = new Set<string>();
    for (const count of [1, 10, 20, 37, 50, 100]) {
      const res = await gatedApp.inject({
        method: 'POST', url: '/admin/alpha/invites', cookies: { [SESSION_COOKIE]: adminCookie },
        payload: { count, idempotencyKey: crypto.randomUUID() },
      });
      expect(res.statusCode, `count ${count}`).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const batch = res.json() as { count: number; codes: Array<{ code: string; ordinal: number }> };
      expect(batch.count).toBe(count);
      expect(batch.codes).toHaveLength(count);
      expect(batch.codes.map((row) => row.ordinal)).toEqual(Array.from({ length: count }, (_, i) => i));
      for (const { code } of batch.codes) {
        expect(code).toMatch(/^[A-Z2-7]{26}$/);
        all.add(code);
      }
    }
    expect(all.size).toBe(218);
  });

  it('rejects invalid generation counts even when the caller is an admin', async () => {
    const adminCookie = await login(gatedApp, adminKp);
    for (const count of [0, -1, 1.5, 101, '10']) {
      const res = await gatedApp.inject({
        method: 'POST', url: '/admin/alpha/invites', cookies: { [SESSION_COOKIE]: adminCookie },
        payload: { count, idempotencyKey: crypto.randomUUID() },
      });
      expect(res.statusCode, `count ${String(count)}`).toBe(400);
    }
  });

  it('replays one idempotency key as the exact batch and refuses count drift', async () => {
    const adminCookie = await login(gatedApp, adminKp);
    const idempotencyKey = crypto.randomUUID();
    const request = (count: number) => gatedApp.inject({
      method: 'POST', url: '/admin/alpha/invites', cookies: { [SESSION_COOKIE]: adminCookie },
      payload: { count, idempotencyKey },
    });
    const first = await request(20);
    const replay = await request(20);
    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(replay.body).toBe(first.body);
    expect((await request(10)).statusCode).toBe(409);

    const batches = await conn.db.select().from(alphaInviteBatches)
      .where(eq(alphaInviteBatches.idempotencyKey, idempotencyKey));
    expect(batches).toHaveLength(1);
    expect(await conn.db.select().from(alphaInviteCodes)
      .where(eq(alphaInviteCodes.batchId, batches[0]!.id))).toHaveLength(20);
  });

  it('serialises concurrent idempotent generation into one complete batch', async () => {
    const adminCookie = await login(gatedApp, adminKp);
    const idempotencyKey = crypto.randomUUID();
    const inject = () => gatedApp.inject({
      method: 'POST', url: '/admin/alpha/invites', cookies: { [SESSION_COOKIE]: adminCookie },
      payload: { count: 50, idempotencyKey },
    });
    const [a, b] = await Promise.all([inject(), inject()]);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(a.body).toBe(b.body);
    const batches = await conn.db.select().from(alphaInviteBatches)
      .where(eq(alphaInviteBatches.idempotencyKey, idempotencyKey));
    expect(batches).toHaveLength(1);
    expect(await conn.db.select().from(alphaInviteCodes)
      .where(eq(alphaInviteCodes.batchId, batches[0]!.id))).toHaveLength(50);
  });

  it('history is private/no-store, paginated, and merges batch and old application codes', async () => {
    const adminCookie = await login(gatedApp, adminKp);
    const generated = await gatedApp.inject({
      method: 'POST', url: '/admin/alpha/invites', cookies: { [SESSION_COOKIE]: adminCookie },
      payload: { count: 2, idempotencyKey: crypto.randomUUID() },
    });
    const generatedCodes = (generated.json() as { codes: Array<{ code: string }> }).codes.map(({ code }) => code);
    const application = await apply(uniqueEmail());
    const approved = await gatedApp.inject({
      method: 'POST', url: `/admin/alpha/${application.id}/approve`,
      cookies: { [SESSION_COOKIE]: adminCookie },
    });
    const applicationCode = (approved.json() as { inviteCode: string }).inviteCode;

    const first = await gatedApp.inject({
      method: 'GET', url: '/admin/alpha/invites?limit=2&offset=0',
      cookies: { [SESSION_COOKIE]: adminCookie },
    });
    expect(first.statusCode).toBe(200);
    expect(first.headers['cache-control']).toBe('no-store');
    const firstPage = first.json() as { invites: Array<{ code: string; source: string }>; nextOffset: number | null };
    expect(firstPage.invites).toHaveLength(2);
    expect(firstPage.nextOffset).toBe(2);
    const second = await gatedApp.inject({
      method: 'GET', url: `/admin/alpha/invites?limit=100&offset=${firstPage.nextOffset}`,
      cookies: { [SESSION_COOKIE]: adminCookie },
    });
    const rows = [...firstPage.invites, ...(second.json() as { invites: typeof firstPage.invites }).invites];
    for (const code of generatedCodes) {
      expect(rows).toContainEqual(expect.objectContaining({ code, source: 'generated' }));
    }
    expect(rows).toContainEqual(expect.objectContaining({ code: applicationCode, source: 'application' }));
  });
});

describe('POST /alpha/redeem + the gate', () => {
  /** Full pipeline: apply → approve → the code, straight from the admin response. */
  async function mintCode(): Promise<{ code: string; applicationId: string }> {
    const adminCookie = await login(gatedApp, adminKp);
    const a = await apply(uniqueEmail());
    const res = await gatedApp.inject({
      method: 'POST', url: `/admin/alpha/${a.id}/approve`, cookies: { [SESSION_COOKIE]: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    return { code: (res.json() as { inviteCode: string }).inviteCode, applicationId: a.id };
  }

  async function mintGeneratedCode(): Promise<string> {
    const adminCookie = await login(gatedApp, adminKp);
    const res = await gatedApp.inject({
      method: 'POST', url: '/admin/alpha/invites', cookies: { [SESSION_COOKIE]: adminCookie },
      payload: { count: 1, idempotencyKey: crypto.randomUUID() },
    });
    expect(res.statusCode).toBe(200);
    return (res.json() as { codes: Array<{ code: string }> }).codes[0]!.code;
  }

  it('requires a session (401 without one)', async () => {
    const res = await gatedApp.inject({ method: 'POST', url: '/alpha/redeem', payload: { code: 'X'.repeat(26) } });
    expect(res.statusCode).toBe(401);
  });

  it('a stranger signs in, is gated with ALPHA_GATED, redeems (as the email formats the code), and is in', async () => {
    const { code, applicationId } = await mintCode();
    const kp = await makeKeypair();
    const cookie = await login(gatedApp, kp); // sign-in itself is open

    // Gated BEFORE redeeming — with the machine-readable reason the client
    // branches on to show the redeem UI.
    const before = await gatedApp.inject({ url: '/me', cookies: { [SESSION_COOKIE]: cookie } });
    expect(before.statusCode).toBe(403);
    expect(before.json().error.code).toBe('ALPHA_GATED');

    // Redeem exactly what a human pastes from the email: dashed, lowercased.
    const redeem = await gatedApp.inject({
      method: 'POST', url: '/alpha/redeem', cookies: { [SESSION_COOKIE]: cookie },
      payload: { code: formatInviteCode(code).toLowerCase() },
    });
    expect(redeem.statusCode).toBe(200);

    const [access] = await conn.db.select().from(alphaAccess).where(eq(alphaAccess.wallet, kp.wallet));
    expect(access?.source).toBe('invite');
    expect(access?.applicationId).toBe(applicationId);
    const [app] = await conn.db.select().from(alphaApplications).where(eq(alphaApplications.id, applicationId));
    expect(app!.redeemedWallet).toBe(kp.wallet);
    expect(app!.redeemedAt).not.toBeNull();

    // The gate now honours the table half of the union.
    const after = await gatedApp.inject({ url: '/me', cookies: { [SESSION_COOKIE]: cookie } });
    expect(after.statusCode).toBe(200);

    // Idempotent for the SAME wallet (a lost response must not strand the player).
    const again = await gatedApp.inject({
      method: 'POST', url: '/alpha/redeem', cookies: { [SESSION_COOKIE]: cookie }, payload: { code },
    });
    expect(again.statusCode).toBe(200);
    expect(await conn.db.select().from(alphaAccess).where(eq(alphaAccess.wallet, kp.wallet))).toHaveLength(1);
  });

  it('a standalone admin code admits one wallet and records its own audit row', async () => {
    const code = await mintGeneratedCode();
    const adminCookie = await login(gatedApp, adminKp);
    const beforeStats = (await gatedApp.inject({
      url: '/admin/alpha/stats', cookies: { [SESSION_COOKIE]: adminCookie },
    })).json() as { redeemed: number };
    const kp = await makeKeypair();
    const cookie = await login(gatedApp, kp);
    expect((await gatedApp.inject({ url: '/me', cookies: { [SESSION_COOKIE]: cookie } })).statusCode).toBe(403);
    const redeem = await gatedApp.inject({
      method: 'POST', url: '/alpha/redeem', cookies: { [SESSION_COOKIE]: cookie },
      payload: { code: formatInviteCode(code).toLowerCase() },
    });
    expect(redeem.statusCode).toBe(200);
    const [access] = await conn.db.select().from(alphaAccess).where(eq(alphaAccess.wallet, kp.wallet));
    expect(access).toMatchObject({ source: 'invite', applicationId: null });
    const [invite] = await conn.db.select().from(alphaInviteCodes).where(eq(alphaInviteCodes.code, code));
    expect(invite?.redeemedWallet).toBe(kp.wallet);
    expect(invite?.redeemedAt).not.toBeNull();
    const afterStats = (await gatedApp.inject({
      url: '/admin/alpha/stats', cookies: { [SESSION_COOKIE]: adminCookie },
    })).json() as { redeemed: number };
    expect(afterStats.redeemed).toBe(beforeStats.redeemed + 1);
    expect((await gatedApp.inject({ url: '/me', cookies: { [SESSION_COOKIE]: cookie } })).statusCode).toBe(200);
    // Lost-response retry remains idempotent while access is intact.
    expect((await gatedApp.inject({
      method: 'POST', url: '/alpha/redeem', cookies: { [SESSION_COOKIE]: cookie }, payload: { code },
    })).statusCode).toBe(200);
  });

  it('standalone codes keep the same single-use race and used-vs-unknown response', async () => {
    const code = await mintGeneratedCode();
    const [a, b] = [await makeKeypair(), await makeKeypair()];
    const [cookieA, cookieB] = [await login(gatedApp, a), await login(gatedApp, b)];
    const [resA, resB] = await Promise.all([
      gatedApp.inject({ method: 'POST', url: '/alpha/redeem', cookies: { [SESSION_COOKIE]: cookieA }, payload: { code } }),
      gatedApp.inject({ method: 'POST', url: '/alpha/redeem', cookies: { [SESSION_COOKIE]: cookieB }, payload: { code } }),
    ]);
    expect([resA.statusCode, resB.statusCode].sort()).toEqual([200, 400]);
    const loserCookie = resA.statusCode === 400 ? cookieA : cookieB;
    const used = resA.statusCode === 400 ? resA : resB;
    const unknown = await gatedApp.inject({
      method: 'POST', url: '/alpha/redeem', cookies: { [SESSION_COOKIE]: loserCookie },
      payload: { code: generateInviteCode() },
    });
    expect(unknown.statusCode).toBe(used.statusCode);
    expect(unknown.body).toBe(used.body);
  });

  it('revocation wins for a standalone code still held by its redeemed wallet', async () => {
    const code = await mintGeneratedCode();
    const kp = await makeKeypair();
    const cookie = await login(gatedApp, kp);
    expect((await gatedApp.inject({
      method: 'POST', url: '/alpha/redeem', cookies: { [SESSION_COOKIE]: cookie }, payload: { code },
    })).statusCode).toBe(200);
    await conn.db.delete(alphaAccess).where(eq(alphaAccess.wallet, kp.wallet));
    const retry = await gatedApp.inject({
      method: 'POST', url: '/alpha/redeem', cookies: { [SESSION_COOKIE]: cookie }, payload: { code },
    });
    expect(retry.statusCode).toBe(400);
    expect(await conn.db.select().from(alphaAccess).where(eq(alphaAccess.wallet, kp.wallet))).toHaveLength(0);
  });

  it('SINGLE-USE: a second wallet on a used code gets the EXACT unknown-code response, and no access', async () => {
    const { code, applicationId } = await mintCode();
    const winner = await makeKeypair();
    const winnerCookie = await login(gatedApp, winner);
    expect((await gatedApp.inject({
      method: 'POST', url: '/alpha/redeem', cookies: { [SESSION_COOKIE]: winnerCookie }, payload: { code },
    })).statusCode).toBe(200);

    const thief = await makeKeypair();
    const thiefCookie = await login(gatedApp, thief);
    const used = await gatedApp.inject({
      method: 'POST', url: '/alpha/redeem', cookies: { [SESSION_COOKIE]: thiefCookie }, payload: { code },
    });
    const unknown = await gatedApp.inject({
      method: 'POST', url: '/alpha/redeem', cookies: { [SESSION_COOKIE]: thiefCookie },
      payload: { code: generateInviteCode() }, // valid shape, never issued
    });
    // NO ORACLE: used and unknown must be byte-identical, or the endpoint
    // confirms which codes exist/were spent.
    expect(used.statusCode).toBeGreaterThanOrEqual(400);
    expect(used.statusCode).toBeLessThan(500);
    expect(used.statusCode).toBe(unknown.statusCode);
    expect(used.body).toBe(unknown.body);

    // Mutation check on single-use: the claim did not move, the thief got nothing.
    const [app] = await conn.db.select().from(alphaApplications).where(eq(alphaApplications.id, applicationId));
    expect(app!.redeemedWallet).toBe(winner.wallet);
    expect(await conn.db.select().from(alphaAccess).where(eq(alphaAccess.wallet, thief.wallet))).toHaveLength(0);
    expect((await gatedApp.inject({ url: '/me', cookies: { [SESSION_COOKIE]: thiefCookie } })).statusCode).toBe(403);
  });

  it('a concurrent race on one code admits exactly one wallet', async () => {
    const { code } = await mintCode();
    const [kpA, kpB] = [await makeKeypair(), await makeKeypair()];
    const [cookieA, cookieB] = [await login(gatedApp, kpA), await login(gatedApp, kpB)];
    const [resA, resB] = await Promise.all([
      gatedApp.inject({ method: 'POST', url: '/alpha/redeem', cookies: { [SESSION_COOKIE]: cookieA }, payload: { code } }),
      gatedApp.inject({ method: 'POST', url: '/alpha/redeem', cookies: { [SESSION_COOKIE]: cookieB }, payload: { code } }),
    ]);
    const codes = [resA.statusCode, resB.statusCode].sort();
    expect(codes[0]).toBe(200);
    expect(codes[1]).toBe(400); // the row lock serialises; the loser sees it spent
    const admitted = await conn.db.select().from(alphaAccess)
      .where(eq(alphaAccess.wallet, resA.statusCode === 200 ? kpA.wallet : kpB.wallet));
    expect(admitted).toHaveLength(1);
  });

  it('GATE UNION mutation checks: env-only passes with no table row; table-only passes; a deleted row revokes', async () => {
    // ENV half alone: envKp has NO alpha_access row, yet passes.
    const envCookie = await login(gatedApp, envKp);
    expect((await gatedApp.inject({ url: '/me', cookies: { [SESSION_COOKIE]: envCookie } })).statusCode).toBe(200);
    expect(await conn.db.select().from(alphaAccess).where(eq(alphaAccess.wallet, envKp.wallet))).toHaveLength(0);

    // TABLE half alone (a 'manual' ops grant, no application at all).
    const kp = await makeKeypair();
    const cookie = await login(gatedApp, kp);
    expect((await gatedApp.inject({ url: '/me', cookies: { [SESSION_COOKIE]: cookie } })).statusCode).toBe(403);
    await conn.db.insert(alphaAccess).values({ wallet: kp.wallet, source: 'manual' });
    expect((await gatedApp.inject({ url: '/me', cookies: { [SESSION_COOKIE]: cookie } })).statusCode).toBe(200);

    // REVOCATION: deleting the row must evict on the very next request — the
    // union is read per-request, never latched into the session.
    await conn.db.delete(alphaAccess).where(eq(alphaAccess.wallet, kp.wallet));
    const revoked = await gatedApp.inject({ url: '/me', cookies: { [SESSION_COOKIE]: cookie } });
    expect(revoked.statusCode).toBe(403);
    expect(revoked.json().error.code).toBe('ALPHA_GATED');
  });

  it('an OPEN game (ALPHA_WALLETS unset) never consults the table', async () => {
    // The gate must stay a no-op when the env var is deleted at launch — a
    // wallet with no access row plays unimpeded on openApp.
    const kp = await makeKeypair();
    const cookie = await login(openApp, kp);
    expect((await openApp.inject({ url: '/me', cookies: { [SESSION_COOKIE]: cookie } })).statusCode).toBe(200);
  });
});

describe('security-review hardening (2026-08-05)', () => {
  it('REVOCATION STICKS: a kicked invite-sourced wallet cannot re-redeem its own code', async () => {
    // Finding 1 (MEDIUM). The documented revocation is deleting the
    // alpha_access row. The same-wallet re-redeem branch used to re-create it —
    // so a kicked tester restored their own access with the code still in
    // their inbox. Now: same-wallet re-redeem is idempotent ONLY while access
    // still exists; after revocation it is the uniform failure.
    const { code } = await mintCodeShared();
    const kp = await makeKeypair();
    const cookie = await login(gatedApp, kp);
    const first = await gatedApp.inject({
      method: 'POST', url: '/alpha/redeem', cookies: { [SESSION_COOKIE]: cookie }, payload: { code },
    });
    expect(first.statusCode).toBe(200);

    // The retry case revocation must NOT break: access intact → idempotent 200.
    const retry = await gatedApp.inject({
      method: 'POST', url: '/alpha/redeem', cookies: { [SESSION_COOKIE]: cookie }, payload: { code },
    });
    expect(retry.statusCode).toBe(200);

    // Admin revokes.
    await conn.db.delete(alphaAccess).where(eq(alphaAccess.wallet, kp.wallet));

    // The kicked wallet is gated again — and its old code must not help.
    const gatedAgain = await gatedApp.inject({ url: '/me', cookies: { [SESSION_COOKIE]: cookie } });
    expect(gatedAgain.statusCode).toBe(403);
    const reRedeem = await gatedApp.inject({
      method: 'POST', url: '/alpha/redeem', cookies: { [SESSION_COOKIE]: cookie }, payload: { code },
    });
    expect(reRedeem.statusCode).toBe(400); // the uniform failure — no oracle, no access
    const rows = await conn.db.select().from(alphaAccess).where(eq(alphaAccess.wallet, kp.wallet));
    expect(rows.length).toBe(0);
  });

  it('a SLOW email provider does not delay the apply response (timing-oracle fix)', async () => {
    // Finding 2 (MEDIUM). Awaiting the send made fresh submissions measurably
    // slower than duplicates. The send is now detached; the response must come
    // back long before a slow provider resolves.
    let release: () => void = () => {};
    const slowSent: string[] = [];
    const slowApp = await buildAlphaApp({
      emailSender: async (to) => {
        await new Promise<void>((r) => { release = r; });
        slowSent.push(to);
      },
    });
    try {
      const t0 = Date.now();
      const res = await slowApp.inject({
        method: 'POST', url: '/alpha/apply',
        payload: { email: uniqueEmail(), handle: 'slowpoke', answers: { q: 'a' } },
      });
      const elapsed = Date.now() - t0;
      expect(res.statusCode).toBe(200);
      expect(elapsed).toBeLessThan(1_000); // did not wait for the provider
      expect(slowSent.length).toBe(0);     // send still in flight when we responded
      release();                            // let the detached send finish cleanly
    } finally {
      release();
      await slowApp.close();
    }
  });

  it('sub-addressed variants of one inbox count as ONE application (bombing fix)', async () => {
    // Finding 3 (LOW): victim+1@gmail.com / v.i.ctim@gmail.com are the same
    // physical inbox; each used to insert a fresh row and send a fresh email.
    const base = `victim${Date.now().toString(36)}`;
    const first = await openApp.inject({
      method: 'POST', url: '/alpha/apply', payload: { email: `${base}@gmail.com`, handle: 'v' },
    });
    expect(first.statusCode).toBe(200);
    const before = sent.length;
    for (const variant of [`${base}+airdrop@gmail.com`, `${base.slice(0,1)}.${base.slice(1)}@gmail.com`]) {
      const res = await openApp.inject({
        method: 'POST', url: '/alpha/apply', payload: { email: variant, handle: 'v' },
      });
      expect(res.statusCode).toBe(200); // outwardly identical
    }
    const rows = await conn.db.select().from(alphaApplications);
    expect(rows.filter((r) => r.email.includes(base)).length).toBe(1);
    expect(sent.length).toBe(before); // no extra emails to that inbox
  });

  it('rejects an answers record with too many keys', async () => {
    // Finding 4 (LOW): each key/value was bounded, the record was not.
    const answers = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`k${i}`, 'v']));
    const res = await openApp.inject({
      method: 'POST', url: '/alpha/apply', payload: { email: uniqueEmail(), answers },
    });
    expect(res.statusCode).toBe(400);
  });

  it('scoped CORS: the landing origin reaches ONLY /alpha/apply, uncredentialed', async () => {
    // Finding 5 (LOW): the landing site must never enter the credentialed
    // allowlist. /alpha/apply reflects the landing origin with credentials
    // OFF; a game route does not reflect it at all.
    const LANDING = 'https://pixelkingdomwars.com';
    const pre = await openApp.inject({
      method: 'OPTIONS', url: '/alpha/apply',
      headers: { origin: LANDING, 'access-control-request-method': 'POST' },
    });
    expect(pre.headers['access-control-allow-origin']).toBe(LANDING);
    expect(pre.headers['access-control-allow-credentials']).toBeUndefined();

    const game = await openApp.inject({ url: '/version', headers: { origin: LANDING } });
    expect(game.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('config validation (ADMIN_WALLETS / EMAIL_FROM — the ALPHA_WALLETS posture)', () => {
  const base = {
    DATABASE_URL: 'postgres://x/y',
    JWT_SECRET: 'test-secret-test-secret-test-secret!',
    WEB_ORIGIN: 'https://play.example.com',
    NODE_ENV: 'test' as const,
  };
  const W = randomWallet();

  it('unset/blank ADMIN_WALLETS means NO admin surface, not a crash', () => {
    expect(loadConfig(base).ADMIN_WALLETS).toBeUndefined();
    expect(loadConfig({ ...base, ADMIN_WALLETS: '  ' }).ADMIN_WALLETS).toBeUndefined();
  });

  it('parses, trims and dedupes; malformed entries FAIL BOOT by name', () => {
    expect(loadConfig({ ...base, ADMIN_WALLETS: ` ${W} , ${W} ` }).ADMIN_WALLETS).toEqual([W]);
    for (const bad of [W.slice(0, 10), `${W},nope`, '0xdeadbeef']) {
      expect(() => loadConfig({ ...base, ADMIN_WALLETS: bad }), bad).toThrow(/ADMIN_WALLETS/);
    }
  });

  it('EMAIL_FROM accepts an address or display-name form, refuses non-addresses', () => {
    expect(loadConfig({ ...base, EMAIL_FROM: 'invites@example.com' }).EMAIL_FROM).toBe('invites@example.com');
    expect(loadConfig({ ...base, EMAIL_FROM: 'Pixel Kingdom Wars <invites@example.com>' }).EMAIL_FROM)
      .toBe('Pixel Kingdom Wars <invites@example.com>');
    expect(() => loadConfig({ ...base, EMAIL_FROM: 'not-an-address' })).toThrow(/EMAIL_FROM/);
  });
});

describe('env placeholders (VAR= is present-with-empty, not unset)', () => {
  it('treats empty optional URLs as unset instead of crash-looping the boot', () => {
    // .env.prod.example ships `SOLANA_MAINNET_RPC_URL_2=` and `PLAY_URL=` as
    // placeholders; copying it verbatim used to feed new URL('') to a zod
    // refine and crash-loop the api on a fresh box (production host first boot,
    // 2026-08-06). '' must behave exactly like the var not existing.
    const parsed = loadConfig({
      ...process.env,
      DATABASE_URL: 'postgres://x:y@localhost:5433/z',
      JWT_SECRET: 'a'.repeat(32),
      WEB_ORIGIN: 'https://play.pixelkingdomwars.com',
      SOLANA_MAINNET_RPC_URL: '',
      SOLANA_MAINNET_RPC_URL_2: '',
      PLAY_URL: '',
    } as NodeJS.ProcessEnv);
    expect(parsed.SOLANA_MAINNET_RPC_URL).toBeUndefined();
    expect(parsed.SOLANA_MAINNET_RPC_URL_2).toBeUndefined();
    expect(parsed.PLAY_URL).toBeUndefined();
  });
});

/**
 * WHY: holding a Seeker IS the invite (owner 2026-08-08). These are the
 * gate-union mutation checks for the new admission source: a proven SGT admits
 * with no code, a non-holder stays 403, the pre-gate seeker routes really are
 * reachable (the chicken-and-egg fix), and an ops revocation STICKS — a linked
 * wallet must not be able to re-grant itself by waving the same token again.
 */
describe('seeker admission (owner 2026-08-08)', () => {
  let seekerApp: FastifyInstance;
  /** wallet → SGT mint it holds on the fake mainnet. */
  const sgtHoldings = new Map<string, string>();

  /** Minimal fake mainnet: holdings + a predicate-passing account per mint.
   *  Discovery methods answer empty — .skr naming is seeker.test.ts territory. */
  const fakeMainnet = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    let result: unknown = { value: null };
    if (body.method === 'getTokenAccountsByOwner') {
      const mint = sgtHoldings.get(String(body.params[0]));
      result = {
        value: mint
          ? [{ account: { data: { parsed: { info: { mint, tokenAmount: { amount: '1', decimals: 0 } } } } } }]
          : [],
      };
    } else if (body.method === 'getMultipleAccounts') {
      const known = new Set(sgtHoldings.values());
      result = {
        value: (body.params[0] as string[]).map((m) => (known.has(m) ? {
          owner: SEEKER.sgt.tokenProgram,
          data: {
            parsed: {
              type: 'mint',
              info: {
                decimals: 0, supply: '1', mintAuthority: SEEKER.sgt.mintAuthority,
                extensions: [
                  { extension: 'metadataPointer', state: { authority: SEEKER.sgt.metadataAuthority, metadataAddress: SEEKER.sgt.metadataAddress } },
                  { extension: 'tokenGroupMember', state: { group: SEEKER.sgt.group, memberNumber: 7 } },
                ],
              },
            },
          },
        } : null)),
      };
    } else if (body.method === 'getProgramAccounts') {
      result = [];
    }
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result }) } as Response;
  }) as unknown as typeof fetch;

  beforeAll(async () => {
    seekerApp = await buildApp(
      {
        ...TEST_CONFIG,
        ALPHA_WALLETS: [envKp.wallet],
        SOLANA_MAINNET_RPC_URL: 'https://fake-mainnet.test',
      },
      conn.db,
      { emailSender: fakeSender, seekerFetch: fakeMainnet },
    );
    await seekerApp.ready();
  });

  afterAll(async () => {
    await seekerApp.close();
  });

  it('the gate probe admits a newly signed-in Seeker — no invite code', async () => {
    resetAutoDetectBudget();
    const kp = await makeKeypair();
    sgtHoldings.set(kp.wallet, `ALPHAMINT-in-${Date.now()}`);
    const cookie = await login(seekerApp, kp);

    // Session creation has no third-party RPC on its critical path. The first
    // protected read sends the UI to CLOSED ALPHA, whose mount-time probe owns
    // automatic Seeker detection.
    expect((await seekerApp.inject({
      url: '/me', cookies: { [SESSION_COOKIE]: cookie },
    })).statusCode).toBe(403);
    const probe = await seekerApp.inject({
      method: 'POST', url: '/alpha/seeker', cookies: { [SESSION_COOKIE]: cookie },
    });
    expect(probe.statusCode).toBe(200);
    expect((probe.json() as { admitted: boolean }).admitted).toBe(true);

    const me = await seekerApp.inject({ url: '/me', cookies: { [SESSION_COOKIE]: cookie } });
    expect(me.statusCode).toBe(200);
    const [row] = await conn.db.select().from(alphaAccess).where(eq(alphaAccess.wallet, kp.wallet));
    expect(row?.source).toBe('seeker');
  });

  it('a non-holder is still 403 ALPHA_GATED — the bypass admits Seekers, not everyone', async () => {
    resetAutoDetectBudget();
    const kp = await makeKeypair();
    const cookie = await login(seekerApp, kp);
    const me = await seekerApp.inject({ url: '/me', cookies: { [SESSION_COOKIE]: cookie } });
    expect(me.statusCode).toBe(403);
    expect((me.json() as { error: { code?: string } }).error.code).toBe('ALPHA_GATED');
  });

  it('POST /alpha/seeker admits a Seeker whose cookie outlived their sign-in', async () => {
    // The 7-day-JWT case: signed in as a nobody, became (or already was) a
    // Seeker, never re-signed. The gate screen's probe is the way in.
    resetAutoDetectBudget();
    const kp = await makeKeypair();
    const cookie = await login(seekerApp, kp);
    sgtHoldings.set(kp.wallet, `ALPHAMINT-late-${Date.now()}`);

    const probe = await seekerApp.inject({
      method: 'POST', url: '/alpha/seeker', cookies: { [SESSION_COOKIE]: cookie },
    });
    expect(probe.statusCode).toBe(200);
    const body = probe.json() as { admitted: boolean; wallet: string; seeker: { linked: boolean } };
    expect(body.admitted).toBe(true);
    expect(body.seeker.linked).toBe(true);
    expect(body.wallet).toBe(kp.wallet);

    const me = await seekerApp.inject({ url: '/me', cookies: { [SESSION_COOKIE]: cookie } });
    expect(me.statusCode).toBe(200);
  });

  it('POST /alpha/seeker for a non-holder answers admitted:false and grants nothing', async () => {
    resetAutoDetectBudget();
    const kp = await makeKeypair();
    const cookie = await login(seekerApp, kp);
    const probe = await seekerApp.inject({
      method: 'POST', url: '/alpha/seeker', cookies: { [SESSION_COOKIE]: cookie },
    });
    expect(probe.statusCode).toBe(200);
    expect((probe.json() as { admitted: boolean }).admitted).toBe(false);
    const me = await seekerApp.inject({ url: '/me', cookies: { [SESSION_COOKIE]: cookie } });
    expect(me.statusCode).toBe(403);
  });

  it('a caller-asserted mobile marker cannot grant closed-alpha access', async () => {
    resetAutoDetectBudget();
    const kp = await makeKeypair();
    const cookie = await login(seekerApp, kp);
    const probe = await seekerApp.inject({
      method: 'POST', url: '/alpha/seeker', cookies: { [SESSION_COOKIE]: cookie },
      // Kept as a compatibility assertion: shipped shells still send this
      // field, but the server must treat it as untrusted transport metadata.
      payload: { mobileClient: true },
    });
    expect(probe.statusCode).toBe(200);
    expect((probe.json() as { admitted: boolean }).admitted).toBe(false);
    expect((await seekerApp.inject({
      url: '/me', cookies: { [SESSION_COOKIE]: cookie },
    })).statusCode).toBe(403);
    const rows = await conn.db.select().from(alphaAccess).where(eq(alphaAccess.wallet, kp.wallet));
    expect(rows).toHaveLength(0);
  });

  it('a split-wallet Seeker can LINK from behind the gate and enter — the chicken-and-egg fix', async () => {
    // The session wallet holds nothing (a social player's embedded wallet can
    // never hold an SGT); the Seeker wallet proves itself over the PRE-GATE
    // link routes. Before 2026-08-08 these sat behind the alpha gate, so the
    // wallet that most needed to verify was 403'd before it could.
    resetAutoDetectBudget();
    const gamer = await makeKeypair();
    const seeker = await makeKeypair();
    sgtHoldings.set(seeker.wallet, `ALPHAMINT-split-${Date.now()}`);
    const cookie = await login(seekerApp, gamer);
    expect((await seekerApp.inject({ url: '/me', cookies: { [SESSION_COOKIE]: cookie } })).statusCode).toBe(403);

    const ch = await seekerApp.inject({
      method: 'POST', url: '/seeker/link/challenge',
      cookies: { [SESSION_COOKIE]: cookie }, payload: { seekerWallet: seeker.wallet },
    });
    expect(ch.statusCode).toBe(200); // pre-gate: NOT 403
    const signature = bs58.encode(await signAsync(
      new TextEncoder().encode((ch.json() as { message: string }).message), seeker.secretKey,
    ));
    const verify = await seekerApp.inject({
      method: 'POST', url: '/seeker/link/verify',
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { seekerWallet: seeker.wallet, signature },
    });
    expect(verify.statusCode).toBe(200);

    const me = await seekerApp.inject({ url: '/me', cookies: { [SESSION_COOKIE]: cookie } });
    expect(me.statusCode).toBe(200);
    const [row] = await conn.db.select().from(alphaAccess).where(eq(alphaAccess.wallet, gamer.wallet));
    expect(row?.source).toBe('seeker');
  });

  it('an ops revocation STICKS — a linked Seeker cannot re-admit itself', async () => {
    // The runbook (DELETE the alpha_access row) must keep working for seeker
    // grants: the live link short-circuits every detection path, so nothing
    // re-inserts the row behind ops' back.
    resetAutoDetectBudget();
    const kp = await makeKeypair();
    sgtHoldings.set(kp.wallet, `ALPHAMINT-revoke-${Date.now()}`);
    const cookie = await login(seekerApp, kp);
    const firstProbe = await seekerApp.inject({
      method: 'POST', url: '/alpha/seeker', cookies: { [SESSION_COOKIE]: cookie },
    });
    expect((firstProbe.json() as { admitted: boolean }).admitted).toBe(true);
    expect((await seekerApp.inject({ url: '/me', cookies: { [SESSION_COOKIE]: cookie } })).statusCode).toBe(200);

    await conn.db.delete(alphaAccess).where(eq(alphaAccess.wallet, kp.wallet));

    expect((await seekerApp.inject({ url: '/me', cookies: { [SESSION_COOKIE]: cookie } })).statusCode).toBe(403);
    // Fresh sign-in creates only a session. The gate probe sees the live link
    // and still must not recreate an ops-revoked alpha grant.
    const cookie2 = await login(seekerApp, kp);
    expect((await seekerApp.inject({ url: '/me', cookies: { [SESSION_COOKIE]: cookie2 } })).statusCode).toBe(403);
    // The gate-screen probe cannot re-grant either.
    const probe = await seekerApp.inject({
      method: 'POST', url: '/alpha/seeker', cookies: { [SESSION_COOKIE]: cookie2 },
    });
    expect((probe.json() as { admitted: boolean }).admitted).toBe(false);
  });
});
