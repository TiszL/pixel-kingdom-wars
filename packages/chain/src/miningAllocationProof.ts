/** E1-ONCHAIN-DESIGN §4.3 / S3 cumulative mining commitment byte protocol.
 * Hash/sum membership only: no publication, claimability, fairness or authority
 * is implied. Deliberately separate from the accepted distributor/PoR codec. */
import { keccak_256 } from '@noble/hashes/sha3.js';
import bs58 from 'bs58';

// Technical wire bounds, not game policy. S3/E1 §4.3 caps Borsh proofs at 16.
export const MINING_ALLOCATION_MAX_DEPTH = 16;
export const MINING_ALLOCATION_MAX_LEAVES = 65536;
export const MINING_ALLOCATION_LEAF_BYTES = 65;
export const MINING_ALLOCATION_NODE_BYTES = 81;
export const MINING_ALLOCATION_PROOF_NODE_BYTES = 41;
export const MINING_ALLOCATION_U64_MAX = (1n << 64n) - 1n;
const HASH_BYTES = 32;
const VEC_LENGTH_BYTES = 4;
const LEAF_PREFIX = 0x02;
const NODE_PREFIX = 0x04;

export interface MiningAllocationLeaf {
  wallet: string;
  cumulativeKeep: bigint;
  cumulativeRenown: bigint;
  cumulativeDays: bigint;
  sequence: bigint;
}
export interface MiningProofNode { hash: Uint8Array; sum: bigint; isLeft: boolean }
export interface MiningAllocationTree {
  readonly root: Uint8Array;
  readonly total: bigint;
  readonly leafCount: number;
  readonly leaves: readonly MiningAllocationLeaf[];
  /** Index in the returned, wallet-byte-sorted leaves; bottom-up siblings. */
  proof(index: number): MiningProofNode[];
}

function u64(value: bigint): bigint {
  if (typeof value !== 'bigint') throw new TypeError('mining allocation: u64 must be bigint');
  if (value < 0n || value > MINING_ALLOCATION_U64_MAX) throw new RangeError('mining allocation: u64 out of range');
  return value;
}
function sum(left: bigint, right: bigint): bigint { return u64(u64(left) + u64(right)); }
function sized(value: Uint8Array, length: number): void {
  if (!(value instanceof Uint8Array) || value.length !== length) throw new TypeError(`mining allocation: expected ${length} bytes`);
}
function view(bytes: Uint8Array): DataView { return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }
function walletBytes(wallet: string): Uint8Array {
  if (typeof wallet !== 'string' || wallet.length < 32 || wallet.length > 44) throw new TypeError('mining allocation: noncanonical wallet');
  let bytes: Uint8Array;
  try { bytes = bs58.decode(wallet); } catch { throw new TypeError('mining allocation: noncanonical wallet'); }
  sized(bytes, HASH_BYTES);
  if (bs58.encode(bytes) !== wallet) throw new TypeError('mining allocation: noncanonical wallet');
  return bytes;
}
function compare(left: Uint8Array, right: Uint8Array): number {
  for (let i = 0; i < HASH_BYTES; i++) if (left[i] !== right[i]) return left[i]! - right[i]!;
  return 0;
}
function boundedProof(proof: readonly MiningProofNode[]): void {
  if (!Array.isArray(proof)) throw new TypeError('mining allocation: proof must be an array');
  if (proof.length > MINING_ALLOCATION_MAX_DEPTH) throw new RangeError('mining allocation: proof too deep');
}

