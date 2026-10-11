/** Pure atomic-sale ABI helpers. Supplied bytes/identities are expectations, not
 * finalized Seeker authority. No signer, RPC, provider, clock, relay or payment
 * authorization is created here. The program revalidates authority at purchase. */
import type { Idl } from '@coral-xyz/anchor';
import { anchorRuntime as anchorPkg } from './anchorRuntime';
import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import { PHASE_E_POLICY, PHASE_E_SEEKER_SALE, PHASE_E_MINING_PUBLICATION } from '@shardkeep/shared';
import idl from './idl/shardkeep_economy.json' with { type: 'json' };
import { canonicalSeekerRegistry, hashSeekerRegistry, seekerAuthorityPda, seekerAuctionConfigPda,
 seekerRegistryPda, seekerTermPda, seekerAuctionPda } from './seekerAuctionProtocol';
import { isEconomyProgramIdentity } from './devnetTestProfile';
const { BorshCoder, BN } = anchorPkg, coder = new BorshCoder(idl as Idl);
// Keep the cross-copy runtime check without relying on bn.js declarations.
// The predicate names `words` (an array BN.isBN itself requires) so the false
// branch stays unknown: a toString-only shape also matches {} and narrowed it to null|undefined.
function isAnchorBN(value: unknown): value is { readonly words: readonly unknown[]; toString(): string } { return BN.isBN(value); }
const P = PHASE_E_POLICY.seekerIsland, S = PHASE_E_SEEKER_SALE, DAY = BigInt(PHASE_E_MINING_PUBLICATION.daySec);
const U64_MAX = (1n << 64n)-1n, I64_MAX = (1n << 63n)-1n, REGISTRY_VERSION = 1;
const LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
export const SEEKER_REALM_SALE_PROGRAM_ADDRESS = idl.address;
type Code = 'INPUT' | 'ACCOUNT' | 'IDENTITY' | 'POLICY' | 'COUNTER' | 'RECEIPT';
export class RealmSaleProtocolError extends Error {
 constructor(readonly code: Code) { super(`Realm sale protocol refused: ${code}`); this.name = 'RealmSaleProtocolError'; }
}
function need(value: unknown, code: Code): asserts value { if (!value) throw new RealmSaleProtocolError(code); }
function checked<T>(read:()=>T):T { try { return read(); } catch(error) { if(error instanceof RealmSaleProtocolError) throw error; throw new RealmSaleProtocolError('ACCOUNT'); } }
function exact(value: object, names: string): void {
 need(value && typeof value === 'object' && !Array.isArray(value), 'INPUT');
 const actual=Reflect.ownKeys(value), wanted=names.split(' ');
 need(actual.length===wanted.length && actual.every(k=>typeof k==='string' && wanted.includes(k)), 'INPUT');
}
function key(value: PublicKey): PublicKey {
 try {
  need(value && typeof value.toBytes==='function' && typeof value.toBase58==='function','INPUT');
  const bytes=value.toBytes(); need(bytes instanceof Uint8Array && bytes.length===32,'INPUT');
  const canonical=new PublicKey(bytes); need(canonical.toBase58()===value.toBase58() && !canonical.equals(PublicKey.default),'INPUT'); return canonical;
 } catch { throw new RealmSaleProtocolError('INPUT'); }
}
function program(value:PublicKey):PublicKey { const p=key(value); need(isEconomyProgramIdentity(p.toBase58()),'IDENTITY'); return p; }
function integer(value:bigint,signed=false):bigint { need(typeof value==='bigint' && value>=0n && value<=(signed?I64_MAX:U64_MAX),'INPUT'); return value; }
function small(value:number,max:number):number { need(Number.isSafeInteger(value) && value>=0 && value<=max,'INPUT'); return value; }
function day(value:bigint):bigint { integer(value); need((value+1n)*DAY-1n<=I64_MAX,'INPUT');return value; }
function id(value:Uint8Array):Buffer { need(value instanceof Uint8Array && value.length===16 && value.some(v=>v!==0),'INPUT');return Buffer.from(value); }
function le(value:bigint):Buffer { const out=Buffer.alloc(8);out.writeBigUInt64LE(integer(value));return out; }
function pda(p:PublicKey,seed:string,...tail:Buffer[]):readonly[PublicKey,number] {return PublicKey.findProgramAddressSync([Buffer.from(seed),...tail],program(p));}
export const realmSaleConfigPda=(p:PublicKey):PublicKey=>pda(p,'realm_sale_config')[0];
export const realmAccessPda=(p:PublicKey,wallet:PublicKey,realm:number):PublicKey=>pda(p,'realm_access',key(wallet).toBuffer(),Buffer.of(small(realm,P.realmCount-1)))[0];
export const spotSalesQuotaPda=(p:PublicKey,spot:number,d:bigint):PublicKey=>pda(p,'spot_sales',Buffer.of(small(spot,P.totalSpots-1)),le(day(d)))[0];
export const realmSaleReceiptPda=(p:PublicKey,buyer:PublicKey,saleId:Uint8Array):PublicKey=>pda(p,'realm_sale',key(buyer).toBuffer(),id(saleId))[0];

