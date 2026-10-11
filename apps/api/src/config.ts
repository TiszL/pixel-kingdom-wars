import { createECDH } from 'node:crypto';
import { resolve as resolvePath } from 'node:path';
import { z } from 'zod';
import bs58 from 'bs58';
import { REALM_IDS, isRealmId, type RealmId } from '@shardkeep/shared/baseVisual';

/**
 * Hosts that are provably NOT mainnet-beta. The cheap half of the F8 assertion:
 * it costs no network and catches the realistic mistake (copying SOLANA_RPC_URL,
 * which is devnet, into the mainnet slot). The authoritative half is the genesis
 * hash checked once at boot — see assertMainnetCluster in server.ts, which is
 * what catches a private endpoint that merely *claims* to be mainnet.
 */
const NON_MAINNET_HOST = /(^|\.)(devnet|testnet|localhost)(\.|$)|^127\.|^0\.0\.0\.0$|^\[?::1\]?$/i;

/** base58, 32-byte-ish — the cheap shape check for a Solana address. It cannot
 *  prove the bytes decode to a valid point, but it catches every realistic
 *  paste error (truncation, an 0x address, a keypair path) at BOOT rather than
 *  at the moment an ops script writes the wrong creator on chain. */
const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const PRIVATE_POLICY_SIGNER_HTTP_ORIGIN = 'http://withdrawal-signer:3003';
const LOOPBACK_POLICY_SIGNER_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost']);
const SHARED_SOLANA_RPC_HOSTS = new Set(['api.devnet.solana.com', 'api.testnet.solana.com', 'api.mainnet-beta.solana.com']);

/** Direct operational helpers use the same fail-closed provider policy as boot.
 * Local development keeps its explicit convenience default; production cannot
 * silently borrow Solana's shared infrastructure when a secret is missing. */
export function resolveSolanaRpcUrl(raw: string | undefined, nodeEnv = 'production'): string {
  const value = raw || (nodeEnv === 'development' || nodeEnv === 'test' ? 'https://api.devnet.solana.com' : undefined);
  if (!value) throw new Error('SOLANA_RPC_URL must be explicitly configured in production');
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Solana RPC endpoint must be a valid HTTP(S) URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.hash) throw new Error('Solana RPC endpoint must be a valid HTTP(S) URL without a fragment');
  if (nodeEnv !== 'development' && nodeEnv !== 'test' && url.protocol !== 'https:') {
    throw new Error('production Solana RPC endpoint must use HTTPS');
  }
  if (nodeEnv !== 'development' && nodeEnv !== 'test' && SHARED_SOLANA_RPC_HOSTS.has(url.hostname.toLowerCase().replace(/\.$/, ''))) {
    throw new Error('production requires a private Solana RPC provider, including devnet');
  }
  return value;
}

/** Token-auth HTTP is acceptable only on the compose-internal signer network.
 * HTTPS and loopback HTTP remain usable without the production-only opt-in. */
export function assertSafeWithdrawalPolicySignerEndpoint(
  raw: string,
  allowPrivateHttp: string = 'false',
): void {
  if (allowPrivateHttp !== 'true' && allowPrivateHttp !== 'false') {
    throw new Error('WITHDRAWAL_POLICY_SIGNER_ALLOW_PRIVATE_HTTP must be true or false');
  }
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('policy signer URL must be a bare http(s) origin with no credentials, path, query or fragment');
  }
  if (url.protocol === 'https:' || LOOPBACK_POLICY_SIGNER_HOSTS.has(url.hostname.toLowerCase())) return;
  if (allowPrivateHttp === 'true' && raw === PRIVATE_POLICY_SIGNER_HTTP_ORIGIN) return;
  throw new Error(
    `plain HTTP policy signer URL must be loopback, or exactly ${PRIVATE_POLICY_SIGNER_HTTP_ORIGIN} with explicit private-network opt-in`,
  );
}

/**
 * Environment config — fail-fast: the process must not boot half-configured.
 */
/**
 * `VAR=` in an env file is PRESENT with value '' — not unset. Every optional
 * URL var must treat that as unset, or a template placeholder crash-loops the
 * api with `new URL('')` inside a zod refine (observed on the production host first
 * boot, 2026-08-06: SOLANA_MAINNET_RPC_URL_2= from .env.prod.example's own
 * empty placeholder). Falsy-checked string vars (TURNSTILE_SECRET_KEY etc.)
 * already behave; URLs are the ones that parse eagerly.
 */
function emptyIsUnset<T extends z.ZodTypeAny>(schema: T): z.ZodPipe<z.ZodTransform<unknown, unknown>, T> {
  return z.preprocess((v) => (v === '' ? undefined : v), schema) as never;
}

function validTwofaKeyring(raw: string): boolean {
  const seen = new Set<string>();
  return raw.split(',').every((entry) => {
    const colon = entry.indexOf(':');
    const id = entry.slice(0, colon);
    const encoded = entry.slice(colon + 1);
    if (colon < 1 || !/^[A-Za-z0-9_-]{1,32}$/.test(id) || seen.has(id)
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return false;
    seen.add(id);
    return Buffer.from(encoded, 'base64').length === 32;
  });
}

/** VAPID uses raw P-256 application-server keys encoded as unpadded base64url:
 * 65-byte uncompressed public point (04 || X || Y) and 32-byte private scalar.
 * Checking the cheap wire shape here keeps a paste/truncation error from first
 * surfacing after the deploy has entered maintenance. `web-push` remains the
 * cryptographic authority when the worker constructs its transport. */
function validVapidKey(raw: string, bytes: number, publicPoint = false): boolean {
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) return false;
  try {
    const decoded = Buffer.from(raw, 'base64url');
    return decoded.length === bytes
      && decoded.toString('base64url') === raw
      && (!publicPoint || decoded[0] === 0x04);
  } catch {
    return false;
  }
}

