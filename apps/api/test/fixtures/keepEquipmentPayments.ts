/** Raw RPC fixtures only: preparation, wire verification and payment finality
 * all run through the real private chain readers. These are simulated execution
 * observations; the separate local-validator fixture verifies actual SPL CPI. */
import {randomUUID} from 'node:crypto';
import {Keypair,Message,MessageV0,PublicKey,SystemProgram,TransactionInstruction,VersionedTransaction,type VersionedTransactionResponse} from '@solana/web3.js';
import bs58 from 'bs58';
import {expect} from 'vitest';
import {PHASE_E_KEEP_EQUIPMENT_MARKET,PHASE_E_POLICY,TOKEN} from '@shardkeep/shared';
import type {KeepEquipmentMarketItem} from '@shardkeep/shared/keepEquipmentMarketApi';
import type {KeepEquipmentPaymentPreparationRpc,KeepEquipmentPreparationAccount,KeepEquipmentPaymentPreparationTrust} from '@shardkeep/chain/keep-equipment-payment-preparation';
import type {KeepEquipmentPaymentRpc} from '@shardkeep/chain/keep-equipment-payment';
import {assertFreshLockedBaseAuthority,refreshBaseOwnership} from '../../src/game/baseOwnership';
import type {StableBaseMutationContext} from '../../src/game/stableBasePrerequisites';
import {createKeepEquipmentListing,reserveKeepEquipmentFill} from '../../src/game/keepEquipmentMarket';
import {createKeepEquipmentPayments,type KeepEquipmentSavedPreparation} from '../../src/game/keepEquipmentPayments';
import type {connectTestDb} from '../helpers';

type Connection=ReturnType<typeof connectTestDb>;
export const tokenProgram=new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const associatedProgram=new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const key=()=>Keypair.generate().publicKey.toBase58();
const ata=(mint:PublicKey,wallet:PublicKey)=>PublicKey.findProgramAddressSync([wallet.toBuffer(),tokenProgram.toBuffer(),mint.toBuffer()],associatedProgram)[0];
export const sellerShare=(total:bigint)=>total*BigInt(PHASE_E_POLICY.taxes.keepMarket.sellerBps)/BigInt(PHASE_E_POLICY.basisPoints);
export const fixtureRent=2_039_280,fixtureFee=5_000,fixtureKeep=20_000_000n;

