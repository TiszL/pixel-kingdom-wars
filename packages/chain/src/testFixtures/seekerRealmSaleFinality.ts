/** R1 joined actual Anchor account bytes and a locally signed sale transaction. */
import anchorPkg from '@coral-xyz/anchor';
import {PublicKey} from '@solana/web3.js';
import {createSeekerRealmAccessFixture} from './seekerRealmAccess';
import {realmSaleReceiptFixture} from './seekerRealmSaleReceipt';
import {realmAccessPda} from '../seekerRealmSaleProtocol';
import type {SeekerRealmSaleFinalityRpc} from '../seekerRealmSaleFinality';
const {BN}=anchorPkg;
export async function realmSaleFinalityFixture(){
 const sale=await realmSaleReceiptFixture(),bank=await createSeekerRealmAccessFixture();
 bank.trust.developer=sale.expected.args.developer;bank.configModel.developer=sale.expected.args.developer;await bank.encode('config');
 bank.accessModel.wallet=sale.buyer.publicKey;bank.accessModel.bump=PublicKey.findProgramAddressSync([Buffer.from('realm_access'),sale.buyer.publicKey.toBuffer(),Buffer.of(0)],bank.programId)[1];
 bank.accessModel.expires_at=new BN((sale.expected.args.validAfter+sale.expected.args.durationSec).toString());
 bank.rows[3]!.address=realmAccessPda(bank.programId,sale.buyer.publicKey,0);await bank.encode('access');
 bank.rows[5]={...sale.receipt,data:Buffer.from(sale.receipt.data)};
 const rpc:SeekerRealmSaleFinalityRpc={...bank.rpc,getTransaction:async()=>sale.transaction};
 const {programId:_,reviewedDeploymentSlot:__,observedAccountSlot:___,proofClockUnixTimestamp:____,...request}=sale.expected;
 return {...sale,bank,trust:bank.trust,request,rpc};
}
