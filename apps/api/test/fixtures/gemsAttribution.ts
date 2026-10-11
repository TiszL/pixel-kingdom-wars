import { randomUUID } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import type { GemsFlowEvidence, GemsFlowFact } from '../../src/mining/gemsFlowEvidence';
export function attributionFixture() {
 const wallet = Keypair.generate().publicKey.toBase58(); const ids = { gems: randomUUID(), mint: randomUUID(), sink: randomUUID(), reward: randomUUID(), emission: randomUUID(), keep: randomUUID(), inflow: randomUUID(), shards: randomUUID(), shardGenesis: randomUUID() };
 let next = 1, nextEntry = 100, net = 0n, at = '2035-01-01T00:00:00.000000Z';
 const evidence: GemsFlowEvidence = { version: 1, sourcePolicyVersion: 1, transactionVisibility: 'whole-db-transaction-at-last-observation', wallet, day: '2035-01-03', coverageStartedAt: at, birthEventId: '1', facts: [], netGems: '0', hasSourceMutations: false, hasUnclassified: false, usefulChainCreditAuthorized: false, allocationReady: false, publicationAuthorized: false };
 const fact = (value: Omit<GemsFlowFact, 'id' | 'observedAt' | 'effectiveObservedAt' | 'transactionMarker'>) => {
  const id = String(next++), f: GemsFlowFact = { id, observedAt: at, effectiveObservedAt: at, transactionMarker: id, ...value }; evidence.facts.push(f); return f;
 };
 fact({ sourceTable: 'accounts', sourceId: ids.gems, accountId: ids.gems, transactionId: null, operation: 'INSERT', classification: 'account-created', source: { id: ids.gems, kind: 'player_gems', currency: 'GEMS', owner_wallet: wallet, base_id: null, initialBalance: '0' }, before: null, receipt: [] });
 type Leg = { id: string; accountId: string; delta: string; kind: string; currency: string; wallet: string | null; baseId: string | null };
 const leg = (accountId: string, kind: string, currency: string, delta: bigint, owner: string | null = null): Leg => ({ id: String(nextEntry++), accountId, delta: delta.toString(), kind, currency, wallet: owner, baseId: null });
 const posting = (classification: GemsFlowFact['classification'], type: string, key: string, delta: bigint, metadata: Record<string, unknown>, legs: Leg[]) => {
  const player = legs.find(l => l.accountId === ids.gems)!; const transactionId = randomUUID(); net += delta; evidence.netGems = net.toString();
  return fact({ sourceTable: 'ledger_entries', sourceId: player.id, accountId: ids.gems, transactionId, operation: 'INSERT', classification, before: null, receipt: legs,
   source: { entry: { id: player.id, txnId: transactionId, accountId: ids.gems, delta: delta.toString() }, account: { id: ids.gems, kind: 'player_gems', currency: 'GEMS', wallet, baseId: null }, transaction: { id: transactionId, key, type, metadata, createdAt: at } } });
 };
 const origin = (amount: bigint, classification: 'grant' | 'custodial-conversion' | 'wallet-conversion-ledger' = 'custodial-conversion') => {
  const depositId = randomUUID(), grantRef = randomUUID();
  const metadata = classification === 'grant' ? { wallet, gems: amount.toString(), reason: 'task', ref: grantRef }
   : { wallet, keep: amount.toString(), gems: amount.toString(), rate: 1, source: classification === 'custodial-conversion' ? 'ledger' : 'wallet', ...(classification === 'wallet-conversion-ledger' ? { depositId, txSignature: 'recorded-signature-without-chain-proof' } : {}) };
  return posting(classification, classification === 'grant' ? 'gems.grant' : classification === 'custodial-conversion' ? 'gems.from_keep' : 'gems.buy',
   classification === 'grant' ? `grant:task:${grantRef}:${wallet}` : classification === 'custodial-conversion' ? `gems:from-keep:${wallet}:${randomUUID()}` : `deposit:${depositId}:credit`, amount, metadata,
   [leg(ids.gems, 'player_gems', 'GEMS', amount, wallet), leg(ids.mint, 'gems_mint', 'GEMS', -amount), leg(ids.emission, 'emission_pool', 'KEEP', amount), leg(classification === 'grant' ? ids.reward : classification === 'custodial-conversion' ? ids.keep : ids.inflow, classification === 'grant' ? 'gems_reward_budget' : classification === 'custodial-conversion' ? 'player_keep' : 'onchain_inflow', 'KEEP', -amount, classification === 'custodial-conversion' ? wallet : null)]);
 };
 const spend = (amount: bigint, options: { excluded?: boolean; raidId?: string } = {}) => {
  if (options.excluded) return posting('excluded-gems-to-shards', 'gems.to_shards', `gems:to-shards:${wallet}:${randomUUID()}`, -amount, { wallet, gems: amount.toString(), shards: amount.toString(), rate: 1 }, [leg(ids.gems, 'player_gems', 'GEMS', -amount, wallet), leg(ids.sink, 'gems_sink', 'GEMS', amount), leg(ids.shardGenesis, 'shard_genesis', 'SHARDS', -amount), leg(ids.shards, 'player_shards', 'SHARDS', amount, wallet)]);
  const raidId = options.raidId;
  return posting('system-spend', raidId ? 'raid.buffs' : 'build.speedup', raidId ? `raid:${raidId}:live-buff:warhorn` : `speedup:${wallet}:${randomUUID()}`, -amount, { wallet, currency: 'GEMS', ...(raidId ? { raidId, buff: 'warhorn', live: true } : { jobId: randomUUID() }) }, [leg(ids.gems, 'player_gems', 'GEMS', -amount, wallet), leg(ids.sink, 'gems_sink', 'GEMS', amount)]);
 };
 const refund = (original: GemsFlowFact) => {
  const s = original.source as { entry: { delta: string }; transaction: { key: string; metadata: { raidId: string; buff: string } } }; const { raidId, buff } = s.transaction.metadata;
  return posting('sink-refund', 'raid.buffs.system_refund', `raid:${raidId}:live-buff-refund:${buff}`, -BigInt(s.entry.delta), { raidId, wallet, buff, originalKey: s.transaction.key, refundOf: original.transactionId, currency: 'GEMS' }, (original.receipt as Leg[]).map(l => ({ ...l, id: String(nextEntry++), delta: String(-BigInt(l.delta)) })));
 };
 return { evidence, wallet, ids, origin, spend, refund, clock: (value: string) => { at = value; }, snapshot: () => structuredClone(evidence) };
}