function validVapidPair(publicKey: string, privateKey: string): boolean {
  try {
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(Buffer.from(privateKey, 'base64url'));
    return ecdh.getPublicKey().equals(Buffer.from(publicKey, 'base64url'));
  } catch {
    return false;
  }
}

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  /** HMAC secret for session JWTs. Long enough that HS256 brute force is moot. */
  JWT_SECRET: z.string().min(32),
  /**
   * Allowed browser origin(s) for CORS with credentials. ONE origin, or several
   * separated by commas.
   *
   * A list because a single value is genuinely not enough locally: `pnpm dev:web`
   * serves on :5173 and `vite preview` on :4173, so pinning one makes the other
   * fail — and CORS failure surfaces in the browser as a bare "Failed to fetch"
   * with no clue that the origin is the problem. Cost an hour on 2026-07-30.
   *
   * Still an exact-match ALLOWLIST, never a wildcard: credentials are sent, so
   * `*` is both forbidden by the spec and would expose every authed route to any
   * site. Each entry is URL-validated, and an origin must have no path — a
   * browser's Origin header never carries one, so a trailing slash silently
   * matches nothing and is rejected here instead.
   */
  /** Marketing-site origins allowed to reach ONLY /alpha/apply, WITHOUT
   *  credentials. Deliberately separate from WEB_ORIGIN (security review
   *  2026-08-05 finding 5): WEB_ORIGIN is the credentialed CORS allowlist for
   *  the WHOLE api — putting the landing site there would let a compromised
   *  Pages deploy make cookie-authed requests to admin and money routes. */
  LANDING_ORIGINS: z.string()
    .default('https://pixelkingdomwars.com,https://www.pixelkingdomwars.com')
    .transform((s) => s.split(',').map((v) => v.trim()).filter((v) => v !== '')),
  /** Where invite emails send players. Explicit env rather than WEB_ORIGIN[0]
   *  because ops APPENDING vs PREPENDING an origin silently changed the link
   *  target (security review finding 9). Optional: falls back to WEB_ORIGIN[0]. */
  PLAY_URL: emptyIsUnset(z.string().url().optional()),
  WEB_ORIGIN: z.string().min(1).transform((s, ctx) => {
    const parts = s.split(',').map((v) => v.trim()).filter((v) => v !== '');
    if (parts.length === 0) {
      ctx.addIssue({ code: 'custom', message: 'WEB_ORIGIN is empty' });
      return z.NEVER;
    }
    for (const part of parts) {
      let u: URL;
      try { u = new URL(part); } catch {
        ctx.addIssue({ code: 'custom', message: `WEB_ORIGIN entry is not a URL: ${part}` });
        return z.NEVER;
      }
      if (part === '*' || u.pathname !== '/' || part.endsWith('/')) {
        ctx.addIssue({
          code: 'custom',
          message: `WEB_ORIGIN entry must be a bare origin with no path or trailing slash: ${part}`,
        });
        return z.NEVER;
      }
    }
    return [...new Set(parts)];
  }),
  PORT: z.coerce.number().int().positive().default(3001),
  HOST: z.string().default('0.0.0.0'),
  /** FAIL-CLOSED: an unset/misconfigured NODE_ENV must NEVER mean development —
   * otherwise the dev-login route (signature-less account takeover, gated on
   * `NODE_ENV !== 'production'`) and the `secure` cookie flag silently open on a
   * misconfigured deploy (security review 2026-07-18). Local dev + CI set it
   * explicitly (`.env`, TEST_CONFIG); production defaults here. */
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  /** Rate limiting (ops knobs, NOT game numbers — so they live here, not in
   * @shardkeep/shared). Global default per IP; sensitive routes tighten it
   * per-route. Disabled under NODE_ENV=test. */
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),

  // --- Chain + infra (validated at boot so the process can't start half-wired;
  //     previously these were read raw from process.env in jobs.ts, unvalidated). ---
  /** Economy cluster. Devnet remains the default; mainnet-beta is an explicit
   * cutover and is additionally guarded by two independent RPCs, a cluster-
   * labelled public address registry, and genesis-hash checks in server.ts. */
  SOLANA_CLUSTER: z.enum(['devnet', 'mainnet-beta']).default('devnet'),
  /** Solana RPC endpoint for every chain read/write (money bar: `finalized`). */
  SOLANA_RPC_URL: z.url().default('https://api.devnet.solana.com'),
  /** Independent economy-cluster RPC. Optional on devnet; mandatory on
   * mainnet-beta, where the hostname must differ from SOLANA_RPC_URL. Both
   * endpoints are proved by genesis hash before the API touches the database. */
  SOLANA_RPC_URL_2: emptyIsUnset(z.url().optional()),
  /** Optional isolated read-only mint evidence provider; all inventory, original
   * mint proofs and campaign-close history stay on this one attested endpoint. */
  MINT_EVIDENCE_RPC_URL: emptyIsUnset(z.url().optional()),
  /** Independently disable browser relay transport without altering chain jobs. */
  RPC_RELAY_ENABLED: z.enum(['true', 'false']).default('false'),
  /** Non-secret vendor labels (for example `helius` and `quicknode`). Distinct
   * hosts alone do not prove failure independence because one vendor can serve
   * many hostnames, so mainnet requires both labels and rejects equal values. */
  SOLANA_RPC_PROVIDER: emptyIsUnset(z.string().trim().min(1).max(64).regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
    'SOLANA_RPC_PROVIDER must be a short non-secret vendor label',
  ).optional()),
  SOLANA_RPC_PROVIDER_2: emptyIsUnset(z.string().trim().min(1).max(64).regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
    'SOLANA_RPC_PROVIDER_2 must be a short non-secret vendor label',
  ).optional()),
  /** READ-ONLY mainnet-beta endpoint, used ONLY to verify Seeker Genesis Tokens
   * and `.skr` domains. It stays separate from the selected economy RPC even
   * after a mainnet cutover: this optional identity feature can fail closed
   * without sharing configuration authority with money paths. Unset ⇒
   * /seeker/link/* answers 503 and the client hides the link button; badges
   * already granted are untouched (an outage must not revoke). */
  SOLANA_MAINNET_RPC_URL: emptyIsUnset(z.url().optional().refine(
    (u) => u === undefined || !NON_MAINNET_HOST.test(new URL(u).hostname),
    'SOLANA_MAINNET_RPC_URL must point at mainnet-beta (got a devnet/testnet/local host)',
  )),
  /** SECOND, INDEPENDENT read-only mainnet-beta endpoint — a DIFFERENT provider
   * from SOLANA_MAINNET_RPC_URL (same host = one source, and the code says so).
   * The Seeker badge is an anti-sybil claim derived entirely from an
   * unauthenticated third-party RPC response; with this set, two providers must
   * agree on the SGT before a badge is granted, and a disagreement grants
   * nothing (2026-07-29 review, finding (a)). Unset is supported and honest:
   * every verdict is then reported `unconfirmed` to the client. */
  SOLANA_MAINNET_RPC_URL_2: emptyIsUnset(z.url().optional().refine(
    (u) => u === undefined || !NON_MAINNET_HOST.test(new URL(u).hostname),
    'SOLANA_MAINNET_RPC_URL_2 must point at mainnet-beta (got a devnet/testnet/local host)',
  )),
  /** Redis connection for the BullMQ job queues (workers only). */
  REDIS_URL: z.string().min(1).default('redis://localhost:6380'),
  /** Background workers (deposit-watch backstop + crons). Off by default —
   * crediting never depends on them (incident 2026-07-18). */
  ENABLE_WORKERS: z.enum(['true', 'false']).default('false'),
  /** Lost-PKW-authenticator recovery rollout. Start is dark by default; once a
   * hold exists its confirm/cancel/complete safety rails remain available even
   * if operators close new starts. */
  TOTP_RECOVERY_ENABLED: z.enum(['true', 'false']).default('false'),
  /** D-109: expose token login only after real-provider acceptance. */
  SOCIAL_TOKEN_LOGIN_ENABLED: z.enum(['true', 'false']).default('false'),
  PRIVY_APP_ID: emptyIsUnset(z.string().min(1).optional()),
  PRIVY_JWKS_URL: emptyIsUnset(z.url().optional().refine((value) => {
    if (!value) return true;
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash;
  }, 'PRIVY_JWKS_URL must be an HTTPS verification-key endpoint')),

  /** DEV ONLY signature-less login. Double-gated with NODE_ENV != production. */
  DEV_LOGIN: z.enum(['true', 'false']).default('false'),
  /** DEV ONLY realm switch for the dev-login base (docs/REALM-THEMES-PLAN.md §3 P0,
   * D-174): the realm the stable dev base PRESENTS — `GET /base` visualContext, kit
   * obstacles, the deed render, native content, the contexts new raids freeze — so a
   * realm kit is reviewed under a real base without a catalogue pin. A fresh dev base
   * is seeded there; an already-seated one keeps its fantasy claim (an assigned claim
   * is immutable by trigger, drizzle/0118 fantasy_claim_identity_guard) and only its
   * presentation follows the switch (game/baseVisual.ts resolveBaseVisual, dev-fixture
   * bases only). Unset keeps today's behaviour. Schema-validated like DEV_LOGIN so a
   * misspelt realm fails boot instead of silently reviewing Crownlands, and for the
   * same reason a value requires DEV_LOGIN=true (only a dev-login host may present a
   * base elsewhere — see the superRefine). It does NOT require the fantasy world: a
   * base without a fantasy address presents the switch realm as well, so the local
   * review host (fantasy world off, legacy dev base) reviews a realm kit under its
   * real base. Refused under NODE_ENV=production like REALM_KIT_PREVIEW_MANIFESTS — a
   * production host presents persisted addresses only. */
  DEV_LOGIN_REALM: emptyIsUnset(z.enum(REALM_IDS).optional()),
  /**
   * FREE ONBOARDING (docs/LAND-DEED-ONBOARDING-PLAN.md P3) — 'true' lets a wallet
   * that has NOT bought land build a base: the FREE route group (build/progress/
   * look) drops the land gate, and `GET /base` — the first alpha-passing
   * authenticated touch — creates the starting base. Buying land (0.2 SOL,
   * `players.entryPaidAt`) still unlocks the Gold Forge, market selling, raiding
   * landowners, PvE bounties and clans.
   *
   * DEFAULT OFF. Schema-validated (like ENABLE_WORKERS / DEV_LOGIN) so a typo —
   * FALSE, 1, yes — fails BOOT instead of silently leaving the paywall up or
   * tearing it down.
   *
   * WHAT OFF GUARANTEES, EXACTLY (narrowed 2026-08-09, security review F2 — this
   * used to claim "exactly today's behaviour", which was not true and is not what
   * a kill switch needs to promise):
   *   1. AUTHORIZATION IS UNCHANGED, with the named exceptions listed below. The
   *      FREE group is registered WITH `requireLandOwned`, so every route that was
   *      gated before the split is gated, and the handful that were auth-only stay
   *      auth-only.
   *   2. NO BASE, PLOT OR STARTER GRANT EXISTS BEFORE THE ENTRY CREDIT. Nothing
   *      but the deposit watcher (and dev-login) creates a base.
   * That is the whole promise. It is about who may do what, and what exists —
   * which is what a rollback has to restore.
   *
   * WHAT IS *NOT* BEHIND THE FLAG, DELIBERATELY. These changes are unconditional,
   * because each one closes a hole that exists whether or not anyone is free, and
   * a hole that only closes when a flag is on is not closed:
   *   - the land gate's 402 now carries message "buy your land to unlock this" and
   *     code LAND_NOT_OWNED (auth/session.ts). Authorization-neutral — the same
   *     callers get the same 402 — and unconditional so the client has ONE 402
   *     contract to branch on instead of one per flag state.
   *   - `mintDeedIfConfigured` requires `entryPaidAt` (game/deed.ts): the deed is
   *     bought, never given.
   *   - `placeBuilding`/`upgradeBuilding` refuse `goldforge` without land
   *     (game/base.ts): the shards→KEEP faucet is a BUILDING, not a route.
   *   - `baseTransfer` refuses a buyer who has a base of their own, and
   *     `abandonFreeBase` is the explicit way through (game/baseTransfer.ts): a
   *     purchased base must never be merged onto someone's existing one.
   *   - matchmaking and scouting are partitioned by land tier (game/land.ts +
   *     game/raids.ts + world.ts's scoutBase), so the two pools are sealed in both
   *     directions. NOTE this makes attackability a FOUR-factor predicate, not the
   *     three-factor INV-1 form: see game/land.ts for the honest statement.
   *   - `searchPlayers` joins plots INNER, not LEFT (game/world.ts): a plotless base
   *     was enumerable by name prefix through the map search.
   *   - quest rewards are credited as SHARDS, not `player_keep` (game/quests.ts):
   *     the constants were always named `rewardShards` and the ledger disagreed.
   *   - `listItem` refuses `dropOnly` items (game/itemMarket.ts): a forged relic was
   *     sellable for SOL through the one door of three that did not check.
   * And the EXCEPTIONS to guarantee 1 — every one is an UN-GATING, every one was a
   * stranding bug, and none grants a landless caller anything beyond finishing or
   * releasing something that is already theirs:
   *   - POST /market/listings/:id/cancel, /paid and /settle are auth-only in BOTH
   *     flag states (game/routes.ts, security review F6). Gating them stranded real
   *     SOL the moment either party's `entryPaidAt` was cleared by a base transfer:
   *     the seller could not release their own listing, and the BUYER — who had
   *     already broadcast the payment — could not pin or settle the purchase they
   *     had paid for. All three are scoped to the caller's own row (`cancelListing`
   *     404s a listing that is not the caller's; `submitPayment` and `settleListing`
   *     422 anyone who is not the reserver), and cancel is the path that settles a
   *     paid-but-lapsed reservation to the buyer.
   *   - Account security is auth-only: `/2fa/*` manages the admitted player's
   *     verified Profile email/authenticator behind fresh wallet proof, while
   *     GET /auth/export/status + POST /auth/export/send-code support the custody
   *     right to export an embedded key. Withdrawal creation/prepare stays
   *     land-gated; caller-scoped history/cancel/refund remains auth-only so a
   *     deed sale cannot strand escrow. Instant custody is mature-TOTP-only, so
   *     account email cannot move funds or shorten unbonding.
   * The kill switch reverts WHO MAY PLAY FOR FREE. It does not un-fix bugs.
   */
  FREE_ONBOARDING: z.enum(['true', 'false']).default('false'),
  /** Additive five-base schema/API rollout. Default off until observation
   * compare audits and base-id dual writes are clean in production. */
  MULTI_BASE_ENABLED: z.enum(['true', 'false']).default('false'),
  FANTASY_WORLD_ENABLED: z.enum(['true', 'false']).default('false'),
  /** D-151: authenticated Phase E policy catalogue only. Enabling this read
   * never activates Phase E gameplay, transactions or native capabilities. */
  PHASE_E_CATALOG_ENABLED: z.enum(['true', 'false']).default('false'),
  /** D-152 (Gems): every system KEEP sink debits Gems, Gems are acquired only by
   * converting KEEP 1:1 (ledger source pre-F) or by owner-authored one-time task
   * grants, Gems → SHARDS 1:1 replaces /forge/convert. Dark by default; flags gate
   * intent creation and the sink currency only, never the crediting of money that
   * already moved. See docs/phase-e/E2-GEMS-CONTRACT.md §4. */
  GEMS_ENABLED: z.enum(['true', 'false']).default('false'),
  /** Child of GEMS_ENABLED: wallet-signed KEEP → Gems purchase intents (gems_buy). */
  GEMS_WALLET_BUY_ENABLED: z.enum(['true', 'false']).default('false'),
  /** Child of GEMS_ENABLED and devnet-only: the 5,000 welcome aid is granted as
   * Gems (PLAYTEST.welcomeGems) instead of a KEEP mail attachment. */
  DEVNET_WELCOME_GEMS_ENABLED: z.enum(['true', 'false']).default('false'),
  /** K-153: reserve authority, not an arbitrary transfer destination. Startup
   * derives and proves its Classic SPL KEEP ATA before any intent can quote it. */
  GEMS_RESERVE_OWNER: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().regex(BASE58_ADDRESS, 'GEMS_RESERVE_OWNER must be a base58 Solana address').optional(),
  ),
  /** Optional operator cross-check only; must equal the derived reserve ATA. */
  GEMS_RESERVE_ATA: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().regex(BASE58_ADDRESS, 'GEMS_RESERVE_ATA must be a base58 Solana address').optional(),
  ),
  /** D-152 §5 / E2-WORKSHOP-CONTRACT §6: placement and upgrade of the five dark
   * Phase E building types (workshop, lodge, market, harvester, berth). */
  PHASE_E_BUILDINGS_ENABLED: z.enum(['true', 'false']).default('false'),
  /** review b37cc131 S1: separate default-off QA construction-art permission. */
  PHASE_E_ART_ENABLED: z.enum(['true', 'false']).default('false'),
  /** New mining contribution admission; original recovery stays independent. */
  PHASE_E_MINING_ENABLED: z.enum(['true', 'false']).default('false'),
  /** Separate reviewed Phase E identity; never changes legacy v3/Gems custody. */
  PHASE_E_KEEP_IDENTITY: z.enum(['disabled', 'keep-v4']).default('disabled'),
  PHASE_E_KEEP_RESERVE_OWNER: emptyIsUnset(z.string().regex(BASE58_ADDRESS).optional()),
  /** Private devnet tester publication runtime. Every mount is explicitly dark. */
  MINING_PUBLICATION_TESTER_STACK: z.enum(['true', 'false']).default('false'),
  MINING_PUBLICATION_RECOVERY_ENABLED: z.enum(['true', 'false']).default('false'),
  MINING_PUBLICATION_JOB_ENABLED: z.enum(['true', 'false']).default('false'),
  /** Public identity only. This setting never names or loads signing material. */
  MINING_PUBLICATION_OPERATOR_PUBKEY: emptyIsUnset(z.string().regex(BASE58_ADDRESS).refine((value) => {
    try { const bytes = bs58.decode(value); return bytes.length === 32 && bytes.some(byte => byte !== 0); }
    catch { return false; }
  }, 'Mining publication operator must be a nondefault 32-byte public key').optional()),
  // Phase E B4: new original-owner claims require explicit opt-in; recovery survives pause.
  PHASE_E_SEEKER_ENABLED: z.enum(['true', 'false']).default('false'),
  /** D153.29: ordinary raw/refined conversion starts only; recovery remains available. */
  ORDINARY_CRAFTING_ENABLED: z.enum(['true', 'false']).default('false'),
  /** D153.30 new free installation and later starter departures only; recovery survives pause. */
  STARTER_EXPEDITIONS_ENABLED: z.enum(['true', 'false']).default('false'),
  /** D153.33 new Harvester sources only; original recovery and delivery survive pause. */
  HARVESTERS_ENABLED: z.enum(['true', 'false']).default('false'),
  /** Child of PHASE_E_BUILDINGS_ENABLED: the `/workshop*` refining routes and
   * the `forge_ingot` item (E2-WORKSHOP-CONTRACT §6; D-149 §5). */
  FORGE_INGOTS_ENABLED: z.enum(['true', 'false']).default('false'),
  /** Authoritative raid clock V2 is dark by default. Existing V2 rows remain
   * readable/resolvable while off; only creation and 1x -> 2x are gated. */
  LIVE_RAID_V2_ENABLED: z.enum(['true', 'false']).default('false'),
  /** Selected-base SSE rollout; status polling remains available while off. */
  RAID_EVENTS_ENABLED: z.enum(['true', 'false']).default('false'),
  /** Native rendering is additive and dark until device/load acceptance. These
   * optional bounds are executor capacity, never gameplay or economy values. */
  NATIVE_PRESENTATION_ENABLED: z.enum(['true', 'false']).optional(),
  /** Optional on the ordinary API; mandatory for an enabled isolated companion.
   * Empty never means public access for that companion. Do not log its entries. */
  NATIVE_PRESENTATION_WALLETS: emptyIsUnset(z.string().max(6_000).transform((value, ctx) => {
    const wallets = value.split(',').map((wallet) => wallet.trim());
    if (wallets.length > 128 || new Set(wallets).size !== wallets.length || wallets.some((wallet) => {
      try { return !BASE58_ADDRESS.test(wallet) || bs58.decode(wallet).length !== 32; } catch { return true; }
    })) {
      ctx.addIssue({ code: 'custom', message: 'native tester list must contain1–128 unique32-byte base58 wallets' });
      return z.NEVER;
    }
    return wallets;
  }).optional()),
  /** Explicit public admission for the ordinary API's native routes. Without it an
   * enabled native presentation refuses to boot unless a tester list exists — the
   * same fail-closed rule the isolated companion applies (security review 2026-09-11). */
  NATIVE_PRESENTATION_OPEN: z.enum(['true', 'false']).optional(),
  NATIVE_PRESENTATION_WORKERS: z.coerce.number().int().min(1).max(2).optional(),
  NATIVE_PRESENTATION_MAX_RAIDS: z.coerce.number().int().min(1).max(32).optional(),
  NATIVE_PRESENTATION_MAX_STREAMS: z.coerce.number().int().min(1).max(64).optional(),
  NATIVE_PRESENTATION_CACHE_MIB: z.coerce.number().int().min(1).max(128).optional(),
  NATIVE_MIN_VERSION_CODE: z.coerce.number().int().min(0).optional(),
  NATIVE_CONTENT_MANIFEST_URL: emptyIsUnset(z.url().refine((value) => new URL(value).protocol === 'https:').optional()),
  /** The content manifest advertised to native clients whose X-PKW-Renderer-Contract
   * is below the realm-kit contract (15) or absent, and to web. Installed code 25 caps
   * its content engine at contract 14, so the revision-5 pack must never reach it.
   * Unset ⇒ every caller gets NATIVE_CONTENT_MANIFEST_URL (today's behaviour). */
  NATIVE_CONTENT_MANIFEST_URL_LEGACY: emptyIsUnset(z.url().refine((value) => new URL(value).protocol === 'https:').optional()),
  /** QA-host preview of the revision-5 realm environment kit (docs/REALM-KIT-PLAN.md
   * §6 step 3, D-173): a comma list of realm ids whose CURRENT scenery is stamped
   * as groundRevision 5 by this host. Unset in production until the owner approves
   * the Crownlands pilot; a typo in a realm id fails boot rather than previewing
   * nothing. Frozen raid contexts are never rewritten by it. */
  REALM_KIT_PREVIEW_REALMS: emptyIsUnset(z.string().refine((value) => value.split(',').every((id) => isRealmId(id.trim())),
    'REALM_KIT_PREVIEW_REALMS must be a comma list of realm ids').optional()),
  /** DEV/QA ONLY twin of the switch above: `<realmId>=atlas/fantasy/layered-ground/<sha256>/manifest.json`
   * entries naming an UNPINNED kit this host serves for its preview realms (deed
   * renderer, expansion obstacles, native content). Refused under NODE_ENV=production
   * (see realmKitCatalogue.previewRealmKitDescriptors). */
  REALM_KIT_PREVIEW_MANIFESTS: emptyIsUnset(z.string().refine((value) => value.split(',').every((entry) => {
    const [id, manifestPath] = entry.split('=').map((s) => s.trim());
    return !!id && isRealmId(id) && /^atlas\/fantasy\/layered-ground\/[0-9a-f]{64}\/manifest\.json$/.test(manifestPath ?? '');
  }), 'REALM_KIT_PREVIEW_MANIFESTS must be <realmId>=atlas/fantasy/layered-ground/<sha256>/manifest.json entries').optional()),
  /** M45 §1 native in-app update channel. Dark by default: when 'true',
   * capabilities advertises the caller's visible native_update_channel row.
   * APK bytes are served by Caddy from R2 at PLAY_URL ?? WEB_ORIGIN[0], never by the API. */
  NATIVE_UPDATE_CHANNEL_ENABLED: z.enum(['true', 'false']).default('false'),
  /** D-180 (new world bundled in the APK with a kill switch; code 25 never locked out).
   * ON by default: capabilities always sends `worldV2: { enabled }` and a native client
   * runs the GL30 world unless it reads an explicit false. Set 'false' to send every
   * native client back to the legacy globe on its next capabilities read — no release,
   * no maintenance window, only the api container is recreated. */
  NATIVE_WORLD_V2_ENABLED: z.enum(['true', 'false']).default('true'),
  /** Ranked SHARDS/item settlement kill switch. Dark by default: the complete
   * earning week must begin only after the release candidate is verified. */
  LEAGUE_REWARDS_ENABLED: z.enum(['true', 'false']).default('false'),
  /** First complete Monday UTC earning window. Advance this when activation
   * misses the target week; settlements never backfill an incomplete window. */
  LEAGUE_REWARD_START_WEEK: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine((value) => {
      const parsed = new Date(`${value}T00:00:00.000Z`);
      return !Number.isNaN(parsed.getTime())
        && parsed.toISOString().slice(0, 10) === value
        && parsed.getUTCDay() === 1;
    }, 'LEAGUE_REWARD_START_WEEK must be a valid Monday UTC date')
    .default('2026-09-07'),
  /** New system/admin delivery only. Inbox reads, claims and expiry deliberately
   * ignore this switch so disabling campaigns can never strand escrow. */
  MAIL_DELIVERY_ENABLED: z.enum(['true', 'false']).default('false'),
  /** Mainnet KEEP attachments are a separate, fail-closed campaign authority.
   * The mail route must require BOTH this opt-in and a reviewed campaign budget;
   * ordinary SHARDS/item mail remains governed by MAIL_DELIVERY_ENABLED. */
  MAINNET_COMMUNITY_KEEP_MAIL_ENABLED: z.enum(['true', 'false']).default('false'),
  /** Public/auditable campaign identity and cumulative ceiling in whole KEEP
   * ledger units (the same unit mail attachment amounts use). These are inert
   * unless the mainnet-only opt-in above is true. */
  MAINNET_COMMUNITY_KEEP_MAIL_CAMPAIGN_ID: emptyIsUnset(z.string()
    .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, 'must be a lowercase campaign slug').optional()),
  MAINNET_COMMUNITY_KEEP_MAIL_BUDGET: emptyIsUnset(z.string()
    .regex(/^[1-9]\d*$/, 'must be a positive decimal KEEP amount')
    .refine((value) => /^[1-9]\d*$/.test(value)
      && BigInt(value) <= 9_223_372_036_854_775_807n, 'exceeds PostgreSQL bigint')
    .optional()),
  /** Clan GROWTH gate (owner 2026-08-15, M23 a17): clans are marked COMING
   * SOON until the post-alpha clan update, so create/join are refused while
   * reads, leave, kick and the weekly chest settle keep working — existing
   * clans (real 5,000-shard creates) are preserved, never stranded. */
  CLANS_ENABLED: z.enum(['true', 'false']).default('false'),
  /** Optional analytics relays (docs/ANALYTICS.md). Unset keys make
   * /telemetry a validated no-op sink. PostHog receives product events under
   * a pseudonymous id (HMAC of the wallet — raw wallets never leave this box);
   * Sentry receives the reliability tier: client errors relayed through
   * /telemetry AND this process's own 500s / failed worker jobs. */
  POSTHOG_API_KEY: emptyIsUnset(z.string().optional()),
  POSTHOG_HOST: emptyIsUnset(z.url().optional()),
  SENTRY_DSN: emptyIsUnset(z.url().optional()),
  /** SIM6 dark attacker rollout gate. The API remains the authority for
   * training, research and deployment; unset is deliberately OFF so shipping
   * the compatible schema/binary cannot expose the roster before verification.
   * Exact literals make an ops typo fail boot instead of accidentally opening
   * or silently misreporting the gate. */
  DARK_ATTACKER_ROSTER_ENABLED: z.enum(['true', 'false']).default('false'),
  /** Hero gear combat is ON by default (D-059, owner 2026-08-16: equipped items
   * must change hero stats end-to-end). The activation gate this flag used to
   * wait on — the max-geared defensive Theodor 90-second counter-sim — is
   * proven in packages/sim/tests/hero-gear.test.ts. Exact literals still make
   * an ops typo fail boot; 'false' remains the emergency balance rollback. */
  HERO_GEAR_COMBAT_ENABLED: z.enum(['true', 'false']).default('true'),
  /** Treasury KEEP buy-vend (owner 2026-08-16: "enable buy KEEP with sol on
   * devnet back again"). Default false keeps the ONRAMP-WALLETS-PLAN fail-closed
   * posture for any environment that doesn't opt in; devnet prod sets 'true'.
   * The credit rail stayed live throughout (a paid historical intent always
   * terminalizes) — this only gates NEW intents. PoR covers every credit
   * against the hot-wallet reserve either way. */
  KEEP_VEND_ENABLED: z.enum(['true', 'false']).default('false'),
  /** DEVNET PLAYTEST ONLY (owner 2026-08-22): in-game devnet SOL faucet. The
   * API records grant requests; the worker pays them from the keypair at
   * DEVNET_FAUCET_KEYPAIR_PATH (worker-only mount). Default off; refused on
   * mainnet-beta by the cluster refinement below. Remove before mainnet. */
  DEVNET_FAUCET_ENABLED: z.enum(['true', 'false']).default('false'),
  DEVNET_FAUCET_KEYPAIR_PATH: z.string().optional(),
  /** D153.275/X12: absence means no import, routes or queue. Never default this. */
  DEVNET_SKR_FAUCET_ENABLED: z.enum(['true', 'false']).optional(),
  DEVNET_SKR_FAUCET_KEYPAIR_PATH: z.string().optional(),
  /** Public-only exclusion pins; the worker holds until all are supplied. */
  DEVNET_SKR_FAUCET_ADMIN_PUBKEY: z.string().regex(BASE58_ADDRESS).optional(),
  DEVNET_SKR_FAUCET_SOL_FAUCET_PUBKEY: z.string().regex(BASE58_ADDRESS).optional(),
  DEVNET_SKR_FAUCET_DEED_OPERATIONS_PUBKEY: z.string().regex(BASE58_ADDRESS).optional(),
  /** Public authority only; API routes never read the worker keypair. */
  DEVNET_SKR_FAUCET_AUTHORITY: z.string().regex(BASE58_ADDRESS).refine((value) => {
    try { return bs58.decode(value).length === 32 && bs58.encode(bs58.decode(value)) === value; } catch { return false; }
  }, 'must be a canonical 32-byte public key').optional(),
  /** Owner N-045 (6 Oct 2026): QA chain lane ONLY. 'true' lets a base with no deed claim the devnet SKR faucet
   * (scripts/candidate/policy.mjs admits it only in the lane env file). Unset/'false' = D153.290, a deedless player
   * cannot claim. Refused under NODE_ENV=production and outside devnet (refinements below). */
  DEVNET_SKR_FAUCET_DEEDLESS_OK: z.enum(['true', 'false']).optional(),
  /** D-103: optional ISO-8601 start of the Founding Kingdoms playtest window
   * (PLAYTEST_CAMPAIGN.totalDays long). Unset = no window; every surface then
   * says the playtest is live and shows no day counter. Presentation only —
   * points and statistics never depend on it. */
  CAMPAIGN_START_AT: emptyIsUnset(z.string().datetime({ offset: true }).optional()),
  /**
   * THE COUNTRY ON THE DEED (docs/EARTH-TILES-PLAN.md P6, owner decision 2026-08-10
   * Q3) — 'true' adds the parcel's real-world COUNTRY and its frozen Earth tile to
   * a deed's metadata attributes.
   *
   * THE ONLY EARTH-TILE FLAG THE SERVER HAS, AND THAT IS DELIBERATE (D6,
   * 2026-08-10). A `PARCEL_CELLS` switch used to sit here, documented as the lever
   * that stopped a cell or a country "reaching the wire". It never had a production
   * caller: at that time no API response carried a cell or a country — the globe
   * derived tiles in the browser from `@shardkeep/shared/parcelGrid`. The 2026-08-11
   * deed-map contract now deliberately publishes frozen `earthCell` addresses in
   * map markers/viewer state and country only in the authenticated single-parcel
   * detail response; those are product identity, not deed-metadata rollout state.
   * The old dial therefore still would not govern them, while reading in the
   * config, the docs and `.env.example` as a rollback path somebody might one day
   * pull in an incident. It was deleted rather than wired, because wiring it would
   * have meant INVENTING a wire field to gate (a new payload, a new privacy surface,
   * a second copy of a mapping the client already computes), and a fake safety dial
   * is worse than none. Their privacy boundary is route shape + land ownership +
   * per-cell rate limiting, not this metadata publication switch.
   *
   * This one is REAL: `buildDeedMetadata` reads it (config.deedLocationV2Enabled) and
   * it decides what a published document says. It governs the document a Metaplex
   * asset POINTS AT, which wallets and marketplaces index and which the chain sweep
   * then versions on chain — the one publication in this system that cannot be
   * withdrawn.
   *
   * DEFAULT OFF, schema-validated like ENABLE_WORKERS / DEV_LOGIN / FREE_ONBOARDING:
   * a typo (TRUE, 1, yes) must fail BOOT rather than silently withhold a trait the
   * owner asked for, or silently publish one they did not.
   *
   * WHAT OFF GUARANTEES: `buildDeedMetadata` emits exactly the five traits it
   * emitted before P6, byte for byte — so flipping this back restores the previous
   * document through the ordinary R2 sweep and the `?v=` versioner. The URI PATH is
   * identical either way, so the re-point circuit breaker (MAX_REPOINTS_PER_PASS,
   * packages/chain/src/landDeed.ts) is never involved in either direction.
   */
  DEED_LOCATION_V2: z.enum(['true', 'false']).default('false'),
  /** Admin keypair for post_root relay (optional — the relay is disabled if unset). */
  ADMIN_KEYPAIR_PATH: z.string().optional(),
  /** Funded hot wallet for KEEP withdrawal payouts (optional — payout skipped if unset). */
  HOT_WALLET_KEYPAIR_PATH: z.string().optional(),
  /** Public address of the custody hot wallet. Unlike the keypair path this is
   * safe (and required by compose) on the public API: deposit verification,
   * destination intents and PoR are read-only. The worker proves its mounted
   * keypair matches this address before it is allowed to sign. */
  HOT_WALLET_PUBKEY: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().regex(BASE58_ADDRESS, 'HOT_WALLET_PUBKEY must be a base58 Solana address').optional(),
  ),
  /** Custody signing boundary. `legacy` is reviewed dev/test compatibility only;
   * `remote` isolates the database-connected worker from signer material, but
   * does not by itself make a software key suitable for mainnet custody. */
  WITHDRAWAL_SIGNER_MODE: z.enum(['legacy', 'remote']).default('legacy'),
  /** The only implemented signer key backend is a local 0600 file. Keeping this
   * as a closed literal prevents an operator from naming an imaginary HSM or
   * enclave backend and accidentally treating configuration as implementation. */
  WITHDRAWAL_POLICY_CUSTODY_BACKEND: z.literal('file').default('file'),
  WITHDRAWAL_POLICY_SIGNER_URL: emptyIsUnset(z.url().optional()),
  WITHDRAWAL_POLICY_SIGNER_ALLOW_PRIVATE_HTTP: z.enum(['true', 'false']).default('false'),
  WITHDRAWAL_POLICY_SIGNER_AUTH_TOKEN_FILE: emptyIsUnset(z.string().trim().min(1).optional()),
  WITHDRAWAL_POLICY_KEEP_MINT: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().regex(BASE58_ADDRESS, 'WITHDRAWAL_POLICY_KEEP_MINT must be a base58 Solana address').optional(),
  ),
  WITHDRAWAL_POLICY_MAX_PER_TRANSFER_KEEP: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().regex(/^[1-9][0-9]*$/, 'must be a positive decimal KEEP amount').optional(),
  ),
  WITHDRAWAL_POLICY_MAX_PER_WALLET_24H_KEEP: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().regex(/^[1-9][0-9]*$/, 'must be a positive decimal KEEP amount').optional(),
  ),
  WITHDRAWAL_POLICY_MAX_AGGREGATE_24H_KEEP: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().regex(/^[1-9][0-9]*$/, 'must be a positive decimal KEEP amount').optional(),
  ),
  /** Retired configuration trap. Arbitrary owners (especially a liquidity-pool
   * owner or generic treasury) are not controlled, unencumbered custody and may
   * not increase PoR. An old production env must fail boot instead of silently
   * restoring the unsafe multi-owner total. An empty legacy template value is
   * treated as absent to keep upgrades non-disruptive. */
  KEEP_RESERVE_EXTRA_OWNERS: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.undefined().optional(),
  ),
  /** Operational worker cadence. Instant withdrawals are due immediately, so
   * their queue must be polled in seconds rather than the historical 5 minutes. */
  WITHDRAWAL_PAYOUT_POLL_MS: z.coerce.number().int().min(1_000).max(60_000).default(10_000),
  /** Bounded worker self-heal for paid players whose best-effort deed mint did
   * not complete on the request path. */
  DEED_MINT_RECONCILE_POLL_MS: z.coerce.number().int().min(5_000).max(300_000).default(60_000),
  /** Repo root for locating the selected cluster's public address registry. */
  REPO_ROOT: z.string().optional(),
  /** Helius API key for DAS (owned-NFT reads, Marketplace Lane A). Optional —
   * the /market endpoints degrade to external links + an empty asset list when
   * unset, so devnet works without it. */
  HELIUS_API_KEY: z.string().optional(),
  /** Liquidity-bootstrap kill-switch (ONRAMP-WALLETS-PLAN §2/§8): 'false' blocks
   * new withdrawal requests globally while collected SOL seeds the pool.
   * Schema-validated so a typo (FALSE/0/no) FAILS BOOT like ENABLE_WORKERS /
   * DEV_LOGIN would — previously it was read raw in money/withdrawals.ts, where
   * anything but the lowercase literal 'false' silently left the gate OPEN.
   * Default ON is the documented decision (withdrawals.ts): devnet testing and
   * the post-liquidity steady state need no config. */
  WITHDRAWALS_ENABLED: z.enum(['true', 'false']).default('true'),
  /**
   * WHERE THE LAND DEED ROYALTY IS PAID (owner 2026-07-29: "5% royalty I want to
   * be flexible so lets add it in env file and I will set address manually there
   * so before mainnet deployment I will add final address there").
   *
   * The RATE is a game number and lives in MARKETPLACE.deedRoyaltyBps; the
   * DESTINATION is an address, which is deployment config, so it lives here.
   * Empty/unset = the ADMIN SIGNER, which is the devnet status quo — before the
   * change the creator was simply whoever signed `deed:collection`, so the
   * treasury could only be moved by changing which key runs ops.
   *
   * Setting this does NOT move the royalty by itself: the collection is the
   * royalty source of truth on chain and every asset mirrors it verbatim, so
   * the value only takes effect when the ops sweep writes it:
   *   DEED_ROYALTY_CREATOR=<addr> pnpm --filter @shardkeep/scripts deed:royalty:creator --confirm
   * Until then the api asserts the two agree and REFUSES TO MINT on a mismatch,
   * rather than minting deeds that pay somewhere the config denies.
   */
  DEED_ROYALTY_CREATOR: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().regex(BASE58_ADDRESS, 'DEED_ROYALTY_CREATOR must be a base58 Solana address (leave empty to use the admin signer)').optional(),
  ),
  // Owner 2026-09-07 (D-118): open admission independently of the internal
  // wallet lists, which also exclude team activity from public statistics.
  PLAYTEST_OPEN: z.enum(['true', 'false']).optional(),
  /**
   * CLOSED-ALPHA ACCESS LIST — comma-separated wallet pubkeys. UNSET = OPEN.
   *
   * DELIBERATELY THE INVERSE of NODE_ENV and WITHDRAWALS_ENABLED above, which
   * fail CLOSED. This variable is meant to be DELETED when the alpha opens, so an
   * unset or blank value must never be able to lock a live game out of itself.
   * `undefined` is the unambiguous "no gate" — hence .optional(), not a default.
   *
   * A MALFORMED entry still fails boot. The realistic mistake is a truncated
   * paste, and the two ways that could go wrong are both worse than a crash:
   * silently dropping the entry locks the owner out of his own game, and silently
   * ignoring the variable leaves the alpha wide open. An empty string means
   * OPEN (the DEED_ROYALTY_CREATOR precedent), so a leftover blank line in an env
   * file is not a lockout.
   */
  ALPHA_WALLETS: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().transform((s, ctx) => {
      const parts = [...new Set(s.split(',').map((p) => p.trim()).filter((p) => p !== ''))];
      for (const p of parts) {
        if (!BASE58_ADDRESS.test(p)) {
          ctx.addIssue({
            code: 'custom',
            message: `ALPHA_WALLETS entry is not a base58 Solana address: ${p}`,
          });
          return z.NEVER;
        }
      }
      return parts;
    }).optional(),
  ),
  /**
   * ADMIN ACCESS LIST for the closed-alpha review panel (/admin/alpha/*):
   * comma-separated wallet pubkeys. UNSET = the admin surface DOES NOT EXIST —
   * every admin route answers 404, even authenticated (routes-alpha.ts), so an
   * unconfigured deploy exposes no admin attack surface at all.
   *
   * Same validation posture as ALPHA_WALLETS above (and for the same reason):
   * a malformed entry fails boot rather than silently dropping the owner's
   * wallet from his own review panel. Admin wallets also pass the closed-alpha
   * gate implicitly (auth/session.ts) — the panel sits behind the same
   * authenticate chain, and an admin locked out of the tool that lets players
   * in is a support ticket with no possible self-service fix.
   */
  ADMIN_WALLETS: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().transform((s, ctx) => {
      const parts = [...new Set(s.split(',').map((p) => p.trim()).filter((p) => p !== ''))];
      for (const p of parts) {
        if (!BASE58_ADDRESS.test(p)) {
          ctx.addIssue({
            code: 'custom',
            message: `ADMIN_WALLETS entry is not a base58 Solana address: ${p}`,
          });
          return z.NEVER;
        }
      }
      return parts;
    }).optional(),
  ),
  /** Cloudflare Turnstile SERVER secret for the public invite-application form
   * (POST /alpha/apply). Unset ⇒ applications are accepted WITHOUT bot
   * verification and the server warns loudly at boot — acceptable in dev,
   * a spam magnet in production. Set ⇒ a missing/invalid token is a 4xx. */
  TURNSTILE_SECRET_KEY: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().min(1).optional(),
  ),
  /** Resend (https://resend.com) API key. BOTH this and EMAIL_FROM provide
   * email delivery for alpha invites + 2FA codes (lib/resend.ts). Profile
   * exposes email enrollment unconditionally, so production requires both. */
  RESEND_API_KEY: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().min(1).optional(),
  ),
  /** Verified Resend sender, e.g. `Pixel Kingdom Wars <invites@example.com>` or
   * a bare address. Validated for an '@' only — Resend is the authority on the
   * rest, and over-validating here would reject the display-name form. */
  EMAIL_FROM: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().refine((s) => s.includes('@'), 'EMAIL_FROM must be an email address or "Name <email>"').optional(),
  ),
  /** Rotatable TOTP/OTP root keyring. First id encrypts/signs; remaining ids are
   * read-only rotation keys. Generate a key with `openssl rand -base64 32` and
   * set `TWOFA_ENCRYPTION_KEYS=2026-08:<value>`. Never reuse JWT_SECRET. */
  TWOFA_ENCRYPTION_KEYS: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().refine(validTwofaKeyring,
      'TWOFA_ENCRYPTION_KEYS must be key-id:base64-32-byte-key[,older-id:base64-32-byte-key]').optional(),
  ),
  /** M33 Web Push (D-101). OFF by default: no sweep scheduler, /notifications/vapid
   * answers `{ publicKey: null }` and subscribe/unsubscribe answer 503
   * PUSH_DISABLED. Schema-validated like ENABLE_WORKERS so a typo fails boot. */
  PUSH_NOTIFICATIONS_ENABLED: z.enum(['true', 'false']).default('false'),
  /** D-134 native FCM. No provider initialization or scheduler while disabled. */
  FCM_NOTIFICATIONS_ENABLED: z.enum(['true', 'false']).default('false'),
  /** Operator-mounted server credential only; never JSON in env or client config. */
  FCM_SERVICE_ACCOUNT_FILE: z.preprocess(
    (v) => typeof v === 'string' && v.trim() === '' ? undefined : v,
    z.string().regex(/^\/[^\0]+$/, 'FCM_SERVICE_ACCOUNT_FILE must be an absolute file path').optional(),
  ),
  /** M34 Mine-full source gate. Separate and dark by default so applying the
   * schema cannot claim a Mine cycle before operators explicitly activate it. */
  MINE_FULL_NOTIFICATIONS_ENABLED: z.enum(['true', 'false']).default('false'),
  /** VAPID keypair + contact. Generate ONCE with `npx web-push generate-vapid-keys`
   * and never rotate casually — rotating invalidates every stored subscription
   * (the push service binds each endpoint to the public key that subscribed it). */
  VAPID_PUBLIC_KEY: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().refine((v) => validVapidKey(v, 65, true),
      'VAPID_PUBLIC_KEY must be an uncompressed P-256 public key in base64url form').optional(),
  ),
  VAPID_PRIVATE_KEY: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().refine((v) => validVapidKey(v, 32),
      'VAPID_PRIVATE_KEY must be a 32-byte private key in base64url form').optional(),
  ),
  /** `mailto:` or `https:` contact the push services may use to reach the operator. */
  VAPID_SUBJECT: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().regex(/^(mailto:.+|https:\/\/.+)$/, 'VAPID_SUBJECT must be a mailto: or https: URL').optional(),
  ),
  // ── Phase E B8: startup parsing for the existing live admission gates. ──
  PHASE_E_VEHICLES_ENABLED: z.enum(['true', 'false']).default('false'),
  PHASE_E_CHARTER_ENABLED: z.enum(['true', 'false']).default('false'),
  KEEP_EQUIPMENT_MARKET_ENABLED: z.enum(['true', 'false']).default('false'),
  // ── End Phase E B8 startup fields. ──
  // Phase E public PoR: absent pins leave the legacy response unchanged.
  MINING_TRANSPARENCY_PROGRAM_ID: emptyIsUnset(z.string().regex(BASE58_ADDRESS).optional()),
  MINING_TRANSPARENCY_DEPLOYMENT_SLOT: emptyIsUnset(z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional()),
  MINING_TRANSPARENCY_PROGRAM_DATA_SHA256: emptyIsUnset(z.string().regex(/^[0-9a-f]{64}$/).optional()),
  // Independent opt-in for claim quotes/same-wire relay; PoR pins grant no send capability.
  MINING_CLAIM_ORDERED_ENABLED: z.enum(['true','false']).default('false'),
  MINING_CLAIM_LOOKUP_TABLE: emptyIsUnset(z.string().regex(BASE58_ADDRESS).optional()),
  MINING_CLAIM_LOOKUP_TABLE_SHA256: emptyIsUnset(z.string().regex(/^[0-9a-f]{64}$/).optional()),
  MINING_CLAIM_PROGRAM_ID: emptyIsUnset(z.string().regex(BASE58_ADDRESS).optional()),
  MINING_CLAIM_DEPLOYMENT_SLOT: emptyIsUnset(z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional()),
  MINING_CLAIM_PROGRAM_DATA_SHA256: emptyIsUnset(z.string().regex(/^[0-9a-f]{64}$/).optional()),
  /** Independent historical KEEP tax quote/relay policy. Blank never borrows claim or sale authority. */
  MINING_TAX_PROGRAM_ID: emptyIsUnset(z.string().regex(BASE58_ADDRESS).optional()),
  MINING_TAX_DEPLOYMENT_SLOT: emptyIsUnset(z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional()),
  MINING_TAX_PROGRAM_DATA_SHA256: emptyIsUnset(z.string().regex(/^[0-9a-f]{64}$/).optional()),
  MINING_TAX_UPGRADE_AUTHORITY: emptyIsUnset(z.union([z.literal('none'), z.string().regex(BASE58_ADDRESS)]).optional()),
  MINING_TAX_AUCTION_MINT: emptyIsUnset(z.string().regex(BASE58_ADDRESS).optional()),
  MINING_TAX_PRIZE_OWNER: emptyIsUnset(z.string().regex(BASE58_ADDRESS).optional()),
  MINING_TAX_STATE_PROVENANCE: emptyIsUnset(z.literal('fresh-reviewed-deployment').optional()),
  // SA-1: independent default-off auctions. Undefined flags do not register routes or a crank.
  PHASE_E_SEEKER_AUCTION_ENABLED: emptyIsUnset(z.enum(['true', 'false']).optional()),
  SEEKER_AUCTION_CRANK_ENABLED: emptyIsUnset(z.enum(['true', 'false']).optional()),
  SEEKER_AUCTION_PROGRAM_ID: emptyIsUnset(z.string().regex(BASE58_ADDRESS).optional()),
  SEEKER_AUCTION_DEPLOYMENT_SLOT: emptyIsUnset(z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional()),
  SEEKER_AUCTION_PROGRAM_DATA_SHA256: emptyIsUnset(z.string().regex(/^[0-9a-f]{64}$/).optional()),
  SEEKER_AUCTION_UPGRADE_AUTHORITY: emptyIsUnset(z.union([z.literal('none'), z.string().regex(BASE58_ADDRESS)]).optional()),
  SEEKER_AUCTION_MINT: emptyIsUnset(z.string().regex(BASE58_ADDRESS).optional()),
  SEEKER_AUCTION_PRIZE_OWNER: emptyIsUnset(z.string().regex(BASE58_ADDRESS).optional()),
  SEEKER_AUCTION_STATE_PROVENANCE: emptyIsUnset(z.literal('fresh-reviewed-deployment').optional()),
  /** K-night-08: optional RPC for the Seeker auction runtime.source. Unset uses
   * SOLANA_RPC_URL. Setting it moves EVERY auction RPC use of runtime.source, not only
   * reads: the finalized reads and quotes, the player relay (auctionRoutes.ts:143
   * sendRawTransaction) and the crank worker's reads and signed sends (auctionCrank.ts:301
   * sendRawTransaction), so the endpoint must accept sendTransaction. Meant for a
   * single-node, bank-exact endpoint when a multi-node pool keeps moving or mislabelling
   * the finalized bank; same provider policy as every other RPC URL. */
  SEEKER_AUCTION_RPC_URL: emptyIsUnset(z.url().optional()),
  SEEKER_AUCTION_CRANK_PUBKEY: emptyIsUnset(z.string().regex(BASE58_ADDRESS).optional()),
  // Worker-only path. API construction never opens a keypair file.
  SEEKER_AUCTION_CRANK_KEYPAIR_FILE: emptyIsUnset(z.string().min(1).optional()),
  // Complete reviewed realm-sale policy; absent sources preserve original recovery.
  SEEKER_REALM_SALE_PROGRAM_ID: emptyIsUnset(z.string().regex(BASE58_ADDRESS).optional()),
  SEEKER_REALM_SALE_DEPLOYMENT_SLOT: emptyIsUnset(z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional()),
  SEEKER_REALM_SALE_PROGRAM_DATA_SHA256: emptyIsUnset(z.string().regex(/^[0-9a-f]{64}$/).optional()),
  SEEKER_REALM_SALE_UPGRADE_AUTHORITY: emptyIsUnset(z.union([z.literal('none'), z.string().regex(BASE58_ADDRESS)]).optional()),
  SEEKER_REALM_SALE_AUCTION_MINT: emptyIsUnset(z.string().regex(BASE58_ADDRESS).optional()),
  SEEKER_REALM_SALE_PRIZE_OWNER: emptyIsUnset(z.string().regex(BASE58_ADDRESS).optional()),
  SEEKER_REALM_SALE_DEVELOPER: emptyIsUnset(z.string().regex(BASE58_ADDRESS).optional()),
  SEEKER_REALM_SALE_ROUND: emptyIsUnset(z.string().regex(/^(0|[1-9][0-9]{0,19})$/).refine(v => /^[0-9]+$/.test(v) && BigInt(v) < 1n << 64n).optional()),
  SEEKER_REALM_SALE_POLICY_REVISION: emptyIsUnset(z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/).optional()),
  SEEKER_REALM_SALE_STATE_PROVENANCE: emptyIsUnset(z.literal('fresh-reviewed-deployment').optional()),
  // Private service LOGIN is separately provisioned; never falls back to DATABASE_URL.
  PHASE_E_SERVICE_DATABASE_URL: emptyIsUnset(z.string().url().optional()),
  // Fixed Metaplex Core identity; blank pins retain original offline history only.
  // Explicit Divine sponsor; absence mounts original history without funding authority.
  /** Clan event authority is independent of individual Divine sponsor policy. */
  CHARTER_TOURNAMENT_SPONSOR_WALLET: emptyIsUnset(z.string().regex(BASE58_ADDRESS).optional()),
  CHARTER_TOURNAMENT_TREASURY: emptyIsUnset(z.string().regex(BASE58_ADDRESS).optional()),
  DIVINE_TRIAL_SPONSOR_WALLET: emptyIsUnset(z.string().regex(BASE58_ADDRESS).optional()),
  // Client-only credential. No private policy key belongs in API configuration.
  CHARTER_POLICY_ISSUER_URL: emptyIsUnset(z.url().optional()),
  CHARTER_POLICY_ISSUER_PUBLIC_KEY: emptyIsUnset(z.string().regex(BASE58_ADDRESS).optional()),
  CHARTER_POLICY_ISSUER_AUTH_TOKEN_FILE: emptyIsUnset(z.string().startsWith('/').refine(v => !v.includes('\0')).optional()),
  CHARTER_POLICY_ISSUER_ALLOW_PRIVATE_HTTP: z.enum(['true', 'false']).default('false'),
  // Explicit new-action authority, distinct from original read-only recovery.
  CHARTER_WORKFLOW_METADATA_URI_PREFIX: emptyIsUnset(z.string().max(256).refine(value => {
    try { const u = new URL(value); return Buffer.byteLength(value) <= 256 && u.protocol === 'https:' && !u.username && !u.password; } catch { return false; }
  }).optional()),
  CHARTER_WORKFLOW_SALE_TREASURY: emptyIsUnset(z.string().regex(BASE58_ADDRESS).optional()),
  CHARTER_WORKFLOW_LOOKUP_TABLE_ADDRESS: emptyIsUnset(z.string().regex(BASE58_ADDRESS).optional()),
  CHARTER_WORKFLOW_LOOKUP_TABLE_SHA256: emptyIsUnset(z.string().regex(/^[0-9a-f]{64}$/).optional()),
  CHARTER_WORKFLOW_CORE_COST_PROFILE: emptyIsUnset(z.literal('mpl-core-0.15.2-charter-pfd-seq-none').optional()),
  CHARTER_WORKFLOW_MAX_NETWORK_FEE_LAMPORTS: emptyIsUnset(z.string().regex(/^(0|[1-9][0-9]{0,19})$/).refine(v => BigInt(v) <= 18446744073709551615n).optional()),
  CHARTER_WORKFLOW_MAX_RENT_LAMPORTS: emptyIsUnset(z.string().regex(/^(0|[1-9][0-9]{0,19})$/).refine(v => BigInt(v) <= 18446744073709551615n).optional()),
  CHARTER_WORKFLOW_MAX_TOTAL_LAMPORTS: emptyIsUnset(z.string().regex(/^(0|[1-9][0-9]{0,19})$/).refine(v => BigInt(v) <= 18446744073709551615n).optional()),
  CHARTER_WORKFLOW_MAX_ADDITIONAL_LAMPORTS: emptyIsUnset(z.string().regex(/^(0|[1-9][0-9]{0,19})$/).refine(v => BigInt(v) <= 18446744073709551615n).optional()),
  CHARTER_WORKFLOW_RELAY_RPC_URL: emptyIsUnset(z.url().optional()),
  // Independent read-only Charter recovery pins; no issuer or new-action authority.
  CHARTER_RECOVERY_ECONOMY_PROGRAM_ID: emptyIsUnset(z.string().regex(BASE58_ADDRESS).optional()),
  CHARTER_RECOVERY_ECONOMY_DEPLOYMENT_SLOT: emptyIsUnset(z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional()),
  CHARTER_RECOVERY_ECONOMY_PROGRAM_DATA_SHA256: emptyIsUnset(z.string().regex(/^[0-9a-f]{64}$/).optional()),
  CHARTER_RECOVERY_ECONOMY_UPGRADE_AUTHORITY: emptyIsUnset(z.union([z.literal('none'), z.string().regex(BASE58_ADDRESS)]).optional()),
  CHARTER_RECOVERY_CRAFT_PROGRAM_ID: emptyIsUnset(z.string().regex(BASE58_ADDRESS).optional()),
  CHARTER_RECOVERY_CRAFT_DEPLOYMENT_SLOT: emptyIsUnset(z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional()),
  CHARTER_RECOVERY_CRAFT_PROGRAM_DATA_SHA256: emptyIsUnset(z.string().regex(/^[0-9a-f]{64}$/).optional()),
  CHARTER_RECOVERY_CRAFT_UPGRADE_AUTHORITY: emptyIsUnset(z.union([z.literal('none'), z.string().regex(BASE58_ADDRESS)]).optional()),
  CHARTER_RECOVERY_CORE_DEPLOYMENT_SLOT: emptyIsUnset(z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional()),
  CHARTER_RECOVERY_CORE_PROGRAM_DATA_SHA256: emptyIsUnset(z.string().regex(/^[0-9a-f]{64}$/).optional()),
  CHARTER_RECOVERY_CORE_UPGRADE_AUTHORITY: emptyIsUnset(z.union([z.literal('none'), z.string().regex(BASE58_ADDRESS)]).optional()),
  CHARTER_RECOVERY_STATE_PROVENANCE: emptyIsUnset(z.literal('fresh-reviewed-deployment').optional()),
  /** Explicit operational payment limits; absent group leaves new KEEP quotes held. */
  KEEP_MARKET_MIN_CONTEXT_SLOT: emptyIsUnset(z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional()),
  KEEP_MARKET_TRANSACTION_VERSION: emptyIsUnset(z.enum(['legacy', '0']).optional()),
  KEEP_MARKET_MAX_FEE_LAMPORTS: emptyIsUnset(z.string().regex(/^(0|[1-9][0-9]{0,19})$/).refine(v => BigInt(v) <= 18446744073709551615n).optional()),
  KEEP_MARKET_MAX_PRIORITY_FEE_LAMPORTS: emptyIsUnset(z.string().regex(/^(0|[1-9][0-9]{0,19})$/).refine(v => BigInt(v) <= 18446744073709551615n).optional()),
  KEEP_MARKET_MAX_COMPUTE_UNIT_LIMIT: emptyIsUnset(z.coerce.number().int().positive().max(1_400_000).optional()),
  KEEP_MARKET_BROADCAST_RPC_URL: emptyIsUnset(z.url().optional()),
  VEHICLE_CORE_DEPLOYMENT_SLOT: emptyIsUnset(z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional()),
  VEHICLE_CORE_PROGRAM_DATA_SHA256: emptyIsUnset(z.string().regex(/^[0-9a-f]{64}$/).optional()),
  VEHICLE_CORE_UPGRADE_AUTHORITY: emptyIsUnset(z.union([z.literal('none'), z.string().regex(BASE58_ADDRESS)]).optional()),
}).superRefine((env, ctx) => {
  const issuerFields = [env.CHARTER_POLICY_ISSUER_URL, env.CHARTER_POLICY_ISSUER_PUBLIC_KEY, env.CHARTER_POLICY_ISSUER_AUTH_TOKEN_FILE];
  if (issuerFields.some(v => v !== undefined) || env.CHARTER_POLICY_ISSUER_ALLOW_PRIVATE_HTTP === 'true') {
    if (issuerFields.some(v => v === undefined)) ctx.addIssue({ code: 'custom', path: ['CHARTER_POLICY_ISSUER_URL'], message: 'Charter issuer requires complete dedicated client identity and token file' });
    if (env.CHARTER_POLICY_ISSUER_URL) {
      const u = new URL(env.CHARTER_POLICY_ISSUER_URL);
      if (u.username || u.password || u.search || u.hash || u.pathname !== '/' || !(u.protocol === 'https:' || u.protocol === 'http:'
          && env.CHARTER_POLICY_ISSUER_ALLOW_PRIVATE_HTTP === 'true' && (['127.0.0.1', '[::1]', 'localhost'].includes(u.hostname) || u.origin === 'http://charter-issuer:3004'))) {
        ctx.addIssue({ code: 'custom', path: ['CHARTER_POLICY_ISSUER_URL'], message: 'Charter issuer requires a dedicated HTTPS origin or explicit private HTTP opt-in' });
      }
    }
  }
  const currentCharter = [env.CHARTER_WORKFLOW_METADATA_URI_PREFIX, env.CHARTER_WORKFLOW_SALE_TREASURY,
    env.CHARTER_WORKFLOW_LOOKUP_TABLE_ADDRESS, env.CHARTER_WORKFLOW_LOOKUP_TABLE_SHA256, env.CHARTER_WORKFLOW_CORE_COST_PROFILE,
    env.CHARTER_WORKFLOW_MAX_NETWORK_FEE_LAMPORTS, env.CHARTER_WORKFLOW_MAX_RENT_LAMPORTS,
    env.CHARTER_WORKFLOW_MAX_TOTAL_LAMPORTS, env.CHARTER_WORKFLOW_MAX_ADDITIONAL_LAMPORTS];
  if (currentCharter.some(v => v !== undefined) || env.CHARTER_WORKFLOW_RELAY_RPC_URL) {
    if (currentCharter.some(v => v === undefined) || issuerFields.some(v => v === undefined) || !env.CHARTER_RECOVERY_ECONOMY_PROGRAM_ID) {
      ctx.addIssue({ code: 'custom', path: ['CHARTER_WORKFLOW_METADATA_URI_PREFIX'], message: 'New Charter actions require complete current domain, issuer, reviewed deployments, ALT, cost profile and explicit fee limits' });
    }
    if (env.CHARTER_WORKFLOW_RELAY_RPC_URL) {
      try { resolveSolanaRpcUrl(env.CHARTER_WORKFLOW_RELAY_RPC_URL, env.NODE_ENV); }
      catch { ctx.addIssue({ code: 'custom', path: ['CHARTER_WORKFLOW_RELAY_RPC_URL'], message: 'Charter relay requires an explicit allowed RPC endpoint' }); }
    }
  }
  if (env.CHARTER_TOURNAMENT_SPONSOR_WALLET || env.CHARTER_TOURNAMENT_TREASURY) {
    if (!env.CHARTER_TOURNAMENT_SPONSOR_WALLET || !env.CHARTER_TOURNAMENT_TREASURY
        || !env.CHARTER_RECOVERY_ECONOMY_PROGRAM_ID || !env.SEEKER_REALM_SALE_PROGRAM_ID) {
      ctx.addIssue({ code: 'custom', path: ['CHARTER_TOURNAMENT_SPONSOR_WALLET'], message: 'Clan event funding requires explicit sponsor/treasury, reviewed Charter domain and historical Seeker trust' });
    }
  }
  const marketLimits = [env.KEEP_MARKET_MIN_CONTEXT_SLOT, env.KEEP_MARKET_TRANSACTION_VERSION,
    env.KEEP_MARKET_MAX_FEE_LAMPORTS, env.KEEP_MARKET_MAX_PRIORITY_FEE_LAMPORTS, env.KEEP_MARKET_MAX_COMPUTE_UNIT_LIMIT];
  if (marketLimits.some(value => value !== undefined) || env.KEEP_MARKET_BROADCAST_RPC_URL) {
    if (marketLimits.some(value => value === undefined) || !env.SOLANA_RPC_URL_2
        || !env.SOLANA_RPC_PROVIDER || !env.SOLANA_RPC_PROVIDER_2
        || env.SOLANA_RPC_PROVIDER.toLowerCase() === env.SOLANA_RPC_PROVIDER_2.toLowerCase()) {
      ctx.addIssue({ code: 'custom', path: ['KEEP_MARKET_MIN_CONTEXT_SLOT'], message: 'KEEP market requires complete reviewed limits and two independent labelled RPC providers' });
    }
    if (env.KEEP_MARKET_MAX_FEE_LAMPORTS && env.KEEP_MARKET_MAX_PRIORITY_FEE_LAMPORTS
        && BigInt(env.KEEP_MARKET_MAX_PRIORITY_FEE_LAMPORTS) > BigInt(env.KEEP_MARKET_MAX_FEE_LAMPORTS)) {
      ctx.addIssue({ code: 'custom', path: ['KEEP_MARKET_MAX_PRIORITY_FEE_LAMPORTS'], message: 'Priority fee cannot exceed total fee limit' });
    }
  }
  if (env.DIVINE_TRIAL_SPONSOR_WALLET && !env.MINING_CLAIM_PROGRAM_ID) {
    ctx.addIssue({ code: 'custom', path: ['DIVINE_TRIAL_SPONSOR_WALLET'], message: 'Divine sponsor requires independent reviewed mining claim authority' });
  }
  const charterPins = [env.CHARTER_RECOVERY_ECONOMY_PROGRAM_ID, env.CHARTER_RECOVERY_ECONOMY_DEPLOYMENT_SLOT,
    env.CHARTER_RECOVERY_ECONOMY_PROGRAM_DATA_SHA256, env.CHARTER_RECOVERY_ECONOMY_UPGRADE_AUTHORITY,
    env.CHARTER_RECOVERY_CRAFT_PROGRAM_ID, env.CHARTER_RECOVERY_CRAFT_DEPLOYMENT_SLOT,
    env.CHARTER_RECOVERY_CRAFT_PROGRAM_DATA_SHA256, env.CHARTER_RECOVERY_CRAFT_UPGRADE_AUTHORITY,
    env.CHARTER_RECOVERY_CORE_DEPLOYMENT_SLOT, env.CHARTER_RECOVERY_CORE_PROGRAM_DATA_SHA256,
    env.CHARTER_RECOVERY_CORE_UPGRADE_AUTHORITY, env.CHARTER_RECOVERY_STATE_PROVENANCE];
  if (charterPins.some(value => value !== undefined) && charterPins.some(value => value === undefined)) {
    ctx.addIssue({ code: 'custom', path: ['CHARTER_RECOVERY_ECONOMY_PROGRAM_ID'], message: 'Charter recovery requires complete independently reviewed deployment trust' });
  }
  const vehiclePins = [env.VEHICLE_CORE_DEPLOYMENT_SLOT, env.VEHICLE_CORE_PROGRAM_DATA_SHA256, env.VEHICLE_CORE_UPGRADE_AUTHORITY];
  if (vehiclePins.some(value => value !== undefined) && vehiclePins.some(value => value === undefined)) {
    ctx.addIssue({ code: 'custom', path: ['VEHICLE_CORE_DEPLOYMENT_SLOT'], message: 'Vehicles require all reviewed Core pins and explicit upgrade authority or none' });
  }
  const taxPins = [env.MINING_TAX_PROGRAM_ID, env.MINING_TAX_DEPLOYMENT_SLOT, env.MINING_TAX_PROGRAM_DATA_SHA256,
    env.MINING_TAX_UPGRADE_AUTHORITY, env.MINING_TAX_AUCTION_MINT, env.MINING_TAX_PRIZE_OWNER, env.MINING_TAX_STATE_PROVENANCE];
  // Same RESERVE rule as the claim and transparency groups below: taxRuntime.ts takes the selected
  // keep-v4 RESERVE, and needs the legacy GEMS_RESERVE_OWNER only when keep-v4 is not selected.
  if (taxPins.some(value => value !== undefined) && (taxPins.some(value => value === undefined)
      || (env.PHASE_E_KEEP_IDENTITY !== 'keep-v4' && !env.GEMS_RESERVE_OWNER) || !env.HOT_WALLET_PUBKEY)) {
    ctx.addIssue({ code: 'custom', path: ['MINING_TAX_PROGRAM_ID'], message: 'Mining tax requires complete reviewed deployment, auction and reserve identity' });
  }
  const realmSalePins = [env.SEEKER_REALM_SALE_PROGRAM_ID, env.SEEKER_REALM_SALE_DEPLOYMENT_SLOT,
    env.SEEKER_REALM_SALE_PROGRAM_DATA_SHA256, env.SEEKER_REALM_SALE_UPGRADE_AUTHORITY,
    env.SEEKER_REALM_SALE_AUCTION_MINT, env.SEEKER_REALM_SALE_PRIZE_OWNER, env.SEEKER_REALM_SALE_DEVELOPER,
    env.SEEKER_REALM_SALE_ROUND, env.SEEKER_REALM_SALE_POLICY_REVISION, env.SEEKER_REALM_SALE_STATE_PROVENANCE];
  if (realmSalePins.some(v => v !== undefined) && realmSalePins.some(v => v === undefined)) {
    ctx.addIssue({ code: 'custom', path: ['SEEKER_REALM_SALE_PROGRAM_ID'], message: 'Realm sales require all reviewed policy fields, including explicit upgrade authority or none' });
  }
  const claimPins = [env.MINING_CLAIM_PROGRAM_ID, env.MINING_CLAIM_DEPLOYMENT_SLOT,
    env.MINING_CLAIM_PROGRAM_DATA_SHA256];
  if (claimPins.some(v => v !== undefined) && (claimPins.some(v => v === undefined)
      || (env.PHASE_E_KEEP_IDENTITY !== 'keep-v4' && !env.GEMS_RESERVE_OWNER) || !env.HOT_WALLET_PUBKEY)) {
    ctx.addIssue({ code: 'custom', path: ['MINING_CLAIM_PROGRAM_ID'],
      message: 'Mining claims require all reviewed claim program pins, selected RESERVE (or legacy GEMS_RESERVE_OWNER) and HOT_WALLET_PUBKEY' });
  }
  const selectedPhaseEKeep = env.PHASE_E_KEEP_IDENTITY === 'keep-v4';
  if (selectedPhaseEKeep && (env.SOLANA_CLUSTER !== 'devnet'
      || env.PHASE_E_KEEP_RESERVE_OWNER !== 'CVKo5i8ax2kiKe9nSB4LfCpBEbyfaLcq8S8bWXsvKo1Q'
      || !env.HOT_WALLET_PUBKEY)) {
    ctx.addIssue({ code: 'custom', path: ['PHASE_E_KEEP_IDENTITY'], message: 'Phase E KEEP v4 requires devnet, the named RESERVE and an explicit hot-custody identity' });
  }
  const publicationEnabled = env.MINING_PUBLICATION_RECOVERY_ENABLED === 'true' || env.MINING_PUBLICATION_JOB_ENABLED === 'true';
  if (publicationEnabled && (env.SOLANA_CLUSTER !== 'devnet' || env.MINING_PUBLICATION_TESTER_STACK !== 'true')) {
    ctx.addIssue({ code: 'custom', path: ['MINING_PUBLICATION_TESTER_STACK'], message: 'Mining publication requires an explicit devnet tester stack' });
  }
  if (publicationEnabled && (!env.PHASE_E_SERVICE_DATABASE_URL || !selectedPhaseEKeep
      || !env.PHASE_E_KEEP_RESERVE_OWNER || !env.HOT_WALLET_PUBKEY)) {
    ctx.addIssue({ code: 'custom', path: ['MINING_PUBLICATION_RECOVERY_ENABLED'], message: 'Mining publication requires a private database and selected reviewed KEEP v4 reserve identity' });
  }
  const publicationOperator = env.MINING_PUBLICATION_OPERATOR_PUBKEY, phaseEReserve = env.PHASE_E_KEEP_RESERVE_OWNER;
  if ((publicationOperator && [phaseEReserve, env.HOT_WALLET_PUBKEY, env.GEMS_RESERVE_OWNER].includes(publicationOperator))
      || (selectedPhaseEKeep && phaseEReserve && [env.HOT_WALLET_PUBKEY, env.GEMS_RESERVE_OWNER].includes(phaseEReserve))) {
    ctx.addIssue({ code: 'custom', path: ['MINING_PUBLICATION_OPERATOR_PUBKEY'], message: 'Phase E OPERATOR, RESERVE, Gems reserve and hot custody must remain distinct' });
  }
  if (env.MINING_PUBLICATION_JOB_ENABLED === 'true' && !env.MINING_PUBLICATION_OPERATOR_PUBKEY) {
    ctx.addIssue({ code: 'custom', path: ['MINING_PUBLICATION_OPERATOR_PUBKEY'], message: 'Mining publication job requires an explicit operator public key' });
  }
  const orderedPins=[env.MINING_CLAIM_LOOKUP_TABLE,env.MINING_CLAIM_LOOKUP_TABLE_SHA256];
  if ((env.MINING_CLAIM_ORDERED_ENABLED==='true'||orderedPins.some(v=>v!==undefined))&&(orderedPins.some(v=>v===undefined)||claimPins.some(v=>v===undefined))) {
    ctx.addIssue({code:'custom',path:['MINING_CLAIM_ORDERED_ENABLED'],message:'Ordered mining claims require complete independent frozen lookup table and claim program pins'});
  }
  const miningPins = [env.MINING_TRANSPARENCY_PROGRAM_ID, env.MINING_TRANSPARENCY_DEPLOYMENT_SLOT,
    env.MINING_TRANSPARENCY_PROGRAM_DATA_SHA256];
  if (miningPins.some(v => v !== undefined) && (miningPins.some(v => v === undefined)
      || (env.PHASE_E_KEEP_IDENTITY !== 'keep-v4' && !env.GEMS_RESERVE_OWNER) || !env.HOT_WALLET_PUBKEY)) {
    ctx.addIssue({ code: 'custom', path: ['MINING_TRANSPARENCY_PROGRAM_ID'],
      message: 'Mining transparency requires all reviewed program pins, selected RESERVE (or legacy GEMS_RESERVE_OWNER) and HOT_WALLET_PUBKEY' });
  }
  // D-152 nested flags (E2-GEMS-CONTRACT §4): a child 'true' with its parent off fails boot.
  for (const child of ['GEMS_WALLET_BUY_ENABLED', 'DEVNET_WELCOME_GEMS_ENABLED'] as const) {
    if (env[child] === 'true' && env.GEMS_ENABLED !== 'true') {
      ctx.addIssue({ code: 'custom', path: [child], message: `${child}=true requires GEMS_ENABLED=true` });
    }
  }
  if ((env.GEMS_WALLET_BUY_ENABLED === 'true' || env.GEMS_RESERVE_ATA) && !env.GEMS_RESERVE_OWNER) {
    ctx.addIssue({ code: 'custom', path: ['GEMS_RESERVE_OWNER'],
      message: 'wallet Gems purchases or GEMS_RESERVE_ATA require GEMS_RESERVE_OWNER' });
  }
  if (env.GEMS_RESERVE_OWNER && !env.HOT_WALLET_PUBKEY) {
    ctx.addIssue({ code: 'custom', path: ['HOT_WALLET_PUBKEY'],
      message: 'GEMS_RESERVE_OWNER requires HOT_WALLET_PUBKEY to exclude the custody ATA' });
  }
  // E2-WORKSHOP-CONTRACT §6: the ingot routes are a child of the building gate.
  if (env.STARTER_EXPEDITIONS_ENABLED === 'true' && (env.PHASE_E_BUILDINGS_ENABLED !== 'true' || env.MULTI_BASE_ENABLED !== 'true')) {
    ctx.addIssue({ code: 'custom', path: ['STARTER_EXPEDITIONS_ENABLED'],
      message: 'STARTER_EXPEDITIONS_ENABLED=true requires PHASE_E_BUILDINGS_ENABLED=true and MULTI_BASE_ENABLED=true' });
  }
  if (env.HARVESTERS_ENABLED === 'true' && (env.PHASE_E_BUILDINGS_ENABLED !== 'true' || env.MULTI_BASE_ENABLED !== 'true')) {
    ctx.addIssue({ code: 'custom', path: ['HARVESTERS_ENABLED'],
      message: 'HARVESTERS_ENABLED=true requires PHASE_E_BUILDINGS_ENABLED=true and MULTI_BASE_ENABLED=true' });
  }
  if (env.ORDINARY_CRAFTING_ENABLED === 'true' && env.PHASE_E_BUILDINGS_ENABLED !== 'true') {
    ctx.addIssue({ code: 'custom', path: ['ORDINARY_CRAFTING_ENABLED'],
      message: 'ORDINARY_CRAFTING_ENABLED=true requires PHASE_E_BUILDINGS_ENABLED=true' });
  }
  if (env.FORGE_INGOTS_ENABLED === 'true' && env.PHASE_E_BUILDINGS_ENABLED !== 'true') {
    ctx.addIssue({ code: 'custom', path: ['FORGE_INGOTS_ENABLED'],
      message: 'FORGE_INGOTS_ENABLED=true requires PHASE_E_BUILDINGS_ENABLED=true' });
  }
  // The unpinned-kit switch is a dev/QA lane only: a production host learns kits from the catalogue pin.
  if (env.REALM_KIT_PREVIEW_MANIFESTS && env.NODE_ENV === 'production') {
    ctx.addIssue({ code: 'custom', path: ['REALM_KIT_PREVIEW_MANIFESTS'], message: 'REALM_KIT_PREVIEW_MANIFESTS is refused in production' });
  }
  // The dev realm switch makes a base present a realm other than its persisted
  // address; only dev-login bases on a dev host may, so a production env naming
  // it is a misconfiguration to fail on, not a value to ignore.
  if (env.DEV_LOGIN_REALM && env.NODE_ENV === 'production') {
    ctx.addIssue({ code: 'custom', path: ['DEV_LOGIN_REALM'], message: 'DEV_LOGIN_REALM is refused in production' });
  }
  // Only DEV_LOGIN=true issues the login the switch is for; without it the value is
  // inert (devLoginRealm() returns nothing) and the owner reviewing another realm would
  // be looking at Crownlands with no signal. Fail boot, as a misspelt realm does. The
  // fantasy world is NOT required: a base without a fantasy address presents the switch
  // realm (game/baseVisual.ts), which is how the local review host runs.
  if (env.DEV_LOGIN_REALM && env.DEV_LOGIN !== 'true') {
    ctx.addIssue({ code: 'custom', path: ['DEV_LOGIN_REALM'], message: 'DEV_LOGIN_REALM requires DEV_LOGIN=true' });
  }
  if (env.FANTASY_WORLD_ENABLED === 'true' && env.MULTI_BASE_ENABLED !== 'true') {
    ctx.addIssue({ code: 'custom', path: ['FANTASY_WORLD_ENABLED'], message: 'Fantasy world requires stable multi-base ownership' });
  }
  // Native presentation on the ordinary API must never open to every player by
  // omission: enabling it requires a tester list or the explicit OPEN switch.
  if (env.NATIVE_PRESENTATION_ENABLED === 'true' && env.NATIVE_PRESENTATION_OPEN !== 'true'
      && !env.NATIVE_PRESENTATION_WALLETS?.length) {
    ctx.addIssue({ code: 'custom', path: ['NATIVE_PRESENTATION_WALLETS'],
      message: 'NATIVE_PRESENTATION_ENABLED=true requires a tester list or NATIVE_PRESENTATION_OPEN=true' });
  }
  // M45 §1: the advertised apkUrl is built from PLAY_URL ?? WEB_ORIGIN[0]. A
  // device must never be sent to a plain-http APK origin outside local dev/test.
  if (env.NATIVE_UPDATE_CHANNEL_ENABLED === 'true' && env.NODE_ENV !== 'development' && env.NODE_ENV !== 'test'
      && new URL(env.PLAY_URL ?? env.WEB_ORIGIN[0]!).protocol !== 'https:') {
    ctx.addIssue({ code: 'custom', path: ['NATIVE_UPDATE_CHANNEL_ENABLED'],
      message: 'NATIVE_UPDATE_CHANNEL_ENABLED=true requires an https PLAY_URL (or WEB_ORIGIN[0])' });
  }
  for (const key of ['SOLANA_RPC_URL', 'SOLANA_RPC_URL_2', 'MINT_EVIDENCE_RPC_URL', 'SOLANA_MAINNET_RPC_URL', 'SOLANA_MAINNET_RPC_URL_2', 'KEEP_MARKET_BROADCAST_RPC_URL', 'SEEKER_AUCTION_RPC_URL'] as const) {
    if (!env[key]) continue;
    try { resolveSolanaRpcUrl(env[key], env.NODE_ENV); }
    catch (error) { ctx.addIssue({ code: 'custom', path: [key], message: (error as Error).message }); }
  }

  if (env.SOCIAL_TOKEN_LOGIN_ENABLED === 'true' && (!env.PRIVY_APP_ID || !env.PRIVY_JWKS_URL)) {
    ctx.addIssue({ code: 'custom', path: ['SOCIAL_TOKEN_LOGIN_ENABLED'],
      message: 'token login requires PRIVY_APP_ID and PRIVY_JWKS_URL' });
  }

  // Enabling push with a half-configured VAPID identity would let the sweep
  // claim push_events rows (at-most-once) and then fail every send, silently
  // burning each notification. Refuse to boot instead, like the Resend pair.
  if (env.PUSH_NOTIFICATIONS_ENABLED === 'true'
      && (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !env.VAPID_SUBJECT)) {
    ctx.addIssue({
      code: 'custom', path: ['PUSH_NOTIFICATIONS_ENABLED'],
      message: 'PUSH_NOTIFICATIONS_ENABLED=true requires ALL of VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT',
    });
  } else if (env.PUSH_NOTIFICATIONS_ENABLED === 'true'
      && !validVapidPair(env.VAPID_PUBLIC_KEY!, env.VAPID_PRIVATE_KEY!)) {
    ctx.addIssue({
      code: 'custom', path: ['VAPID_PRIVATE_KEY'],
      message: 'VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY must be one matching P-256 pair',
    });
  }
  if (env.FCM_NOTIFICATIONS_ENABLED === 'true' && !env.FCM_SERVICE_ACCOUNT_FILE) {
    ctx.addIssue({ code: 'custom', path: ['FCM_SERVICE_ACCOUNT_FILE'],
      message: 'FCM_NOTIFICATIONS_ENABLED=true requires FCM_SERVICE_ACCOUNT_FILE' });
  }
  if (env.MINE_FULL_NOTIFICATIONS_ENABLED === 'true'
      && env.PUSH_NOTIFICATIONS_ENABLED !== 'true' && env.FCM_NOTIFICATIONS_ENABLED !== 'true') {
    ctx.addIssue({
      code: 'custom', path: ['MINE_FULL_NOTIFICATIONS_ENABLED'],
      message: 'MINE_FULL_NOTIFICATIONS_ENABLED=true requires PUSH_NOTIFICATIONS_ENABLED=true or FCM_NOTIFICATIONS_ENABLED=true',
    });
  }
  if (env.SOLANA_CLUSTER !== 'devnet' && env.DEVNET_FAUCET_ENABLED === 'true') {
    ctx.addIssue({
      code: 'custom', path: ['DEVNET_FAUCET_ENABLED'],
      message: 'the in-game SOL faucet is a devnet playtest convenience and must be off on every other cluster',
    });
  }
  if (env.SOLANA_CLUSTER !== 'devnet'
      && (env.DEVNET_SKR_FAUCET_ENABLED !== undefined || env.DEVNET_SKR_FAUCET_KEYPAIR_PATH !== undefined
        || env.DEVNET_SKR_FAUCET_AUTHORITY !== undefined || env.DEVNET_SKR_FAUCET_ADMIN_PUBKEY !== undefined
        || env.DEVNET_SKR_FAUCET_SOL_FAUCET_PUBKEY !== undefined || env.DEVNET_SKR_FAUCET_DEED_OPERATIONS_PUBKEY !== undefined
        || env.DEVNET_SKR_FAUCET_DEEDLESS_OK !== undefined)) {
    ctx.addIssue({ code: 'custom', path: ['DEVNET_SKR_FAUCET_ENABLED'],
      message: 'every devnet SKR faucet setting must be absent outside devnet' });
  }
  // N-045: the deedless-claim switch belongs to the QA chain lane (its harness validates with NODE_ENV=development);
  // a production host keeps D153.290, so naming the switch there at all fails boot.
  if (env.DEVNET_SKR_FAUCET_DEEDLESS_OK !== undefined && env.NODE_ENV === 'production') {
    ctx.addIssue({ code: 'custom', path: ['DEVNET_SKR_FAUCET_DEEDLESS_OK'],
      message: 'DEVNET_SKR_FAUCET_DEEDLESS_OK is refused in production (D153.290: a deedless player cannot claim)' });
  }
  if (env.DEVNET_SKR_FAUCET_ENABLED === 'true') {
    if (!env.DEVNET_SKR_FAUCET_AUTHORITY) ctx.addIssue({ code: 'custom', path: ['DEVNET_SKR_FAUCET_AUTHORITY'],
      message: 'the enabled faucet requires its public authority' });
    const faucetPath = env.DEVNET_SKR_FAUCET_KEYPAIR_PATH;
    if (!faucetPath?.trim() || [env.ADMIN_KEYPAIR_PATH, env.HOT_WALLET_KEYPAIR_PATH, env.DEVNET_FAUCET_KEYPAIR_PATH]
      .some((other) => !!other?.trim() && resolvePath(other) === resolvePath(faucetPath))) {
      ctx.addIssue({ code: 'custom', path: ['DEVNET_SKR_FAUCET_KEYPAIR_PATH'],
        message: 'the enabled devnet SKR faucet requires a dedicated authority keypair path' });
    }
  }
  if (env.WITHDRAWAL_SIGNER_MODE === 'remote') {
    for (const [field, value] of [
      ['WITHDRAWAL_POLICY_SIGNER_URL', env.WITHDRAWAL_POLICY_SIGNER_URL],
      ['WITHDRAWAL_POLICY_SIGNER_AUTH_TOKEN_FILE', env.WITHDRAWAL_POLICY_SIGNER_AUTH_TOKEN_FILE],
      ['WITHDRAWAL_POLICY_KEEP_MINT', env.WITHDRAWAL_POLICY_KEEP_MINT],
      ['WITHDRAWAL_POLICY_MAX_PER_TRANSFER_KEEP', env.WITHDRAWAL_POLICY_MAX_PER_TRANSFER_KEEP],
      ['WITHDRAWAL_POLICY_MAX_PER_WALLET_24H_KEEP', env.WITHDRAWAL_POLICY_MAX_PER_WALLET_24H_KEEP],
      ['WITHDRAWAL_POLICY_MAX_AGGREGATE_24H_KEEP', env.WITHDRAWAL_POLICY_MAX_AGGREGATE_24H_KEEP],
    ] as const) {
      if (!value) ctx.addIssue({ code: 'custom', path: [field], message: `remote signer requires ${field}` });
    }
    if (env.WITHDRAWAL_POLICY_SIGNER_URL) {
      try {
        assertSafeWithdrawalPolicySignerEndpoint(
          env.WITHDRAWAL_POLICY_SIGNER_URL,
          env.WITHDRAWAL_POLICY_SIGNER_ALLOW_PRIVATE_HTTP,
        );
      } catch (error) {
        ctx.addIssue({
          code: 'custom', path: ['WITHDRAWAL_POLICY_SIGNER_URL'],
          message: error instanceof Error ? error.message : 'policy signer URL is invalid',
        });
      }
    }
    const limits = [
      env.WITHDRAWAL_POLICY_MAX_PER_TRANSFER_KEEP,
      env.WITHDRAWAL_POLICY_MAX_PER_WALLET_24H_KEEP,
      env.WITHDRAWAL_POLICY_MAX_AGGREGATE_24H_KEEP,
    ];
    if (limits.every((value): value is string => Boolean(value))) {
      const [transfer, wallet, aggregate] = limits.map(BigInt);
      if (transfer! > wallet! || wallet! > aggregate!) {
        ctx.addIssue({
          code: 'custom', path: ['WITHDRAWAL_POLICY_MAX_AGGREGATE_24H_KEEP'],
          message: 'policy signer limits must satisfy transfer <= wallet <= aggregate',
        });
      }
    }
  }
  if (env.SOLANA_CLUSTER === 'mainnet-beta') {
    if (env.WITHDRAWAL_POLICY_CUSTODY_BACKEND === 'file') {
      ctx.addIssue({
        code: 'custom', path: ['WITHDRAWAL_POLICY_CUSTODY_BACKEND'],
        message: 'mainnet-beta forbids file-backed withdrawal custody; no reviewed HSM or enclave backend is implemented',
      });
    }
    if (env.WITHDRAWAL_SIGNER_MODE !== 'remote') {
      ctx.addIssue({
        code: 'custom', path: ['WITHDRAWAL_SIGNER_MODE'],
        message: 'mainnet-beta requires the independent remote withdrawal policy signer',
      });
    }
    if (!env.SOLANA_RPC_URL_2) {
      ctx.addIssue({
        code: 'custom', path: ['SOLANA_RPC_URL_2'],
        message: 'mainnet-beta requires a second independent economy RPC',
      });
    } else if (new URL(env.SOLANA_RPC_URL).hostname.toLowerCase()
      === new URL(env.SOLANA_RPC_URL_2).hostname.toLowerCase()) {
      ctx.addIssue({
        code: 'custom', path: ['SOLANA_RPC_URL_2'],
        message: 'mainnet-beta RPC redundancy requires different provider hosts',
      });
    }
    if (!env.SOLANA_RPC_PROVIDER || !env.SOLANA_RPC_PROVIDER_2) {
      ctx.addIssue({
        code: 'custom', path: ['SOLANA_RPC_PROVIDER_2'],
        message: 'mainnet-beta requires two explicit RPC vendor labels',
      });
    } else if (env.SOLANA_RPC_PROVIDER.toLowerCase() === env.SOLANA_RPC_PROVIDER_2.toLowerCase()) {
      ctx.addIssue({
        code: 'custom', path: ['SOLANA_RPC_PROVIDER_2'],
        message: 'mainnet-beta requires RPC endpoints from different vendors',
      });
    }
    if (env.MAINNET_COMMUNITY_KEEP_MAIL_ENABLED === 'true'
      && (!env.MAINNET_COMMUNITY_KEEP_MAIL_CAMPAIGN_ID || !env.MAINNET_COMMUNITY_KEEP_MAIL_BUDGET)) {
      ctx.addIssue({
        code: 'custom', path: ['MAINNET_COMMUNITY_KEEP_MAIL_CAMPAIGN_ID'],
        message: 'enabled mainnet KEEP mail requires campaign id and cumulative budget',
      });
    }
  }
  // A production process may never create/read 2FA state without its dedicated
  // key. Dev/test remain explicit at the operation boundary and can inject a
  // stable test key without weakening production boot.
  if (env.NODE_ENV === 'production' && !env.TWOFA_ENCRYPTION_KEYS) {
    ctx.addIssue({ code: 'custom', path: ['TWOFA_ENCRYPTION_KEYS'], message: 'required in production' });
  }
  // Email enrollment is an unconditional Profile capability, not a feature
  // flag. A missing or half-configured sender would advertise an unusable
  // security factor, so production refuses to boot without the complete pair.
  if (env.NODE_ENV === 'production' && (!env.RESEND_API_KEY || !env.EMAIL_FROM)) {
    ctx.addIssue({
      code: 'custom', path: ['RESEND_API_KEY'],
      message: 'production requires BOTH RESEND_API_KEY and EMAIL_FROM',
    });
  }
  // ── Phase E B8: match the live readers; paused receipt recovery is unchanged. ──
  if (env.PHASE_E_VEHICLES_ENABLED === 'true' && (env.MULTI_BASE_ENABLED !== 'true' || env.PHASE_E_BUILDINGS_ENABLED !== 'true')) {
    ctx.addIssue({ code: 'custom', path: ['PHASE_E_VEHICLES_ENABLED'],
      message: 'PHASE_E_VEHICLES_ENABLED=true requires MULTI_BASE_ENABLED=true and PHASE_E_BUILDINGS_ENABLED=true' });
  }
  if (env.PHASE_E_CHARTER_ENABLED === 'true' && env.MULTI_BASE_ENABLED !== 'true') {
    ctx.addIssue({ code: 'custom', path: ['PHASE_E_CHARTER_ENABLED'],
      message: 'PHASE_E_CHARTER_ENABLED=true requires MULTI_BASE_ENABLED=true' });
  }
  if (env.KEEP_EQUIPMENT_MARKET_ENABLED === 'true' && env.MULTI_BASE_ENABLED !== 'true') {
    ctx.addIssue({ code: 'custom', path: ['KEEP_EQUIPMENT_MARKET_ENABLED'],
      message: 'KEEP_EQUIPMENT_MARKET_ENABLED=true requires MULTI_BASE_ENABLED=true' });
  }
  // ── End Phase E B8 startup prerequisites. ──
});

