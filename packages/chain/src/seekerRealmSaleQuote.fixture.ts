/** R1 synthetic fixture only. Actual Anchor bytes and locally signed settlement
 * bodies exercise the real validators; injected finality is not a live proof. */
import { createHash } from 'node:crypto';
import type {Idl} from '@coral-xyz/anchor';
import { anchorRuntime as anchorPkg } from './anchorRuntime';
import { PHASE_E_POLICY,PHASE_E_SEEKER_AUCTION,PHASE_E_SEEKER_SALE,PHASE_E_MINING_PUBLICATION } from '@shardkeep/shared';
import { TOKEN_PROGRAM_ID,getAssociatedTokenAddressSync } from '@solana/spl-token';
import { PublicKey,Keypair,SystemProgram,SYSVAR_CLOCK_PUBKEY,TransactionMessage,VersionedTransaction,
 type AccountInfo,type VersionedTransactionResponse,type Connection,type GetMultipleAccountsConfig,type RpcResponseAndContext } from '@solana/web3.js';
import bs58 from 'bs58';
import idl from './idl/shardkeep_economy.json' with {type:'json'};
import { canonicalSeekerRegistry,hashSeekerRegistry,hashSeekerAuctionTerms,seekerAuctionConfigPda,seekerAuctionPda,seekerAuthorityPda,seekerBidPda,seekerRegistryPda,seekerTermPda } from './seekerAuctionProtocol';
import { realmSaleConfigPda,realmAccessPda,spotSalesQuotaPda,REALM_SALE_ACCOUNT_BYTES } from './seekerRealmSaleProtocol';
import { SEEKER_TERM_ACCOUNT_BYTES } from './seekerTermAccounts';
import type { ReviewedSeekerTermPolicy,SeekerTermRpc } from './seekerTerms';
import type { SeekerRealmAccessTrust } from './seekerRealmAccessSnapshot';
const {BorshAccountsCoder,BN}=anchorPkg,coder=new BorshAccountsCoder(idl as Idl);
const LOADER=new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'),SYSVAR=new PublicKey('Sysvar1111111111111111111111111111111111111');
const key=(n:number)=>Keypair.fromSeed(Buffer.alloc(32,n)).publicKey;
const le=(n:bigint)=>{const b=Buffer.alloc(8);b.writeBigUInt64LE(n);return b;};
function anchorValue(v:unknown):unknown{if(typeof v==='bigint')return new BN(v.toString());if(v instanceof PublicKey||v===null)return v;if(Array.isArray(v))return v.map(anchorValue);if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,v])=>[k,anchorValue(v)]));return v;}
export interface RealmSaleQuoteFixtureControls {
 now:bigint;slot:number;balance:number;fee:number|null;rent:number;blockhash:string;lastValidBlockHeight:number;blockHeight:number;genesisHash:string;
 beforeRead?:(addresses:PublicKey[],readIndex:number)=>void|Promise<void>;
 onFee?:()=>void|Promise<void>;onRent?:()=>void|Promise<void>;
}
export type RealmSaleQuoteFixtureRpc=Omit<SeekerTermRpc,'getMultipleAccountsInfoAndContext'>
 & Pick<Connection,'getSlot'|'getBlockHeight'|'getLatestBlockhashAndContext'|'getFeeForMessage'|'getMinimumBalanceForRentExemption'>
 & {getMultipleAccountsInfoAndContext(addresses:PublicKey[],options?:GetMultipleAccountsConfig):Promise<RpcResponseAndContext<Array<(AccountInfo<Buffer>&{address:PublicKey})|null>>>};