export interface RealmSalePurchaseArgs {
 readonly version:number; readonly saleId:Uint8Array; readonly spot:number; readonly realm:number;
 readonly round:bigint; readonly day:bigint; readonly seller:PublicKey; readonly developer:PublicKey;
 readonly registryVersion:number; readonly priceLamports:bigint; readonly durationSec:bigint;
 readonly sellerBps:number; readonly developerBps:number; readonly priorExpiry:bigint;
 readonly validAfter:bigint; readonly validUntil:bigint;
}
export type RealmSalePurchaseInput=Pick<RealmSalePurchaseArgs,'saleId'|'spot'|'realm'|'round'|'day'|'seller'|'developer'|'priorExpiry'|'validAfter'|'validUntil'>;
const dynamicFields='saleId spot realm round day seller developer priorExpiry validAfter validUntil';
function defaults() {return {version:S.version,registryVersion:REGISTRY_VERSION,priceLamports:BigInt(P.permitPriceLamports),
 durationSec:BigInt(P.permitDurationSec),sellerBps:P.contractSellerBps,developerBps:P.contractDevBps};}
/** Every variable consent field is explicit. No wall-clock or seller/config inference. */
export function createRealmSalePurchaseArgs(input:RealmSalePurchaseInput):Readonly<RealmSalePurchaseArgs> {
 return checked(()=>{exact(input,dynamicFields);return validateRealmSalePurchaseArgs({...defaults(),...input});});
}
export function validateRealmSalePurchaseArgs(input:RealmSalePurchaseArgs):Readonly<RealmSalePurchaseArgs> {
 return checked(()=>{
  exact(input,'version saleId spot realm round day seller developer registryVersion priceLamports durationSec sellerBps developerBps priorExpiry validAfter validUntil');
  const fixed=defaults(); for(const [name,value] of Object.entries(fixed))need(input[name as keyof RealmSalePurchaseArgs]===value,'POLICY');
  const saleId=id(input.saleId),spot=small(input.spot,P.totalSpots-1),realm=small(input.realm,P.realmCount-1);
  const round=integer(input.round),d=day(input.day),seller=key(input.seller),developer=key(input.developer);
  const priorExpiry=integer(input.priorExpiry,true),validAfter=integer(input.validAfter,true),validUntil=integer(input.validUntil,true);
  need(canonicalSeekerRegistry()[spot]!.realmMask & (1<<realm),'POLICY');
  need(validUntil>=validAfter && validUntil-validAfter<=BigInt(S.quoteTtlSec),'POLICY');
  // A quote may cross midnight, but it can execute only inside its signed UTC
  // day. Require a nonempty intersection; do not pretend a local clock is final.
  need(validAfter<(d+1n)*DAY && validUntil>=d*DAY,'POLICY');
  const latest=validUntil<(d+1n)*DAY?validUntil:(d+1n)*DAY-1n;
  need((priorExpiry>latest?priorExpiry:latest)+fixed.durationSec<=I64_MAX,'COUNTER');
  return Object.freeze({...fixed,spot,realm,round,day:d,seller,developer,priorExpiry,validAfter,validUntil,
   get saleId(){return Uint8Array.from(saleId);}});
 });
}

