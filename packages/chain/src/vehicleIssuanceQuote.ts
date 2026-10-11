/** Private complete request quote. Retained validation is internal binding only,
 * never current source truth or permission to sign, send, replace or release. */
import {Message,PublicKey,SystemProgram,SYSVAR_CLOCK_PUBKEY,SYSVAR_RENT_PUBKEY} from '@solana/web3.js';
import {PHASE_E_SEEKER_AUCTION} from '@shardkeep/shared';
import {createVehicleIssuanceAdmissionReader,type VehicleIssuanceAdmissionEvidence} from './vehicleIssuanceAdmission';
import {fields,safe,copyTrust,normalizeVehicleIssuanceOriginal,LOADER,type VehicleIssuanceTrust,type VehicleIssuanceRawAccount} from './vehicleIssuanceAccounts';
import {vehicleRequestInstructions,vehicleRequestLegacyMessage} from './vehicleIssuanceRequest';
import {vehicleAddress,vehicleHex,vehiclePda,vehicleFees,vehicleSha256,vehicleTermsHash,vehicleDiscriminator,VEHICLE_CRAFT_PROGRAM,VEHICLE_CORE_PROGRAM,VEHICLE_VRF_PROGRAM,VEHICLE_VRF_QUEUE,type VehicleIssuanceOriginal} from './vehicleIssuanceProtocol';
export interface VehicleIssuanceQuoteInput {original:VehicleIssuanceOriginal;policyAuthority:string;policySignature:Uint8Array}
export interface VehicleIssuanceQuoteLimits {maxNetworkFeeLamports:string;maxInitializationRentLamports:string;maxRequiredLamports:string}
export interface VehicleIssuanceQuoteRpc {
 getGenesisHash():Promise<string>;getSlot(commitment:'finalized'):Promise<number>;
 getMultipleAccountsInfoAndContext(addresses:PublicKey[],options:{commitment:'finalized';minContextSlot:number}):Promise<{context:{slot:number};value:(VehicleIssuanceRawAccount&{lamports:number}|null)[]}>;
 getLatestBlockhashAndContext(options:{commitment:'finalized';minContextSlot:number}):Promise<{context:{slot:number};value:{blockhash:string;lastValidBlockHeight:number}}>;
 getFeeForMessage(message:Message,commitment:'finalized'):Promise<{context:{slot:number};value:number|null}>;
 getBlockHeight(options:{commitment:'finalized';minContextSlot:number}):Promise<number>;
}
export interface QuoteBank {
 admission:VehicleIssuanceAdmissionEvidence;controlHex:string;rentHex:string;clockHex:string;
 balances:readonly {address:string;lamports:string}[];
 payer:{address:string;owner:string;executable:false;dataSha256:string};bankSha256:string;
}
export interface QuoteCosts {
 allocations:readonly {kind:'root'|'attempt'|'permit';address:string;bytes:number;minimumBalanceLamports:string;existingLamports:string;topUpLamports:string}[];
 networkFeeLamports:string;initializationRentLamports:string;applicationFeeLamports:string;oracleBudgetLamports:string;
 escrowRentReserveLamports:string;applicationFundingLamports:string;oracleFundingLamports:string;requiredLamports:string;
}
export interface VehicleIssuanceQuote {
 version:1;original:VehicleIssuanceOriginal;originalHash:string;policyAuthority:string;policySignatureHex:string;termsHash:string;permitExpiry:string;
 blockhash:string;blockhashSlot:number;lastValidBlockHeight:number;currentBlockHeight:number;messageHex:string;messageSha256:string;packetBytes:number;
 costLimits:VehicleIssuanceQuoteLimits;costs:QuoteCosts;payer:{balanceLamports:string;remainingLamports:string;emptyAccountRentLamports:string};
 source:{initial:QuoteBank;final:QuoteBank;feeSlot:number;closingSlot:number;closingGenesisHash:string};
 signingAuthorized:false;broadcastAuthorized:false;paymentAuthorized:false;activationAuthorized:false;reservationReleaseAuthorized:false;
}
export class VehicleIssuanceQuoteError extends Error {
 readonly reservationReleaseAuthorized=false;
 constructor(readonly code:'INPUT'|'SOURCE'|'COST'|'INSUFFICIENT_SOL'|'DUST'|'BLOCKHASH'|'DEADLINE'|'BUSY'|'UNAVAILABLE'){super(`Vehicle request quote held: ${code}`);this.name='VehicleIssuanceQuoteError';}
}
function need(v:unknown,code:VehicleIssuanceQuoteError['code']='INPUT'):asserts v {if(!v)throw new VehicleIssuanceQuoteError(code);}
const U64=0xffffffffffffffffn,MAX_MS=60_000,MAX_PENDING=8,SYSVAR='Sysvar1111111111111111111111111111111111111',EMPTY_HASH=vehicleSha256(Buffer.alloc(0));
const num=(v:unknown)=>{need(safe(v));return v;};
const nat=(v:unknown)=>{need(typeof v==='string'&&/^(0|[1-9][0-9]*)$/.test(v)&&v.length<=20&&BigInt(v)<=U64);return v;};
const hash=(v:unknown)=>vehicleHex(v,32);
const equal=(a:unknown,b:unknown)=>need(JSON.stringify(a)===JSON.stringify(b));
const address=(v:unknown)=>{need(typeof v==='string');const p=new PublicKey(v);need(p.toBase58()===v);return v;};
function array(value:unknown,length:number):unknown[]{
 need(Array.isArray(value)&&Object.getPrototypeOf(value)===Array.prototype&&value.length===length&&Reflect.ownKeys(value).length===length+1);
 return Array.from({length},(_,i)=>{const d=Object.getOwnPropertyDescriptor(value,String(i));need(d&&d.enumerable&&'value'in d);return d.value;});
}
function limits(value:unknown):VehicleIssuanceQuoteLimits {const l=fields(value,'maxNetworkFeeLamports maxInitializationRentLamports maxRequiredLamports');return Object.freeze({maxNetworkFeeLamports:nat(l.maxNetworkFeeLamports),maxInitializationRentLamports:nat(l.maxInitializationRentLamports),maxRequiredLamports:nat(l.maxRequiredLamports)});}
function input(value:unknown):VehicleIssuanceQuoteInput {
 const i=fields(value,'original policyAuthority policySignature'),original=normalizeVehicleIssuanceOriginal(i.original),policyAuthority=vehicleAddress(i.policyAuthority);
 need(i.policySignature instanceof Uint8Array&&i.policySignature.length===64);const policySignature=Buffer.from(i.policySignature);
 const instructions=vehicleRequestInstructions(original,policyAuthority,policySignature),internals=[...instructions[1]!.keys.slice(1).map(k=>k.pubkey.toBase58()),VEHICLE_CRAFT_PROGRAM,VEHICLE_CORE_PROGRAM,original.identity.collection,vehiclePda('vehicle_authority')[0].toBase58()];
 need([original.buyer,original.terms.site,original.terms.operator,original.terms.project].every(k=>!internals.includes(k)));
 need(original.terms.recipeVersion>0&&[original.terms.recipeHash,original.terms.materialHash,original.terms.metadataHash].every(h=>!/^0+$/.test(h))&&BigInt(original.terms.oracleBudget)>0n);
 return {original,policyAuthority,policySignature};
}
function accountAddresses(o:VehicleIssuanceOriginal,trust:VehicleIssuanceTrust):string[]{return [trust.craft,trust.provider,trust.core].flatMap(p=>{const id=new PublicKey(p.programId);return [id.toBase58(),PublicKey.findProgramAddressSync([id.toBuffer()],LOADER)[0].toBase58()];}).concat([
 vehiclePda('vehicle_control')[0].toBase58(),VEHICLE_VRF_QUEUE,SYSVAR_CLOCK_PUBKEY.toBase58(),SYSVAR_RENT_PUBKEY.toBase58(),vehiclePda('identity')[0].toBase58(),
 vehiclePda('vehicle_root',o.rootId)[0].toBase58(),vehiclePda('vehicle_attempt',o.attemptId)[0].toBase58(),vehiclePda('vehicle_permit',o.permitId)[0].toBase58(),
 vehiclePda('vehicle_app',o.rootId)[0].toBase58(),vehiclePda('vehicle_oracle',o.rootId)[0].toBase58(),o.identity.assetId,o.buyer]);}