export type Config = z.infer<typeof EnvSchema>;

/** Reuse field validators without unrelated money/email/signer boot requirements.
 * The normal API's cross-field security validation remains unchanged. */
const NativeServiceSchema = z.object(EnvSchema.shape).pick({
  DATABASE_URL: true, JWT_SECRET: true, REDIS_URL: true, NODE_ENV: true, HOST: true, PORT: true,
  RATE_LIMIT_MAX: true, RATE_LIMIT_WINDOW_MS: true, ALPHA_WALLETS: true, ADMIN_WALLETS: true, PLAYTEST_OPEN: true,
  MULTI_BASE_ENABLED: true, NATIVE_PRESENTATION_ENABLED: true, NATIVE_PRESENTATION_WALLETS: true,
  NATIVE_PRESENTATION_OPEN: true, NATIVE_PRESENTATION_WORKERS: true, NATIVE_PRESENTATION_MAX_RAIDS: true,
  NATIVE_PRESENTATION_MAX_STREAMS: true, NATIVE_PRESENTATION_CACHE_MIB: true,
  NATIVE_MIN_VERSION_CODE: true, NATIVE_CONTENT_MANIFEST_URL: true, NATIVE_CONTENT_MANIFEST_URL_LEGACY: true,
}).extend({
  NATIVE_PRESENTATION_SERVICE: z.literal('true'),
  NATIVE_DB_POOL_MAX: z.coerce.number().int().min(1).max(2).default(2),
  NATIVE_PRESENTATION_WORKERS: z.coerce.number().int().min(1).max(1).default(1),
}).superRefine((config, ctx) => {
  if (config.NATIVE_PRESENTATION_ENABLED === 'true' && !config.NATIVE_PRESENTATION_WALLETS?.length) {
    ctx.addIssue({ code: 'custom', path: ['NATIVE_PRESENTATION_WALLETS'], message: 'enabled companion requires an explicit tester list' });
  }
  if (config.NATIVE_PRESENTATION_OPEN === 'true') {
    ctx.addIssue({ code: 'custom', path: ['NATIVE_PRESENTATION_OPEN'], message: 'the isolated companion never admits the public' });
  }
});

