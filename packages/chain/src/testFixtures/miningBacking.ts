/** Test-only raw IDL/SPL account fixture. No production subpath export or semantic
 * verifier mock: consumers inject these serialized accounts into real readers. */
import { createHash } from 'node:crypto';
import anchorPkg,{type Idl} from '@coral-xyz/anchor';
import { PublicKey,SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';
import { AccountLayout,MintLayout,ACCOUNT_SIZE,MINT_SIZE,TOKEN_PROGRAM_ID,getAssociatedTokenAddressSync } from '@solana/spl-token';
import { TOKEN,PHASE_E_MINING_PUBLICATION as POLICY } from '@shardkeep/shared';
import idl from '../idl/shardkeep_economy.json' with {type:'json'};
import { miningConfigPda } from '../miningProgramProtocol';
import type { MiningBackingReader } from '../miningBackingSnapshot';
import { decodeProgramDataUpgradeAuthority } from '../registryAttestation';
const {BN,BorshCoder}=anchorPkg,coder=new BorshCoder(idl as Idl),pk=(n:number)=>new PublicKey(Buffer.alloc(32,n)),zero=PublicKey.default;
function bn(v:unknown):unknown{if(typeof v==='bigint')return new BN(v.toString());if(v instanceof PublicKey)return v;if(v instanceof Uint8Array)return [...v];if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,bn(x)]));return v;}
export interface MiningBackingFixtureOptions {
 genesisHash?:PublicKey; programId?:PublicKey; programData?:Buffer; programDataAddress?:PublicKey;
 upgradeAuthority?:PublicKey|null; day?:string; virginConfig?:boolean; budgetGross?:bigint;
}
export async function createMiningBackingFixture(options:MiningBackingFixtureOptions={}){
 const parsedDay=options.day===undefined?null:new Date(`${options.day}T00:00:00.000Z`);
 if(parsedDay&&(!Number.isFinite(+parsedDay)||parsedDay.toISOString().slice(0,10)!==options.day))throw new Error('Invalid fixture day');
 const day=parsedDay?BigInt(+parsedDay/(POLICY.daySec*1000)):100n;
 const virgin=options.virginConfig===true;
 if(options.budgetGross!==undefined&&(options.budgetGross<0n||options.budgetGross>((1n<<64n)-1n)-1000n))throw new Error('Invalid fixture budget');
 const identity={programId:options.programId??new PublicKey(idl.address),keepMint:pk(1),reserveOwner:pk(2)},genesis=options.genesisHash??pk(3),loader=new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
 const config=miningConfigPda(identity.programId),[authority,authorityBump]=PublicKey.findProgramAddressSync([Buffer.from('seeker_authority')],identity.programId),pdAddress=PublicKey.findProgramAddressSync([identity.programId.toBuffer()],loader)[0];
 if(options.programDataAddress&&!options.programDataAddress.equals(pdAddress))throw new Error('Noncanonical fixture ProgramData');
 const vault=getAssociatedTokenAddressSync(identity.keepMint,config,true),reserve=getAssociatedTokenAddressSync(identity.keepMint,identity.reserveOwner,true);
 const model={version:1,authority,publisher:pk(4),keep_mint:identity.keepMint,mining_vault:vault,emission_reserve_owner:identity.reserveOwner,emission_reserve_ata:reserve,decimals:TOKEN.decimals,genesis_day:99n,latest_day:100n,latest_sequence:1n,total_published:80n,total_published_highwater:80n,total_claimed:30n,tax_highwater:10n,tax_paid:0n,recycled_total:10n,gross_published:100n,split_cursor:0,flags:35,correction_pending:false,bump:PublicKey.findProgramAddressSync([Buffer.from('economy')],identity.programId)[1]};
 if(virgin)Object.assign(model,{genesis_day:day,latest_day:day-1n,latest_sequence:0n,total_published:0n,total_published_highwater:0n,total_claimed:0n,tax_highwater:0n,tax_paid:0n,recycled_total:0n,gross_published:0n});
 else if(parsedDay)Object.assign(model,{genesis_day:day-1n,latest_day:day});
 const vaultAmount=options.budgetGross===undefined?100n:options.budgetGross+(virgin?0n:60n);
 const token=(owner:PublicKey,amount:bigint)=>{const b=Buffer.alloc(ACCOUNT_SIZE);AccountLayout.encode({mint:identity.keepMint,owner,amount,delegateOption:0,delegate:zero,state:1,isNativeOption:0,isNative:0n,delegatedAmount:0n,closeAuthorityOption:0,closeAuthority:zero},b);return b;};
 const mint=Buffer.alloc(MINT_SIZE);MintLayout.encode({mintAuthorityOption:0,mintAuthority:zero,supply:vaultAmount>990n?vaultAmount+1000n:1000n,decimals:TOKEN.decimals,isInitialized:true,freezeAuthorityOption:0,freezeAuthority:zero},mint);
 const pd=options.programData?Buffer.from(options.programData):Buffer.alloc(50);
 if(!options.programData){pd.writeUInt32LE(3);pd.writeBigUInt64LE(90n,4);pd[49]=7;if(options.upgradeAuthority){pd[12]=1;options.upgradeAuthority.toBuffer().copy(pd,13);}}
 const actualAuthority=decodeProgramDataUpgradeAuthority(pd);
 if(options.upgradeAuthority!==undefined&&(actualAuthority?.toBase58()??null)!==(options.upgradeAuthority?.toBase58()??null))throw new Error('Fixture upgrade authority mismatch');
 const deployedSlot=Number(pd.readBigUInt64LE(4));if(!Number.isSafeInteger(deployedSlot)||deployedSlot<0||deployedSlot>Number.MAX_SAFE_INTEGER-110)throw new Error('Invalid fixture deployment slot');
 const contextSlot=Math.max(150,deployedSlot+60),program=Buffer.alloc(36);program.writeUInt32LE(2);pdAddress.toBuffer().copy(program,4);
 const auth={version:1,admin:pk(5),pending_admin:null,guardian:pk(6),current_policy_key:pk(7),previous_policy_key:null,previous_valid_until:0n,cluster_genesis:genesis.toBytes(),admission_paused:true,bump:authorityBump};
 const authorityBytes=Buffer.alloc(213,19);(await coder.accounts.encode('SeekerAuthority',bn(auth) as object)).copy(authorityBytes);
 const clock=Buffer.alloc(40);clock.writeBigUInt64LE(BigInt(contextSlot));clock.writeBigInt64LE((day+1n)*BigInt(POLICY.daySec),32);
 const rows=[{address:config,owner:identity.programId,executable:false,data:await coder.accounts.encode('EconomyConfig',bn(model) as object)},
  {address:vault,owner:TOKEN_PROGRAM_ID,executable:false,data:token(config,vaultAmount)},{address:reserve,owner:TOKEN_PROGRAM_ID,executable:false,data:token(identity.reserveOwner,10n)},
  {address:identity.keepMint,owner:TOKEN_PROGRAM_ID,executable:false,data:mint},{address:identity.programId,owner:loader,executable:true,data:program},{address:pdAddress,owner:loader,executable:false,data:pd},
  {address:authority,owner:identity.programId,executable:false,data:authorityBytes},{address:SYSVAR_CLOCK_PUBKEY,owner:new PublicKey('Sysvar1111111111111111111111111111111111111'),executable:false,data:clock}];
 let calls=0;const reader:MiningBackingReader={getGenesisHash:async()=>genesis.toBase58(),getSlot:async()=>calls++%2?contextSlot+50:contextSlot-50,getMultipleAccountsInfoAndContext:async()=>({context:{slot:contextSlot},value:rows})};
 const trust={...identity,expectedGenesisHash:genesis.toBase58(),reviewedDeploymentSlot:deployedSlot,reviewedProgramDataSha256:createHash('sha256').update(pd).digest('hex')};
 return {rows,model,auth,trust,reader,programData:pd,programDataAddress:pdAddress,upgradeAuthority:actualAuthority,async config(){rows[0]!.data=await coder.accounts.encode('EconomyConfig',bn(model) as object);},async authority(){const data=Buffer.alloc(213);(await coder.accounts.encode('SeekerAuthority',bn(auth) as object)).copy(data);rows[6]!.data=data;}};
}
