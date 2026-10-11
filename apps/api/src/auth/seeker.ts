/**
 * Seeker identity: link a Solana Mobile Seeker wallet to a game account
 * (owner 2026-07-29 — "there is 0 indication that I am a seeker user").
 *
 * Two independent proofs are required, and NEITHER is a client claim:
 *   1. SIGNATURE — the Seeker wallet signs a purpose-scoped challenge, so we
 *      know the requester actually controls it. (Reuses the SIWS machinery in
 *      auth/routes.ts: same nonce table, same ed25519 verify, scoped by
 *      `auth_nonces.purpose` so a link signature can never mint a session.)
 *   2. HOLDING — the server reads mainnet-beta and applies the four-way SGT
 *      predicate (packages/chain/src/seeker.ts).
 *
 * The anti-sybil guarantee is `seeker_links_sgt_mint_uq`: one SGT = one physical
 * Seeker = at most one game account, forever. Unlinking sets `revoked_at` but
 * KEEPS the row, so unlink→relink cannot be used to seed farm accounts.
 *
 * A `.skr` domain grants NO badge — it's a commercial namespace with no sybil
 * resistance. It is offered as a username only AFTER the SGT check passes.
 */
import { randomBytes } from 'node:crypto';
import { verifyAsync } from '@noble/ed25519';
import {
  SeekerRpcError, SeekerSourceConflictError, discoverSkrOwnedBy, independentSourceCount,
  resolveSkrOwnedBy, verifySgtOwnership, type SgtHolding,
} from '@shardkeep/chain';
import { SEEKER } from '@shardkeep/shared';
import bs58 from 'bs58';
import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import type { Db } from '../db/client';
import { alphaAccess, authNonces, players, seekerLinks } from '../db/schema';
import { adoptSkrUsername } from '../game/username';
import { HttpError } from '../lib/errors';
import { buildSeekerLinkMessage } from './message';

export const LINK_NONCE_TTL_MS = SEEKER.linkChallengeTtlMin * 60 * 1000;

/** What the client renders as the badge. Server-derived only. */
export interface SeekerStatus {
  linked: boolean;
  seekerWallet: string | null;
  sgtMint: string | null;
  memberNumber: number | null;
  skrDomain: string | null;
  verifiedAt: string | null;
  /** True once the last on-chain re-check is older than SEEKER.recheckHours. */
  stale: boolean;
  /**
   * Independent mainnet sources behind the verdict: the number that AGREED when
   * this read performed an on-chain check, otherwise the number configured.
   * The badge is an anti-sybil claim resting on third-party RPC responses, so
   * the client is told how much corroboration it has instead of being handed a
   * bare "verified" (2026-07-29 review, finding (a)).
   */
  verificationSources: number;
  /** True when the verdict rests on ONE unauthenticated third-party read.
   *  Configure SOLANA_MAINNET_RPC_URL_2 (a different provider) to clear it. */
  unconfirmed: boolean;
}

const UNLINKED: SeekerStatus = {
  linked: false, seekerWallet: null, sgtMint: null, memberNumber: null,
  skrDomain: null, verifiedAt: null, stale: false,
  verificationSources: 0, unconfirmed: false,
};

/**
 * Is the last on-chain proof older than the staleness budget?
 *
 * `stale` is not cosmetic: a stale link is one we are NOT currently willing to
 * vouch for (the SGT carries a permanentDelegate and is freely sellable), so it
 * drives both the lazy re-verify and the fail-closed badge below.
 */
function isStale(row: typeof seekerLinks.$inferSelect, now: Date): boolean {
  return now.getTime() - row.lastCheckedAt.getTime() > SEEKER.recheckHours * 3_600_000;
}

function toStatus(row: typeof seekerLinks.$inferSelect, now: Date, sources: number): SeekerStatus {
  if (row.revokedAt) return UNLINKED;
  return {
    linked: true,
    seekerWallet: row.seekerWallet,
    sgtMint: row.sgtMint,
    memberNumber: row.memberNumber,
    skrDomain: row.skrDomain,
    verifiedAt: row.verifiedAt.toISOString(),
    stale: isStale(row, now),
    verificationSources: sources,
    unconfirmed: sources < 2,
  };
}

