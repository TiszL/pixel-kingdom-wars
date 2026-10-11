import { describe, expect, it } from 'vitest';
import bs58 from 'bs58';
import { buildMiningAllocationTree, decodeMiningAllocationLeaf, decodeMiningAllocationProof, decodeMiningProofNode,
  encodeMiningAllocationLeaf, encodeMiningAllocationNode, encodeMiningAllocationProof, encodeMiningProofNode,
  hashMiningAllocationLeaf, hashMiningAllocationNode, verifyMiningAllocationProof,
  MINING_ALLOCATION_MAX_DEPTH, MINING_ALLOCATION_MAX_LEAVES, MINING_ALLOCATION_U64_MAX,
  type MiningAllocationLeaf, type MiningProofNode } from './miningAllocationProof';

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const bytes = (value: string) => Uint8Array.from(Buffer.from(value, 'hex'));
// S3 make_leaf, spikes/phase-e-toolchain/spike-economy-core/src/lib.rs:349.
function spikeLeaf(i: number): MiningAllocationLeaf {
  const wallet = Buffer.alloc(32); wallet.writeBigUInt64LE(BigInt(i)); wallet[31] = 0xaa;
  return { wallet: bs58.encode(wallet), cumulativeKeep: 1000n + BigInt(i) * 7n,
    cumulativeRenown: BigInt(i % 13), cumulativeDays: BigInt(i % 30), sequence: BigInt(i + 1) };
}
const leaf0hex = '0200000000000000000000000000000000000000000000000000000000000000aae803000000000000000000000000000000000000000000000100000000000000';
const hash0 = 'e105f3ff6de90b90c56e701926ac9729e1933aadb1bdce36da3421fc0109fce7';
const hash1 = 'd1f3a0f044ae6a49d499bdddc528551416648d61e0a9980c9129155f3d142866';
const node01hex = `04${hash0}e803000000000000${hash1}ef03000000000000`;
const node01hash = '285cb8f554227b39c3ab1e14bc1fcf39dbfbbab291f0599e2c0ef779cb53e113';

