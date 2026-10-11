/**
 * Solana Mobile **Seeker Genesis Token** (SGT) verification — SERVER ONLY.
 *
 * The SGT is the anti-sybil half of Seeker identity: one physical device, one
 * token, one game account. It lives on **mainnet-beta** while the SHARDKEEP
 * economy runs on devnet, so this module takes its own read-only RPC URL and
 * never shares the devnet `Connection` used by the money paths.
 *
 * A client claim ("I am a Seeker") is NEVER trusted — the badge is granted only
 * by these reads, and only after the wallet has proven ownership by signature
 * (apps/api/src/auth/seeker.ts).
 *
 * Why raw JSON-RPC instead of `@solana/web3.js`: two `jsonParsed` reads is the
 * whole job (no gPA, no getProgramAccounts scan), and a plain `fetch` is
 * trivially injectable, which is what makes the look-alike-mint rejection
 * testable without a live validator.
 *
 * THE PREDICATE (SEEKER.sgt in @shardkeep/shared, all verified live 2026-07-29):
 * a mint is an SGT iff ALL of
 *   1. it is owned by the Token-2022 program,
 *   2. decimals === 0 and supply === 1 (a real NFT, not a fungible look-alike),
 *   3. mintAuthority === SEEKER.sgt.mintAuthority,
 *   4. extensions.metadataPointer.authority === SEEKER.sgt.metadataAuthority,
 *   5. extensions.metadataPointer.metadataAddress === SEEKER.sgt.metadataAddress,
 *   6. extensions.tokenGroupMember.group === SEEKER.sgt.group.
 * Any ONE of 3–6 is forgeable alone (anyone may mint a Token-2022 NFT and point
 * its metadataPointer at Solana Mobile's metadata account); the conjunction is
 * not, because mintAuthority and the token-group membership are written by
 * Solana Mobile's issuer.
 *
 * TWO INDEPENDENT SOURCES (2026-07-29 review, finding (a)). The predicate above
 * is only as good as the bytes it is fed, and those bytes come from an
 * unauthenticated third-party RPC. One lying (or stale, or hijacked) endpoint
 * used to be enough to mint a badge. So a second endpoint is read in parallel
 * and the two must AGREE on the mint before the verdict counts as confirmed:
 *   - agree            → confirmed verdict (sources: 2)
 *   - disagree         → SeekerSourceConflictError; NO badge, no revocation
 *   - one configured   → verdict stands but `confirmed: false`, and the API says
 *                        so — degrade honestly rather than imply certainty
 *   - one unreachable  → same honest degrade (an outage on the cross-check must
 *                        not lock everyone out of linking)
 * Cost stays bounded: at most 2 × (1 + ceil(candidates / mintBatchSize)) calls,
 * all sharing ONE wall-clock budget.
 */
import { SEEKER } from '@shardkeep/shared';

/** A verified SGT holding. `memberNumber` is display-only ("SEEKER #76095"). */
export interface SgtHolding {
  /** The SGT mint address — the anti-sybil key (UNIQUE in seeker_links). */
  mint: string;
  memberNumber: number | null;
}

/**
 * Transport/config failure. Distinct from "this wallet holds no SGT" (null) so
 * callers FAIL CLOSED — a mainnet outage must never look like a revocation, and
 * must never be answered as a badge grant either.
 */
export class SeekerRpcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeekerRpcError';
  }
}

/**
 * The two independent sources returned DIFFERENT verdicts for the same wallet.
 *
 * Extends SeekerRpcError on purpose: every caller already fails closed on that
 * type, and "we cannot say" is exactly the right answer here — one of the two
 * endpoints is wrong and we do not know which, so we neither grant a badge nor
 * revoke one.
 */
export class SeekerSourceConflictError extends SeekerRpcError {
  constructor(message: string) {
    super(message);
    this.name = 'SeekerSourceConflictError';
  }
}

/** Outcome of one verification, with the evidence behind it. */
export interface SgtVerification {
  /** The holding, or null when the sources agree the wallet holds no SGT. */
  holding: SgtHolding | null;
  /** Independent endpoints that produced this verdict (1 or 2). */
  sources: number;
  /** True only when TWO independent sources agreed. `false` ⇒ single-source. */
  confirmed: boolean;
}

// --- jsonParsed shapes (only the fields the predicate reads) ----------------

