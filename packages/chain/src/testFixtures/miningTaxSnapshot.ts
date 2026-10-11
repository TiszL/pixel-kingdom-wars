/** Injected finalized bank and signed settlement bodies, using actual IDL/SPL bytes. */
import anchorPkg,{type Idl} from '@coral-xyz/anchor';
import {Keypair,PublicKey,SystemProgram,SYSVAR_CLOCK_PUBKEY,type AccountInfo} from '@solana/web3.js';
import {AccountLayout,ACCOUNT_SIZE,TOKEN_PROGRAM_ID,getAssociatedTokenAddressSync} from '@solana/spl-token';
import {PHASE_E_MINING_PUBLICATION as P,PHASE_E_POLICY} from '@shardkeep/shared';
import idl from '../idl/shardkeep_economy.json' with {type:'json'};
import {createMiningBackingFixture} from './miningBacking';
import {createMiningTermFixture} from './miningZeroWinnerTerm';
import {miningConfigPda,miningEpochPda} from '../miningProgramProtocol';
import {seekerTermPda,seekerRegistryPda,seekerAuctionPda,hashSeekerRegistry,canonicalSeekerRegistry} from '../seekerAuctionProtocol';
import {hashMiningTermTaxIdentity,hashMiningTaxCommitment,miningTermTaxPoolPda,miningTaxEpochReceiptPda,miningTaxSpotCursorPda} from '../miningTaxProtocol';
import type {MiningTaxSnapshotRpc} from '../miningTaxSnapshot';
const {BN,BorshCoder}=anchorPkg,coder=new BorshCoder(idl as Idl);
function bn(v:unknown):unknown{if(typeof v==='bigint')return new BN(v.toString());if(v instanceof PublicKey)return v;if(v instanceof Uint8Array)return [...v];if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,bn(x)]));return v;}
export async function createMiningTaxSnapshotFixture(options:{zeroWinners?:boolean;wallet?:PublicKey;claimReserve?:boolean;genesisHash?:PublicKey}={}){
 const wallet=options.wallet??Keypair.generate().publicKey,other=Keypair.generate().publicKey,dayText='2020-01-01';
 const backing=await createMiningBackingFixture({day:dayText,...(options.genesisHash?{genesisHash:options.genesisHash}:{})});
 if(options.claimReserve){backing.trust.reserveOwner=wallet;backing.model.emission_reserve_owner=wallet;backing.model.emission_reserve_ata=getAssociatedTokenAddressSync(backing.trust.keepMint,wallet,true);backing.rows[2]!.address=backing.model.emission_reserve_ata;const token=AccountLayout.decode(backing.rows[2]!.data);AccountLayout.encode({...token,owner:wallet},backing.rows[2]!.data);await backing.config();}
 const seeker=await createMiningTermFixture({day:dayText,programId:backing.trust.programId,genesisHash:new PublicKey(backing.trust.expectedGenesisHash),programData:backing.programData,programDataAddress:backing.programDataAddress,upgradeAuthority:backing.upgradeAuthority,winners:options.zeroWinners?[]:[{spotId:0,wallet},{spotId:20,wallet},{spotId:21,wallet:other}]});
 const p=backing.trust.programId,config=miningConfigPda(p),day=backing.model.latest_day,sec=BigInt(P.daySec),spot=0;
 const termAccount=seeker.store.get(seekerTermPda(p,seeker.policy.config,0n).toBase58())!;
 const tm=coder.accounts.decode('SeekerTerm',termAccount.data);
 const term={programId:p,config,keepMint:backing.trust.keepMint,auctionConfig:seeker.policy.config,term:seekerTermPda(p,seeker.policy.config,0n),registry:seekerRegistryPda(p),registryHash:hashSeekerRegistry(canonicalSeekerRegistry()),round:0n,auctionStart:BigInt(tm.auction_start.toString()),auctionEnd:BigInt(tm.auction_end.toString()),operatingStart:BigInt(tm.operating_start.toString()),operatingEnd:BigInt(tm.operating_end.toString()),winnerCount:3};
 const pool=miningTermTaxPoolPda(p,term.term),epoch=miningEpochPda(p,day),accrual=miningTaxEpochReceiptPda(p,epoch),cursor=miningTaxSpotCursorPda(p,pool,spot),ata=getAssociatedTokenAddressSync(backing.trust.keepMint,wallet,true);
 const bump=(seed:string,...tails:Buffer[])=>PublicKey.findProgramAddressSync([Buffer.from(seed),...tails],p)[1],le=Buffer.alloc(8);le.writeBigUInt64LE(day);
 Object.assign(backing.model,{tax_highwater:10n,tax_paid:3n,flags:0});await backing.config();
 const models={pool:{version:2,distribution_version:1,config,term:term.term,term_identity:hashMiningTermTaxIdentity(term),winner_count:3,accrued:10n,paid:3n,bump:bump('mining_tax_pool',config.toBuffer(),term.term.toBuffer())},
  epoch:{version:1,config,day,budget_gross:100n,free_gross:5n,deed_gross:95n,player_net:80n,tax:10n,recycle:10n,source_hash:Buffer.alloc(32,4),tax_commitment:hashMiningTaxCommitment(term,{day,epoch}),tax_version:2,split_start:0,split_end:0,funded_at:(day+1n)*sec,bump:bump('mining_epoch',le)},
  accrual:{version:2,config,pool,epoch,amount:10n,accrued_at:(day+1n)*sec+BigInt(P.claimDelaySec),bump:bump('mining_tax_epoch',config.toBuffer(),epoch.toBuffer())},
  cursor:{version:2,pool,auction:seekerAuctionPda(p,seeker.policy.config,spot,0n),wallet,spot,claimed_total:3n,bump:bump('mining_tax_spot',pool.toBuffer(),Buffer.of(spot))}};
 const store=seeker.store,names={pool:'MiningTaxPool',epoch:'MiningEpochReceipt',accrual:'MiningTaxAccrual',cursor:'MiningTaxSpot'} as const,addresses={pool,epoch,accrual,cursor};
 function row(data:Buffer,owner=p,lamports=1):AccountInfo<Buffer>{return {data,owner,executable:false,lamports,rentEpoch:0};}
 async function encode(which:keyof typeof models){store.set(addresses[which].toBase58(),row(await coder.accounts.encode(names[which],bn(models[which]) as object)));}
 for(const r of backing.rows.slice(0,6))store.set(r.address.toBase58(),{...row(Buffer.from(r.data),r.owner),executable:r.executable});
 for(const k of Object.keys(models) as (keyof typeof models)[])await encode(k);
 const ataBytes=Buffer.alloc(ACCOUNT_SIZE);AccountLayout.encode({mint:backing.trust.keepMint,owner:wallet,amount:0n,delegateOption:0,delegate:PublicKey.default,state:1,isNativeOption:0,isNative:0n,delegatedAmount:0n,closeAuthorityOption:0,closeAuthority:PublicKey.default},ataBytes);
 if(!store.has(ata.toBase58()))store.set(ata.toBase58(),row(ataBytes,TOKEN_PROGRAM_ID));store.set(wallet.toBase58(),row(Buffer.alloc(0),SystemProgram.programId,1_000_000));
 const clock=store.get(SYSVAR_CLOCK_PUBKEY.toBase58())!.data;clock.writeBigInt64LE(term.operatingEnd+sec,32);
 const calls:{keys:PublicKey[];minContextSlot:number}[]=[];
 const rpc:MiningTaxSnapshotRpc={...seeker.rpc,getSlot:async()=>2000,getMultipleAccountsInfoAndContext:async(keys,options)=>{
  calls.push({keys:[...keys],minContextSlot:typeof options==='object'?options.minContextSlot??0:0});
  return {context:{slot:2000},value:keys.map(key=>{const r=store.get(key.toBase58());return r?{...r,data:Buffer.from(r.data)}:null;})};}};
 const {round:_,...seekerTrust}=seeker.policy;
 return {wallet,other,backing,seeker,term,models,addresses:{...addresses,ata},store,rpc,calls,encode,trust:{mining:backing.trust,seeker:seekerTrust},request:{wallet,round:0n,spot},clock,
  async config(){await backing.config();store.set(config.toBase58(),row(Buffer.from(backing.rows[0]!.data)));},
  async cursorFor(nextSpot:number){const next=miningTaxSpotCursorPda(p,pool,nextSpot);store.set(next.toBase58(),row(await coder.accounts.encode('MiningTaxSpot',bn({...models.cursor,spot:nextSpot,auction:seekerAuctionPda(p,seeker.policy.config,nextSpot,0n),claimed_total:0n,bump:bump('mining_tax_spot',pool.toBuffer(),Buffer.of(nextSpot))}) as object)));},
  operatingClock(){clock.writeBigInt64LE(day*sec+sec,32);},totalSpots:PHASE_E_POLICY.seekerIsland.totalSpots};
}
