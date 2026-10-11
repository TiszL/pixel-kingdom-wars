import { describe,it,expect } from 'vitest';
import { PublicKey,SystemProgram } from '@solana/web3.js';
import { PHASE_E_MINING_PUBLICATION as POLICY } from '@shardkeep/shared';
import { createMiningClaimFixture as fixture } from './testFixtures/miningClaim';
import { createMiningClaimSnapshotReader as factory } from './miningClaimSnapshot';
const pk=(n:number)=>new PublicKey(Buffer.alloc(32,n));
describe('same-finalized-bank mining claimant status',()=>{
 it('reads all fourteen rows once and preserves absent cursors without granting entitlement',async()=>{
  const f=await fixture(),r=await factory(f.reader,f.trust)(f.request);
  expect(f.readCount()).toBe(1);expect(r).toMatchObject({slot:150,minerClaim:null,renownRecord:null,currentClaimsAuthorized:false,payer:{exists:true,lamports:1_000_000_000n},claimantAta:{exists:true,balanceBaseUnits:0n}});
  expect(r.root.totalCumulative).toBe(80n);expect(r.backing.totalOutstanding).toBe(90n);expect(r.source.accounts).toHaveLength(14);expect(Object.isFrozen(r)).toBe(true);
 });
 it('reports exact delay boundary and distinguishes publication pause from claim pause',async()=>{
  const f=await fixture(),read=factory(f.reader,f.trust),at=f.root.published_at+BigInt(POLICY.claimDelaySec);
  f.clock(at-1n);expect((await read(f.request)).chainClock.unixTimestamp).toBe(at-1n);
  f.clock(at);f.backing.model.flags=2;await f.backing.config();const pub=await read(f.request);expect(pub.chainClock.unixTimestamp).toBe(at);expect(pub.backing.config.flags).toBe(2);
  f.backing.model.flags=1;await f.backing.config();expect((await read(f.request)).backing.config.flags).toBe(1);
 });
 it('keeps a revoked root and its funded liabilities visible after frontier rollback',async()=>{
  const f=await fixture();f.root.revoked=true;await f.encodeRoot();Object.assign(f.backing.model,{total_published:0n,latest_day:f.root.prev_day,correction_pending:true});await f.backing.config();
  const r=await factory(f.reader,f.trust)(f.request);expect(r.root.revoked).toBe(true);expect(r.backing.totalOutstanding).toBe(90n);
 });
 it('reads both permanent cursors and explicit missing ATA/System account facts',async()=>{
  const f=await fixture();await f.records();f.rows[12]=null;f.rows[13]=null;
  const r=await factory(f.reader,f.trust)(f.request);expect(r.minerClaim?.claimedTotal).toBe(0n);expect(r.renownRecord?.daysAttested).toBe(0n);expect(r.claimantAta).toMatchObject({exists:false,balanceBaseUnits:null});expect(r.payer).toMatchObject({exists:false,lamports:null});
 });
 it.each(['delegated','close-authority','frozen','reassigned-owner'] as const)('keeps default admission strict while historical account policy permits %s',async kind=>{
  const f=await fixture(),ata=Buffer.from(f.rows[12]!.data.buffer,f.rows[12]!.data.byteOffset,f.rows[12]!.data.byteLength);
  if(kind==='delegated'){ata.writeUInt32LE(1,72);pk(22).toBuffer().copy(ata,76);ata.writeBigUInt64LE(10n,121);}
  if(kind==='close-authority'){ata.writeUInt32LE(1,129);pk(22).toBuffer().copy(ata,133);}
  if(kind==='frozen')ata[108]=2;
  if(kind==='reassigned-owner')pk(22).toBuffer().copy(ata,32);
  await expect(factory(f.reader,f.trust)(f.request)).rejects.toMatchObject({code:'TOKEN'});
  const history=await factory(f.reader,f.trust,{claimantAccountPolicy:'historical'})(f.request);expect(history.claimantAta).toMatchObject({exists:true,balanceBaseUnits:0n});expect(history.currentClaimsAuthorized).toBe(false);
 });
 it.each(['delegate-option','close-option','uninitialized','invalid-state','native','mint','program-owner','layout','system-data','system-executable'] as const)('historical account policy still rejects malformed %s',async kind=>{
  const f=await fixture(),ata=Buffer.from(f.rows[12]!.data.buffer,f.rows[12]!.data.byteOffset,f.rows[12]!.data.byteLength);
  if(kind==='delegate-option')ata.writeUInt32LE(2,72);
  if(kind==='close-option')ata.writeUInt32LE(2,129);
  if(kind==='uninitialized')ata[108]=0;
  if(kind==='invalid-state')ata[108]=3;
  if(kind==='native')ata.writeUInt32LE(1,109);
  if(kind==='mint')pk(22).toBuffer().copy(ata,0);
  if(kind==='program-owner')f.rows[12]={...f.rows[12]!,owner:pk(22)};
  if(kind==='layout')f.rows[12]={...f.rows[12]!,data:ata.subarray(0,164)};
  if(kind==='system-data')f.rows[12]={...f.rows[12]!,owner:SystemProgram.programId,data:Buffer.of(0)};
  if(kind==='system-executable')f.rows[12]={...f.rows[12]!,owner:SystemProgram.programId,data:Buffer.alloc(0),executable:true};
  await expect(factory(f.reader,f.trust,{claimantAccountPolicy:'historical'})(f.request)).rejects.toMatchObject({code:'TOKEN'});
 });
 it('historical account policy represents a closed SOL-funded address as no token ATA, retaining the real source occupant',async()=>{
  const f=await fixture();f.rows[12]={...f.rows[12]!,owner:SystemProgram.programId,data:Buffer.alloc(0),lamports:123};
  await expect(factory(f.reader,f.trust)(f.request)).rejects.toMatchObject({code:'TOKEN'});
  const history=await factory(f.reader,f.trust,{claimantAccountPolicy:'historical'})(f.request);
  expect(history.claimantAta).toMatchObject({exists:false,balanceBaseUnits:null});expect(history.source.accounts[12]).toMatchObject({exists:true,owner:SystemProgram.programId.toBase58(),executable:false});expect(history.currentClaimsAuthorized).toBe(false);
 });
 it.each(['partial','miner-owner','miner-wallet','root-owner','root-address','root-day','root-kind','root-total','epoch-total','epoch-cap','program-revision','clock-context','genesis','context','extra-row','sparse-row','oversize-root','unsafe-sol','missing-sol','payer-owner','payer-data','ata-owner','ata-mint','ata-address','ata-delegate','ata-close','ata-frozen','ata-native','shortfall'] as const)('refuses %s rather than fabricating claim readiness or a zero balance',async kind=>{
  const f=await fixture();await f.records();
  const patch=(i:number,p:object)=>{f.rows[i]={...f.rows[i]!,...p};};
  if(kind==='partial')f.rows[11]=null;
  if(kind==='miner-owner')patch(10,{owner:pk(22)});
  if(kind==='miner-wallet'){f.miner.wallet=pk(22);await f.records();}
  if(kind==='root-owner')patch(8,{owner:SystemProgram.programId});
  if(kind==='root-address')patch(8,{address:pk(22)});
  if(kind==='root-day'){f.root.day++;await f.encodeRoot();}
  if(kind==='root-kind'){f.root.kind=1;await f.encodeRoot();}
  if(kind==='root-total'){f.root.total_cumulative++;await f.encodeRoot();}
  if(kind==='epoch-total'){f.epoch.player_net++;await f.encodeEpoch();}
  if(kind==='epoch-cap'){f.epoch.free_gross=6n;f.epoch.deed_gross=94n;await f.encodeEpoch();}
  if(kind==='program-revision')f.backing.rows[5]!.data.writeBigUInt64LE(91n,4);
  if(kind==='clock-context')f.backing.rows[7]!.data.writeBigUInt64LE(149n);
  if(kind==='genesis')f.reader.getGenesisHash=async()=>pk(22).toBase58();
  if(kind==='context')f.reader.getMultipleAccountsInfoAndContext=async()=>({context:{slot:149},value:f.rows});
  if(kind==='extra-row')f.rows.push(null);
  if(kind==='oversize-root')patch(8,{data:Buffer.alloc(4096)});
  if(kind==='unsafe-sol')patch(13,{lamports:Number.MAX_SAFE_INTEGER+1});
  if(kind==='missing-sol')patch(13,{lamports:undefined});
  if(kind==='payer-owner')patch(13,{owner:pk(22)});
  if(kind==='payer-data')patch(13,{data:Buffer.of(1)});
  if(kind==='ata-owner')patch(12,{owner:pk(22)});
  if(kind==='ata-mint')pk(22).toBuffer().copy(Buffer.from(f.rows[12]!.data.buffer,f.rows[12]!.data.byteOffset,f.rows[12]!.data.byteLength));
  if(kind==='ata-address')patch(12,{address:pk(22)});
  const ata=Buffer.from(f.rows[12]!.data.buffer,f.rows[12]!.data.byteOffset,f.rows[12]!.data.byteLength);
  if(kind==='ata-delegate')ata.writeUInt32LE(1,72);
  if(kind==='ata-close')ata.writeUInt32LE(1,129);
  if(kind==='ata-frozen')ata[108]=2;
  if(kind==='ata-native')ata.writeUInt32LE(1,109);
  if(kind==='shortfall')f.backing.rows[1]!.data.writeBigUInt64LE(89n,64);
  if(kind==='sparse-row')delete f.rows[12];
  await expect(factory(f.reader,f.trust)(f.request)).rejects.toThrow(/Mining claim snapshot refused/);
 });
 it('represents a claimant who owns the reserve ATA once without counting its balance twice',async()=>{
  const f=await fixture({wallet:pk(2)});f.rows[12]=f.rows[2]!;
  const r=await factory(f.reader,f.trust)(f.request);expect(r.claimantAta.balanceBaseUnits).toBe(10n);expect(r.backing.reserveAmount).toBe(10n);
 });
 it('rejects malformed factory/request identities with a typed refusal before the account read',async()=>{
  const f=await fixture();expect(()=>factory(f.reader,{...f.trust,expectedGenesisHash:'0'.repeat(32)})).toThrowError(expect.objectContaining({code:'INPUT'}));
  await expect(factory(f.reader,f.trust)({...f.request,sequence:0n})).rejects.toMatchObject({code:'INPUT'});expect(f.readCount()).toBe(0);
 });
 it('copies the one bank before subsequent source calls can mutate reused buffers',async()=>{
  const f=await fixture();let slots=0;f.reader.getSlot=async()=>{if(++slots===2){f.rows[8]!.data.fill(0);f.backing.rows[1]!.data.fill(0);f.rows[13]={...f.rows[13]!,lamports:0};}return 150;};
  const r=await factory(f.reader,f.trust)(f.request);expect(r.root.totalCumulative).toBe(80n);expect(r.backing.vaultAmount).toBe(100n);expect(r.payer.lamports).toBe(1_000_000_000n);expect(f.readCount()).toBe(1);
 });
});