export type NativeServiceConfig = z.infer<typeof NativeServiceSchema>;

export function loadNativeServiceConfig(env: NodeJS.ProcessEnv = process.env): NativeServiceConfig {
  const parsed = NativeServiceSchema.safeParse(env);
  if (!parsed.success) throw new Error(`Invalid native service configuration: ${parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')}`);
  return parsed.data;
}

/**
 * Is free onboarding ON? Read from the LIVE env rather than threaded through a
 * Config, for the same reason FORGE_ENABLED is (game/routes.ts): the flag is
 * consumed at route-REGISTRATION time, which does not hold a Config. The schema
 * above still validates it at boot, so this can only ever see 'true', 'false' or
 * undefined.
 *
 * ONE reader for the whole flip, and now exactly ONE call site (game/routes.ts):
 * the route table IS the flip. Base creation deliberately does not read the flag —
 * it hangs off `GET /base`, which is in the FREE group when the flag is on and in
 * the OWNED group when it is off, so "who may build" and "when a base appears"
 * cannot disagree (F3: it must also stay behind the closed-alpha gate, which only
 * an authenticated route can do).
 */
export function freeOnboardingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['FREE_ONBOARDING'] === 'true';
}

export function multiBaseEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['MULTI_BASE_ENABLED'] === 'true';
}

