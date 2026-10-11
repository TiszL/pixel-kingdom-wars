/** Synthetic signed-chain evidence, persisted through the real quote/wire stores. */
import {randomUUID} from 'node:crypto';
import {PHASE_E_POLICY} from '@shardkeep/shared';
import {realmSaleFinalityFixture} from '../../../../packages/chain/src/testFixtures/seekerRealmSaleFinality';
import type {Db} from '../../src/db/client';
import {saveRealmSalePreparation,type RealmSalePreparation} from '../../src/seeker/realmSalePreparationStore';
import {acceptRealmSaleSigned} from '../../src/seeker/realmSaleSignedStore';
export async function retainRealmSaleSettlementFixture(db:Db):Promise<{artifact:RealmSalePreparation;chain:Awaited<ReturnType<typeof realmSaleFinalityFixture>>;key:{wallet:string;idempotencyKey:string}}>{
 const chain=await realmSaleFinalityFixture(),a=chain.expected.args;
 const artifact:RealmSalePreparation={version:1,wallet:chain.buyer.publicKey.toBase58(),idempotencyKey:randomUUID(),saleId:Buffer.from(a.saleId).toString('hex'),spot:a.spot,realm:a.realm,
  terms:{round:String(a.round),day:String(a.day),seller:a.seller.toBase58(),developer:a.developer.toBase58(),priorExpiry:String(a.priorExpiry),validAfter:String(a.validAfter),validUntil:String(a.validUntil)},
  source:{revision:'fixture-r1',genesisHash:chain.trust.expectedGenesisHash,programId:chain.expected.programId.toBase58(),programDataSha256:chain.trust.reviewedProgramDataSha256,reviewedDeploymentSlot:chain.trust.reviewedDeploymentSlot,termProofHash:'cd'.repeat(32),snapshotHash:'ef'.repeat(32),termSlot:99,initialSlot:100,blockhashSlot:100,feeSlot:100,costSlot:100,admissionSlot:100},
  quote:{blockhash:chain.expected.blockhash,lastValidBlockHeight:300,unixTimestamp:String(a.validAfter),needsAccess:true,needsQuota:true,quotaRemaining:PHASE_E_POLICY.seekerIsland.paidContractsPerSpotDayMax,
   messageHex:Buffer.from(chain.plan.messageBytes).toString('hex'),messageSha256:chain.plan.messageSha256,packetBytes:chain.plan.packetBytes,
   rents:chain.plan.expectedNewAccounts.map(r=>({address:r.address,space:r.space,minimumBalanceLamports:'1000000',existingLamports:'0',maxIncreaseLamports:'1000000'})),
   feeLamports:'5000',rentLamports:'3000000',paymentDebitLamports:String(chain.plan.buyerNetPaymentLamports),requiredLamports:String(chain.plan.buyerNetPaymentLamports+3005000n),payerLamports:'100000000'},
  state:'prepared',currentSigningAuthorized:false,submissionAuthorized:false};
 await saveRealmSalePreparation(db,artifact);await acceptRealmSaleSigned(db,{wallet:artifact.wallet,idempotencyKey:artifact.idempotencyKey,signedTransaction:chain.expected.signedTransaction});
 return {artifact,chain,key:{wallet:artifact.wallet,idempotencyKey:artifact.idempotencyKey}};
}
