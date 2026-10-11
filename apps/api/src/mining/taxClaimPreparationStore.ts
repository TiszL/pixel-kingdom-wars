/** Immutable original consent and private proof. Recovery authenticates stored
 * structure/ABI, never RPC finality or permission to sign, relay or clear history. */
import {createHash} from 'node:crypto';
import {PublicKey} from '@solana/web3.js';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import {MINING_TAX_CLAIM_QUOTE_POLICY as POLICY,MiningTaxClaimPrepareRequestSchema,MiningTaxClaimPreparationSchema,type MiningTaxClaimPreparation,type MiningTaxClaimPrepareRequest} from '@shardkeep/shared/miningTaxClaimsApi';
import {validateMiningTaxPreparationMessages} from '@shardkeep/chain/mining-tax-preparation';
import {buildMiningTaxMessages,quoteMiningTaxMessageCosts} from '@shardkeep/chain/mining-tax-message';
import type {MiningTaxQuote} from '@shardkeep/chain/mining-tax-quote';
import type {MiningTaxSnapshot} from '@shardkeep/chain/mining-tax-snapshot';
import type {DbOrTx} from '../db/client';
export type MiningTaxClaimPreparationRecord={artifact:MiningTaxClaimPreparation;snapshot:MiningTaxSnapshot};
type Code='INVALID_INPUT'|'SOURCE_CONFLICT'|'REQUEST_CONFLICT';
export class MiningTaxClaimPreparationStoreError extends Error{constructor(readonly code:Code){super(`Mining tax preparation refused: ${code}`);this.name='MiningTaxClaimPreparationStoreError';}}
function fail(code:Code='INVALID_INPUT'):never{throw new MiningTaxClaimPreparationStoreError(code);}
const need=(v:unknown):void=>{if(!v)fail();};
const sha=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex');
const originalJson=(v:unknown)=>JSON.stringify(v,(_,x)=>typeof x==='bigint'?x.toString():x);
// Durable codec limits are operational. Preserve bigint type without guessing
// which historical decimal fields used to be strings. Private JSON is not trust.
function snapshotText(value:unknown):string{
 let nodes=0;
 function visit(v:unknown,depth:number):unknown{
  need(++nodes<=30000&&depth<=32);
  if(typeof v==='bigint'){need(v>=0n&&v<1n<<64n);return {$bigint:v.toString()};}
  if(v===null||typeof v==='boolean')return v;
  if(typeof v==='string'){need(v.length<=16384);return v;}
  if(typeof v==='number'){need(Number.isSafeInteger(v)&&v>=0);return v;}
  need(v&&typeof v==='object'&&(Array.isArray(v)||Object.getPrototypeOf(v)===Object.prototype));
  if(Array.isArray(v)){need(v.length<=512);return v.map(x=>visit(x,depth+1));}
  const entries=Object.entries(v as object);need(entries.length<=128&&!entries.some(([k])=>['$bigint','__proto__','constructor','prototype'].includes(k)));
  return Object.fromEntries(entries.map(([k,x])=>[k,visit(x,depth+1)]));
 }
 const text=JSON.stringify(visit(value,0));need(Buffer.byteLength(text)<=524288);return text;
}
function decodeSnapshot(text:unknown):MiningTaxSnapshot{
 need(typeof text==='string'&&Buffer.byteLength(text)<=524288);
 const parsed=JSON.parse(text as string,(_k,v)=>{
  if(v&&typeof v==='object'&&!Array.isArray(v)&&Object.hasOwn(v,'$bigint')){
   need(Object.keys(v).length===1&&typeof v.$bigint==='string'&&/^(0|[1-9][0-9]{0,19})$/.test(v.$bigint));const n=BigInt(v.$bigint);need(n<1n<<64n);return n;
  }return v;
 });need(snapshotText(parsed)===text);return parsed as MiningTaxSnapshot;
}
const keySchema=z.object({wallet:MiningTaxClaimPreparationSchema.shape.wallet,idempotencyKey:z.uuid().refine(v=>v===v.toLowerCase())}).strict();
type Key=z.infer<typeof keySchema>;
const sameIntent=(a:MiningTaxClaimPreparation,b:MiningTaxClaimPreparation)=>a.round===b.round&&a.spot===b.spot&&Object.keys(a.caps).every(k=>a.caps[k as keyof typeof a.caps]===b.caps[k as keyof typeof b.caps]);

