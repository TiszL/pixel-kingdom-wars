/** Read-only net commitment audit (E1-ONCHAIN §§4.2–4.3), not a publisher.
 * Full caller-supplied leaf sets prove their mutual consistency only. This does
 * not authenticate publication history, scores, funded pools or D-150 tax backing.
 * No result from this module authorizes a claim, root publication or money write. */
import { buildMiningAllocationTree, MINING_ALLOCATION_MAX_LEAVES, MINING_ALLOCATION_U64_MAX,
  type MiningAllocationLeaf } from '@shardkeep/chain/mining-allocation';
import { z } from 'zod';

const u64 = z.bigint().min(0n).max(MINING_ALLOCATION_U64_MAX);
const leafSchema = z.object({ wallet: z.string(), cumulativeKeep: u64, cumulativeRenown: u64,
  cumulativeDays: u64, sequence: u64 }).strict();
const publicationSchema = z.object({
  sequence: u64, root: z.string().length(64).regex(/^[0-9a-f]+$/), total: u64,
  leafCount: z.number().int().positive().max(MINING_ALLOCATION_MAX_LEAVES),
  leaves: z.array(z.unknown()).max(MINING_ALLOCATION_MAX_LEAVES),
}).strict();
const inputSchema = z.object({ previousPublication: z.unknown(), nextPublication: z.unknown() }).strict();

type Scope = 'input' | 'previousPublication' | 'nextPublication';
type RefusalCode = 'INVALID_INPUT' | 'INVALID_PUBLICATION' | 'INVALID_LEAF_SET' | 'SEQUENCE_MISMATCH'
  | 'COMMITMENT_MISMATCH' | 'PRIOR_WALLET_OMITTED' | 'CUMULATIVE_REGRESSION';
export class MiningAllocationAuditError extends Error {
  constructor(readonly code: RefusalCode, readonly scope: Scope) {
    super(`Mining allocation audit refused: ${code} (${scope})`);
    this.name = 'MiningAllocationAuditError';
  }
}

export interface MiningAllocationPublication {
  readonly sequence: bigint;
  readonly root: string;
  readonly total: bigint;
  readonly leafCount: number;
  readonly leaves: readonly Readonly<MiningAllocationLeaf>[];
}
const unverified = Object.freeze(['published-history', 'funding', 'tax-backing', 'score-fairness'] as const);
export interface MiningAllocationAudit {
  readonly netCommitmentValid: true;
  readonly publicationAuthorized: false;
  readonly unverified: typeof unverified;
  readonly previousPublication: MiningAllocationPublication | null;
  readonly nextPublication: MiningAllocationPublication;
  readonly previousTotal: bigint;
  readonly nextTotal: bigint;
  readonly incrementalNetKeep: bigint;
  readonly retainedWallets: number;
  readonly newWallets: number;
}

function publication(value: unknown, scope: Exclude<Scope, 'input'>): MiningAllocationPublication {
  // Zod array max checks run after element parsing/allocation. Admit the raw
  // length first so oversized declarations cannot consume work before refusal.
  const rawLeaves = value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>).leaves : undefined;
  if (!Array.isArray(rawLeaves) || rawLeaves.length > MINING_ALLOCATION_MAX_LEAVES)
    throw new MiningAllocationAuditError('INVALID_PUBLICATION', scope);
  const parsed = publicationSchema.safeParse(value);
  if (!parsed.success) throw new MiningAllocationAuditError('INVALID_PUBLICATION', scope);
  const declaration = parsed.data;
  const leaves = declaration.leaves.map(value => {
    const parsedLeaf = leafSchema.safeParse(value);
    if (!parsedLeaf.success) throw new MiningAllocationAuditError('INVALID_LEAF_SET', scope);
    if (parsedLeaf.data.sequence !== declaration.sequence)
      throw new MiningAllocationAuditError('SEQUENCE_MISMATCH', scope);
    return parsedLeaf.data;
  });
  if (declaration.sequence === 0n) throw new MiningAllocationAuditError('SEQUENCE_MISMATCH', scope);
  let tree: ReturnType<typeof buildMiningAllocationTree>;
  try { tree = buildMiningAllocationTree(leaves); }
  catch (error) {
    if (error instanceof TypeError || error instanceof RangeError)
      throw new MiningAllocationAuditError('INVALID_LEAF_SET', scope);
    throw error;
  }
  const root = Buffer.from(tree.root).toString('hex');
  if (root !== declaration.root || tree.total !== declaration.total || tree.leafCount !== declaration.leafCount)
    throw new MiningAllocationAuditError('COMMITMENT_MISMATCH', scope);
  return Object.freeze({ sequence: declaration.sequence, root, total: tree.total, leafCount: tree.leafCount,
    leaves: Object.freeze(tree.leaves.map(row => Object.freeze({ ...row }))) });
}

/** Audit consecutive complete declarations. E1 §4.2 requires latest_sequence+1.
 * Explicit null is only the pre-first-publication baseline (next sequence 1).
 * A revoked sequence gap needs authenticated complete history from a future
 * integration; it cannot silently reset this audit's prior funded leaf set. */
export function auditMiningAllocation(value: unknown): MiningAllocationAudit {
  const input = inputSchema.safeParse(value);
  if (!input.success || input.data.previousPublication === undefined || input.data.nextPublication === undefined)
    throw new MiningAllocationAuditError('INVALID_INPUT', 'input');
  const previous = input.data.previousPublication === null ? null
    : publication(input.data.previousPublication, 'previousPublication');
  const next = publication(input.data.nextPublication, 'nextPublication');
  if (next.sequence !== (previous?.sequence ?? 0n) + 1n)
    throw new MiningAllocationAuditError('SEQUENCE_MISMATCH', 'nextPublication');
  const nextByWallet = new Map(next.leaves.map(row => [row.wallet, row]));
  for (const old of previous?.leaves ?? []) {
    const current = nextByWallet.get(old.wallet);
    // Retain Renown-only and zero-valued leaves too: omitting history is not a
    // proof that the wallet lost every previously committed right.
    if (!current) throw new MiningAllocationAuditError('PRIOR_WALLET_OMITTED', 'nextPublication');
    if (current.cumulativeKeep < old.cumulativeKeep || current.cumulativeRenown < old.cumulativeRenown
      || current.cumulativeDays < old.cumulativeDays)
      throw new MiningAllocationAuditError('CUMULATIVE_REGRESSION', 'nextPublication');
  }
  const previousTotal = previous?.total ?? 0n, retainedWallets = previous?.leafCount ?? 0;
  return Object.freeze({ netCommitmentValid: true, publicationAuthorized: false, unverified,
    previousPublication: previous, nextPublication: next, previousTotal, nextTotal: next.total,
    incrementalNetKeep: next.total - previousTotal, retainedWallets,
    newWallets: next.leafCount - retainedWallets });
}
