/**
 * Closed-alpha access machinery (owner decisions 2026-08-05):
 *
 * - PUBLIC application form (email only — no wallet, deliberately: Privy
 *   social/email players have no wallet before first login, and wallet-upfront
 *   hands airdrop farmers the field they want),
 * - admin review: approve mints a one-time 128-bit base32 invite code and
 *   emails it; reject stores a note and emails nothing,
 * - redemption: the SESSION wallet (external or Privy-embedded — both exist by
 *   session time) lands in alpha_access, the DB half of assertAlphaAccess's
 *   union (auth/session.ts).
 *
 * Nothing here is a game number (no prices, no stats), so nothing belongs in
 * @shardkeep/shared constants.ts.
 */
import { randomBytes } from 'node:crypto';
import { and, asc, count, desc, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import type { EmailSender } from '../auth/twofa';
import { accessGrantedEmail, applicationReceivedEmail } from './alphaEmails';
import type { Db, DbOrTx } from '../db/client';
import {
  alphaAccess, alphaApplications, alphaInviteBatches, alphaInviteCodes,
} from '../db/schema';
import { HttpError } from '../lib/errors';

// Same cheap shape check the 2FA email enroll uses (auth/twofa.ts) — the real
// proof of deliverability is the invite email itself arriving.
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// RFC 4648 base32 alphabet — no 0/1/8/9, so a code survives being read aloud.
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** 128 bits of crypto randomness as 26 base32 chars. 128-bit: unguessable by
 *  construction, so redemption needs no attempt-counter of its own (the route
 *  rate limit is belt-and-braces). */
export function generateInviteCode(): string {
  const bytes = randomBytes(16);
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** Dash-grouped for the email; redemption strips the dashes back out. */
export function formatInviteCode(code: string): string {
  return code.match(/.{1,5}/g)?.join('-') ?? code;
}

/** Uppercase and drop every non-base32 char (dashes, spaces, smart paste). */
function normalizeInviteCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z2-7]/g, '');
}

// ---------------------------------------------------------------------------
// Turnstile (server-side bot check for the public form)
// ---------------------------------------------------------------------------

const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/**
 * Server-side Cloudflare Turnstile verification. Secret UNSET ⇒ accept without
 * verification (dev mode — server.ts warns loudly at boot so a production
 * deploy can't be silently unprotected without a trace in the logs). Secret SET
 * ⇒ a missing or invalid token is a 4xx, and an unreachable verifier is a 502
 * rather than an open door: failing open would make the bot check decorative
 * exactly when someone is hammering the endpoint.
 */
export async function verifyTurnstile(
  secret: string | undefined,
  token: string | undefined,
  remoteIp: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (!secret) return;
  if (!token) throw new HttpError(400, 'bot verification required — reload the page and try again');
  let outcome: { success?: boolean } | null;
  try {
    const res = await fetchImpl(TURNSTILE_VERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        secret,
        response: token,
        ...(remoteIp ? { remoteip: remoteIp } : {}),
      }).toString(),
      // Same rationale as resend.ts: a hung verifier must not pin the request
      // handler open (security review 2026-08-05 finding 6).
      signal: AbortSignal.timeout(5_000),
    });
    outcome = (await res.json()) as { success?: boolean };
  } catch {
    throw new HttpError(502, 'bot verification is temporarily unavailable — try again in a minute');
  }
  if (!outcome?.success) {
    throw new HttpError(400, 'bot verification failed — reload the page and try again');
  }
}

// ---------------------------------------------------------------------------
// Application (public)
// ---------------------------------------------------------------------------

export interface ApplicationInput {
  email: string;
  handle?: string | undefined;
  socials?: string | undefined;
  answers?: Record<string, string> | undefined;
}

/**
 * Record an application and send the "received" email. Duplicate email ⇒ a
 * no-op that the ROUTE answers identically to a fresh submit (no second row,
 * no second email, no enumeration oracle). The email send is best-effort: the
 * application row is the record, so a provider outage must not 5xx the form —
 * it is logged and the admin still sees the application.
 */
/**
 * Sub-address-blind form of an email, for DEDUPE ONLY (never for delivery —
 * stripping a +suffix is safe almost everywhere but not guaranteed, so we
 * always SEND to what the applicant typed). victim+1@gmail.com, victim+2@…
 * and dot-variants all collapse to one inbox: without this, each counted as a
 * fresh application and each mailed the same physical mailbox — a slow but
 * real bombing vector inside the rate limit (security review 2026-08-05
 * finding 3). Dots are inbox-equivalent only on the gmail family, so they are
 * stripped only there.
 */
