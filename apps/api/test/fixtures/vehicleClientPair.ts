/** D182 R1 private paired fixture. Encoded Core/finality/calendar are injected;
 * reservations, signed consent, installations, services and trips use real owners.
 * Extra completed berths and registry entries do not prove K231 or mint provenance. */
import {createHash,randomUUID} from 'node:crypto';
import {Keypair,PublicKey,Message,VersionedTransaction,SYSVAR_CLOCK_PUBKEY,type VersionedTransactionResponse} from '@solana/web3.js';
import bs58 from 'bs58';
import {expect,vi} from 'vitest';
import {PHASE_E_VEHICLE_CLIENT,PHASE_E_VEHICLES,PHASE_E_ADVANCED_EXPEDITIONS,PHASE_E_PAID_STARTER_ROUTES} from '@shardkeep/shared';
import type {VehicleBurnFinalityRpc} from '@shardkeep/chain/vehicle-burn-finality';
import type {VehicleClientCurrentRpc} from '@shardkeep/chain/vehicle-client-current';
import {vehicleReference,type VehicleClient,type VehicleReference} from '@shardkeep/shared/vehicleClientApi';
import {createMiningTermFixture} from '../../../../packages/chain/src/testFixtures/miningZeroWinnerTerm';
import {vehicleBurnDatabase} from './vehicleBurn';
import {vehicleServiceAsset,vehicleServiceBuilding} from './vehicleService';
import {createVehicleClient} from '../../src/game/vehicleClient';
import {createAdvancedExpeditionWorkflow} from '../../src/game/advancedExpeditionWorkflow';
import {createAdvancedFleetView} from '../../src/game/advancedFleetView';
import {createVehicleBurnPreparations} from '../../src/game/vehicleBurnPreparations';
import {createVehicleServiceBurnPreparations} from '../../src/game/vehicleServiceBurnPreparations';
import {issueSessionJwt,SESSION_COOKIE,SESSION_TTL_SEC} from '../../src/auth/session';
import {sessions} from '../../src/db/schema';
import {TEST_CONFIG} from '../helpers';
const hash=(v:Uint8Array)=>createHash('sha256').update(v).digest('hex');
export async function vehicleClientPairFixture(options:{genesisHash?:string}={}){
 // Advance accepted trip durations inside historical time; SQL settlement rejects future cutoffs.
 let now=new Date(Math.floor(Date.now()/1000)*1000-3*24*60*60*1000);
 const completedAt=new Date(+now-60*60*1000);
 const f=await vehicleBurnDatabase(undefined,undefined,options,{completedAt}),berthId=await vehicleServiceBuilding(f,'berth',completedAt);await vehicleServiceBuilding(f,'lodge',completedAt);
 const initial=await vehicleServiceAsset(f,{family:'cargo_cutter'}),upgrade=await vehicleServiceAsset(f,{family:'cargo_cutter'}),restore=await vehicleServiceAsset(f,{family:'cargo_cutter',tier:2}),assets=[initial,upgrade,restore];
 for(const resource of ['rough_prism','heartwood_logs','crown_iron_ore'])await f.conn.sql`insert into resource_stocks(base_id,resource_id,available,reserved) values(${f.baseId},${resource},1000,0) on conflict do nothing`;
 let slot=100,online=true,paused=false;
 const bank=await createMiningTermFixture({day:now.toISOString().slice(0,10),genesisHash:Keypair.generate().publicKey,programId:Keypair.generate().publicKey});
 function time(at:Date){now=at;vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(now);bank.store.get(SYSVAR_CLOCK_PUBKEY.toBase58())!.data.writeBigInt64LE(BigInt(Math.floor(+now/1000)),32);}
 time(now);
 const [session]=await f.conn.db.insert(sessions).values({wallet:f.actor,expiresAt:new Date(+now+SESSION_TTL_SEC*1000)}).returning();
 const cookies={[SESSION_COOKIE]:await issueSessionJwt(TEST_CONFIG,f.actor,session!.id)},transactions=new Map<string,VersionedTransactionResponse>(),burned=new Set<string>(),sent:string[]=[];
 const ensure=()=>{if(!online)throw Error('Private fixture provider unavailable');};
 const rpc:VehicleBurnFinalityRpc={...f.rpc,getGenesisHash:async()=>{ensure();return f.trust.expectedGenesisHash;},getSlot:async()=>{ensure();return slot;},
  getMultipleAccountsInfoAndContext:async(keys,options)=>{ensure();const rows=await Promise.all(keys.map(async key=>{if(burned.has(key.toBase58()))return null;const source=assets.find(a=>a.identity.assetId===key.toBase58())?.rpc??f.rpc;return (await source.getMultipleAccountsInfoAndContext([key],options)).value[0]??null;}));return {context:{slot},value:rows};},
  getSignaturesForAddress:async address=>{ensure();return [...[...transactions.values()].filter(tx=>tx.transaction.message.staticAccountKeys.some(k=>k.equals(address))).sort((a,b)=>b.slot-a.slot).map(tx=>({signature:tx.transaction.signatures[0]!,slot:tx.slot,err:null,memo:null,blockTime:tx.blockTime??null,confirmationStatus:'finalized' as const})),{signature:bs58.encode(Buffer.alloc(64,1)),slot:90,err:null,memo:null,blockTime:null,confirmationStatus:'finalized' as const}];},
  getTransaction:async signature=>{ensure();return transactions.get(signature)??null;},getBlockSignatures:async requested=>{ensure();return {signatures:[...transactions.entries()].filter(([,tx])=>tx.slot===requested).map(([signature])=>signature)};}};
 const current:VehicleClientCurrentRpc={...rpc,getFeeForMessage:async()=>{ensure();return {context:{slot},value:5000};},getBalanceAndContext:async()=>{ensure();return {context:{slot},value:100000};},isBlockhashValid:async()=>{ensure();return {context:{slot},value:true};},getBlockHeight:async()=>{ensure();return 100;},
  getSignatureStatuses:async signatures=>{ensure();return {context:{slot},value:signatures.map(s=>{const tx=transactions.get(s);return tx?{slot:tx.slot,confirmations:null,err:null,confirmationStatus:'finalized' as const}:null;})};},
  sendRawTransaction:async(bytes,options)=>{ensure();expect(options).toEqual({skipPreflight:false,preflightCommitment:'finalized',maxRetries:0,minContextSlot:slot});const signature=bs58.encode(bytes.subarray(1,65));sent.push(Buffer.from(bytes).toString('hex'));return signature;}};
 const deps={connect:()=>rpc,trust:f.trust,getBlockhash:async()=>({blockhash:Keypair.generate().publicKey.toBase58(),contextSlot:slot,lastValidBlockHeight:1000})},term={connect:bank.connect,policy:bank.policy};
 const client=()=>createVehicleClient(f.conn.db,{...online?{installation:deps,service:deps,current:{connect:()=>current,trust:f.trust}}:{},expeditions:{term}});
 const expeditions=()=>createAdvancedExpeditionWorkflow(f.conn.db,{...online?{term}:{}});
 const initialPreparations=createVehicleBurnPreparations(f.conn.db),servicePreparations=createVehicleServiceBurnPreparations(f.conn.db);
 async function sign(client:VehicleClient){const saved=await createVehicleClient(f.conn.db).read(f.actor,vehicleReference(client));expect(saved.record.preparation).toEqual(client.record.preparation);const p=saved.record.preparation!;
  const tx=new VersionedTransaction(Message.from(Buffer.from(p.messageHex,'hex')));tx.sign([f.wallet]);const bytes=tx.serialize();return {signedTransactionHex:Buffer.from(bytes).toString('hex'),signature:bs58.encode(tx.signatures[0]!),wireSha256:hash(bytes),messageSha256:p.messageSha256};}
 async function finalize(reference:VehicleReference){const saved=await client().read(f.actor,reference),wire=await sign(saved),p=reference.kind==='installation'?await initialPreparations.get(f.actor,reference.id):await servicePreparations.get(f.actor,reference.id);if(!p)throw Error('No private original preparation');
  expect(sent).toContain(wire.signedTransactionHex);const tx=VersionedTransaction.deserialize(Buffer.from(wire.signedTransactionHex,'hex')),message=tx.message;expect(message.version).toBe('legacy');const keys=message.staticAccountKeys,pre=keys.map(()=>10000000),post=[...pre],asset=keys.findIndex(k=>k.toBase58()===p.plan.identity.assetId);post[0]!+=995000;post[asset]!-=1000000;
  slot+=10;const transaction:VersionedTransactionResponse={slot,blockTime:Math.floor(+now/1000),version:'legacy',transaction:{message,signatures:[wire.signature]},meta:{err:null,fee:5000,preBalances:pre,postBalances:post,innerInstructions:[],loadedAddresses:{readonly:[],writable:[]}}};transactions.set(wire.signature,transaction);burned.add(p.plan.identity.assetId);slot+=10;return {observed:true,signature:wire.signature};}
 async function finishExpedition(id:string){const saved=await expeditions().read(f.actor,id);if(!saved.receipt)throw Error('Unknown original expedition');time(new Date(saved.receipt.returnsAt));return {advancedTo:now.toISOString()};}
 async function exhaust(installationId:string){const api=expeditions();for(;;){const fleet=await createAdvancedFleetView(f.conn.db).read(f.actor,f.baseId),vehicle=fleet.vehicles.find(v=>v.installationId===installationId);if(!vehicle)throw Error('Missing actual installation');if(vehicle.remainingUses===0)break;const original=await api.dispatch(f.actor,{baseId:f.baseId,installationId,routeId:'coastal_survey',policyVersion:PHASE_E_ADVANCED_EXPEDITIONS.currentPolicyVersion,idempotencyKey:randomUUID()});await finishExpedition(original.idempotencyKey);await api.collect(f.actor,f.baseId);}return {exhausted:true};}
 async function live(method:string,params:unknown[]){ensure();let result:unknown;const context=(value:unknown)=>({context:{slot},value});switch(method){
  case'getGenesisHash':result=await rpc.getGenesisHash();break;case'getSlot':result=slot;break;
  case'getLatestBlockhash':{const b=await deps.getBlockhash();result={context:{slot:b.contextSlot},value:{blockhash:b.blockhash,lastValidBlockHeight:b.lastValidBlockHeight}};break;}
  case'getSignaturesForAddress':result=await rpc.getSignaturesForAddress(new PublicKey(params[0] as string),params[1] as never,'finalized');break;
  case'getBlock':result={...await rpc.getBlockSignatures(Number(params[0]),'finalized'),parentSlot:Number(params[0])-1,blockTime:null,blockhash:f.identity.assetId,previousBlockhash:f.identity.collection};break;
  case'getTransaction':{const tx=await rpc.getTransaction(params[0] as string,{commitment:'finalized',maxSupportedTransactionVersion:0});if(!tx){result=null;break;}const m=tx.transaction.message;result={...tx,transaction:{signatures:tx.transaction.signatures,message:{header:m.header,accountKeys:m.staticAccountKeys.map(k=>k.toBase58()),recentBlockhash:m.recentBlockhash,instructions:m.compiledInstructions.map(ix=>({programIdIndex:ix.programIdIndex,accounts:ix.accountKeyIndexes,data:bs58.encode(ix.data)}))}}};break;}
  case'sendTransaction':{const {encoding,...settings}=params[1] as Record<string,unknown>;expect(encoding).toBe('base64');result=await current.sendRawTransaction(Buffer.from(params[0] as string,'base64'),{skipPreflight:false,...settings} as Parameters<typeof current.sendRawTransaction>[1]);break;}
  case'getMultipleAccounts':{const keys=(params[0] as string[]).map(k=>new PublicKey(k)),response=await rpc.getMultipleAccountsInfoAndContext(keys,{commitment:'finalized',minContextSlot:slot});result={context:response.context,value:response.value.map(a=>a?{owner:a.owner.toBase58(),executable:a.executable,data:[Buffer.from(a.data).toString('base64'),'base64'],lamports:10000000,rentEpoch:0,space:a.data.length}:null)};break;}
  case'getBlockHeight':result=100;break;case'isBlockhashValid':result=context(true);break;case'getFeeForMessage':result=context(5000);break;case'getBalance':result=context(100000);break;case'getSignatureStatuses':result=await current.getSignatureStatuses(params[0] as string[],{searchTransactionHistory:true});break;default:throw Error('Unsupported private RPC method');}
  return {jsonrpc:'2.0',id:1,result};}
 function state(next:{paused:boolean;providerless?:boolean}){paused=next.paused;online=!next.providerless;for(const flag of ['MULTI_BASE_ENABLED','PHASE_E_BUILDINGS_ENABLED'])vi.stubEnv(flag,'true');vi.stubEnv('PHASE_E_VEHICLES_ENABLED',paused?'false':'true');}
 state({paused:false});
 return {f,cookies,client,expeditions,live,sign,finalize,finishExpedition,exhaust,state,sent,advanceTo:time,termProvider:()=>online?term:null,config:{wallet:f.actor,baseId:f.baseId,berthId,initialAssetId:initial.identity.assetId,upgradeAssetId:upgrade.identity.assetId,restoreAssetId:restore.identity.assetId,routeId:'coastal_survey',trust:{version:1,revision:'D182-private-pair',core:f.trust,operationalPolicyVersion:1},policy:{client:PHASE_E_VEHICLE_CLIENT,vehicles:PHASE_E_VEHICLES,advanced:PHASE_E_ADVANCED_EXPEDITIONS,paidRoutes:PHASE_E_PAID_STARTER_ROUTES}},
  providers:()=>({vehicleClientProvider:client(),advancedExpeditionWorkflowProvider:expeditions(),advancedFleetViewProvider:createAdvancedFleetView(f.conn.db)}),dispose:async()=>{vi.useRealTimers();await f.dispose();}};
}
export type VehicleClientPairFixture=Awaited<ReturnType<typeof vehicleClientPairFixture>>;
