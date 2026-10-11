/** Actual encoded term/receipt fixtures; synthetic RPC, no signing or network. */
import {randomUUID} from 'node:crypto';
import {describe,it,expect,afterEach} from 'vitest';
import {createRequire} from 'node:module';
// Test fixture encoding uses the chain package's pinned Anchor dependency.
const anchorPkg=createRequire(new URL('../../../packages/chain/package.json',import.meta.url))('@coral-xyz/anchor');
import {Message,PublicKey,SystemProgram} from '@solana/web3.js';
import {PHASE_E_POLICY,PHASE_E_MINING_PUBLICATION} from '@shardkeep/shared';
import {realmSaleQuoteFixture} from '../../../packages/chain/src/seekerRealmSaleQuote.fixture';
import {createSeekerRealmSaleQuoteReader} from '@shardkeep/chain/seeker-realm-sale-quote';
import {buildRealmSaleMessage} from '@shardkeep/chain/seeker-realm-sale-message';
import {realmSaleReceiptPda,REALM_SALE_ACCOUNT_BYTES} from '@shardkeep/chain/seeker-realm-sale';
import idl from '../../../packages/chain/src/idl/shardkeep_economy.json' with {type:'json'};
import {createRealmSaleAdmissionReader} from '../src/seeker/realmSaleAdmission';
import {validateRealmSalePreparation,type RealmSalePreparation} from '../src/seeker/realmSalePreparationStore';
const flag=process.env['PHASE_E_SEEKER_ENABLED'];afterEach(()=>{if(flag===undefined)delete process.env['PHASE_E_SEEKER_ENABLED'];else process.env['PHASE_E_SEEKER_ENABLED']=flag;});
const tick=(ms=10)=>new Promise(resolve=>setTimeout(resolve,ms));
async function fixture(missing=false){
 const f=await realmSaleQuoteFixture(),sources={connect:()=>f.rpc,policy:{term:f.termPolicy,access:f.accessTrust,revision:'test-r1'}};
 if(missing){f.store.delete(f.addresses.access.toBase58());f.store.delete(f.addresses.quota.toBase58());}
 const q=await createSeekerRealmSaleQuoteReader(sources.connect,sources.policy)({buyer:f.buyer,spot:0,realm:0},{saleId:Buffer.alloc(16,5)}),a=q.args,s=q.source;
 const plan=buildRealmSaleMessage(f.termPolicy.programId,{wallet:f.buyer,args:a,blockhash:q.blockhash,needsAccess:!q.accessExists,needsQuota:!q.quotaExists});
 const rents=plan.expectedNewAccounts.map(n=>{const r=q.rents.find(r=>r.address===n.address)!;return {address:r.address,space:r.bytes,minimumBalanceLamports:r.minimumBalanceLamports.toString(),existingLamports:r.existingLamports.toString(),maxIncreaseLamports:r.lamports.toString()};});
 const saved=validateRealmSalePreparation({version:1,wallet:q.buyer,idempotencyKey:randomUUID(),saleId:Buffer.from(a.saleId).toString('hex'),spot:0,realm:0,
  terms:{round:a.round.toString(),day:a.day.toString(),seller:q.seller,developer:q.developer,priorExpiry:a.priorExpiry.toString(),validAfter:a.validAfter.toString(),validUntil:a.validUntil.toString()},
  source:{revision:s.revision,genesisHash:s.genesisHash,programId:s.programId,programDataSha256:s.programDataSha256,reviewedDeploymentSlot:s.reviewedDeploymentSlot,termProofHash:s.termProofHash,snapshotHash:s.snapshotHash,termSlot:s.termSlot,initialSlot:s.initialSlot,blockhashSlot:s.blockhashSlot,feeSlot:s.feeSlot,costSlot:s.costSlot,admissionSlot:s.admissionSlot},
  quote:{blockhash:q.blockhash,lastValidBlockHeight:q.lastValidBlockHeight,unixTimestamp:q.unixTimestamp.toString(),needsAccess:!q.accessExists,needsQuota:!q.quotaExists,quotaRemaining:q.quotaRemaining,messageHex:Buffer.from(q.messageBytes).toString('hex'),messageSha256:q.messageSha256,packetBytes:q.packetBytes,rents,feeLamports:q.feeLamports.toString(),rentLamports:q.rentLamports.toString(),paymentDebitLamports:q.paymentDebitLamports.toString(),requiredLamports:q.requiredLamports.toString(),payerLamports:q.payerLamports.toString()},state:'prepared',currentSigningAuthorized:false,submissionAuthorized:false});
 process.env['PHASE_E_SEEKER_ENABLED']='true';return {f,sources,saved,q};
}
describe('original sale admission facts',()=>{
 it('preserves original message/identity/window, checks exact original fee and grants no signing authority',async()=>{
  const {f,sources,saved}=await fixture(),before=JSON.stringify(saved),read=createRealmSaleAdmissionReader(sources);f.controls.now+=10n;f.controls.slot++;
  const messages:Message[]=[],fee=f.rpc.getFeeForMessage.bind(f.rpc),heights:unknown[]=[];f.rpc.getFeeForMessage=async(...a)=>{messages.push(Message.from(a[0].serialize()));return fee(...a);};f.rpc.getBlockHeight=async config=>{heights.push(config);return f.controls.blockHeight;};
  const result=await read(saved);expect(result).toMatchObject({admissionEligible:true,saleId:saved.saleId,messageSha256:saved.quote.messageSha256,signingAuthorized:false,paymentAuthorized:false,submissionAuthorized:false,reservation:false});expect(result.unixTimestamp).toBe(f.controls.now);
  expect(Buffer.from(messages.at(-1)!.serialize()).toString('hex')).toBe(saved.quote.messageHex);expect(heights.at(-1)).toEqual({commitment:'finalized',minContextSlot:f.controls.slot});expect(JSON.stringify(saved)).toBe(before);
 });
 it('validates original bytes before RPC and owns a copy of saved input',async()=>{
  const {sources,saved}=await fixture();let calls=0;const read=createRealmSaleAdmissionReader({...sources,connect:()=>{calls++;return sources.connect();}});
  await expect(read({...saved,quote:{...saved.quote,messageHex:'00'}})).rejects.toMatchObject({code:'INVALID_PREPARATION'});expect(calls).toBe(0);const promise=read(saved);saved.terms.seller=PublicKey.default.toBase58();expect((await promise).admissionEligible).toBe(true);
 });
 it('holds flag off before and after asynchronous reads',async()=>{
  const {f,sources,saved}=await fixture(),read=createRealmSaleAdmissionReader(sources);process.env['PHASE_E_SEEKER_ENABLED']='false';const count=f.reads.length;await expect(read(saved)).rejects.toMatchObject({code:'DISABLED'});expect(f.reads.length).toBe(count);
  process.env['PHASE_E_SEEKER_ENABLED']='true';let fees=0;f.controls.onFee=()=>{if(++fees===2)process.env['PHASE_E_SEEKER_ENABLED']='false';};await expect(read(saved)).rejects.toMatchObject({code:'DISABLED'});
 });
 it.each(['before','after','next-day','term-end'] as const)('holds original calendar/window: %s',async kind=>{
  const {f,sources,saved}=await fixture();f.controls.now=kind==='before'?BigInt(saved.terms.validAfter)-1n:kind==='after'?BigInt(saved.terms.validUntil)+1n:kind==='next-day'?(BigInt(saved.terms.day)+1n)*BigInt(PHASE_E_MINING_PUBLICATION.daySec):f.models.term.operating_end;
  await expect(createRealmSaleAdmissionReader(sources)(saved)).rejects.toBeDefined();
 });
 it.each(['pause','quota','coverage','seller','registry','init-access','init-quota'] as const)('holds authoritative change: %s',async kind=>{
  const {f,sources,saved}=await fixture();if(kind==='pause')f.models.authority.admission_paused=true;if(kind==='quota')f.models.quota.sales=PHASE_E_POLICY.seekerIsland.paidContractsPerSpotDayMax;if(kind==='coverage')f.models.access.expires_at=f.controls.now+1n;
  if(kind==='seller'){f.models.auctions[0]!.fields.result_owner=f.developer;f.models.auctions[0]!.fields.high_bidder=f.developer;}if(kind==='registry')f.models.registry.entries[0]!.realm_mask^=2;
  await f.repack();if(kind==='init-access')f.store.delete(f.addresses.access.toBase58());if(kind==='init-quota')f.store.delete(f.addresses.quota.toBase58());await expect(createRealmSaleAdmissionReader(sources)(saved)).rejects.toBeDefined();
 });
 it('holds opposite initialization race rather than replacing the packet',async()=>{const {f,sources,saved}=await fixture(true);await f.repack();await expect(createRealmSaleAdmissionReader(sources)(saved)).rejects.toMatchObject({code:'CONSENT_CHANGED'});});
 it.each(['fee','rent','sol','original-fee'] as const)('holds approved cost/funding cap: %s',async kind=>{
  const {f,sources,saved}=await fixture();if(kind==='fee')f.controls.fee=Number(saved.quote.feeLamports)+1;if(kind==='rent')f.controls.rent++;if(kind==='sol')f.controls.balance=1;
  if(kind==='original-fee'){const fee=f.rpc.getFeeForMessage.bind(f.rpc);let calls=0;f.rpc.getFeeForMessage=async(...a)=>{const r=await fee(...a);return ++calls===2?{...r,value:Number(saved.quote.feeLamports)+1}:r;};}
  await expect(createRealmSaleAdmissionReader(sources)(saved)).rejects.toMatchObject(kind==='sol'?{code:'QUOTE_UNAVAILABLE',reason:'INSUFFICIENT_SOL'}:{code:'COST_EXCEEDED'});
 });
 it('checks individual PDA rent caps even when prefunding lowers the total',async()=>{
  const {f,sources,saved}=await fixture(true),address=realmSaleReceiptPda(f.termPolicy.programId,f.buyer,Buffer.from(saved.saleId,'hex'));f.store.set(address.toBase58(),{owner:SystemProgram.programId,executable:false,data:Buffer.alloc(0),lamports:f.controls.rent,rentEpoch:0});f.controls.rent++;
  await expect(createRealmSaleAdmissionReader(sources)(saved)).rejects.toMatchObject({code:'COST_EXCEEDED'});
 });
 it('holds expired original blockhash despite a valid newly quoted blockhash',async()=>{
  const {f,sources,saved}=await fixture();f.controls.blockHeight=saved.quote.lastValidBlockHeight+1;f.controls.lastValidBlockHeight+=100;await expect(createRealmSaleAdmissionReader(sources)(saved)).rejects.toMatchObject({code:'BLOCKHASH_EXPIRED'});
 });
 it.each(['genesis','slot','null-fee','throw'] as const)('holds untrusted trailing measurement: %s',async kind=>{
  const {f,sources,saved}=await fixture();let fees=0;const fee=f.rpc.getFeeForMessage.bind(f.rpc);f.rpc.getFeeForMessage=async(...a)=>{const value=await fee(...a);if(++fees!==2)return value;if(kind==='throw')throw Error('offline');if(kind==='genesis')f.controls.genesisHash=f.seller.toBase58();if(kind==='slot')f.controls.slot--;return kind==='null-fee'?{...value,value:null}:value;};
  await expect(createRealmSaleAdmissionReader(sources)(saved)).rejects.toMatchObject({code:'SOURCE_UNAVAILABLE'});
 });
 it('routes an already recorded original receipt to recovery',async()=>{
  const {f,sources,saved,q}=await fixture(),{BorshAccountsCoder,BN}=anchorPkg,coder=new BorshAccountsCoder(idl),a=q.args,p=PHASE_E_POLICY.seekerIsland;
  const [address,bump]=PublicKey.findProgramAddressSync([Buffer.from('realm_sale'),f.buyer.toBuffer(),Buffer.from(saved.saleId,'hex')],f.termPolicy.programId);
  const model={version:a.version,config:f.addresses.saleConfig,sale_id:[...a.saleId],buyer:f.buyer,seller:f.seller,developer:f.developer,term:f.addresses.term,spot:a.spot,realm:a.realm,day:new BN(a.day.toString()),round:new BN(a.round.toString()),registry_version:a.registryVersion,registry_hash:f.models.registry.hash,price_lamports:new BN(p.permitPriceLamports),seller_lamports:new BN(p.permitPriceLamports*p.contractSellerBps/PHASE_E_POLICY.basisPoints),developer_lamports:new BN(p.permitPriceLamports*p.contractDevBps/PHASE_E_POLICY.basisPoints),prior_expiry:new BN(0),coverage_start:new BN(q.unixTimestamp.toString()),expires_at:new BN((q.unixTimestamp+a.durationSec).toString()),accepted_at:new BN(q.unixTimestamp.toString()),bump};
  f.models.access.expires_at=q.unixTimestamp+a.durationSec;f.models.quota.sales=1;await f.repack();
  const data=Buffer.alloc(REALM_SALE_ACCOUNT_BYTES.RealmSaleReceipt);(await coder.encode('RealmSaleReceipt',model)).copy(data);f.store.set(address.toBase58(),{owner:f.termPolicy.programId,executable:false,data,lamports:f.controls.rent,rentEpoch:0});await expect(createRealmSaleAdmissionReader(sources)(saved)).rejects.toMatchObject({code:'RECOVERY_REQUIRED',reason:'ALREADY_RECORDED'});
 });
 it('holds policy revision changes and unknown request-shaped fields',async()=>{
  const {sources,saved}=await fixture();await expect(createRealmSaleAdmissionReader({...sources,policy:{...sources.policy,revision:'next'}})(saved)).rejects.toMatchObject({code:'CONSENT_CHANGED'});await expect(createRealmSaleAdmissionReader(sources)({...saved,recipient:saved.wallet} as RealmSalePreparation)).rejects.toMatchObject({code:'INVALID_PREPARATION'});
 });
 it('retains capacity after nested deadline until abort-ignoring RPC settles',async()=>{
  const {f,sources,saved}=await fixture(),original=f.rpc.getGenesisHash.bind(f.rpc),releases:Array<()=>void>=[];f.rpc.getGenesisHash=()=>new Promise(resolve=>releases.push(()=>resolve(f.controls.genesisHash)));
  const read=createRealmSaleAdmissionReader({...sources,timeoutMs:50}),all=Array.from({length:32},()=>read(saved).catch(error=>error));expect((await Promise.all(all)).every(x=>x.code==='TIMEOUT')).toBe(true);await tick(60);await expect(read(saved)).rejects.toMatchObject({code:'BUSY'});for(const release of releases)release();f.rpc.getGenesisHash=original;await tick();expect(releases).toHaveLength(32);
 });
});
