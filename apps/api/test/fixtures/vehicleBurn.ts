/** Actual private reservation -> Core capture -> retained consent -> locally
 * signed finalized burn fixture. No live chain or independently proven minting. */
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {Keypair,PublicKey,Message,VersionedTransaction,type VersionedTransactionResponse} from '@solana/web3.js';
import {createVehicleBurnFinalityReader,type VehicleBurnFinalityRpc} from '@shardkeep/chain/vehicle-burn-finality';
import type {PhaseEVehicleFamily,PhaseEVehicleTier} from '@shardkeep/shared/phaseEVehicles';
import {createVehicleActivationReservations} from '../../src/game/vehicleActivationReservations';
import {createVehicleBurnPreparations} from '../../src/game/vehicleBurnPreparations';
import {assertFreshLockedBaseAuthority} from '../../src/game/baseOwnership';
import {resourceClaimsDatabase} from './resourceClaimsDatabase';
const requireChain=createRequire(new URL('../../../../packages/chain/package.json',import.meta.url));
const {Key,MPL_CORE_PROGRAM_ID}=requireChain('@metaplex-foundation/mpl-core') as {Key:{AssetV1:number;CollectionV1:number};MPL_CORE_PROGRAM_ID:string};
const {publicKey}=requireChain('@metaplex-foundation/umi') as {publicKey:(v:string)=>string};
const bs58=(requireChain('bs58') as {default:{encode:(v:Uint8Array)=>string}}).default;
interface Serializer {serialize:(v:Record<string,unknown>)=>Uint8Array}
const {getAssetV1AccountDataSerializer}=requireChain('@metaplex-foundation/mpl-core/dist/src/generated/types/assetV1AccountData') as {getAssetV1AccountDataSerializer:()=>Serializer};
const {getCollectionV1AccountDataSerializer}=requireChain('@metaplex-foundation/mpl-core/dist/src/generated/types/collectionV1AccountData') as {getCollectionV1AccountDataSerializer:()=>Serializer};
export async function vehicleBurnDatabase(family:PhaseEVehicleFamily='survey_balloon',tier:PhaseEVehicleTier=1,options:{genesisHash?:string}={},storage:{connection?:ReturnType<typeof resourceClaimsDatabase>;completedAt?:Date}={}){
 const conn=storage.connection??resourceClaimsDatabase();if(!storage.connection)await conn.setup();const wallet=Keypair.generate(),baseId=randomUUID(),berthId=randomUUID(),jobId=randomUUID();
 const identity={assetId:Keypair.generate().publicKey.toBase58(),collection:Keypair.generate().publicKey.toBase58(),family,tier},actor=wallet.publicKey.toBase58();
 await conn.sql`insert into players(wallet) values(${actor})`;
 await conn.sql`insert into bases(id,owner_wallet) values(${baseId},${actor})`;
 await conn.sql`insert into base_slots(wallet,slot,base_id) values(${actor},1,${baseId})`;
 await conn.sql`insert into buildings(id,player_wallet,base_id,type,tx,ty) values(${berthId},${actor},${baseId},'berth',2,2)`;
 const completed=storage.completedAt?.toISOString()??null;
 await conn.sql`insert into builder_jobs(id,player_wallet,base_id,building_id,kind,started_at,finishes_at,completed_at) values(${jobId},${actor},${baseId},${berthId},'build',coalesce(${completed}::timestamptz,now()-interval '1 hour')-interval '1 hour',coalesce(${completed}::timestamptz,now()-interval '1 hour'),coalesce(${completed}::timestamptz,now()-interval '1 hour'))`;
 const reservations=createVehicleActivationReservations(conn.db),attestation={fixture:'owner-attested mint identity; no live mint provenance'};
 // 2026-10-10 (CI 37503885235): since 0266 (e6af3ddd4) register() also proves provenance='owner_attestation', a
 // column a pre-0266 prefix database (vehicleConsumptionFence's real pre-0214 upgrade) does not have. Write that
 // identity exactly as the pre-0266 source did; the real upgrade then backfills provenance by its column default.
 const [registry]=await conn.sql`select exists(select 1 from pg_attribute where attrelid='public.vehicle_mint_registry'::regclass and attname='provenance' and attnum>0 and not attisdropped) current`;
 if(registry!.current)await reservations.register(identity,attestation);
 else await conn.sql`insert into public.vehicle_mint_registry(asset_id,collection,family,tier,owner_attestation) values(${identity.assetId},${identity.collection},${identity.family},${identity.tier},${JSON.stringify(attestation)}::jsonb)`;
 const reservation=await reservations.reserve({wallet:actor,assetId:identity.assetId,berthId,idempotencyKey:randomUUID()},{baseId,
  assertAuthority:async(tx,w,id)=>{await assertFreshLockedBaseAuthority(tx,w,id);}});
 const core=new PublicKey(MPL_CORE_PROGRAM_ID),loader=new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'),programData=PublicKey.findProgramAddressSync([core.toBuffer()],loader)[0];
 const code=Buffer.alloc(50);code.writeUInt32LE(3);code.writeBigUInt64LE(50n,4);code[45]=99;
 const raw=(address:PublicKey,data:Uint8Array,owner=core,executable=false)=>({address,data:Buffer.from(data),owner,executable});
 const accounts=[raw(core,Buffer.concat([Buffer.of(2,0,0,0),programData.toBuffer()]),loader,true),raw(programData,code,loader),
  raw(new PublicKey(identity.assetId),getAssetV1AccountDataSerializer().serialize({key:Key.AssetV1,owner:publicKey(actor),updateAuthority:{__kind:'Collection',fields:[publicKey(identity.collection)]},name:'Vehicle',uri:'',seq:null})),
  raw(new PublicKey(identity.collection),getCollectionV1AccountDataSerializer().serialize({key:Key.CollectionV1,updateAuthority:publicKey(actor),name:'Vehicles',uri:'',numMinted:1,currentSize:1}))];
 const trust={expectedGenesisHash:options.genesisHash??Keypair.generate().publicKey.toBase58(),reviewedDeploymentSlot:50,reviewedProgramDataSha256:createHash('sha256').update(code).digest('hex'),upgradeAuthority:null};
 const blockhash={blockhash:Keypair.generate().publicKey.toBase58(),contextSlot:100,lastValidBlockHeight:1000};
 let slot=100,transaction:VersionedTransactionResponse|null=null,online=true;
 const ensure=()=>{if(!online)throw Error('fixture archive unavailable');};
 const rpc:VehicleBurnFinalityRpc={getGenesisHash:async()=>{ensure();return trust.expectedGenesisHash;},getSlot:async()=>{ensure();return slot;},
  getMultipleAccountsInfoAndContext:async addresses=>{ensure();return {context:{slot},value:addresses.map(k=>accounts.find(a=>a.address.equals(k))??null)};},
  getSignaturesForAddress:async()=>{ensure();return [...transaction?[{signature:transaction.transaction.signatures[0]!,slot:transaction.slot,err:transaction.meta!.err,memo:null,blockTime:transaction.blockTime??null,confirmationStatus:'finalized' as const}]:[],
   {signature:bs58.encode(Buffer.alloc(64,1)),slot:90,err:null,memo:null,blockTime:null,confirmationStatus:'finalized' as const}];},
  getTransaction:async signature=>{ensure();return transaction?.transaction.signatures[0]===signature?transaction:null;},
  getBlockSignatures:async requested=>{ensure();return {signatures:transaction?.slot===requested?[transaction.transaction.signatures[0]!]:[]};}};
 let preparations:ReturnType<typeof createVehicleBurnPreparations>;
 const reader=createVehicleBurnFinalityReader(()=>rpc,trust,id=>preparations.loadSavedReservation(id));
 preparations=createVehicleBurnPreparations(conn.db,{enabled:()=>true,captureOwner:reader.captureOwner,getBlockhash:async()=>blockhash});
 const preparation=await preparations.prepare(actor,reservation.id);
 function finalizeBurn(){
  const message=Message.from(Buffer.from(preparation.messageHex,'hex')),signed=new VersionedTransaction(message);signed.sign([wallet]);
  const signature=bs58.encode(signed.signatures[0]!),pre=message.accountKeys.map(()=>10_000_000),post=[...pre],asset=message.accountKeys.findIndex(k=>k.toBase58()===identity.assetId);
  post[0]!+=995_000;post[asset]!-=1_000_000;
  transaction={slot:110,blockTime:1_700_000_000,version:'legacy',transaction:{message,signatures:[signature]},meta:{err:null,fee:5000,preBalances:pre,postBalances:post,innerInstructions:[],loadedAddresses:{readonly:[],writable:[]}}};slot=120;
  return {signature,signedTransaction:signed.serialize(),transaction};
 }
 return {conn,wallet,actor,baseId,berthId,jobId,identity,reservation,preparation,preparations,reader,rpc,trust,finalizeBurn,
  setOnline(value:boolean){online=value;},dispose:async()=>{if(!storage.connection)await conn.close();}};
}
