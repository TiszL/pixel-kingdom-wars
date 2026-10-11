/** Actual earned leaves -> committed private material original -> local SBF paid
 * win/loss -> delayed Core mint/acquisition/burn/install. Synthetic VRF only. */
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {Message,VersionedTransaction,PublicKey,type AccountInfo} from '@solana/web3.js';
import {expect,vi} from 'vitest';
import {createVehicleIssuanceTerminalReader,type VehicleIssuanceEvidenceRpc} from '@shardkeep/chain/vehicle-issuance-terminal';
import {createVehicleIssuanceEvidenceReader} from '@shardkeep/chain/vehicle-issuance-evidence';
import {makeVehicleBurnFinalityRpc} from '@shardkeep/chain/vehicle-burn-finality';
import {vehicleClientCurrentRpcConnection} from '@shardkeep/chain/vehicle-client-current';
import {runVehicleIssuanceProgram,type VehicleLocalMint,type VehicleLocalRequest,type VehicleLocalSubmitted} from '../../../../programs/vehicle-local-issuance';
import {createVehicleCraftMaterials,type VehicleCraftMaterialRecord} from '../../src/game/vehicleCraftMaterials';
import {createVehicleIssuanceAcquisitions} from '../../src/game/vehicleIssuanceAcquisitions';
import {createVehicleClient} from '../../src/game/vehicleClient';
import {withVehicleMaterialEarnedSource} from './vehicleMaterialEarnedSource';
const requireChain=createRequire(new URL('../../../../packages/chain/package.json',import.meta.url));
const ChainPublicKey=(requireChain('@solana/web3.js') as {PublicKey:typeof PublicKey}).PublicKey;
const bs58=(requireChain('bs58') as {default:{encode:(v:Uint8Array)=>string}}).default;
const sleep=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
function need(v:unknown,why:string):asserts v{if(!v)throw Error(why);}
function connect(chain:VehicleLocalMint['chain']):()=>VehicleIssuanceEvidenceRpc{return ()=>({getGenesisHash:()=>chain.connection.getGenesisHash(),getSlot:c=>chain.connection.getSlot(c),getMultipleAccountsInfoAndContext:async(addresses,options)=>{
 const r=await chain.connection.getMultipleAccountsInfoAndContext(addresses.map(a=>new PublicKey(a.toBytes())),options);return {context:r.context,value:r.value.map((a:AccountInfo<Buffer>|null,i:number)=>a===null?null:{address:addresses[i]!,owner:new ChainPublicKey(a.owner.toBytes()),executable:a.executable,data:Buffer.from(a.data)})};
}});}
type EarnedSource=Parameters<Parameters<typeof withVehicleMaterialEarnedSource>[0]>[0];
export interface VehicleMaterialCoreHooks {
 before?: (source:EarnedSource)=>Promise<void>;
 submitRequest?: (input:VehicleLocalRequest & {source:EarnedSource;saved:VehicleCraftMaterialRecord})=>Promise<VehicleLocalSubmitted>;
 onPaidResult?: (input:VehicleLocalMint & {source:EarnedSource;saved:VehicleCraftMaterialRecord})=>Promise<void>;
}
export async function actualVehicleMaterialCore(hooks:VehicleMaterialCoreHooks={}){
 await withVehicleMaterialEarnedSource(async source=>{
  vi.useRealTimers();for(const flag of ['MULTI_BASE_ENABLED','PHASE_E_BUILDINGS_ENABLED','PHASE_E_VEHICLES_ENABLED'])vi.stubEnv(flag,'true');
  const {db,conn,seller}=source,storage=createVehicleIssuanceAcquisitions(db),reservations=new Map<string,VehicleCraftMaterialRecord>(),terminals:VehicleCraftMaterialRecord[]=[];
  await hooks.before?.(source);
  const before=await conn.sql`select item_id,available::text from crafting_stocks where base_id=${seller.baseId} order by item_id`;
  const fragmentBefore=await conn.sql`select available::text from crystal_fragment_stocks where base_id=${seller.baseId}`;
  await runVehicleIssuanceProgram({payer:seller.signer,...(hooks.submitRequest?{submitRequest:async(input:VehicleLocalRequest)=>{const saved=reservations.get(input.original.rootId);need(saved,'No committed request original');return hooks.submitRequest!({...input,source,saved});}}:{}),prepareOriginal:async({original})=>{
   await source.refresh();const materials=createVehicleCraftMaterials(db,{loadTemplate:async()=>original});
   const request={idempotencyKey:randomUUID(),baseId:seller.baseId,family:'survey_balloon',tier:1,recipeVersion:1};
   const saved=await materials.reserve(seller.wallet,request,seller.authority);expect(saved.status).toBe('held');
   expect(saved.original.terms.oddsBps).toBe(saved.recipe.oddsBps);expect(saved.original.terms.materialHash).toBe(saved.materialHash);
   expect(await storage.loadOriginal(saved.original.rootId)).toEqual(saved.original);
   expect(await materials.reserve(seller.wallet,request,seller.authority)).toEqual(saved);
   await expect(materials.settle(seller.wallet,request.idempotencyKey)).rejects.toMatchObject({code:'VEHICLE_MATERIAL_HELD'});
   expect(await materials.read(seller.wallet,request.idempotencyKey)).toEqual(saved);
   reservations.set(saved.original.rootId,saved);return saved.original;
  },onPaidResult:async({chain,original,trust})=>{
   const saved=reservations.get(original.rootId)!;need(saved,'No committed material original');
   const reader=createVehicleIssuanceTerminalReader(connect(chain),trust,storage.loadOriginal),proof=await reader(original.rootId);
   expect(proof).toMatchObject({paid:true,minted:false,mintSlot:0,finalizedNormalResultObserved:true,finalizedMintObserved:false});
   expect(proof.outcome).toBe(terminals.length===0?'won':'lost');
   const materials=createVehicleCraftMaterials(db,{readFinalizedResult:reader});
   const settled=await materials.settle(seller.wallet,saved.request.idempotencyKey);expect(settled.status).toBe('consumed');
   expect(settled.terminal!.proof).toMatchObject({rootId:proof.rootId,originalHash:proof.originalHash,outcome:proof.outcome,randomness:proof.randomness,minted:false});terminals.push(settled);
   vi.stubEnv('PHASE_E_VEHICLES_ENABLED','false');
   expect(await createVehicleCraftMaterials(db).settle(seller.wallet,saved.request.idempotencyKey)).toEqual(settled);
   vi.stubEnv('PHASE_E_VEHICLES_ENABLED','true');
   await hooks.onPaidResult?.({chain,original,trust,source,saved});
   chain.record(`actual paid ${proof.outcome} consumes original earned materials once; providerless paused replay`);
  },onMinted:async({chain,original,trust})=>{
   expect(terminals).toHaveLength(3);expect(terminals.filter(r=>r.terminal?.proof.outcome==='won')).toHaveLength(1);
   const {connection,payer}=chain,actor=payer.publicKey.toBase58(),readFinalized=createVehicleIssuanceEvidenceReader(connect(chain),trust,storage.loadOriginal);
   const acquisition=await createVehicleIssuanceAcquisitions(db,{readFinalized}).acquire(original.rootId);
   expect(acquisition.buyer).toBe(actor);
   // The paid unminted receipt remains immutable when minting later succeeds.
   const saved=reservations.get(original.rootId)!;expect(await createVehicleCraftMaterials(db).settle(actor,saved.request.idempotencyKey)).toEqual(terminals[0]);
   expect(await conn.sql`select count(*)::int n from vehicle_craft_material_reservations`).toEqual([{n:3}]);
   expect(await conn.sql`select count(*)::int n from vehicle_craft_material_terminals`).toEqual([{n:3}]);
   const after=await conn.sql`select item_id,available::text from crafting_stocks where base_id=${seller.baseId} order by item_id`;
   for(const row of before){const consumed=saved.recipe.inputs.find(l=>l.kind==='refined'&&l.itemId===row.item_id);expect(BigInt(after.find(a=>a.item_id===row.item_id)!.available)).toBe(BigInt(row.available)-(consumed?BigInt(consumed.quantity)*3n:0n));}
   expect(await conn.sql`select available::text from crystal_fragment_stocks where base_id=${seller.baseId}`).toEqual([{available:(BigInt(fragmentBefore[0]!.available)-6n).toString()}]);
   const berthId=randomUUID(),jobId=randomUUID();
   await conn.sql`insert into buildings(id,player_wallet,base_id,type,tx,ty) values(${berthId},${actor},${seller.baseId},'berth',20,2)`;
   await conn.sql`insert into builder_jobs(id,player_wallet,base_id,building_id,kind,started_at,finishes_at,completed_at) values(${jobId},${actor},${seller.baseId},${berthId},'build',now()-interval '2 hours',now()-interval '1 hour',now()-interval '1 hour')`;
   const coreTrust={expectedGenesisHash:trust.expectedGenesisHash,reviewedDeploymentSlot:trust.core.reviewedDeploymentSlot,reviewedProgramDataSha256:trust.core.reviewedProgramDataSha256,upgradeAuthority:trust.core.upgradeAuthority};
   const installation={connect:(signal:AbortSignal)=>makeVehicleBurnFinalityRpc(connection.rpcEndpoint,signal),trust:coreTrust,getBlockhash:async()=>{const r=await connection.getLatestBlockhashAndContext('finalized');return {...r.value,contextSlot:r.context.slot};}};
   const client=createVehicleClient(db,{installation,current:{connect:vehicleClientCurrentRpcConnection(connection.rpcEndpoint),trust:coreTrust}});
   await source.refresh();const reservation=await client.reserve(actor,'installation',{baseId:seller.baseId,berthId,assetId:original.identity.assetId,idempotencyKey:randomUUID()});need(reservation.kind==='installation','Wrong installation kind');
   const installationId=reservation.record.reservation.reservationId,ref={kind:'installation' as const,id:installationId};
   const prepared=await client.prepare(actor,ref);expect(await client.review(actor,ref)).toMatchObject({status:'ready'});const p=prepared.record.preparation!;
   const tx=new VersionedTransaction(Message.from(Buffer.from(p.messageHex,'hex')));tx.sign([payer]);const signature=bs58.encode(tx.signatures[0]!);
   await client.retainSigned(actor,ref,tx.serialize());expect(await client.deliver(actor,ref)).toMatchObject({status:'submitted',signature});
   await connection.confirmTransaction({signature,blockhash:p.blockhash,lastValidBlockHeight:p.lastValidBlockHeight},'finalized');
   const burn=await connection.getTransaction(signature,{commitment:'finalized',maxSupportedTransactionVersion:0});need(burn&&burn.meta?.err===null,'Original burn did not finalize');
   const deadline=Date.now()+30000;while(await connection.getSlot('finalized')<=burn.slot&&Date.now()<deadline)await sleep(100);need(await connection.getSlot('finalized')>burn.slot,'No closing burn bank');
   const result=await client.recover(actor,ref);expect(result).toMatchObject({record:{status:'installed',installation:{installationId,baseId:seller.baseId,berthId}},burnReceipt:{signature,slot:burn.slot}});
   expect(await storage.acquire(original.rootId)).toEqual(acquisition);expect(await createVehicleCraftMaterials(db).read(actor,saved.request.idempotencyKey)).toEqual(terminals[0]);
   await writeFile(join(chain.working,'vehicle-material-core-proof.json'),JSON.stringify({scope:'actual earned new-base goods, original material custody, local SBF paid win/loss, Core burn/install; synthetic VRF and prerequisite deed/term banks',reservations:[...reservations.values()],terminals,before,after,fragmentBefore,acquisition,burn:{signature,slot:burn.slot},installation:result},null,2));
   chain.record('earned leaf inputs -> committed original -> paid won-unminted entitlement -> original Core mint/acquisition -> installed; both normal losses consumed exactly once');
  }});
 });
}
