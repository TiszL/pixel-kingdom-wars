/** Deterministic, actual Anchor-encoded account fixtures. No chain/RPC authority. */
import { createHash } from 'node:crypto';
import anchorPkg,{type Idl} from '@coral-xyz/anchor';
import { PublicKey,SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';
import { PHASE_E_POLICY,PHASE_E_SEEKER_SALE,PHASE_E_MINING_PUBLICATION } from '@shardkeep/shared';
import idl from '../idl/shardkeep_economy.json' with {type:'json'};
import { canonicalSeekerRegistry,hashSeekerRegistry,seekerAuthorityPda,seekerAuctionConfigPda,seekerTermPda } from '../seekerAuctionProtocol';
import { realmSaleConfigPda,realmAccessPda,realmSaleReceiptPda } from '../seekerRealmSaleProtocol';
import type { SeekerRealmAccessRpc,SeekerRealmAccessTrust } from '../seekerRealmAccessSnapshot';
const {BorshCoder,BN}=anchorPkg,coder=new BorshCoder(idl as Idl);
export const realmAccessFixtureKey=(n:number)=>new PublicKey(Buffer.alloc(32,n));
const LOADER=new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'),SYSVAR=new PublicKey('Sysvar1111111111111111111111111111111111111');
export async function createSeekerRealmAccessFixture(){
 const programId=new PublicKey(idl.address),wallet=realmAccessFixtureKey(1),developer=realmAccessFixtureKey(2),upgradeAuthority=realmAccessFixtureKey(3),genesis=realmAccessFixtureKey(4);
 const saleId=Buffer.alloc(16,5),realm=0,slot=150,now=10n*BigInt(PHASE_E_MINING_PUBLICATION.daySec),P=PHASE_E_POLICY.seekerIsland;
 const derive=(seed:string,...tails:Buffer[])=>PublicKey.findProgramAddressSync([Buffer.from(seed),...tails],programId);
 const pd=PublicKey.findProgramAddressSync([programId.toBuffer()],LOADER)[0],configAddress=realmSaleConfigPda(programId),accessAddress=realmAccessPda(programId,wallet,realm),receiptAddress=realmSaleReceiptPda(programId,wallet,saleId);
 const configModel={version:PHASE_E_SEEKER_SALE.version,authority:seekerAuthorityPda(programId),developer,price_lamports:new BN(P.permitPriceLamports),duration_sec:new BN(P.permitDurationSec),seller_bps:P.contractSellerBps,developer_bps:P.contractDevBps,quota_max:P.paidContractsPerSpotDayMax,day_sec:new BN(PHASE_E_MINING_PUBLICATION.daySec),quote_ttl_sec:new BN(PHASE_E_SEEKER_SALE.quoteTtlSec),bump:derive('realm_sale_config')[1]};
 const accessModel={version:PHASE_E_SEEKER_SALE.version,config:configAddress,wallet,realm,expires_at:new BN((now+BigInt(P.permitDurationSec)).toString()),bump:derive('realm_access',wallet.toBuffer(),Buffer.of(realm))[1]};
 const receiptModel={version:PHASE_E_SEEKER_SALE.version,config:configAddress,sale_id:[...saleId],buyer:wallet,seller:realmAccessFixtureKey(6),developer,term:seekerTermPda(programId,seekerAuctionConfigPda(programId),2n),spot:0,realm,day:new BN(10),round:new BN(2),registry_version:1,registry_hash:[...hashSeekerRegistry(canonicalSeekerRegistry())],price_lamports:new BN(P.permitPriceLamports),seller_lamports:new BN(P.permitPriceLamports*P.contractSellerBps/PHASE_E_POLICY.basisPoints),developer_lamports:new BN(P.permitPriceLamports*P.contractDevBps/PHASE_E_POLICY.basisPoints),prior_expiry:new BN(0),coverage_start:new BN(now.toString()),expires_at:new BN((now+BigInt(P.permitDurationSec)).toString()),accepted_at:new BN(now.toString()),bump:derive('realm_sale',wallet.toBuffer(),saleId)[1]};
 const program=Buffer.alloc(36);program.writeUInt32LE(2);pd.toBuffer().copy(program,4);
 const programData=Buffer.alloc(64,7);programData.writeUInt32LE(3);programData.writeBigUInt64LE(90n,4);programData[12]=1;upgradeAuthority.toBuffer().copy(programData,13);
 const clock=Buffer.alloc(40);clock.writeBigUInt64LE(BigInt(slot));clock.writeBigInt64LE(now,32);
 const row=(address:PublicKey,owner:PublicKey,data:Buffer,executable=false)=>({address,owner,data,executable});
 const rows:Array<ReturnType<typeof row>|null>=[row(programId,LOADER,program,true),row(pd,LOADER,programData),row(configAddress,programId,await coder.accounts.encode('RealmSaleConfig',configModel)),row(accessAddress,programId,await coder.accounts.encode('RealmAccess',accessModel)),row(SYSVAR_CLOCK_PUBKEY,SYSVAR,clock),row(receiptAddress,programId,await coder.accounts.encode('RealmSaleReceipt',receiptModel))];
 const trust:{-readonly [K in keyof SeekerRealmAccessTrust]:SeekerRealmAccessTrust[K]}={programId,developer,expectedGenesisHash:genesis.toBase58(),reviewedDeploymentSlot:90,reviewedProgramDataSha256:createHash('sha256').update(programData).digest('hex'),upgradeAuthority,stateProvenance:'fresh-reviewed-deployment'};
 const rpc:SeekerRealmAccessRpc={getGenesisHash:async()=>genesis.toBase58(),getSlot:async()=>slot,getMultipleAccountsInfoAndContext:async(addresses)=>({context:{slot},value:addresses.map(a=>rows.find(r=>r?.address.equals(a))??null)})};
 const encode=async(name:'config'|'access'|'receipt')=>{const index={config:2,access:3,receipt:5}[name],model={config:configModel,access:accessModel,receipt:receiptModel}[name],label={config:'RealmSaleConfig',access:'RealmAccess',receipt:'RealmSaleReceipt'}[name];rows[index]!.data=await coder.accounts.encode(label,model);};
 return {programId,wallet,developer,upgradeAuthority,genesis,saleId,realm,now,slot,trust,rpc,rows,configModel,accessModel,receiptModel,encode,request:{wallet,realm,saleId}};
}
