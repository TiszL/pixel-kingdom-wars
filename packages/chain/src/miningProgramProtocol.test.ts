import { describe,it,expect } from 'vitest';
import anchorPkg,{type Idl} from '@coral-xyz/anchor';
import { PublicKey,SystemProgram } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID,getAssociatedTokenAddressSync } from '@solana/spl-token';
import idl from './idl/shardkeep_economy.json' with { type:'json' };
import { buildMiningAllocationTree,encodeMiningAllocationProof } from './miningAllocationProof';
import { miningConfigPda,miningRootPda,miningEpochPda,minerClaimPda,renownRecordPda,decodeMiningConfig,decodeMiningRoot,decodeMiningEpoch,decodeMinerClaim,decodeRenownRecord,miningLiabilityFloor,
 buildPublishMiningInstruction,buildCorrectMiningInstruction,buildRevokeMiningInstruction,buildClaimMiningInstruction,buildSyncRenownInstruction,buildOpenMinerRecordsInstruction,MINING_ACCOUNT_BYTES } from './miningProgramProtocol';
const {BN,BorshCoder}=anchorPkg,coder=new BorshCoder(idl as Idl),pk=(n:number)=>new PublicKey(Buffer.alloc(32,n));
const identity={programId:new PublicKey(idl.address),keepMint:pk(1),reserveOwner:pk(2)},wallet=pk(3),admin=pk(4),sequence=3n,day=100n;
const authority=PublicKey.findProgramAddressSync([Buffer.from('seeker_authority')],identity.programId)[0];
const config=miningConfigPda(identity.programId),epoch=miningEpochPda(identity.programId,day),root=miningRootPda(identity.programId,sequence);
const hash=Uint8Array.from({length:32},(_,i)=>i+1);
const leaf={wallet:wallet.toBase58(),sequence,cumulativeKeep:80n,cumulativeRenown:1n,cumulativeDays:2n};
const publish={sequence,day,kind:0 as const,root:hash,totalCumulative:80n,leafCount:1,budgetGross:100n,freeGross:5n,deedGross:95n,sourceHash:hash,taxCommitment:hash,taxVersion:1};
function bn(value:unknown):unknown{if(typeof value==='bigint')return new BN(value.toString());if(value instanceof PublicKey)return value;if(value instanceof Uint8Array)return [...value];if(Array.isArray(value))return value.map(bn);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,bn(v)]));return value;}
async function raw(name:string,address:PublicKey,model:object){return {address,owner:identity.programId,executable:false,data:await coder.accounts.encode(name,bn(model) as object)};}
function bump(seed:string,tail?:Buffer){return PublicKey.findProgramAddressSync([Buffer.from(seed),...(tail?[tail]:[])],identity.programId)[1];}
const le=(n:bigint)=>{const b=Buffer.alloc(8);b.writeBigUInt64LE(n);return b;};
const configModel={version:1,authority,publisher:admin,keep_mint:identity.keepMint,mining_vault:getAssociatedTokenAddressSync(identity.keepMint,config,true),emission_reserve_owner:identity.reserveOwner,emission_reserve_ata:getAssociatedTokenAddressSync(identity.keepMint,identity.reserveOwner,true),decimals:9,genesis_day:99n,latest_day:100n,latest_sequence:3n,total_published:80n,total_published_highwater:80n,total_claimed:30n,tax_highwater:10n,tax_paid:0n,recycled_total:10n,gross_published:100n,split_cursor:0,flags:35,correction_pending:false,bump:bump('economy')};
const rootModel={version:1,config,epoch,sequence,day,prev_day:99n,prev_total:0n,root:hash,total_cumulative:80n,leaf_count:1,claims_count:0n,published_at:1000n,revoked:false,kind:0,bump:bump('alloc',le(sequence))};
const epochModel={version:1,config,day,budget_gross:100n,free_gross:5n,deed_gross:95n,player_net:80n,tax:10n,recycle:10n,source_hash:hash,tax_commitment:hash,tax_version:1,split_start:0,split_end:0,funded_at:1000n,bump:bump('mining_epoch',le(day))};
describe('mining program protocol matches the implemented IDL',()=>{
 it('cross-decodes exact config/root/immutable epoch and retains checked independent liabilities',async()=>{
  const c=decodeMiningConfig(await raw('EconomyConfig',config,configModel),identity);expect(c.keepMint).toBe(identity.keepMint.toBase58());expect(miningLiabilityFloor(c)).toBe(60n);expect(Object.isFrozen(c)).toBe(true);
  expect(decodeMiningRoot(await raw('AllocationRoot',root,rootModel),{programId:identity.programId,sequence})).toMatchObject({sequence,day,root:Buffer.from(hash).toString('hex'),revoked:false});
  expect(decodeMiningEpoch(await raw('MiningEpochReceipt',epoch,epochModel),{programId:identity.programId,day})).toMatchObject({budgetGross:100n,sourceHash:Buffer.from(hash).toString('hex'),tax:10n});
 });
 it('decodes permanent wallet records with exact wallet PDA binding and signed timestamps',async()=>{
  const miner=await raw('MinerClaim',minerClaimPda(identity.programId,wallet),{wallet,claimed_total:30n,last_sequence:2n,last_claim_at:-1n,version:1,bump:bump('miner',wallet.toBuffer())});
  expect(decodeMinerClaim(miner,{programId:identity.programId,wallet})).toMatchObject({wallet:wallet.toBase58(),claimedTotal:30n,lastClaimAt:-1n});
  const renown=await raw('RenownRecord',renownRecordPda(identity.programId,wallet),{wallet,renown_total:1n,days_attested:2n,last_sequence:2n,synced_at:1000n,version:1,bump:bump('renown',wallet.toBuffer())});
  expect(decodeRenownRecord(renown,{programId:identity.programId,wallet})).toMatchObject({renownTotal:1n,daysAttested:2n});
  expect(()=>decodeMinerClaim(miner,{programId:identity.programId,wallet:admin})).toThrow();
 });
 it.each(['owner','address','executable','short','trailing','discriminator','boolean','version','bump','mint','reserve','vault'] as const)('rejects malformed or substituted config %s',async kind=>{
  const model={...configModel};if(kind==='version')model.version=2;if(kind==='bump')model.bump^=1;if(kind==='mint')model.keep_mint=pk(8);if(kind==='reserve')model.emission_reserve_ata=pk(8);if(kind==='vault')model.mining_vault=pk(8);
  const a=await raw('EconomyConfig',config,model);if(kind==='owner')a.owner=pk(8);if(kind==='address')a.address=pk(8);if(kind==='executable')a.executable=true;if(kind==='short')a.data=a.data.subarray(0,-1);if(kind==='trailing')a.data=Buffer.concat([a.data,Buffer.of(0)]);if(kind==='discriminator')a.data[0]=a.data[0]!^1;if(kind==='boolean')a.data[a.data.length-2]=2;
  expect(()=>decodeMiningConfig(a,identity)).toThrow();
 });
 it('pins root sequence/epoch/config and epoch day without treating old/revoked evidence as absent',async()=>{
  expect(()=>decodeMiningRoot({address:root,owner:identity.programId,executable:false,data:Buffer.alloc(MINING_ACCOUNT_BYTES.AllocationRoot)},{programId:identity.programId,sequence})).toThrow();
  for(const model of [{...rootModel,epoch:pk(9)},{...rootModel,config:pk(9)},{...rootModel,sequence:4n}]){const a=await raw('AllocationRoot',root,model);expect(()=>decodeMiningRoot(a,{programId:identity.programId,sequence})).toThrow();}
  const revoked=await raw('AllocationRoot',root,{...rootModel,revoked:true});expect(decodeMiningRoot(revoked,{programId:identity.programId,sequence}).revoked).toBe(true);
  const e=await raw('MiningEpochReceipt',epoch,epochModel);expect(()=>decodeMiningEpoch(e,{programId:identity.programId,day:101n})).toThrow();
 });
 it('refuses either paid counter exceeding its highwater and sum overflow',()=>{
  expect(()=>miningLiabilityFloor({totalPublishedHighwater:1n,totalClaimed:2n,taxHighwater:0n,taxPaid:0n})).toThrow();
  expect(()=>miningLiabilityFloor({totalPublishedHighwater:1n,totalClaimed:0n,taxHighwater:0n,taxPaid:1n})).toThrow();
  expect(()=>miningLiabilityFloor({totalPublishedHighwater:(1n<<64n)-1n,totalClaimed:0n,taxHighwater:1n,taxPaid:0n})).toThrow();
 });
 it('uses the exact IDL instruction order, flags and full funded publication payload',()=>{
  const ix=buildPublishMiningInstruction(identity,{signer:admin,args:publish}),decoded=coder.instruction.decode(ix.data)!;expect(decoded.name).toBe('publish_allocation_root');
  expect(ix.data).toEqual(coder.instruction.encode('publish_allocation_root',{args:bn({sequence,day,kind:0,root:hash,total_cumulative:80n,leaf_count:1,budget_gross:100n,free_gross:5n,deed_gross:95n,source_hash:hash,tax_commitment:hash,tax_version:1})}));
  expect(ix.keys.map(k=>k.pubkey.toBase58())).toEqual([admin,authority,config,root,epoch,identity.keepMint,getAssociatedTokenAddressSync(identity.keepMint,config,true),getAssociatedTokenAddressSync(identity.keepMint,identity.reserveOwner,true),TOKEN_PROGRAM_ID,SystemProgram.programId].map(k=>k.toBase58()));
  const entry=idl.instructions.find(i=>i.name===decoded.name)!;expect(ix.keys.map(k=>[k.isSigner,k.isWritable])).toEqual(entry.accounts.map(a=>['signer' in a&&a.signer===true,'writable' in a&&a.writable===true]));
 });
 it('encodes same-receipt correction/revoke with no mutable economic receipt arguments',()=>{
  const args={sequence:4n,root:hash,totalCumulative:80n,leafCount:2,kind:2 as const};const corrected=buildCorrectMiningInstruction(identity,{signer:admin,revokedSequence:sequence,day,args});
  expect(corrected.data).toEqual(coder.instruction.encode('correct_allocation_root',{args:bn({sequence:4n,root:hash,total_cumulative:80n,leaf_count:2,kind:2})}));
  expect(corrected.keys[3]!.pubkey.equals(root)).toBe(true);expect(corrected.keys[4]!.pubkey.equals(epoch)).toBe(true);expect(corrected.keys[5]!.pubkey.equals(miningRootPda(identity.programId,4n))).toBe(true);
  expect(buildRevokeMiningInstruction({programId:identity.programId},{admin,sequence}).data).toEqual(coder.instruction.encode('revoke_allocation_root',{}));
 });
 it('encodes actual proof fields and exact maximum-depth bytes for claim and permissionless Renown',()=>{
  const tree=buildMiningAllocationTree([leaf,{...leaf,wallet:admin.toBase58()}]),proof=tree.proof(0),chosen=tree.leaves[0]!;
  const ix=buildClaimMiningInstruction(identity,{leaf:chosen,proof});expect(coder.instruction.decode(ix.data)!.name).toBe('claim_mining');expect(ix.data.subarray(8+32)).toEqual(Buffer.from(encodeMiningAllocationProof(proof)));
  const decoded=coder.instruction.decode(ix.data)!.data as {proof:{sum:InstanceType<typeof BN>;is_left:boolean}[]};expect(decoded.proof[0]!.sum.toString()).toBe('80');expect(decoded.proof[0]!.is_left).toBe(proof[0]!.isLeft);
  const max=Array.from({length:16},()=>({hash,sum:0n,isLeft:false}));expect(buildClaimMiningInstruction(identity,{leaf,proof:max}).data.length).toBe(8+32+4+16*41);
  const sync=buildSyncRenownInstruction({programId:identity.programId},{payer:admin,leaf,proof});expect(sync.data.subarray(8+32+32)).toEqual(Buffer.from(encodeMiningAllocationProof(proof)));
  expect(sync.keys[0]!.pubkey.equals(admin)).toBe(true);expect(sync.keys[3]!.pubkey.equals(minerClaimPda(identity.programId,wallet))).toBe(true);
  expect(coder.instruction.decode(buildOpenMinerRecordsInstruction({programId:identity.programId},{payer:admin,wallet}).data)!.name).toBe('open_miner_records');
 });
 it('refuses malformed proof/width/domain inputs before building anything',()=>{
  expect(()=>buildClaimMiningInstruction(identity,{leaf,proof:Array(17).fill({hash,sum:0n,isLeft:false})})).toThrow();
  expect(()=>buildClaimMiningInstruction(identity,{leaf,proof:[{hash,sum:0n,isLeft:2 as unknown as boolean}]})).toThrow();
  expect(()=>buildClaimMiningInstruction(identity,{leaf:{...leaf,cumulativeKeep:-1n},proof:[]})).toThrow();
  expect(()=>buildPublishMiningInstruction(identity,{signer:admin,args:{...publish,kind:1 as 0}})).toThrow();
  expect(()=>buildPublishMiningInstruction({...identity,programId:pk(9)},{signer:admin,args:publish})).toThrow();
  expect(()=>buildPublishMiningInstruction(identity,{signer:admin,args:{...publish,budgetGross:1n<<64n}})).toThrow();
  expect(()=>buildCorrectMiningInstruction(identity,{signer:admin,revokedSequence:sequence,day,args:{sequence,root:hash,totalCumulative:80n,leafCount:1,kind:0}})).toThrow();
 });
 it('preserves full-width unsigned counters and signed timestamps while normalizing Anchor BN values',async()=>{
  const max=(1n<<64n)-1n,min=-(1n<<63n);
  const miner=await raw('MinerClaim',minerClaimPda(identity.programId,wallet),{wallet,claimed_total:max,last_sequence:max,last_claim_at:min,version:1,bump:bump('miner',wallet.toBuffer())});
  const decoded=decodeMinerClaim(miner,{programId:identity.programId,wallet});
  expect(decoded).toMatchObject({wallet:wallet.toBase58(),claimedTotal:max,lastSequence:max,lastClaimAt:min});
  expect(typeof decoded.claimedTotal).toBe('bigint');expect(Object.isFrozen(decoded)).toBe(true);
 });
});
