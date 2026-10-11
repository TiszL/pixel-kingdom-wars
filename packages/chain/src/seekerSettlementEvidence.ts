/** Transaction/account cross-binding only, not an RPC finality or deployment verifier.
 * The caller must independently verify immutable auction accounts, finalized RPC
 * identity, and that settlement is not older than the reviewed ProgramData deployment.
 * That reviewed binary must enforce native top-level settlement entry. Incidental
 * inner traces are not settlement authority and do not invalidate its result.
 * Permissionless bytes do not independently encode the account's bid/hash/Clock time.
 */
import { PHASE_E_SEEKER_AUCTION } from '@shardkeep/shared';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { Ed25519Program, PublicKey, SYSVAR_INSTRUCTIONS_PUBKEY, SystemProgram,
  type VersionedTransactionResponse } from '@solana/web3.js';
import bs58 from 'bs58';
import idl from './idl/shardkeep_economy.json' with { type: 'json' };
import { encodeSeekerActionPermit, hashSeekerAuctionTerms, hashSettleSeekerAuctionPayload,
  seekerAuctionConfigPda, seekerAuctionPda, seekerAuthorityPda, seekerBidPda,
  seekerPermitReceiptPda, seekerRegistryPda, seekerTermPda, type SeekerAuctionTerms } from './seekerAuctionProtocol';

export interface SeekerSettlementExpectation {
  readonly signature: string;
  readonly genesisHash: PublicKey;
  readonly programId: PublicKey;
  /** Independently decoded and verified immutable account facts, not client input. */
  readonly terms: SeekerAuctionTerms;
  readonly termsHash: Uint8Array;
  readonly winner: PublicKey | null;
  readonly highBid: bigint;
  readonly settledAt: bigint;
  readonly settledSlot: bigint;
}
export interface SeekerSettlementEvidence {
  readonly signature: string;
  readonly slot: bigint;
  readonly instructionIndex: number;
  readonly method: 'permissionless' | 'permit';
  readonly settler: string;
  /** Historical native verification key; deliberately not today's rotated key. */
  readonly policyKey: string | null;
  readonly requiresFinalizedAccountsAndReviewedDeployment: true;
}

const plainIdl = idl.instructions.find(i => i.name === 'settle_auction')!;
const permitIdl = idl.instructions.find(i => i.name === 'settle_auction_with_permit')!;
const plainDiscriminator = Buffer.from(plainIdl.discriminator);
const permitDiscriminator = Buffer.from(permitIdl.discriminator);
const U64_MAX = (1n << 64n) - 1n, I64_MAX = (1n << 63n) - 1n;
function requireThat(ok: unknown, reason: string): asserts ok {
  if (!ok) throw new Error(`Seeker settlement evidence: ${reason}`);
}
function key(value: PublicKey): PublicKey {
  requireThat(value && typeof value.toBytes === 'function' && typeof value.toBase58 === 'function', 'invalid key');
  const bytes = value.toBytes();
  requireThat(bytes instanceof Uint8Array && bytes.length === 32, 'invalid key bytes');
  const copy = new PublicKey(bytes);
  requireThat(copy.toBase58() === value.toBase58(), 'inconsistent key');
  return copy;
}
function equal(a: PublicKey, b: PublicKey): boolean { return key(a).equals(key(b)); }
function unsigned(value: bigint, max: bigint): void {
  requireThat(typeof value === 'bigint' && value >= 0n && value <= max, 'integer bounds');
}
function signature(value: string): void {
  requireThat(typeof value === 'string', 'signature type');
  const bytes = bs58.decode(value);
  requireThat(bytes.length === 64 && bytes.some(b => b !== 0) && bs58.encode(bytes) === value, 'canonical signature');
}
function method(data: Uint8Array): 'permissionless' | 'permit' | null {
  const prefix = Buffer.from(data).subarray(0, 8);
  return prefix.equals(plainDiscriminator) ? 'permissionless' : prefix.equals(permitDiscriminator) ? 'permit' : null;
}
function nativeEvidence(data: Uint8Array): { policyKey: PublicKey; message: Buffer } {
  const bytes = Buffer.from(data);
  requireThat(bytes.length >= 16 && bytes[0] === 1 && bytes[1] === 0, 'native header');
  for (const at of [4, 8, 14]) requireThat(bytes.readUInt16LE(at) === 65535, 'native cross-instruction offset');
  requireThat(bytes.readUInt16LE(12) === 161, 'native message length');
  const ranges = [[bytes.readUInt16LE(2), 64], [bytes.readUInt16LE(6), 32], [bytes.readUInt16LE(10), 161]]
    .map(([start, length]) => { requireThat(start !== undefined && length !== undefined && start >= 16
      && start + length <= bytes.length, 'native range'); return { start, end: start + length }; });
  for (let i = 0; i < ranges.length; i++) for (let j = i + 1; j < ranges.length; j++) {
    requireThat(ranges[i]!.end <= ranges[j]!.start || ranges[j]!.end <= ranges[i]!.start, 'native overlapping ranges');
  }
  return { policyKey: new PublicKey(bytes.subarray(ranges[1]!.start, ranges[1]!.end)),
    message: bytes.subarray(ranges[2]!.start, ranges[2]!.end) };
}