/**
 * The caller's Seeker status straight from the DB — no RPC, no staleness
 * handling. This is the INTERNAL guard ("does this account already hold a
 * link?"); routes that render a badge use `recheckSeeker`, which re-verifies a
 * stale verdict instead of trusting it forever.
 */
export async function getSeekerStatus(
  db: Db, wallet: string, now = new Date(), sources = 1,
): Promise<SeekerStatus> {
  const [row] = await db.select().from(seekerLinks).where(eq(seekerLinks.wallet, wallet));
  return row ? toStatus(row, now, sources) : UNLINKED;
}

/** Issue the link challenge for `seekerWallet`, bound to the caller's account. */
export async function createLinkChallenge(
  db: Db, domain: string, gameWallet: string, seekerWallet: string,
): Promise<{ nonce: string; message: string; expiresAt: string }> {
  const existing = await getSeekerStatus(db, gameWallet);
  if (existing.linked) throw new HttpError(409, 'this account already has a linked Seeker wallet');

  const nonce = randomBytes(24).toString('hex');
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + LINK_NONCE_TTL_MS);
  await db.insert(authNonces).values({
    wallet: seekerWallet, nonce, issuedAt, expiresAt, purpose: 'seeker_link', subject: gameWallet,
  });
  return {
    nonce,
    message: buildSeekerLinkMessage({ domain, seekerWallet, gameWallet, nonce, issuedAt }),
    expiresAt: expiresAt.toISOString(),
  };
}

/** Consume the seeker_link nonce for (seekerWallet → gameWallet) after verifying it. */
async function consumeLinkChallenge(
  db: Db, domain: string, gameWallet: string, seekerWallet: string, signature: string,
): Promise<void> {
  let sigBytes: Uint8Array;
  try {
    sigBytes = bs58.decode(signature);
  } catch {
    throw new HttpError(400, 'signature is not valid base58');
  }
  if (sigBytes.length !== 64) throw new HttpError(400, 'signature must be 64 bytes');

  const [challenge] = await db
    .select()
    .from(authNonces)
    .where(and(
      eq(authNonces.wallet, seekerWallet),
      // Scope is load-bearing, not hygiene: without it this SELECT and the
      // sign-in SELECT would fight over the same rows.
      eq(authNonces.purpose, 'seeker_link'),
      eq(authNonces.subject, gameWallet),
      isNull(authNonces.usedAt),
      gt(authNonces.expiresAt, new Date()),
    ))
    .orderBy(desc(authNonces.issuedAt))
    .limit(1);
  if (!challenge) throw new HttpError(401, 'no active link challenge for this wallet');

  const message = buildSeekerLinkMessage({
    domain, seekerWallet, gameWallet, nonce: challenge.nonce, issuedAt: challenge.issuedAt,
  });
  const ok = await verifyAsync(sigBytes, new TextEncoder().encode(message), bs58.decode(seekerWallet));
  if (!ok) throw new HttpError(401, 'invalid signature');

  // Single-use even under concurrent verifies.
  const consumed = await db.update(authNonces).set({ usedAt: new Date() })
    .where(and(eq(authNonces.id, challenge.id), isNull(authNonces.usedAt)))
    .returning({ id: authNonces.id });
  if (consumed.length === 0) throw new HttpError(401, 'challenge already used');
}

export interface LinkDeps {
  /** Read-only mainnet endpoint. Absent ⇒ 503, never a badge. */
  mainnetRpcUrl?: string | undefined;
  /** SECOND, independent read-only mainnet endpoint (a different provider).
   *  Present ⇒ both must agree before a badge is granted. Absent ⇒ every verdict
   *  is reported `unconfirmed` rather than passed off as certain. */
  mainnetRpcUrlSecondary?: string | undefined;
  /** Injectable transport (tests fake mainnet; production uses global fetch). */
  fetchImpl?: typeof fetch | undefined;
}

type ClaimOutcome = 'linked' | 'bound_elsewhere' | 'mint_claimed' | 'wallet_claimed' | 'account_conflict';

/** The manual route's contract: each non-linked outcome keeps its original 409. */
function claimConflictError(outcome: Exclude<ClaimOutcome, 'linked'>): HttpError {
  switch (outcome) {
    case 'bound_elsewhere':
      return new HttpError(409, 'this account is bound to a different Seeker Genesis Token — relink that one');
    case 'mint_claimed':
      return new HttpError(409, 'that Seeker Genesis Token is already linked to another account');
    case 'wallet_claimed':
      return new HttpError(409, 'that Seeker wallet is already linked to another account');
    case 'account_conflict':
      return new HttpError(409, 'this account already has a linked Seeker wallet');
  }
}