export function fantasyWorldEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['FANTASY_WORLD_ENABLED'] === 'true';
}

/** Catalogue-only rollout, read live like the other game-route gates above. */
export function phaseECatalogEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['PHASE_E_CATALOG_ENABLED'] === 'true';
}

/** D-152 Gems: read live like the other game-route gates (E2-GEMS-CONTRACT §4). */
export function gemsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['GEMS_ENABLED'] === 'true';
}
export function gemsWalletBuyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return gemsEnabled(env) && env['GEMS_WALLET_BUY_ENABLED'] === 'true';
}
/** Devnet-only welcome Gems: the cluster gate is the same one base.ts uses for the welcome KEEP mail. */
export function devnetWelcomeGemsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return gemsEnabled(env) && env['DEVNET_WELCOME_GEMS_ENABLED'] === 'true'
    && (env['SOLANA_CLUSTER'] ?? 'devnet') === 'devnet';
}

/** D-152 §5 dark buildings: read live like the other game-route gates (E2-WORKSHOP-CONTRACT §6). */
export function phaseEBuildingsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['PHASE_E_BUILDINGS_ENABLED'] === 'true';
}
/** Presentation permission only; never enables building or money game rules. */
export function phaseEArtEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['PHASE_E_ART_ENABLED'] === 'true';
}
/** Ordinary conversion starts require stable bases and both default-off flags. */
export function ordinaryCraftingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return multiBaseEnabled(env) && phaseEBuildingsEnabled(env) && env['ORDINARY_CRAFTING_ENABLED'] === 'true';
}

