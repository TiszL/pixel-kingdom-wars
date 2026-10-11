/** League claim v1 hash/sum protocol (7002e405). These pure functions prove
 * membership only; they do not prove RPC finality, funding or claim admission. */
import { keccak_256 } from '@noble/hashes/sha3.js';
import { PublicKey } from '@solana/web3.js';

export const LEAGUE_PROGRAM_ID = new PublicKey('2x3PP9GeyvcwvrBCwAjYacTaaLRMhXbzBnRLDAWtninE');
// Local calendar/wire facts, explicitly ruled in 2c498a74; not game tuning.
export const LEAGUE_WEEK_SEC = 604800n;
export const MONDAY_OFFSET_SEC = 345600n;
export const MAX_PROOF_DEPTH = 10;
const LEAF_DOMAIN = 0x06, NODE_DOMAIN = 0x07;
const HASH_BYTES = 32, PROOF_NODE_BYTES = 41, U64_MAX = (1n << 64n) - 1n;
const I64_MIN = -(1n << 63n), I64_MAX = (1n << 63n) - 1n;

export interface Leaf {
  programId: PublicKey;
  config: PublicKey;
  weekStart: bigint;
  /** Immutable entitlement place minus one, not a position in the leaf array. */
  index: number;
  claimant: PublicKey;
  amount: bigint;
}
export interface ProofNode { hash: Uint8Array; sum: bigint; isLeft: boolean }
export type LeagueProofErrorCode = 'InvalidProof' | 'ProofTooDeep' | 'ArithmeticOverflow'
  | 'InvalidPublicKey' | 'InvalidWeekStart' | 'InvalidIndex' | 'InvalidAmount'
  | 'InvalidLeafCount' | 'InvalidPolicy' | 'DuplicateIndex' | 'InvalidTreeContext';
export class LeagueProofError extends Error {
  constructor(readonly code: LeagueProofErrorCode) { super(`League claim proof: ${code}`); this.name = 'LeagueProofError'; }
}
function need(value: unknown, code: LeagueProofErrorCode): asserts value {
  if (!value) throw new LeagueProofError(code);
}
function hashBytes(value: Uint8Array): Uint8Array {
  need(value instanceof Uint8Array && value.length === HASH_BYTES, 'InvalidProof'); return value;
}
function publicKeyBytes(value: PublicKey): Uint8Array {
  need(value instanceof PublicKey, 'InvalidPublicKey');
  let bytes: Uint8Array;
  try { bytes = value.toBytes(); } catch { throw new LeagueProofError('InvalidPublicKey'); }
  need(bytes instanceof Uint8Array && bytes.length === HASH_BYTES, 'InvalidPublicKey'); return bytes;
}
function u64(value: bigint, code: LeagueProofErrorCode = 'InvalidAmount'): bigint {
  need(typeof value === 'bigint' && value >= 0n && value <= U64_MAX, code); return value;
}
function add(left: bigint, right: bigint): bigint {
  const sum = u64(left) + u64(right); need(sum <= U64_MAX, 'ArithmeticOverflow'); return sum;
}
function indexValue(index: number): number {
  need(Number.isSafeInteger(index) && index >= 0 && index <= 0xffff, 'InvalidIndex'); return index;
}
function view(bytes: Uint8Array): DataView { return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }
function same(left: Uint8Array, right: Uint8Array): boolean { return left.every((byte, index) => byte === right[index]); }
function proofValue(proof: readonly ProofNode[]): void {
  need(Array.isArray(proof), 'InvalidProof'); need(proof.length <= MAX_PROOF_DEPTH, 'ProofTooDeep');
  for (const node of proof) {
    need(node && typeof node === 'object', 'InvalidProof'); hashBytes(node.hash);
    u64(node.sum, 'InvalidProof'); need(typeof node.isLeft === 'boolean', 'InvalidProof');
  }
}

/** Signed i64 calendar encoding is lossless; calendar admission belongs to the
 * program handler. Zero amounts are hashable but cannot enter buildTree. */
export function leafPreimage(leaf: Leaf): Uint8Array {
  need(leaf && typeof leaf === 'object', 'InvalidProof');
  need(typeof leaf.weekStart === 'bigint' && leaf.weekStart >= I64_MIN && leaf.weekStart <= I64_MAX, 'InvalidWeekStart');
  indexValue(leaf.index); u64(leaf.amount);
  const bytes = new Uint8Array(115), data = view(bytes); bytes[0] = LEAF_DOMAIN;
  bytes.set(publicKeyBytes(leaf.programId), 1); bytes.set(publicKeyBytes(leaf.config), 33);
  data.setBigInt64(65, leaf.weekStart, true); data.setUint16(73, leaf.index, true);
  bytes.set(publicKeyBytes(leaf.claimant), 75); data.setBigUint64(107, leaf.amount, true); return bytes;
}
export function hashLeaf(leaf: Leaf): Uint8Array { return keccak_256(leafPreimage(leaf)); }
export function nodePreimage(leftHash: Uint8Array, leftSum: bigint, rightHash: Uint8Array, rightSum: bigint): Uint8Array {
  hashBytes(leftHash); hashBytes(rightHash); add(leftSum, rightSum);
  const bytes = new Uint8Array(81), data = view(bytes); bytes[0] = NODE_DOMAIN;
  bytes.set(leftHash, 1); data.setBigUint64(33, leftSum, true);
  bytes.set(rightHash, 41); data.setBigUint64(73, rightSum, true); return bytes;
}
export function hashNode(leftHash: Uint8Array, leftSum: bigint, rightHash: Uint8Array, rightSum: bigint): Uint8Array {
  return keccak_256(nodePreimage(leftHash, leftSum, rightHash, rightSum));
}

