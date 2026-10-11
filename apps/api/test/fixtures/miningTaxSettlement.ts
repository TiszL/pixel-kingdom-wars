/** Real finalized term/transaction adapters over encoded synthetic banks. The
 * owner writer must obtain its own proof; this fixture never inserts receipts. */
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {Keypair,type PublicKey,VersionedMessage,VersionedTransaction} from '@solana/web3.js';
import {buildMiningTaxMessages,quoteMiningTaxMessageCosts} from '@shardkeep/chain/mining-tax-message';
import type {MiningTaxQuote} from '@shardkeep/chain/mining-tax-quote';
import {createMiningTaxReceiptReaderFixture} from '../../../../packages/chain/src/testFixtures/miningTaxReceiptReader';
import {createMiningTaxClaimPreparationRecord,saveMiningTaxClaimPreparation} from '../../src/mining/taxClaimPreparationStore';
import {acceptMiningTaxClaimSigned} from '../../src/mining/taxClaimSignedStore';
import {withMiningTaxPreparationFixture} from './miningTaxPreparation';
import {signedMigration} from './miningTaxSigned';
export const settlementMigration=()=>readFileSync(new URL('../../drizzle/0188_mining_tax_claim_receipts.sql',import.meta.url),'utf8');
type BaseFixture=Parameters<Parameters<typeof withMiningTaxPreparationFixture>[0]>[0];
export type MiningTaxSettlementFixture=Omit<BaseFixture,'chain'|'wallet'|'trust'>&{
 chain:Awaited<ReturnType<typeof createMiningTaxReceiptReaderFixture>>;record:ReturnType<typeof createMiningTaxClaimPreparationRecord>;wallet:string;
 key:{wallet:string;idempotencyKey:string;ordinal:number};options:{connect:Awaited<ReturnType<typeof createMiningTaxReceiptReaderFixture>>['connect'];trust:Awaited<ReturnType<typeof createMiningTaxReceiptReaderFixture>>['trust']};
 wire:(ordinal?:number)=>Uint8Array;forkClaim:()=>Promise<{wallet:string;idempotencyKey:string;ordinal:number}>;
};
async function setup(f:BaseFixture,mode:'claim'|'combined'|'split',persistSigned:boolean,genesisHash?:PublicKey):Promise<MiningTaxSettlementFixture>{
 for(const [name,migration] of [['0187',signedMigration()],['0188',settlementMigration()]] as const){
  for(const [index,statement] of migration.split('--> statement-breakpoint').filter(x=>x.trim()).entries()){
   try{await f.conn.sql.unsafe(statement);}catch(error){throw new Error(`${name} fixture statement ${index+1}: ${error instanceof Error?error.message:String(error)}`,{cause:error});}
  }
 }
 const chain=await createMiningTaxReceiptReaderFixture(mode,{advancingQuote:mode!=='split',...(genesisHash?{genesisHash}:{})}),snapshot=chain.request.snapshot,plan=buildMiningTaxMessages(chain.trust.mining,snapshot,chain.request.plan),caps=chain.request.caps,t=chain.trust.mining;
 const measurements=plan.transactions.map(tx=>({messageSha256:tx.messageSha256,feeLamports:5n,rents:tx.expectedNewAccounts.map(a=>({...a,lamports:100n}))}));
 const quote:MiningTaxQuote=chain.quote??{snapshot,plan,blockhash:chain.request.plan.blockhash,blockhashSlot:chain.request.blockhashContextSlot,lastValidBlockHeight:200,blockHeight:100,measurements,caps,
  costs:quoteMiningTaxMessageCosts(plan,measurements,caps),source:{genesisHash:t.expectedGenesisHash,programId:t.programId.toBase58(),reviewedDeploymentSlot:t.reviewedDeploymentSlot,reviewedProgramDataSha256:t.reviewedProgramDataSha256,firstSnapshotSlot:snapshot.slot,snapshotSlot:snapshot.slot,feeSlot:snapshot.slot,snapshotSha256:createHash('sha256').update(JSON.stringify(snapshot,(_,v)=>typeof v==='bigint'?v.toString():v)).digest('hex')},signingAuthorized:false,broadcastAuthorized:false};
 const request={idempotencyKey:randomUUID(),round:chain.request.plan.round.toString(),spot:chain.request.plan.spot,caps:{maxFeeLamports:caps.maxFeeLamports.toString(),maxRentLamports:caps.maxRentLamports.toString(),maxTotalLamports:caps.maxTotalLamports.toString()}},wallet=chain.signer.publicKey.toBase58();
 const record=createMiningTaxClaimPreparationRecord(wallet,request,quote,{claimId:randomUUID(),preparedAt:new Date('2020-01-01T00:00:00.000Z')});await saveMiningTaxClaimPreparation(f.conn.db,record);
 const wire=(ordinal=0)=>Uint8Array.from(chain.request.signedTransactions[ordinal]!);
 if(persistSigned)for(const tx of record.artifact.transactions)await acceptMiningTaxClaimSigned(f.conn.db,{wallet,idempotencyKey:request.idempotencyKey,signedTransaction:wire(tx.ordinal)});
 async function forkClaim(){
  // A distinct exact packet and immutable consent for each resource-capacity
  // slot. These planning facts never substitute for the settlement RPC proof.
  const freshRequest={...request,idempotencyKey:randomUUID()},blockhash=Keypair.generate().publicKey.toBase58();
  const freshPlan=buildMiningTaxMessages(chain.trust.mining,snapshot,{...chain.request.plan,blockhash});
  const freshMeasurements=quote.measurements.map((m,i)=>({...m,messageSha256:freshPlan.transactions[i]!.messageSha256}));
  const fresh=createMiningTaxClaimPreparationRecord(wallet,freshRequest,{...quote,blockhash,plan:freshPlan,measurements:freshMeasurements,costs:quoteMiningTaxMessageCosts(freshPlan,freshMeasurements,caps)},{claimId:randomUUID(),preparedAt:new Date(record.artifact.preparedAt)});
  await saveMiningTaxClaimPreparation(f.conn.db,fresh);
  for(const tx of fresh.artifact.transactions){const signed=new VersionedTransaction(VersionedMessage.deserialize(Buffer.from(tx.messageHex,'hex')));signed.sign([chain.signer]);await acceptMiningTaxClaimSigned(f.conn.db,{wallet,idempotencyKey:freshRequest.idempotencyKey,signedTransaction:signed.serialize()});}
  return {wallet,idempotencyKey:freshRequest.idempotencyKey,ordinal:0};
 }
 return {...f,chain,record,wallet,forkClaim,key:{wallet,idempotencyKey:request.idempotencyKey,ordinal:0},options:{connect:chain.connect,trust:chain.trust},wire};
}
export async function withMiningTaxSettlementFixture(run:(f:MiningTaxSettlementFixture)=>Promise<void>,options:{mode?:'claim'|'combined'|'split';persistSigned?:boolean;genesisHash?:PublicKey}={}){
 return withMiningTaxPreparationFixture(async f=>run(await setup(f,options.mode??'claim',options.persistSigned??true,options.genesisHash)));
}
