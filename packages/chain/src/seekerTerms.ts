/** Read-only finalized Seeker provenance. No signer, default deployment, synthetic
 * term, persistent admission cache or RPC work inside game/database locks. */
import { createHash } from 'node:crypto';
import { PHASE_E_POLICY } from '@shardkeep/shared';
import { Connection, PublicKey, SYSVAR_CLOCK_PUBKEY, type AccountInfo,
  type VersionedTransactionResponse, type VersionedBlockResponse } from '@solana/web3.js';
import type { ReviewedProgramDeployment } from './bootstrap';
import { decodeProgramDataUpgradeAuthority, decodeUpgradeableProgramDataAddress } from './registryAttestation';
import { seekerAuthorityPda, seekerRegistryPda, seekerTermPda, seekerAuctionPda,
  type SeekerAuctionTerms } from './seekerAuctionProtocol';
import { candidateSeekerRoundAt, verifySeekerTermAccounts, verifyHistoricalSeekerTermAccounts, type SeekerRawAccount, type SeekerTermAccountPolicy,
  type SeekerVerifiedTerms } from './seekerTermAccounts';
import { seekerSettlementEvidence } from './seekerSettlementEvidence';

const LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const SYSVAR_OWNER = new PublicKey('Sysvar1111111111111111111111111111111111111');
// Transport/work bounds, not game economy or timing policy.
const DEADLINE_MS = 60_000, HISTORY_LIMIT = 32, MAX_CANDIDATES = 8;
const MAX_RPC_BYTES = 32 * 1024 * 1024, MAX_BLOCK_TRANSACTIONS = 10_000;
export type SeekerTermRpc = Pick<Connection, 'getGenesisHash' | 'getMultipleAccountsInfoAndContext'
  | 'getSignaturesForAddress' | 'getTransaction' | 'getBlock'>;
export interface ReviewedSeekerSourcePolicy extends Omit<SeekerTermAccountPolicy, 'operatingAt' | 'round'> {
  readonly deployment: Readonly<ReviewedProgramDeployment>;
  /** Deployment-review attestation, not inferred from account shape. Retained
   * state from an upgraded deployment needs a separate reviewed migration policy. */
  readonly stateProvenance: 'fresh-reviewed-deployment';
}
export interface ReviewedSeekerTermPolicy extends ReviewedSeekerSourcePolicy { readonly round: bigint; }
export interface SeekerTermReadOptions {
  /** Original signatures are hints only: every supplied body is verified again. */
  readonly settlementSignatures?: ReadonlyMap<number, string>;
  readonly deadlineMs?: number;
}
function requireValue(value: unknown, label: string): asserts value {
  if (!value) throw new Error(`Seeker term evidence unavailable: ${label}`);
}
function slot(value: number): number {
  requireValue(Number.isSafeInteger(value) && value >= 0, 'unsafe RPC context slot'); return value;
}
/** Use this transport in server wiring so the overall deadline cancels unfinished
 * response bodies too. No redirects or hidden rate-limit retry loop. */