async function base(conn:Connection,available:string){
 const signer=Keypair.generate(),wallet=signer.publicKey.toBase58(),baseId=randomUUID(),deed=key(),collection=key(),now=new Date('2035-01-01T01:00:00Z');
 await conn.sql`insert into players(wallet) values(${wallet})`;
 await conn.sql`insert into bases(id,owner_wallet,deed_asset_id,land_paid_at) values(${baseId},${wallet},${deed},${now.toISOString()})`;
 await conn.sql`insert into base_slots(wallet,slot,base_id) values(${wallet},1,${baseId})`;
 expect(await refreshBaseOwnership(conn.db,baseId,async()=>({owner:wallet,collection,frozen:false,delegate:null,slot:100}),collection,now,'keep-payment-test',()=>now)).toBe('owned');
 const authority:StableBaseMutationContext={baseId,assertAuthority:async(tx,actor,id)=>{await assertFreshLockedBaseAuthority(tx,actor,id,now);}};
 await conn.sql`insert into ordinary_equipment_stocks(base_id,item_id,available) values(${baseId},'route_compass',${available}::bigint)`;
 return {signer,wallet,baseId,deed,collection,now,authority};
}
type PaymentFixtureActor=Omit<Awaited<ReturnType<typeof base>>,'baseId'>&{baseId:string};
export async function transferPaymentBase(conn:Connection,f:PaymentFixtureActor){
 const wallet=key();await conn.sql`insert into players(wallet) values(${wallet})`;
 expect(await refreshBaseOwnership(conn.db,f.baseId,async()=>({owner:wallet,collection:f.collection,frozen:false,delegate:null,slot:200}),f.collection,f.now,'keep-payment-transfer',()=>f.now)).toBe('mismatch');
 await conn.sql`update bases set status='active' where id=${f.baseId}`;
 await conn.sql`insert into base_slots(wallet,slot,base_id) values(${wallet},1,${f.baseId})`;
 expect(await refreshBaseOwnership(conn.db,f.baseId,async()=>({owner:wallet,collection:f.collection,frozen:false,delegate:null,slot:201}),f.collection,f.now,'keep-payment-new-owner',()=>f.now)).toBe('owned');
 return wallet;
}
export interface PaymentFixtureSource {
 actors:{seller:PaymentFixtureActor;buyer:PaymentFixtureActor};
 itemId:KeepEquipmentMarketItem;listingQuantity:string;fillQuantity:string;
}
export async function paymentFixture(conn:Connection,version:'legacy'|0='legacy',missingAta=false,source?:PaymentFixtureSource){
 const seller=source?.actors.seller??await base(conn,'10'),buyer=source?.actors.buyer??await base(conn,'0'),mint=Keypair.generate().publicKey,genesis=key(),blockhash=key();
 const marketDeps={clock:()=>buyer.now,assertAdmission:()=>undefined};
 const listing=await createKeepEquipmentListing(conn.db,seller.wallet,{idempotencyKey:randomUUID(),baseId:seller.baseId,itemId:source?.itemId??'route_compass',quantity:source?.listingQuantity??'10',unitPriceBaseUnits:(PHASE_E_KEEP_EQUIPMENT_MARKET.minFillBaseUnits+1n).toString()},seller.authority,marketDeps);
 const fill=await reserveKeepEquipmentFill(conn.db,buyer.wallet,{idempotencyKey:randomUUID(),listingId:listing.id,buyerBaseId:buyer.baseId,quantity:source?.fillQuantity??'2'},{buyer:buyer.authority,seller:seller.authority},marketDeps);
 const trust:KeepEquipmentPaymentPreparationTrust={expectedGenesisHash:genesis,expectedKeepMint:mint.toBase58(),providerIds:['payment-test-private-one','payment-test-private-two'],minContextSlot:90,deadlineMs:500,transactionVersion:version,maxFeeLamports:100_000n,maxPriorityFeeLamports:0n,maxComputeUnitLimit:300_000};
 // Classic SPL byte layouts are protocol fixtures, not gameplay numbers.
 const mintData=Buffer.alloc(82);mintData.writeBigUInt64LE(fixtureKeep+5n,36);mintData[44]=TOKEN.decimals;mintData[45]=1;
 const token=(wallet:PublicKey,amount:bigint):KeepEquipmentPreparationAccount=>{const data=Buffer.alloc(165);mint.toBuffer().copy(data);wallet.toBuffer().copy(data,32);data.writeBigUInt64LE(amount,64);data[108]=1;return {owner:tokenProgram,lamports:fixtureRent,executable:false,data};};
 const rows:Array<KeepEquipmentPreparationAccount|null>=[{owner:tokenProgram,data:mintData,lamports:1_461_600,executable:false},token(buyer.signer.publicKey,fixtureKeep),missingAta?null:token(seller.signer.publicKey,5n),{owner:SystemProgram.programId,data:Buffer.alloc(0),lamports:100_000_000,executable:false}];
 const expectedKeys=[mint,ata(mint,buyer.signer.publicKey),ata(mint,seller.signer.publicKey),buyer.signer.publicKey].map(k=>k.toBase58());
 const controls={paused:false,preparationCalls:0,finalityCalls:0,latestCalls:0,feeMessages:[] as string[],validityHashes:[] as string[],height:200,fee:fixtureFee,rent:fixtureRent,blockhashValid:true,wire:null as Uint8Array|null,preparation:null as KeepEquipmentSavedPreparation|null,
  preparationMode:'ok' as 'ok'|'missing'|'disagree'|'fail',finalityMode:'ok' as 'ok'|'missing'|'disagree'|'failed'|'throw'|'genesis'|'unfinalized',signals:[] as AbortSignal[]};
 const preparationConnect=[0,1].map(peer=>(signal:AbortSignal):KeepEquipmentPaymentPreparationRpc=>{
  controls.signals.push(signal);return {
   getGenesisHash:async()=>genesis,getSlot:async()=>100,
   getMultipleAccountsInfoAndContext:async(keys,options)=>{controls.preparationCalls++;expect(options.commitment).toBe('finalized');expect(keys.map(k=>k.toBase58())).toEqual(expectedKeys);
    if(peer===1&&controls.preparationMode==='fail')throw Error('private RPC unavailable');
    return {context:{slot:100},value:rows.map((r,i)=>r===null||peer===1&&i===1&&controls.preparationMode==='missing'?null:{...r,data:Buffer.from(r.data)})};},
   getMinimumBalanceForRentExemption:async(bytes,commitment)=>{expect(bytes).toBe(165);expect(commitment).toBe('finalized');return controls.rent+(peer===1&&controls.preparationMode==='disagree'?1:0);},
   getLatestBlockhashAndContext:async()=>{controls.latestCalls++;return {context:{slot:100},value:{blockhash,lastValidBlockHeight:300}};},
   getFeeForMessage:async message=>{controls.feeMessages.push(Buffer.from(message.serialize()).toString('hex'));return {context:{slot:100},value:controls.fee};},
   isBlockhashValid:async hash=>{controls.validityHashes.push(hash);return {context:{slot:100},value:controls.blockhashValid&&hash===blockhash};},getBlockHeight:async()=>controls.height,
  };
 }) as [(signal:AbortSignal)=>KeepEquipmentPaymentPreparationRpc,(signal:AbortSignal)=>KeepEquipmentPaymentPreparationRpc];
 const finalityConnect=[0,1].map(peer=>(signal:AbortSignal):KeepEquipmentPaymentRpc=>{
  controls.signals.push(signal);return {getGenesisHash:async()=>peer===1&&controls.finalityMode==='genesis'?key():genesis,getSlot:async()=>peer===1&&controls.finalityMode==='unfinalized'?109:120,
   getTransaction:async(signature,options)=>{controls.finalityCalls++;expect(options).toEqual({commitment:'finalized',maxSupportedTransactionVersion:0});
    if(peer===1&&controls.finalityMode==='throw')throw Error('private RPC unavailable');if(peer===1&&controls.finalityMode==='missing')return null;
    if(!controls.wire||!controls.preparation)throw Error('Fixture must publish the retained original');
    const tx=execution(controls.wire,controls.preparation);expect(tx.transaction.signatures).toEqual([signature]);
    if(peer===1&&controls.finalityMode==='disagree')tx.slot++;
    if(peer===1&&controls.finalityMode==='failed')tx.meta!.err={InstructionError:[0,'InvalidArgument']};
    return tx;
   }};
 }) as [(signal:AbortSignal)=>KeepEquipmentPaymentRpc,(signal:AbortSignal)=>KeepEquipmentPaymentRpc];
 const deps={trust,preparationConnect,finalityConnect,assertAdmission:()=>{if(controls.paused)throw Error('Fixture market paused');}};
 const payments=createKeepEquipmentPayments(conn.db,deps);
 const prepare=async()=>{const state=await payments.prepare(buyer.wallet,fill.id);expect(state.preparation).not.toBeNull();controls.preparation=state.preparation;return state.preparation!;};
 const sign=(p:KeepEquipmentSavedPreparation)=>{const bytes=Buffer.from(p.messageHex,'hex'),tx=new VersionedTransaction(p.transactionVersion==='legacy'?Message.from(bytes):MessageV0.deserialize(bytes));tx.sign([buyer.signer]);return tx.serialize();};
 const retain=async()=>{const p=await prepare(),wire=sign(p);controls.wire=Uint8Array.from(wire);const state=await payments.retainSigned(buyer.wallet,fill.id,wire);return {state,wire,p};};
 return {seller,buyer,mint,genesis,blockhash,listing,fill,trust,controls,deps,payments,prepare,sign,retain,accountRows:rows,createSellerAta:()=>{rows[2]=token(seller.signer.publicKey,5n);}};
}
export function execution(wire:Uint8Array,p:KeepEquipmentSavedPreparation):VersionedTransactionResponse{
 const tx=VersionedTransaction.deserialize(wire),message=tx.message,keys=message.staticAccountKeys;
 const buyer=new PublicKey(p.original.buyer),seller=new PublicKey(p.original.seller),mint=new PublicKey(p.original.keepMint),buyerAta=ata(mint,buyer),sellerAta=ata(mint,seller),created=!p.original.sellerAtaExists;
 const index=(key:PublicKey)=>{const i=keys.findIndex(k=>k.equals(key));if(i<0)throw Error('Fixture instruction key missing');return i;};
 const token=(owner:PublicKey,address:PublicKey,amount:bigint)=>({accountIndex:index(address),mint:mint.toBase58(),owner:owner.toBase58(),programId:tokenProgram.toBase58(),uiTokenAmount:{amount:amount.toString(),decimals:TOKEN.decimals,uiAmount:null}});
 const preBalances=keys.map(()=>100_000_000),postBalances=[...preBalances];postBalances[0]!-=fixtureFee+(created?fixtureRent:0);
 if(created){preBalances[index(sellerAta)]=0;postBalances[index(sellerAta)]=fixtureRent;}
 const inner:TransactionInstruction[]=created?[
  new TransactionInstruction({programId:tokenProgram,keys:[{pubkey:mint,isWritable:false,isSigner:false}],data:Buffer.from([21,7,0])}),
  SystemProgram.createAccount({fromPubkey:buyer,newAccountPubkey:sellerAta,lamports:fixtureRent,space:165,programId:tokenProgram}),
  new TransactionInstruction({programId:tokenProgram,keys:[{pubkey:sellerAta,isWritable:true,isSigner:false}],data:Buffer.of(22)}),
  new TransactionInstruction({programId:tokenProgram,keys:[{pubkey:sellerAta,isWritable:true,isSigner:false},{pubkey:mint,isWritable:false,isSigner:false}],data:Buffer.concat([Buffer.of(18),seller.toBuffer()])}),
 ]:[];
 const total=BigInt(p.original.totalBaseUnits);
 return {version:message.version,slot:110,blockTime:1_900_000_000,transaction:{message,signatures:[bs58.encode(tx.signatures[0]!)]},meta:{err:null,fee:fixtureFee,preBalances,postBalances,loadedAddresses:{writable:[],readonly:[]},
  innerInstructions:created?[{index:0,instructions:inner.map(ix=>({programIdIndex:index(ix.programId),accounts:ix.keys.map(k=>index(k.pubkey)),data:bs58.encode(ix.data),stackHeight:2}))}]:[],
  preTokenBalances:[token(buyer,buyerAta,fixtureKeep),...(!created?[token(seller,sellerAta,5n)]:[])],postTokenBalances:[token(buyer,buyerAta,fixtureKeep-total),token(seller,sellerAta,(created?0n:5n)+sellerShare(total))]}};
}
export async function paymentStock(conn:Connection,baseId:string){return (await conn.sql`select available::text,market_outgoing::text,market_incoming::text from ordinary_equipment_stocks where base_id=${baseId} and item_id='route_compass'`)[0]!;}
