/** Actual verified split setup and an injected post-expiry finalized bank. */
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {acceptMiningTaxClaimSigned} from '../../src/mining/taxClaimSignedStore';
import {withMiningTaxAdmissionFixture,type MiningTaxAdmissionFixture} from './miningTaxAdmission';
import type {MiningTaxClaimSettlement} from '../../src/mining/taxClaimSettlement';
import type {MiningTaxClaimContinuationRequest} from '@shardkeep/shared/miningTaxClaimContinuationApi';
export const continuationMigration=()=>readFileSync(new URL('../../drizzle/0190_mining_tax_claim_continuations.sql',import.meta.url),'utf8');
export async function withMiningTaxContinuationFixture(run:(f:Awaited<ReturnType<typeof setup>>)=>Promise<void>){
 await withMiningTaxAdmissionFixture(async f=>run(await setup(f)),{mode:'split',persistSigned:false});
}
type Base=MiningTaxAdmissionFixture;
type Fixture=Omit<Base,'request'>&{setup:MiningTaxClaimSettlement;request:MiningTaxClaimContinuationRequest;parentKey:string};
async function setup(f:Base):Promise<Fixture>{
 for(const statement of continuationMigration().split('--> statement-breakpoint').filter(s=>s.trim()))await f.conn.sql.unsafe(statement);
 await acceptMiningTaxClaimSigned(f.conn.db,{wallet:f.wallet,idempotencyKey:f.key.idempotencyKey,signedTransaction:f.wire(0)});
 const setup=await f.verifySetup(6);f.control.height=f.record.artifact.lastValidBlockHeight+1;f.control.now=new Date(Date.parse(f.record.artifact.expiresAt)+1);
 const request={idempotencyKey:randomUUID(),caps:{maxFeeLamports:'10',maxRentLamports:'1000',maxTotalLamports:'1010'}};
 return {...f,setup,request,parentKey:f.key.idempotencyKey};
}
