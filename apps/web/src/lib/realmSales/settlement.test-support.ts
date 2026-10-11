/** Actual SDK/Anchor fixture facts only; never network or wall-clock authority. */
import {createHash} from 'node:crypto';
import {PublicKey} from '@solana/web3.js';
import {RealmSalePreparationSchema,RealmSaleSignedWireSchema,type RealmSalePreparationView,type RealmSaleSignedWireView} from '@shardkeep/shared/realmSalesApi';
import {RealmSaleSettlementSchema,type RealmSaleSettlementView} from '@shardkeep/shared/realmSaleSettlementApi';
import {realmSaleReceiptFixture} from '../../../../../packages/chain/src/testFixtures/seekerRealmSaleReceipt';
import {createSeekerRealmAccessFixture} from '../../../../../packages/chain/src/testFixtures/seekerRealmAccess';
import {createSeekerRealmSaleFinalityVerifier} from '../../../../../packages/chain/src/seekerRealmSaleFinality';
import {realmAccessPda} from '../../../../../packages/chain/src/seekerRealmSaleProtocol';
export async function realmSaleSettlementFixture(options:Parameters<typeof realmSaleReceiptFixture>[0]={}):Promise<{preparation:RealmSalePreparationView;wire:RealmSaleSignedWireView;settlement:RealmSaleSettlementView;sale:Awaited<ReturnType<typeof realmSaleReceiptFixture>>}>{
 const sale=await realmSaleReceiptFixture(options),bank=await createSeekerRealmAccessFixture(),a=sale.expected.args;
 bank.trust.developer=a.developer;bank.configModel.developer=a.developer;await bank.encode('config');
 bank.accessModel.wallet=sale.buyer.publicKey;bank.accessModel.bump=PublicKey.findProgramAddressSync([Buffer.from('realm_access'),sale.buyer.publicKey.toBuffer(),Buffer.of(a.realm)],bank.programId)[1];
 bank.accessModel.expires_at=sale.model.expires_at.clone();bank.rows[3]!.address=realmAccessPda(bank.programId,sale.buyer.publicKey,a.realm);await bank.encode('access');
 bank.rows[5]={...sale.receipt,data:Buffer.from(sale.receipt.data)};
 const {programId:_,reviewedDeploymentSlot:__,observedAccountSlot:___,proofClockUnixTimestamp:____,...request}=sale.expected;
 const proof=await createSeekerRealmSaleFinalityVerifier(()=>({...bank.rpc,getTransaction:async()=>sale.transaction}),bank.trust)(request),e=proof.evidence;
 const wallet=sale.buyer.publicKey.toBase58(),idempotencyKey='12345678-1234-4234-8234-123456789abc',saleId=Buffer.from(a.saleId).toString('hex');
 const rents=sale.plan.expectedNewAccounts.map((row,i)=>({address:row.address,space:row.space,minimumBalanceLamports:sale.expected.newAccountRentCaps[i]!.maxIncreaseLamports.toString(),existingLamports:'0',maxIncreaseLamports:sale.expected.newAccountRentCaps[i]!.maxIncreaseLamports.toString()}));
 const rent=rents.reduce((sum,row)=>sum+BigInt(row.maxIncreaseLamports),0n),required=rent+BigInt(e.feeLamports)+sale.plan.buyerNetPaymentLamports;
 const preparation=RealmSalePreparationSchema.parse({version:1,wallet,idempotencyKey,saleId,spot:a.spot,realm:a.realm,
  terms:{round:a.round.toString(),day:a.day.toString(),seller:a.seller.toBase58(),developer:a.developer.toBase58(),priorExpiry:a.priorExpiry.toString(),validAfter:a.validAfter.toString(),validUntil:a.validUntil.toString()},
  source:{revision:'browser-fixture',genesisHash:bank.trust.expectedGenesisHash,programId:bank.programId.toBase58(),programDataSha256:bank.trust.reviewedProgramDataSha256,reviewedDeploymentSlot:bank.trust.reviewedDeploymentSlot,termProofHash:'cd'.repeat(32),snapshotHash:'ef'.repeat(32),termSlot:100,initialSlot:100,blockhashSlot:100,feeSlot:100,costSlot:100,admissionSlot:100},
  quote:{blockhash:sale.expected.blockhash,lastValidBlockHeight:99,unixTimestamp:a.validAfter.toString(),needsAccess:sale.expected.needsAccess,needsQuota:sale.expected.needsQuota,quotaRemaining:1,messageHex:Buffer.from(sale.plan.messageBytes).toString('hex'),messageSha256:sale.plan.messageSha256,packetBytes:sale.plan.packetBytes,rents,feeLamports:e.feeLamports,rentLamports:rent.toString(),paymentDebitLamports:sale.plan.buyerNetPaymentLamports.toString(),requiredLamports:required.toString(),payerLamports:required.toString()},state:'prepared',currentSigningAuthorized:false,submissionAuthorized:false});
 const wire=RealmSaleSignedWireSchema.parse({wallet,idempotencyKey,saleId,signature:sale.signature,signedTransactionHex:Buffer.from(sale.expected.signedTransaction).toString('hex'),wireSha256:createHash('sha256').update(sale.expected.signedTransaction).digest('hex'),messageSha256:sale.plan.messageSha256,acceptedAt:'2026-09-25T12:34:56.123456Z',currentSigningAuthorized:false,relayAuthorized:false});
 const purchase=e.receipt;
 const settlement=RealmSaleSettlementSchema.parse({wallet,idempotencyKey,saleId,signature:sale.signature,
  receipt:{version:1,signature:e.signature,slot:e.slot,blockTime:e.blockTime,originalMessageSha256:e.originalMessageSha256,signedTransactionSha256:e.signedTransactionSha256,receiptAccountHex:proof.receiptAccountHex,feeLamports:e.feeLamports,actualRentLamports:e.actualRentLamports,buyerNetPaymentLamports:e.buyerNetPaymentLamports,accountRentIncreases:e.accountRentIncreases,observedAccountSlot:proof.observedAccountSlot,proofClockUnixTimestamp:proof.proofClockUnixTimestamp.toString(),source:proof.source},
  purchase:{address:purchase.address,buyer:purchase.buyer,seller:purchase.seller,developer:purchase.developer,spot:purchase.spot,realm:purchase.realm,round:purchase.round.toString(),day:purchase.day.toString(),acceptedAt:purchase.acceptedAt.toString(),priorExpiry:purchase.priorExpiry.toString(),coverageStart:purchase.coverageStart.toString(),expiresAt:purchase.expiresAt.toString(),priceLamports:purchase.priceLamports.toString(),sellerLamports:purchase.sellerLamports.toString(),developerLamports:purchase.developerLamports.toString()},settledAt:'2026-09-25T12:34:56.123456Z',purchaseFinalized:true,admissionAuthorized:false,relayAuthorized:false,signingAuthorized:false});
 return {preparation,wire,settlement,sale};
}
