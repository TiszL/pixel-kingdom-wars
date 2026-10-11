/** Loopback native/API evidence. Raw account and finalized execution fixtures
 * pass through real readers; private keys remain in this process only. */
import {createHash} from 'node:crypto';
import {PublicKey,Message,MessageV0,VersionedTransaction} from '@solana/web3.js';
import bs58 from 'bs58';
import {expect,vi} from 'vitest';
import {PHASE_E_KEEP_EQUIPMENT_MARKET,PHASE_E_KEEP_EQUIPMENT_MARKET_CLIENT,PHASE_E_POLICY,TOKEN} from '@shardkeep/shared';
import type {KeepEquipmentPaymentFailureRpc} from '@shardkeep/chain/keep-equipment-payment-failure';
import type {KeepEquipmentPurchase} from '@shardkeep/shared/keepEquipmentMarketApi';
import {createKeepEquipmentPayments,type KeepEquipmentPaymentDependencies} from '../../src/game/keepEquipmentPayments';
import {sessions} from '../../src/db/schema';
import {issueSessionJwt,SESSION_COOKIE,SESSION_TTL_SEC} from '../../src/auth/session';
import {connectTestDb,TEST_CONFIG} from '../helpers';
import {paymentFixture,paymentStock,fixtureFee,fixtureRent,transferPaymentBase,type PaymentFixtureSource} from './keepEquipmentPayments';
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
export async function keepEquipmentMarketNativePair(version:'legacy'|0,source?:{conn:ReturnType<typeof connectTestDb>;goods:PaymentFixtureSource}){
 const conn=source?.conn??connectTestDb();vi.stubEnv('MULTI_BASE_ENABLED','true');const f=await paymentFixture(conn,version,version===0,source?.goods);vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(f.buyer.now);
 let failed=false;
 const finalityConnect=f.deps.finalityConnect.map(connect=>(signal:AbortSignal):KeepEquipmentPaymentFailureRpc=>{const rpc=connect(signal);return {...rpc,getTransaction:async(signature,options)=>{const tx=await rpc.getTransaction(signature,options);if(!tx||!failed)return tx;
  tx.meta!.err={InstructionError:[version===0?2:1,{Custom:1}]};tx.meta!.postBalances=tx.meta!.preBalances.map((n,i)=>n-(i===0?tx.meta!.fee:0));tx.meta!.postTokenBalances=structuredClone(tx.meta!.preTokenBalances!);tx.meta!.innerInstructions=[];return tx;}};}) as [(signal:AbortSignal)=>KeepEquipmentPaymentFailureRpc,(signal:AbortSignal)=>KeepEquipmentPaymentFailureRpc];
 const releases={failureConnect:finalityConnect,trust:f.trust};
 const cookies=new Map<string,Record<string,string>>(),sent:Array<{fillId:string;signature:string;hex:string}>=[];
 for(const actor of [f.buyer,f.seller]){const [session]=await conn.db.insert(sessions).values({wallet:actor.wallet,expiresAt:new Date(Date.now()+SESSION_TTL_SEC*1000)}).returning();cookies.set(actor.wallet,{[SESSION_COOKIE]:await issueSessionJwt(TEST_CONFIG,actor.wallet,session!.id)});}
 f.controls.finalityMode='missing';const deps:KeepEquipmentPaymentDependencies={...f.deps,finalityConnect,broadcastConnect:()=>({getGenesisHash:async()=>f.genesis,getSlot:async()=>120,sendRawTransaction:async(bytes,options)=>{
  const signature=bs58.encode(VersionedTransaction.deserialize(bytes).signatures[0]!),hex=Buffer.from(bytes).toString('hex');const [row]=await conn.sql`select fill_id,encode(signed_transaction,'hex') wire from keep_equipment_payment_wires where signature=${signature}`;
  expect(row).toBeDefined();expect(row!.wire).toBe(hex);expect(await conn.sql`select consumer_kind,consumer_id from payment_signature_claims where signature=${signature}`).toEqual([{consumer_kind:'keep_equipment_market',consumer_id:row!.fill_id}]);
  expect(options).toEqual({skipPreflight:false,preflightCommitment:'finalized',maxRetries:0,minContextSlot:100});sent.push({fillId:row!.fill_id,signature,hex});return signature;
 }})};
 const payments=createKeepEquipmentPayments(conn.db,deps);
 async function sign(purchase:KeepEquipmentPurchase){const saved=await payments.read(f.buyer.wallet,purchase.fill.id);expect(saved).toEqual(purchase);const p=saved.preparation;expect(p).not.toBeNull();f.controls.preparation=p;
  const message=Buffer.from(p!.messageHex,'hex'),tx=new VersionedTransaction(version==='legacy'?Message.from(message):MessageV0.deserialize(message));tx.sign([f.buyer.signer]);const bytes=tx.serialize();
  return {signedTransactionHex:Buffer.from(bytes).toString('hex'),signature:bs58.encode(tx.signatures[0]!),wireSha256:hash(bytes),messageSha256:hash(message)};
 }
 async function retained(id:string){const saved=await payments.read(f.buyer.wallet,id);expect(saved.wire).not.toBeNull();f.controls.preparation=saved.preparation;f.controls.wire=Buffer.from(saved.wire!.signedTransactionHex,'hex');}
 async function finalize(id:string){await retained(id);expect(sent.some(row=>row.fillId===id&&row.hex===Buffer.from(f.controls.wire!).toString('hex'))).toBe(true);f.controls.finalityMode='ok';return {observed:true};}
 async function fail(id:string){await retained(id);expect(sent.some(row=>row.fillId===id&&row.hex===Buffer.from(f.controls.wire!).toString('hex'))).toBe(true);failed=true;f.controls.finalityMode='ok';return {observed:true};}
 async function positiveAgain(id:string){await retained(id);expect(failed).toBe(true);failed=false;f.controls.finalityMode='ok';return {observed:true};}
 async function transfer(){return {newBuyer:await transferPaymentBase(conn,f.buyer),newSeller:await transferPaymentBase(conn,f.seller)};}
 async function sourceStock(baseId:string){if(source?.goods.itemId==='crystal_fragment')return (await conn.sql`select available::text,market_outgoing::text,market_incoming::text from crystal_fragment_stocks where base_id=${baseId}`)[0]!;return source?(await conn.sql`select available::text,market_outgoing::text,market_incoming::text from crafting_stocks where base_id=${baseId} and item_id=${source.goods.itemId}`)[0]!:paymentStock(conn,baseId);}
 async function inspect(){const rows=await conn.sql`select d.fill_id from keep_equipment_deliveries d join keep_equipment_fills f on f.id=d.fill_id where f.buyer_base_id=${f.buyer.baseId}`;const released=await conn.sql`select r.fill_id from keep_equipment_fill_releases r join keep_equipment_fills f on f.id=r.fill_id where f.buyer_base_id=${f.buyer.baseId}`;return {sends:sent.length,deliveries:rows.length,releases:released.length,buyer:await sourceStock(f.buyer.baseId),seller:await sourceStock(f.seller.baseId),...(source&&source.goods.itemId!=='crystal_fragment'?{buyerCompass:await paymentStock(conn,f.buyer.baseId)}:{}),wire:sent[0]?.hex??null};}
 const raw=f.deps.preparationConnect[0](new AbortController().signal);
 async function live(method:string,params:unknown[]){let result:unknown;const context=(value:unknown)=>({context:{slot:100},value});switch(method){
  case 'getGenesisHash':result=f.genesis;break;case 'getSlot':result=100;break;case 'getBlockHeight':result=f.controls.height;break;
  case 'getMultipleAccounts':{const keys=(params[0] as string[]).map(k=>new PublicKey(k));const value=await raw.getMultipleAccountsInfoAndContext(keys,{commitment:'finalized',minContextSlot:100});result={context:value.context,value:value.value.map(r=>r?{owner:r.owner.toBase58(),executable:r.executable,lamports:r.lamports,data:[Buffer.from(r.data).toString('base64'),'base64'],space:r.data.length}:null)};break;}
  case 'getMinimumBalanceForRentExemption':expect(params[0]).toBe(165);result=fixtureRent;break;
  case 'getFeeForMessage':{const expected=f.controls.preparation;expect(expected).not.toBeNull();expect(params[0]).toBe(Buffer.from(expected!.messageHex,'hex').toString('base64'));result=context(fixtureFee);break;}
  case 'isBlockhashValid':expect(params[0]).toBe(f.blockhash);result=context(true);break;
  case 'getSignatureStatuses':result=context([null]);break;
  default:throw Error('Unsupported paired read-only RPC');
 }return {jsonrpc:'2.0',id:1,result};}
 const policy={version:PHASE_E_KEEP_EQUIPMENT_MARKET.policyVersion,decimals:TOKEN.decimals,minFillBaseUnits:PHASE_E_KEEP_EQUIPMENT_MARKET.minFillBaseUnits.toString(),sellerBps:PHASE_E_POLICY.taxes.keepMarket.sellerBps,basisPoints:PHASE_E_POLICY.basisPoints,reviewMaxAgeMs:PHASE_E_KEEP_EQUIPMENT_MARKET_CLIENT.reviewMaxAgeMs};
 return {conn,f,cookies,deps,releases,sign,retained,finalize,fail,positiveAgain,transfer,inspect,live,sent,config:{buyerWallet:f.buyer.wallet,buyerBaseId:f.buyer.baseId,sellerWallet:f.seller.wallet,sellerBaseId:f.seller.baseId,initialListing:f.listing,price:f.listing.unitPriceBaseUnits,policy,
  trust:{version:1,revision:'native-api-pair',expectedGenesisHash:f.genesis,expectedKeepMint:f.mint.toBase58(),transactionVersion:version,policy,limits:{maxFeeLamports:f.trust.maxFeeLamports.toString(),maxPriorityFeeLamports:f.trust.maxPriorityFeeLamports.toString(),maxComputeUnitLimit:f.trust.maxComputeUnitLimit},rpcTimeoutMs:PHASE_E_KEEP_EQUIPMENT_MARKET_CLIENT.rpcTimeoutMs,maxPendingRpc:PHASE_E_KEEP_EQUIPMENT_MARKET_CLIENT.maxPendingRpc}},close:async()=>{await conn.sql.end();vi.useRealTimers();}};
}
export type KeepEquipmentMarketNativePair=Awaited<ReturnType<typeof keepEquipmentMarketNativePair>>;