export interface RealmSaleRawAccount {readonly address:PublicKey;readonly owner:PublicKey;readonly executable:boolean;readonly data:Uint8Array}
interface AccountBase {readonly address:string;readonly version:number;readonly bump:number;readonly finalityVerified:false;readonly paymentAuthorized:false}
export interface RealmSaleConfigAccount extends AccountBase {readonly authority:string;readonly developer:string;readonly priceLamports:bigint;
 readonly durationSec:bigint;readonly sellerBps:number;readonly developerBps:number;readonly quotaMax:number;readonly daySec:bigint;readonly quoteTtlSec:bigint}
export interface RealmAccessAccount extends AccountBase {readonly config:string;readonly wallet:string;readonly realm:number;readonly expiresAt:bigint}
export interface SpotSalesQuotaAccount extends AccountBase {readonly spot:number;readonly day:bigint;readonly sales:number}
export interface RealmSaleReceiptAccount extends AccountBase {readonly config:string;readonly saleId:string;readonly buyer:string;readonly seller:string;readonly developer:string;
 readonly term:string;readonly spot:number;readonly realm:number;readonly day:bigint;readonly round:bigint;readonly registryVersion:number;readonly registryHash:string;
 readonly priceLamports:bigint;readonly sellerLamports:bigint;readonly developerLamports:bigint;readonly priorExpiry:bigint;readonly coverageStart:bigint;readonly expiresAt:bigint;readonly acceptedAt:bigint}