/**
 * Persist a PROVEN holding as `gameWallet`'s seeker link — the ONE writer both
 * proof paths share (manual challenge link, gate auto-detect), so the three
 * consequences of a proof can never drift apart:
 *  - the seeker_links row claims the SGT mint under the FULL unique index
 *    (one SGT = one physical Seeker = at most one game account, forever);
 *  - players.seeker_verified mirrors it in the same transaction;
 *  - alpha_access gains a source='seeker' row (owner 2026-08-08: holding a
 *    Seeker IS the invite — no code needed). STICKY on purpose, like an
 *    invite: the alpha gate runs on every authed request, and a grant that
 *    tracked the live badge would turn a mainnet outage (which fail-closes the
 *    badge) into a 403 lockout of every Seeker-admitted player mid-game.
 *    onConflictDoNothing keeps an existing 'invite'/'env'/'manual' row as-is.
 *    Granted ONLY when the row is first INSERTED, never on revival — the
 *    seeker_links row is the redemption anchor, exactly like
 *    alpha_applications.redeemed_wallet for invites ("Revocation must win",
 *    security review 2026-08-05 #1): ops deleting the alpha_access row must
 *    STAY deleted, and a revival that re-inserted it would let a banned
 *    account re-admit itself by re-proving the same token. Pre-existing rows
 *    get their insert-time grant late, via the 0050 migration backfill.
 *
 * RE-LINK (security review F3): a revoked row for THIS account — an unlink, or
 * a recheck that couldn't see the token — must not be a life sentence, and
 * `wallet` is the PRIMARY KEY so a plain insert would 409 on it forever.
 * Revival is gated on the SGT MINT matching, which is the whole anti-sybil
 * claim; a DIFFERENT token answers 'bound_elsewhere', because moving the row's
 * mint would release the old one for a second account to claim.
 *
 * Returns the dedupe verdict instead of throwing — the dedupe firing is the
 * FEATURE: the manual route maps each outcome to its 409, auto-detect skips
 * silently. Never auto-migrate a mint between accounts on conflict; that would
 * defeat "one device, one account" entirely.
 */
async function claimSgtHolding(
  db: Db, gameWallet: string, seekerWallet: string,
  holding: SgtHolding, skr: string | null, now: Date,
): Promise<ClaimOutcome> {
  const [prior] = await db.select().from(seekerLinks).where(eq(seekerLinks.wallet, gameWallet));
  if (prior && prior.sgtMint !== holding.mint) return 'bound_elsewhere';

  try {
    await db.transaction(async (tx) => {
      if (prior) {
        await tx.update(seekerLinks).set({
          seekerWallet, memberNumber: holding.memberNumber,
          // A domain proven now wins; otherwise keep the one proven last time
          // (an unlink never invalidated it, and it grants nothing either way).
          skrDomain: skr ?? prior.skrDomain,
          verifiedAt: now, lastCheckedAt: now, revokedAt: null,
        }).where(eq(seekerLinks.wallet, gameWallet));
      } else {
        await tx.insert(seekerLinks).values({
          wallet: gameWallet, seekerWallet, sgtMint: holding.mint,
          memberNumber: holding.memberNumber, skrDomain: skr,
          verifiedAt: now, lastCheckedAt: now,
        });
        // The closed-alpha grant rides the SAME transaction as the FIRST (and
        // only-ever) insert of this row: an admission with no claim behind it
        // must be impossible, and a claim row is a once-per-account event —
        // so ops deleting the grant later can never be undone from here (the
        // revival branch above deliberately grants nothing).
        await tx.insert(alphaAccess).values({ wallet: gameWallet, source: 'seeker' }).onConflictDoNothing();
      }
      // Denormalized badge, same transaction as its truth.
      await tx.update(players).set({ seekerVerified: true }).where(eq(players.wallet, gameWallet));
    });
  } catch (e) {
    // drizzle wraps driver errors, so unwrap `.cause` too (clans.ts convention).
    const cause = (e as { cause?: { code?: string; constraint_name?: string } }).cause;
    const code = (e as { code?: string }).code ?? cause?.code;
    const constraint = String(
      (e as { constraint_name?: string }).constraint_name ?? cause?.constraint_name ?? (e as Error).message,
    );
    if (code === '23505') {
      if (constraint.includes('sgt_mint')) return 'mint_claimed';
      if (constraint.includes('seeker_wallet')) return 'wallet_claimed';
      return 'account_conflict';
    }
    throw e;
  }
  return 'linked';
}

