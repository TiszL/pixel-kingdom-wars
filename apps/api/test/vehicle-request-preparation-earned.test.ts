/** Genuine played/earned D211 material -> actual private issuer/SQL/wallet path.
 * Finalized chain observations are explicit serialized fixtures, never live
 * supplier/payment/SBF evidence. No request is sent to a chain. */
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Message,PublicKey,SystemProgram,VersionedTransaction} from '@solana/web3.js';
import {eq,sql} from 'drizzle-orm';
import {expect,it,vi} from 'vitest';
import {normalizeVehicleIssuanceOriginal} from '@shardkeep/chain/vehicle-issuance-evidence';
import {createVehicleIssuanceQuoteReader,type VehicleIssuanceQuoteRpc} from '@shardkeep/chain/vehicle-issuance-quote';
import {createVehicleIssuanceTerminalReader} from '@shardkeep/chain/vehicle-issuance-terminal';
import {VEHICLE_CRAFT_PROGRAM,vehicleTermsHash,vehicleTermsBytes,vehicleVrfRequest,vehicleKeccak} from '@shardkeep/chain/vehicle-issuance-protocol';
import {vehicleIssuanceFixture} from '../../../packages/chain/src/testFixtures/vehicleIssuance';
import {vehicleIssuanceTerminalFixture} from '../../../packages/chain/src/testFixtures/vehicleIssuanceTerminal';
import {bases} from '../src/db/schema';
import {createVehicleCraftMaterials,type VehicleCraftMaterialRecord} from '../src/game/vehicleCraftMaterials';
import {createVehicleCraftPreparation} from '../src/game/vehicleCraftPreparation';
import {createVehicleCraftSignedStore} from '../src/game/vehicleCraftSignedStore';
import {createVehiclePolicyIssuer} from '../src/vehiclePolicyIssuer';
import {VEHICLE_ISSUER_PURPOSE,initializeVehicleIssuerJournal} from '../src/vehiclePolicyIssuerJournal';
import {signVehiclePolicy,vehiclePolicyBank} from './fixtures/vehiclePolicyIssuer';
import {withVehicleMaterialEarnedSource} from './fixtures/vehicleMaterialEarnedSource';
import {resealVehicleRequestFixture} from './fixtures/vehicleCraftPreparation';
import {SEAL_BOUND_EARNED_VEHICLE_CASE_MS} from './sealLatencyBudgets';

async function terminal(saved:VehicleCraftMaterialRecord,now:bigint){
 const o=saved.original,b=vehicleIssuanceTerminalFixture('lost',{rootId:o.rootId,oddsBps:o.terms.oddsBps}),terms=vehicleTermsHash(o),buyer=new PublicKey(o.buyer).toBuffer();
 buyer.copy(b.rows[7]!.data,41);buyer.copy(b.rows[8]!.data,73);buyer.copy(b.rows[9]!.data,25);
 vehicleTermsBytes(o.terms).copy(b.rows[8]!.data,185);Buffer.from(terms,'hex').copy(b.rows[7]!.data,137);Buffer.from(terms,'hex').copy(b.rows[8]!.data,393);Buffer.from(terms,'hex').copy(b.rows[9]!.data,121);vehicleKeccak(vehicleVrfRequest(o.rootId,o.attemptId,terms)).copy(b.rows[8]!.data,425);
 const attempt=b.rows[8]!.data as Buffer,permit=b.rows[9]!.data as Buffer,clock=b.rows[11]!.data as Buffer;
 attempt.writeBigInt64LE(now+1n,516);attempt.writeBigUInt64LE(21n,524);attempt.writeBigUInt64LE(22n,532);attempt.writeBigUInt64LE(23n,540);
 permit.writeBigInt64LE(BigInt(o.permitExpiry),153);permit.writeBigInt64LE(now+1n,161);clock.writeBigUInt64LE(24n);clock.writeBigInt64LE(now+2n,32);
 const rpc={...b.rpc,getSlot:async()=>24,getMultipleAccountsInfoAndContext:async(addresses:PublicKey[])=>({context:{slot:24},value:addresses.map(a=>b.rows.find(r=>r.address.equals(a))??null)})};
 return createVehicleIssuanceTerminalReader(()=>rpc,b.trust,async()=>o)(o.rootId);
}

