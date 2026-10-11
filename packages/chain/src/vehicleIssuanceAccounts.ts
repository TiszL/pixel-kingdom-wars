/** Strict immutable originals and exact craft state decoding for D153.207. */
import {PublicKey} from '@solana/web3.js';
import {PHASE_E_SEEKER_AUCTION} from '@shardkeep/shared';
import {PHASE_E_VEHICLE_FAMILY_IDS,PhaseEVehicleMintIdentitySchema} from '@shardkeep/shared/phaseEVehicles';
import {vehicleAddress,vehicleHex,vehicleId,vehicleSha256,vehicleTermsBytes,vehicleTermsHash,vehicleMetadataHash,vehiclePda,vehicleDiscriminator,vehicleFees,vehicleKeccak,vehicleVrfRequest,vehicleWins,VEHICLE_CRAFT_PROGRAM,VEHICLE_CORE_PROGRAM,VEHICLE_VRF_PROGRAM,VEHICLE_VRF_QUEUE,type VehicleIssuanceOriginal,type VehicleIssuanceTerms} from './vehicleIssuanceProtocol';
export type VehicleIssuanceEvidenceCode='INPUT'|'ORIGINAL'|'IDENTITY'|'DEPLOYMENT'|'ACCOUNTS'|'HELD'|'UNAVAILABLE'|'DEADLINE'|'BUSY';
export class VehicleIssuanceEvidenceError extends Error {readonly reservationReleaseAuthorized=false;constructor(readonly code:VehicleIssuanceEvidenceCode){super(`Vehicle issuance held: ${code}`);this.name='VehicleIssuanceEvidenceError';}}
export function need(v:unknown,code:VehicleIssuanceEvidenceCode='INPUT'):asserts v{if(!v)throw new VehicleIssuanceEvidenceError(code);}
export const safe=(n:unknown):n is number=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0;
export function fields(value:unknown,names:string,optional=''):Record<string,unknown>{
 need(value&&typeof value==='object'&&!Array.isArray(value));const proto=Object.getPrototypeOf(value);need(proto===null||proto===Object.prototype);
 const required=names.split(' ').filter(Boolean),allowed=[...required,...optional.split(' ').filter(Boolean)],keys=Reflect.ownKeys(value);need(keys.every(k=>typeof k==='string'&&allowed.includes(k)));
 const out:Record<string,unknown>={};for(const name of allowed){const d=Object.getOwnPropertyDescriptor(value,name);need(d||!required.includes(name));if(d){need(d.enumerable&&'value'in d);out[name]=d.value;}}return out;
}
const decimal=(v:unknown)=>{need(typeof v==='string'&&/^(0|[1-9][0-9]*)$/.test(v)&&v.length<=20);return v;};
/** Detach every primitive. SHA256 identifies this saved original, not a signature. */
export function normalizeVehicleIssuanceOriginal(value:unknown):VehicleIssuanceOriginal{
 try{
 const v=fields(value,'version rootId attemptId buyer permitId permitExpiry genesisHash escrowRentReserve identity metadata terms','originalHash');need(v.version===1);
 const t=fields(v.terms,'recipeVersion recipeHash materialHash metadataHash site operator project oracleBudget oddsBps family tier');
 const terms:VehicleIssuanceTerms={recipeVersion:t.recipeVersion as number,recipeHash:vehicleHex(t.recipeHash,32),materialHash:vehicleHex(t.materialHash,32),metadataHash:vehicleHex(t.metadataHash,32),site:vehicleAddress(t.site),operator:vehicleAddress(t.operator),project:vehicleAddress(t.project),oracleBudget:decimal(t.oracleBudget),oddsBps:t.oddsBps as number,family:t.family as number,tier:t.tier as number};vehicleTermsBytes(terms);
 const m=fields(v.metadata,'name uri');need(typeof m.name==='string'&&typeof m.uri==='string');const metadata={name:m.name,uri:m.uri};need(vehicleMetadataHash(metadata.name,metadata.uri)===terms.metadataHash);
 const rawIdentity=fields(v.identity,'assetId collection family tier'),identity=PhaseEVehicleMintIdentitySchema.parse(rawIdentity);
 const original={version:1 as const,rootId:vehicleId(v.rootId),attemptId:vehicleId(v.attemptId),buyer:vehicleAddress(v.buyer),permitId:vehicleId(v.permitId),permitExpiry:decimal(v.permitExpiry),genesisHash:vehicleAddress(v.genesisHash),escrowRentReserve:decimal(v.escrowRentReserve),identity,metadata,terms};
 need(BigInt(original.escrowRentReserve)>0n&&BigInt(original.escrowRentReserve)<=0xffffffffffffffffn);
 need(BigInt(original.permitExpiry)>0n&&BigInt(original.permitExpiry)<=0x7fffffffffffffffn);
 const family=PHASE_E_VEHICLE_FAMILY_IDS[terms.family];
 need(identity.assetId===vehiclePda('vehicle_asset',original.rootId)[0].toBase58()&&identity.collection===vehiclePda('vehicle_collection')[0].toBase58()&&identity.family===family&&identity.tier===terms.tier);
 const originalHash=vehicleSha256(Buffer.from(JSON.stringify(original)));need(v.originalHash===undefined||v.originalHash===originalHash);
 return Object.freeze({...original,identity:Object.freeze(identity),metadata:Object.freeze(metadata),terms:Object.freeze(terms),originalHash});
 }catch{throw new VehicleIssuanceEvidenceError('ORIGINAL');}
}
export interface VehicleIssuanceProgramTrust{programId:string;reviewedDeploymentSlot:number;reviewedProgramDataSha256:string;upgradeAuthority:string|null}
export interface VehicleIssuanceTrust{expectedGenesisHash:string;craft:VehicleIssuanceProgramTrust;provider:VehicleIssuanceProgramTrust;core:VehicleIssuanceProgramTrust;stateProvenance:'fresh-reviewed-deployment'}
export interface VehicleIssuanceRawAccount{address:PublicKey;owner:PublicKey;executable:boolean;data:Uint8Array}
export interface VehicleIssuanceEvidenceRpc{getGenesisHash():Promise<string>;getSlot(commitment:'finalized'):Promise<number>;getMultipleAccountsInfoAndContext(addresses:PublicKey[],options:{commitment:'finalized';minContextSlot:number}):Promise<{context:{slot:number};value:(VehicleIssuanceRawAccount|null)[]}>}
export interface VehicleIssuanceEvidence{version:1;rootId:string;attemptId:string;buyer:string;identity:VehicleIssuanceOriginal['identity'];originalHash:string;termsHash:string;requestHash:string;randomness:string;permitId:string;requestSlot:number;resultSlot:number;settlementSlot:number;mintSlot:number;slot:number;source:{trust:'trusted-finalized-rpc-reviewed-program';stateProvenance:'fresh-reviewed-deployment';genesisHash:string;programs:readonly VehicleIssuanceProgramTrust[];accounts:readonly {address:string;owner:string;executable:boolean;dataSha256:string}[]};finalizedMintObserved:true;transactionProofVerified:false;paymentAuthorized:false;activationAuthorized:false;reservationReleaseAuthorized:false}
/** The paid original result is separate from observing a Core mint. A true
 * minted flag here is the craft record only; acquisition still reads the asset. */
