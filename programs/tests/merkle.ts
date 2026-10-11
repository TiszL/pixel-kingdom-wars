/**
 * Tiny merkle helper mirroring shardkeep-distributor's on-chain hashing exactly:
 * - leaf = keccak256(0x00 || claimant(32) || amount_u64_le || version_u64_le)
 * - node = keccak256(0x01 || min(l, r) || max(l, r))   (sorted pair)
 * - odd nodes are promoted to the next level unchanged (no duplication)
 *
 * Domain separation (0x00 leaves / 0x01 nodes, different preimage lengths)
 * makes the 64-byte node-as-leaf second-preimage trick structurally impossible
 * (see docs/research/research-security-economy.md §6).
 */
import { keccak_256 } from "@noble/hashes/sha3";
import { PublicKey } from "@solana/web3.js";

export function u64Le(n: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
}

export function hashLeaf(claimant: PublicKey, amount: bigint, version: bigint): Buffer {
  return Buffer.from(
    keccak_256(
      Buffer.concat([Buffer.from([0x00]), claimant.toBuffer(), u64Le(amount), u64Le(version)])
    )
  );
}

export function hashNode(a: Buffer, b: Buffer): Buffer {
  const [lo, hi] = Buffer.compare(a, b) <= 0 ? [a, b] : [b, a];
  return Buffer.from(keccak_256(Buffer.concat([Buffer.from([0x01]), lo, hi])));
}

export class MerkleTree {
  /** levels[0] = leaves, last level = [root] */
  readonly levels: Buffer[][];

  constructor(leaves: Buffer[]) {
    if (leaves.length === 0) throw new Error("empty tree");
    const levels: Buffer[][] = [leaves];
    while (levels[levels.length - 1].length > 1) {
      const prev = levels[levels.length - 1];
      const next: Buffer[] = [];
      for (let i = 0; i < prev.length; i += 2) {
        if (i + 1 < prev.length) next.push(hashNode(prev[i], prev[i + 1]));
        else next.push(prev[i]); // odd node promoted unchanged
      }
      levels.push(next);
    }
    this.levels = levels;
  }

  get root(): Buffer {
    return this.levels[this.levels.length - 1][0];
  }

  proof(index: number): Buffer[] {
    const out: Buffer[] = [];
    let idx = index;
    for (let l = 0; l < this.levels.length - 1; l++) {
      const sibling = idx ^ 1;
      if (sibling < this.levels[l].length) out.push(this.levels[l][sibling]);
      idx = Math.floor(idx / 2);
    }
    return out;
  }

  /** proof formatted for the Anchor instruction arg Vec<[u8;32]> */
  proofArg(index: number): number[][] {
    return this.proof(index).map((b) => Array.from(b));
  }
}
