import { keccak_256 } from '@noble/hashes/sha3.js';
import { PublicKey } from '@solana/web3.js';
import { PHASE_E_LEAGUE_REWARDS } from '@shardkeep/shared';
import { describe, expect, it } from 'vitest';
import {
  LEAGUE_PROGRAM_ID, LEAGUE_WEEK_SEC, MONDAY_OFFSET_SEC, MAX_PROOF_DEPTH,
  LeagueProofError, buildTree, decodeProof, encodeProof, hashLeaf, hashNode,
  leafPreimage, nodePreimage, verifyProof, type Leaf, type ProofNode,
} from './leagueClaimProof';

// Independent OpenSSL 3.6.1 KECCAK-256 pins; empty-input KAT passed before derivation.
// Fixed wire vectors, not game policy; identical literals are in proof.rs.
const P1_LEAF_HEX = 'b5020bedeca14d0cff2dcfd129fd2b7f062cafd90d6a54c0496aacb70cb8e589';
const P2_NODE_HEX = '27b371b23ef1b3eee41127a0478445cbec4e2560973c69232096f2857d91b283';
const P3_EMPTY_HEX = 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470';
const P4_TWO_ROOT_HEX = '5412a7764d1065386cd8d4ff2abf612a2fc5ebf64f9521bae1f92ea45d2fcec1';
const P4_THREE_ROOT_HEX = '43281f6c0cca6cfa9e86f25220a36a2c28599ce683b80ca1812f8bf57a5c5099';
const P5_ROOT_HEX = '4f1ff6117728475172dda7d2c35f811a80b38fc56bbf375063e3c3d15be84b08';
const P5_PROOF_0_HEX = '09000000deb8e1c159156beda32f8fe99f868506abef52986ff341ff746ac6cc11b27c0c020000000000000000122ff1a10cfadc33c26827d9c391af81fe1b9ec03ccaf06adb1d097a28465115070000000000000000048e39850b6cf2d6f3eb2d965fe72648437ffce316811e4db75e609dadf91f5c1a000000000000000099bd0dbc08313068f440e079eff1c0d4dac32aef65f9ab3aa65c3f7d13f1d63b640000000000000000f574f5eaa6f88c659a0126866b257a6d5febd1e591692479c34fd977a97ea22d88010000000000000090edb142dbf637e4de8a361d343c995cf0e266de1b4541ddec09a7f6963d8f9c100600000000000000630a62d1dfe5a29b7795410ae0f8ae449ef0ed40383c98728ff07f4eddf5c8c0201800000000000000ba4a7ec9a8152c890a28742a45d48179cdf6279d337348ce68df186909f1f332406000000000000000382ba5c12406fb642ae35fa433a9bbe18592591fa0bf7b21b37c0c7f1e44aea8c26801000000000000';
const P5_PROOF_499_HEX = '07000000422f201ecc0e111ca98bb8daf0cdd2531534376b4d4c7a9197708b90b642d8bff301000000000000017958c3c3632f1014548954f8fdb132a3f05e11939f223adf357012bbfc1ef347e30300000000000001b79a70c57c34d9c8d1b2fcb220d20eefa5960dd3cc6c393a3b4c6c71c57b76d6881e000000000000013ec318eb214428764ac6ec8ab5e63bb4c59d615512e8f64b5ec3c76d530fccbf103a00000000000001bbe96ffd6cdd5ac128522247c05a4f77e9c2b843eb61c8fb339f0ea0044ab9252068000000000000016f5de58abebd3611a21ca21f1440e08e13d9c6d3a9435171d838382d58dfdae440a0000000000000014522ebe1d53f12e67a51196871500f2ef5f799c0910aefb4fe0e764b65486671808000000000000001';

// Authored before implementation. No test or fixture generator ran in MS-LC.
const key = (byte: number) => new PublicKey(new Uint8Array(32).fill(byte));
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const U64_MAX = (1n << 64n) - 1n;
const fixture = (index = 0): Leaf => ({ programId: key(0x11), config: key(0x22),
  weekStart: 345600n, index, claimant: key(0x33), amount: BigInt(index + 1) });
