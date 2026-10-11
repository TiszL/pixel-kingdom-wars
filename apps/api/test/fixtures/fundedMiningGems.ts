/** Real canonical wallet conversion + completed research, reverified through
 * signed SPL transaction metadata. No contribution result is injected. */
import { randomUUID } from 'node:crypto';
import { Keypair,PublicKey,TransactionMessage,VersionedTransaction,type VersionedTransactionResponse } from '@solana/web3.js';
import bs58 from 'bs58';
import { keepAta } from '@shardkeep/chain';
import { TOKEN,speedupCostKeep } from '@shardkeep/shared';
import { creditDeposit } from '../../src/money/deposits';
import { researchSpeedup } from '../../src/game/army';
import { withClientCurrencyContext } from '../../src/game/clientCurrency';
import type { GemsFinalizedOriginWiring } from '../../src/mining/gemsFinalizedOrigins';
import type { withFundedMiningFixture } from './fundedMining';
type Fixture=Pick<Parameters<Parameters<typeof withFundedMiningFixture>[0]>[0],'conn'|'buyerSigner'|'buyer'|'clock'>;
export async function fundedMiningGems(f:Fixture,identity:{genesisHash:string;keepMint:string},day='2020-01-01'){
 const signer=f.buyerSigner,wallet=f.buyer,mint=new PublicKey(identity.keepMint),reserveOwner=Keypair.generate().publicKey,reserveAta=keepAta(reserveOwner,mint,true);
 await f.conn.sql`insert into economy_chain_identity(singleton,cluster,keep_mint,core_program,config_pda,gems_reserve_owner,gems_reserve_ata)
 values(true,'devnet',${mint.toBase58()},${Keypair.generate().publicKey.toBase58()},${Keypair.generate().publicKey.toBase58()},${reserveOwner.toBase58()},${reserveAta.toBase58()})`;
 const cost=BigInt(speedupCostKeep(3600)),raw=cost*10n**BigInt(TOKEN.decimals)+123n,source=keepAta(signer.publicKey,mint);
 const program=new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),data=Buffer.alloc(10);data[0]=12;data.writeBigUInt64LE(raw,1);data[9]=TOKEN.decimals;
 const message=new TransactionMessage({payerKey:signer.publicKey,recentBlockhash:Keypair.generate().publicKey.toBase58(),instructions:[{programId:program,data,keys:[
  {pubkey:source,isSigner:false,isWritable:true},{pubkey:mint,isSigner:false,isWritable:false},{pubkey:reserveAta,isSigner:false,isWritable:true},{pubkey:signer.publicKey,isSigner:true,isWritable:false}]}]}).compileToLegacyMessage();
 const signed=new VersionedTransaction(message);signed.sign([signer]);const signature=bs58.encode(signed.signatures[0]!),index=message.accountKeys.findIndex(k=>k.equals(reserveAta));
 const balance=(amount:bigint)=>({accountIndex:index,mint:mint.toBase58(),owner:reserveOwner.toBase58(),programId:program.toBase58(),uiTokenAmount:{amount:String(amount),decimals:TOKEN.decimals,uiAmount:null}});
 const transaction:VersionedTransactionResponse={slot:100,blockTime:Date.parse(day+'T01:00:00Z')/1000,version:'legacy',transaction:{message,signatures:[signature]},meta:{err:null,fee:5000,
  preBalances:message.accountKeys.map(()=>1000000),postBalances:message.accountKeys.map(()=>1000000),preTokenBalances:[balance(500n)],postTokenBalances:[balance(500n+raw)],innerInstructions:[],loadedAddresses:{writable:[],readonly:[]},logMessages:[]}};
 const transactions=new Map([[signature,transaction]]),calls:string[]=[];
 const wiring:GemsFinalizedOriginWiring={trust:{cluster:'devnet',expectedGenesisHash:identity.genesisHash,keepMint:mint.toBase58(),reserveOwner:reserveOwner.toBase58(),reserveAta:reserveAta.toBase58()},connect:()=>[{
  getGenesisHash:async()=>identity.genesisHash,getSlot:async()=>200,getTransaction:async signature=>{calls.push(signature);return transactions.get(signature)??null;}}]};
 await f.clock(day+'T02:00:00Z');const id=randomUUID(),reference=Keypair.generate().publicKey.toBase58(),payload={idempotencyKey:randomUUID(),keepIn:Number(cost),gemsOut:Number(cost),destination:reserveAta.toBase58(),mint:mint.toBase58(),gemsBuyVersion:1,decimals:TOKEN.decimals,expiresAt:day+'T03:00:00Z'};
 await f.conn.sql`insert into deposits(id,player_wallet,kind,reference,status,payload,created_at) values(${id},${wallet},'gems_buy',${reference},'pending',${JSON.stringify(payload)}::jsonb,${day+'T00:30:00Z'})`;
 await creditDeposit(f.conn.db,id,{wallet,txSignature:signature,kind:'gems_buy',lamports:raw,finalized:true},new Date(day+'T02:00:00Z'));
 const finishesAt=day+'T03:00:00.000Z';await f.conn.sql`insert into troop_research(player_wallet,troop,level,researching_to_level,finishes_at) values(${wallet},'giant',1,2,${finishesAt})`;
 await f.clock(day+'T02:00:00.000999Z');
 await withClientCurrencyContext({currency:undefined,expectedCurrency:'GEMS'},()=>researchSpeedup(f.conn.db,wallet,'giant',randomUUID(),new Date(day+'T02:00:00Z'),undefined,{currentLevel:1,toLevel:2,finishesAt,episodeId:null,maxCostKeep:String(cost)}));
 await f.clock(null);return {wiring,transactions,transaction,signature,cost,calls};
}