/** Independent sources this deployment can cross-check against. */
function sourcesOf(deps: LinkDeps): number {
  return independentSourceCount(deps.mainnetRpcUrl, deps.mainnetRpcUrlSecondary);
}

/**
 * Verify + bind. Order matters: signature FIRST (cheap, and it stops an
 * unauthenticated wallet from burning our mainnet RPC quota), holding SECOND.
 */
export async function verifyAndLinkSeeker(
  db: Db, deps: LinkDeps, domain: string, gameWallet: string,
  input: { seekerWallet: string; signature: string; skrDomain?: string | undefined },
): Promise<{ seeker: SeekerStatus; username: string | null }> {
  const { seekerWallet } = input;
  // The RAW row, not getSeekerStatus: a revoked row is "unlinked" to the
  // badge but its mint still matters below — a revival must ask mainnet about
  // THAT mint, or a second SGT in the wallet can win the enumeration race and
  // turn "same device came back" into a baffling 409 (the recheck bug's
  // manual-path twin).
  const [prior] = await db.select().from(seekerLinks).where(eq(seekerLinks.wallet, gameWallet));
  if (prior && !prior.revokedAt) throw new HttpError(409, 'this account already has a linked Seeker wallet');

  await consumeLinkChallenge(db, domain, gameWallet, seekerWallet, input.signature);

  // The holding check below reaches every configured mainnet endpoint, and
  // this route is reachable PRE-alpha-gate (a split-wallet Seeker proving
  // theirs from the gate screen, 2026-08-08) — so it draws from the SAME
  // global probe budget as gate auto-detect. Without this it was the one
  // pre-gate mainnet path outside the ceiling: 20/min/IP of self-signed link
  // attempts, times any number of IPs, could starve the quota that keeps real
  // Seekers' badges lit. Ordered AFTER the signature check on purpose: a
  // request that did no real work can never spend a probe slot.
  if (!takeAutoDetectProbe(new Date())) {
    throw new HttpError(503, 'Seeker verification is busy — try again shortly');
  }

  let verification;
  try {
    verification = await verifySgtOwnership({
      rpcUrl: deps.mainnetRpcUrl, secondaryRpcUrl: deps.mainnetRpcUrlSecondary,
      owner: seekerWallet, expectedMint: prior?.sgtMint, fetchImpl: deps.fetchImpl,
    });
  } catch (e) {
    // FAIL CLOSED and write nothing: an outage must neither grant nor revoke.
    // A CONFLICT is called out separately — "the sources disagree" is not an
    // outage, and a user retrying past it should not think they were told "no".
    if (e instanceof SeekerSourceConflictError) throw new HttpError(503, 'Seeker verification could not be confirmed — our two mainnet sources disagree about this wallet');
    if (e instanceof SeekerRpcError) throw new HttpError(503, 'Seeker verification is unavailable right now — try again shortly');
    throw e;
  }
  const holding = verification.holding;
  if (!holding) {
    throw new HttpError(404, 'no Seeker Genesis Token in that wallet — the SGT lives in your Seed Vault Wallet\'s primary account');
  }
  // A NEW GRANT requires both sources to have actually answered (money review
  // 2026-07-29 #4). The cross-check is only as strong as both endpoints being
  // up: with two configured and one merely SLOW, allSettled yields a single
  // answer and `unconfirmed` was a label rather than a gate — so poisoning one
  // endpoint never had to beat the other, only outlast the shared deadline.
  // Degrading is right for a RE-CHECK (never revoke on an outage); it is wrong
  // for handing out a badge in the first place.
  if (deps.mainnetRpcUrlSecondary && !verification.confirmed) {
    throw new HttpError(503, 'Seeker verification could not be confirmed by both sources — try again shortly');
  }

  // `.skr` is decoration: resolved only after the SGT passed, forward-checked
  // against the .skr parent so a foo.sol can't pose as one, and never fatal.
  let skr: string | null = null;
  if (input.skrDomain) {
    const rec = await resolveSkrOwnedBy({
      rpcUrl: deps.mainnetRpcUrl, domain: input.skrDomain,
      expectedOwner: seekerWallet, fetchImpl: deps.fetchImpl,
    });
    skr = rec?.domain ?? null;
  } else {
    // AUTO-DISCOVERY: no typed domain ⇒ ask mainnet which .skr this wallet
    // owns (a typed domain always wins — it is the player's explicit choice).
    // STRICTLY after the SGT gate above, so the gPA it may issue — the most
    // expensive read we make — is never spent on a non-Seeker. Discovery only
    // NOMINATES; the forward proof inside it decides, and a failure here
    // degrades to exactly the old blank-input outcome: linked + badge +
    // username null.
    const rec = await discoverSkrOwnedBy({
      rpcUrl: deps.mainnetRpcUrl, owner: seekerWallet, fetchImpl: deps.fetchImpl,
    });
    skr = rec?.domain ?? null;
  }

  const now = new Date();
  const outcome = await claimSgtHolding(db, gameWallet, seekerWallet, holding, skr, now);
  if (outcome !== 'linked') throw claimConflictError(outcome);

  const username = skr ? await adoptSkrUsername(db, gameWallet, skr) : null;
  // The count that ACTUALLY agreed on this proof — not the configured one, so a
  // link completed while the cross-check was down reports itself unconfirmed.
  return { seeker: await getSeekerStatus(db, gameWallet, now, verification.sources), username };
}

