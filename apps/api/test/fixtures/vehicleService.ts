/** Fresh owner-attested registry NFT with actual encoded Core ownership capture.
 * This is not independently verified mint provenance or a service burn. */
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {Keypair,PublicKey} from '@solana/web3.js';
import {createVehicleBurnFinalityReader,type VehicleBurnFinalityRpc} from '@shardkeep/chain/vehicle-burn-finality';
import {createVehicleActivationReservations} from '../../src/game/vehicleActivationReservations';
import type {PhaseEVehicleFamily,PhaseEVehicleTier} from '@shardkeep/shared/phaseEVehicles';
import type {vehicleBurnDatabase} from './vehicleBurn';
const requireChain=createRequire(new URL('../../../../packages/chain/package.json',import.meta.url));
const {getAssetV1AccountDataSerializer}=requireChain('@metaplex-foundation/mpl-core/dist/src/generated/types/assetV1AccountData') as {getAssetV1AccountDataSerializer:()=>{serialize:(v:Record<string,unknown>)=>Uint8Array}};
const {publicKey}=requireChain('@metaplex-foundation/umi') as {publicKey:(v:string)=>string};
const {Key}=requireChain('@metaplex-foundation/mpl-core') as {Key:{AssetV1:number}};
export async function vehicleServiceAsset(f:Awaited<ReturnType<typeof vehicleBurnDatabase>>,options:{owner?:string;family?:PhaseEVehicleFamily;tier?:PhaseEVehicleTier}={}){
 const identity={...f.identity,assetId:Keypair.generate().publicKey.toBase58(),family:options.family??f.identity.family,tier:options.tier??f.identity.tier};
 await createVehicleActivationReservations(f.conn.db).register(identity,{fixture:'Owner-attested service NFT identity; no independent mint authority'});
 const bytes=getAssetV1AccountDataSerializer().serialize({key:Key.AssetV1,owner:publicKey(options.owner??f.actor),updateAuthority:{__kind:'Collection',fields:[publicKey(identity.collection)]},name:'Service vehicle',uri:'',seq:null});
 const rpc:VehicleBurnFinalityRpc={...f.rpc,getMultipleAccountsInfoAndContext:async(addresses,config)=>{
  const answer=await f.rpc.getMultipleAccountsInfoAndContext(addresses.map(key=>key.toBase58()===identity.assetId?new PublicKey(f.identity.assetId):key),config);
  return {...answer,value:answer.value.map((row,i)=>addresses[i]!.toBase58()===identity.assetId&&row?{...row,address:addresses[i]!,data:Buffer.from(bytes)}:row)};
 }};
 const reader=createVehicleBurnFinalityReader(()=>rpc,f.trust,async()=>null);
 return {identity,reader,rpc};
}