interface ParsedTokenAccount {
  account?: {
    data?: { parsed?: { info?: { mint?: string; tokenAmount?: { amount?: string; decimals?: number } } } };
  };
}

interface ParsedMintExtension {
  extension?: string;
  state?: {
    authority?: string | null;
    metadataAddress?: string | null;
    group?: string | null;
    memberNumber?: number | null;
  };
}

/** The `getAccountInfo(mint, jsonParsed)` value, as far as the predicate cares. */
export interface ParsedMintAccount {
  /** Owning PROGRAM of the mint account — must be Token-2022. */
  owner?: string;
  data?: {
    parsed?: {
      type?: string;
      info?: {
        decimals?: number;
        supply?: string;
        mintAuthority?: string | null;
        extensions?: ParsedMintExtension[];
      };
    };
  };
}

function extensionState(info: ParsedMintAccount, name: string): ParsedMintExtension['state'] | undefined {
  return info.data?.parsed?.info?.extensions?.find((e) => e.extension === name)?.state;
}

/**
 * PURE four-way predicate over one `jsonParsed` mint account.
 * Exported so the rejection cases (wrong authority / wrong group / legacy SPL
 * token / supply > 1) are unit-testable with no network.
 *
 * Returns the holding on a pass, `null` on any failure — never throws, so one
 * malformed candidate mint in a wallet can't deny the whole check.
 */
export function checkSgtMint(mint: string, account: ParsedMintAccount | null | undefined): SgtHolding | null {
  if (!account) return null;
  // 1. Token-2022 only. A legacy SPL-Token mint has no extensions at all, so
  //    without this an attacker could not forge one — but a *future* extension
  //    lookalike under another program could, and being explicit is free.
  if (account.owner !== SEEKER.sgt.tokenProgram) return null;
  const info = account.data?.parsed?.info;
  if (!info || account.data?.parsed?.type !== 'mint') return null;
  // 2. A real 1-of-1. A decimals>0 or supply>1 mint is a fungible token dressed
  //    up as a badge; it would also let ONE mint "prove" many holders at once.
  if (info.decimals !== 0) return null;
  if (String(info.supply) !== '1') return null;
  // 3. Issuer.
  if (info.mintAuthority !== SEEKER.sgt.mintAuthority) return null;
  // 4/5. Metadata pointer — both halves.
  const mp = extensionState(account, 'metadataPointer');
  if (!mp || mp.authority !== SEEKER.sgt.metadataAuthority) return null;
  if (mp.metadataAddress !== SEEKER.sgt.metadataAddress) return null;
  // 6. Token-group membership.
  const gm = extensionState(account, 'tokenGroupMember');
  if (!gm || gm.group !== SEEKER.sgt.group) return null;

  const n = gm.memberNumber;
  return { mint, memberNumber: typeof n === 'number' && Number.isFinite(n) ? n : null };
}

/**
 * One JSON-RPC call, inside the caller's TOTAL time budget.
 *
 * The budget is shared across every call of one verification (not per call):
 * mainnet is a third party we do not control and this runs inside a request, so
 * the only bound that matters is how long the WHOLE check can take. An expired
 * budget is a transport failure — SeekerRpcError, so callers still fail closed.
 */
async function rpc<T>(
  rpcUrl: string, doFetch: typeof fetch, method: string, params: unknown[], deadline: number,
): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new SeekerRpcError(`mainnet RPC budget exhausted before ${method}`);
  let res: Response;
  try {
    res = await doFetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(remaining),
    });
  } catch (e) {
    throw new SeekerRpcError(`mainnet RPC unreachable (${method}): ${String(e)}`);
  }
  if (!res.ok) throw new SeekerRpcError(`mainnet RPC ${method} failed: HTTP ${res.status}`);
  const body = (await res.json()) as { result?: T; error?: { message?: string } };
  if (body.error) throw new SeekerRpcError(`mainnet RPC ${method} failed: ${body.error.message ?? 'error'}`);
  if (body.result === undefined) throw new SeekerRpcError(`mainnet RPC ${method} returned no result`);
  return body.result;
}