/** Free starter admissions require stable bases and both default-off flags. */
export function starterExpeditionsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return multiBaseEnabled(env) && phaseEBuildingsEnabled(env) && env['STARTER_EXPEDITIONS_ENABLED'] === 'true';
}

/** New Harvester consent requires both parents; historical earning is independent. */
export function harvestersEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return multiBaseEnabled(env) && phaseEBuildingsEnabled(env) && env['HARVESTERS_ENABLED'] === 'true';
}

/** Forge Ingot refining requires its building parent and refining child. */
export function forgeIngotsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return phaseEBuildingsEnabled(env) && env['FORGE_INGOTS_ENABLED'] === 'true';
}

/** The dev realm switch (DEV_LOGIN_REALM above): the realm the dev-login base
 * presents, or undefined when unset, off a dev host (DEV_LOGIN must be 'true',
 * NODE_ENV must not be production — the same double gate as /auth/dev-login).
 * Live-env read like the flags above so a test can flip it between logins; an
 * unknown id throws here as well as at boot, as REALM_KIT_PREVIEW_REALMS does. */
export function devLoginRealm(env: NodeJS.ProcessEnv = process.env): RealmId | undefined {
  const raw = env['DEV_LOGIN_REALM']?.trim();
  if (!raw || env['NODE_ENV'] === 'production' || env['DEV_LOGIN'] !== 'true') return undefined;
  if (!isRealmId(raw)) throw new Error(`DEV_LOGIN_REALM names an unknown realm: ${raw}`);
  return raw;
}

