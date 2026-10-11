/** Actual Anchor account fixtures through the finalized SDK reader. No network,
 * sale writer, running validator or chain-finality evidence is claimed. */
import {PublicKey,SystemProgram} from '@solana/web3.js';
import {PHASE_E_SEEKER_AUCTION} from '@shardkeep/shared';
import {describe,expect,it,vi} from 'vitest';
import {createSeekerRealmAccessFixture} from '../../../packages/chain/src/testFixtures/seekerRealmAccess';
import {assertExpeditionRealmAccessAtDeparture,prefetchExpeditionRealmAccessReader} from '../src/game/expeditionRealmAccess';
const key=(n:number)=>new PublicKey(Buffer.alloc(32,n));
async function fixture(){
 const bank=await createSeekerRealmAccessFixture(),request={wallet:bank.wallet.toBase58(),realm:bank.realm},at=new Date(Number(bank.now*1000n));
 const connect=vi.fn(()=>bank.rpc),clock=vi.fn(()=>at);
 return {bank,request,at,connect,clock,prefetch:()=>prefetchExpeditionRealmAccessReader(connect,bank.trust,request,{clock})};
}
const iso=(date:Date,delta=0)=>new Date(date.getTime()+delta).toISOString();
describe('B4q paid-expedition access prefetch and final lock-time coverage',()=>{
 it('requests only the canonical wallet/realm bank and retains independently reviewed source and original observation',async()=>{
  const f=await fixture(),read=vi.spyOn(f.bank.rpc,'getMultipleAccountsInfoAndContext'),reader=await f.prefetch(),proof=await reader.readCoverage(iso(f.at,1));
  expect(read).toHaveBeenCalledOnce();expect(read.mock.calls[0]![0]).toHaveLength(5);expect(f.clock).toHaveBeenCalledOnce();
  expect(proof).toMatchObject({version:1,wallet:f.request.wallet,realm:f.request.realm,accessAddress:f.bank.rows[3]!.address.toBase58(),configAddress:f.bank.rows[2]!.address.toBase58(),expiresAt:f.bank.accessModel.expires_at.toString(),
   finality:{commitment:'finalized',contextSlot:String(f.bank.slot),observedAt:iso(f.at),chainUnixTimestamp:f.bank.now.toString()},source:{genesisHash:f.bank.genesis.toBase58(),programId:f.bank.programId.toBase58(),reviewedProgramDataSha256:f.bank.trust.reviewedProgramDataSha256}});
  expect(assertExpeditionRealmAccessAtDeparture(proof,f.request,iso(f.at,2))).toBe(proof);expect(f.connect).toHaveBeenCalledOnce();
  expect(proof).not.toHaveProperty('purchaseFinalized');expect(proof).not.toHaveProperty('paymentAuthorized');expect(proof).not.toHaveProperty('admissionAuthorized');
 });
 it.each([0,PHASE_E_SEEKER_AUCTION.observationMaxAgeMs])('admits the exact inclusive observation-age boundary %s',async age=>{
  const f=await fixture();expect(await (await f.prefetch()).readCoverage(iso(f.at,age))).toHaveProperty('wallet',f.request.wallet);
 });
 it.each(['stale','future','invalid'] as const)('consumes a rejected %s observation once without fresh RPC or relabeling',async kind=>{
  const f=await fixture(),reader=await f.prefetch(),at=kind==='stale'?iso(f.at,PHASE_E_SEEKER_AUCTION.observationMaxAgeMs+1):kind==='future'?iso(f.at,-1):'not-a-clock';
  await expect(reader.readCoverage(at)).rejects.toThrow();await expect(reader.readCoverage(iso(f.at))).rejects.toMatchObject({code:'CONSUMED'});expect(f.connect).toHaveBeenCalledOnce();
 });
 it('allows one concurrent consumption and exposes only its authentic frozen proof for final recheck',async()=>{
  const f=await fixture(),reader=await f.prefetch(),results=await Promise.allSettled([reader.readCoverage(iso(f.at)),reader.readCoverage(iso(f.at))]);
  expect(results.map(r=>r.status)).toEqual(['fulfilled','rejected']);const proof=(results[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof reader.readCoverage>>>).value;
  for(const value of [reader,proof,proof.finality,proof.source,proof.source.accounts,proof.source.accounts[3]])expect(Object.isFrozen(value)).toBe(true);
  expect(()=>assertExpeditionRealmAccessAtDeparture({...proof},f.request,iso(f.at))).toThrow();
  expect(()=>assertExpeditionRealmAccessAtDeparture(proof,{...f.request,wallet:key(9).toBase58()},iso(f.at))).toThrow();
  expect(()=>assertExpeditionRealmAccessAtDeparture(proof,{...f.request,realm:1},iso(f.at))).toThrow();
 });
 it('rechecks exact exclusive expiry after a lock wait, independent of the longer return duration',async()=>{
  const f=await fixture();f.bank.accessModel.expires_at=f.bank.accessModel.expires_at.clone().sub(f.bank.accessModel.expires_at).addn(Number(f.bank.now+1n));await f.bank.encode('access');
  const proof=await (await f.prefetch()).readCoverage(iso(f.at,999));expect(proof.expiresAt).toBe(String(f.bank.now+1n));
  expect(()=>assertExpeditionRealmAccessAtDeparture(proof,f.request,iso(f.at,1000))).toThrow(/EXPIRED/);
  expect(()=>assertExpeditionRealmAccessAtDeparture(proof,f.request,iso(f.at,PHASE_E_SEEKER_AUCTION.observationMaxAgeMs+1))).toThrow();
 });
 it.each(['absent','prefunded','expired'] as const)('distinguishes authoritative %s coverage from source unavailability',async kind=>{
  const f=await fixture();if(kind==='absent')f.bank.rows[3]=null;else if(kind==='prefunded')f.bank.rows[3]={...f.bank.rows[3]!,owner:SystemProgram.programId,data:Buffer.alloc(0)};
  else{f.bank.accessModel.expires_at=f.bank.accessModel.expires_at.clone().sub(f.bank.accessModel.expires_at).addn(Number(f.bank.now));await f.bank.encode('access');}
  const reader=await f.prefetch();await expect(reader.readCoverage(iso(f.at))).rejects.toMatchObject({code:kind==='expired'?'EXPIRED':'NO_COVERAGE'});
  await expect(reader.readCoverage(iso(f.at))).rejects.toMatchObject({code:'CONSUMED'});
 });
 it('propagates provider failure as unavailable rather than fabricating an absent permit',async()=>{
  const f=await fixture();f.bank.rpc.getGenesisHash=async()=>{throw Error('fixture provider offline');};await expect(f.prefetch()).rejects.toMatchObject({code:'UNAVAILABLE'});
 });
 it('does not classify a stale absent-account observation as current no coverage',async()=>{
  const f=await fixture();f.bank.rows[3]=null;await expect((await f.prefetch()).readCoverage(iso(f.at,PHASE_E_SEEKER_AUCTION.observationMaxAgeMs+1))).rejects.toMatchObject({code:'STALE'});
 });
 it.each(['wallet','realm','config','program','programData','genesis','clock'] as const)('refuses a substituted %s authority using actual SDK checks',async kind=>{
  const f=await fixture();if(kind==='wallet'){f.bank.accessModel.wallet=key(9);await f.bank.encode('access');}
  if(kind==='realm'){f.bank.accessModel.realm=1;await f.bank.encode('access');}
  if(kind==='config'){f.bank.accessModel.config=key(9);await f.bank.encode('access');}
  if(kind==='program')f.bank.rows[0]!.owner=key(9);if(kind==='programData')f.bank.rows[1]!.data[50]=99;
  if(kind==='genesis')f.bank.rpc.getGenesisHash=async()=>key(9).toBase58();if(kind==='clock')f.bank.rows[4]!.data.writeBigInt64LE(f.bank.now+1n,32);
  if(kind==='clock')await expect((await f.prefetch()).readCoverage(iso(f.at))).rejects.toMatchObject({code:'STALE'});else await expect(f.prefetch()).rejects.toMatchObject({code:'SOURCE'});
 });
 it('owns request, trust, original receive clock and account evidence across asynchronous work',async()=>{
  const f=await fixture(),original={...f.request},at=iso(f.at),read=f.bank.rpc.getMultipleAccountsInfoAndContext;let release!:()=>void;
  const waiting=new Promise<void>(resolve=>{release=resolve;});f.bank.rpc.getMultipleAccountsInfoAndContext=async(...args)=>{await waiting;return read(...args);};
  const pending=f.prefetch();f.request.wallet=key(9).toBase58();f.request.realm=1;f.bank.trust.programId=key(9);f.bank.trust.reviewedProgramDataSha256='ab'.repeat(32);f.at.setTime(f.at.getTime()+9999);release();
  const reader=await pending;f.bank.rows[3]!.data.fill(0);const proof=await reader.readCoverage(at);
  expect(proof.wallet).toBe(original.wallet);expect(proof.realm).toBe(original.realm);expect(proof.finality.observedAt).toBe(at);expect(proof.source.programId).toBe(f.bank.programId.toBase58());
 });
 it('does not require current sales, spot, sale receipt or auction-owner authority for existing access',async()=>{
  const f=await fixture();f.bank.rows[5]=null;const old=process.env['PHASE_E_SEEKER_ENABLED'];process.env['PHASE_E_SEEKER_ENABLED']='false';
  try{expect(await (await f.prefetch()).readCoverage(iso(f.at))).toHaveProperty('wallet',f.request.wallet);}finally{if(old===undefined)delete process.env['PHASE_E_SEEKER_ENABLED'];else process.env['PHASE_E_SEEKER_ENABLED']=old;}
 });
 it('rejects request-side authority fields and invalid identity/time before opening a provider',async()=>{
  for(const extra of [{permit:true},{purchaseFinalized:true},{expiresAt:'9999999999'},{saleId:Buffer.alloc(16,1)}]){const f=await fixture();await expect(prefetchExpeditionRealmAccessReader(f.connect,f.bank.trust,{...f.request,...extra},{clock:f.clock})).rejects.toMatchObject({code:'INPUT'});expect(f.connect).not.toHaveBeenCalled();}
  for(const request of [{wallet:'invalid',realm:0},{wallet:key(9).toBase58(),realm:-1},{wallet:key(9).toBase58(),realm:1.5}]){const f=await fixture();await expect(prefetchExpeditionRealmAccessReader(f.connect,f.bank.trust,request,{clock:f.clock})).rejects.toMatchObject({code:'INPUT'});expect(f.connect).not.toHaveBeenCalled();}
  const f=await fixture();await expect(prefetchExpeditionRealmAccessReader(f.connect,f.bank.trust,f.request,{clock:()=>new Date(NaN)})).rejects.toMatchObject({code:'INPUT'});expect(f.connect).not.toHaveBeenCalled();
 });
});