export function normalizeEmailForDedupe(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 0) return email;
  let local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const plus = local.indexOf('+');
  if (plus >= 0) local = local.slice(0, plus);
  if (domain === 'gmail.com' || domain === 'googlemail.com') local = local.replaceAll('.', '');
  return `${local}@${domain}`;
}

export async function submitApplication(db: Db, input: ApplicationInput, send: EmailSender): Promise<void> {
  const email = input.email.trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) throw new HttpError(400, 'invalid email address');
  // Sub-address dedupe pass. A full-table scan is deliberate for the alpha:
  // the table is thousands of rows at most, the route is 5/min/IP, and an
  // expression index would need a migration for what is a LOW-severity
  // hardening. Revisit if applications ever reach 6 digits.
  const norm = normalizeEmailForDedupe(email);
  const existing = await db.select({ email: alphaApplications.email }).from(alphaApplications);
  if (existing.some((r) => normalizeEmailForDedupe(r.email) === norm)) return; // duplicate inbox — outwardly identical
  const inserted = await db.insert(alphaApplications).values({
    email,
    handle: input.handle ?? null,
    socials: input.socials ?? null,
    answers: input.answers ?? null,
  }).onConflictDoNothing({ target: alphaApplications.email })
    .returning({ id: alphaApplications.id });
  if (inserted.length === 0) return; // duplicate — outwardly identical to success

  // FIRE-AND-FORGET, deliberately (security review 2026-08-05 finding 2): the
  // response bytes for fresh vs duplicate are identical, but AWAITING the
  // Resend round-trip here made fresh submissions ~100-500ms slower than
  // duplicates — a stopwatch could enumerate who has applied. The send was
  // already declared best-effort ("the application row is the record"), so
  // detaching it deletes the timing signal without changing semantics.
  void (async () => {
    const mail = applicationReceivedEmail();
    await send(email, mail.subject, mail.text, mail.html);
  })().catch((e: unknown) => {
    console.error('[alpha] application-received email failed (application recorded)', e);
  });
}

// ---------------------------------------------------------------------------
// Admin review
// ---------------------------------------------------------------------------

type AppStatus = 'pending' | 'approved' | 'rejected';

/** Newest-first queue for the review panel, optionally filtered by status.
 *  Hard-capped — the panel pages by eye, not by cursor, at alpha scale. */
export async function listApplications(db: Db, status?: AppStatus) {
  const base = db.select().from(alphaApplications);
  const rows = await (status ? base.where(eq(alphaApplications.status, status)) : base)
    .orderBy(desc(alphaApplications.createdAt))
    .limit(500);
  return { applications: rows };
}

/**
 * Approve: mint the invite code, stamp the row, email the code. Approving an
 * already-approved application is a 409, NOT a silent re-mint — regenerating
 * would strand the code already emailed, and auto-resending would make a
 * double-clicked button spam the applicant (the list endpoint shows the code
 * for a manual resend). A REJECTED application may be approved: the admin
 * changed their mind.
 *
 * The email failing does NOT unwind the approval: the code is stored and shown
 * to the admin (emailSent: false), who can deliver it by hand — the same
 * "record first, notify best-effort" posture as submitApplication.
 */
export async function approveApplication(db: Db, id: string, send: EmailSender, playUrl: string): Promise<{
  id: string; email: string; inviteCode: string; emailSent: boolean;
}> {
  const code = generateInviteCode();
  const [updated] = await db.update(alphaApplications)
    .set({ status: 'approved', inviteCode: code, invitedAt: new Date() })
    // Guard in SQL, not read-then-write: two admins approving the same row
    // concurrently must mint exactly one code — the loser matches zero rows.
    .where(and(eq(alphaApplications.id, id), ne(alphaApplications.status, 'approved')))
    .returning({ email: alphaApplications.email });
  if (!updated) {
    const [existing] = await db.select({ id: alphaApplications.id }).from(alphaApplications)
      .where(eq(alphaApplications.id, id));
    if (!existing) throw new HttpError(404, 'application not found');
    throw new HttpError(409, 'already approved — its invite code is in the applications list');
  }
  const email = updated.email;

  let emailSent = true;
  try {
    const mail = accessGrantedEmail(formatInviteCode(code), playUrl);
    await send(email, mail.subject, mail.text, mail.html);
  } catch (e) {
    emailSent = false;
    console.error('[alpha] invite email failed — deliver the code manually', e);
  }
  return { id, email, inviteCode: code, emailSent };
}

