/** Current-root assessment from a minimal wallet projection and current chain state.
 * No signer, transaction preparation, relay, or claim receipt is created here. */
import { PublicKey } from '@solana/web3.js';
import { PHASE_E_MINING_PUBLICATION as POLICY, TOKEN } from '@shardkeep/shared';
import { decodeMiningAllocationLeaf, decodeMiningAllocationProof, verifyMiningAllocationProof } from '@shardkeep/chain/mining-allocation';
import { createMiningClaimSnapshotReader, type MiningClaimSnapshotReader, type MiningClaimSnapshotTrust } from '@shardkeep/chain/mining-claim-snapshot';
import { miningConfigPda } from '@shardkeep/chain/mining-program';
import type { Db } from '../db/client';
import { phaseEMiningEnabled } from '../config';
import { createMiningClaimEntitlementReader } from './claimEntitlement';

const MAX_TIMEOUT_MS = 30_000, MAX_PENDING_WALLETS = 32;
type Projection = Awaited<ReturnType<ReturnType<typeof createMiningClaimEntitlementReader>>>;
type Snapshot = Awaited<ReturnType<ReturnType<typeof createMiningClaimSnapshotReader>>>;
type Reason = 'INVALID_WALLET' | 'DISABLED' | 'NOT_PROJECTED' | 'SOURCE_UNAVAILABLE' | 'SOURCE_CONFLICT' | 'UNSUPPORTED_FRONTIER' | 'BUSY' | 'TIMEOUT';
export interface MiningClaimStatus {
  state: 'unavailable' | 'no_allocation' | 'ready' | 'delayed' | 'paused' | 'revoked' | 'claimed';
  wallet: string;
  reason?: Reason;
  sequence?: string;
  amountBaseUnits?: string;
  cumulativeKeepBaseUnits?: string;
  alreadyClaimedBaseUnits?: string;
  decimals: number;
  observedSlot?: number;
  chainUnixTimestamp?: string;
  claimableAfterUnixTimestamp?: string;
  needsAta?: boolean;
  needsMinerRecords?: boolean;
  preparationAllowed: boolean;
  claimSubmissionAuthorized: false;
}
export interface MiningClaimAssessment {
  status: Readonly<MiningClaimStatus>;
  /** Internal preparation input. A public status route returns only status. */
  projection?: Projection;
  snapshot?: Snapshot;
}
const unavailable = (wallet: string, reason: Reason): MiningClaimAssessment => Object.freeze({ status: Object.freeze({
  state: 'unavailable', wallet, reason, decimals: TOKEN.decimals, preparationAllowed: false, claimSubmissionAuthorized: false,
}) });
function walletKey(value: unknown): string | null {
  if (typeof value !== 'string' || value.length < 32 || value.length > 44) return null;
  try { const p = new PublicKey(value); return p.toBase58() === value && !p.equals(PublicKey.default) ? value : null; } catch { return null; }
}

