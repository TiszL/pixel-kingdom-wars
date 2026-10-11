/**
 * AllDomains ANS `.skr` resolution — SERVER ONLY, read-only, mainnet-beta.
 *
 * Used for NAMING ONLY. Owning a `.skr` grants NO Seeker badge: it is a
 * commercial namespace with no proven Seeker exclusivity and no sybil
 * resistance (see SEEKER.skr in @shardkeep/shared). The badge comes from the
 * SGT alone (seeker.ts); a verified Seeker may then adopt their `.skr` as a
 * username.
 *
 * Why a 40-line port instead of `@onsol/tldparser`: that package's ESM entry
 * imports `./parsers` extensionless, so `import`ing it from apps/api (ESM)
 * fails with ERR_MODULE_NOT_FOUND — it only works under CJS `require`. Owning
 * the derivation is safer than owning a broken dependency, and the golden
 * fixture in skr.test.ts pins it to ground truth.
 *
 * Ground truth (live mainnet reads 2026-07-29):
 *   torqueond.skr → name account 4eDbAer2fqjQWD8Q9HDcMofEEXz24UUZGptCh1t7snc5
 *   parent F3A8kuikEiu6k2399oSJ1PWfcJYDHqpwoQ2e8psSDNuF, owner 3HaPGBPE…9bEbpLf,
 *   nclass = system program (none), expiresAt 0 (never), nonTransferable true.
 *
 * The FORWARD check (domain → owner) — one PDA derivation plus one
 * getAccountInfo — is the only PROOF we ever trust. Reverse discovery
 * (wallet → its domains, `discoverSkrOwnedBy`) uses a memcmp-FILTERED
 * getProgramAccounts, measured working against the public mainnet endpoint
 * (2026-07-31) — the earlier claim that gPA was rate-limited into uselessness
 * held only for the unfiltered scan. Discovery merely NOMINATES a label; the
 * forward check decides, so a lying RPC degrades to "no name", never to a
 * wrong one. Sustained discovery load still wants the paid endpoint.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { PublicKey } from '@solana/web3.js';
import { SEEKER } from '@shardkeep/shared';

/** ANS hashes `HASH_PREFIX + label`, NOT the fully-qualified name. */
const HASH_PREFIX = 'ALT Name Service';

/** A resolved `.skr` name record. */
export interface SkrRecord {
  /** Fully-qualified, lowercased — e.g. `torqueond.skr`. */
  domain: string;
  /** The ANS name account (PDA). */
  nameAccount: string;
  owner: string;
}

/** Label of `x.skr`, lowercased; null when it isn't a well-formed `.skr` name. */
export function parseSkrLabel(domain: string): string | null {
  const d = domain.trim().toLowerCase();
  if (!d.endsWith(SEEKER.skr.tld)) return null;
  const label = d.slice(0, -SEEKER.skr.tld.length);
  // ANS labels are a single level; a dot here would mean a subdomain, which has
  // a different parent and must not be resolved against the TLD parent.
  if (!/^[a-z0-9_-]{1,63}$/.test(label)) return null;
  return label;
}

/**
 * ANS name-account PDA for a `.skr` label.
 * seeds = [ sha256("ALT Name Service" + label), nameClass (none → 32 zeros),
 *           parentName (the `.skr` parent name account) ].
 */
export function deriveSkrNameAccount(label: string): string {
  const hashed = Buffer.from(sha256(new TextEncoder().encode(HASH_PREFIX + label)));
  const [pda] = PublicKey.findProgramAddressSync(
    [hashed, Buffer.alloc(32), new PublicKey(SEEKER.skr.parentNameAccount).toBuffer()],
    new PublicKey(SEEKER.skr.ansProgram),
  );
  return pda.toBase58();
}

/**
 * Decode a NameRecordHeader (verified byte-for-byte against the account above).
 * Anchor 8-byte discriminator, then parentName(32) owner(32) nclass(32)
 * expiresAt(u64 LE) createdAt(u64 LE) nonTransferable(u8).
 */