/**
 * Assert that `rpcUrl` really is mainnet-beta, by its genesis hash.
 *
 * Called once at boot (apps/api/src/server.ts). Nothing else in the config
 * distinguishes clusters: point SOLANA_MAINNET_RPC_URL at devnet and every SGT
 * check silently answers "no badge" — and on a cluster where an attacker can
 * create accounts under the authorities the predicate trusts, it answers "yes"
 * for a forgery (security review F8). Cheap: one call, no accounts read.
 *
 * @throws {Error} — plain — when the cluster is WRONG. That is a
 *   misconfiguration, not an outage: the caller must refuse to boot.
 * @throws {SeekerRpcError} when the endpoint is unreachable, so a caller can
 *   tell "can't confirm right now" from "confirmed wrong" and keep booting.
 */
export async function assertMainnetCluster(opts: {
  rpcUrl: string;
  fetchImpl?: typeof fetch | undefined;
}): Promise<void> {
  const genesis = await rpc<string>(
    opts.rpcUrl, opts.fetchImpl ?? fetch, 'getGenesisHash', [],
    Date.now() + SEEKER.rpcTimeoutMs,
  );
  if (genesis !== SEEKER.mainnetGenesisHash) {
    // Names the host: this now runs for the cross-check endpoint too, and "which
    // of the two is wrong" is the whole question when it fires.
    throw new Error(
      `${host(opts.rpcUrl)} is not mainnet-beta: genesis ${genesis} != ${SEEKER.mainnetGenesisHash}. `
      + 'Seeker verification would be meaningless against this cluster.',
    );
  }
}

/**
 * Does `owner` hold an SGT according to ONE endpoint? (Half of a verification.)
 *
 * The server-side filter is `getTokenAccountsByOwner` scoped to the Token-2022
 * program — the SGT can live nowhere else — so the wallet's SPL-Token, Core and
 * cNFT clutter never reaches us. What remains is filtered to 1-of-1s and read in
 * BATCHES: the cost is one call per `mintBatchSize` candidates, which is what
 * lets the cap sit at a real wallet size instead of at 12.
 */
async function readSgtFrom(
  rpcUrl: string, doFetch: typeof fetch, owner: string, deadline: number,
  expectedMint?: string,
): Promise<SgtHolding | null> {
  // One cheap indexed read — NOT getProgramAccounts (the public endpoint 429s
  // hard on gPA, and a rate-limited badge check is a broken badge check).
  const accounts = await rpc<{ value?: ParsedTokenAccount[] }>(
    rpcUrl, doFetch, 'getTokenAccountsByOwner',
    [owner, { programId: SEEKER.sgt.tokenProgram }, { encoding: 'jsonParsed' }],
    deadline,
  );

  const candidates: string[] = [];
  for (const a of accounts.value ?? []) {
    const info = a.account?.data?.parsed?.info;
    const amt = info?.tokenAmount;
    // Held, indivisible, exactly one — everything else can't be an SGT the
    // wallet currently owns.
    if (info?.mint && amt?.decimals === 0 && amt.amount === '1') candidates.push(info.mint);
    // Still capped — a wallet stuffed with 1-of-1s must not cost us unbounded
    // work (security review F4) — but the cap is now on the CANDIDATE LIST and
    // sits far above any real wallet, so a genuine Seeker is never missed.
    if (candidates.length >= SEEKER.maxCandidateMints) break;
  }

  // A wallet MAY hold several SGTs (they are freely sellable), and this
  // function returns the FIRST candidate that passes the predicate — in token-
  // account order, which the caller does not control. For a RE-CHECK that is a
  // trap: the linked mint losing the enumeration race to a second SGT read as
  // "the token moved" and revoked a perfectly valid link. When the caller names
  // the mint it is asking about, answer about THAT one first.
  if (expectedMint) {
    const i = candidates.indexOf(expectedMint);
    if (i > 0) {
      candidates.splice(i, 1);
      candidates.unshift(expectedMint);
    }
  }

  for (let i = 0; i < candidates.length; i += SEEKER.mintBatchSize) {
    const batch = candidates.slice(i, i + SEEKER.mintBatchSize);
    const res = await rpc<{ value?: (ParsedMintAccount | null)[] }>(
      rpcUrl, doFetch, 'getMultipleAccounts', [batch, { encoding: 'jsonParsed' }], deadline,
    );
    const values = res.value ?? [];
    for (let j = 0; j < batch.length; j += 1) {
      const hit = checkSgtMint(batch[j]!, values[j]);
      if (hit) return hit;
    }
  }
  return null;
}

function host(u: string): string {
  try {
    return new URL(u).host.toLowerCase();
  } catch {
    return u.toLowerCase();
  }
}

