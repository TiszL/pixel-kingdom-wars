/** Owned SQL wrapper and throwaway real signatures. Split uses the existing
 * explicit seven-day planning facts, never an RPC/finality capability. */
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {quoteMiningTaxMessageCosts} from '@shardkeep/chain/mining-tax-message';
import type {MiningTaxQuote} from '@shardkeep/chain/mining-tax-quote';
import {createMiningTaxReceiptFixture} from '../../../../packages/chain/src/testFixtures/miningTaxReceipt';
import {createMiningTaxClaimPreparationRecord,saveMiningTaxClaimPreparation} from '../../src/mining/taxClaimPreparationStore';
import {withMiningTaxPreparationFixture} from './miningTaxPreparation';
export const signedMigration=()=>readFileSync(new URL('../../drizzle/0187_mining_tax_claim_signed.sql',import.meta.url),'utf8');
type BaseFixture=Parameters<Parameters<typeof withMiningTaxPreparationFixture>[0]>[0];
export type MiningTaxSignedFixture=Omit<BaseFixture,'chain'|'wallet'>&{
 chain:Awaited<ReturnType<typeof createMiningTaxReceiptFixture>>;record:ReturnType<typeof createMiningTaxClaimPreparationRecord>;wallet:string;key:{wallet:string;idempotencyKey:string};wire:(ordinal?:number)=>Uint8Array;
};
async function setup(f:BaseFixture,mode:'claim'|'combined'|'split'):Promise<MiningTaxSignedFixture>{
 for(const statement of signedMigration().split('--> statement-breakpoint').filter(x=>x.trim()))await f.conn.sql.unsafe(statement);
 const chain=await createMiningTaxReceiptFixture(mode),snapshot=chain.snapshot,plan=chain.planned,caps=chain.request.caps;
 const measurements=plan.transactions.map(tx=>({messageSha256:tx.messageSha256,feeLamports:5n,rents:tx.expectedNewAccounts.map(a=>({...a,lamports:100n}))}));
 const q:MiningTaxQuote={snapshot,plan,blockhash:chain.request.plan.blockhash,blockhashSlot:snapshot.slot,lastValidBlockHeight:200,blockHeight:100,measurements,caps,
  costs:quoteMiningTaxMessageCosts(plan,measurements,caps),source:{genesisHash:chain.trust.expectedGenesisHash,programId:chain.trust.programId.toBase58(),reviewedDeploymentSlot:chain.trust.reviewedDeploymentSlot,reviewedProgramDataSha256:chain.trust.reviewedProgramDataSha256,firstSnapshotSlot:snapshot.slot,snapshotSlot:snapshot.slot,feeSlot:snapshot.slot,snapshotSha256:createHash('sha256').update(JSON.stringify(snapshot,(_,v)=>typeof v==='bigint'?v.toString():v)).digest('hex')},signingAuthorized:false,broadcastAuthorized:false};
 const request={idempotencyKey:randomUUID(),round:chain.request.plan.round.toString(),spot:chain.request.plan.spot,caps:{maxFeeLamports:caps.maxFeeLamports.toString(),maxRentLamports:caps.maxRentLamports.toString(),maxTotalLamports:caps.maxTotalLamports.toString()}},wallet=chain.signer.publicKey.toBase58();
 const record=createMiningTaxClaimPreparationRecord(wallet,request,q,{claimId:randomUUID(),preparedAt:new Date('2026-09-25T12:00:00.000Z')});
 await saveMiningTaxClaimPreparation(f.conn.db,record);
 return {...f,chain,record,wallet,key:{wallet,idempotencyKey:request.idempotencyKey},wire:(ordinal=0)=>Uint8Array.from(chain.evidence[ordinal]!.signedTransaction)};
}
export async function withMiningTaxSignedFixture(run:(f:MiningTaxSignedFixture)=>Promise<void>,mode:'claim'|'combined'|'split'='claim'){
 return withMiningTaxPreparationFixture(async f=>run(await setup(f,mode)));
}
