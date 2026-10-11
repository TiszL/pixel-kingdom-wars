/** Actual funded admission plus synthetic finalized RPC and an ephemeral typed
 * issuer. API/DB owns entitlement; this issuer checks chain policy ONLY. */
import { AddressLookupTableProgram, Keypair } from '@solana/web3.js';
import { PHASE_E_CHARTER_ADMISSION, PHASE_E_SEEKER_AUCTION } from '@shardkeep/shared';
import { createCharterAdmissionReader } from '@shardkeep/chain/charter-admission';
import { decodeCharterRegistrationPermit, encodeCharterRegistrationPermit } from '@shardkeep/chain/charter-protocol';
import type { CharterCreationQuoteRpc } from '@shardkeep/chain/charter-creation-preparation';
import { vi } from 'vitest';
import { lookupFixture, sign } from '../../../../packages/chain/src/testFixtures/charterPreparation';
import { createCharterCreationPreparation, type CharterCreationPreparationOptions, type CharterIssueReceipt, type TypedCharterIssuer } from '../../src/game/clanCharterCreationPreparation';
import { charterCreationPolicyFixture, type PolicyFixture } from './charterCreationPolicyAdmission';
export { postgresLeaf, outcome } from './charterCreationPolicyAdmission';
export const preparationRefusal = (suffix: string) => ({ code: 'CLAN_CHARTER_PREPARATION_' + suffix });
export const noPreparationAuthority = { signingAuthorized:false,relayAuthorized:false,mintAuthorized:false,
 paymentAuthorized:false,activationAuthorized:false,refundAuthorized:false };
export function gate() {
 let entered!:()=>void, release!:()=>void;
 const arrived=new Promise<void>(resolve=>entered=resolve),wait=new Promise<void>(resolve=>release=resolve);
 return {arrived,release,enter:async()=>{entered();await wait;}};
}
const copyReceipt=(v:CharterIssueReceipt):CharterIssueReceipt=>({...v,message:Buffer.from(v.message),signature:Buffer.from(v.signature)});
export async function charterCreationPreparationFixture() {
 const f=await charterCreationPolicyFixture();
 async function admitted(actor:PolicyFixture['source']=f.source) {
  const p=await f.policyPrepared(actor),key=Keypair.generate();
  key.publicKey.toBuffer().copy(p.bank.row.data,p.bank.offsets['current']!);
  p.bank.chain.expectedCurrentSigner=key.publicKey.toBase58();
  const admission=await p.service().admit(actor.wallet,p.consent.creationIntentId);
  const loaded=await f.inventory().loadForCancellation(p.consent.creationIntentId),candidate=Buffer.from(admission.candidate.messageHex,'hex');
  const original=loaded.original,lookup=lookupFixture(original,candidate),blockhash=Keypair.generate().publicKey.toBase58();
  const rpc:CharterCreationQuoteRpc={...p.bank.rpc,
   getAccountInfoAndContext:vi.fn(async()=>({context:{slot:150},value:{owner:AddressLookupTableProgram.programId,executable:false,data:lookup.data}})),
   getLatestBlockhashAndContext:vi.fn(async()=>({context:{slot:150},value:{blockhash,lastValidBlockHeight:300}})),
   getFeeForMessage:vi.fn(async()=>({context:{slot:150},value:10000})),
   getMinimumBalanceForRentExemption:vi.fn(async n=>1000+n*5),getBlockHeight:vi.fn(async()=>200)};
  let tick=0,issuerTick=0;
  const monotonicNow=vi.fn(()=>tick),issuerNow=vi.fn(()=>issuerTick);
  const connect=vi.fn((_signal:AbortSignal)=>rpc);
  const chain={connect,trust:p.bank.trust,expectedCurrentSigner:key.publicKey.toBase58(),lookupTable:lookup.pin,
   coreCostProfile:{version:1 as const,profile:'mpl-core-0.15.2-charter-pfd-seq-none' as const,reviewedProgramDataSha256:p.bank.trust.core.reviewedProgramDataSha256},
   costLimits:{maxNetworkFeeLamports:100000n,maxRentLamports:100000n,maxTotalLamports:2000000n}};
  const receipts=new Map<string,CharterIssueReceipt>();
  const hooks={beforePolicy:async()=>{},afterSign:async()=>{},reply:(v:CharterIssueReceipt)=>v};
  let actualSignatures=0;
  const issuer:TypedCharterIssuer={issueOnce:vi.fn(async(request,signal)=>{
   const bytes=Buffer.from(request.message),started=issuerNow();
   if(Object.keys(request).sort().join(',')!=='kind,message,requestId'||request.kind!=='charter-registration-v1')throw Error('ISSUER_KIND');
   const saved=receipts.get(request.requestId);
   if(saved){if(!Buffer.from(saved.message).equals(bytes))throw Error('ISSUER_CONFLICT');return copyReceipt(saved);}
   const decoded=decodeCharterRegistrationPermit(bytes);
   if(!encodeCharterRegistrationPermit(decoded).equals(bytes)||decoded.kind!==5||!decoded.programId.equals(keyFor('economyProgram'))
    ||!decoded.genesisHash.equals(keyFor('genesisHash')))throw Error('ISSUER_DOMAIN');
   // All awaits precede the final full-precision, expiry and abort check. This
   // independent current-policy read is not an API-supplied verified flag.
   await hooks.beforePolicy();
   const current=await createCharterAdmissionReader(p.bank.connect,p.bank.trust,key.publicKey.toBase58())();
   const finished=issuerNow(),age=finished-started;
   if(signal.aborted||!Number.isFinite(started)||started<0||!Number.isFinite(finished)||finished<started
    ||age>PHASE_E_CHARTER_ADMISSION.v1.observationMaxAgeMs||decoded.expiry<=current.unixTimestamp
    ||decoded.expiry-current.unixTimestamp>BigInt(PHASE_E_SEEKER_AUCTION.maxPolicyPermitTtlSec))throw Error('ISSUER_STALE');
   const receipt:CharterIssueReceipt={requestId:request.requestId,publicKey:key.publicKey.toBase58(),message:bytes,signature:sign(key,bytes)};
   actualSignatures++;receipts.set(request.requestId,copyReceipt(receipt));
   await hooks.afterSign();return hooks.reply(copyReceipt(receipt));
  }),lookup:vi.fn(async(id,_signal)=>{const saved=receipts.get(id);return saved?copyReceipt(saved):null;})};
  function keyFor(field:'genesisHash'|'economyProgram'){return decodeCharterRegistrationPermit(candidate)[field==='economyProgram'?'programId':'genesisHash'];}
  const service=(overrides:Partial<CharterCreationPreparationOptions>={})=>createCharterCreationPreparation(f.db,{chain,issuer,monotonicNow,...overrides});
  return {...p,admission,original,candidate,key,lookup,blockhash,rpc,chain,connect,issuer,receipts,hooks,monotonicNow,issuerNow,
   setTick:(value:number)=>{tick=value;},setIssuerTick:(value:number)=>{issuerTick=value;},signatures:()=>actualSignatures,service};
 }
 const attempts=()=>f.sql`select * from charter_creation_issuance_attempts order by reservation_id`;
 const preparations=()=>f.sql`select * from charter_creation_preparations order by attempt_id`;
 return {...f,admitted,attempts,preparations};
}
export type PreparationFixture=Awaited<ReturnType<typeof charterCreationPreparationFixture>>;
export type AdmittedPreparation=Awaited<ReturnType<PreparationFixture['admitted']>>;
