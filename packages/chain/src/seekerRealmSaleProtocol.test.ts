import { describe, expect, it } from 'vitest';
import anchorPkg, { type Idl } from '@coral-xyz/anchor';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import { PHASE_E_POLICY, PHASE_E_SEEKER_SALE, PHASE_E_MINING_PUBLICATION } from '@shardkeep/shared';
import idl from './idl/shardkeep_economy.json' with { type: 'json' };
import { canonicalSeekerRegistry, hashSeekerRegistry, seekerAuthorityPda, seekerAuctionConfigPda, seekerTermPda } from './seekerAuctionProtocol';
import { REALM_SALE_ACCOUNT_BYTES, realmSaleConfigPda, realmAccessPda, spotSalesQuotaPda, realmSaleReceiptPda,
 createRealmSalePurchaseArgs, validateRealmSalePurchaseArgs, decodeRealmSaleConfig, decodeRealmAccess, decodeSpotSalesQuota,
 decodeRealmSaleReceipt, matchRealmSaleReceipt, buildInitializeRealmSaleConfigInstruction, buildOpenRealmAccessInstruction,
 buildOpenSpotSalesQuotaInstruction, buildBuyRealmAccessInstruction, type RealmSaleRawAccount, type RealmSalePurchaseArgs } from './seekerRealmSaleProtocol';
const { BorshCoder, BN } = anchorPkg, coder = new BorshCoder(idl as Idl), programId = new PublicKey(idl.address);
const P = PHASE_E_POLICY.seekerIsland, S = PHASE_E_SEEKER_SALE, D = BigInt(PHASE_E_MINING_PUBLICATION.daySec);
const key = (n:number) => new PublicKey(Buffer.alloc(32,n));
const buyer = key(1), seller = key(2), developer = key(3), now = 10n*D, round = 2n, saleId = Buffer.alloc(16,4);
const le = (n:bigint) => { const b=Buffer.alloc(8);b.writeBigUInt64LE(n);return b; };
const derive = (seed:string,...tail:Buffer[]) => PublicKey.findProgramAddressSync([Buffer.from(seed),...tail],programId);
const args = () => createRealmSalePurchaseArgs({saleId,spot:0,realm:0,round,day:10n,seller,developer,priorExpiry:0n,validAfter:now,validUntil:now+BigInt(S.quoteTtlSec)});
const accountCases = ['RealmSaleConfig','RealmAccess','SpotSalesQuota','RealmSaleReceipt'] as const;
type Name = typeof accountCases[number];
function model(name:Name): Record<string,unknown> {
 const config=realmSaleConfigPda(programId);
 switch(name) {
 case 'RealmSaleConfig':return {version:S.version,authority:seekerAuthorityPda(programId),developer,price_lamports:new BN(P.permitPriceLamports),
  duration_sec:new BN(P.permitDurationSec),seller_bps:P.contractSellerBps,developer_bps:P.contractDevBps,quota_max:P.paidContractsPerSpotDayMax,
  day_sec:new BN(D.toString()),quote_ttl_sec:new BN(S.quoteTtlSec),bump:derive('realm_sale_config')[1]};
 case 'RealmAccess':return {version:S.version,config,wallet:buyer,realm:0,expires_at:new BN(0),bump:derive('realm_access',buyer.toBuffer(),Buffer.of(0))[1]};
 case 'SpotSalesQuota':return {version:S.version,spot:0,day:new BN(10),sales:P.paidContractsPerSpotDayMax,bump:derive('spot_sales',Buffer.of(0),le(10n))[1]};
 case 'RealmSaleReceipt':return {version:S.version,config,sale_id:[...saleId],buyer,seller,developer,
  term:seekerTermPda(programId,seekerAuctionConfigPda(programId),round),spot:0,realm:0,day:new BN(10),round:new BN(round.toString()),registry_version:1,
  registry_hash:[...hashSeekerRegistry(canonicalSeekerRegistry())],price_lamports:new BN(P.permitPriceLamports),
  seller_lamports:new BN(P.permitPriceLamports*P.contractSellerBps/PHASE_E_POLICY.basisPoints),developer_lamports:new BN(P.permitPriceLamports*P.contractDevBps/PHASE_E_POLICY.basisPoints),
  prior_expiry:new BN(0),coverage_start:new BN(now.toString()),expires_at:new BN((now+BigInt(P.permitDurationSec)).toString()),accepted_at:new BN(now.toString()),
  bump:derive('realm_sale',buyer.toBuffer(),saleId)[1]};
 }
}
async function raw(name:Name,patch:Record<string,unknown>={}):Promise<RealmSaleRawAccount> {
 const address=name==='RealmSaleConfig'?realmSaleConfigPda(programId):name==='RealmAccess'?realmAccessPda(programId,buyer,0)
  :name==='SpotSalesQuota'?spotSalesQuotaPda(programId,0,10n):realmSaleReceiptPda(programId,buyer,saleId);
 return {address,owner:programId,executable:false,data:await coder.accounts.encode(name,{...model(name),...patch})};
}
const decode = (name:Name,r:RealmSaleRawAccount) => name==='RealmSaleConfig'?decodeRealmSaleConfig(r,{programId,developer})
 :name==='RealmAccess'?decodeRealmAccess(r,{programId,wallet:buyer,realm:0})
 :name==='SpotSalesQuota'?decodeSpotSalesQuota(r,{programId,spot:0,day:10n}):decodeRealmSaleReceipt(r,{programId,buyer,saleId});
