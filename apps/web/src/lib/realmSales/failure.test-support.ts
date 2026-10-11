/** Actual canonical SDK bytes and injected finalized failure facts, never RPC. */
import {PublicKey} from '@solana/web3.js';
import {RealmSaleFailureSchema} from '@shardkeep/shared/realmSaleFailureApi';
import {realmSaleSettlementFixture} from './settlement.test-support';
import {createSeekerRealmAccessFixture} from '../../../../../packages/chain/src/testFixtures/seekerRealmAccess';
import {createSeekerRealmSaleFailureVerifier} from '../../../../../packages/chain/src/seekerRealmSaleFailure';
export async function realmSaleBrowserFailureFixture(options:Parameters<typeof realmSaleSettlementFixture>[0]={}){
 const original=await realmSaleSettlementFixture(options),bank=await createSeekerRealmAccessFixture(),p=original.preparation;
 bank.trust.developer=new PublicKey(p.terms.developer);
 const tx=original.sale.transaction,meta=tx.meta!;meta.err={InstructionError:[0,{Custom:9}]};meta.postBalances=meta.preBalances.map((v,i)=>v-(i===0?meta.fee:0));
 const {programId:_,reviewedDeploymentSlot:__,observedAccountSlot:___,proofClockUnixTimestamp:____,newAccountRentCaps:_____,...request}=original.sale.expected;
 const receipt=await createSeekerRealmSaleFailureVerifier(()=>({...bank.rpc,getTransaction:async()=>tx}),bank.trust)(request);
 const failure=RealmSaleFailureSchema.parse({wallet:p.wallet,idempotencyKey:p.idempotencyKey,saleId:p.saleId,receipt,verifiedAt:'2026-09-26T01:00:00.123456Z',transactionFailed:true,purchaseFinalized:false,journalClearingAuthorized:false});
 const trust={genesisHash:p.source.genesisHash,programId:p.source.programId,developer:p.terms.developer,reviewedProgramDataSha256:p.source.programDataSha256,reviewedDeploymentSlot:p.source.reviewedDeploymentSlot,revision:p.source.revision,upgradeAuthority:bank.trust.upgradeAuthority?.toBase58()??null};
 return {...original,failure,trust};
}