const accountNames=['RealmSaleConfig','RealmAccess','SpotSalesQuota','RealmSaleReceipt'] as const;
type AccountName=typeof accountNames[number];
export const REALM_SALE_ACCOUNT_BYTES:Readonly<Record<AccountName,number>>=Object.freeze(Object.fromEntries(accountNames.map(n=>[n,coder.accounts.size(n)])) as Record<AccountName,number>);
function decode<T extends AccountBase>(raw:RealmSaleRawAccount,name:AccountName,p:PublicKey,expected:readonly[PublicKey,number]):Readonly<T> {
 exact(raw,'address owner executable data'); const address=key(raw.address),owner=key(raw.owner),data=raw.data;
 need(owner.equals(p) && address.equals(expected[0]) && raw.executable===false,'IDENTITY');
 need(data instanceof Uint8Array && data.length===REALM_SALE_ACCOUNT_BYTES[name],'ACCOUNT');
 const bytes=Buffer.from(data),decoded=coder.accounts.decode(name,bytes) as Record<string,unknown>;
 need(coder.types.encode(name,decoded).equals(bytes.subarray(8)),'ACCOUNT');
 const out:Record<string,unknown>={address:address.toBase58(),finalityVerified:false,paymentAuthorized:false};
 for(const [field,value] of Object.entries(decoded))out[field.replace(/_([a-z])/g,(_,c:string)=>c.toUpperCase())]=isAnchorBN(value)?BigInt(value.toString())
  :value instanceof PublicKey?key(value).toBase58():Array.isArray(value)?Buffer.from(value).toString('hex'):value;
 need(out.version===S.version && out.bump===expected[1],'ACCOUNT');return Object.freeze(out) as unknown as Readonly<T>;
}
export function decodeRealmSaleConfig(raw:RealmSaleRawAccount,expected:{readonly programId:PublicKey;readonly developer:PublicKey}):Readonly<RealmSaleConfigAccount> {
 return checked(()=>{
  exact(expected,'programId developer');const p=program(expected.programId),c=decode<RealmSaleConfigAccount>(raw,'RealmSaleConfig',p,pda(p,'realm_sale_config'));
  need(c.authority===seekerAuthorityPda(p).toBase58() && c.developer===key(expected.developer).toBase58(),'IDENTITY');
  need(c.priceLamports===BigInt(P.permitPriceLamports) && c.durationSec===BigInt(P.permitDurationSec) && c.sellerBps===P.contractSellerBps
   && c.developerBps===P.contractDevBps && c.quotaMax===P.paidContractsPerSpotDayMax && c.daySec===DAY && c.quoteTtlSec===BigInt(S.quoteTtlSec),'POLICY');return c;
 });
}
export function decodeRealmAccess(raw:RealmSaleRawAccount,expected:{readonly programId:PublicKey;readonly wallet:PublicKey;readonly realm:number}):Readonly<RealmAccessAccount> {
 return checked(()=>{
  exact(expected,'programId wallet realm');const p=program(expected.programId),wallet=key(expected.wallet),realm=small(expected.realm,P.realmCount-1);
  const a=decode<RealmAccessAccount>(raw,'RealmAccess',p,pda(p,'realm_access',wallet.toBuffer(),Buffer.of(realm)));
  need(a.config===realmSaleConfigPda(p).toBase58() && a.wallet===wallet.toBase58() && a.realm===realm,'IDENTITY');integer(a.expiresAt,true);return a;
 });
}
export function decodeSpotSalesQuota(raw:RealmSaleRawAccount,expected:{readonly programId:PublicKey;readonly spot:number;readonly day:bigint}):Readonly<SpotSalesQuotaAccount> {
 return checked(()=>{
  exact(expected,'programId spot day');const p=program(expected.programId),spot=small(expected.spot,P.totalSpots-1),d=day(expected.day);
  const q=decode<SpotSalesQuotaAccount>(raw,'SpotSalesQuota',p,pda(p,'spot_sales',Buffer.of(spot),le(d)));
  need(q.spot===spot && q.day===d,'IDENTITY');need(q.sales<=P.paidContractsPerSpotDayMax,'COUNTER');return q;
 });
}
export function decodeRealmSaleReceipt(raw:RealmSaleRawAccount,expected:{readonly programId:PublicKey;readonly buyer:PublicKey;readonly saleId:Uint8Array}):Readonly<RealmSaleReceiptAccount> {
 return checked(()=>{
  exact(expected,'programId buyer saleId');const p=program(expected.programId),buyer=key(expected.buyer),saleId=id(expected.saleId);
  const r=decode<RealmSaleReceiptAccount>(raw,'RealmSaleReceipt',p,pda(p,'realm_sale',buyer.toBuffer(),saleId));
  small(r.spot,P.totalSpots-1);small(r.realm,P.realmCount-1);day(r.day);integer(r.round);integer(r.acceptedAt,true);integer(r.priorExpiry,true);integer(r.coverageStart,true);integer(r.expiresAt,true);
  need(r.config===realmSaleConfigPda(p).toBase58() && r.buyer===buyer.toBase58() && r.saleId===saleId.toString('hex')
   && r.term===seekerTermPda(p,seekerAuctionConfigPda(p),r.round).toBase58(),'IDENTITY');
  need(r.registryVersion===REGISTRY_VERSION && r.registryHash===hashSeekerRegistry(canonicalSeekerRegistry()).toString('hex')
   && (canonicalSeekerRegistry()[r.spot]!.realmMask & (1<<r.realm))!==0,'IDENTITY');
  const price=BigInt(P.permitPriceLamports),bps=BigInt(PHASE_E_POLICY.basisPoints);
  need(r.priceLamports===price && r.sellerLamports===price*BigInt(P.contractSellerBps)/bps && r.developerLamports===price*BigInt(P.contractDevBps)/bps
   && r.sellerLamports+r.developerLamports===price,'COUNTER');
  need(r.acceptedAt/DAY===r.day && r.coverageStart===(r.acceptedAt>r.priorExpiry?r.acceptedAt:r.priorExpiry)
   && r.expiresAt-r.coverageStart===BigInt(P.permitDurationSec),'COUNTER');return r;
 });
}
/** Binds one stored receipt to one exact prepared intent. Still no RPC finality,
 * ProgramData identity, successful transaction or payment authorization proof. */