export interface AdminInviteBatchDto {
  batchId: string;
  count: number;
  createdAt: Date;
  createdByWallet: string;
  codes: Array<{
    id: string;
    code: string;
    ordinal: number;
    redeemedWallet: string | null;
    redeemedAt: Date | null;
  }>;
}

async function loadAdminInviteBatch(
  db: DbOrTx,
  batch: typeof alphaInviteBatches.$inferSelect,
): Promise<AdminInviteBatchDto> {
  const codes = await db.select({
    id: alphaInviteCodes.id,
    code: alphaInviteCodes.code,
    ordinal: alphaInviteCodes.ordinal,
    redeemedWallet: alphaInviteCodes.redeemedWallet,
    redeemedAt: alphaInviteCodes.redeemedAt,
  }).from(alphaInviteCodes)
    .where(eq(alphaInviteCodes.batchId, batch.id))
    .orderBy(asc(alphaInviteCodes.ordinal));
  // A batch and its codes are inserted in one transaction. Returning a partial
  // set would turn database corruption into leaked/stranded invitations, so it
  // is an invariant failure, never a best-effort response.
  if (codes.length !== batch.requestedCount) {
    throw new Error(`invite batch ${batch.id} is incomplete`);
  }
  return {
    batchId: batch.id,
    count: batch.requestedCount,
    createdAt: batch.createdAt,
    createdByWallet: batch.createdByWallet,
    codes,
  };
}

/**
 * Mint one atomic, idempotent owner batch (owner 2026-08-24: 1..100 codes).
 * The same admin wallet + UUID always returns the exact same ordered batch;
 * replaying that UUID with a different count is refused instead of silently
 * returning a surprising number of secrets.
 */
export async function generateAdminInviteBatch(
  db: Db,
  adminWallet: string,
  countToGenerate: number,
  idempotencyKey: string,
): Promise<AdminInviteBatchDto> {
  if (!Number.isInteger(countToGenerate) || countToGenerate < 1 || countToGenerate > 100) {
    throw new HttpError(400, 'invite count must be a whole number from 1 to 100');
  }
  return db.transaction(async (tx) => {
    let [batch] = await tx.select().from(alphaInviteBatches).where(and(
      eq(alphaInviteBatches.createdByWallet, adminWallet),
      eq(alphaInviteBatches.idempotencyKey, idempotencyKey),
    )).for('update');
    if (batch) {
      if (batch.requestedCount !== countToGenerate) {
        throw new HttpError(409, 'idempotency key was already used with a different invite count');
      }
      return loadAdminInviteBatch(tx, batch);
    }

    [batch] = await tx.insert(alphaInviteBatches).values({
      idempotencyKey,
      createdByWallet: adminWallet,
      requestedCount: countToGenerate,
    }).onConflictDoNothing({
      target: [alphaInviteBatches.createdByWallet, alphaInviteBatches.idempotencyKey],
    }).returning();

    // A concurrent request with the same key waits on the unique index, then
    // reaches this branch after the winner commits. Read its complete batch.
    if (!batch) {
      [batch] = await tx.select().from(alphaInviteBatches).where(and(
        eq(alphaInviteBatches.createdByWallet, adminWallet),
        eq(alphaInviteBatches.idempotencyKey, idempotencyKey),
      )).for('update');
      if (!batch) throw new Error('invite idempotency conflict resolved without a batch');
      if (batch.requestedCount !== countToGenerate) {
        throw new HttpError(409, 'idempotency key was already used with a different invite count');
      }
      return loadAdminInviteBatch(tx, batch);
    }

    // Five retries are only collision hardening. At 128 bits, reaching even a
    // second pass indicates a broken RNG or corrupted table and must fail loud.
    for (let attempt = 0; attempt < 5; attempt++) {
      const unique = new Set<string>();
      while (unique.size < countToGenerate) unique.add(generateInviteCode());
      const candidates = [...unique];
      // Application and standalone invites share one redemption namespace even
      // though their audit rows live in separate tables.
      const applicationConflicts = await tx.select({ code: alphaApplications.inviteCode })
        .from(alphaApplications)
        .where(inArray(alphaApplications.inviteCode, candidates));
      if (applicationConflicts.length > 0) continue;

      const inserted = await tx.insert(alphaInviteCodes).values(candidates.map((code, ordinal) => ({
        batchId: batch!.id,
        code,
        ordinal,
      }))).onConflictDoNothing({ target: alphaInviteCodes.code })
        .returning({ id: alphaInviteCodes.id });
      if (inserted.length === countToGenerate) return loadAdminInviteBatch(tx, batch);

      // A standalone-code collision may have inserted only part of this batch.
      // Remove only those new rows before retrying; the outer transaction still
      // guarantees callers can never observe a partial batch.
      await tx.delete(alphaInviteCodes).where(eq(alphaInviteCodes.batchId, batch.id));
    }
    throw new Error('could not mint a collision-free invite batch');
  });
}