const policy = { maxPlaces: PHASE_E_LEAGUE_REWARDS.v1.skr.maxPlaces };
function code(action: () => unknown, expected: string): void {
  let error: unknown;
  try { action(); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(LeagueProofError);
  expect((error as LeagueProofError).code).toBe(expected);
}
// Independent byte concatenation, intentionally does not call the production
// encoders. Literal preimages below pin the endian/domain layout independently.
function referenceLeaf(leaf: Leaf): Uint8Array {
  const week = Buffer.alloc(8), index = Buffer.alloc(2), amount = Buffer.alloc(8);
  week.writeBigInt64LE(leaf.weekStart); index.writeUInt16LE(leaf.index); amount.writeBigUInt64LE(leaf.amount);
  return keccak_256(Buffer.concat([Buffer.from([6]), leaf.programId.toBuffer(), leaf.config.toBuffer(),
    week, index, leaf.claimant.toBuffer(), amount]));
}
function referenceNode(left: Uint8Array, leftSum: bigint, right: Uint8Array, rightSum: bigint): Uint8Array {
  const a = Buffer.alloc(8), b = Buffer.alloc(8); a.writeBigUInt64LE(leftSum); b.writeBigUInt64LE(rightSum);
  return keccak_256(Buffer.concat([Buffer.from([7]), Buffer.from(left), a, Buffer.from(right), b]));
}

describe('league claim proof: 7002e405 ordered sum-Merkle protocol', () => {
  it('P3: matches the independent empty-input Keccak known answer', () => {
    expect(hex(keccak_256(new Uint8Array()))).toBe(P3_EMPTY_HEX);
  });

  it('01: pins the exact 115-byte leaf and 81-byte node preimages', () => {
    const leaf = { ...fixture(257), amount: 0x0102030405060708n };
    const expected = `06${'11'.repeat(32)}${'22'.repeat(32)}00460500000000000101${'33'.repeat(32)}0807060504030201`;
    expect(hex(leafPreimage(leaf))).toBe(expected); expect(leafPreimage(leaf)).toHaveLength(115);
    expect(hashLeaf(leaf)).toEqual(keccak_256(Buffer.from(expected, 'hex')));
    expect(hex(hashLeaf(leaf))).toBe(P1_LEAF_HEX);
    const left = new Uint8Array(32).fill(0x44), right = new Uint8Array(32).fill(0x55);
    const node = `07${'44'.repeat(32)}0100000000000000${'55'.repeat(32)}0200000000000000`;
    expect(hex(nodePreimage(left, 1n, right, 2n))).toBe(node);
    expect(nodePreimage(left, 1n, right, 2n)).toHaveLength(81);
    expect(hashNode(left, 1n, right, 2n)).toEqual(keccak_256(Buffer.from(node, 'hex')));
    expect(hex(hashNode(left, 1n, right, 2n))).toBe(P2_NODE_HEX);
  });

  it.each(['programId', 'config', 'weekStart', 'index', 'claimant', 'amount'] as const)
    ('02: binds leaf field %s (well-formed mismatch = false)', field => {
      const original = fixture(), tree = buildTree([original, fixture(1)], policy);
      const changed = { ...original };
      if (field === 'programId' || field === 'config' || field === 'claimant') changed[field] = key(0x77);
      else if (field === 'index') changed.index = 2;
      else changed[field] += 1n;
      expect(verifyProof(changed, tree.getProof(0), tree.root, tree.total)).toBe(false);
    });

  it('03: binds each sibling hash/sum/side, the root and the total', () => {
    const leaf = fixture(), tree = buildTree([leaf, fixture(1)], policy), sibling = tree.getProof(0)[0]!;
    for (const changed of [{ ...sibling, hash: new Uint8Array(32) }, { ...sibling, sum: sibling.sum + 1n },
      { ...sibling, isLeft: !sibling.isLeft }]) expect(verifyProof(leaf, [changed], tree.root, tree.total)).toBe(false);
    expect(verifyProof(leaf, [], tree.root, tree.total)).toBe(false);
    expect(verifyProof(leaf, tree.getProof(0), new Uint8Array(32), tree.total)).toBe(false);
    expect(verifyProof(leaf, tree.getProof(0), tree.root, tree.total + 1n)).toBe(false);
  });

  it('04: refuses node-as-leaf and mining/distributor hash domains', () => {
    const leaf = fixture(), next = fixture(1), sibling: ProofNode = { hash: hashLeaf(next), sum: next.amount, isLeft: false };
    for (const domain of [0x00, 0x02]) {
      const bytes = leafPreimage(leaf); bytes[0] = domain;
      expect(verifyProof(leaf, [], keccak_256(bytes), leaf.amount)).toBe(false);
    }
    const node = nodePreimage(hashLeaf(leaf), leaf.amount, sibling.hash, sibling.sum);
    expect(verifyProof(leaf, [], keccak_256(node), leaf.amount)).toBe(false);
    for (const domain of [0x01, 0x04]) {
      const bytes = node.slice(); bytes[0] = domain;
      expect(verifyProof(leaf, [sibling], keccak_256(bytes), leaf.amount + sibling.sum)).toBe(false);
    }
  });

  it('05: accepts depth 10 and refuses depth 11 with ProofTooDeep', () => {
    const leaf = fixture(), proof: ProofNode[] = []; let root = referenceLeaf(leaf), total = leaf.amount;
    for (let depth = 1; depth <= MAX_PROOF_DEPTH + 1; depth++) {
      const sibling = { hash: new Uint8Array(32).fill(depth), sum: 1n, isLeft: depth % 2 === 0 };
      root = sibling.isLeft ? referenceNode(sibling.hash, 1n, root, total) : referenceNode(root, total, sibling.hash, 1n);
      total += 1n; proof.push(sibling);
      if (depth <= MAX_PROOF_DEPTH) expect(verifyProof(leaf, proof, root, total)).toBe(true);
      else code(() => verifyProof(leaf, proof, root, total), 'ProofTooDeep');
    }
    expect(MAX_PROOF_DEPTH).toBe(10);
  });

  it('06: checks node and running u64 sums with ArithmeticOverflow', () => {
    const leaf = { ...fixture(), amount: U64_MAX }, sibling = { hash: hashLeaf(fixture(1)), sum: 1n, isLeft: false };
    expect(verifyProof(leaf, [], hashLeaf(leaf), U64_MAX)).toBe(true);
    code(() => hashNode(hashLeaf(leaf), U64_MAX, sibling.hash, 1n), 'ArithmeticOverflow');
    for (const isLeft of [false, true]) code(() => verifyProof(leaf, [{ ...sibling, isLeft }], new Uint8Array(32), 1n), 'ArithmeticOverflow');
    code(() => buildTree([leaf, fixture(1)], policy), 'ArithmeticOverflow');
  });

  it('07: singleton and odd-node promotion neither duplicate sums nor invent siblings', () => {
    const lastIndex = policy.maxPlaces - 1, lastLeaf = fixture(lastIndex);
    const singleton = buildTree([lastLeaf], policy);
    expect(singleton.root).toEqual(hashLeaf(lastLeaf)); expect(singleton.getProof(lastIndex)).toEqual([]);
    expect(verifyProof(lastLeaf, [], singleton.root, singleton.total)).toBe(true);
    const pair = buildTree([fixture(), fixture(1)], policy);
    expect(hex(pair.root)).toBe(P4_TWO_ROOT_HEX); expect(pair.total).toBe(3n);
    expect(verifyProof(fixture(), pair.getProof(0), Buffer.from(P4_TWO_ROOT_HEX, 'hex'), 3n)).toBe(true);
    const tree = buildTree([fixture(2), fixture(), fixture(1)], policy);
    expect(hex(tree.root)).toBe(P4_THREE_ROOT_HEX);
    expect(verifyProof(fixture(2), tree.getProof(2), Buffer.from(P4_THREE_ROOT_HEX, 'hex'), 6n)).toBe(true);
    expect(tree.total).toBe(6n); expect(tree.leaves.map(l => l.index)).toEqual([0, 1, 2]);
    expect(tree.getProof(2)).toEqual([{ hash: referenceNode(referenceLeaf(fixture()), 1n, referenceLeaf(fixture(1)), 2n), sum: 3n, isLeft: true }]);
    for (const leaf of tree.leaves) expect(verifyProof(leaf, tree.getProof(leaf.index), tree.root, tree.total)).toBe(true);
  });

  it('39/MIN-1: policy-sized maximum tree has deterministic ordering and conserves all leaf sums', () => {
    const leaves = Array.from({ length: policy.maxPlaces }, (_, i) => fixture(i));
    const tree = buildTree(leaves, policy), reversed = buildTree([...leaves].reverse(), policy);
    const count = BigInt(policy.maxPlaces), treeDepth = Math.ceil(Math.log2(policy.maxPlaces));
    expect(tree.root).toEqual(reversed.root); expect(tree.total).toBe(count * (count + 1n) / 2n);
    expect(tree.leafCount).toBe(policy.maxPlaces);
    expect(treeDepth).toBeLessThanOrEqual(MAX_PROOF_DEPTH);
    for (const leaf of leaves) {
      const proof = tree.getProof(leaf.index); expect(proof.length).toBeLessThanOrEqual(treeDepth);
      expect(verifyProof(leaf, proof, tree.root, tree.total)).toBe(true);
    }
  });

  it('08/P5: keeps the fixed 500-leaf fixture separate from the policy maximum', () => {
    // This fixed wire fixture is deliberately independent of changing game policy.
    const leaves = Array.from({ length: 500 }, (_, i) => fixture(i));
    const tree = buildTree(leaves, { maxPlaces: 500 });
    expect(tree.leafCount).toBe(500); expect(tree.total).toBe(125250n);
    expect(hex(tree.root)).toBe(P5_ROOT_HEX);
    for (const [index, depth] of [[0, 9], [499, 7]] as const) {
      const proof = tree.getProof(index); expect(proof).toHaveLength(depth);
      const expected = index === 0 ? P5_PROOF_0_HEX : P5_PROOF_499_HEX;
      expect(hex(encodeProof(proof))).toBe(expected);
      const pinnedProof = decodeProof(Uint8Array.from(Buffer.from(expected, 'hex')));
      expect(proof).toEqual(pinnedProof);
      expect(verifyProof(fixture(index), pinnedProof, Buffer.from(P5_ROOT_HEX, 'hex'), 125250n)).toBe(true);
      expect(verifyProof(fixture(index), proof, tree.root, tree.total)).toBe(true);
    }
    // Literal roots and complete Borsh proofs bind the independently hashed fixed vector.
  });

  it('requires unique sparse entitlement indexes and one common deployment/week', () => {
    code(() => buildTree([fixture(), fixture()], policy), 'DuplicateIndex');
    code(() => buildTree([], policy), 'InvalidLeafCount');
    code(() => buildTree([fixture(policy.maxPlaces)], policy), 'InvalidIndex');
    code(() => buildTree(Array.from({ length: policy.maxPlaces + 1 }, (_, i) => fixture(i)), policy), 'InvalidLeafCount');
    for (const change of [{ programId: key(1) }, { config: key(2) }, { weekStart: fixture().weekStart + LEAGUE_WEEK_SEC }])
      code(() => buildTree([fixture(), { ...fixture(1), ...change }], policy), 'InvalidTreeContext');
    code(() => buildTree([{ ...fixture(), amount: 0n }], policy), 'InvalidAmount');
    code(() => buildTree([fixture()], { maxPlaces: 0 }), 'InvalidPolicy');
    code(() => buildTree([fixture()], { maxPlaces: 1025 }), 'InvalidPolicy');
    code(() => buildTree([fixture()], { maxPlaces: 0.5 }), 'InvalidPolicy');
    code(() => buildTree([fixture()], policy).getProof(1), 'InvalidIndex');
  });

  it('refuses malformed keys, integer bounds and proof nodes with stable codes', () => {
    for (const index of [-1, 65536, 1.5, NaN, Infinity]) code(() => hashLeaf({ ...fixture(), index }), 'InvalidIndex');
    for (const amount of [-1n, U64_MAX + 1n, 1 as unknown as bigint]) code(() => hashLeaf({ ...fixture(), amount }), 'InvalidAmount');
    for (const weekStart of [-(1n << 63n) - 1n, 1n << 63n, 1 as unknown as bigint]) code(() => hashLeaf({ ...fixture(), weekStart }), 'InvalidWeekStart');
    code(() => hashLeaf({ ...fixture(), programId: 'bad' as unknown as PublicKey }), 'InvalidPublicKey');
    const node: ProofNode = { hash: new Uint8Array(32), sum: 0n, isLeft: false };
    for (const hash of [new Uint8Array(31), new Uint8Array(33)]) code(() => encodeProof([{ ...node, hash }]), 'InvalidProof');
    code(() => encodeProof([{ ...node, isLeft: 1 as unknown as boolean }]), 'InvalidProof');
    code(() => verifyProof(fixture(), [], new Uint8Array(31), 1n), 'InvalidProof');
    code(() => verifyProof(fixture(), [], hashLeaf(fixture()), -1n), 'InvalidAmount');
  });

  it('pins 41-byte ProofNode and strict Borsh Vec encoding', () => {
    const node: ProofNode = { hash: new Uint8Array(32).fill(0x44), sum: 1n, isLeft: true };
    const bytes = encodeProof([node]); expect(hex(bytes)).toBe(`01000000${'44'.repeat(32)}010000000000000001`);
    expect(bytes).toHaveLength(45); expect(decodeProof(bytes)).toEqual([node]);
    expect(hex(encodeProof([]))).toBe('00000000'); expect(decodeProof(new Uint8Array(4))).toEqual([]);
    for (const invalid of [new Uint8Array(0), bytes.slice(0, -1), Uint8Array.from([...bytes, 0]), Uint8Array.from([0, 0, 0, 0, 0])])
      code(() => decodeProof(invalid), 'InvalidProof');
    const badBool = bytes.slice(); badBool[44] = 2; code(() => decodeProof(badBool), 'InvalidProof');
    code(() => decodeProof(Uint8Array.from([11, 0, 0, 0])), 'ProofTooDeep');
    code(() => encodeProof(Array(11).fill(node)), 'ProofTooDeep');
  });

  it('copies input/output buffers so callers cannot mutate the committed tree', () => {
    const leaves = [fixture(), fixture(1)], tree = buildTree(leaves, policy), root = tree.root;
    leaves[0]!.amount = 99n; tree.root.fill(0); tree.getProof(0)[0]!.hash.fill(0);
    expect(tree.root).toEqual(root); expect(verifyProof(fixture(), tree.getProof(0), tree.root, tree.total)).toBe(true);
    const proof = encodeProof(tree.getProof(0)), decoded = decodeProof(proof); proof.fill(0);
    expect(decoded).toEqual(tree.getProof(0));
  });

  it('A13/A15: pins the owner program id and local calendar protocol facts', () => {
    expect(LEAGUE_PROGRAM_ID.toBase58()).toBe('2x3PP9GeyvcwvrBCwAjYacTaaLRMhXbzBnRLDAWtninE');
    expect(LEAGUE_WEEK_SEC).toBe(7n * 86400n); expect(MONDAY_OFFSET_SEC).toBe(345600n);
    expect((1791158400n - MONDAY_OFFSET_SEC) % LEAGUE_WEEK_SEC).toBe(0n);
    expect((1791158401n - MONDAY_OFFSET_SEC) % LEAGUE_WEEK_SEC).not.toBe(0n);
  });
});
