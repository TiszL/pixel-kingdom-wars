/** Original fixed tax preparation ABI; structural recovery, never finality. */
import {createHash} from 'node:crypto';
import {PublicKey,SystemProgram,TransactionInstruction,TransactionMessage} from '@solana/web3.js';
import {ACCOUNT_SIZE,ASSOCIATED_TOKEN_PROGRAM_ID,TOKEN_PROGRAM_ID,createAssociatedTokenAccountIdempotentInstruction,getAssociatedTokenAddressSync} from '@solana/spl-token';
import type {MiningTaxClaimPreparation} from '@shardkeep/shared/miningTaxClaimsApi';
import {MINING_PROGRAM_ADDRESS} from './miningProgramProtocol';
import {MINING_TAX_ACCOUNT_BYTES} from './miningTaxProtocol';
const sha=(v:Uint8Array)=>createHash('sha256').update(v).digest('hex');
const need=(v:unknown):void=>{if(!v)throw new Error('Invalid original tax preparation ABI');};
/** Version1 recovery rebuilds its original fixed ABI without reading current
 * duration, price, eligibility or tax tuning. IDL: shardkeep_economy tax v2.
 * New quote creation still uses the complete authoritative planner below. */
export function validateMiningTaxPreparationMessages(a:MiningTaxClaimPreparation){
 const i=a.identity,p=new PublicKey(i.programId),wallet=new PublicKey(a.wallet),mint=new PublicKey(i.keepMint);
 need(i.programId===MINING_PROGRAM_ADDRESS&&PublicKey.isOnCurve(wallet.toBytes()));
 const le=(s:string)=>{const b=Buffer.alloc(8);b.writeBigUInt64LE(BigInt(s));return b;};
 const pda=(seed:string,...parts:Uint8Array[])=>PublicKey.findProgramAddressSync([Buffer.from(seed),...parts],p)[0];
 const config=pda('economy'),auctionConfig=pda('auction_config'),registry=pda('seeker_registry'),term=pda('seeker_term',auctionConfig.toBytes(),le(a.round));
 const pool=pda('mining_tax_pool',config.toBytes(),term.toBytes()),cursor=pda('mining_tax_spot',pool.toBytes(),Buffer.of(a.spot));
 const auction=pda('auction',auctionConfig.toBytes(),Buffer.of(a.spot),le(a.round)),ata=getAssociatedTokenAddressSync(mint,wallet),vault=getAssociatedTokenAddressSync(mint,config,true);
 const roles=[wallet,p,mint,config,auctionConfig,registry,term,pool,cursor,auction,ata,vault,SystemProgram.programId,TOKEN_PROGRAM_ID,ASSOCIATED_TOKEN_PROGRAM_ID].map(k=>k.toBase58());need(new Set(roles).size===roles.length);
 for(const [name,value]of Object.entries({configAddress:config,auctionConfig,registry,term,pool,cursor,auction,claimantAta:ata}))need(i[name as keyof typeof i]===value.toBase58());
 const ix=(name:string,rows:readonly (readonly [PublicKey,boolean,boolean])[])=>new TransactionInstruction({programId:p,data:createHash('sha256').update(`global:${name}`).digest().subarray(0,8),keys:rows.map(([pubkey,isSigner,isWritable])=>({pubkey,isSigner,isWritable}))});
 const common:readonly (readonly [PublicKey,boolean,boolean])[]=[[config,false,false],[auctionConfig,false,false],[registry,false,false],[term,false,false]],payer=[wallet,true,true] as const,system=[SystemProgram.programId,false,false] as const;
 const setup:TransactionInstruction[]=[],accounts:{address:string;space:number}[]=[];
 if(a.setup.needsAta){setup.push(createAssociatedTokenAccountIdempotentInstruction(wallet,ata,wallet,mint));accounts.push({address:ata.toBase58(),space:ACCOUNT_SIZE});}
 if(a.setup.needsPool){setup.push(ix('open_mining_tax_pool',[payer,...common,[pool,false,true],system]));accounts.push({address:pool.toBase58(),space:MINING_TAX_ACCOUNT_BYTES.MiningTaxPool});}
 for(const day of a.setup.accrualDays){const epoch=pda('mining_epoch',le(day)),accrual=pda('mining_tax_epoch',config.toBytes(),epoch.toBytes());
  setup.push(ix('accrue_mining_tax',[payer,...common,[pool,false,true],[epoch,false,false],[accrual,false,true],system]));accounts.push({address:accrual.toBase58(),space:MINING_TAX_ACCOUNT_BYTES.MiningTaxAccrual});}
 if(a.setup.needsCursor){setup.push(ix('open_mining_tax_spot',[payer,...common,[pool,false,false],[auction,false,false],[cursor,false,true],system]));accounts.push({address:cursor.toBase58(),space:MINING_TAX_ACCOUNT_BYTES.MiningTaxSpot});}
 const claim=ix('claim_mining_tax',[[wallet,true,false],[config,false,true],...common.slice(1),[pool,false,true],[auction,false,false],[cursor,false,true],[vault,false,true],[ata,false,true],[mint,false,false],[TOKEN_PROGRAM_ID,false,false]]);
 const groups=a.transactions.length===2?[setup,[claim]]:[[...setup,claim]];
 for(const [n,tx]of a.transactions.entries()){
  const bytes=new TransactionMessage({payerKey:wallet,recentBlockhash:a.blockhash,instructions:groups[n]!}).compileToLegacyMessage().serialize();
  need(tx.messageHex===Buffer.from(bytes).toString('hex')&&tx.messageSha256===sha(bytes));
  const expected=n===0?accounts:[];need(tx.newAccounts.length===expected.length&&tx.newAccounts.every((r,j)=>r.address===expected[j]!.address&&r.space===expected[j]!.space));
 }
}