/** Source identities are application configuration, never parameters of a player request. */
export function createMiningClaimReader(db: Db, sources: {
  reader: MiningClaimSnapshotReader; trust: MiningClaimSnapshotTrust; timeoutMs?: number;
}) {
  const trust = { ...sources.trust, programId: new PublicKey(sources.trust.programId.toBytes()),
    keepMint: new PublicKey(sources.trust.keepMint.toBytes()), reserveOwner: new PublicKey(sources.trust.reserveOwner.toBytes()) };
  const entitlement = createMiningClaimEntitlementReader(db, { genesisHash: trust.expectedGenesisHash,
    programId: trust.programId.toBase58(), configAddress: miningConfigPda(trust.programId).toBase58() });
  const readSnapshot = createMiningClaimSnapshotReader(sources.reader, trust);
  const timeout = sources.timeoutMs ?? MAX_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT_MS) throw Error('Invalid mining claim read deadline');
  const flights = new Map<string, Promise<MiningClaimAssessment>>();
  async function observe(wallet: string): Promise<MiningClaimAssessment> {
    if (!phaseEMiningEnabled()) return unavailable(wallet, 'DISABLED');
    const projection = await entitlement(wallet);
    if (projection.kind === 'unavailable') return unavailable(wallet, 'NOT_PROJECTED');
    const h = projection.header;
    if (h.keepMint !== trust.keepMint.toBase58() || h.reserveOwner !== trust.reserveOwner.toBase58()) return unavailable(wallet, 'SOURCE_CONFLICT');
    const snapshot = await readSnapshot({ wallet: new PublicKey(wallet), sequence: BigInt(h.sequence), day: BigInt(h.day) });
    if (!phaseEMiningEnabled()) return unavailable(wallet, 'DISABLED');
    const { root, epoch, backing, minerClaim, renownRecord, chainClock } = snapshot, c = backing.config;
    if (snapshot.slot < h.publicationSlot || root.sequence !== BigInt(h.sequence) || root.day !== BigInt(h.day)
      || root.kind !== 0 || root.root !== h.root || root.totalCumulative !== BigInt(h.totalCumulative)
      || root.leafCount !== h.leafCount || epoch.sourceHash !== h.sourceHash || root.config !== h.configAddress
      || epoch.config !== h.configAddress || root.totalCumulative > c.totalPublishedHighwater) return unavailable(wallet, 'SOURCE_CONFLICT');
    // The program honors older roots, but current status cannot report zero
    // from an old projection while a newer complete allocation is unavailable.
    if (c.latestSequence !== BigInt(h.sequence)) return unavailable(wallet, 'UNSUPPORTED_FRONTIER');
    const common = { wallet, sequence: h.sequence, decimals: TOKEN.decimals, observedSlot: snapshot.slot,
      chainUnixTimestamp: chainClock.unixTimestamp.toString(), preparationAllowed: false, claimSubmissionAuthorized: false as const };
    const result = (status: MiningClaimStatus): MiningClaimAssessment => Object.freeze({ status: Object.freeze(status), projection, snapshot });
    if (root.revoked) return result({ ...common, state: 'revoked' });
    if (projection.kind === 'no_allocation') return result({ ...common, state: 'no_allocation', amountBaseUnits: '0' });
    const leaf = decodeMiningAllocationLeaf(Buffer.from(projection.leafHex, 'hex'));
    const proof = decodeMiningAllocationProof(Buffer.from(projection.proofHex, 'hex'));
    if (leaf.wallet !== wallet || leaf.sequence !== root.sequence || leaf.cumulativeKeep <= 0n
      || !verifyMiningAllocationProof(leaf, proof, Buffer.from(root.root, 'hex'), root.totalCumulative)
      || leaf.cumulativeRenown > leaf.cumulativeDays || root.day < c.genesisDay
      || leaf.cumulativeDays > root.day - c.genesisDay + 1n) return unavailable(wallet, 'SOURCE_CONFLICT');
    if ((minerClaim === null) !== (renownRecord === null)) return unavailable(wallet, 'SOURCE_CONFLICT');
    const paid = minerClaim?.claimedTotal ?? 0n;
    if (paid > leaf.cumulativeKeep || (minerClaim && (minerClaim.wallet !== wallet || minerClaim.lastSequence > leaf.sequence))
      || (renownRecord && (renownRecord.wallet !== wallet || renownRecord.lastSequence > leaf.sequence
        || renownRecord.renownTotal > leaf.cumulativeRenown || renownRecord.daysAttested > leaf.cumulativeDays))) return unavailable(wallet, 'SOURCE_CONFLICT');
    const amount = leaf.cumulativeKeep - paid, after = root.publishedAt + BigInt(POLICY.claimDelaySec);
    const quantities = { ...common, cumulativeKeepBaseUnits: leaf.cumulativeKeep.toString(), alreadyClaimedBaseUnits: paid.toString(),
      amountBaseUnits: amount.toString(), claimableAfterUnixTimestamp: after.toString(),
      needsAta: !snapshot.claimantAta.exists, needsMinerRecords: minerClaim === null };
    if (amount === 0n) return result({ ...quantities, state: 'claimed' });
    if ((c.flags & 1) !== 0) return result({ ...quantities, state: 'paused' }); // Reviewed claim-pause ABI bit.
    if (chainClock.unixTimestamp < after) return result({ ...quantities, state: 'delayed' });
    if (amount > backing.playerOutstanding || backing.vaultAmount - amount < backing.totalOutstanding - amount) return unavailable(wallet, 'SOURCE_CONFLICT');
    return result({ ...quantities, state: 'ready', preparationAllowed: true });
  }
  function assess(value: string): Promise<MiningClaimAssessment> {
    const wallet = walletKey(value); if (!wallet) return Promise.resolve(unavailable('', 'INVALID_WALLET'));
    const old = flights.get(wallet); if (old) return old;
    if (flights.size >= MAX_PENDING_WALLETS) return Promise.resolve(unavailable(wallet, 'BUSY'));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const work = observe(wallet).catch(() => unavailable(wallet, 'SOURCE_UNAVAILABLE'));
    const reply = Promise.race([work, new Promise<MiningClaimAssessment>(resolve => {
      timer = setTimeout(() => resolve(unavailable(wallet, 'TIMEOUT')), timeout);
    })]).finally(() => { if (timer) clearTimeout(timer); });
    flights.set(wallet, reply);
    // A timeout does not free the source slot: retain it until the real read
    // drains. Late read-only results are discarded, never cached as claimability.
    void work.then(() => { if (flights.get(wallet) === reply) flights.delete(wallet); });
    return reply;
  }
  return { assess, async status(wallet: string): Promise<Readonly<MiningClaimStatus>> { return (await assess(wallet)).status; } };
}