/** Pinned solana-rent2.2.1 bincode/f64 semantics; protocol overhead, not game policy. */
function rent(bytes:Buffer,length:number):bigint {
 need(bytes.length===17,'SOURCE');const annual=(128n+BigInt(length))*bytes.readBigUInt64LE(),threshold=bytes.readDoubleLE(8);
 need(annual<=BigInt(Number.MAX_SAFE_INTEGER)&&Number.isFinite(threshold)&&threshold>=0&&bytes[16]!<=100,'SOURCE');
 const value=Number(annual)*threshold;need(Number.isFinite(value)&&value>=0&&value<=Number.MAX_SAFE_INTEGER,'SOURCE');return BigInt(Math.floor(value));
}
function copyBank(value:unknown,i:VehicleIssuanceQuoteInput):QuoteBank {
 const b=fields(value,'admission controlHex rentHex clockHex balances payer bankSha256'),a=fields(b.admission,'version originalHash rootId attemptId permitId buyer termsHash policyAuthority genesisHash unixTimestamp openingSlot slot closingSlot emptyAccountRentLamports source transactionProofVerified paymentAuthorized activationAuthorized reservationReleaseAuthorized');
 const o=i.original;need(a.version===1&&a.originalHash===o.originalHash&&a.rootId===o.rootId&&a.attemptId===o.attemptId&&a.permitId===o.permitId&&a.buyer===o.buyer&&a.termsHash===vehicleTermsHash(o)&&a.policyAuthority===i.policyAuthority&&a.genesisHash===o.genesisHash);
 need([a.transactionProofVerified,a.paymentAuthorized,a.activationAuthorized,a.reservationReleaseAuthorized].every(v=>v===false));
 const openingSlot=num(a.openingSlot),slot=num(a.slot),closingSlot=num(a.closingSlot),unixTimestamp=nat(a.unixTimestamp),emptyAccountRentLamports=nat(a.emptyAccountRentLamports);
 need(openingSlot<=slot&&slot<=closingSlot&&BigInt(unixTimestamp)>0n&&BigInt(o.permitExpiry)>BigInt(unixTimestamp)&&BigInt(o.permitExpiry)-BigInt(unixTimestamp)<=BigInt(PHASE_E_SEEKER_AUCTION.maxPolicyPermitTtlSec));
 const s=fields(a.source,'profile trust stateProvenance genesisHash programs accounts');need(s.profile==='pre-request-17-v1'&&s.trust==='trusted-finalized-rpc-reviewed-program'&&s.stateProvenance==='fresh-reviewed-deployment'&&s.genesisHash===o.genesisHash);
 const ps=array(s.programs,3),trust=copyTrust({expectedGenesisHash:o.genesisHash,craft:ps[0],provider:ps[1],core:ps[2],stateProvenance:s.stateProvenance} as VehicleIssuanceTrust),programs=[trust.craft,trust.provider,trust.core];
 need(openingSlot>=Math.max(...programs.map(p=>p.reviewedDeploymentSlot)));
 const addresses=accountAddresses(o,trust),accounts=array(s.accounts,17).map((v,j)=>{
  const row=fields(v,'address absent','owner executable dataSha256');need(row.address===addresses[j]&&typeof row.absent==='boolean');
  if(row.absent){need(j>=10&&Object.keys(row).length===2);return Object.freeze({address:addresses[j]!,absent:true as const});}
  need(typeof row.executable==='boolean');const owner=address(row.owner),dataSha256=hash(row.dataSha256);
  if(j<6){need(owner===LOADER.toBase58()&&row.executable===(j%2===0));if(j%2)need(dataSha256===programs[(j-1)/2]!.reviewedProgramDataSha256);else{const data=Buffer.alloc(36);data.writeUInt32LE(2);new PublicKey(addresses[j+1]!).toBuffer().copy(data,4);need(dataSha256===vehicleSha256(data));}}
  if(j===6)need(owner===VEHICLE_CRAFT_PROGRAM&&!row.executable);
  if(j===7)need(owner===VEHICLE_VRF_PROGRAM&&!row.executable);
  if(j===8||j===9)need(owner===SYSVAR&&!row.executable);
  if(j>=10)need(owner===SystemProgram.programId.toBase58()&&!row.executable&&dataSha256===EMPTY_HASH);
  return Object.freeze({address:addresses[j]!,absent:false as const,owner,executable:row.executable,dataSha256});
 });
 const controlHex=vehicleHex(b.controlHex,189),rentHex=vehicleHex(b.rentHex,17),clockHex=vehicleHex(b.clockHex,40),c=Buffer.from(controlHex,'hex'),clock=Buffer.from(clockHex,'hex'),r=Buffer.from(rentHex,'hex');
 for(const [index,raw] of [[6,c],[8,clock],[9,r]] as const){const row=accounts[index]!;need(!row.absent&&row.dataSha256===vehicleSha256(raw));}
 need(c.subarray(0,8).equals(vehicleDiscriminator('account','VehicleControl'))&&c[8]===1&&c.subarray(9,41).equals(new PublicKey(o.genesisHash).toBuffer())&&c.subarray(41,73).equals(new PublicKey(i.policyAuthority).toBuffer()));
 const prior=new PublicKey(c.subarray(73,105)),priorUntil=c.readBigInt64LE(105);need(priorUntil>=0n&&(!prior.equals(PublicKey.default)||priorUntil===0n));
 need(c.subarray(113,145).equals(new PublicKey(o.identity.collection).toBuffer())&&c.subarray(145,177).equals(vehiclePda('vehicle_authority')[0].toBuffer())&&c[177]===0&&c.readBigUInt64LE(178)===BigInt(o.escrowRentReserve)&&c[186]===vehiclePda('vehicle_control')[1]&&c[187]===vehiclePda('vehicle_collection')[1]&&c[188]===vehiclePda('vehicle_authority')[1]);
 need(clock.readBigUInt64LE()===BigInt(slot)&&clock.readBigInt64LE(32)===BigInt(unixTimestamp)&&rent(r,0)===BigInt(emptyAccountRentLamports)&&BigInt(o.escrowRentReserve)>=rent(r,0));
 const balances=Object.freeze(array(b.balances,18).map((v,j)=>{const row=fields(v,'address lamports');need(row.address===addresses[j]);const lamports=nat(row.lamports);need(BigInt(lamports)<=BigInt(Number.MAX_SAFE_INTEGER));if(j<17&&accounts[j]!.absent)need(lamports==='0');return Object.freeze({address:addresses[j]!,lamports});}));
 const payerRaw=fields(b.payer,'address owner executable dataSha256');need(payerRaw.address===o.buyer&&payerRaw.owner===SystemProgram.programId.toBase58()&&payerRaw.executable===false&&payerRaw.dataSha256===EMPTY_HASH);
 const payer=Object.freeze({address:o.buyer,owner:SystemProgram.programId.toBase58(),executable:false as const,dataSha256:EMPTY_HASH});
 const admission:VehicleIssuanceAdmissionEvidence=Object.freeze({version:1,originalHash:o.originalHash,rootId:o.rootId,attemptId:o.attemptId,permitId:o.permitId,buyer:o.buyer,termsHash:vehicleTermsHash(o),policyAuthority:i.policyAuthority,genesisHash:o.genesisHash,unixTimestamp,openingSlot,slot,closingSlot,emptyAccountRentLamports,
  source:Object.freeze({profile:'pre-request-17-v1',trust:'trusted-finalized-rpc-reviewed-program',stateProvenance:'fresh-reviewed-deployment',genesisHash:o.genesisHash,programs:Object.freeze(programs),accounts:Object.freeze(accounts)}),transactionProofVerified:false,paymentAuthorized:false,activationAuthorized:false,reservationReleaseAuthorized:false});
 const body={admission,controlHex,rentHex,clockHex,balances,payer},bankSha256=vehicleSha256(Buffer.from(JSON.stringify(body)));need(hash(b.bankSha256)===bankSha256);return Object.freeze({...body,bankSha256});
}
export function calculateVehicleIssuanceQuoteCosts(o:VehicleIssuanceOriginal,bank:QuoteBank,networkFeeLamports:string,ceiling:VehicleIssuanceQuoteLimits){
 const r=Buffer.from(bank.rentHex,'hex'),balance=(index:number)=>BigInt(bank.balances[index]!.lamports);
 const allocations=Object.freeze(([['root',11,170],['attempt',12,557],['permit',13,170]] as const).map(([kind,index,bytes])=>{
  const minimum=rent(r,bytes),existing=balance(index),required=existing===0n?minimum:(minimum>0n?minimum:1n),topUp=required>existing?required-existing:0n;
  return Object.freeze({kind,address:bank.balances[index]!.address,bytes,minimumBalanceLamports:minimum.toString(),existingLamports:existing.toString(),topUpLamports:topUp.toString()});
 }));
 const initializationRent=allocations.reduce((n,a)=>n+BigInt(a.topUpLamports),0n),application=vehicleFees().application,oracle=BigInt(o.terms.oracleBudget),reserve=BigInt(o.escrowRentReserve),appFunding=application+reserve,oracleFunding=oracle+reserve,required=BigInt(networkFeeLamports)+initializationRent+appFunding+oracleFunding;
 need([appFunding,oracleFunding,required,balance(14)+appFunding,balance(15)+oracleFunding].every(n=>n<=U64),'COST');
 need(BigInt(networkFeeLamports)<=BigInt(ceiling.maxNetworkFeeLamports)&&initializationRent<=BigInt(ceiling.maxInitializationRentLamports)&&required<=BigInt(ceiling.maxRequiredLamports),'COST');
 const payerBalance=balance(17);need(payerBalance>=required,'INSUFFICIENT_SOL');const remaining=payerBalance-required,empty=rent(r,0);need(remaining===0n||remaining>=empty,'DUST');
 return {costs:Object.freeze({allocations,networkFeeLamports,initializationRentLamports:initializationRent.toString(),applicationFeeLamports:application.toString(),oracleBudgetLamports:oracle.toString(),escrowRentReserveLamports:reserve.toString(),applicationFundingLamports:appFunding.toString(),oracleFundingLamports:oracleFunding.toString(),requiredLamports:required.toString()}),
 payer:Object.freeze({balanceLamports:payerBalance.toString(),remainingLamports:remaining.toString(),emptyAccountRentLamports:empty.toString()})};
}
/** Verify a retained quote's strict shape/arithmetic and immutable message. An
 * optional expected receipt binds caller-owned identity; neither form is RPC proof. */