export interface AdminInviteHistoryDto {
  invites: Array<{
    id: string;
    source: 'generated' | 'application';
    code: string;
    createdAt: Date;
    batchId: string | null;
    createdByWallet: string | null;
    email: string | null;
    redeemedWallet: string | null;
    redeemedAt: Date | null;
  }>;
  nextOffset: number | null;
}

/** Admin-only merged history. Existing application approvals count as “old
 * generated codes”; standalone batches add durable creator/batch metadata. */
export async function listInviteCodes(
  db: Db,
  options: { offset: number; limit: number },
): Promise<AdminInviteHistoryDto> {
  const fetchCount = options.offset + options.limit + 1;
  const generated = await db.select({
    id: alphaInviteCodes.id,
    code: alphaInviteCodes.code,
    createdAt: alphaInviteCodes.createdAt,
    batchId: alphaInviteCodes.batchId,
    createdByWallet: alphaInviteBatches.createdByWallet,
    redeemedWallet: alphaInviteCodes.redeemedWallet,
    redeemedAt: alphaInviteCodes.redeemedAt,
  }).from(alphaInviteCodes)
    .innerJoin(alphaInviteBatches, eq(alphaInviteCodes.batchId, alphaInviteBatches.id))
    .orderBy(desc(alphaInviteCodes.createdAt), desc(alphaInviteCodes.id))
    .limit(fetchCount);
  const applications = await db.select({
    id: alphaApplications.id,
    code: alphaApplications.inviteCode,
    invitedAt: alphaApplications.invitedAt,
    createdAt: alphaApplications.createdAt,
    email: alphaApplications.email,
    redeemedWallet: alphaApplications.redeemedWallet,
    redeemedAt: alphaApplications.redeemedAt,
  }).from(alphaApplications)
    .where(and(eq(alphaApplications.status, 'approved'), isNotNull(alphaApplications.inviteCode)))
    .orderBy(
      desc(sql`coalesce(${alphaApplications.invitedAt}, ${alphaApplications.createdAt})`),
      desc(alphaApplications.id),
    )
    .limit(fetchCount);

  const merged: AdminInviteHistoryDto['invites'] = [
    ...generated.map((row) => ({
      ...row,
      source: 'generated' as const,
      email: null,
    })),
    ...applications.flatMap((row) => row.code === null ? [] : [{
      id: row.id,
      source: 'application' as const,
      code: row.code,
      createdAt: row.invitedAt ?? row.createdAt,
      batchId: null,
      createdByWallet: null,
      email: row.email,
      redeemedWallet: row.redeemedWallet,
      redeemedAt: row.redeemedAt,
    }]),
  ].sort((a, b) => {
    const byTime = b.createdAt.getTime() - a.createdAt.getTime();
    return byTime !== 0 ? byTime : b.id.localeCompare(a.id);
  });
  const page = merged.slice(options.offset, options.offset + options.limit);
  return {
    invites: page,
    nextOffset: merged.length > options.offset + options.limit
      ? options.offset + options.limit
      : null,
  };
}

/** Reject with an optional reviewer note. NO email by default (owner-locked):
 *  a rejection mail invites argument and the queue is re-reviewable anyway.
 *  PENDING only — "rejecting" an approved application would leave its emailed
 *  code either live (a lie) or dead (silent revocation); revoking granted
 *  access is a deliberate manual act (delete the alpha_access row), not a
 *  side effect of a review button. */
export async function rejectApplication(db: Db, id: string, note?: string): Promise<{ id: string; status: 'rejected' }> {
  const [updated] = await db.update(alphaApplications)
    .set({ status: 'rejected', ...(note !== undefined ? { reviewerNote: note } : {}) })
    .where(and(eq(alphaApplications.id, id), eq(alphaApplications.status, 'pending')))
    .returning({ status: alphaApplications.status });
  if (!updated) {
    const [existing] = await db.select({ id: alphaApplications.id }).from(alphaApplications)
      .where(eq(alphaApplications.id, id));
    if (!existing) throw new HttpError(404, 'application not found');
    throw new HttpError(409, 'only a pending application can be rejected');
  }
  return { id, status: 'rejected' };
}