export function makeSeekerTermRpc(url: string, signal: AbortSignal): SeekerTermRpc {
  return new Connection(url, { commitment: 'finalized', disableRetryOnRateLimit: true,
    fetch: async (input, init) => {
      const response = await fetch(input, { ...init, signal, redirect: 'error' });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new Error('Seeker term RPC transport refused');
      }
      requireValue(response.body, 'missing RPC body');
      const reader = response.body.getReader(), chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          requireValue(size <= MAX_RPC_BYTES, 'RPC response exceeds work bound');
          chunks.push(chunk.value);
        }
      } catch (error) { await reader.cancel().catch(() => {}); throw error; }
      finally { reader.releaseLock(); }
      const headers = new Headers(response.headers);
      headers.delete('content-length'); headers.delete('content-encoding');
      return new Response(Buffer.concat(chunks), { status: response.status, headers });
    },
  });
}
function raw(address: PublicKey, value: AccountInfo<Buffer> | null | undefined): SeekerRawAccount {
  requireValue(value, 'missing required account');
  return { address, owner: value.owner, executable: value.executable, data: Buffer.from(value.data) };
}
function sameAccount(a: SeekerRawAccount, b: SeekerRawAccount): boolean {
  return a.address.equals(b.address) && a.owner.equals(b.owner) && a.executable === b.executable
    && Buffer.from(a.data).equals(Buffer.from(b.data));
}
function terms(value: SeekerVerifiedTerms): SeekerAuctionTerms {
  return { ...value, registryHash: Buffer.from(value.registryHash, 'hex'),
    config: new PublicKey(value.config), term: new PublicKey(value.term), auction: new PublicKey(value.auction),
    registry: new PublicKey(value.registry), mint: new PublicKey(value.mint), tokenProgram: new PublicKey(value.tokenProgram),
    vault: new PublicKey(value.vault), prizeOwner: new PublicKey(value.prizeOwner), prizeAta: new PublicKey(value.prizeAta) };
}
function deployment(program: SeekerRawAccount, data: SeekerRawAccount, policy: ReviewedSeekerTermPolicy): bigint {
  const expected = policy.deployment;
  requireValue(expected && /^[0-9a-f]{64}$/.test(expected.programDataSha256)
    && Object.hasOwn(expected, 'upgradeAuthority'), 'missing explicit deployment policy');
  const canonical = PublicKey.findProgramAddressSync([policy.programId.toBuffer()], LOADER)[0];
  requireValue(canonical.toBase58() === expected.programDataAddress && data.address.equals(canonical)
    && program.executable && program.owner.equals(LOADER)
    && decodeUpgradeableProgramDataAddress(Buffer.from(program.data)).equals(canonical), 'program identity');
  requireValue(!data.executable && data.owner.equals(LOADER)
    && createHash('sha256').update(data.data).digest('hex') === expected.programDataSha256, 'reviewed binary changed');
  const authority = decodeProgramDataUpgradeAuthority(Buffer.from(data.data));
  requireValue((authority?.toBase58() ?? null) === expected.upgradeAuthority, 'upgrade authority changed');
  return Buffer.from(data.data).readBigUInt64LE(4);
}

/** Prefetch once outside locks. The result is original immutable account evidence
 * plus genuine finalized settlement instructions, bracketed by the same reviewed
 * deployment. Historical results before its deployment cannot be authenticated
 * without a separately reviewed deployment-history verifier, so v1 refuses them. */
export async function readFinalizedSeekerTerm(
  connect: (signal: AbortSignal) => SeekerTermRpc, policy: ReviewedSeekerTermPolicy,
  options: SeekerTermReadOptions = {},
) {
  return readSeekerTerm(connect, policy, options, false, { round: policy.round });
}
/** Historical tax provenance only. Actual finalized Clock and reviewed original
 * settlement evidence remain mandatory; expiry does not erase earned rights. */
export async function readFinalizedHistoricalSeekerTerm(
  connect: (signal: AbortSignal) => SeekerTermRpc, policy: ReviewedSeekerTermPolicy,
  options: SeekerTermReadOptions = {},
) {
  const term = await readSeekerTerm(connect, policy, options, true, { round: policy.round });
  return Object.freeze({ ...term, operatingAdmissionAuthorized: false as const });
}
/** Resolve a historical earning through the immutable config calendar, then run
 * the same complete original-settlement verification. A calendar hint can only
 * select one candidate; it cannot authorize a fallback or known-zero result. */
export async function readFinalizedHistoricalSeekerTermAt(connect: (signal: AbortSignal) => SeekerTermRpc,
  reviewed: ReviewedSeekerSourcePolicy, earnedAtMs: bigint, options: SeekerTermReadOptions = {}) {
  const key = (value: PublicKey) => new PublicKey(value.toBytes());
  const source: ReviewedSeekerSourcePolicy = Object.freeze({
    programId: key(reviewed.programId), config: key(reviewed.config), mint: key(reviewed.mint),
    prizeOwner: key(reviewed.prizeOwner), prizeAta: key(reviewed.prizeAta), genesisHash: key(reviewed.genesisHash),
    stateProvenance: reviewed.stateProvenance, deployment: Object.freeze({
      programDataAddress: reviewed.deployment.programDataAddress, programDataSha256: reviewed.deployment.programDataSha256,
      upgradeAuthority: reviewed.deployment.upgradeAuthority }),
  });
  requireValue(typeof earnedAtMs === 'bigint', 'invalid earning time');
  const term = await readSeekerTerm(connect, source, {
    ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
    ...(options.settlementSignatures === undefined ? {} : { settlementSignatures: new Map(options.settlementSignatures) }) },
  true, { earnedAtMs });
  return Object.freeze({ ...term, operatingAdmissionAuthorized: false as const });
}
/** Discover one currently operating round from the finalized config and Clock.
 * Selection is only a hint: the complete current-term verifier must still prove
 * every settled auction and refuse a rollover before this attempt finishes. */