export function matchRealmSaleReceipt(raw:RealmSaleRawAccount,expected:{readonly programId:PublicKey;readonly buyer:PublicKey;readonly args:RealmSalePurchaseArgs}):Readonly<RealmSaleReceiptAccount> {
 return checked(()=>{
  exact(expected,'programId buyer args');const a=validateRealmSalePurchaseArgs(expected.args);
  const r=decodeRealmSaleReceipt(raw,{programId:expected.programId,buyer:expected.buyer,saleId:a.saleId});
  need(r.version===a.version && r.spot===a.spot && r.realm===a.realm && r.round===a.round && r.day===a.day
   && r.seller===a.seller.toBase58() && r.developer===a.developer.toBase58() && r.registryVersion===a.registryVersion
   && r.priceLamports===a.priceLamports && r.expiresAt-r.coverageStart===a.durationSec && r.priorExpiry===a.priorExpiry
   && r.acceptedAt>=a.validAfter && r.acceptedAt<=a.validUntil,'RECEIPT');return r;
 });
}
function instruction(p:PublicKey,name:string,accounts:Record<string,PublicKey>,args:Record<string,unknown>):TransactionInstruction {
 const def=idl.instructions.find(i=>i.name===name);need(def,'INPUT');
 exact(accounts,def.accounts.map(a=>a.name).join(' '));
 const metas=def.accounts.map(a=>{
  const pubkey=a.name==='system_program'?SystemProgram.programId:key(accounts[a.name]!);
  if('address'in a)need(pubkey.toBase58()===a.address,'IDENTITY');
  return {pubkey,isSigner:'signer'in a&&a.signer===true,isWritable:'writable'in a&&a.writable===true};
 });
 return new TransactionInstruction({programId:p,keys:metas,data:coder.instruction.encode(name,args)});
}
export function buildInitializeRealmSaleConfigInstruction(programId:PublicKey,input:{readonly admin:PublicKey;readonly upgradeAuthority:PublicKey;readonly developer:PublicKey}):TransactionInstruction {
 return checked(()=>{
  exact(input,'admin upgradeAuthority developer');const p=program(programId);
  return instruction(p,'initialize_realm_sale_config',{admin:input.admin,upgrade_authority:input.upgradeAuthority,program:p,
   program_data:PublicKey.findProgramAddressSync([p.toBuffer()],LOADER)[0],authority:seekerAuthorityPda(p),config:realmSaleConfigPda(p),
   developer:input.developer,system_program:SystemProgram.programId},{});
 });
}
export function buildOpenRealmAccessInstruction(programId:PublicKey,input:{readonly payer:PublicKey;readonly wallet:PublicKey;readonly realm:number}):TransactionInstruction {
 return checked(()=>{
  exact(input,'payer wallet realm');const p=program(programId),wallet=key(input.wallet),realm=small(input.realm,P.realmCount-1);
  return instruction(p,'open_realm_access',{payer:input.payer,config:realmSaleConfigPda(p),access:realmAccessPda(p,wallet,realm),system_program:SystemProgram.programId},{wallet,realm});
 });
}
export function buildOpenSpotSalesQuotaInstruction(programId:PublicKey,input:{readonly payer:PublicKey;readonly spot:number;readonly day:bigint}):TransactionInstruction {
 return checked(()=>{
  exact(input,'payer spot day');const p=program(programId),spot=small(input.spot,P.totalSpots-1),d=day(input.day);
  return instruction(p,'open_spot_sales_quota',{payer:input.payer,config:realmSaleConfigPda(p),quota:spotSalesQuotaPda(p,spot,d),system_program:SystemProgram.programId},{spot,day:new BN(d.toString())});
 });
}
export function buildBuyRealmAccessInstruction(programId:PublicKey,input:{readonly buyer:PublicKey;readonly args:RealmSalePurchaseArgs}):TransactionInstruction {
 return checked(()=>{
  exact(input,'buyer args');const p=program(programId),buyer=key(input.buyer),a=validateRealmSalePurchaseArgs(input.args),auctionConfig=seekerAuctionConfigPda(p);
  const wire=Object.fromEntries(Object.entries(a).map(([name,value])=>[name.replace(/[A-Z]/g,c=>'_'+c.toLowerCase()),typeof value==='bigint'?new BN(value.toString()):value instanceof Uint8Array?[...value]:value]));
  return instruction(p,'buy_realm_access',{buyer,authority:seekerAuthorityPda(p),config:realmSaleConfigPda(p),auction_config:auctionConfig,registry:seekerRegistryPda(p),
   term:seekerTermPda(p,auctionConfig,a.round),auction:seekerAuctionPda(p,auctionConfig,a.spot,a.round),quota:spotSalesQuotaPda(p,a.spot,a.day),
   access:realmAccessPda(p,buyer,a.realm),receipt:realmSaleReceiptPda(p,buyer,a.saleId),seller:a.seller,developer:a.developer,system_program:SystemProgram.programId},{args:wire});
 });
}