export function encodeMiningAllocationLeaf(leaf: MiningAllocationLeaf): Uint8Array {
  const bytes = new Uint8Array(MINING_ALLOCATION_LEAF_BYTES), data = view(bytes);
  bytes[0] = LEAF_PREFIX; bytes.set(walletBytes(leaf.wallet), 1);
  data.setBigUint64(33, u64(leaf.cumulativeKeep), true);
  data.setBigUint64(41, u64(leaf.cumulativeRenown), true);
  data.setBigUint64(49, u64(leaf.cumulativeDays), true);
  data.setBigUint64(57, u64(leaf.sequence), true);
  return bytes;
}
export function decodeMiningAllocationLeaf(bytes: Uint8Array): MiningAllocationLeaf {
  sized(bytes, MINING_ALLOCATION_LEAF_BYTES);
  if (bytes[0] !== LEAF_PREFIX) throw new TypeError('mining allocation: wrong leaf domain');
  const data = view(bytes);
  return { wallet: bs58.encode(bytes.subarray(1, 33)), cumulativeKeep: data.getBigUint64(33, true),
    cumulativeRenown: data.getBigUint64(41, true), cumulativeDays: data.getBigUint64(49, true), sequence: data.getBigUint64(57, true) };
}
export function hashMiningAllocationLeaf(leaf: MiningAllocationLeaf): Uint8Array { return keccak_256(encodeMiningAllocationLeaf(leaf)); }

export function encodeMiningAllocationNode(left: Uint8Array, leftSum: bigint, right: Uint8Array, rightSum: bigint): Uint8Array {
  sized(left, HASH_BYTES); sized(right, HASH_BYTES); sum(leftSum, rightSum);
  const bytes = new Uint8Array(MINING_ALLOCATION_NODE_BYTES), data = view(bytes);
  bytes[0] = NODE_PREFIX; bytes.set(left, 1); data.setBigUint64(33, leftSum, true);
  bytes.set(right, 41); data.setBigUint64(73, rightSum, true);
  return bytes;
}
export function hashMiningAllocationNode(left: Uint8Array, leftSum: bigint, right: Uint8Array, rightSum: bigint): Uint8Array {
  return keccak_256(encodeMiningAllocationNode(left, leftSum, right, rightSum));
}

export function encodeMiningProofNode(node: MiningProofNode): Uint8Array {
  sized(node.hash, HASH_BYTES); u64(node.sum);
  if (typeof node.isLeft !== 'boolean') throw new TypeError('mining allocation: noncanonical proof boolean');
  const bytes = new Uint8Array(MINING_ALLOCATION_PROOF_NODE_BYTES);
  bytes.set(node.hash); view(bytes).setBigUint64(32, node.sum, true); bytes[40] = node.isLeft ? 1 : 0;
  return bytes;
}
export function decodeMiningProofNode(bytes: Uint8Array): MiningProofNode {
  sized(bytes, MINING_ALLOCATION_PROOF_NODE_BYTES);
  if (bytes[40] !== 0 && bytes[40] !== 1) throw new TypeError('mining allocation: noncanonical proof boolean');
  return { hash: Uint8Array.from(bytes.subarray(0, 32)), sum: view(bytes).getBigUint64(32, true), isLeft: bytes[40] === 1 };
}
/** Borsh Vec<ProofNode>: u32 LE count followed by exactly count × 41 bytes. */
export function encodeMiningAllocationProof(proof: readonly MiningProofNode[]): Uint8Array {
  boundedProof(proof);
  const bytes = new Uint8Array(VEC_LENGTH_BYTES + proof.length * MINING_ALLOCATION_PROOF_NODE_BYTES);
  view(bytes).setUint32(0, proof.length, true);
  for (let i = 0; i < proof.length; i++) bytes.set(encodeMiningProofNode(proof[i]!), VEC_LENGTH_BYTES + i * MINING_ALLOCATION_PROOF_NODE_BYTES);
  return bytes;
}
export function decodeMiningAllocationProof(bytes: Uint8Array): MiningProofNode[] {
  if (!(bytes instanceof Uint8Array) || bytes.length < VEC_LENGTH_BYTES) throw new TypeError('mining allocation: truncated proof vector');
  const length = view(bytes).getUint32(0, true);
  if (length > MINING_ALLOCATION_MAX_DEPTH || bytes.length !== VEC_LENGTH_BYTES + length * MINING_ALLOCATION_PROOF_NODE_BYTES)
    throw new RangeError('mining allocation: invalid proof vector length');
  return Array.from({ length }, (_, i) => {
    const offset = VEC_LENGTH_BYTES + i * MINING_ALLOCATION_PROOF_NODE_BYTES;
    return decodeMiningProofNode(bytes.subarray(offset, offset + MINING_ALLOCATION_PROOF_NODE_BYTES));
  });
}