// Extra completed fixture berths are not ordinary five-berth construction proof.
export async function vehicleServiceBuilding(f:Pick<Awaited<ReturnType<typeof vehicleBurnDatabase>>,'conn'|'actor'|'baseId'>,type:'berth'|'lodge',completedAt=new Date(Date.now()-7*86400000)){
 const id=randomUUID();await f.conn.sql`insert into buildings(id,player_wallet,base_id,type,tx,ty) values(${id},${f.actor},${f.baseId},${type},8,8)`;
 await f.conn.sql`insert into builder_jobs(player_wallet,base_id,building_id,kind,started_at,finishes_at,completed_at) values(${f.actor},${f.baseId},${id},'build',coalesce(${completedAt?.toISOString()??null}::timestamptz,date_trunc('milliseconds',now())-interval '1 hour')-interval '1 hour',coalesce(${completedAt?.toISOString()??null}::timestamptz,date_trunc('milliseconds',now())-interval '1 hour'),coalesce(${completedAt?.toISOString()??null}::timestamptz,date_trunc('milliseconds',now())-interval '1 hour'))`;return id;
}
export async function vehicleServiceExpeditions(f:Pick<Awaited<ReturnType<typeof vehicleBurnDatabase>>,'conn'|'actor'|'baseId'|'reservation'>){
 const {vi}=await import('vitest'),{createMiningTermFixture}=await import('../../../../packages/chain/src/testFixtures/miningZeroWinnerTerm');
 const {prefetchExpeditionTermReader}=await import('../../src/game/expeditionTermReader'),{dispatchAdvancedExpedition}=await import('../../src/game/advancedExpeditionDispatch'),{settleDueAdvancedExpeditions}=await import('../../src/game/advancedExpeditionReturns'),{assertFreshLockedBaseAuthority}=await import('../../src/game/baseOwnership'),{SYSVAR_CLOCK_PUBKEY}=await import('@solana/web3.js');
 await vehicleServiceBuilding(f,'lodge');for(const resource of ['rough_prism','heartwood_logs','crown_iron_ore'])await f.conn.sql`insert into resource_stocks(base_id,resource_id,available,reserved) values(${f.baseId},${resource},1000,0) on conflict do nothing`;
 let now=new Date(Math.floor((Date.now()-6*86400000)/1000)*1000);vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(now);const bank=await createMiningTermFixture({day:now.toISOString().slice(0,10),genesisHash:Keypair.generate().publicKey,programId:Keypair.generate().publicKey});
 const authority={baseId:f.baseId,assertAuthority:async(...args:Parameters<typeof assertFreshLockedBaseAuthority>)=>{await assertFreshLockedBaseAuthority(...args);}};
 async function reader(){bank.store.get(SYSVAR_CLOCK_PUBKEY.toBase58())!.data.writeBigInt64LE(BigInt(+now/1000),32);return prefetchExpeditionTermReader(bank.connect,bank.policy);}
 const command=(installationId=f.reservation.id)=>({id:randomUUID(),baseId:f.baseId,installationId,routeId:'coastal_survey',policyVersion:1});
 async function depart(installationId=f.reservation.id){return dispatchAdvancedExpedition(f.conn.db,f.actor,command(installationId),authority,{reader:await reader(),clock:()=>now});}
 async function complete(trip:Awaited<ReturnType<typeof depart>>){now=trip.returnsAt;vi.setSystemTime(now);return f.conn.db.transaction(tx=>settleDueAdvancedExpeditions(tx,f.baseId,now));}
 return {depart,complete,command,reader,authority,clock:()=>now};
}
export async function vehicleServiceInstallation(f:Awaited<ReturnType<typeof vehicleBurnDatabase>>,family:PhaseEVehicleFamily){
 const {Message,VersionedTransaction}=await import('@solana/web3.js'),{createVehicleBurnPreparations}=await import('../../src/game/vehicleBurnPreparations'),{createVehicleInstallations}=await import('../../src/game/vehicleInstallations'),{assertFreshLockedBaseAuthority}=await import('../../src/game/baseOwnership');
 const bs58=(requireChain('bs58') as {default:{encode:(v:Uint8Array)=>string}}).default,asset=await vehicleServiceAsset(f,{family}),berthId=await vehicleServiceBuilding(f,'berth');
 const reservation=await createVehicleActivationReservations(f.conn.db).reserve({wallet:f.actor,assetId:asset.identity.assetId,berthId,idempotencyKey:randomUUID()},{baseId:f.baseId,assertAuthority:async(...args:Parameters<typeof assertFreshLockedBaseAuthority>)=>{await assertFreshLockedBaseAuthority(...args);}});
 let slot=200,transaction:import('@solana/web3.js').VersionedTransactionResponse|null=null;
 const rpc:VehicleBurnFinalityRpc={...asset.rpc,getSlot:async()=>slot,getMultipleAccountsInfoAndContext:async(...args)=>({...await asset.rpc.getMultipleAccountsInfoAndContext(...args),context:{slot}}),getSignaturesForAddress:async()=>[...transaction?[{signature:transaction.transaction.signatures[0]!,slot:transaction.slot,err:null,memo:null,blockTime:transaction.blockTime??null,confirmationStatus:'finalized' as const}]:[],{signature:bs58.encode(Buffer.alloc(64,1)),slot:190,err:null,memo:null,blockTime:null,confirmationStatus:'finalized' as const}],getTransaction:async signature=>transaction?.transaction.signatures[0]===signature?transaction:null,getBlockSignatures:async requested=>({signatures:transaction?.slot===requested?[transaction.transaction.signatures[0]!]:[]})};
 let preparations:ReturnType<typeof createVehicleBurnPreparations>;const reader=createVehicleBurnFinalityReader(()=>rpc,f.trust,id=>preparations.loadSavedReservation(id));preparations=createVehicleBurnPreparations(f.conn.db,{enabled:()=>true,captureOwner:reader.captureOwner,getBlockhash:async()=>({blockhash:Keypair.generate().publicKey.toBase58(),contextSlot:slot,lastValidBlockHeight:1000})});const prepared=await preparations.prepare(f.actor,reservation.id),message=Message.from(Buffer.from(prepared.messageHex,'hex')),signed=new VersionedTransaction(message);signed.sign([f.wallet]);const pre=message.accountKeys.map(()=>10_000_000),post=[...pre],index=message.accountKeys.findIndex(k=>k.toBase58()===asset.identity.assetId);post[0]!+=995_000;post[index]!-=1_000_000;transaction={slot:210,blockTime:1_700_000_000,version:'legacy',transaction:{message,signatures:[bs58.encode(signed.signatures[0]!)]},meta:{err:null,fee:5000,preBalances:pre,postBalances:post,innerInstructions:[],loadedAddresses:{readonly:[],writable:[]}}};slot=220;
 const installed=await createVehicleInstallations(f.conn.db,{verifyBurn:reader.verify}).recover(f.actor,reservation.id);return {reservation,installed};
}