/**
 * How many INDEPENDENT mainnet sources this configuration provides (0, 1 or 2).
 *
 * Compared by hostname: the same provider twice — differing only by api-key
 * query string or path — is one source, not two, and must not be reported as a
 * cross-check. The API renders this so a single-source deployment says so.
 */
export function independentSourceCount(
  primary?: string | undefined, secondary?: string | undefined,
): number {
  if (!primary) return 0;
  return secondary && host(secondary) !== host(primary) ? 2 : 1;
}

/**
 * Does `owner` hold a Seeker Genesis Token on mainnet?
 *
 * Reads every configured source in PARALLEL under one shared budget and returns
 * the agreed verdict plus how much agreement is behind it — see the two-source
 * policy at the top of this file. Callers must surface `confirmed: false`
 * rather than presenting a single-source read as certainty.
 *
 * @returns `holding: null` when the sources agree the wallet holds no SGT.
 * @throws {SeekerRpcError} when mainnet is unconfigured or NO source answered —
 *   the caller answers 503 and writes NOTHING, so an outage neither grants nor
 *   revokes a badge.
 * @throws {SeekerSourceConflictError} (a SeekerRpcError) when the sources
 *   disagree: no badge, and nothing is revoked either.
 */
export async function verifySgtOwnership(opts: {
  /** Read-only mainnet-beta endpoint (SOLANA_MAINNET_RPC_URL). */
  rpcUrl?: string | undefined;
  /** Independent second endpoint (SOLANA_MAINNET_RPC_URL_2). Optional; without
   *  it every verdict is reported unconfirmed. */
  secondaryRpcUrl?: string | undefined;
  owner: string;
  /** The mint the caller is asking about (a re-check of an existing link).
   *  When the wallet holds SEVERAL SGTs, this one is answered first — both
   *  sources apply the same preference, so the cross-check stays comparable. */
  expectedMint?: string | undefined;
  /** Injectable for tests (defaults to global fetch). */
  fetchImpl?: typeof fetch | undefined;
}): Promise<SgtVerification> {
  const { rpcUrl, secondaryRpcUrl, owner, expectedMint } = opts;
  if (!rpcUrl) throw new SeekerRpcError('mainnet RPC is not configured (SOLANA_MAINNET_RPC_URL)');
  const doFetch = opts.fetchImpl ?? fetch;
  // ONE budget for the whole check, both sources included (security review F4):
  // this runs inside a request, against endpoints we do not control.
  const deadline = Date.now() + SEEKER.rpcTimeoutMs;

  const endpoints = [rpcUrl];
  if (independentSourceCount(rpcUrl, secondaryRpcUrl) === 2) endpoints.push(secondaryRpcUrl!);

  // Parallel, so a second source costs latency-max rather than latency-sum and
  // still fits the same budget.
  const settled = await Promise.allSettled(
    endpoints.map((url) => readSgtFrom(url, doFetch, owner, deadline, expectedMint)),
  );
  const answers = settled.filter((s) => s.status === 'fulfilled').map((s) => s.value);
  if (answers.length === 0) {
    const first = settled[0] as PromiseRejectedResult;
    throw first.reason instanceof SeekerRpcError
      ? first.reason
      : new SeekerRpcError(`mainnet unreachable: ${String(first.reason)}`);
  }

  // DEGRADED, and said so: one endpoint configured, or the cross-check is down.
  // Refusing here would take Seeker linking offline for a second-source outage,
  // which is worse than an honestly-labelled single-source verdict.
  if (answers.length === 1) return { holding: answers[0] ?? null, sources: 1, confirmed: false };

  const [a, b] = answers as [SgtHolding | null, SgtHolding | null];
  if ((a?.mint ?? null) !== (b?.mint ?? null)) {
    // KNOWN EDGE: each source reports its FIRST passing mint, so a wallet
    // holding TWO SGTs can trip this on enumeration-order alone when no
    // expectedMint narrows the question (fresh detection). Rare, and safe —
    // the callers fail closed and retry after backoff — but a wallet stuck
    // here repeatedly should link with `expectedMint` known (re-checks and
    // revivals already pass it).
    throw new SeekerSourceConflictError(
      `mainnet sources disagree about ${owner}: ${a?.mint ?? 'none'} vs ${b?.mint ?? 'none'}`,
    );
  }
  return { holding: a, sources: answers.length, confirmed: true };
}