/** False means well-formed nonmembership. Malformed wire values, over-depth
 * proofs and arithmetic overflow throw LeagueProofError with a stable code. */
export function verifyProof(leaf: Leaf, proof: readonly ProofNode[], root: Uint8Array, total: bigint): boolean {
  proofValue(proof); hashBytes(root); u64(total);
  let current = hashLeaf(leaf), running = leaf.amount;
  for (const sibling of proof) {
    const next = add(running, sibling.sum);
    current = sibling.isLeft ? hashNode(sibling.hash, sibling.sum, current, running)
      : hashNode(current, running, sibling.hash, sibling.sum);
    running = next;
  }
  return running === total && same(current, root);
}

/** Canonical Borsh Vec<ProofNode>, with a u32 count and 41-byte entries. */
export function encodeProof(proof: readonly ProofNode[]): Uint8Array {
  proofValue(proof);
  const bytes = new Uint8Array(4 + PROOF_NODE_BYTES * proof.length), data = view(bytes);
  data.setUint32(0, proof.length, true);
  proof.forEach((node, index) => {
    const at = 4 + PROOF_NODE_BYTES * index; bytes.set(node.hash, at);
    data.setBigUint64(at + HASH_BYTES, node.sum, true); bytes[at + 40] = node.isLeft ? 1 : 0;
  });
  return bytes;
}
export function decodeProof(bytes: Uint8Array): ProofNode[] {
  need(bytes instanceof Uint8Array && bytes.length >= 4, 'InvalidProof');
  const data = view(bytes), count = data.getUint32(0, true);
  need(count <= MAX_PROOF_DEPTH, 'ProofTooDeep'); need(bytes.length === 4 + count * PROOF_NODE_BYTES, 'InvalidProof');
  return Array.from({ length: count }, (_, index) => {
    const at = 4 + index * PROOF_NODE_BYTES, side = bytes[at + 40]!;
    need(side === 0 || side === 1, 'InvalidProof');
    return { hash: bytes.slice(at, at + HASH_BYTES), sum: data.getBigUint64(at + HASH_BYTES, true), isLeft: side === 1 };
  });
}

export interface LeagueTree {
  readonly root: Uint8Array;
  readonly total: bigint;
  readonly leafCount: number;
  readonly leaves: readonly Readonly<Leaf>[];
  /** Fetch by entitlement index (place minus one), including sparse indexes. */
  getProof(index: number): ProofNode[];
}
function copyLeaf(leaf: Leaf): Leaf {
  return { ...leaf, programId: new PublicKey(publicKeyBytes(leaf.programId)), config: new PublicKey(publicKeyBytes(leaf.config)),
    claimant: new PublicKey(publicKeyBytes(leaf.claimant)) };
}
/** Caller supplies PHASE_E_LEAGUE_REWARDS.v1.skr.maxPlaces from its pinned
 * shared policy. No duplicate policy number or fallback is embedded here. */
export function buildTree(input: readonly Leaf[], policy: { readonly maxPlaces: number }): LeagueTree {
  need(policy && Number.isSafeInteger(policy.maxPlaces) && policy.maxPlaces > 0
    && policy.maxPlaces <= (1 << MAX_PROOF_DEPTH), 'InvalidPolicy');
  need(Array.isArray(input) && input.length > 0 && input.length <= policy.maxPlaces, 'InvalidLeafCount');
  const leaves = input.map(leaf => { leafPreimage(leaf); return copyLeaf(leaf); }).sort((left, right) => left.index - right.index);
  const context = leaves[0]!, positions = new Map<number, number>();
  const bottom = leaves.map((leaf, position) => {
    need(leaf.index < policy.maxPlaces, 'InvalidIndex'); need(leaf.amount > 0n, 'InvalidAmount');
    need(!positions.has(leaf.index), 'DuplicateIndex'); positions.set(leaf.index, position);
    need(leaf.programId.equals(context.programId) && leaf.config.equals(context.config)
      && leaf.weekStart === context.weekStart, 'InvalidTreeContext');
    return { hash: hashLeaf(leaf), sum: leaf.amount };
  });
  const levels = [bottom];
  while (levels[levels.length - 1]!.length > 1) {
    const current = levels[levels.length - 1]!, next: { hash: Uint8Array; sum: bigint }[] = [];
    for (let index = 0; index < current.length; index += 2) {
      const left = current[index]!, right = current[index + 1];
      next.push(right ? { hash: hashNode(left.hash, left.sum, right.hash, right.sum), sum: add(left.sum, right.sum) } : left);
    }
    levels.push(next);
  }
  const root = levels[levels.length - 1]![0]!;
  return Object.freeze({
    get root() { return root.hash.slice(); }, total: root.sum, leafCount: leaves.length,
    get leaves() { return Object.freeze(leaves.map(leaf => Object.freeze(copyLeaf(leaf)))); },
    getProof(index: number): ProofNode[] {
      indexValue(index); let position = positions.get(index); need(position !== undefined, 'InvalidIndex');
      const proof: ProofNode[] = [];
      for (const level of levels.slice(0, -1)) {
        const sibling = level[position ^ 1];
        if (sibling) proof.push({ hash: sibling.hash.slice(), sum: sibling.sum, isLeft: position % 2 === 1 });
        position = Math.floor(position / 2);
      }
      return proof;
    },
  });
}