export function verifyMiningAllocationProof(leaf: MiningAllocationLeaf, proof: readonly MiningProofNode[], root: Uint8Array, total: bigint): boolean {
  try {
    boundedProof(proof); sized(root, HASH_BYTES); u64(total);
    let hash = hashMiningAllocationLeaf(leaf), running = leaf.cumulativeKeep;
    for (const sibling of proof) {
      // Reject malformed in-memory nodes as strictly as wire-decoded nodes.
      sized(sibling.hash, HASH_BYTES);
      if (typeof sibling.isLeft !== 'boolean') return false;
      const next = sum(running, sibling.sum);
      hash = sibling.isLeft ? hashMiningAllocationNode(sibling.hash, sibling.sum, hash, running)
        : hashMiningAllocationNode(hash, running, sibling.hash, sibling.sum);
      running = next;
    }
    return running === total && compare(hash, root) === 0;
  } catch { return false; }
}

export function buildMiningAllocationTree(input: readonly MiningAllocationLeaf[]): MiningAllocationTree {
  if (!Array.isArray(input) || input.length === 0 || input.length > MINING_ALLOCATION_MAX_LEAVES)
    throw new RangeError('mining allocation: invalid leaf count');
  const sorted = input.map(leaf => {
    // Copy only protocol fields so mutable caller data cannot change the tree.
    const copy = Object.freeze({ wallet: leaf.wallet, cumulativeKeep: u64(leaf.cumulativeKeep),
      cumulativeRenown: u64(leaf.cumulativeRenown), cumulativeDays: u64(leaf.cumulativeDays), sequence: u64(leaf.sequence) });
    return { leaf: copy, wallet: walletBytes(copy.wallet) };
  }).sort((a, b) => compare(a.wallet, b.wallet));
  for (let i = 1; i < sorted.length; i++) if (compare(sorted[i - 1]!.wallet, sorted[i]!.wallet) === 0)
    throw new TypeError('mining allocation: duplicate wallet');
  const leaves = Object.freeze(sorted.map(entry => entry.leaf));
  const levels = [leaves.map(leaf => ({ hash: hashMiningAllocationLeaf(leaf), sum: leaf.cumulativeKeep }))];
  while (levels[levels.length - 1]!.length > 1) {
    const previous = levels[levels.length - 1]!, next: typeof previous = [];
    for (let i = 0; i < previous.length; i += 2) {
      const left = previous[i]!, right = previous[i + 1];
      // An odd node promotes unchanged: no phantom wallet or duplicated KEEP.
      next.push(right ? { hash: hashMiningAllocationNode(left.hash, left.sum, right.hash, right.sum), sum: sum(left.sum, right.sum) } : left);
    }
    levels.push(next);
  }
  const top = levels[levels.length - 1]![0]!;
  return Object.freeze({
    get root() { return Uint8Array.from(top.hash); }, total: top.sum, leafCount: leaves.length, leaves,
    proof(index: number): MiningProofNode[] {
      if (!Number.isInteger(index) || index < 0 || index >= leaves.length) throw new RangeError('mining allocation: invalid leaf index');
      const proof: MiningProofNode[] = [];
      for (let level = 0; level < levels.length - 1; level++) {
        const siblingIndex = index ^ 1, sibling = levels[level]![siblingIndex];
        if (sibling) proof.push({ hash: Uint8Array.from(sibling.hash), sum: sibling.sum, isLeft: siblingIndex < index });
        index = Math.floor(index / 2);
      }
      return proof;
    },
  });
}