function audit(value:MiningTaxClaimPreparationRecord,code:Code):MiningTaxClaimPreparationRecord{
 try{
  need(value&&typeof value==='object'&&Object.keys(value).length===2&&Object.hasOwn(value,'artifact')&&Object.hasOwn(value,'snapshot'));
  const artifact=MiningTaxClaimPreparationSchema.parse(value.artifact),snapshot=decodeSnapshot(snapshotText(value.snapshot)),a=artifact,s=snapshot,t=s.term,i=a.identity;
  need(sha(originalJson(s))===a.source.snapshotSha256&&s.wallet===a.wallet&&s.spot===a.spot&&s.slot===a.source.snapshotSlot&&s.chainClock.slot===s.slot&&s.chainClock.unixTimestamp.toString()===a.snapshot.unixTimestamp);
  need(s.claimsAuthorized===false&&s.signingAuthorized===false&&s.source.programId===i.programId&&s.source.genesisHash===i.genesisHash&&s.source.reviewedDeploymentSlot===a.source.reviewedDeploymentSlot&&s.source.reviewedProgramDataSha256===a.source.reviewedProgramDataSha256);
  need(t.source.round.toString()===a.round&&t.term===i.term&&t.registry===i.registry&&t.registryHash===i.registryHash&&t.source.config===i.auctionConfig&&t.auctions[a.spot]?.winner===a.wallet&&t.auctions[a.spot]?.terms.auction===i.auction);
  for(const k of ['auctionStart','auctionEnd','operatingStart','operatingEnd','completedAt','completedSlot'] as const)need(t[k].toString()===a.term[k]);
  need(t.winnerCount===a.term.winnerCount&&s.backing.config.address===i.configAddress&&s.backing.config.keepMint===i.keepMint&&s.backing.config.emissionReserveOwner===i.reserveOwner);
  need(s.claimantAta.address===i.claimantAta&&s.payer.address===a.wallet&&s.payer.lamports?.toString()===a.fees.payerBalanceLamports);
  need(a.setup.needsAta===!s.claimantAta.exists&&a.setup.needsPool===(s.pool===null)&&a.setup.needsCursor===(s.cursor===null));
  need((s.pool?.accrued??0n).toString()===a.snapshot.poolAccruedBaseUnits&&(s.cursor?.claimedTotal??0n).toString()===a.snapshot.claimedBaseUnits);
  let accrued=s.pool?.accrued??0n;for(const day of a.setup.accrualDays){const row=s.epochs.find(e=>e.day.toString()===day);need(row&&row.accrual===null&&row.epoch!==null&&row.epoch.tax>0n);accrued+=row!.epoch!.tax;}
  need(accrued/BigInt(t.winnerCount)===BigInt(a.intended.cumulativeBaseUnits)&&accrued%BigInt(t.winnerCount)===BigInt(a.intended.dustBaseUnits));
  validateMiningTaxPreparationMessages(a);return {artifact,snapshot};
 }catch{fail(code);}
}
export function createMiningTaxClaimPreparationRecord(wallet:string,value:MiningTaxClaimPrepareRequest,q:MiningTaxQuote,meta:{claimId:string;preparedAt:Date}):MiningTaxClaimPreparationRecord{
 try{
  const r=MiningTaxClaimPrepareRequestSchema.parse(value),s=q.snapshot,t=s.term,b=s.backing.config;
  need(wallet===s.wallet&&r.round===t.source.round.toString()&&r.spot===s.spot&&q.signingAuthorized===false&&q.broadcastAuthorized===false);
  const trust={programId:new PublicKey(q.source.programId),keepMint:new PublicKey(b.keepMint),reserveOwner:new PublicKey(b.emissionReserveOwner),expectedGenesisHash:q.source.genesisHash,reviewedDeploymentSlot:q.source.reviewedDeploymentSlot,reviewedProgramDataSha256:q.source.reviewedProgramDataSha256};
  const plan=buildMiningTaxMessages(trust,s,{wallet:new PublicKey(wallet),round:BigInt(r.round),spot:r.spot,blockhash:q.blockhash});
  const caps={maxFeeLamports:BigInt(r.caps.maxFeeLamports),maxRentLamports:BigInt(r.caps.maxRentLamports),maxTotalLamports:BigInt(r.caps.maxTotalLamports)},costs=quoteMiningTaxMessageCosts(plan,q.measurements,caps);
  need(originalJson(plan)===originalJson(q.plan)&&originalJson(costs)===originalJson(q.costs)&&originalJson(caps)===originalJson(q.caps));
  const pool=PublicKey.findProgramAddressSync([Buffer.from('mining_tax_pool'),new PublicKey(b.address).toBytes(),new PublicKey(t.term).toBytes()],trust.programId)[0];
  const artifact:MiningTaxClaimPreparation={version:1,wallet,idempotencyKey:r.idempotencyKey,claimId:meta.claimId,round:r.round,spot:r.spot,caps:r.caps,quoteVersion:1,quoteTtlSec:POLICY.ttlSec,preparedAt:meta.preparedAt.toISOString(),expiresAt:new Date(meta.preparedAt.getTime()+POLICY.ttlSec*1000).toISOString(),
   identity:{genesisHash:q.source.genesisHash,programId:q.source.programId,configAddress:b.address,keepMint:b.keepMint,reserveOwner:b.emissionReserveOwner,auctionConfig:t.source.config,term:t.term,registry:t.registry,registryHash:t.registryHash,pool:pool.toBase58(),cursor:PublicKey.findProgramAddressSync([Buffer.from('mining_tax_spot'),pool.toBytes(),Buffer.of(r.spot)],trust.programId)[0].toBase58(),auction:t.auctions[r.spot]!.terms.auction,claimantAta:s.claimantAta.address,originalWinner:wallet},
   term:{auctionStart:t.auctionStart.toString(),auctionEnd:t.auctionEnd.toString(),operatingStart:t.operatingStart.toString(),operatingEnd:t.operatingEnd.toString(),completedAt:t.completedAt.toString(),completedSlot:t.completedSlot.toString(),winnerCount:t.winnerCount,distributionVersion:1},
   source:{...q.source,blockhashSlot:q.blockhashSlot},snapshot:{unixTimestamp:s.chainClock.unixTimestamp.toString(),claimedBaseUnits:(s.cursor?.claimedTotal??0n).toString(),poolAccruedBaseUnits:(s.pool?.accrued??0n).toString()},
   intended:{claimBaseUnits:plan.expectedClaimBaseUnits.toString(),cumulativeBaseUnits:plan.cumulativeBaseUnits.toString(),dustBaseUnits:plan.dustBaseUnits.toString()},
   setup:{needsAta:!s.claimantAta.exists,needsPool:s.pool===null,needsCursor:s.cursor===null,accrualDays:plan.accrualDays.map(String)},blockhash:q.blockhash,lastValidBlockHeight:q.lastValidBlockHeight,blockHeight:q.blockHeight,
   fees:{feeLamports:costs.feeLamports.toString(),rentLamports:costs.rentLamports.toString(),totalLamports:costs.totalLamports.toString(),payerBalanceLamports:plan.payerBalanceLamports.toString()},
   transactions:plan.transactions.map((tx,ordinal)=>({ordinal,kind:tx.kind,messageHex:Buffer.from(tx.messageBytes).toString('hex'),messageSha256:tx.messageSha256,packetBytes:tx.packetBytes,feeLamports:costs.transactions[ordinal]!.feeLamports.toString(),rentLamports:costs.transactions[ordinal]!.rentLamports.toString(),newAccounts:q.measurements[ordinal]!.rents.map(r=>({address:r.address,space:r.space,rentLamports:r.lamports.toString()}))})),state:'prepared',currentSigningAuthorized:false,submissionAuthorized:false};
  return audit({artifact,snapshot:s},'INVALID_INPUT');
 }catch{fail();}
}
export async function getMiningTaxClaimPreparationRecord(db:DbOrTx,input:Key):Promise<MiningTaxClaimPreparationRecord|null>{
 const key=keySchema.safeParse(input);if(!key.success)fail();
 const [row]=await db.execute<{artifact:unknown;snapshot_text:string;snapshot_sha256:string}>(sql`select artifact,snapshot_text,snapshot_sha256 from mining_tax_claim_preparations where wallet=${key.data.wallet} and idempotency_key=${key.data.idempotencyKey}`);
 if(!row)return null;
 try{need(sha(row.snapshot_text)===row.snapshot_sha256);const result=audit({artifact:row.artifact as MiningTaxClaimPreparation,snapshot:decodeSnapshot(row.snapshot_text)},'SOURCE_CONFLICT');need(result.artifact.wallet===key.data.wallet&&result.artifact.idempotencyKey===key.data.idempotencyKey);return result;}catch{fail('SOURCE_CONFLICT');}
}
export async function getMiningTaxClaimPreparation(db:DbOrTx,input:Key):Promise<MiningTaxClaimPreparation|null>{return (await getMiningTaxClaimPreparationRecord(db,input))?.artifact??null;}
export async function saveMiningTaxClaimPreparation(db:DbOrTx,value:MiningTaxClaimPreparationRecord):Promise<MiningTaxClaimPreparation>{
 const r=audit(value,'INVALID_INPUT'),a=r.artifact,key={wallet:a.wallet,idempotencyKey:a.idempotencyKey};
 const match=(prior:MiningTaxClaimPreparation)=>{if(!sameIntent(prior,a))fail('REQUEST_CONFLICT');return prior;};
 const prior=await getMiningTaxClaimPreparation(db,key);if(prior)return match(prior);
 await db.execute(sql`insert into mining_tax_claim_preparations(artifact,snapshot_text) values(${JSON.stringify(a)}::jsonb,${snapshotText(r.snapshot)}) on conflict(wallet,idempotency_key) do nothing`);
 const saved=await getMiningTaxClaimPreparation(db,key);if(!saved)fail('SOURCE_CONFLICT');return match(saved);
}
