import { buildMiningAllocationTree, MINING_ALLOCATION_MAX_LEAVES,
  type MiningAllocationLeaf } from '@shardkeep/chain/mining-allocation';
import { PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { auditMiningAllocation, MiningAllocationAuditError } from '../src/mining/allocationAudit';

const wallet = (byte: number) => new PublicKey(new Uint8Array(32).fill(byte)).toBase58();
const leaf = (byte: number, sequence: bigint, cumulativeKeep = 0n, cumulativeRenown = 0n,
  cumulativeDays = cumulativeRenown): MiningAllocationLeaf => ({
  wallet: wallet(byte), sequence, cumulativeKeep, cumulativeRenown, cumulativeDays,
});
function publication(leaves: readonly MiningAllocationLeaf[]) {
  const tree = buildMiningAllocationTree(leaves);
  return { sequence: leaves[0]!.sequence, root: Buffer.from(tree.root).toString('hex'),
    total: tree.total, leafCount: tree.leafCount, leaves: [...leaves] };
}
function fixture() {
  return {
    previousPublication: publication([leaf(1, 1n, 10n, 1n), leaf(2, 1n, 20n, 2n)]),
    nextPublication: publication([leaf(1, 2n, 15n, 2n), leaf(2, 2n, 25n, 2n), leaf(3, 2n, 10n, 1n)]),
  };
}
function refuses(input: unknown, code: MiningAllocationAuditError['code']) {
  expect(() => auditMiningAllocation(input)).toThrow(MiningAllocationAuditError);
  try { auditMiningAllocation(input); } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

describe('read-only cumulative mining allocation audit', () => {
  it('recomputes both full net commitments without claiming funding, term, score or publication authority', () => {
    const result = auditMiningAllocation(fixture());
    expect(result).toMatchObject({ netCommitmentValid: true, publicationAuthorized: false,
      previousTotal: 30n, nextTotal: 50n, incrementalNetKeep: 20n,
      retainedWallets: 2, newWallets: 1 });
    expect(result.unverified).toEqual(['published-history', 'funding', 'tax-backing', 'score-fairness']);
  });

  it('requires an explicit empty baseline for the first publication rather than inferring one from missing input', () => {
    const nextPublication = publication([leaf(1, 1n)]);
    expect(auditMiningAllocation({ previousPublication: null, nextPublication })).toMatchObject({
      previousPublication: null, previousTotal: 0n, nextTotal: 0n, incrementalNetKeep: 0n,
      retainedWallets: 0, newWallets: 1,
    });
    refuses({ nextPublication }, 'INVALID_INPUT');
    refuses({ previousPublication: null, nextPublication: publication([leaf(1, 2n)]) }, 'SEQUENCE_MISMATCH');
  });

  it('requires the next consecutive publication sequence; unprovided revocation history cannot justify a gap', () => {
    for (const sequence of [0n, 1n, 3n]) {
      const value = fixture();
      value.nextPublication = publication(value.nextPublication.leaves.map(row => ({ ...row, sequence })));
      refuses(value, 'SEQUENCE_MISMATCH');
    }
    const max = (1n << 64n) - 1n;
    refuses({ previousPublication: publication([leaf(1, max)]), nextPublication: publication([leaf(1, max)]) },
      'SEQUENCE_MISMATCH');
  });

  it('binds every leaf to its own declared publication sequence', () => {
    const value = fixture();
    value.nextPublication = publication([leaf(1, 2n, 15n, 2n), leaf(2, 2n, 25n, 2n)]);
    value.nextPublication.leaves[1] = { ...value.nextPublication.leaves[1]!, sequence: 1n };
    refuses(value, 'SEQUENCE_MISMATCH');
    const previous = fixture();
    previous.previousPublication.sequence = 2n;
    refuses(previous, 'SEQUENCE_MISMATCH');
  });

  it.each(['previousPublication', 'nextPublication'] as const)(
    'recomputes declared root, total and count for %s rather than trusting a highwater or summary', scope => {
      for (const patch of [{ root: '00'.repeat(32) }, { total: 99n }, { leafCount: 9 }]) {
        const value = fixture(); value[scope] = { ...value[scope], ...patch };
        refuses(value, 'COMMITMENT_MISMATCH');
      }
    });

  it('refuses a valid recomputed root that drops an earlier funded wallet', () => {
    const value = fixture();
    value.nextPublication = publication([leaf(1, 2n, 50n, 2n)]);
    refuses(value, 'PRIOR_WALLET_OMITTED');
  });

  it('retains zero-KEEP Renown and participation history as well as zero-valued prior leaves', () => {
    const previousPublication = publication([leaf(1, 1n, 0n, 2n), leaf(2, 1n)]);
    for (const leaves of [[leaf(2, 2n)], [leaf(1, 2n, 0n, 2n)]])
      refuses({ previousPublication, nextPublication: publication(leaves) }, 'PRIOR_WALLET_OMITTED');
  });

  it.each(['cumulativeKeep', 'cumulativeRenown', 'cumulativeDays'] as const)(
    'refuses %s regression even when another wallet raises the root total', field => {
      const value = fixture();
      value.nextPublication = publication([
        { ...leaf(1, 2n, 15n, 2n), [field]: 0n }, leaf(2, 2n, 50n, 3n),
      ]);
      refuses(value, 'CUMULATIVE_REGRESSION');
    });

  it('permits unchanged funded rights and a Renown-only advance without inventing a KEEP payout', () => {
    const value = fixture();
    value.nextPublication = publication([leaf(1, 2n, 10n, 2n), leaf(2, 2n, 20n, 2n)]);
    expect(auditMiningAllocation(value)).toMatchObject({ nextTotal: 30n, incrementalNetKeep: 0n,
      retainedWallets: 2, newWallets: 0, publicationAuthorized: false });
  });

  it('refuses duplicate wallets, malformed leaf values and missing full leaf sets', () => {
    const duplicate = fixture(); duplicate.nextPublication.leaves.push({ ...duplicate.nextPublication.leaves[0]! });
    refuses(duplicate, 'INVALID_LEAF_SET');
    for (const patch of [{ cumulativeKeep: -1n }, { cumulativeDays: 1 }, { wallet: 'invalid' }, { wallet: '0'.repeat(32) },
      { cumulativeKeep: 1n << 64n }, { allocated: true }]) {
      const value = fixture();
      refuses({ ...value, nextPublication: { ...value.nextPublication,
        leaves: [{ ...value.nextPublication.leaves[0], ...patch }] } }, 'INVALID_LEAF_SET');
    }
    const value = fixture();
    refuses({ ...value, nextPublication: { ...value.nextPublication, leaves: [] } }, 'INVALID_LEAF_SET');
  });

  it('refuses claimed funding, highwater and tax aggregates instead of upgrading net audit scope', () => {
    const value = fixture();
    for (const extra of [{ funded: true }, { grossTotal: 100n }, { taxHighwater: 0n }, { playerHighwater: 50n }])
      refuses({ ...value, nextPublication: { ...value.nextPublication, ...extra } }, 'INVALID_PUBLICATION');
    refuses({ ...value, publicationAuthorized: true }, 'INVALID_INPUT');
  });

  it('bounds both full leaf-set work and the declared count before recomputing any tree', () => {
    const value = fixture();
    for (const patch of [{ leafCount: MINING_ALLOCATION_MAX_LEAVES + 1 },
      { leaves: new Array(MINING_ALLOCATION_MAX_LEAVES + 1) }])
      refuses({ ...value, nextPublication: { ...value.nextPublication, ...patch } }, 'INVALID_PUBLICATION');
  });

  it('refuses oversized declarations before inspecting any leaf element', () => {
    const value = fixture();
    const leaves = new Array(MINING_ALLOCATION_MAX_LEAVES + 1);
    Object.defineProperty(leaves, 0, { get() { throw new Error('oversized leaf array was traversed'); } });
    refuses({ ...value, nextPublication: { ...value.nextPublication, leaves } }, 'INVALID_PUBLICATION');
  });

  it('requires canonical declaration scalars and lowercase root bytes', () => {
    for (const patch of [{ sequence: '2' }, { total: 50 }, { total: -1n }, { total: 1n << 64n },
      { leafCount: 1.5 }, { root: 'AB'.repeat(32) }, { root: '00'.repeat(32) + '\n' }]) {
      const value = fixture();
      refuses({ ...value, nextPublication: { ...value.nextPublication, ...patch } }, 'INVALID_PUBLICATION');
    }
    for (const input of [null, undefined, [], {}]) refuses(input, 'INVALID_INPUT');
  });

  it('canonicalizes and freezes independent copies without mutating caller-owned declarations or leaves', () => {
    const value = fixture(); value.nextPublication.leaves.reverse();
    const before = structuredClone(value);
    const result = auditMiningAllocation(value);
    expect(value).toEqual(before);
    expect(result.nextPublication.leaves.map(row => row.wallet)).toEqual([wallet(1), wallet(2), wallet(3)]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.unverified)).toBe(true);
    expect(Object.isFrozen(result.nextPublication)).toBe(true);
    expect(Object.isFrozen(result.nextPublication.leaves)).toBe(true);
    expect(Object.isFrozen(result.nextPublication.leaves[0])).toBe(true);
    value.nextPublication.leaves[0] = leaf(9, 2n, 999n);
    expect(result.nextTotal).toBe(50n);
    expect(result.nextPublication.leaves[2]!.wallet).toBe(wallet(3));
  });
});