/**
 * Late `.skr` adoption (POST /seeker/skr/adopt): re-run discovery for a linked
 * account that has NO domain on file — e.g. discovery was down at link time,
 * or the player registered their .skr afterwards.
 *
 * Deliberately its own user-initiated route rather than part of recheckSeeker:
 * that runs on hot /me reads, and wiring a gPA into it would be the F4 RPC
 * amplifier all over again. 404 (not 200-with-nothing) when there is no
 * non-revoked link or a domain is already on file, so the client can tell
 * "nothing to do" from "found nothing". Discovery finding nothing is a normal
 * 200 — same never-fatal contract as the link path.
 */
export async function adoptDiscoveredSkr(
  db: Db, deps: LinkDeps, wallet: string,
): Promise<{ seeker: SeekerStatus; username: string | null }> {
  const [row] = await db.select().from(seekerLinks).where(eq(seekerLinks.wallet, wallet));
  if (!row || row.revokedAt) throw new HttpError(404, 'no linked Seeker wallet');
  if (row.skrDomain) throw new HttpError(404, 'this account already has a .skr domain on file');

  const rec = await discoverSkrOwnedBy({
    rpcUrl: deps.mainnetRpcUrl, owner: row.seekerWallet, fetchImpl: deps.fetchImpl,
  });
  if (rec) {
    await db.update(seekerLinks).set({ skrDomain: rec.domain }).where(eq(seekerLinks.wallet, wallet));
  }
  // adoptSkrUsername keeps every safety property this route must not weaken:
  // never overwrites a chosen name, never throws, enforces RESERVED/charset/
  // length/uniqueness, and never stamps the rename cooldown.
  const username = rec ? await adoptSkrUsername(db, wallet, rec.domain) : null;
  // No SGT check happened here, so report the CONFIGURED source count.
  return { seeker: await getSeekerStatus(db, wallet, new Date(), sourcesOf(deps)), username };
}

/**
 * Unlink. Sets `revoked_at` and drops the badge but KEEPS the row — the SGT
 * mint stays claimed, so the same device cannot go on to badge a second
 * account.
 *
 * Re-linking is possible, and ONLY back to this account: `verifyAndLinkSeeker`
 * revives this row when the same SGT is proven again (fresh signature, fresh
 * mainnet read), and refuses the mint everywhere else. Unlink is reversible;
 * the anti-sybil binding is not (security review F3 — this used to be a
 * permanent lockout, with a docstring implying otherwise).
 */