export async function readFinalizedCurrentSeekerTerm(connect: (signal: AbortSignal) => SeekerTermRpc,
  reviewed: ReviewedSeekerSourcePolicy, options: SeekerTermReadOptions = {}) {
  const key = (value: PublicKey) => new PublicKey(value.toBytes());
  const source: ReviewedSeekerSourcePolicy = Object.freeze({
    programId: key(reviewed.programId), config: key(reviewed.config), mint: key(reviewed.mint),
    prizeOwner: key(reviewed.prizeOwner), prizeAta: key(reviewed.prizeAta), genesisHash: key(reviewed.genesisHash),
    stateProvenance: reviewed.stateProvenance, deployment: Object.freeze({
      programDataAddress: reviewed.deployment.programDataAddress, programDataSha256: reviewed.deployment.programDataSha256,
      upgradeAuthority: reviewed.deployment.upgradeAuthority }),
  });
  return readSeekerTerm(connect, source, {
    ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
    ...(options.settlementSignatures === undefined ? {} : { settlementSignatures: new Map(options.settlementSignatures) }) },
  false, { current: true });
}
function actualClock(clock: SeekerRawAccount, floor: number): bigint {
  requireValue(clock.owner.equals(SYSVAR_OWNER) && !clock.executable && clock.data.length === 40,
    'invalid actual Clock');
  const data = Buffer.from(clock.data);
  requireValue(data.readBigUInt64LE(0) <= BigInt(floor), 'Clock above finalized context');
  return data.readBigInt64LE(32);
}
async function readSeekerTerm(connect: (signal: AbortSignal) => SeekerTermRpc,
  source: ReviewedSeekerSourcePolicy, options: SeekerTermReadOptions, historical: boolean,
  selection: Readonly<{ round: bigint } | { earnedAtMs: bigint } | { current: true }>) {
  const duration = options.deadlineMs ?? DEADLINE_MS;
  requireValue(Number.isInteger(duration) && duration > 0 && duration <= DEADLINE_MS, 'invalid deadline');
  requireValue(source.stateProvenance === 'fresh-reviewed-deployment', 'unreviewed retained state');
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(); reject(new Error('Seeker term evidence unavailable: deadline'));
    }, duration);
  });
  const task = async () => {
    const rpc = connect(controller.signal), genesis = source.genesisHash.toBase58();
    requireValue(await rpc.getGenesisHash() === genesis, 'wrong chain genesis');
    let floor = 0;
    async function read(addresses: PublicKey[]) {
      controller.signal.throwIfAborted();
      const response = await rpc.getMultipleAccountsInfoAndContext(addresses,
        { commitment: 'finalized', minContextSlot: floor });
      controller.signal.throwIfAborted();
      const actual = slot(response.context.slot);
      requireValue(actual >= floor && response.value.length === addresses.length, 'regressing or incomplete context');
      floor = actual;
      return addresses.map((address, index) => raw(address, response.value[index]));
    }
    const discovery = 'current' in selection ? await read([source.config, SYSVAR_CLOCK_PUBKEY])
      : 'earnedAtMs' in selection ? await read([source.config]) : undefined;
    const hint = discovery?.[0];
    const round = 'round' in selection ? selection.round : candidateSeekerRoundAt(source, hint!,
      'earnedAtMs' in selection ? selection.earnedAtMs : actualClock(discovery![1]!, floor) * 1000n);
    const policy: ReviewedSeekerTermPolicy = { ...source, round };
    const addresses = [policy.programId, new PublicKey(policy.deployment.programDataAddress),
      seekerAuthorityPda(policy.programId), policy.config, seekerRegistryPda(policy.programId),
      seekerTermPda(policy.programId, policy.config, policy.round), SYSVAR_CLOCK_PUBKEY];
    const before = await read(addresses);
    if (hint) requireValue(sameAccount(hint, before[3]!), 'calendar changed after discovery');
    const deployedSlot = deployment(before[0]!, before[1]!, policy);
    requireValue(deployedSlot <= BigInt(floor), 'deployment above finalized context');
    // Exactly100 is the immutable accepted registry, not a synthesized owner list.
    const auctionAddresses = Array.from({ length: PHASE_E_POLICY.seekerIsland.totalSpots }, (_, spot) =>
      seekerAuctionPda(policy.programId, policy.config, spot, policy.round));
    const auctions = await read(auctionAddresses);
    function verified(core: SeekerRawAccount[]) {
      const observedClock = actualClock(core[6]!, floor);
      const verified = (historical ? verifyHistoricalSeekerTermAccounts : verifySeekerTermAccounts)({ ...policy, operatingAt: observedClock }, {
        authority: core[2]!, config: core[3]!, registry: core[4]!, term: core[5]!, auctions,
      });
      if ('earnedAtMs' in selection) requireValue(historical && selection.earnedAtMs >= verified.operatingStart * 1000n
        && selection.earnedAtMs < verified.operatingEnd * 1000n && selection.earnedAtMs >= verified.completedAt * 1000n
        && selection.earnedAtMs <= observedClock * 1000n, 'original term unavailable at earning');
      return verified;
    }
    const middle = await read(addresses);
    requireValue(deployment(middle[0]!, middle[1]!, policy) === deployedSlot, 'deployment changed while reading');
    // Complete term/config/registry are immutable. Authority may legitimately
    // rotate policy/admin or pause without rewriting settled term ownership.
    for (const i of [3, 4, 5]) requireValue(sameAccount(before[i]!, middle[i]!), 'immutable source changed');
    const original = verified(middle);
    // Refuse the entire invalid snapshot before any history work. Strictness
    // also rejects an upgrade and settlement whose same-slot order is ambiguous.
    requireValue(original.completedSlot <= BigInt(floor) && original.auctions.every(auction =>
      auction.settledSlot > deployedSlot && auction.settledSlot <= BigInt(floor)),
    'settlement outside reviewed deployment');
    const bodies = new Map<string, Promise<VersionedTransactionResponse | null>>();
    const proofs = [];
    // Group by original slot so a noisy shared history needs one block fetch.
    // Retain only that current block, rather than accumulating100 large bodies.
    const bySlot = [...original.auctions].sort((a, b) => a.settledSlot < b.settledSlot ? -1
      : a.settledSlot > b.settledSlot ? 1 : a.terms.spotId - b.terms.spotId);
    let cachedBlockSlot: number | undefined, cachedBlock: VersionedBlockResponse | null = null;
    for (const auction of bySlot) {
      controller.signal.throwIfAborted();
      const hint = options.settlementSignatures?.get(auction.terms.spotId);
      let candidates: string[];
      if (hint !== undefined) candidates = [hint];
      else {
        try {
          const history = await rpc.getSignaturesForAddress(new PublicKey(auction.terms.auction),
            { limit: HISTORY_LIMIT, minContextSlot: floor }, 'finalized');
          candidates = history.filter(row => slot(row.slot) === Number(auction.settledSlot)
            && row.err === null && row.confirmationStatus === 'finalized').map(row => row.signature);
        } catch { controller.signal.throwIfAborted(); candidates = []; }
      }
      let proof: ReturnType<typeof seekerSettlementEvidence> | undefined;
      const expected = (signature: string) => ({ signature, genesisHash: policy.genesisHash,
        programId: policy.programId, terms: terms(auction.terms), termsHash: Buffer.from(auction.termsHash, 'hex'),
        winner: auction.winner === null ? null : new PublicKey(auction.winner), highBid: auction.highBid,
        settledAt: auction.settledAt, settledSlot: auction.settledSlot });
      // A noisy account history is merely a discovery hint, never authority or
      // an attacker-controlled prerequisite for inspecting the original block.
      if (candidates.length > MAX_CANDIDATES || new Set(candidates).size !== candidates.length) candidates = [];
      for (const signature of candidates) {
        controller.signal.throwIfAborted();
        let body = bodies.get(signature);
        if (!body) {
          body = rpc.getTransaction(signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 });
          bodies.set(signature, body);
        }
        let transaction: VersionedTransactionResponse | null;
        try { transaction = await body; }
        catch (error) {
          controller.signal.throwIfAborted();
          if (hint !== undefined) throw error;
          continue; // Discovery-only provider failure still permits original-block recovery.
        }
        let candidate: ReturnType<typeof seekerSettlementEvidence>;
        try {
          candidate = seekerSettlementEvidence(transaction, expected(signature), policy.genesisHash);
        } catch { continue; } // Unrelated successful mentions are not settlement evidence.
        requireValue(!proof, 'multiple matching settlements'); proof = candidate;
      }
      if (!proof && hint === undefined) {
        controller.signal.throwIfAborted();
        const at = Number(auction.settledSlot);
        if (cachedBlockSlot !== at) {
          cachedBlock = await rpc.getBlock(at, { commitment: 'finalized', maxSupportedTransactionVersion: 0,
            transactionDetails: 'full', rewards: false });
          cachedBlockSlot = at;
        }
        const block = cachedBlock;
        requireValue(block && slot(block.parentSlot) < at && block.transactions.length <= MAX_BLOCK_TRANSACTIONS,
          'original settlement block unavailable');
        for (const entry of block.transactions) {
          if (!entry.meta || entry.meta.err !== null) continue;
          // Cheap discovery only; the semantic verifier still checks every
          // required byte/privilege. Avoid costly PDA/hash work on unrelated txs.
          try {
            const message = entry.transaction.message;
            const keys = message.getAccountKeys({ accountKeysFromLookups: entry.meta.loadedAddresses ?? null });
            if (!message.compiledInstructions.some(ix => keys.get(ix.programIdIndex)?.equals(policy.programId)
              && ix.accountKeyIndexes[3] !== undefined
              && keys.get(ix.accountKeyIndexes[3])?.equals(new PublicKey(auction.terms.auction)))) continue;
          } catch { continue; }
          const signature = entry.transaction.signatures[0];
          if (!signature) continue;
          let candidate: ReturnType<typeof seekerSettlementEvidence>;
          try {
            candidate = seekerSettlementEvidence({ ...entry, slot: at, blockTime: block.blockTime },
              expected(signature), policy.genesisHash);
          } catch { continue; }
          requireValue(!proof, 'multiple matching settlements in original block'); proof = candidate;
        }
      }
      requireValue(proof, 'no genuine successful settlement instruction');
      proofs.push(Object.freeze({ ...auction, settlement: Object.freeze(proof) }));
    }
    const after = await read(addresses);
    requireValue(deployment(after[0]!, after[1]!, policy) === deployedSlot, 'deployment changed during provenance lookup');
    for (const i of [3, 4, 5]) requireValue(sameAccount(middle[i]!, after[i]!), 'immutable source changed during provenance lookup');
    const current = verified(after); // Recheck the actual Clock for the selected purpose.
    requireValue(await rpc.getGenesisHash() === genesis, 'chain changed during provenance lookup');
    controller.signal.throwIfAborted();
    return Object.freeze({ ...current, auctions: Object.freeze(proofs.sort((a, b) => a.terms.spotId - b.terms.spotId)),
      deployment: Object.freeze({ ...policy.deployment, deployedSlot }),
      finality: Object.freeze({ commitment: 'finalized' as const, contextSlot: BigInt(floor), observedAt: new Date().toISOString() }) });
  };
  try { return await Promise.race([task(), deadline]); }
  catch { throw new Error('Authoritative finalized Seeker term unavailable'); }
  finally { if (timer) clearTimeout(timer); controller.abort(); }
}
export type FinalizedSeekerTerm = Awaited<ReturnType<typeof readFinalizedSeekerTerm>>;
