/** Explicit synthetic codec bank; never a live issuance or installed trust. */
import {PublicKey,SYSVAR_CLOCK_PUBKEY} from '@solana/web3.js';
import {normalizeVehicleIssuanceOriginal,LOADER,type VehicleIssuanceTrust,type VehicleIssuanceRawAccount,type VehicleIssuanceEvidenceRpc} from '../vehicleIssuanceAccounts';
import {vehiclePda,vehicleIdentity,vehicleMetadataHash,vehicleTermsHash,vehicleVrfRequest,vehicleKeccak,vehicleDiscriminator,vehicleTermsBytes,vehicleFees,vehicleU32,vehicleU64,vehicleSha256,VEHICLE_CRAFT_PROGRAM,VEHICLE_VRF_PROGRAM,VEHICLE_VRF_QUEUE,VEHICLE_CORE_PROGRAM} from '../vehicleIssuanceProtocol';
const key=(n:number)=>new PublicKey(Buffer.alloc(32,n)),b=(s:string)=>new PublicKey(s).toBuffer(),id=(s:string)=>Buffer.from(s,'hex');
const str=(s:string)=>Buffer.concat([vehicleU32(Buffer.byteLength(s)),Buffer.from(s)]),account=(n:string,parts:Buffer[])=>Buffer.concat([vehicleDiscriminator('account',n),Buffer.of(1),...parts]);
export function vehicleIssuanceFixture(rootId='11'.repeat(16)){
 const attemptId=vehicleSha256(Buffer.from('attempt'+rootId)).slice(0,32),permitId=vehicleSha256(Buffer.from('permit'+rootId)).slice(0,32),metadata={name:'Synthetic test balloon',uri:'https://invalid.example/local-vehicle'};
 const original=normalizeVehicleIssuanceOriginal({version:1,rootId,attemptId,permitId,buyer:key(4).toBase58(),permitExpiry:'1700000060',genesisHash:key(5).toBase58(),escrowRentReserve:'890880',identity:vehicleIdentity(rootId,0,1),metadata,terms:{recipeVersion:1,recipeHash:'41'.repeat(32),materialHash:'42'.repeat(32),metadataHash:vehicleMetadataHash(metadata.name,metadata.uri),site:key(6).toBase58(),operator:key(7).toBase58(),project:key(8).toBase58(),oracleBudget:'10000000',oddsBps:10000,family:0,tier:1}});
 const rows:VehicleIssuanceRawAccount[]=[],programs=[VEHICLE_CRAFT_PROGRAM,VEHICLE_VRF_PROGRAM,VEHICLE_CORE_PROGRAM].map((programId,i)=>{
  const address=new PublicKey(programId),pd=PublicKey.findProgramAddressSync([address.toBuffer()],LOADER)[0],bytes=Buffer.concat([vehicleU32(3),vehicleU64(5n),Buffer.of(1),key(9).toBuffer(),Buffer.alloc(8,i+1)]);
  rows.push({address,owner:LOADER,executable:true,data:Buffer.concat([vehicleU32(2),pd.toBuffer()])},{address:pd,owner:LOADER,executable:false,data:bytes});
  return {programId,reviewedDeploymentSlot:5,reviewedProgramDataSha256:vehicleSha256(bytes),upgradeAuthority:key(9).toBase58()};
 });
 const trust:VehicleIssuanceTrust={expectedGenesisHash:original.genesisHash,craft:programs[0]!,provider:programs[1]!,core:programs[2]!,stateProvenance:'fresh-reviewed-deployment'};
 const add=(seed:string,tail:string|undefined,bytes:Buffer)=>rows.push({address:vehiclePda(seed,tail)[0],owner:new PublicKey(VEHICLE_CRAFT_PROGRAM),executable:false,data:bytes}),bump=(seed:string,tail?:string)=>Buffer.of(vehiclePda(seed,tail)[1]);
 const termsHash=vehicleTermsHash(original),requestHash=vehicleKeccak(vehicleVrfRequest(rootId,attemptId,termsHash)),fees=vehicleFees();
 add('vehicle_control',undefined,account('VehicleControl',[b(original.genesisHash),key(10).toBuffer(),Buffer.alloc(32),Buffer.alloc(8),b(original.identity.collection),vehiclePda('vehicle_authority')[0].toBuffer(),Buffer.of(1),vehicleU64(BigInt(original.escrowRentReserve)),bump('vehicle_control'),bump('vehicle_collection'),bump('vehicle_authority')]));
 add('vehicle_root',rootId,account('VehicleRoot',[id(rootId),id(attemptId),b(original.buyer),vehiclePda('vehicle_attempt',attemptId)[0].toBuffer(),b(original.identity.assetId),id(termsHash),bump('vehicle_root',rootId)]));
 add('vehicle_attempt',attemptId,account('VehicleAttempt',[vehiclePda('vehicle_root',rootId)[0].toBuffer(),id(rootId),id(attemptId),b(original.buyer),id(permitId),b(original.identity.collection),b(original.identity.assetId),vehicleTermsBytes(original.terms),id(termsHash),requestHash,vehicleU64(fees.application),vehicleU64(fees.operator),vehicleU64(fees.project),Buffer.alloc(32),Buffer.of(2,1,1),vehicleU64(1700000000n),vehicleU64(10n),vehicleU64(11n),vehicleU64(12n),vehicleU64(13n),bump('vehicle_attempt',attemptId)]));
 add('vehicle_permit',permitId,account('VehiclePermitReceipt',[id(permitId),b(original.buyer),vehiclePda('vehicle_root',rootId)[0].toBuffer(),vehiclePda('vehicle_attempt',attemptId)[0].toBuffer(),id(termsHash),vehicleU64(1700000060n),vehicleU64(1700000000n),bump('vehicle_permit',permitId)]));
 rows.push({address:new PublicKey(original.identity.assetId),owner:new PublicKey(VEHICLE_CORE_PROGRAM),executable:false,data:Buffer.concat([Buffer.of(1),b(original.buyer),Buffer.of(2),b(original.identity.collection),str(metadata.name),str(metadata.uri),Buffer.of(0)])});
 rows.push({address:new PublicKey(original.identity.collection),owner:new PublicKey(VEHICLE_CORE_PROGRAM),executable:false,data:Buffer.concat([Buffer.of(5),vehiclePda('vehicle_authority')[0].toBuffer(),str('Synthetic collection'),str('https://invalid.example/collection'),vehicleU32(1),vehicleU32(1)])});
 rows.push({address:new PublicKey(VEHICLE_VRF_QUEUE),owner:new PublicKey(VEHICLE_VRF_PROGRAM),executable:false,data:Buffer.alloc(1)});
 const clock=Buffer.alloc(40);clock.writeBigUInt64LE(20n);clock.writeBigInt64LE(1700000020n,32);rows.push({address:SYSVAR_CLOCK_PUBKEY,owner:new PublicKey('Sysvar1111111111111111111111111111111111111'),executable:false,data:clock});
 const rpc:VehicleIssuanceEvidenceRpc={getGenesisHash:async()=>original.genesisHash,getSlot:async()=>20,getMultipleAccountsInfoAndContext:async addresses=>({context:{slot:20},value:addresses.map(a=>rows.find(r=>r.address.equals(a))??null)})};
 return {original,trust,rows,rpc};
}