export async function unlinkSeeker(db: Db, wallet: string): Promise<void> {
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx.update(seekerLinks).set({ revokedAt: now }).where(eq(seekerLinks.wallet, wallet));
    // sgtCheckedAt too (2026-08-08): auto-detect revives a revoked row when
    // the same mint is still in the session wallet, so without this stamp the
    // very next /me silently undid the player's explicit UNLINK. Stamping the
    // negative cache makes the choice hold for autoDetectRecheckHours; after
    // that, automatic detection is simply the designed behavior again.
    await tx.update(players).set({ seekerVerified: false, sgtCheckedAt: now })
      .where(eq(players.wallet, wallet));
  });
}

/**
 * In-process back-off for FAILED re-verifies, keyed by game wallet.
 *
 * A stale link is re-verified on every read until it succeeds, so an unreachable
 * mainnet would turn a polling client's /me into an outbound call per poll —
 * the same unbounded-third-party-calls hole F4 closed on the refresh route,
 * arriving through the front door. Deliberately per-process and unpersisted:
 * losing it on restart costs one extra attempt, and it must never be the thing
 * that decides whether someone is verified.
 */
const recheckBackoff = new Map<string, number>();

/**
 * A stale link we could not re-prove. FAIL CLOSED: the public badge
 * (`players.seeker_verified`, what the map roster / raid log / clan roster
 * render) goes off, because we no longer have a proof inside the staleness
 * budget that this account holds the token. The seeker_links row is NOT
 * revoked — an outage is not evidence of a sale, and the mint stays claimed —
 * so a successful re-verify lights the badge straight back up.
 */
async function failClosedStale(
  db: Db, row: typeof seekerLinks.$inferSelect, now: Date, sources: number,
): Promise<SeekerStatus> {
  // Guarded so the repeat reads during an outage are no-op writes.
  await db.update(players).set({ seekerVerified: false })
    .where(and(eq(players.wallet, row.wallet), eq(players.seekerVerified, true)));
  return toStatus(row, now, sources);
}

/**
 * Re-verify a linked account's holding against mainnet and update the badge.
 *
 * This is the badge's ONLY expiry mechanism, so every badge-rendering read goes
 * through it (/me, /seeker/status): nothing else calls it, and a verdict that is
 * never re-checked survives selling the SGT indefinitely (security review F5).
 * Per the R9 incident, correctness must NEVER depend on ENABLE_WORKERS.
 *
 * Bounded three ways so "verify on read" cannot become an RPC amplifier
 * (security review F4): a verdict inside SEEKER.recheckHours is REUSED with no
 * network at all, a failure backs off for SEEKER.recheckBackoffMin, and the
 * verification itself carries a total time budget + candidate cap
 * (packages/chain/src/seeker.ts).
 *
 * Outage policy, both directions:
 *  - FRESH verdict → never touched (we don't even ask mainnet), so a transient
 *    error can't revoke a badge we proved an hour ago;
 *  - STALE verdict → fail closed, badge off, row intact.
 */
export async function recheckSeeker(
  db: Db, deps: LinkDeps, wallet: string, now = new Date(),
): Promise<SeekerStatus> {
  const [row] = await db.select().from(seekerLinks).where(eq(seekerLinks.wallet, wallet));
  if (!row || row.revokedAt) return UNLINKED;

  // No check performed on these paths, so the honest number to report is what
  // this deployment cross-checks — see SeekerStatus.verificationSources.
  const configured = sourcesOf(deps);

  // Inside the staleness budget the verdict on file IS the answer. This is what
  // makes ?refresh=1 un-abusable: spamming it costs one indexed SELECT.
  if (!isStale(row, now)) return toStatus(row, now, configured);

  const backoffUntil = recheckBackoff.get(wallet);
  if (backoffUntil !== undefined && backoffUntil > now.getTime()) {
    return failClosedStale(db, row, now, configured);
  }
  recheckBackoff.delete(wallet);

  let verification;
  try {
    verification = await verifySgtOwnership({
      rpcUrl: deps.mainnetRpcUrl, secondaryRpcUrl: deps.mainnetRpcUrlSecondary,
      // Name the LINKED mint: a wallet may hold a second SGT (they are freely
      // sellable), and without this the re-check revoked a valid link whenever
      // the other token won the enumeration race.
      owner: row.seekerWallet, expectedMint: row.sgtMint, fetchImpl: deps.fetchImpl,
    });
  } catch {
    // Includes a SOURCE CONFLICT: two endpoints disagreeing is not evidence of
    // a sale, so the badge goes dark (we cannot vouch) and the link survives —
    // identical handling to an outage, on purpose.
    recheckBackoff.set(wallet, now.getTime() + SEEKER.recheckBackoffMin * 60_000);
    return failClosedStale(db, row, now, configured);
  }
  const holding = verification.holding;

  // The SGT carries a permanentDelegate (Solana Mobile can move it), so a
  // transfer away is possible and must drop the badge — but the mint stays
  // claimed, so the new holder gets a 409 rather than a free identity.
  if (!holding || holding.mint !== row.sgtMint) {
    await db.transaction(async (tx) => {
      await tx.update(seekerLinks).set({ revokedAt: now, lastCheckedAt: now })
        .where(eq(seekerLinks.wallet, wallet));
      // The USERNAME is deliberately kept: losing a badge should not also blank
      // the player's identity, and it is already unique-indexed.
      await tx.update(players).set({ seekerVerified: false }).where(eq(players.wallet, wallet));
    });
    return UNLINKED;
  }

  await db.transaction(async (tx) => {
    await tx.update(seekerLinks).set({ lastCheckedAt: now }).where(eq(seekerLinks.wallet, wallet));
    // Re-assert the denormalized badge: a previous fail-closed read may have
    // cleared it while mainnet was unreachable.
    await tx.update(players).set({ seekerVerified: true }).where(eq(players.wallet, wallet));
  });
  // A check DID happen here, so report what actually agreed on it.
  return toStatus({ ...row, lastCheckedAt: now }, now, verification.sources);
}