export function verifyVehicleIssuanceQuote(value:unknown,expected?:VehicleIssuanceQuoteInput):VehicleIssuanceQuote {
 try{
 const q=fields(value,'version original originalHash policyAuthority policySignatureHex termsHash permitExpiry blockhash blockhashSlot lastValidBlockHeight currentBlockHeight messageHex messageSha256 packetBytes costLimits costs payer source signingAuthorized broadcastAuthorized paymentAuthorized activationAuthorized reservationReleaseAuthorized');
 need(q.version===1&&[q.signingAuthorized,q.broadcastAuthorized,q.paymentAuthorized,q.activationAuthorized,q.reservationReleaseAuthorized].every(v=>v===false));
 const policySignatureHex=vehicleHex(q.policySignatureHex,64),i=input({original:q.original,policyAuthority:q.policyAuthority,policySignature:Buffer.from(policySignatureHex,'hex')}),o=i.original;
 if(expected){const e=input(expected);need(e.original.originalHash===o.originalHash&&e.policyAuthority===i.policyAuthority&&Buffer.from(e.policySignature).equals(i.policySignature));}
 need(q.originalHash===o.originalHash&&q.termsHash===vehicleTermsHash(o)&&q.permitExpiry===o.permitExpiry);
 const blockhash=vehicleAddress(q.blockhash),blockhashSlot=num(q.blockhashSlot),lastValidBlockHeight=num(q.lastValidBlockHeight),currentBlockHeight=num(q.currentBlockHeight);need(currentBlockHeight<=lastValidBlockHeight,'BLOCKHASH');
 const message=vehicleRequestLegacyMessage(o,i.policyAuthority,i.policySignature,blockhash);need(q.messageHex===message.toString('hex')&&q.messageSha256===vehicleSha256(message)&&q.packetBytes===message.length+65);
 const s=fields(q.source,'initial final feeSlot closingSlot closingGenesisHash'),initial=copyBank(s.initial,i),final=copyBank(s.final,i),feeSlot=num(s.feeSlot),closingSlot=num(s.closingSlot);
 need(blockhashSlot>=initial.admission.closingSlot&&feeSlot>=blockhashSlot&&final.admission.openingSlot>=feeSlot&&closingSlot>=final.admission.closingSlot&&s.closingGenesisHash===o.genesisHash&&BigInt(final.admission.unixTimestamp)>=BigInt(initial.admission.unixTimestamp));equal(initial.admission.source.programs,final.admission.source.programs);
 const costLimits=limits(q.costLimits),c=fields(q.costs,'allocations networkFeeLamports initializationRentLamports applicationFeeLamports oracleBudgetLamports escrowRentReserveLamports applicationFundingLamports oracleFundingLamports requiredLamports');
 const networkFeeLamports=nat(c.networkFeeLamports);need(BigInt(networkFeeLamports)<=BigInt(Number.MAX_SAFE_INTEGER));
 const result=calculateVehicleIssuanceQuoteCosts(o,final,networkFeeLamports,costLimits);
 const allocations=array(c.allocations,3).map(row=>{const a=fields(row,'kind address bytes minimumBalanceLamports existingLamports topUpLamports');return {kind:a.kind,address:address(a.address),bytes:num(a.bytes),minimumBalanceLamports:nat(a.minimumBalanceLamports),existingLamports:nat(a.existingLamports),topUpLamports:nat(a.topUpLamports)};});
 equal({...c,allocations},result.costs);const p=fields(q.payer,'balanceLamports remainingLamports emptyAccountRentLamports');equal(p,result.payer);
 return Object.freeze({version:1,original:o,originalHash:o.originalHash,policyAuthority:i.policyAuthority,policySignatureHex,termsHash:vehicleTermsHash(o),permitExpiry:o.permitExpiry,blockhash,blockhashSlot,lastValidBlockHeight,currentBlockHeight,messageHex:message.toString('hex'),messageSha256:vehicleSha256(message),packetBytes:message.length+65,costLimits,...result,
 source:Object.freeze({initial,final,feeSlot,closingSlot,closingGenesisHash:o.genesisHash}),signingAuthorized:false,broadcastAuthorized:false,paymentAuthorized:false,activationAuthorized:false,reservationReleaseAuthorized:false});
 }catch(error){if(error instanceof VehicleIssuanceQuoteError)throw error;throw new VehicleIssuanceQuoteError('INPUT');}
}

