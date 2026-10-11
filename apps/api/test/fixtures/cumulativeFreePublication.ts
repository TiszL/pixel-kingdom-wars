/** Complete owner-held publication history plus real daily stock/qualification.
 * RPC fixtures serialize the actual ABI. No planner/history/verifier is mocked. */
import { randomUUID } from 'node:crypto';
import { PublicKey, SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';
import { KEEP_MINING_FLOOR, PHASE_E_POLICY as POLICY, PHASE_E_MINING_PUBLICATION as SPLIT, TOKEN } from '@shardkeep/shared';
import { createMiningBackingSnapshotReader } from '@shardkeep/chain/mining-backing';
import { readFinalizedSeekerTerm } from '@shardkeep/chain/seeker-terms';
import type { DeedMiningWalletReader } from '@shardkeep/chain/mining-wallet';
import { createMiningBackingFixture } from '../../../../packages/chain/src/testFixtures/miningBacking';
import { createMiningWalletFixture } from '../../../../packages/chain/src/testFixtures/deedMiningWallet';
import { createMiningPublicationFixture } from '../../../../packages/chain/src/testFixtures/miningPublication';
import { createCumulativeFreePublicationPreparer, type PreparedMiningPublication } from '../../src/mining/publicationPreparation';
import { createMiningPublicationOutbox } from '../../src/mining/publicationOutbox';
import { createMiningPublicationSettlement } from '../../src/mining/publicationSettlement';
import { withMiningClaimEntitlementFixture, type MiningClaimEntitlementFixture } from './miningClaimEntitlement';

type Chain = Awaited<ReturnType<typeof createMiningPublicationFixture>>;
type Backing = Awaited<ReturnType<typeof createMiningBackingFixture>>;
const dayStart = (day: string) => Date.parse(`${day}T00:00:00.000Z`);
const ceiling = BigInt(POLICY.mining.grossDailyCeilingKeep) * 10n ** BigInt(TOKEN.decimals);
const ceilDiv = (n: bigint, d: bigint) => (n + d - 1n) / d;
function args(p: PreparedMiningPublication) {
  const d = p.publication;
  return { sequence: BigInt(d.sequence), day: BigInt(d.day), kind: 0 as const, root: Buffer.from(d.root, 'hex'),
    totalCumulative: BigInt(d.total), leafCount: d.leafCount, budgetGross: BigInt(d.budgetGross),
    freeGross: BigInt(d.freeGross), deedGross: BigInt(d.deedGross), sourceHash: Buffer.from(p.sourceHash, 'hex'),
    taxCommitment: Buffer.from(d.taxCommitment, 'hex'), taxVersion: d.taxVersion };
}
function bank(backing: Backing, slot: number, closedDay: string) {
  backing.rows[7]!.data.writeBigUInt64LE(BigInt(slot));
  backing.rows[7]!.data.writeBigInt64LE(BigInt(dayStart(closedDay) / 1000 + SPLIT.daySec), 32);
  backing.reader.getSlot = async () => slot;
  backing.reader.getMultipleAccountsInfoAndContext = async () => ({ context: { slot }, value: backing.rows });
}
function frontier(backing: Backing, prior: Chain['nextFrontier']) {
  Object.assign(backing.model, { genesis_day: prior.genesisDay, latest_day: prior.latestDay, latest_sequence: prior.latestSequence,
    total_published: prior.totalPublished, total_published_highwater: prior.totalPublishedHighwater, total_claimed: prior.totalClaimed,
    tax_highwater: prior.taxHighwater, tax_paid: prior.taxPaid, recycled_total: prior.recycledTotal,
    gross_published: prior.grossPublished, split_cursor: prior.splitCursor });
}

/** Only the observation horizon advances. Original mint/collection and Seeker
 * round0 creation/settlement facts remain identical across every fixture day. */
function dailyQualification(f: MiningClaimEntitlementFixture, day: string) {
  const end = dayStart(day) / 1000 + SPLIT.daySec;
  const make = () => {
    const q = createMiningWalletFixture({ targetWallet: f.wallet, startAt: new Date('2020-01-01T00:00:00Z'),
      endAt: new Date('2020-01-02T00:00:00Z'), scenario: 'none' });
    const original = q.reader.getBlockTime.getMockImplementation()!;
    q.reader.getBlockTime.mockImplementation(async slot => slot === 19 ? end : slot === 20 ? end + 1 : slot === 21 ? end + 2 : slot === 25 ? end + 3 : original(slot));
    return q;
  };
  const q = make();
  return { source: () => make().reader as unknown as DeedMiningWalletReader,
    collection: q.collection, expectedGenesisHash: q.expectedGenesisHash };
}
function dailyTax(f: MiningClaimEntitlementFixture, day: string, slot: number) {
  const original = f.sources.tax!;
  return { policy: original.policy, connect: (signal: AbortSignal) => {
    const rpc = original.connect(signal);
    return { ...rpc, getMultipleAccountsInfoAndContext: (async (addresses: PublicKey[], options: unknown) => {
      const result = await rpc.getMultipleAccountsInfoAndContext(addresses, options as never);
      return { ...result, context: { slot }, value: result.value.map((row, index) => {
        if (!row || !addresses[index]!.equals(SYSVAR_CLOCK_PUBKEY)) return row;
        const data = Buffer.from(row.data); data.writeBigUInt64LE(BigInt(slot));
        data.writeBigInt64LE(BigInt(dayStart(day) / 1000 + SPLIT.daySec), 32); return { ...row, data };
      }) };
    }) as typeof rpc.getMultipleAccountsInfoAndContext };
  } };
}
export interface CumulativeDayOptions {
  quantity?: number; claimedAdvance?: bigint; taxPaidAdvance?: bigint; topUp?: bigint;
  /** Derive the smallest extra funding that exercises a nonzero split carry. */
  ensureNonzeroCarry?: boolean;
}
export async function withCumulativeFreePublicationFixture(run: (f: Awaited<ReturnType<typeof extend>>) => Promise<void>) {
  return withMiningClaimEntitlementFixture(async f => run(await extend(f)));
}
async function extend(f: MiningClaimEntitlementFixture) {
  const originalTerm = await readFinalizedSeekerTerm(f.sources.tax!.connect, f.sources.tax!.policy);
  let last: Chain | null = null;
  async function complete(p: PreparedMiningPublication, backing: Backing) {
    const original = await createMiningBackingSnapshotReader(backing.reader, backing.trust)();
    const request = { epochId: p.epochId, attemptKey: p.attemptKey };
    const outbox = createMiningPublicationOutbox(f.conn.db, { reader: backing.reader, trust: backing.trust });
    const reservation = await outbox.reserveSigning(request);
    const chain = await createMiningPublicationFixture('legacy', { signer: f.signer, identity: backing.trust,
      args: args(p), genesisHash: backing.trust.expectedGenesisHash, programData: backing.programData,
      intentBytes: Buffer.from(p.intentHex, 'hex'), priorFrontier: original.config,
      vaultBefore: original.vaultAmount, reserveBefore: original.reserveAmount, publicationSlot: original.slot + 1 });
    const signed = await outbox.acceptSigned({ ...request, signedTransaction: chain.request.signedTransaction });
    const settle = () => createMiningPublicationSettlement(f.conn.db, { reader: chain.reader, trust: chain.trusted })({
      ...request, signature: chain.request.signature, signedTransaction: chain.request.signedTransaction });
    const settlement = await settle(); last = chain;
    return { prepared: p, original, reservation, signed, chain, settlement, settle, request, backing, outbox };
  }
  async function first() {
    if (last) throw Error('Day one was already finalized');
    bank(f.backing, 2110, '2020-01-01'); return complete(f.prepared, f.backing);
  }
  async function stageDay(day: string, options: CumulativeDayOptions = {}) {
    if (!last) throw Error('First publication must be settled before the next day');
    const previous = last;
    if (BigInt(dayStart(day) / (SPLIT.daySec * 1000)) !== previous.nextFrontier.latestDay + 1n) throw Error('Consecutive fixture day required');
    if (BigInt(dayStart(day) / 1000) < originalTerm.operatingStart
      || BigInt(dayStart(day) / 1000 + SPLIT.daySec) > originalTerm.operatingEnd) throw Error('Fixture day requires the next genuine Seeker term');
    const reservation = await f.reserve(day, options.quantity ?? 1); await f.battle(day);
    await f.clock(null); await f.collect(day);
    const claimed = options.claimedAdvance ?? 0n, taxPaid = options.taxPaidAdvance ?? 0n;
    const prior = { ...previous.nextFrontier, totalClaimed: previous.nextFrontier.totalClaimed + claimed,
      taxPaid: previous.nextFrontier.taxPaid + taxPaid };
    const floor = prior.totalPublishedHighwater - prior.totalClaimed + prior.taxHighwater - prior.taxPaid;
    let vault = previous.afterTokenBalance.vaultAfter - claimed - taxPaid + (options.topUp ?? 0n);
    let topUp = options.topUp ?? 0n;
    if (options.ensureNonzeroCarry) {
      const score = await f.evaluate(day), weight = BigInt(score.weight);
      const denominator = BigInt(KEEP_MINING_FLOOR.minUnitsPerPool) * BigInt(POLICY.basisPoints);
      if (!weight || weight > denominator) throw Error('Fixture expected one qualified floor-denominator participant');
      const available = vault - floor, budget = available < ceiling ? available : ceiling;
      const gross = budget * BigInt(POLICY.mining.freePoolBps) / BigInt(POLICY.basisPoints) * weight / denominator;
      if ((prior.splitCursor + Number(gross % BigInt(SPLIT.splitPeriod))) % SPLIT.splitPeriod === 0) {
        const pool = ceilDiv((gross + 1n) * denominator, weight);
        const required = ceilDiv(pool * BigInt(POLICY.basisPoints), BigInt(POLICY.mining.freePoolBps));
        if (required > ceiling || required < available) throw Error('Fixture cannot exercise carry with a bounded deposit');
        topUp += required - available; vault += required - available;
      }
    }
    if (topUp > previous.afterTokenBalance.reserveAfter) throw Error('Fixture reserve cannot fund the requested transfer');
    const backing = await createMiningBackingFixture({ day, genesisHash: new PublicKey(f.backing.trust.expectedGenesisHash),
      programId: f.backing.trust.programId, programData: f.backing.programData, programDataAddress: f.backing.programDataAddress,
      upgradeAuthority: f.backing.upgradeAuthority, virginConfig: true, budgetGross: 0n });
    frontier(backing, prior); backing.model.publisher = f.signer.publicKey; backing.model.flags = 0;
    // Classic SPL fixtures have the canonical u64 amount at offset64; preserve
    // all other validated token fields and the original fixed-supply mint.
    backing.rows[1]!.data.writeBigUInt64LE(vault, 64);
    backing.rows[2]!.data.writeBigUInt64LE(previous.afterTokenBalance.reserveAfter - topUp, 64);
    backing.rows[3]!.data = Buffer.from(f.backing.rows[3]!.data);
    await backing.config(); const slot = previous.contextSlot + 100; bank(backing, slot, day);
    const sources = { qualification: dailyQualification(f, day), backing: { reader: backing.reader, trust: backing.trust }, tax: dailyTax(f, day, slot) };
    const request = { epochId: reservation.receipt.epochId, day, policyVersion: 1 as const, attemptKey: randomUUID() };
    const blockhashSource = () => ({ getGenesisHash: async () => backing.trust.expectedGenesisHash,
      getLatestBlockhashAndContext: async () => ({ context: { slot }, value: { blockhash: new PublicKey(Buffer.alloc(32, Number(prior.latestSequence) + 91)).toBase58(), lastValidBlockHeight: slot + 200 } }) });
    const prepare = createCumulativeFreePublicationPreparer(f.conn.db, { sources, signer: f.signer.publicKey, blockhashSource });
    const publish = async () => { const p = await prepare(request); if (p.status !== 'prepared') throw Error('Expected useful funded cumulative fixture'); return complete(p, backing); };
    return { day, request, sources, backing, prepare, publish, previous, prior, topUp, claimed, taxPaid, reservation };
  }
  return { ...f, first, stageDay };
}
