/** Test-only serialized fourteen-account bank; no semantic reader replacement. */
import anchorPkg,{type Idl} from '@coral-xyz/anchor';
import { Keypair,PublicKey,SystemProgram } from '@solana/web3.js';
import { AccountLayout,ACCOUNT_SIZE,TOKEN_PROGRAM_ID,getAssociatedTokenAddressSync } from '@solana/spl-token';
import { PHASE_E_MINING_PUBLICATION as POLICY } from '@shardkeep/shared';
import idl from '../idl/shardkeep_economy.json' with {type:'json'};
import { buildMiningAllocationTree } from '../miningAllocationProof';
import { miningConfigPda,miningRootPda,miningEpochPda,minerClaimPda,renownRecordPda } from '../miningProgramProtocol';
import { createMiningBackingFixture } from './miningBacking';
import type { MiningClaimRawAccount,MiningClaimSnapshotReader } from '../miningClaimSnapshot';
const {BN,BorshCoder}=anchorPkg,coder=new BorshCoder(idl as Idl);
function bn(v:unknown):unknown{if(typeof v==='bigint')return new BN(v.toString());if(v instanceof PublicKey)return v;if(v instanceof Uint8Array)return [...v];if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,bn(x)]));return v;}
export async function createMiningClaimFixture(options:{wallet?:PublicKey;day?:string}={}){
 const backing=await createMiningBackingFixture(options.day?{day:options.day}:{}),wallet=options.wallet??Keypair.generate().publicKey,p=backing.trust.programId;
 backing.model.total_claimed=0n;backing.model.flags=0;await backing.config();
 const day=backing.model.latest_day,sequence=1n,config=miningConfigPda(p),epochAddress=miningEpochPda(p,day),rootAddress=miningRootPda(p,sequence),minerAddress=minerClaimPda(p,wallet),renownAddress=renownRecordPda(p,wallet),ata=getAssociatedTokenAddressSync(backing.trust.keepMint,wallet,true);
 const leaf={wallet:wallet.toBase58(),cumulativeKeep:80n,cumulativeRenown:0n,cumulativeDays:0n,sequence},tree=buildMiningAllocationTree([leaf]);
 const bump=(seed:string,tail:Buffer)=>PublicKey.findProgramAddressSync([Buffer.from(seed),tail],p)[1],le=(v:bigint)=>{const b=Buffer.alloc(8);b.writeBigUInt64LE(v);return b;};
 const fundedAt=(day+1n)*BigInt(POLICY.daySec);
 const root={version:1,config,epoch:epochAddress,sequence,day,prev_day:day-1n,prev_total:0n,root:tree.root,total_cumulative:80n,leaf_count:1,claims_count:0n,published_at:fundedAt,revoked:false,kind:0,bump:bump('alloc',le(sequence))};
 const epoch={version:1,config,day,budget_gross:100n,free_gross:5n,deed_gross:95n,player_net:80n,tax:10n,recycle:10n,source_hash:Buffer.alloc(32,4),tax_commitment:Buffer.alloc(32,5),tax_version:1,split_start:0,split_end:0,funded_at:fundedAt,bump:bump('mining_epoch',le(day))};
 const miner={wallet,claimed_total:0n,last_sequence:0n,last_claim_at:0n,version:1,bump:bump('miner',wallet.toBuffer())};
 const renown={wallet,renown_total:0n,days_attested:0n,last_sequence:0n,synced_at:0n,version:1,bump:bump('renown',wallet.toBuffer())};
 const raw=async(address:PublicKey,name:string,model:object):Promise<MiningClaimRawAccount>=>({address,owner:p,executable:false,data:await coder.accounts.encode(name,bn(model) as object)});
 const ataBytes=Buffer.alloc(ACCOUNT_SIZE);AccountLayout.encode({mint:backing.trust.keepMint,owner:wallet,amount:0n,delegateOption:0,delegate:PublicKey.default,state:1,isNativeOption:0,isNative:0n,delegatedAmount:0n,closeAuthorityOption:0,closeAuthority:PublicKey.default},ataBytes);
 const rows:(MiningClaimRawAccount|null)[]=[...backing.rows,await raw(rootAddress,'AllocationRoot',root),await raw(epochAddress,'MiningEpochReceipt',epoch),null,null,{address:ata,owner:TOKEN_PROGRAM_ID,executable:false,data:ataBytes},{address:wallet,owner:SystemProgram.programId,executable:false,data:Buffer.alloc(0),lamports:1_000_000_000}];
 backing.rows[7]!.data.writeBigInt64LE(fundedAt+BigInt(POLICY.claimDelaySec),32);
 let reads=0;const reader:MiningClaimSnapshotReader={getGenesisHash:backing.reader.getGenesisHash,getSlot:async()=>150,getMultipleAccountsInfoAndContext:async()=>{reads++;return {context:{slot:150},value:rows};}};
 return {backing,trust:backing.trust,rows,root,epoch,miner,renown,leaf,tree,reader,request:{wallet,sequence,day},readCount:()=>reads,
  async encodeRoot(){rows[8]=await raw(rootAddress,'AllocationRoot',root);},async encodeEpoch(){rows[9]=await raw(epochAddress,'MiningEpochReceipt',epoch);},
  async records(){rows[10]=await raw(minerAddress,'MinerClaim',miner);rows[11]=await raw(renownAddress,'RenownRecord',renown);},
  clock(at:bigint){backing.rows[7]!.data.writeBigInt64LE(at,32);}};
}