export async function readVehicleIssuanceQuoteBank(rpc:Pick<VehicleIssuanceQuoteRpc,'getGenesisHash'|'getSlot'|'getMultipleAccountsInfoAndContext'>,trust:VehicleIssuanceTrust,i:VehicleIssuanceQuoteInput,floor:number,context:{call:<T>(fn:()=>Promise<T>)=>Promise<T>;active:()=>void;signal:AbortSignal;deadline:number}):Promise<QuoteBank>{
   const {call,active,signal,deadline}=context,o=i.original,policyAuthority=i.policyAuthority;
   let captured:{slot:number;rows:(VehicleIssuanceRawAccount&{lamports:number}|null)[];addresses:PublicKey[]}|undefined;
   const read=createVehicleIssuanceAdmissionReader(()=>({getGenesisHash:()=>call(()=>rpc.getGenesisHash()),getSlot:async()=>{const slot=num(await call(()=>rpc.getSlot('finalized')));need(slot>=floor,'SOURCE');return slot;},
    getMultipleAccountsInfoAndContext:async(addresses,config)=>{
     const all=[...addresses,new PublicKey(o.buyer)],response=await call(()=>rpc.getMultipleAccountsInfoAndContext(all.map(a=>new PublicKey(a.toBytes())),{...config,minContextSlot:Math.max(config.minContextSlot,floor)}));
     need(response&&safe(response.context?.slot)&&response.context.slot>=Math.max(config.minContextSlot,floor),'SOURCE');
     const caps=[36,8*1024*1024,36,8*1024*1024,36,8*1024*1024,189,65536,40,17,0,0,0,0,0,0,0,0];
     const rows=array(response.value,18).map((v,j)=>{if(v===null)return null;const row=fields(v,'address owner executable data lamports');need(row.address instanceof PublicKey&&row.owner instanceof PublicKey&&row.data instanceof Uint8Array&&row.data.length<=caps[j]!&&typeof row.executable==='boolean'&&row.address.equals(all[j]!),'SOURCE');return {address:new PublicKey(row.address.toBytes()),owner:new PublicKey(row.owner.toBytes()),executable:row.executable,data:Buffer.from(row.data),lamports:num(row.lamports)};});
     captured={slot:response.context.slot,rows,addresses:all};return {context:{slot:response.context.slot},value:rows.slice(0,17).map(row=>row===null?null:{address:row.address,owner:row.owner,executable:row.executable,data:row.data})};
    }}),trust,policyAuthority,{deadlineMs:deadline});
   const admission=await read(o,signal);active();need(captured&&captured.slot===admission.slot,'SOURCE');
   const {rows,addresses}=captured,payerRow=rows[17];need(payerRow,'INSUFFICIENT_SOL');need(!payerRow.executable&&payerRow.owner.equals(SystemProgram.programId)&&payerRow.data.length===0,'SOURCE');
   const body={admission,controlHex:Buffer.from(rows[6]!.data).toString('hex'),rentHex:Buffer.from(rows[9]!.data).toString('hex'),clockHex:Buffer.from(rows[8]!.data).toString('hex'),balances:rows.map((row,j)=>({address:addresses[j]!.toBase58(),lamports:String(row?.lamports??0)})),payer:{address:o.buyer,owner:payerRow.owner.toBase58(),executable:false as const,dataSha256:vehicleSha256(payerRow.data)}};
   return copyBank({...body,bankSha256:vehicleSha256(Buffer.from(JSON.stringify(body)))},i);
  }