export interface VehicleIssuanceTerminalEvidence extends Omit<VehicleIssuanceEvidence,'source'|'finalizedMintObserved'>{
 outcome:'lost'|'won';paid:true;minted:boolean;finalizedNormalResultObserved:true;finalizedMintObserved:false;
 source:VehicleIssuanceEvidence['source']&{profile:'paid-normal-result-12-v1'};
}
export const LOADER=new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
export function copyTrust(value:VehicleIssuanceTrust):VehicleIssuanceTrust{
 const t=fields(value,'expectedGenesisHash craft provider core stateProvenance');need(t.stateProvenance==='fresh-reviewed-deployment');
 const program=(v:unknown,id:string)=>{const p=fields(v,'programId reviewedDeploymentSlot reviewedProgramDataSha256 upgradeAuthority');need(p.programId===id&&safe(p.reviewedDeploymentSlot));return Object.freeze({programId:id,reviewedDeploymentSlot:p.reviewedDeploymentSlot,reviewedProgramDataSha256:vehicleHex(p.reviewedProgramDataSha256,32),upgradeAuthority:p.upgradeAuthority===null?null:vehicleAddress(p.upgradeAuthority)});};
 return Object.freeze({expectedGenesisHash:vehicleAddress(t.expectedGenesisHash),craft:program(t.craft,VEHICLE_CRAFT_PROGRAM),provider:program(t.provider,VEHICLE_VRF_PROGRAM),core:program(t.core,VEHICLE_CORE_PROGRAM),stateProvenance:t.stateProvenance});
}
export function attest(program:VehicleIssuanceRawAccount,data:VehicleIssuanceRawAccount,t:VehicleIssuanceProgramTrust){const p=Buffer.from(program.data),d=Buffer.from(data.data);need(program.executable&&program.owner.equals(LOADER)&&!data.executable&&data.owner.equals(LOADER)&&p.length===36&&p.readUInt32LE(0)===2&&p.subarray(4).equals(data.address.toBuffer())&&d.length>=45&&d.readUInt32LE(0)===3&&d.readBigUInt64LE(4)===BigInt(t.reviewedDeploymentSlot)&&vehicleSha256(d)===t.reviewedProgramDataSha256,'DEPLOYMENT');need(d[12]===0||d[12]===1,'DEPLOYMENT');need((d[12]===0?null:new PublicKey(d.subarray(13,45)).toBase58())===t.upgradeAuthority,'DEPLOYMENT');}
class Cursor{at=0;readonly b:Buffer;constructor(bytes:Uint8Array){this.b=Buffer.from(bytes);}take(n:number){need(safe(n)&&this.at+n<=this.b.length,'ACCOUNTS');const b=this.b.subarray(this.at,this.at+n);this.at+=n;return b;}key(){return new PublicKey(this.take(32)).toBase58();}u8(){return this.take(1)[0]!;}bool(){const n=this.u8();need(n===0||n===1,'ACCOUNTS');return n===1;}u64(){return this.take(8).readBigUInt64LE();}i64(){return this.take(8).readBigInt64LE();}slot(){const n=Number(this.u64());need(safe(n),'ACCOUNTS');return n;}string(){const b=this.take(this.take(4).readUInt32LE());const s=b.toString();need(Buffer.from(s).equals(b),'ACCOUNTS');return s;}done(){need(this.at===this.b.length,'ACCOUNTS');}}
const same=(a:unknown,b:unknown)=>need(a===b,'ACCOUNTS');
const begin=(row:VehicleIssuanceRawAccount,name:string,size:number)=>{need(!row.executable&&row.owner.toBase58()===VEHICLE_CRAFT_PROGRAM&&row.data.length===size,'ACCOUNTS');const c=new Cursor(row.data);need(c.take(8).equals(vehicleDiscriminator('account',name)),'ACCOUNTS');same(c.u8(),1);return c;};
function verifyVehicleIssuanceState(rows:VehicleIssuanceRawAccount[],o:VehicleIssuanceOriginal,slot:number,trust:VehicleIssuanceTrust,profile:'minted'):VehicleIssuanceEvidence;
function verifyVehicleIssuanceState(rows:VehicleIssuanceRawAccount[],o:VehicleIssuanceOriginal,slot:number,trust:VehicleIssuanceTrust,profile:'terminal'):VehicleIssuanceTerminalEvidence;
function verifyVehicleIssuanceState(rows:VehicleIssuanceRawAccount[],o:VehicleIssuanceOriginal,slot:number,trust:VehicleIssuanceTrust,profile:'minted'|'terminal'):VehicleIssuanceEvidence|VehicleIssuanceTerminalEvidence{
 const control=rows[6]!,root=rows[7]!,attempt=rows[8]!,receipt=rows[9]!,queue=rows[profile==='minted'?12:10]!,clock=rows[profile==='minted'?13:11]!;
 const c=begin(control,'VehicleControl',189);same(c.take(32).toString('hex'),new PublicKey(o.genesisHash).toBuffer().toString('hex'));vehicleAddress(c.key());const previous=c.key(),previousUntil=c.i64();need(previousUntil>=0n&&(previous!==PublicKey.default.toBase58()||previousUntil===0n),'ACCOUNTS');same(c.key(),o.identity.collection);same(c.key(),vehiclePda('vehicle_authority')[0].toBase58());c.bool();same(c.u64(),BigInt(o.escrowRentReserve));same(c.u8(),vehiclePda('vehicle_control')[1]);same(c.u8(),vehiclePda('vehicle_collection')[1]);same(c.u8(),vehiclePda('vehicle_authority')[1]);c.done();
 const termsHash=vehicleTermsHash(o),requestHash=vehicleKeccak(vehicleVrfRequest(o.rootId,o.attemptId,termsHash)).toString('hex');
 const r=begin(root,'VehicleRoot',170);same(r.take(16).toString('hex'),o.rootId);same(r.take(16).toString('hex'),o.attemptId);same(r.key(),o.buyer);same(r.key(),attempt.address.toBase58());same(r.key(),o.identity.assetId);same(r.take(32).toString('hex'),termsHash);same(r.u8(),vehiclePda('vehicle_root',o.rootId)[1]);r.done();
 const a=begin(attempt,'VehicleAttempt',557);same(a.key(),root.address.toBase58());same(a.take(16).toString('hex'),o.rootId);same(a.take(16).toString('hex'),o.attemptId);same(a.key(),o.buyer);same(a.take(16).toString('hex'),o.permitId);same(a.key(),o.identity.collection);same(a.key(),o.identity.assetId);need(a.take(208).equals(vehicleTermsBytes(o.terms)),'ACCOUNTS');same(a.take(32).toString('hex'),termsHash);same(a.take(32).toString('hex'),requestHash);const fees=vehicleFees();same(a.u64(),fees.application);same(a.u64(),fees.operator);same(a.u64(),fees.project);const randomness=a.take(32),outcome=a.u8(),paid=a.bool(),minted=a.bool(),requestedAt=a.i64(),requestSlot=a.slot(),resultSlot=a.slot(),settlementSlot=a.slot(),mintSlot=a.slot();same(a.u8(),vehiclePda('vehicle_attempt',o.attemptId)[1]);a.done();need(outcome<=2,'ACCOUNTS');
 if(profile==='minted'){
  need(outcome===2&&paid&&minted,'HELD');need(vehicleWins(randomness,o.terms.oddsBps),'ACCOUNTS');need(requestSlot>=Math.max(trust.craft.reviewedDeploymentSlot,trust.provider.reviewedDeploymentSlot,trust.core.reviewedDeploymentSlot)&&resultSlot>=requestSlot&&settlementSlot>=resultSlot&&mintSlot>=settlementSlot&&slot>=mintSlot,'ACCOUNTS');
 }else{
  need((outcome===1||outcome===2)&&paid,'HELD');
  need(vehicleWins(randomness,o.terms.oddsBps)===(outcome===2),'ACCOUNTS');
  need(requestSlot>=Math.max(trust.craft.reviewedDeploymentSlot,trust.provider.reviewedDeploymentSlot,trust.core.reviewedDeploymentSlot)&&resultSlot>=requestSlot&&settlementSlot>=resultSlot&&slot>=settlementSlot,'ACCOUNTS');
  need(minted?outcome===2&&mintSlot>=settlementSlot&&slot>=mintSlot:mintSlot===0,'ACCOUNTS');
 }
 const p=begin(receipt,'VehiclePermitReceipt',170);same(p.take(16).toString('hex'),o.permitId);same(p.key(),o.buyer);same(p.key(),root.address.toBase58());same(p.key(),attempt.address.toBase58());same(p.take(32).toString('hex'),termsHash);same(p.i64(),BigInt(o.permitExpiry));same(p.i64(),requestedAt);same(p.u8(),vehiclePda('vehicle_permit',o.permitId)[1]);p.done();need(requestedAt>0n&&BigInt(o.permitExpiry)>requestedAt&&BigInt(o.permitExpiry)-requestedAt<=BigInt(PHASE_E_SEEKER_AUCTION.maxPolicyPermitTtlSec),'ACCOUNTS');
 need(!clock.executable&&clock.owner.toBase58()==='Sysvar1111111111111111111111111111111111111'&&clock.data.length===40,'ACCOUNTS');const clockBytes=Buffer.from(clock.data);same(clockBytes.readBigUInt64LE(),BigInt(slot));need(clockBytes.readBigInt64LE(32)>=requestedAt,'ACCOUNTS');
 need(!queue.executable&&queue.address.toBase58()===VEHICLE_VRF_QUEUE&&queue.owner.toBase58()===VEHICLE_VRF_PROGRAM,'ACCOUNTS');
 if(profile==='terminal')return Object.freeze({version:1,rootId:o.rootId,attemptId:o.attemptId,buyer:o.buyer,identity:o.identity,originalHash:o.originalHash,termsHash,requestHash,randomness:randomness.toString('hex'),permitId:o.permitId,requestSlot,resultSlot,settlementSlot,mintSlot,slot,outcome:outcome===2?'won':'lost',paid:true,minted,
  source:Object.freeze({profile:'paid-normal-result-12-v1',trust:'trusted-finalized-rpc-reviewed-program',stateProvenance:trust.stateProvenance,genesisHash:trust.expectedGenesisHash,programs:Object.freeze([trust.craft,trust.provider,trust.core]),accounts:Object.freeze(rows.map(row=>Object.freeze({address:row.address.toBase58(),owner:row.owner.toBase58(),executable:row.executable,dataSha256:vehicleSha256(row.data)})))}),
  finalizedNormalResultObserved:true,finalizedMintObserved:false,transactionProofVerified:false,paymentAuthorized:false,activationAuthorized:false,reservationReleaseAuthorized:false});
 const asset=rows[10]!,collection=rows[11]!;
 need(!asset.executable&&asset.owner.toBase58()===VEHICLE_CORE_PROGRAM&&!collection.executable&&collection.owner.toBase58()===VEHICLE_CORE_PROGRAM,'ACCOUNTS');
 // Plain Core profile only. Current owner may differ from the immutable buyer;
 // installation still performs an independent fresh ownership/burn check.
 const ca=new Cursor(asset.data);same(ca.u8(),1);vehicleAddress(ca.key());same(ca.u8(),2);same(ca.key(),o.identity.collection);same(ca.string(),o.metadata.name);same(ca.string(),o.metadata.uri);const seq=ca.u8();need(seq===0||seq===1,'ACCOUNTS');if(seq===1)ca.u64();ca.done();
 const cc=new Cursor(collection.data);same(cc.u8(),5);same(cc.key(),vehiclePda('vehicle_authority')[0].toBase58());cc.string();cc.string();const numMinted=cc.take(4).readUInt32LE(),currentSize=cc.take(4).readUInt32LE();need(numMinted>0&&currentSize>0&&currentSize<=numMinted,'ACCOUNTS');cc.done();
 return Object.freeze({version:1,rootId:o.rootId,attemptId:o.attemptId,buyer:o.buyer,identity:o.identity,originalHash:o.originalHash,termsHash,requestHash,randomness:randomness.toString('hex'),permitId:o.permitId,requestSlot,resultSlot,settlementSlot,mintSlot,slot,source:Object.freeze({trust:'trusted-finalized-rpc-reviewed-program',stateProvenance:trust.stateProvenance,genesisHash:trust.expectedGenesisHash,programs:Object.freeze([trust.craft,trust.provider,trust.core]),accounts:Object.freeze(rows.map(row=>Object.freeze({address:row.address.toBase58(),owner:row.owner.toBase58(),executable:row.executable,dataSha256:vehicleSha256(row.data)})))}),finalizedMintObserved:true,transactionProofVerified:false,paymentAuthorized:false,activationAuthorized:false,reservationReleaseAuthorized:false});
}

export function verifyVehicleIssuanceAccounts(rows:VehicleIssuanceRawAccount[],o:VehicleIssuanceOriginal,slot:number,trust:VehicleIssuanceTrust):VehicleIssuanceEvidence{
 return verifyVehicleIssuanceState(rows,o,slot,trust,'minted');
}
export function verifyVehicleIssuanceTerminalAccounts(rows:VehicleIssuanceRawAccount[],o:VehicleIssuanceOriginal,slot:number,trust:VehicleIssuanceTrust):VehicleIssuanceTerminalEvidence{
 return verifyVehicleIssuanceState(rows,o,slot,trust,'terminal');
}