/** M23 a17: clan growth (create/join) is refused while clans are COMING SOON;
 * reads/leave/kick/chest settle deliberately ignore this so existing paid
 * clans are preserved and never locked in. Live-env read like the flags above. */
export function clansEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['CLANS_ENABLED'] === 'true';
}

/** D-059 (owner 2026-08-16): gear combat is ON unless explicitly rolled back
 * with HERO_GEAR_COMBAT_ENABLED=false — the default flipped together with the
 * EnvSchema literal above so an unset env and a parsed Config agree. Live-env
 * read like the flags above. */
export function heroGearCombatEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['HERO_GEAR_COMBAT_ENABLED'] !== 'false';
}

/**
 * May a deed's metadata name the parcel's real-world COUNTRY and its Earth tile?
 * (EARTH-TILES-PLAN P6 — the owner's Q3 decision, reversing the recommendation.)
 *
 * ONE reader, for the same reason the two above are one. It is read INSIDE
 * `buildDeedMetadata` from the live env rather than threaded down from a Config,
 * because that builder has three callers — GET /deed/:wallet.json,
 * GET /deed/asset/:assetId.json and the R2 sweep — and a flag passed through three
 * call sites is a flag one of them forgets. Two of those callers publishing
 * different documents to the same address is precisely the class of bug the
 * asset-keyed scheme was introduced to end.
 */