export function decodeNameRecord(data: Uint8Array): {
  parentName: string; owner: string; expiresAt: bigint; nonTransferable: boolean;
} | null {
  if (data.length < 121) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    parentName: new PublicKey(data.subarray(8, 40)).toBase58(),
    owner: new PublicKey(data.subarray(40, 72)).toBase58(),
    expiresAt: view.getBigUint64(104, true),
    nonTransferable: data[120] === 1,
  };
}

/**
 * Resolve `domain` and confirm `expectedOwner` owns it RIGHT NOW.
 *
 * Returns null on any failure — bad format, missing account, wrong parent
 * (so a `foo.sol` record can never be passed off as `.skr`), expired, or a
 * different owner. `.skr` is decoration; a failure here must never block a
 * Seeker from being verified, so this never throws.
 */
export async function resolveSkrOwnedBy(opts: {
  rpcUrl?: string | undefined;
  domain: string;
  expectedOwner: string;
  fetchImpl?: typeof fetch | undefined;
  /** Injectable clock (seconds) for the expiry check. */
  nowSec?: number;
}): Promise<SkrRecord | null> {
  const { rpcUrl, domain, expectedOwner } = opts;
  if (!rpcUrl) return null;
  const label = parseSkrLabel(domain);
  if (!label) return null;
  const nameAccount = deriveSkrNameAccount(label);
  const doFetch = opts.fetchImpl ?? fetch;

  let data: Uint8Array;
  try {
    // BOUNDED like the SGT reads (security review F4, same class): this runs on
    // the link path against a third-party RPC, so an endpoint that accepts the
    // connection and then hangs would otherwise pin the request open.
    const res = await doFetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'getAccountInfo',
        params: [nameAccount, { encoding: 'base64' }],
      }),
      signal: AbortSignal.timeout(SEEKER.rpcTimeoutMs),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { result?: { value?: { data?: [string, string] } | null } };
    const b64 = body.result?.value?.data?.[0];
    if (!b64) return null;
    data = Uint8Array.from(Buffer.from(b64, 'base64'));
  } catch {
    return null;
  }

  const rec = decodeNameRecord(data);
  if (!rec) return null;
  // The parent IS the namespace assertion — without it any ANS name from any
  // TLD would resolve here and be displayed as a `.skr`.
  if (rec.parentName !== SEEKER.skr.parentNameAccount) return null;
  if (rec.owner !== expectedOwner) return null;
  // expiresAt 0 means "never" (how `.skr` records are issued).
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  if (rec.expiresAt !== 0n && rec.expiresAt < BigInt(now)) return null;

  return { domain: `${label}${SEEKER.skr.tld}`, nameAccount, owner: rec.owner };
}

/**
 * ANS reverse-lookup PDA for a name account: the "name" hashed is the name
 * account's BASE58 STRING, the class is the `.skr` TLD House ACCOUNT, and the
 * parent is none (32 zeros). Its data is a NameRecordHeader followed by the raw
 * label — no length prefix (verified live 2026-07-31, space 209 = 200 + 9).
 */
export function deriveSkrReverseAccount(nameAccount: string): string {
  const hashed = Buffer.from(sha256(new TextEncoder().encode(HASH_PREFIX + nameAccount)));
  const [pda] = PublicKey.findProgramAddressSync(
    [hashed, new PublicKey(SEEKER.skr.tldHouse).toBuffer(), Buffer.alloc(32)],
    new PublicKey(SEEKER.skr.ansProgram),
  );
  return pda.toBase58();
}

/** TLD House MainDomain PDA for `owner` — the wallet's self-declared main domain. */
export function deriveSkrMainDomainAccount(owner: string): string {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from(SEEKER.skr.mainDomainPrefix), new PublicKey(owner).toBuffer()],
    new PublicKey(SEEKER.skr.tldHouseProgram),
  );
  return pda.toBase58();
}

