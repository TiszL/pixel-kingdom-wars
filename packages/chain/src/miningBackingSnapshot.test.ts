import { describe,it,expect } from 'vitest';
import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { TOKEN,PHASE_E_POLICY } from '@shardkeep/shared';
import { createMiningBackingSnapshotReader } from './miningBackingSnapshot';
import { createMiningBackingFixture as fixture } from './testFixtures/miningBacking';
const pk=(n:number)=>new PublicKey(Buffer.alloc(32,n));
describe('finalized mining backing snapshot',()=>{
 it('counts both outstanding liabilities while paused, and excludes reserve holdings from available backing',async()=>{
  const f=await fixture(),r=await createMiningBackingSnapshotReader(f.reader,f.trust)();
  expect(r).toMatchObject({slot:150,chainDay:101n,playerOutstanding:50n,taxOutstanding:10n,totalOutstanding:60n,vaultAmount:100n,reserveAmount:10n,availableBudget:40n,maximumEpochBudget:40n,publicationAuthorized:false,claimsAuthorized:false,scoreFairnessVerified:false});
  expect(r.config.flags).toBe(35);expect(r.source.accounts).toHaveLength(8);expect(Object.isFrozen(r)).toBe(true);expect(Object.isFrozen(r.source.accounts)).toBe(true);
 });
 it('zero surplus is valid when fully backed, without erasing liabilities',async()=>{
  const f=await fixture();f.rows[1]!.data.writeBigUInt64LE(60n,64);const r=await createMiningBackingSnapshotReader(f.reader,f.trust)();expect(r.availableBudget).toBe(0n);expect(r.totalOutstanding).toBe(60n);
 });
 it('caps one epoch while retaining the full measured surplus separately',async()=>{
  const f=await fixture(),ceiling=BigInt(PHASE_E_POLICY.mining.grossDailyCeilingKeep)*10n**BigInt(TOKEN.decimals);
  f.rows[1]!.data.writeBigUInt64LE(ceiling+61n,64);f.rows[3]!.data.writeBigUInt64LE(ceiling+100n,36);
  const r=await createMiningBackingSnapshotReader(f.reader,f.trust)();expect(r.availableBudget).toBe(ceiling+1n);expect(r.maximumEpochBudget).toBe(ceiling);
 });
 it('a revoked distribution frontier does not turn encumbered highwaters into surplus',async()=>{
  const f=await fixture();Object.assign(f.model,{latest_sequence:2n,latest_day:99n,total_published:0n,correction_pending:true,split_cursor:9});await f.config();
  const r=await createMiningBackingSnapshotReader(f.reader,f.trust)();expect(r.totalOutstanding).toBe(60n);expect(r.availableBudget).toBe(40n);expect(r.config).toMatchObject({latestSequence:2n,totalPublished:0n,correctionPending:true,splitCursor:9});
 });
 it.each(['shortfall','player-overpaid','tax-overpaid','sum-overflow','mint-owner','mint-size','mint-decimals','mint-authority','freeze-authority','mint-bool','vault-address','vault-owner','vault-mint','vault-delegate','vault-close','vault-frozen','reserve-owner','native','supply','genesis','authority-genesis','authority-tag','missing','context','clock-slot','clock-owner','revision','binary'] as const)('refuses %s instead of reporting zero liabilities',async kind=>{
  const f=await fixture();
  if(kind==='shortfall')f.rows[1]!.data.writeBigUInt64LE(59n,64);
  if(kind==='player-overpaid'){f.model.total_claimed=81n;await f.config();}
  if(kind==='tax-overpaid'){f.model.tax_paid=11n;await f.config();}
  if(kind==='sum-overflow'){f.model.total_published_highwater=(1n<<64n)-1n;f.model.total_claimed=0n;await f.config();}
  if(kind==='mint-owner')f.rows[3]!.owner=pk(22);
  if(kind==='mint-size')f.rows[3]!.data=Buffer.concat([f.rows[3]!.data,Buffer.of(0)]);
  if(kind==='mint-decimals')f.rows[3]!.data[44]=0;
  if(kind==='mint-authority')f.rows[3]!.data.writeUInt32LE(1,0);
  if(kind==='freeze-authority')f.rows[3]!.data.writeUInt32LE(1,46);
  if(kind==='mint-bool')f.rows[3]!.data[45]=2;
  if(kind==='vault-address')f.rows[1]!.address=pk(22);
  if(kind==='vault-owner')f.rows[1]!.owner=pk(22);
  if(kind==='vault-mint')pk(22).toBuffer().copy(f.rows[1]!.data);
  if(kind==='vault-delegate')f.rows[1]!.data.writeUInt32LE(2,72);
  if(kind==='vault-close')f.rows[1]!.data.writeUInt32LE(1,129);
  if(kind==='vault-frozen')f.rows[1]!.data[108]=2;
  if(kind==='reserve-owner')pk(22).toBuffer().copy(f.rows[2]!.data,32);
  if(kind==='native')f.rows[1]!.data.writeUInt32LE(1,109);
  if(kind==='supply')f.rows[3]!.data.writeBigUInt64LE(109n,36);
  if(kind==='genesis')f.reader.getGenesisHash=async()=>pk(22).toBase58();
  if(kind==='authority-genesis'){f.auth.cluster_genesis=pk(22).toBytes();await f.authority();}
  if(kind==='authority-tag')f.rows[6]!.data[41]=2;
  if(kind==='missing')f.reader.getMultipleAccountsInfoAndContext=async()=>({context:{slot:150},value:f.rows.map((r,i)=>i===2?null:r)});
  if(kind==='context')f.reader.getMultipleAccountsInfoAndContext=async()=>({context:{slot:99},value:f.rows});
  if(kind==='clock-slot')f.rows[7]!.data.writeBigUInt64LE(149n);
  if(kind==='clock-owner')f.rows[7]!.owner=pk(22);
  if(kind==='revision')f.rows[5]!.data.writeBigUInt64LE(91n,4);
  if(kind==='binary')f.rows[5]!.data[49]=8;
  await expect(createMiningBackingSnapshotReader(f.reader,f.trust)()).rejects.toThrow(/Mining backing snapshot refused/);
 });
 it('snapshots application trust and refuses provider genesis movement within the read',async()=>{
  const f=await fixture(),read=createMiningBackingSnapshotReader(f.reader,f.trust);f.trust.expectedGenesisHash=pk(22).toBase58();expect((await read()).availableBudget).toBe(40n);
  let n=0;f.reader.getGenesisHash=async()=>n++?pk(22).toBase58():pk(3).toBase58();await expect(read()).rejects.toThrow();
 });
});