it('retains one genuine-material request and wallet wire through quote failure, pause, transfer and paid loss',()=>withVehicleMaterialEarnedSource(async source=>{
 vi.stubEnv('PHASE_E_VEHICLES_ENABLED','true');
 await resealVehicleRequestFixture(source.conn);
 const directory=await mkdtemp(path.join(tmpdir(),'vehicle-request-earned-')),bank=vehiclePolicyBank(),now=BigInt(Math.floor(Date.now()/1000)),{originalHash:_ignored,...template}=vehicleIssuanceFixture(randomBytes(16).toString('hex')).original;
 (bank.rows[8]!.data as Buffer).writeBigInt64LE(now,32);
 const material=createVehicleCraftMaterials(source.db,{loadTemplate:async()=>normalizeVehicleIssuanceOriginal({...template,buyer:source.seller.wallet,permitExpiry:String(now+60n)})});
 await source.refresh();const held=await material.reserve(source.seller.wallet,{idempotencyKey:randomUUID(),baseId:source.seller.baseId,family:source.recipe.family,tier:source.recipe.tier,recipeVersion:source.recipe.recipeVersion},source.seller.authority),stock=await source.stock(),request={wallet:held.actorWallet,idempotencyKey:held.request.idempotencyKey};
 const journalFile=path.join(directory,'issuer.jsonl');await initializeVehicleIssuerJournal(journalFile,{purpose:VEHICLE_ISSUER_PURPOSE,genesisHash:bank.trust.expectedGenesisHash,craftProgram:VEHICLE_CRAFT_PROGRAM});
 const signer=vi.fn((message:Uint8Array)=>signVehiclePolicy(bank.policy,message)),issuer=await createVehiclePolicyIssuer({journalFile,trust:bank.trust,connect:()=>bank.rpc,material,signer:{publicKey:bank.policyAuthority,sign:signer}});
 try{
  let refuseFee=true,offline=false;const feeMessages:string[]=[],blockhash=new PublicKey(Buffer.alloc(32,21)).toBase58();
  const rpc:VehicleIssuanceQuoteRpc={getGenesisHash:async()=>{if(offline)throw Error('explicit fixture outage');return bank.trust.expectedGenesisHash;},getSlot:async()=>20,
   getMultipleAccountsInfoAndContext:async addresses=>({context:{slot:20},value:addresses.map(address=>{
    if(address.toBase58()===source.seller.wallet)return {address,owner:SystemProgram.programId,executable:false,data:Buffer.alloc(0),lamports:2_000_000_000};
    const row=bank.rows.find(value=>value.address.equals(address));return row?{...row,lamports:1_000_000_000}:null;
   })}),getLatestBlockhashAndContext:async()=>({context:{slot:20},value:{blockhash,lastValidBlockHeight:100}}),
   getFeeForMessage:async message=>{feeMessages.push(Buffer.from(message.serialize()).toString('hex'));return {context:{slot:20},value:refuseFee?null:10_000};},getBlockHeight:async()=>50};
  const quote=createVehicleIssuanceQuoteReader(()=>rpc,bank.trust,bank.policyAuthority,{costLimits:{maxNetworkFeeLamports:'100000',maxInitializationRentLamports:'100000000',maxRequiredLamports:'1000000000'}}),dispatch=vi.fn(issuer.issueOnce),lookup=vi.fn(issuer.lookup);
  const configured={enabled:()=>true,issuer:{publicKey:bank.policyAuthority,issueOnce:dispatch,lookup},quote};
  const first=createVehicleCraftPreparation(source.db,configured);
  const firstFailure=await first.prepare(request,new AbortController().signal).then(()=>null,(error:unknown)=>error);
  const diagnostic=firstFailure as {name?:string;code?:string;message?:string;cause?:{code?:string;message?:string}};
  expect({name:diagnostic?.name,code:diagnostic?.code,causeCode:diagnostic?.cause?.code,causeMessage:diagnostic?.cause?.message}).toEqual({name:'VehicleIssuanceQuoteError',code:'COST',causeCode:undefined,causeMessage:undefined});
  expect(signer).toHaveBeenCalledTimes(1);expect(dispatch).toHaveBeenCalledTimes(1);expect((await first.get(request))?.preparation).toBeNull();expect(await source.stock()).toEqual(stock);
  refuseFee=false;const service=createVehicleCraftPreparation(source.db,configured),saved=await service.prepare(request,new AbortController().signal);
  expect(saved.preparation).not.toBeNull();expect(signer).toHaveBeenCalledTimes(1);expect(dispatch).toHaveBeenCalledTimes(1);expect(lookup).toHaveBeenCalledTimes(1);
  const prepared=saved.preparation!;expect(prepared.issuerReceipt.original).toEqual(held.original);expect(prepared.quote.messageHex).toBe(feeMessages.at(-1));expect(prepared.quote.costs.networkFeeLamports).toBe('10000');expect(saved.signingAuthorized).toBe(false);
  const tx=new VersionedTransaction(Message.from(Buffer.from(prepared.quote.messageHex,'hex')));tx.sign([source.seller.signer]);const wire=tx.serialize(),bad=Uint8Array.from(wire);bad[1]=bad[1]!^1;
  const store=createVehicleCraftSignedStore(source.db);await expect(store.accept(request,bad)).rejects.toThrow();expect(await store.get(request)).toBeNull();
  const [one,two]=await Promise.all([store.accept(request,wire),store.accept(request,wire)]);expect(one).toEqual(two);expect(one.messageSha256).toBe(prepared.quote.messageSha256);expect(one.broadcastAuthorized).toBe(false);
  expect(await source.db.execute(sql`select reservation_id from public.vehicle_request_signed_wires where reservation_id=${held.id}::uuid`)).toHaveLength(1);
  offline=true;(bank.rows[6]!.data as Buffer)[177]=1;vi.stubEnv('PHASE_E_VEHICLES_ENABLED','false');
  await source.db.update(bases).set({ownerWallet:source.fragmentSource.f.buyer}).where(eq(bases.id,source.seller.baseId));
  const recovery=createVehicleCraftPreparation(source.db);expect(await recovery.get(request)).toEqual(saved);expect(await recovery.prepare(request,new AbortController().signal)).toEqual(saved);
  expect(await createVehicleCraftSignedStore(source.db).get(request)).toEqual(one);
  const proof=await terminal(held,now),consumed=await createVehicleCraftMaterials(source.db,{readFinalizedResult:async()=>proof}).settle(request.wallet,request.idempotencyKey);
  expect(consumed.status).toBe('consumed');expect(consumed.terminal?.proof.outcome).toBe('lost');expect(await recovery.get(request)).toEqual(saved);expect(await createVehicleCraftSignedStore(source.db).accept(request,wire)).toEqual(one);
  expect(await source.stock()).toEqual(stock);expect(signer).toHaveBeenCalledTimes(1);expect(dispatch).toHaveBeenCalledTimes(1);
 }finally{await issuer.close();await rm(directory,{recursive:true,force:true});vi.unstubAllEnvs();}
}),SEAL_BOUND_EARNED_VEHICLE_CASE_MS);