/** Counts for the panel header. `access` includes manual/env rows, so it can
 *  legitimately exceed `redeemed`. */
export async function alphaStats(db: Db) {
  const byStatus = await db.select({ status: alphaApplications.status, n: count() })
    .from(alphaApplications).groupBy(alphaApplications.status);
  const [redeemed] = await db.select({ n: count() }).from(alphaApplications)
    .where(isNotNull(alphaApplications.redeemedWallet));
  const [generated] = await db.select({ n: count() }).from(alphaInviteCodes);
  const [generatedRedeemed] = await db.select({ n: count() }).from(alphaInviteCodes)
    .where(isNotNull(alphaInviteCodes.redeemedWallet));
  const [access] = await db.select({ n: count() }).from(alphaAccess);
  const get = (s: AppStatus): number => byStatus.find((r) => r.status === s)?.n ?? 0;
  return {
    pending: get('pending'),
    approved: get('approved'),
    rejected: get('rejected'),
    redeemed: (redeemed?.n ?? 0) + (generatedRedeemed?.n ?? 0),
    generated: generated?.n ?? 0,
    access: access?.n ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Redemption (authed, pre-gate)
// ---------------------------------------------------------------------------

/**
 * Redeem an invite code for the session wallet. SINGLE-USE: the row lock (FOR
 * UPDATE) serialises concurrent redeems, the first wallet stamps
 * redeemed_wallet, and every later wallet gets the SAME 4xx a nonexistent code
 * gets — a used code and a wrong code are deliberately indistinguishable, so
 * the endpoint is not an oracle for which codes exist. The SAME wallet
 * re-redeeming its own code succeeds idempotently (a retried request must not
 * strand a player whose first response was lost).
 *
 * "Constant-time-ish": both the hit and the miss are one indexed point lookup
 * on the unique invite_code, and at 128 bits of entropy the residual timing
 * signal has nothing to find.
 */
export async function redeemInviteCode(db: Db, wallet: string, rawCode: string): Promise<void> {
  const code = normalizeInviteCode(rawCode);
  const uniformFailure = (): HttpError => new HttpError(400, 'invalid or already-used invite code');
  if (code.length === 0) throw uniformFailure();

  await db.transaction(async (tx) => {
    // Always perform both indexed lookups. Used/unknown/application/standalone
    // codes therefore share one outward failure posture; there is no cheap
    // timing branch that reveals which invite namespace contains a secret.
    const [application] = await tx.select().from(alphaApplications)
      .where(eq(alphaApplications.inviteCode, code)).for('update');
    const [generated] = await tx.select().from(alphaInviteCodes)
      .where(eq(alphaInviteCodes.code, code)).for('update');
    // Cross-table ambiguity should be impossible (generation checks old codes),
    // but fail closed if an operator ever corrupts that invariant.
    if ((!application && !generated) || (application && generated)) throw uniformFailure();
    if (application?.status !== undefined && application.status !== 'approved') throw uniformFailure();
    const redeemedWallet = application?.redeemedWallet ?? generated?.redeemedWallet ?? null;
    if (redeemedWallet !== null && redeemedWallet !== wallet) throw uniformFailure();

    if (redeemedWallet !== null) {
      // SAME-wallet re-redeem. Idempotent ONLY while the access row still
      // exists (a retried request after a flaky commit). If it does NOT exist,
      // an admin REVOKED this wallet — the documented revocation is deleting
      // the alpha_access row — and honouring the re-redeem would let a kicked
      // tester restore their own access with the code still in their inbox
      // (security review 2026-08-05 finding 1). Revocation must win.
      const [access] = await tx.select({ wallet: alphaAccess.wallet }).from(alphaAccess)
        .where(eq(alphaAccess.wallet, wallet));
      if (!access) throw uniformFailure();
      return; // access intact — nothing to do
    }

    const redeemedAt = new Date();
    if (application) {
      await tx.update(alphaApplications)
        .set({ redeemedWallet: wallet, redeemedAt })
        .where(eq(alphaApplications.id, application.id));
    } else {
      await tx.update(alphaInviteCodes)
        .set({ redeemedWallet: wallet, redeemedAt })
        .where(eq(alphaInviteCodes.id, generated!.id));
    }
    // onConflictDoNothing: the wallet may already be allowlisted (a manual
    // grant) — access is a set, not a counter.
    await tx.insert(alphaAccess)
      .values({ wallet, source: 'invite', applicationId: application?.id ?? null })
      .onConflictDoNothing();
  });
}