/**
 * In-process ceiling on TOTAL SGT probes per minute, all wallets combined —
 * spent by gate auto-detect AND by the manual /seeker/link/verify holding
 * check (both are reachable before the alpha gate by anyone with a keypair).
 * Without it a stream of fresh wallets could spend the whole mainnet RPC
 * quota — and a starved quota fail-closes REAL Seekers' badges. Deliberately
 * per-process and unpersisted, like recheckBackoff: losing it on restart
 * costs a burst of extra probes, never a wrong verdict.
 */
let autoDetectWindowMinute = 0;
let autoDetectProbesSpent = 0;

/** TEST HOOK: clear the global probe window so cases can't starve each other. */
export function resetAutoDetectBudget(): void {
  autoDetectWindowMinute = 0;
  autoDetectProbesSpent = 0;
}

function takeAutoDetectProbe(now: Date): boolean {
  const minute = Math.floor(now.getTime() / 60_000);
  if (minute !== autoDetectWindowMinute) {
    autoDetectWindowMinute = minute;
    autoDetectProbesSpent = 0;
  }
  if (autoDetectProbesSpent >= SEEKER.autoDetectGlobalPerMin) return false;
  autoDetectProbesSpent += 1;
  return true;
}

/**
 * Post-sign-in SGT auto-detection (owner 2026-08-08: "detect seeker user
 * automatically each time user signs in" — a Seeker enters the closed alpha
 * with no invite code). The SIWS signature that minted this session already
 * proved control of `wallet`, so the server probes THAT wallet for an SGT with
 * no second challenge, and a hit writes the SAME atomic claim the manual link
 * writes (claimSgtHolding: mint claim + badge + sticky alpha grant).
 *
 * Detection and claiming are deliberately inseparable: the SGT is freely
 * sellable, and an admission handed out without claiming the mint would let
 * one token admit every wallet it passes through between sign-ins.
 *
 * BEST-EFFORT by contract — never throws, and every skip is silent (the next
 * gate or /me read retries). Latency: the holding check and the .skr discovery
 * each carry their own SEEKER.rpcTimeoutMs budget, but only the gate waits;
 * session creation never does. Cached probes answer with zero RPC. Bounded
 * four ways (F4 discipline):
 *  1. a LIVE link short-circuits with zero RPC — recheckSeeker owns that path;
 *  2. players.sgt_checked_at — a definitive "no SGT" is not re-asked for
 *     SEEKER.autoDetectRecheckHours (never stamped on an outage: no answer is
 *     not an answer, and stamping would turn a bad mainnet minute into a 24h
 *     Seeker denial);
 *  3. the shared per-wallet failure backoff (recheckBackoff);
 *  4. the global probes-per-minute ceiling above.
 * Grant bar matches the manual route (money review 2026-07-29 #4): with a
 * second RPC source configured, a NEW admission requires both to have answered
 * and agreed.
 */