export async function realmSaleQuoteFixture(options:{genesisHash?:string}={}){
 const P=PHASE_E_POLICY.seekerIsland,A=PHASE_E_SEEKER_AUCTION,S=PHASE_E_SEEKER_SALE,program=new PublicKey(idl.address),buyer=key(1),seller=key(2),developer=key(3),settler=Keypair.fromSeed(Buffer.alloc(32,4)),upgradeAuthority=key(5),genesis=options.genesisHash?new PublicKey(options.genesisHash):key(6);
 const mint=key(7),prizeOwner=key(8),prizeAta=getAssociatedTokenAddressSync(mint,prizeOwner,true),authority=seekerAuthorityPda(program),config=seekerAuctionConfigPda(program),registry=seekerRegistryPda(program),term=seekerTermPda(program,config,0n);
 const derive=(seed:string,...tails:Buffer[])=>PublicKey.findProgramAddressSync([Buffer.from(seed),...tails],program),entries=canonicalSeekerRegistry(),registryHash=hashSeekerRegistry(entries);
 const operatingStart=1_800_000_000n,operatingEnd=operatingStart+BigInt(P.operatingTermSec),auctionStart=operatingStart-BigInt(P.overlappingAuctionSec),completedAt=operatingStart+BigInt(A.settlementGraceSec);
 const controls:RealmSaleQuoteFixtureControls={now:completedAt+3_600n,slot:2000,balance:10_000_000_000,fee:5_000,rent:2_039_280,blockhash:key(9).toBase58(),lastValidBlockHeight:2100,blockHeight:2000,genesisHash:genesis.toBase58()};
 const day=controls.now/BigInt(PHASE_E_MINING_PUBLICATION.daySec),saleConfig=realmSaleConfigPda(program),access=realmAccessPda(program,buyer,0),quota=spotSalesQuotaPda(program,0,day);
 const full=Array(Math.ceil(P.totalSpots/8)).fill(0) as number[];for(let i=0;i<P.totalSpots;i++)full[i>>3]!|=1<<(i%8);
 const opening=BigInt(A.openingBidSkr)*10n**6n;
 const models={
  authority:{version:1,admin:settler.publicKey,pending_admin:null as PublicKey|null,guardian:key(10),current_policy_key:key(11),previous_policy_key:null as PublicKey|null,previous_valid_until:0n,cluster_genesis:[...genesis.toBytes()],admission_paused:false,bump:derive('seeker_authority')[1]},
  config:{version:1,authority,registry,registry_hash:[...registryHash],registry_version:1,mint,token_program:TOKEN_PROGRAM_ID,decimals:6,prize_owner:prizeOwner,prize_ata:prizeAta,prize_bps:A.prizeBps,opening_bid:opening,first_operating_start:operatingStart,term_sec:BigInt(P.operatingTermSec),auction_sec:BigInt(P.overlappingAuctionSec),grace_sec:BigInt(A.settlementGraceSec),auction_format:1,terms_format:1,bump:derive('auction_config')[1]},
  registry:{version:1,island:1,entries:entries.map(e=>({id:e.spotId,class:e.class as number,realm_mask:e.realmMask})),hash:[...registryHash],bump:derive('seeker_registry')[1]},
  term:{version:1,config,registry,registry_hash:[...registryHash],round:0n,previous:null as PublicKey|null,auction_start:auctionStart,auction_end:operatingStart,operating_start:operatingStart,operating_end:operatingEnd,opened:[...full],settled:[...full],completed_count:P.totalSpots as number,winner_count:2,completed_at:completedAt as bigint|null,completed_slot:1099n as bigint|null,bump:derive('seeker_term',config.toBuffer(),le(0n))[1]},
  auctions:entries.map(entry=>{const address=seekerAuctionPda(program,config,entry.spotId,0n),vault=getAssociatedTokenAddressSync(mint,address,true),winner=entry.spotId===0?seller:entry.spotId===1?developer:null;
   const terms={...entry,config,term,auction:address,registry,registryHash,round:0n,auctionStart,auctionEnd:operatingStart,operatingStart,operatingEnd,mint,tokenProgram:TOKEN_PROGRAM_ID,vault,prizeOwner,prizeAta,prizeBps:A.prizeBps,grace:BigInt(A.settlementGraceSec),openingBid:opening,registryVersion:1,auctionFormat:1,termsFormat:1};
   return {address,fields:{version:1,config,term,registry,spot:{id:entry.spotId,class:entry.class as number,realm_mask:entry.realmMask},round:0n,auction_start:auctionStart,auction_end:operatingStart,operating_start:operatingStart,operating_end:operatingEnd,terms_hash:[...hashSeekerAuctionTerms(terms)],vault,high_bid:winner?opening:0n,high_bidder:winner,outstanding_escrow:0n,settled:true,result_owner:winner,settled_at:completedAt as bigint|null,settled_slot:BigInt(1000+entry.spotId) as bigint|null,bump:derive('auction',config.toBuffer(),Buffer.of(entry.spotId),le(0n))[1]}};
  }),
  saleConfig:{version:S.version,authority,developer,price_lamports:BigInt(P.permitPriceLamports),duration_sec:BigInt(P.permitDurationSec),seller_bps:P.contractSellerBps,developer_bps:P.contractDevBps,quota_max:P.paidContractsPerSpotDayMax,day_sec:BigInt(PHASE_E_MINING_PUBLICATION.daySec),quote_ttl_sec:BigInt(S.quoteTtlSec),bump:derive('realm_sale_config')[1]},
  access:{version:S.version,config:saleConfig,wallet:buyer,realm:0,expires_at:0n,bump:derive('realm_access',buyer.toBuffer(),Buffer.of(0))[1]},
  quota:{version:S.version,spot:0,day,sales:0,bump:derive('spot_sales',Buffer.of(0),le(day))[1]},
 };
 const store=new Map<string,AccountInfo<Buffer>>(),bodies=new Map<string,VersionedTransactionResponse>(),history=new Map<string,string>();
 const account=(data:Buffer,owner=program,executable=false,lamports=2_039_280):AccountInfo<Buffer>=>({data,owner,executable,lamports,rentEpoch:0});
 const programDataAddress=PublicKey.findProgramAddressSync([program.toBuffer()],LOADER)[0],programData=Buffer.alloc(49,7);programData.writeUInt32LE(3);programData.writeBigUInt64LE(100n,4);programData[12]=1;upgradeAuthority.toBuffer().copy(programData,13);
 const programBytes=Buffer.alloc(36);programBytes.writeUInt32LE(2);programDataAddress.toBuffer().copy(programBytes,4);
 store.set(program.toBase58(),account(programBytes,LOADER,true));store.set(programDataAddress.toBase58(),account(programData,LOADER));
 const deployment={programDataAddress:programDataAddress.toBase58(),programDataSha256:createHash('sha256').update(programData).digest('hex'),upgradeAuthority:upgradeAuthority.toBase58()};
 const termPolicy:ReviewedSeekerTermPolicy={programId:program,config,round:0n,mint,prizeOwner,prizeAta,genesisHash:genesis,stateProvenance:'fresh-reviewed-deployment',deployment};
 const accessTrust:SeekerRealmAccessTrust={programId:program,developer,expectedGenesisHash:genesis.toBase58(),reviewedDeploymentSlot:100,reviewedProgramDataSha256:deployment.programDataSha256,upgradeAuthority,stateProvenance:'fresh-reviewed-deployment'};
 async function pack(name:keyof typeof SEEKER_TERM_ACCOUNT_BYTES|keyof typeof REALM_SALE_ACCOUNT_BYTES,address:PublicKey,model:unknown){const encoded=await coder.encode(name,anchorValue(model) as object),size=name in SEEKER_TERM_ACCOUNT_BYTES?SEEKER_TERM_ACCOUNT_BYTES[name as keyof typeof SEEKER_TERM_ACCOUNT_BYTES]:REALM_SALE_ACCOUNT_BYTES[name as keyof typeof REALM_SALE_ACCOUNT_BYTES],data=Buffer.alloc(size);if(encoded.length>size)throw new Error('Fixture exceeds allocation');encoded.copy(data);store.set(address.toBase58(),account(data));}
 function clock(){const data=Buffer.alloc(40);data.writeBigUInt64LE(BigInt(controls.slot));data.writeBigInt64LE(controls.now,32);store.set(SYSVAR_CLOCK_PUBKEY.toBase58(),account(data,SYSVAR));}
 async function repack(){
  await pack('SeekerAuthority',authority,models.authority);await pack('AuctionConfig',config,models.config);await pack('SeekerRegistry',registry,models.registry);await pack('SeekerTerm',term,models.term);
  await pack('RealmSaleConfig',saleConfig,models.saleConfig);await pack('RealmAccess',access,models.access);await pack('SpotSalesQuota',quota,models.quota);
  store.set(buyer.toBase58(),account(Buffer.alloc(0),SystemProgram.programId,false,controls.balance));store.set(seller.toBase58(),account(Buffer.alloc(0),SystemProgram.programId));store.set(developer.toBase58(),account(Buffer.alloc(0),SystemProgram.programId));clock();
  bodies.clear();history.clear();const layout=idl.instructions.find(i=>i.name==='settle_auction')!;
  for(const row of models.auctions){await pack('Auction',row.address,row.fields);const winner=row.fields.result_owner,accounts=[settler.publicKey,config,term,row.address,mint,row.fields.vault,prizeAta,winner?seekerBidPda(program,row.address,winner):program,TOKEN_PROGRAM_ID];
   const message=new TransactionMessage({payerKey:settler.publicKey,recentBlockhash:key(12).toBase58(),instructions:[{programId:program,data:Buffer.from(layout.discriminator),keys:accounts.map((pubkey,i)=>({pubkey,isSigner:'signer'in layout.accounts[i]!&&layout.accounts[i]!.signer,isWritable:(i!==7||winner!==null)&&'writable'in layout.accounts[i]!&&layout.accounts[i]!.writable}))}]}).compileToLegacyMessage();
   const signed=new VersionedTransaction(message);signed.sign([settler]);const signatures=signed.signatures.map(s=>bs58.encode(s)),signature=signatures[0]!;
   bodies.set(signature,{slot:Number(row.fields.settled_slot),blockTime:null,version:'legacy',transaction:{message,signatures},meta:{err:null,fee:5_000,preBalances:[],postBalances:[],innerInstructions:[]}});history.set(row.address.toBase58(),signature);
  }
 }
 const reads:PublicKey[][]=[];
 const rpc:RealmSaleQuoteFixtureRpc={
  getGenesisHash:async()=>controls.genesisHash,getSlot:async()=>controls.slot,getBlockHeight:async()=>controls.blockHeight,
  getMultipleAccountsInfoAndContext:async(addresses)=>{if(addresses.length>100)throw new Error('Fixture RPC account bound');reads.push(addresses.map(a=>new PublicKey(a.toBytes())));await controls.beforeRead?.(addresses,reads.length-1);clock();const payer=store.get(buyer.toBase58());if(payer)payer.lamports=controls.balance;return {context:{slot:controls.slot},value:addresses.map(address=>{const row=store.get(address.toBase58());return row?{...row,address:new PublicKey(address.toBytes()),owner:new PublicKey(row.owner.toBytes()),data:Buffer.from(row.data)}:null;})};},
  getSignaturesForAddress:async address=>{const signature=history.get(address.toBase58()),tx=signature?bodies.get(signature):null;return signature&&tx?[{signature,slot:tx.slot,err:tx.meta?.err??null,memo:null,confirmationStatus:'finalized'}]:[];},
  getTransaction:(async(signature:string)=>bodies.get(signature)??null) as SeekerTermRpc['getTransaction'],
  getBlock:(async(slot:number)=>({parentSlot:slot-1,blockTime:null,blockhash:key(13).toBase58(),previousBlockhash:key(14).toBase58(),transactions:[...bodies.values()].filter(tx=>tx.slot===slot)})) as unknown as SeekerTermRpc['getBlock'],
  getLatestBlockhashAndContext:async()=>({context:{slot:controls.slot},value:{blockhash:controls.blockhash,lastValidBlockHeight:controls.lastValidBlockHeight}}),
  getFeeForMessage:async()=>{await controls.onFee?.();return {context:{slot:controls.slot},value:controls.fee};},
  getMinimumBalanceForRentExemption:async()=>{await controls.onRent?.();return controls.rent;},
 };
 await repack();
 return {termPolicy,accessTrust,buyer,seller,developer,store,models,repack,rpc,controls,reads,bodies,history,programData,programDataAddress,upgradeAuthority,addresses:{authority,config,registry,term,saleConfig,access,quota}};
}