/**
 * Decode a MainDomain account into a candidate `.skr` LABEL, or null.
 * Borsh layout after the 8-byte Anchor discriminator: nameAccount(32), then
 * strings `tld` and `domain` (u32 LE length + utf8). Only `tld === '.skr'`
 * is accepted — a wallet whose main domain is a `.sol` nominates nothing here.
 *
 * The label-vs-FQDN semantics of `domain` are UNVERIFIED (no live populated
 * account was found 2026-07-31), so it is normalised defensively: strip a
 * trailing '.skr' if present, then treat as a label. A wrong guess fails the
 * forward closure in discoverSkrOwnedBy and degrades to "no adoption" — it can
 * never produce a wrong name.
 */
export function decodeMainDomainLabel(data: Uint8Array): string | null {
  if (data.length < 8 + 32 + 4) return null;
  for (let i = 0; i < 8; i += 1) {
    if (data[i] !== SEEKER.skr.mainDomainDiscriminator[i]) return null;
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let off = 40; // discriminator(8) + nameAccount(32)
  const readString = (): string | null => {
    if (off + 4 > data.length) return null;
    const len = view.getUint32(off, true);
    off += 4;
    if (len > 256 || off + len > data.length) return null;
    const s = new TextDecoder().decode(data.subarray(off, off + len));
    off += len;
    return s;
  };
  const tld = readString();
  if (tld !== SEEKER.skr.tld) return null;
  const domain = readString();
  if (!domain) return null;
  const lower = domain.toLowerCase();
  return lower.endsWith(SEEKER.skr.tld) ? lower.slice(0, -SEEKER.skr.tld.length) : lower;
}

/** One raw JSON-RPC POST; null on any transport/HTTP failure (never throws). */
async function rpcResult<T>(
  rpcUrl: string, doFetch: typeof fetch, signal: AbortSignal, method: string, params: unknown[],
): Promise<T | null> {
  try {
    const res = await doFetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { result?: T };
    return body.result ?? null;
  } catch {
    return null;
  }
}

/**
 * Discover the `.skr` a wallet owns WITHOUT the user typing it — the Seeker
 * onboarding flow registers one, so on link we can adopt it automatically.
 *
 * Two nomination sources, in order:
 *  1. The TLD House MainDomain PDA (one cheap getAccountInfo) — the wallet's
 *     own declaration, when it exists and is a `.skr`.
 *  2. A memcmp-filtered getProgramAccounts over the ANS program (owner AND the
 *     `.skr` parent), candidates sorted by createdAt ascending with a
 *     lexicographic-pubkey tiebreak, capped at SEEKER.skr.maxReverseCandidates.
 *     WHY earliest-first: the first `.skr` a wallet claimed is the closest
 *     proxy for the Seeker onboarding domain, and the rule is deterministic
 *     across relinks. Labels come from each candidate's reverse-lookup account
 *     (ONE getMultipleAccounts for all of them).
 *
 * Either source only NOMINATES a label; the existing forward proof
 * (resolveSkrOwnedBy) DECIDES, so a lying RPC or corrupt reverse record
 * degrades to null — never to a wrong name. Like resolveSkrOwnedBy this never
 * throws (`.skr` is decoration; failure must not block a link), and all
 * discovery reads share ONE AbortSignal deadline of SEEKER.rpcTimeoutMs.
 */
export async function discoverSkrOwnedBy(opts: {
  rpcUrl?: string | undefined;
  owner: string;
  fetchImpl?: typeof fetch | undefined;
  /** Injectable clock (seconds) for the forward expiry check. */
  nowSec?: number;
}): Promise<SkrRecord | null> {
  const { rpcUrl, owner } = opts;
  if (!rpcUrl) return null;
  const doFetch = opts.fetchImpl ?? fetch;
  const forward = (label: string): Promise<SkrRecord | null> => resolveSkrOwnedBy({
    rpcUrl, domain: `${label}${SEEKER.skr.tld}`, expectedOwner: owner,
    fetchImpl: opts.fetchImpl, ...(opts.nowSec !== undefined ? { nowSec: opts.nowSec } : {}),
  });

  try {
    // ONE deadline for every discovery read (same F4 class as the SGT budget:
    // third-party RPC on the link path must not pin our request workers).
    const signal = AbortSignal.timeout(SEEKER.rpcTimeoutMs);

    // 1. MainDomain fast path. A valid `.skr` nomination here is FINAL: it is
    //    the wallet's own declaration, so we forward-check it rather than
    //    second-guess it with a scan (a failed check means no adoption — safe).
    const main = await rpcResult<{ value?: { data?: [string, string] } | null }>(
      rpcUrl, doFetch, signal, 'getAccountInfo',
      [deriveSkrMainDomainAccount(owner), { encoding: 'base64' }],
    );
    const mainB64 = main?.value?.data?.[0];
    if (mainB64) {
      const label = decodeMainDomainLabel(Uint8Array.from(Buffer.from(mainB64, 'base64')));
      // Re-validated as a label (charset/single-level) before it may become a
      // domain we resolve; a malformed or non-.skr main domain falls through
      // to the scan — the wallet may still own a `.skr` it never declared.
      if (label !== null && parseSkrLabel(`${label}${SEEKER.skr.tld}`) !== null) {
        return await forward(label);
      }
    }

    // 2. Filtered reverse scan: every ANS record owned by `owner` under the
    //    `.skr` parent. The dataSlice keeps the response to headers only.
    const accounts = await rpcResult<{ pubkey?: string; account?: { data?: [string, string] } }[]>(
      rpcUrl, doFetch, signal, 'getProgramAccounts',
      [SEEKER.skr.ansProgram, {
        encoding: 'base64',
        dataSlice: { offset: 0, length: SEEKER.skr.nameRecordByteSize },
        filters: [
          { memcmp: { offset: 40, bytes: owner } },
          { memcmp: { offset: 8, bytes: SEEKER.skr.parentNameAccount } },
        ],
      }],
    );
    if (!accounts) return null;

    const candidates: { pubkey: string; createdAt: bigint }[] = [];
    for (const a of accounts) {
      const b64 = a.account?.data?.[0];
      if (!a.pubkey || !b64) continue;
      const buf = Buffer.from(b64, 'base64');
      if (buf.length < 120) continue; // createdAt is u64 LE at offset 112
      candidates.push({ pubkey: a.pubkey, createdAt: buf.readBigUInt64LE(112) });
    }
    candidates.sort((x, y) => {
      if (x.createdAt !== y.createdAt) return x.createdAt < y.createdAt ? -1 : 1;
      return x.pubkey < y.pubkey ? -1 : x.pubkey > y.pubkey ? 1 : 0;
    });
    const capped = candidates.slice(0, SEEKER.skr.maxReverseCandidates);
    if (capped.length === 0) return null;

    // 3. Labels live in the reverse-lookup accounts — ONE batched read.
    const rev = await rpcResult<{ value?: ({ data?: [string, string] } | null)[] }>(
      rpcUrl, doFetch, signal, 'getMultipleAccounts',
      [capped.map((c) => deriveSkrReverseAccount(c.pubkey)), { encoding: 'base64' }],
    );
    if (!rev?.value) return null;

    for (let i = 0; i < capped.length; i += 1) {
      const b64 = rev.value[i]?.data?.[0];
      if (!b64) continue;
      const data = Buffer.from(b64, 'base64');
      if (data.length <= SEEKER.skr.nameRecordByteSize) continue;
      const label = data.subarray(SEEKER.skr.nameRecordByteSize).toString('utf8');
      // parseSkrLabel is the SAME validator the typed-domain path uses; a
      // corrupt reverse record fails it and the next candidate is tried.
      if (parseSkrLabel(`${label}${SEEKER.skr.tld}`) === null) continue;
      // 4. CLOSE THE LOOP: the first parsing candidate is forward-proven and
      //    that verdict is returned as-is — nomination is not ownership.
      return await forward(label);
    }
    return null;
  } catch {
    return null;
  }
}