describe('cumulative mining allocation byte protocol', () => {
  it('pins the 65-byte leaf and ordered 81-byte node against S3 preimages', () => {
    expect(hex(encodeMiningAllocationLeaf(spikeLeaf(0)))).toBe(leaf0hex);
    expect(decodeMiningAllocationLeaf(bytes(leaf0hex))).toEqual(spikeLeaf(0));
    expect(hex(hashMiningAllocationLeaf(spikeLeaf(0)))).toBe(hash0);
    expect(hex(hashMiningAllocationLeaf(spikeLeaf(1)))).toBe(hash1);
    expect(hex(encodeMiningAllocationNode(bytes(hash0), 1000n, bytes(hash1), 1007n))).toBe(node01hex);
    expect(hex(hashMiningAllocationNode(bytes(hash0), 1000n, bytes(hash1), 1007n))).toBe(node01hash);
    expect(hex(hashMiningAllocationNode(bytes(hash1), 1007n, bytes(hash0), 1000n))).not.toBe(node01hash);
  });

  it('pins the independent published S3 depth-14 root in the spike input order', () => {
    // S3 predates canonical publisher ordering. Recreate ONLY its pair topology
    // here to compare the recorded Rust result (SPIKES.md S3), not a new vector
    // computed by the production tree builder under test.
    let level = Array.from({ length: 16384 }, (_, i) => ({ hash: hashMiningAllocationLeaf(spikeLeaf(i)), sum: spikeLeaf(i).cumulativeKeep }));
    while (level.length > 1) {
      const next: typeof level = [];
      for (let i = 0; i < level.length; i += 2) {
        const l = level[i]!, r = level[i + 1]!;
        next.push({ hash: hashMiningAllocationNode(l.hash, l.sum, r.hash, r.sum), sum: l.sum + r.sum });
      }
      level = next;
    }
    expect(hex(level[0]!.hash)).toBe('bc0a648767fd2249868b97a0863ad3060fa7794ff6f844467724378071f82b1c');
    expect(level[0]!.sum).toBe(955850752n);
  }, 20_000);

  it('encodes each proof node as 41 bytes and the proof as a canonical Borsh Vec', () => {
    const left: MiningProofNode = { hash: bytes(hash0), sum: 1000n, isLeft: true };
    const right: MiningProofNode = { hash: bytes(hash1), sum: 1007n, isLeft: false };
    expect(hex(encodeMiningProofNode(left))).toBe(`${hash0}e80300000000000001`);
    expect(hex(encodeMiningProofNode(right))).toBe(`${hash1}ef0300000000000000`);
    expect(hex(encodeMiningAllocationProof([left, right]))).toBe(`02000000${hash0}e80300000000000001${hash1}ef0300000000000000`);
    expect(decodeMiningAllocationProof(encodeMiningAllocationProof([left, right]))).toEqual([left, right]);
    expect(hex(encodeMiningAllocationProof([]))).toBe('00000000');
    expect(decodeMiningAllocationProof(bytes('00000000'))).toEqual([]);
  });

  it('sorts by decoded wallet bytes, independent of input/base58 lexical order', () => {
    const leaves = [spikeLeaf(1), spikeLeaf(256), spikeLeaf(2)];
    const tree = buildMiningAllocationTree(leaves);
    expect(tree.leaves.map(l => l.wallet)).toEqual([spikeLeaf(256), spikeLeaf(1), spikeLeaf(2)].map(l => l.wallet));
    expect(tree.root).toEqual(buildMiningAllocationTree([...leaves].reverse()).root);
    expect(tree.total).toBe(leaves.reduce((n, l) => n + l.cumulativeKeep, 0n));
    for (let i = 0; i < tree.leafCount; i++) expect(verifyMiningAllocationProof(tree.leaves[i]!, tree.proof(i), tree.root, tree.total)).toBe(true);
  });

  it('promotes odd nodes without duplicating their sum or inventing leaves', () => {
    const tree = buildMiningAllocationTree([spikeLeaf(0), spikeLeaf(1), spikeLeaf(2)]);
    expect(tree.total).toBe(3021n); expect(tree.leafCount).toBe(3);
    expect(tree.proof(2)).toEqual([{ hash: bytes(node01hash), sum: 2007n, isLeft: true }]);
    expect(tree.proof(0)).toHaveLength(2);
    expect(verifyMiningAllocationProof(tree.leaves[2]!, tree.proof(2), tree.root, tree.total)).toBe(true);
  });

  it('supports a singleton including zero KEEP, without inventing an empty root', () => {
    const leaf = { ...spikeLeaf(0), cumulativeKeep: 0n }, tree = buildMiningAllocationTree([leaf]);
    expect(tree.root).toEqual(hashMiningAllocationLeaf(leaf)); expect(tree.total).toBe(0n);
    expect(tree.proof(0)).toEqual([]); expect(verifyMiningAllocationProof(leaf, [], tree.root, 0n)).toBe(true);
    expect(() => buildMiningAllocationTree([])).toThrow();
  });

  it.each(['wallet', 'cumulativeKeep', 'cumulativeRenown', 'cumulativeDays', 'sequence'] as const)('binds %s and rejects tampered claims', field => {
    const tree = buildMiningAllocationTree([spikeLeaf(0), spikeLeaf(1)]), leaf = { ...tree.leaves[0]! };
    if (field === 'wallet') leaf.wallet = spikeLeaf(2).wallet; else leaf[field] += 1n;
    expect(verifyMiningAllocationProof(leaf, tree.proof(0), tree.root, tree.total)).toBe(false);
  });

  it('binds sibling hash, sum, side, root and total independently', () => {
    const tree = buildMiningAllocationTree([spikeLeaf(0), spikeLeaf(1)]), leaf = tree.leaves[0]!;
    const proof = tree.proof(0), node = proof[0]!;
    for (const changed of [{ ...node, hash: new Uint8Array(32) }, { ...node, sum: node.sum + 1n }, { ...node, isLeft: !node.isLeft }])
      expect(verifyMiningAllocationProof(leaf, [changed], tree.root, tree.total)).toBe(false);
    expect(verifyMiningAllocationProof(leaf, [], tree.root, tree.total)).toBe(false);
    expect(verifyMiningAllocationProof(leaf, proof, new Uint8Array(32), tree.total)).toBe(false);
    expect(verifyMiningAllocationProof(leaf, proof, tree.root, tree.total + 1n)).toBe(false);
  });

  it('rejects malformed base58, duplicate wallets, unsafe numbers and every u64 overflow', () => {
    for (const wallet of ['', '0', '0'.repeat(32), ` ${spikeLeaf(0).wallet}`, `1${spikeLeaf(0).wallet}`, bs58.encode(new Uint8Array(31))])
      expect(() => encodeMiningAllocationLeaf({ ...spikeLeaf(0), wallet })).toThrow(TypeError);
    expect(() => buildMiningAllocationTree([spikeLeaf(0), { ...spikeLeaf(0), cumulativeKeep: 1n }])).toThrow();
    for (const field of ['cumulativeKeep', 'cumulativeRenown', 'cumulativeDays', 'sequence'] as const)
      for (const value of [-1n, MINING_ALLOCATION_U64_MAX + 1n, 1, Number.MAX_SAFE_INTEGER + 1, '1', null])
        expect(() => encodeMiningAllocationLeaf({ ...spikeLeaf(0), [field]: value } as MiningAllocationLeaf)).toThrow();
    const max = { ...spikeLeaf(0), cumulativeKeep: MINING_ALLOCATION_U64_MAX };
    expect(decodeMiningAllocationLeaf(encodeMiningAllocationLeaf(max))).toEqual(max);
    expect(() => buildMiningAllocationTree([max, spikeLeaf(1)])).toThrow();
    expect(() => encodeMiningAllocationNode(bytes(hash0), MINING_ALLOCATION_U64_MAX, bytes(hash1), 1n)).toThrow();
    expect(verifyMiningAllocationProof(max, [{ hash: bytes(hash1), sum: 1n, isLeft: false }], bytes(hash0), 0n)).toBe(false);
  });

  it('rejects wrong domains, lengths, noncanonical booleans, trailing bytes and depth >16', () => {
    for (const input of [new Uint8Array(64), new Uint8Array(66), Uint8Array.from([0, ...bytes(leaf0hex).slice(1)])])
      expect(() => decodeMiningAllocationLeaf(input)).toThrow();
    for (const length of [31, 33]) expect(() => encodeMiningAllocationNode(new Uint8Array(length), 0n, bytes(hash1), 0n)).toThrow();
    for (const input of [new Uint8Array(40), new Uint8Array(42), Uint8Array.from([...bytes(hash0), ...new Uint8Array(8), 2])])
      expect(() => decodeMiningProofNode(input)).toThrow();
    const node: MiningProofNode = { hash: bytes(hash0), sum: 0n, isLeft: false };
    expect(() => encodeMiningProofNode({ ...node, isLeft: 1 as unknown as boolean })).toThrow();
    for (const input of [new Uint8Array(0), bytes('01000000'), bytes('0000000000'), bytes('11000000'), bytes('ffffffff')])
      expect(() => decodeMiningAllocationProof(input)).toThrow();
    expect(() => encodeMiningAllocationProof(Array(17).fill(node))).toThrow();
    expect(verifyMiningAllocationProof(spikeLeaf(0), Array(17).fill(node), bytes(hash0), 1000n)).toBe(false);
    expect(verifyMiningAllocationProof(spikeLeaf(0), [node], new Uint8Array(31), 1000n)).toBe(false);
    expect(verifyMiningAllocationProof(spikeLeaf(0), [node], bytes(hash0), 1000 as unknown as bigint)).toBe(false);
  });

  it('defensively copies inputs, exposed roots, leaf metadata and proof buffers', () => {
    const leaves = [spikeLeaf(0), spikeLeaf(1)], tree = buildMiningAllocationTree(leaves), root = tree.root;
    leaves[0]!.cumulativeKeep = 999n; leaves.reverse(); tree.root.fill(0);
    const proof = tree.proof(0); proof[0]!.hash.fill(0); proof[0]!.sum = 0n;
    expect(() => { (tree.leaves[0] as MiningAllocationLeaf).wallet = spikeLeaf(2).wallet; }).toThrow();
    expect(tree.root).toEqual(root); expect(verifyMiningAllocationProof(tree.leaves[0]!, tree.proof(0), tree.root, tree.total)).toBe(true);
    const encoded = encodeMiningAllocationProof(tree.proof(0)), decoded = decodeMiningAllocationProof(encoded);
    encoded.fill(0); expect(decoded).toEqual(tree.proof(0));
    for (const index of [-1, 0.5, NaN, Infinity, 2, Number.MAX_SAFE_INTEGER]) expect(() => tree.proof(index)).toThrow();
  });

  it('accepts the exact 65536-leaf/depth16 bound and refuses a 65537th leaf before hashing', () => {
    expect(MINING_ALLOCATION_MAX_DEPTH).toBe(16); expect(MINING_ALLOCATION_MAX_LEAVES).toBe(65536);
    expect(() => buildMiningAllocationTree(Array(MINING_ALLOCATION_MAX_LEAVES + 1).fill(spikeLeaf(0)))).toThrow();
    const tree = buildMiningAllocationTree(Array.from({ length: MINING_ALLOCATION_MAX_LEAVES }, (_, i) => spikeLeaf(i)));
    for (const i of [0, 1, 32767, 65535]) {
      expect(tree.proof(i)).toHaveLength(16);
      expect(encodeMiningAllocationProof(tree.proof(i))).toHaveLength(4 + 16 * 41);
      expect(verifyMiningAllocationProof(tree.leaves[i]!, tree.proof(i), tree.root, tree.total)).toBe(true);
    }
  }, 30_000);
});