export async function autoDetectSeeker(
  db: Db, deps: LinkDeps, wallet: string, now = new Date(),
): Promise<SeekerStatus> {
  const configured = sourcesOf(deps);
  const [prior] = await db.select().from(seekerLinks).where(eq(seekerLinks.wallet, wallet));
  if (prior && !prior.revokedAt) return toStatus(prior, now, configured);
  if (!deps.mainnetRpcUrl) return UNLINKED;

  const [me] = await db.select({ sgtCheckedAt: players.sgtCheckedAt }).from(players)
    .where(eq(players.wallet, wallet));
  if (!me) return UNLINKED; // no player row — nothing to attach a claim to
  if (me.sgtCheckedAt
    && now.getTime() - me.sgtCheckedAt.getTime() < SEEKER.autoDetectRecheckHours * 3_600_000) {
    return UNLINKED;
  }

  const backoffUntil = recheckBackoff.get(wallet);
  if (backoffUntil !== undefined && backoffUntil > now.getTime()) return UNLINKED;
  recheckBackoff.delete(wallet);

  if (!takeAutoDetectProbe(now)) return UNLINKED;

  let verification;
  try {
    verification = await verifySgtOwnership({
      rpcUrl: deps.mainnetRpcUrl, secondaryRpcUrl: deps.mainnetRpcUrlSecondary,
      // A revival candidate names its mint: a wallet holding a SECOND SGT must
      // not have the other token win the enumeration race and turn "same
      // device came back" into bound_elsewhere (the recheck fix, same bug).
      owner: wallet, expectedMint: prior?.sgtMint, fetchImpl: deps.fetchImpl,
    });
  } catch {
    recheckBackoff.set(wallet, now.getTime() + SEEKER.recheckBackoffMin * 60_000);
    return UNLINKED;
  }
  if (deps.mainnetRpcUrlSecondary && !verification.confirmed) {
    // The cross-check exists but didn't corroborate — same handling as an
    // outage: no negative stamp, back off, try again later.
    recheckBackoff.set(wallet, now.getTime() + SEEKER.recheckBackoffMin * 60_000);
    return UNLINKED;
  }

  const holding = verification.holding;
  if (!holding) {
    await db.update(players).set({ sgtCheckedAt: now }).where(eq(players.wallet, wallet));
    return UNLINKED;
  }

  // AUTO-DISCOVERY only (nobody typed a domain at sign-in), STRICTLY after the
  // SGT gate so the gPA it may issue is never spent on a non-Seeker — the same
  // ordering the manual path enforces. Failure degrades to "no name", never to
  // no link.
  const rec = await discoverSkrOwnedBy({
    rpcUrl: deps.mainnetRpcUrl, owner: wallet, fetchImpl: deps.fetchImpl,
  });
  const skr = rec?.domain ?? null;

  const outcome = await claimSgtHolding(db, wallet, wallet, holding, skr, now);
  if (outcome !== 'linked') {
    // The SGT (or this wallet) is already claimed by ANOTHER account — the
    // dedupe firing is the feature, not an error. Stamp the cache so a farmed
    // wallet can't re-bill the probe on every gate view; tomorrow re-asks.
    await db.update(players).set({ sgtCheckedAt: now }).where(eq(players.wallet, wallet));
    return UNLINKED;
  }
  if (skr) await adoptSkrUsername(db, wallet, skr);
  return getSeekerStatus(db, wallet, now, verification.sources);
}

/**
 * The badge-rendering altitude (/me): whichever lazy path applies. A live link
 * goes through recheckSeeker (staleness-budgeted re-verify, fail-closed
 * badge); everything else gets the bounded auto-detect — so a Seeker whose
 * cookie outlived their last sign-in (session JWTs live 7 days and verify
 * statelessly) is still picked up without re-authenticating.
 */
export async function resolveSeeker(
  db: Db, deps: LinkDeps, wallet: string, now = new Date(),
): Promise<SeekerStatus> {
  const [row] = await db.select({ revokedAt: seekerLinks.revokedAt }).from(seekerLinks)
    .where(eq(seekerLinks.wallet, wallet));
  if (row && !row.revokedAt) return recheckSeeker(db, deps, wallet, now);
  return autoDetectSeeker(db, deps, wallet, now);
}