function anchorArgs(a:RealmSalePurchaseArgs) {return Object.fromEntries(Object.entries(a).map(([name,value])=>[name.replace(/[A-Z]/g,c=>'_'+c.toLowerCase()),
 typeof value==='bigint'?new BN(value.toString()):value instanceof Uint8Array?[...value]:value]));}

describe('pure atomic realm sale ABI',()=>{
 it('derives exact immutable PDAs without quota owner/term/realm dimensions',()=>{
  expect(realmSaleConfigPda(programId)).toEqual(derive('realm_sale_config')[0]);
  expect(realmAccessPda(programId,buyer,0)).toEqual(derive('realm_access',buyer.toBuffer(),Buffer.of(0))[0]);
  expect(spotSalesQuotaPda(programId,0,10n)).toEqual(derive('spot_sales',Buffer.of(0),le(10n))[0]);
  expect(realmSaleReceiptPda(programId,buyer,saleId)).toEqual(derive('realm_sale',buyer.toBuffer(),saleId)[0]);
  expect(spotSalesQuotaPda(programId,1,10n)).not.toEqual(spotSalesQuotaPda(programId,0,10n));
  expect(REALM_SALE_ACCOUNT_BYTES).toEqual({RealmSaleConfig:111,RealmAccess:83,SpotSalesQuota:20,RealmSaleReceipt:294});
 });
 it.each(accountCases)('roundtrips actual generated Anchor %s fixtures but never claims finality/payment authority',async name=>{
  const r=await raw(name),m=decode(name,r);expect(m.address).toBe(r.address.toBase58());expect(m.finalityVerified).toBe(false);expect(m.paymentAuthorized).toBe(false);expect(Object.isFrozen(m)).toBe(true);
 });
 it.each(accountCases)('rejects wrong owner/address/executable/discriminator/size/trailing/variant/bump for %s',async name=>{
  const r=await raw(name),altered=Buffer.from(r.data);altered[0]=altered[0]!^1;
  for(const patch of [{owner:key(9)},{address:key(9)},{executable:true},{data:altered},{data:r.data.slice(0,-1)},
   {data:Buffer.concat([r.data,Buffer.of(0)])},{data:await coder.accounts.encode(name,{...model(name),version:S.version+1})},
   {data:await coder.accounts.encode(name,{...model(name),bump:((model(name).bump as number)+1)%256})}]) expect(()=>decode(name,{...r,...patch})).toThrow();
  expect(()=>decode(name,{...r,unexpected:true} as RealmSaleRawAccount)).toThrow();
 });
 it('checks immutable config policy and recipient expectations',async()=>{
  for(const patch of [{authority:key(8)},{developer:key(8)},{price_lamports:new BN(P.permitPriceLamports+1)},
   {duration_sec:new BN(P.permitDurationSec+1)},{seller_bps:P.contractSellerBps+1},{developer_bps:P.contractDevBps+1},
   {quota_max:P.paidContractsPerSpotDayMax+1},{day_sec:new BN(1)},{quote_ttl_sec:new BN(S.quoteTtlSec+1)}]) {const r=await raw('RealmSaleConfig',patch);expect(()=>decodeRealmSaleConfig(r,{programId,developer})).toThrow();}
 });
 it('refuses substituted access identities and negative expiry',async()=>{
  for(const patch of [{config:key(8)},{wallet:key(8)},{realm:1},{expires_at:new BN(-1)}]){const r=await raw('RealmAccess',patch);expect(()=>decode('RealmAccess',r)).toThrow();}
 });
 it('accepts exhausted quota for observation but refuses corrupt counters and identity',async()=>{
  expect(decodeSpotSalesQuota(await raw('SpotSalesQuota'),{programId,spot:0,day:10n}).sales).toBe(P.paidContractsPerSpotDayMax);
  for(const patch of [{spot:1},{day:new BN(11)},{sales:P.paidContractsPerSpotDayMax+1}]){const r=await raw('SpotSalesQuota',patch);expect(()=>decode('SpotSalesQuota',r)).toThrow();}
 });
 it('uses owned sale-ID copies and only shared policy defaults',()=>{
  const id=Buffer.from(saleId),a=createRealmSalePurchaseArgs({saleId:id,spot:0,realm:0,round,day:10n,seller,developer,priorExpiry:0n,validAfter:now,validUntil:now+BigInt(S.quoteTtlSec)});id[0]=id[0]!^1;expect(Buffer.from(a.saleId)).toEqual(saleId);a.saleId[0]=a.saleId[0]!^1;expect(Buffer.from(a.saleId)).toEqual(saleId);expect(a.priceLamports).toBe(BigInt(P.permitPriceLamports));
 });
 it.each(['version','priceLamports','durationSec','sellerBps','developerBps','registryVersion'] as const)('rejects signed %s substitution',field=>{
  const a=args(),v=a[field];expect(()=>validateRealmSalePurchaseArgs({...a,[field]:typeof v==='bigint'?v+1n:v+1})).toThrow();
 });
 it.each([-1n,1n<<64n,1 as unknown as bigint])('rejects wrong round integer %s',round=>{expect(()=>validateRealmSalePurchaseArgs({...args(),round})).toThrow();});
 it('rejects malformed keys/IDs, unknown fields, bounds, day/window inconsistencies and expiry overflow',()=>{
  const a=args();for(const patch of [{saleId:Buffer.alloc(16)},{saleId:Buffer.alloc(15)},{seller:PublicKey.default},{developer:PublicKey.default},
   {spot:P.totalSpots},{realm:P.realmCount},{realm:NaN},{round:-1n},{day:(1n<<63n)/D},{priorExpiry:-1n},
   {priorExpiry:(1n<<63n)-1n},{validAfter:-1n},{validUntil:a.validAfter-1n},{validUntil:a.validUntil+1n},
   {day:11n},{day:10 as unknown as bigint},{extra:1}])expect(()=>validateRealmSalePurchaseArgs({...a,...patch})).toThrow();
  const fake={toBytes:()=>seller.toBytes(),toBase58:()=>developer.toBase58()} as PublicKey;
  expect(()=>validateRealmSalePurchaseArgs({...a,seller:fake})).toThrow();
  expect(()=>realmSaleConfigPda(key(9))).toThrow();
  expect(()=>validateRealmSalePurchaseArgs({...a,[Symbol('hidden')]:1})).toThrow();
 });
 it('rejects uncovered regular-spot realms before building a payment',()=>{
  const spot=P.kingSpots,mask=canonicalSeekerRegistry()[spot]!.realmMask,realm=Array.from({length:P.realmCount},(_,i)=>i).find(i=>!(mask&(1<<i)))!;
  expect(()=>validateRealmSalePurchaseArgs({...args(),spot,realm})).toThrow();
 });
 it('validates original receipt identity, conserved price and cumulative coverage',async()=>{
  const r=await raw('RealmSaleReceipt'),m=matchRealmSaleReceipt(r,{programId,buyer,args:args()});expect(m.expiresAt).toBe(now+BigInt(P.permitDurationSec));
  for(const patch of [{config:key(8)},{term:key(8)},{seller:PublicKey.default},{developer:PublicKey.default},{registry_version:2},
   {registry_hash:Array(32).fill(0)},{price_lamports:new BN(1)},{seller_lamports:new BN(1)},{developer_lamports:new BN(1)},
   {prior_expiry:new BN(-1)},{coverage_start:new BN((now+1n).toString())},{expires_at:new BN((now+BigInt(P.permitDurationSec)+1n).toString())},
   {accepted_at:new BN(-1)},{day:new BN(11)}]){const bad=await raw('RealmSaleReceipt',patch);expect(()=>decode('RealmSaleReceipt',bad)).toThrow();}
 });
 it.each(['seller','developer','round','priorExpiry','spot','realm','validAfter','validUntil'] as const)('receipt matching binds exact prepared %s',async field=>{
  const a=args(),r=await raw('RealmSaleReceipt');
  const patch=field==='seller'||field==='developer'?key(9):field==='spot'||field==='realm'?1:field==='validUntil'?now-1n:field==='validAfter'?now+1n:a[field]+1n;
  expect(()=>matchRealmSaleReceipt(r,{programId,buyer,args:{...a,[field]:patch}})).toThrow();
 });
 it('matches renewal from a future prior expiry and preserves old rights without a current-term lookup',async()=>{
  const prior=now+BigInt(P.permitDurationSec),a={...args(),priorExpiry:prior};
  const r=await raw('RealmSaleReceipt',{prior_expiry:new BN(prior.toString()),coverage_start:new BN(prior.toString()),expires_at:new BN((prior+BigInt(P.permitDurationSec)).toString())});
  expect(matchRealmSaleReceipt(r,{programId,buyer,args:a}).expiresAt).toBe(prior+BigInt(P.permitDurationSec));
 });
 it('encodes all four instructions exactly through generated IDL and canonical account metas',()=>{
  const a=args(),init=buildInitializeRealmSaleConfigInstruction(programId,{admin:buyer,upgradeAuthority:seller,developer});
  const open=buildOpenRealmAccessInstruction(programId,{payer:buyer,wallet:seller,realm:0});
  const quota=buildOpenSpotSalesQuotaInstruction(programId,{payer:buyer,spot:0,day:10n});
  const buy=buildBuyRealmAccessInstruction(programId,{buyer,args:a});
  for(const [ix,name,value] of [[init,'initialize_realm_sale_config',{}],[open,'open_realm_access',{wallet:seller,realm:0}],
   [quota,'open_spot_sales_quota',{spot:0,day:new BN(10)}],[buy,'buy_realm_access',{args:anchorArgs(a)}]] as const){
   expect(ix.programId).toEqual(programId);expect(ix.data).toEqual(coder.instruction.encode(name,value));
   const def=idl.instructions.find(i=>i.name===name)!;expect(ix.keys).toHaveLength(def.accounts.length);
   for(const [i,meta] of ix.keys.entries()){const item=def.accounts[i]!;expect(meta.isSigner).toBe('signer'in item&&item.signer===true);expect(meta.isWritable).toBe('writable'in item&&item.writable===true);}
   expect(ix.keys.at(-1)!.pubkey).toEqual(SystemProgram.programId);
  }
  const programData=PublicKey.findProgramAddressSync([programId.toBuffer()],new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'))[0];
  expect(init.keys.map(k=>k.pubkey.toBase58())).toEqual([buyer,seller,programId,programData,seekerAuthorityPda(programId),realmSaleConfigPda(programId),developer,SystemProgram.programId].map(k=>k.toBase58()));
  expect(open.keys.map(k=>k.pubkey.toBase58())).toEqual([buyer,realmSaleConfigPda(programId),realmAccessPda(programId,seller,0),SystemProgram.programId].map(k=>k.toBase58()));
  expect(quota.keys.map(k=>k.pubkey.toBase58())).toEqual([buyer,realmSaleConfigPda(programId),spotSalesQuotaPda(programId,0,10n),SystemProgram.programId].map(k=>k.toBase58()));
  expect(buy.keys.map(k=>k.pubkey.toBase58())).toEqual([buyer,seekerAuthorityPda(programId),realmSaleConfigPda(programId),seekerAuctionConfigPda(programId),derive('seeker_registry')[0],
   seekerTermPda(programId,seekerAuctionConfigPda(programId),round),derive('auction',seekerAuctionConfigPda(programId).toBuffer(),Buffer.of(0),le(round))[0],
   spotSalesQuotaPda(programId,0,10n),realmAccessPda(programId,buyer,0),realmSaleReceiptPda(programId,buyer,saleId),seller,developer,SystemProgram.programId].map(k=>k.toBase58()));
 });
 it.each([[buyer,buyer,developer],[buyer,seller,buyer],[buyer,seller,seller],[buyer,buyer,buyer]])('preserves aliases and gross signed price', (b,s,d)=>{
  const a={...args(),seller:s,developer:d},ix=buildBuyRealmAccessInstruction(programId,{buyer:b,args:a});expect(ix.keys[0]!.pubkey).toEqual(b);expect(ix.keys[10]!.pubkey).toEqual(s);expect(ix.keys[11]!.pubkey).toEqual(d);expect(a.priceLamports).toBe(BigInt(P.permitPriceLamports));
 });
 it('refuses extra account overrides and unknown expected-model fields',async()=>{
  expect(()=>buildBuyRealmAccessInstruction(programId,{buyer,args:args(),seller:key(9)} as never)).toThrow();
  expect(()=>buildInitializeRealmSaleConfigInstruction(programId,{admin:buyer,upgradeAuthority:seller,developer,programData:key(9)} as never)).toThrow();
  const r=await raw('RealmAccess');expect(()=>decodeRealmAccess(r,{programId,wallet:buyer,realm:0,extra:true} as never)).toThrow();
 });
 it('preserves the signed i64 expiry boundary and non-authoritative account flags',async()=>{
  const max=(1n<<63n)-1n;
  const decoded=decodeRealmAccess(await raw('RealmAccess',{expires_at:new BN(max.toString())}),{programId,wallet:buyer,realm:0});
  expect(decoded).toMatchObject({wallet:buyer.toBase58(),realm:0,expiresAt:max,finalityVerified:false,paymentAuthorized:false});
  expect(typeof decoded.expiresAt).toBe('bigint');expect(Object.isFrozen(decoded)).toBe(true);
 });
});