export function createVehicleIssuanceQuoteReader(connect:(signal:AbortSignal)=>VehicleIssuanceQuoteRpc,inputTrust:VehicleIssuanceTrust,expectedPolicyAuthority:string,options:{costLimits:VehicleIssuanceQuoteLimits;deadlineMs?:number}){
 need(typeof connect==='function');const trust=copyTrust(inputTrust),policyAuthority=vehicleAddress(expectedPolicyAuthority),settings=fields(options,'costLimits','deadlineMs'),costLimits=limits(settings.costLimits),deadline=num(settings.deadlineMs??MAX_MS);need(deadline>0&&deadline<=MAX_MS);let pending=0;
 return async(value:VehicleIssuanceQuoteInput,signal?:AbortSignal):Promise<VehicleIssuanceQuote>=>{
 const i=input(value),o=i.original;need(i.policyAuthority===policyAuthority&&o.genesisHash===trust.expectedGenesisHash);need(!signal?.aborted,'DEADLINE');need(pending<MAX_PENDING,'BUSY');pending++;
 const controller=new AbortController(),started=performance.now();let done=false,released=false,outstanding=0,timer:ReturnType<typeof setTimeout>|undefined;
 const active=()=>need(!controller.signal.aborted&&performance.now()-started<deadline,'DEADLINE'),release=()=>{if(done&&outstanding===0&&!released){released=true;pending--;}};
 async function call<T>(fn:()=>Promise<T>):Promise<T>{active();outstanding++;try{const result=await fn();active();return result;}finally{outstanding--;release();}}
 let cancel!:()=>void;const stopped=new Promise<never>((_,reject)=>{cancel=()=>{controller.abort();reject(new VehicleIssuanceQuoteError('DEADLINE'));};signal?.addEventListener('abort',cancel,{once:true});timer=setTimeout(cancel,deadline);});
 const work=(async()=>{
  const rpc=connect(controller.signal);active();
  const bank=(floor:number)=>readVehicleIssuanceQuoteBank(rpc,trust,i,floor,{call,active,signal:controller.signal,deadline});
  const initial=await bank(0),latest=await call(()=>rpc.getLatestBlockhashAndContext({commitment:'finalized',minContextSlot:initial.admission.closingSlot}));
  need(latest&&safe(latest.context?.slot)&&latest.context.slot>=initial.admission.closingSlot,'BLOCKHASH');const blockhashSlot=latest.context.slot,b=fields(latest.value,'blockhash lastValidBlockHeight'),blockhash=vehicleAddress(b.blockhash),lastValidBlockHeight=num(b.lastValidBlockHeight);
  const message=vehicleRequestLegacyMessage(o,policyAuthority,i.policySignature,blockhash),fee=await call(()=>rpc.getFeeForMessage(Message.from(message),'finalized'));
  need(fee&&safe(fee.context?.slot)&&fee.context.slot>=blockhashSlot&&safe(fee.value),'COST');const feeSlot=fee.context.slot,networkFeeLamports=String(fee.value),final=await bank(feeSlot),result=calculateVehicleIssuanceQuoteCosts(o,final,networkFeeLamports,costLimits);
  const currentBlockHeight=num(await call(()=>rpc.getBlockHeight({commitment:'finalized',minContextSlot:final.admission.closingSlot})));need(currentBlockHeight<=lastValidBlockHeight,'BLOCKHASH');
  const closingSlot=num(await call(()=>rpc.getSlot('finalized')));need(closingSlot>=final.admission.closingSlot,'SOURCE');const closingGenesisHash=await call(()=>rpc.getGenesisHash());need(closingGenesisHash===o.genesisHash,'SOURCE');active();
  const quote=verifyVehicleIssuanceQuote({version:1,original:o,originalHash:o.originalHash,policyAuthority,policySignatureHex:Buffer.from(i.policySignature).toString('hex'),termsHash:vehicleTermsHash(o),permitExpiry:o.permitExpiry,blockhash,blockhashSlot,lastValidBlockHeight,currentBlockHeight,messageHex:message.toString('hex'),messageSha256:vehicleSha256(message),packetBytes:message.length+65,costLimits,...result,source:{initial,final,feeSlot,closingSlot,closingGenesisHash},signingAuthorized:false,broadcastAuthorized:false,paymentAuthorized:false,activationAuthorized:false,reservationReleaseAuthorized:false},i);active();return quote;
 })();
 void work.then(()=>{done=true;release();},()=>{done=true;release();});
 try{return await Promise.race([work,stopped]);}catch(error){if(error instanceof VehicleIssuanceQuoteError)throw error;throw new VehicleIssuanceQuoteError('UNAVAILABLE');}
 finally{if(timer!==undefined)clearTimeout(timer);signal?.removeEventListener('abort',cancel);controller.abort();}
 };
}
