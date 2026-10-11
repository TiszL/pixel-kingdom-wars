/** D153.207 local-only original issuance wire. No signer, RPC or activation. */
import {createHash} from 'node:crypto';
import {PublicKey} from '@solana/web3.js';
import {keccak_256} from '@noble/hashes/sha3.js';
import {PHASE_E_POLICY,PHASE_E_VEHICLES} from '@shardkeep/shared';
import {PHASE_E_VEHICLE_FAMILY_IDS,type PhaseEVehicleMintIdentity} from '@shardkeep/shared/phaseEVehicles';
export const VEHICLE_CRAFT_PROGRAM='4FnNXB9FFSnDmGnwyML28XBugxgzdHqJfXZ1vxXjye59';
export const VEHICLE_VRF_PROGRAM='Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz';
export const VEHICLE_VRF_QUEUE='Cuj97ggrhhidhbu39TijNVqE74xvKJ69gDervRUXAxGh';
export const VEHICLE_CORE_PROGRAM='CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d';
export const vehicleSha256=(v:Uint8Array)=>createHash('sha256').update(v).digest('hex');
export const vehicleKeccak=(v:Uint8Array)=>Buffer.from(keccak_256(v));
export const vehicleDiscriminator=(kind:'account'|'global',name:string)=>createHash('sha256').update(`${kind}:${name}`).digest().subarray(0,8);
export function vehicleHex(v:unknown,n:number):string{if(typeof v!=='string'||v.length!==n*2||!/^[0-9a-f]+$/.test(v))throw Error('VEHICLE_HEX');return v;}
export function vehicleAddress(v:unknown):string{if(typeof v!=='string'||v.length<32||v.length>44)throw Error('VEHICLE_ADDRESS');const k=new PublicKey(v);if(k.equals(PublicKey.default)||k.toBase58()!==v)throw Error('VEHICLE_ADDRESS');return v;}
export const vehicleId=(v:unknown)=>{const s=vehicleHex(v,16);if(/^0+$/.test(s))throw Error('VEHICLE_ID');return s;};
export const vehicleU32=(v:number)=>{if(!Number.isInteger(v)||v<0||v>0xffffffff)throw Error('VEHICLE_U32');const b=Buffer.alloc(4);b.writeUInt32LE(v);return b;};
export const vehicleU64=(v:bigint)=>{const b=Buffer.alloc(8);b.writeBigUInt64LE(v);return b;};
const str=(s:string)=>Buffer.concat([vehicleU32(Buffer.byteLength(s)),Buffer.from(s)]);
const key=(s:string)=>new PublicKey(vehicleAddress(s)).toBuffer();
export function vehiclePda(seed:string,id?:string):[PublicKey,number]{return PublicKey.findProgramAddressSync([Buffer.from(seed),...(id===undefined?[]:[Buffer.from(vehicleId(id),'hex')])],new PublicKey(VEHICLE_CRAFT_PROGRAM));}
export interface VehicleIssuanceTerms {recipeVersion:number;recipeHash:string;materialHash:string;metadataHash:string;site:string;operator:string;project:string;oracleBudget:string;oddsBps:number;family:number;tier:number}
export function vehicleTermsBytes(t:VehicleIssuanceTerms):Buffer{
 if(!Number.isInteger(t.oddsBps)||t.oddsBps<0||t.oddsBps>PHASE_E_POLICY.basisPoints||!Number.isInteger(t.family)||t.family<0||t.family>=PHASE_E_VEHICLES.advancedFamilyCount||!PHASE_E_VEHICLES.tiers.includes(t.tier as 1))throw Error('VEHICLE_TERMS');
 const odds=Buffer.alloc(2);odds.writeUInt16LE(t.oddsBps);
 if(!/^(0|[1-9][0-9]*)$/.test(t.oracleBudget))throw Error('VEHICLE_ORACLE_BUDGET');
 return Buffer.concat([vehicleU32(t.recipeVersion),...['recipeHash','materialHash','metadataHash'].map(k=>Buffer.from(vehicleHex(t[k as keyof VehicleIssuanceTerms],32),'hex')),key(t.site),key(t.operator),key(t.project),vehicleU64(BigInt(t.oracleBudget)),odds,Buffer.of(t.family,t.tier)]);
}
export function vehicleMetadataHash(name:string,uri:string):string{
 if(typeof name!=='string'||typeof uri!=='string'||!name.length||!uri.length||Buffer.byteLength(name)>64||Buffer.byteLength(uri)>512||Buffer.from(name).toString()!==name||Buffer.from(uri).toString()!==uri)throw Error('VEHICLE_METADATA');
 return vehicleKeccak(Buffer.concat([Buffer.from('SKVEHM01'),str(name),str(uri)])).toString('hex');
}
export function vehicleFees(){const application=BigInt(PHASE_E_POLICY.craft.applicationFeeLamports),operator=application*BigInt(PHASE_E_POLICY.craft.operatorBps)/BigInt(PHASE_E_POLICY.basisPoints);return {application,operator,project:application-operator};}
export interface VehicleIssuanceOriginal {
 version:1;rootId:string;attemptId:string;buyer:string;permitId:string;permitExpiry:string;genesisHash:string;escrowRentReserve:string;
 identity:PhaseEVehicleMintIdentity;metadata:{name:string;uri:string};terms:VehicleIssuanceTerms;originalHash:string;
}
export function vehicleTermsHash(v:Omit<VehicleIssuanceOriginal,'originalHash'>):string{const fees=vehicleFees();return vehicleKeccak(Buffer.concat([
 Buffer.from('SKVEHT01'),key(VEHICLE_CRAFT_PROGRAM),key(v.genesisHash),vehiclePda('vehicle_control')[0].toBuffer(),Buffer.from(vehicleId(v.rootId),'hex'),Buffer.from(vehicleId(v.attemptId),'hex'),key(v.buyer),key(v.identity.collection),key(v.identity.assetId),vehicleTermsBytes(v.terms),vehicleU64(fees.application),vehicleU64(fees.operator),vehicleU64(fees.project),vehicleU64(BigInt(v.escrowRentReserve)),
])).toString('hex');}
/** Exact installed SDK0.17.2 wire: callback randomness precedes these saved args. */
export function vehicleVrfRequest(rootId:string,attemptId:string,termsHash:string):Buffer{
 const callback=vehicleDiscriminator('global','consume_vehicle_randomness'),args=Buffer.concat([Buffer.from(vehicleId(rootId),'hex'),Buffer.from(vehicleId(attemptId),'hex')]);
 return Buffer.concat([Buffer.from([10,0,0,0,0,0,0,0]),Buffer.from(vehicleHex(termsHash,32),'hex'),key(VEHICLE_CRAFT_PROGRAM),vehicleU32(callback.length),callback,vehicleU32(2),vehiclePda('vehicle_root',rootId)[0].toBuffer(),Buffer.of(0,0),vehiclePda('vehicle_attempt',attemptId)[0].toBuffer(),Buffer.of(0,1),vehicleU32(args.length),args]);
}
export function vehicleWins(randomness:Uint8Array,oddsBps:number):boolean{
 if(!(randomness instanceof Uint8Array)||randomness.length!==32||!Number.isInteger(oddsBps)||oddsBps<0||oddsBps>PHASE_E_POLICY.basisPoints)throw Error('VEHICLE_DRAW');
 return oddsBps===PHASE_E_POLICY.basisPoints||Buffer.from(randomness).readBigUInt64LE(0)<(BigInt(oddsBps)<<64n)/BigInt(PHASE_E_POLICY.basisPoints);
}
export function vehicleIdentity(rootId:string,family:number,tier:number):PhaseEVehicleMintIdentity{return {assetId:vehiclePda('vehicle_asset',rootId)[0].toBase58(),collection:vehiclePda('vehicle_collection')[0].toBase58(),family:PHASE_E_VEHICLE_FAMILY_IDS[family]!,tier:tier as 1};}
