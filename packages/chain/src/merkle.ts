/**
 * Off-chain merkle tree matching shardkeep-distributor's on-chain verifier
 * EXACTLY (programs/shardkeep-distributor/src/lib.rs):
 *   leaf  = keccak(0x00 || claimant(32) || amount_le_u64 || version_le_u64)
 *   node  = keccak(0x01 || min(l,r) || max(l,r))   (sorted pair)
 * Domain-separated prefixes defeat second-preimage/node-as-leaf attacks
 * (research-security-economy.md §6). Odd nodes promote unchanged.
 *
 * Used by: the weekly liabilities snapshot (EpochRoot posting + per-player
 * proof-of-reserves proofs) and the TGE-sim distributor population.
 */
import { keccak_256 } from '@noble/hashes/sha3.js';
import { PublicKey } from '@solana/web3.js';

export interface MerkleLeafInput {
  /** base58 wallet. */
  wallet: string;
  /** KEEP base units (whole Shards in the alpha ledger). */
  amount: bigint;
}

const LEAF_PREFIX = 0x00;
const NODE_PREFIX = 0x01;

function u64le(n: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true);
  return b;
}

export function hashLeaf(wallet: string, amount: bigint, version: bigint): Uint8Array {
  const pk = new PublicKey(wallet).toBytes();
  const pre = new Uint8Array(1 + 32 + 8 + 8);
  pre[0] = LEAF_PREFIX;
  pre.set(pk, 1);
  pre.set(u64le(amount), 33);
  pre.set(u64le(version), 41);
  return keccak_256(pre);
}

function hashNode(a: Uint8Array, b: Uint8Array): Uint8Array {
  const [lo, hi] = compare(a, b) <= 0 ? [a, b] : [b, a];
  const pre = new Uint8Array(65);
  pre[0] = NODE_PREFIX;
  pre.set(lo, 1);
  pre.set(hi, 33);
  return keccak_256(pre);
}

function compare(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < 32; i++) {
    if (a[i]! !== b[i]!) return a[i]! - b[i]!;
  }
  return 0;
}

export interface MerkleTree {
  root: Uint8Array;
  /** Sibling path for the leaf at `index` (bottom-up). */
  proof(index: number): Uint8Array[];
  leafCount: number;
}

/**
 * Build the tree over leaves in INPUT ORDER (callers must use a stable,
 * documented order — the snapshot uses wallet-ascending). Sorted-pair node
 * hashing makes proofs order-agnostic at each level.
 */
export function buildMerkleTree(leaves: Uint8Array[]): MerkleTree {
  if (leaves.length === 0) throw new Error('merkle: no leaves');
  const levels: Uint8Array[][] = [leaves];
  while (levels[levels.length - 1]!.length > 1) {
    const prev = levels[levels.length - 1]!;
    const next: Uint8Array[] = [];
    for (let i = 0; i < prev.length; i += 2) {
      next.push(i + 1 < prev.length ? hashNode(prev[i]!, prev[i + 1]!) : prev[i]!);
    }
    levels.push(next);
  }
  return {
    root: levels[levels.length - 1]![0]!,
    leafCount: leaves.length,
    proof(index: number): Uint8Array[] {
      if (index < 0 || index >= leaves.length) throw new RangeError(`merkle: bad index ${index}`);
      const path: Uint8Array[] = [];
      let i = index;
      for (let lvl = 0; lvl < levels.length - 1; lvl++) {
        const nodes = levels[lvl]!;
        const sibling = i % 2 === 0 ? i + 1 : i - 1;
        if (sibling < nodes.length) path.push(nodes[sibling]!);
        i = Math.floor(i / 2);
      }
      return path;
    },
  };
}

/** Mirror of the on-chain verifier — for tests and client-side PoR checks. */
export function verifyProof(leaf: Uint8Array, proof: Uint8Array[], root: Uint8Array): boolean {
  let node = leaf;
  for (const sib of proof) node = hashNode(node, sib);
  return compare(node, root) === 0;
}

export function toHex(b: Uint8Array): string {
  return Buffer.from(b).toString('hex');
}
