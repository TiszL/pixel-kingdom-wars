/** Unsigned player preparation. Saved recovery is independent of new admission;
 * this module never signs, broadcasts, consumes a cursor or reports settlement. */
import { randomUUID } from 'node:crypto';
import { PublicKey,type VersionedMessage } from '@solana/web3.js';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { PHASE_E_MINING_CLAIM_QUOTE as POLICY } from '@shardkeep/shared';
import { decodeMiningAllocationLeaf,decodeMiningAllocationProof } from '@shardkeep/chain/mining-allocation';
import { buildMiningClaimMessages } from '@shardkeep/chain/mining-claim-message';
import { copyMiningClaimFormat,type MiningClaimFormat } from '@shardkeep/chain/mining-claim-format';
import type { MiningClaimSnapshotReader,MiningClaimSnapshotTrust } from '@shardkeep/chain/mining-claim-snapshot';
import { VersionedMessage as MessageCodec } from '@solana/web3.js';
import { phaseEMiningEnabled } from '../config';
import type { Db } from '../db/client';
import { createMiningClaimReader } from './claimStatus';
import { getMiningClaimPreparation,saveMiningClaimPreparation,type MiningClaimPreparation } from './claimPreparationStore';

const MAX_TIMEOUT_MS=30_000,MAX_PENDING=32,U64=(1n<<64n)-1n;
type Code='INVALID_INPUT'|'DISABLED'|'BUSY'|'TIMEOUT'|'CLAIM_UNAVAILABLE'|'CLAIM_NOT_READY'|'SOURCE_CONFLICT'|'QUOTE_UNAVAILABLE'|'SOL_BALANCE_UNAVAILABLE'|'INSUFFICIENT_SOL'|'CLAIM_BLOCKHASH_REUSED'|'FORMAT_UNAVAILABLE';
export class MiningClaimPreparationError extends Error{constructor(readonly code:Code,cause?:unknown){super(`Mining claim preparation refused: ${code}`,{cause});this.name='MiningClaimPreparationError';}}
function fail(code:Code):never{throw new MiningClaimPreparationError(code);}
const requestSchema=z.object({idempotencyKey:z.uuid(),profile:z.literal('ordered-v0').optional()}).strict();
function integer(v:unknown):v is number{return typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;}
function address(v:unknown):string{if(typeof v!=='string'||v.length<32||v.length>44)fail('INVALID_INPUT');try{const p=new PublicKey(v);if(p.toBase58()!==v||p.equals(PublicKey.default))fail('INVALID_INPUT');return v;}catch{fail('INVALID_INPUT');}}
export interface MiningClaimQuoteReader {
 getAccountInfoAndContext?(address:PublicKey,options:{commitment:'finalized';minContextSlot:number}):Promise<{context:{slot:number};value:{owner:PublicKey;executable:boolean;data:Uint8Array}|null}>;
 getGenesisHash():Promise<string>;
 getSlot(commitment:'finalized'):Promise<number>;
 getBlockHeight(options:{commitment:'finalized';minContextSlot:number}):Promise<number>;
 getLatestBlockhashAndContext(options:{commitment:'finalized';minContextSlot:number}):Promise<{context:{slot:number};value:{blockhash:string;lastValidBlockHeight:number}}>;
 getFeeForMessage(message:VersionedMessage,commitment:'finalized'):Promise<{context:{slot:number};value:number|null}>;
 getMinimumBalanceForRentExemption(space:number,commitment:'finalized'):Promise<number>;
}
export interface MiningClaimPreparationSources {reader:MiningClaimSnapshotReader;trust:MiningClaimSnapshotTrust;quoteSource:(signal:AbortSignal)=>MiningClaimQuoteReader;ordered?:{address:string;dataSha256:string};now?:()=>Date;timeoutMs?:number}
export function createMiningClaimPreparer(db:Db,sources:MiningClaimPreparationSources){
 const timeout=sources.timeoutMs??MAX_TIMEOUT_MS;if(!integer(timeout)||timeout<1||timeout>MAX_TIMEOUT_MS)fail('INVALID_INPUT');
 const assess=createMiningClaimReader(db,sources),now=sources.now??(()=>new Date());
 const expectedGenesis=sources.trust.expectedGenesisHash,quoteSource=sources.quoteSource,ordered=sources.ordered?Object.freeze({...sources.ordered}):undefined;
 if(ordered){address(ordered.address);if(!/^[0-9a-f]{64}$/.test(ordered.dataSha256))fail('INVALID_INPUT');}
 const pending=new Map<string,{profile:'ordered-v0'|undefined;reply:Promise<MiningClaimPreparation>}>();
 async function prepareNew(wallet:string,idempotencyKey:string,signal:AbortSignal,profile?:'ordered-v0',persist=true,minSnapshotSlot=0):Promise<MiningClaimPreparation>{
  const guard=()=>{if(signal.aborted)fail('TIMEOUT');};
  const prior=await getMiningClaimPreparation(db,{wallet,idempotencyKey});guard();if(prior){if((prior.format?.preset)!==profile)fail('INVALID_INPUT');return prior;}
  if(profile&&!ordered)fail('FORMAT_UNAVAILABLE');
  if(!phaseEMiningEnabled())fail('DISABLED');
  const assessment=await assess.assess(wallet);guard();const {status,projection,snapshot}=assessment;
  if(status.state==='unavailable')fail('CLAIM_UNAVAILABLE');
  if(status.state!=='ready'||!status.preparationAllowed||projection?.kind!=='entitlement'||!snapshot)fail('CLAIM_NOT_READY');
  if(snapshot.slot<minSnapshotSlot)fail('SOURCE_CONFLICT');
  if(!snapshot.payer.exists||snapshot.payer.lamports===null)fail('SOL_BALANCE_UNAVAILABLE');
  const transport=quoteSource(signal),rpc=async<T>(run:()=>Promise<T>):Promise<T>=>{guard();const value=await run();guard();return value;};
  if(await rpc(()=>transport.getGenesisHash())!==expectedGenesis)fail('SOURCE_CONFLICT');
  let rawLookup:MiningClaimFormat['lookupTable']|undefined;
  if(profile){if(!ordered||!transport.getAccountInfoAndContext)fail('FORMAT_UNAVAILABLE');const observed=await rpc(()=>transport.getAccountInfoAndContext!(new PublicKey(ordered.address),{commitment:'finalized',minContextSlot:snapshot.slot}));
   if(!observed||!integer(observed.context?.slot)||observed.context.slot<snapshot.slot||!observed.value||observed.value.executable!==false||!(observed.value.data instanceof Uint8Array))fail('SOURCE_CONFLICT');
   rawLookup={address:ordered.address,owner:observed.value.owner.toBase58(),executable:false,dataHex:Buffer.from(observed.value.data).toString('hex'),slot:observed.context.slot};}
  const block=await rpc(()=>transport.getLatestBlockhashAndContext({commitment:'finalized',minContextSlot:Math.max(snapshot.slot,rawLookup?.slot??0)}));
  if(!block||!integer(block.context?.slot)||block.context.slot<snapshot.slot||!integer(block.value?.lastValidBlockHeight))fail('QUOTE_UNAVAILABLE');
  const blockhashContextSlot=block.context.slot,lastValidBlockHeight=block.value.lastValidBlockHeight;
  let blockhash:string;try{blockhash=address(block.value.blockhash);}catch{fail('QUOTE_UNAVAILABLE');}
  const h=projection.header,format=rawLookup&&ordered?copyMiningClaimFormat({version:1,preset:'ordered-v0',lookupTable:rawLookup,expectedLookupTable:ordered,blockhashContextSlot},sources.trust):undefined,plan=buildMiningClaimMessages({programId:new PublicKey(h.programId),keepMint:new PublicKey(h.keepMint),reserveOwner:new PublicKey(h.reserveOwner)},
   {wallet:new PublicKey(wallet),root:Buffer.from(h.root,'hex'),sequence:BigInt(h.sequence),day:BigInt(h.day),totalCumulative:BigInt(h.totalCumulative),
    leaf:decodeMiningAllocationLeaf(Buffer.from(projection.leafHex,'hex')),proof:decodeMiningAllocationProof(Buffer.from(projection.proofHex,'hex')),blockhash,
    needsAta:status.needsAta===true,needsMinerRecords:status.needsMinerRecords===true},format);
  // Ed25519 signs the message deterministically. A new UUID cannot reparent
  // the same globally unique signature after its original failed receipt.
  for(const tx of plan.transactions){
   const [used]=await db.execute(sql`select w.claim_id from mining_claim_signed_wires w join mining_claim_failures f on f.claim_id=w.claim_id and f.ordinal=w.ordinal where w.wallet=${wallet} and w.message_sha256=${tx.messageSha256} limit 1`);guard();
   if(used)fail('CLAIM_BLOCKHASH_REUSED');
  }
  let fees=0n,rents=0n,lastSlot=blockhashContextSlot;
  const transactions:MiningClaimPreparation['transactions']=[];
  for(const tx of plan.transactions){
   const fee=await rpc(()=>transport.getFeeForMessage(MessageCodec.deserialize(tx.messageBytes),'finalized'));
   if(!fee||!integer(fee.context?.slot)||fee.context.slot<blockhashContextSlot||!integer(fee.value))fail('QUOTE_UNAVAILABLE');
   lastSlot=Math.max(lastSlot,fee.context.slot);const feeLamports=BigInt(fee.value);let rentLamports=0n;
   for(const account of tx.expectedNewAccounts){const rent=await rpc(()=>transport.getMinimumBalanceForRentExemption(account.space,'finalized'));if(!integer(rent))fail('QUOTE_UNAVAILABLE');rentLamports+=BigInt(rent);}
   fees+=feeLamports;rents+=rentLamports;if(fees+rents>U64)fail('QUOTE_UNAVAILABLE');
   transactions.push({kind:tx.kind,messageHex:Buffer.from(tx.messageBytes).toString('hex'),messageSha256:tx.messageSha256,packetBytes:tx.packetBytes,feeLamports:feeLamports.toString(),rentLamports:rentLamports.toString()});
  }
  const height=await rpc(()=>transport.getBlockHeight({commitment:'finalized',minContextSlot:lastSlot})),finalSlot=await rpc(()=>transport.getSlot('finalized'));
  if(!integer(height)||height>lastValidBlockHeight||!integer(finalSlot)||finalSlot<lastSlot)fail('QUOTE_UNAVAILABLE');
  if(await rpc(()=>transport.getGenesisHash())!==expectedGenesis)fail('SOURCE_CONFLICT');
  if(snapshot.payer.lamports<fees+rents)fail('INSUFFICIENT_SOL');
  if(!phaseEMiningEnabled())fail('DISABLED');guard();const at=now();if(!(at instanceof Date)||!Number.isFinite(at.getTime()))fail('QUOTE_UNAVAILABLE');
  const artifact:MiningClaimPreparation={...(format?{format}:{}),claimId:randomUUID(),wallet,idempotencyKey,header:h,leafHex:projection.leafHex,proofHex:projection.proofHex,
   needsAta:status.needsAta===true,needsMinerRecords:status.needsMinerRecords===true,quoteVersion:POLICY.version,
   preparedAt:at.toISOString(),expiresAt:new Date(at.getTime()+POLICY.ttlSec*1000).toISOString(),snapshotSlot:snapshot.slot,
   blockhashContextSlot,blockhash,lastValidBlockHeight,payerBalanceLamports:snapshot.payer.lamports.toString(),
   feeLamports:fees.toString(),rentLamports:rents.toString(),totalLamports:(fees+rents).toString(),transactions,
   state:'prepared',currentSigningAuthorized:false,claimSubmissionAuthorized:false};
  // A reply can be lost during this commit. The immutable wallet/key remains
  // discoverable by GET; a timeout never authorizes a replacement or a send.
  if(!persist)return artifact;const saved=await saveMiningClaimPreparation(db,artifact);if(saved.format?.preset!==profile)fail('INVALID_INPUT');return saved;
 }
 return {async prepare(authenticatedWallet:string,value:unknown):Promise<MiningClaimPreparation>{
  const wallet=address(authenticatedWallet),parsed=requestSchema.safeParse(value);if(!parsed.success)fail('INVALID_INPUT');
  const idempotencyKey=parsed.data.idempotencyKey,key=`${wallet}:${idempotencyKey}`,prior=pending.get(key);if(prior){if(prior.profile!==parsed.data.profile)fail('INVALID_INPUT');return prior.reply;}
  if(pending.size>=MAX_PENDING)fail('BUSY');const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  const work=prepareNew(wallet,idempotencyKey,controller.signal,parsed.data.profile).catch(error=>{if(error instanceof MiningClaimPreparationError)throw error;throw new MiningClaimPreparationError('QUOTE_UNAVAILABLE',error);});
  const reply=Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new MiningClaimPreparationError('TIMEOUT'));},timeout);})]).finally(()=>{if(timer)clearTimeout(timer);});
  const entry={profile:parsed.data.profile,reply};pending.set(key,entry);void work.then(()=>{if(pending.get(key)===entry)pending.delete(key);},()=>{if(pending.get(key)===entry)pending.delete(key);});return reply;
 },
 /** Internal continuation candidate: caller must atomically save it with its validated parent link. */
 quoteForContinuation(authenticatedWallet:string,idempotencyKey:string,signal:AbortSignal,minSnapshotSlot:number){const wallet=address(authenticatedWallet);if(!z.uuid().safeParse(idempotencyKey).success||!integer(minSnapshotSlot))fail('INVALID_INPUT');return prepareNew(wallet,idempotencyKey,signal,'ordered-v0',false,minSnapshotSlot);},
 get(authenticatedWallet:string,idempotencyKey:string){const wallet=address(authenticatedWallet);if(!z.uuid().safeParse(idempotencyKey).success)fail('INVALID_INPUT');return getMiningClaimPreparation(db,{wallet,idempotencyKey});}};
}