/** Throws on unavailable/malformed/ambiguous evidence. No RPC, signature creation or fallback. */
export function seekerSettlementEvidence(tx: VersionedTransactionResponse | null,
  expected: SeekerSettlementExpectation, observedGenesisHash: PublicKey): SeekerSettlementEvidence {
  signature(expected.signature);
  requireThat(equal(expected.genesisHash, observedGenesisHash), 'genesis mismatch');
  const program = key(expected.programId), terms = expected.terms;
  unsigned(expected.settledSlot, U64_MAX); unsigned(expected.settledAt, I64_MAX);
  unsigned(expected.highBid, U64_MAX); unsigned(terms.grace, I64_MAX);
  requireThat(expected.termsHash instanceof Uint8Array && expected.termsHash.length === 32
    && Buffer.from(expected.termsHash).equals(hashSeekerAuctionTerms(terms)), 'original terms hash');
  requireThat(equal(terms.config, seekerAuctionConfigPda(program)) && equal(terms.registry, seekerRegistryPda(program))
    && equal(terms.term, seekerTermPda(program, terms.config, terms.round))
    && equal(terms.auction, seekerAuctionPda(program, terms.config, terms.spotId, terms.round)), 'original PDA identity');
  requireThat(equal(terms.tokenProgram, TOKEN_PROGRAM_ID)
    && equal(terms.vault, getAssociatedTokenAddressSync(key(terms.mint), key(terms.auction), true))
    && equal(terms.prizeAta, getAssociatedTokenAddressSync(key(terms.mint), key(terms.prizeOwner), true))
    && !equal(terms.vault, terms.prizeAta), 'canonical token accounts');
  requireThat((expected.highBid === 0n) === (expected.winner === null)
    && (expected.winner === null || expected.highBid >= terms.openingBid), 'winner/amount mismatch');
  requireThat(expected.settledAt >= terms.auctionEnd, 'settled before auction end');
  requireThat(tx && tx.meta && tx.meta.err === null && Number.isSafeInteger(tx.slot) && tx.slot >= 0
    && BigInt(tx.slot) === expected.settledSlot, 'missing/failed/wrong-slot transaction');
  requireThat(tx.version === undefined || tx.version === 'legacy' || tx.version === 0, 'unsupported transaction version');
  const message = tx.transaction.message;
  requireThat(message.version === 'legacy' || message.version === 0, 'unsupported message version');
  requireThat(Array.isArray(tx.transaction.signatures) && tx.transaction.signatures.length === message.header.numRequiredSignatures
    && tx.transaction.signatures[0] === expected.signature, 'original first signature');
  tx.transaction.signatures.forEach(signature);
  const keys = message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses ?? null });
  requireThat(keys.length > 0 && keys.length <= 256, 'account key count');
  const at = (index: number): PublicKey => {
    requireThat(Number.isInteger(index) && index >= 0 && index < keys.length, 'account index');
    return key(keys.get(index)!);
  };
  // Never promote inner traces to authority. The reviewed native entry guard
  // rejects CPI settlement; successful unrelated CPI does not poison genuine proof.
  let result: SeekerSettlementEvidence | undefined;
  const seenAuctions = new Set<string>();
  for (const [instructionIndex, ix] of message.compiledInstructions.entries()) {
    if (!equal(at(ix.programIdIndex), program)) continue;
    const mode = method(ix.data);
    if (mode === null) continue;
    const data = Buffer.from(ix.data), layout = mode === 'permissionless' ? plainIdl : permitIdl;
    // Anchor consumes this exact required prefix and allows unused trailing
    // instruction bytes/remaining accounts. Rejecting those valid transactions
    // could strand an irreversibly settled auction.
    requireThat(data.length >= (mode === 'permissionless' ? 8 : 34)
      && ix.accountKeyIndexes.length >= layout.accounts.length, 'settlement layout');
    const auction = at(ix.accountKeyIndexes[3]!);
    requireThat(!seenAuctions.has(auction.toBase58()), 'duplicate settlement'); seenAuctions.add(auction.toBase58());
    if (!equal(auction, terms.auction)) continue; // Distinct-auction batches are valid.
    requireThat(result === undefined, 'ambiguous settlement');
    const wallet = at(ix.accountKeyIndexes[0]!);
    const winnerBid = expected.winner === null ? program : seekerBidPda(program, terms.auction, key(expected.winner));
    const expectedAccounts = [wallet, terms.config, terms.term, terms.auction, terms.mint, terms.vault,
      terms.prizeAta, winnerBid, TOKEN_PROGRAM_ID];
    if (mode === 'permit') expectedAccounts.push(seekerAuthorityPda(program), seekerPermitReceiptPda(program, data.subarray(8, 24)),
      SYSVAR_INSTRUCTIONS_PUBKEY, SystemProgram.programId);
    for (const [position, want] of expectedAccounts.entries()) {
      const index = ix.accountKeyIndexes[position]!;
      requireThat(equal(at(index), want), 'settlement account order/identity');
      // Message privileges are the union of all instructions. A readonly role
      // may be promoted by a valid batch; required signer/writer privileges may not disappear.
      const row = layout.accounts[position]!;
      if ('signer' in row && row.signer) requireThat(message.isAccountSigner(index), 'settler signature');
      if ('writable' in row && row.writable && !(position === 7 && expected.winner === null)) {
        requireThat(message.isAccountWritable(index), 'required writable account');
      }
    }
    // Do not reject raw invoked-program privilege promotion: the runtime can
    // demote it, and the reviewed handler does not impose that negative rule.
    let policyKey: string | null = null;
    if (mode === 'permissionless') {
      requireThat(terms.auctionEnd + terms.grace <= I64_MAX && expected.settledAt >= terms.auctionEnd + terms.grace,
        'permissionless grace period');
    } else {
      const expiry = data.readBigInt64LE(24), nativeIndex = data.readUInt16LE(32);
      requireThat(expected.settledAt + BigInt(PHASE_E_SEEKER_AUCTION.maxPolicyPermitTtlSec) <= I64_MAX
        && expected.settledAt < expiry
        && expiry <= expected.settledAt + BigInt(PHASE_E_SEEKER_AUCTION.maxPolicyPermitTtlSec), 'historical permit expiry');
      requireThat(nativeIndex < instructionIndex, 'native verification must precede settlement');
      const native = message.compiledInstructions[nativeIndex]!;
      requireThat(equal(at(native.programIdIndex), Ed25519Program.programId) && native.accountKeyIndexes.length === 0,
        'native verifier identity/accounts');
      const decoded = nativeEvidence(native.data);
      const want = encodeSeekerActionPermit({ genesisHash: key(expected.genesisHash), programId: program, kind: 8,
        permitId: data.subarray(8, 24), wallet, expiry, payloadHash: hashSettleSeekerAuctionPayload({ auction: terms.auction,
          config: terms.config, term: terms.term, termsHash: expected.termsHash, highBid: expected.highBid, highBidder: expected.winner }) });
      requireThat(decoded.message.equals(want), 'native original permit payload');
      policyKey = decoded.policyKey.toBase58();
    }
    result = Object.freeze({ signature: expected.signature, slot: expected.settledSlot, instructionIndex, method: mode,
      settler: wallet.toBase58(), policyKey, requiresFinalizedAccountsAndReviewedDeployment: true });
  }
  requireThat(result, 'no original top-level settlement');
  return result;
}