export function deedLocationV2Enabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['DEED_LOCATION_V2'] === 'true';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }
  return parsed.data;
}

/** New mining admissions pause live; historical custody recovery ignores this. */
export function phaseEMiningEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['PHASE_E_MINING_ENABLED'] === 'true';
}

/** Phase E B4: read the admission gate live; original receipts remain recoverable. */
export function phaseESeekerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['PHASE_E_SEEKER_ENABLED'] === 'true';
}

// ── Phase E vehicles: D-153.131, new admission only; saved intent survives pause. ──
export function phaseEVehiclesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return multiBaseEnabled(env) && phaseEBuildingsEnabled(env) && env['PHASE_E_VEHICLES_ENABLED'] === 'true';
}
// ── End Phase E vehicles. ──

// ── Phase E Charter: D-153.146, enrollment only; captured history survives pause. ──
export function phaseECharterEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return multiBaseEnabled(env) && env['PHASE_E_CHARTER_ENABLED'] === 'true';
}
// ── End Phase E Charter. ──

// ── Phase E KEEP equipment market: D153.190; saved recovery ignores pauses. ──
export function keepEquipmentMarketEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return multiBaseEnabled(env) && env['KEEP_EQUIPMENT_MARKET_ENABLED'] === 'true';
}
// ── End Phase E KEEP equipment market. ──
