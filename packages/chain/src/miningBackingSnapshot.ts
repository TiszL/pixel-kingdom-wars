/** Read-only same-bank mining solvency. The application owns RPC and reviewed
 * deployment configuration; these measurements do not authorize publication,
 * fair allocation, or claims, and never count reserve tokens twice as backing. */
import { createHash } from 'node:crypto';
import type {Idl} from '@coral-xyz/anchor';
import { anchorRuntime as anchorPkg } from './anchorRuntime';
import { PublicKey,SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';
import { AccountLayout,MintLayout,ACCOUNT_SIZE,MINT_SIZE,TOKEN_PROGRAM_ID,getAssociatedTokenAddressSync } from '@solana/spl-token';
import { TOKEN,PHASE_E_POLICY,PHASE_E_MINING_PUBLICATION } from '@shardkeep/shared';
import idl from './idl/shardkeep_economy.json' with {type:'json'};
import { decodeMiningConfig,miningConfigPda,miningLiabilityFloor,type MiningRawAccount } from './miningProgramProtocol';
import type { MiningPublicationReader,MiningPublicationTrust } from './miningPublicationReceipt';
import { decodeUpgradeableProgramDataAddress,decodeProgramDataUpgradeAuthority } from './registryAttestation';
import { SEEKER_TERM_ACCOUNT_BYTES } from './seekerTermAccounts';
const {BorshCoder}=anchorPkg,coder=new BorshCoder(idl as Idl);
const LOADER=new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'),SYSVAR=new PublicKey('Sysvar1111111111111111111111111111111111111');
const MAX_PROGRAM_DATA=8*1024*1024; // Bounded reviewed executable bytes, not a game limit.
type Code='INPUT'|'UNAVAILABLE'|'IDENTITY'|'DEPLOYMENT'|'ACCOUNTS'|'TOKEN'|'INSOLVENT';
export class MiningBackingSnapshotError extends Error {constructor(readonly code:Code){super(`Mining backing snapshot refused: ${code}`);this.name='MiningBackingSnapshotError';}}
function need(v:unknown,code:Code):asserts v{if(!v)throw new MiningBackingSnapshotError(code);}
function key(v:PublicKey):PublicKey{
 try{need(v&&typeof v.toBytes==='function'&&typeof v.toBase58==='function','INPUT');const b=v.toBytes();need(b instanceof Uint8Array&&b.length===32,'INPUT');const p=new PublicKey(b);need(p.toBase58()===v.toBase58(),'INPUT');return p;}
 catch{throw new MiningBackingSnapshotError('INPUT');}
}
function genesisKey(v:string):PublicKey{try{need(typeof v==='string'&&v.length<=44,'INPUT');const p=new PublicKey(v);need(p.toBase58()===v&&!p.equals(PublicKey.default),'INPUT');return p;}catch{throw new MiningBackingSnapshotError('INPUT');}}
const digest=(v:Uint8Array)=>createHash('sha256').update(v).digest('hex');
function slot(v:unknown):v is number{return typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;}
export type MiningBackingReader=Pick<MiningPublicationReader,'getGenesisHash'|'getSlot'|'getMultipleAccountsInfoAndContext'>;
export type MiningBackingTrust=MiningPublicationTrust;

export function createMiningBackingSnapshotReader(reader:MiningBackingReader,trust:MiningBackingTrust){
 const identity={programId:key(trust.programId),keepMint:key(trust.keepMint),reserveOwner:key(trust.reserveOwner)},genesis=genesisKey(trust.expectedGenesisHash);
 const deployment=trust.reviewedDeploymentSlot,programHash=trust.reviewedProgramDataSha256;
 need(slot(deployment)&&typeof programHash==='string'&&/^[0-9a-f]{64}$/.test(programHash),'INPUT');
 const configAddress=miningConfigPda(identity.programId),vault=getAssociatedTokenAddressSync(identity.keepMint,configAddress,true),reserve=getAssociatedTokenAddressSync(identity.keepMint,identity.reserveOwner,true);
 const pdAddress=PublicKey.findProgramAddressSync([identity.programId.toBuffer()],LOADER)[0],[authorityAddress,authorityBump]=PublicKey.findProgramAddressSync([Buffer.from('seeker_authority')],identity.programId);
 const addresses=[configAddress,vault,reserve,identity.keepMint,identity.programId,pdAddress,authorityAddress,SYSVAR_CLOCK_PUBKEY];
 return async function read(){
  try{
   need(await reader.getGenesisHash()===genesis.toBase58(),'IDENTITY');const before=await reader.getSlot('finalized');need(slot(before)&&before>=deployment,'DEPLOYMENT');
   const response=await reader.getMultipleAccountsInfoAndContext(addresses.map(key),{commitment:'finalized',minContextSlot:before});
   // Copy bounded raw rows before another await; source identity is not a mutable
   // reference to application configuration or a provider's reusable buffers.
   need(response&&slot(response.context?.slot)&&response.context.slot>=before&&Array.isArray(response.value)&&response.value.length===addresses.length,'ACCOUNTS');
   const observedSlot=response.context.slot;
   const sizes=[1024,ACCOUNT_SIZE,ACCOUNT_SIZE,MINT_SIZE,36,MAX_PROGRAM_DATA,SEEKER_TERM_ACCOUNT_BYTES.SeekerAuthority,40];
   const rows:MiningRawAccount[]=response.value.map((r,i)=>{need(r&&key(r.address).equals(addresses[i]!)&&r.data instanceof Uint8Array&&r.data.length<=sizes[i]!,'ACCOUNTS');return {address:key(r.address),owner:key(r.owner),executable:r.executable,data:Buffer.from(r.data)};});
   const after=await reader.getSlot('finalized');need(slot(after)&&after>=observedSlot,'ACCOUNTS');need(await reader.getGenesisHash()===genesis.toBase58(),'IDENTITY');
   const program=rows[4]!,pd=rows[5]!;
   need(program.owner.equals(LOADER)&&program.executable===true&&program.data.length===36&&decodeUpgradeableProgramDataAddress(Buffer.from(program.data)).equals(pdAddress),'DEPLOYMENT');
   need(pd.owner.equals(LOADER)&&pd.executable===false&&pd.data.length>=45,'DEPLOYMENT');const programBytes=Buffer.from(pd.data);decodeProgramDataUpgradeAuthority(programBytes);
   need(programBytes.readBigUInt64LE(4)===BigInt(deployment)&&digest(programBytes)===programHash,'DEPLOYMENT');
   const config=decodeMiningConfig(rows[0]!,identity);
   const auth=rows[6]!;need(auth.owner.equals(identity.programId)&&auth.executable===false&&auth.data.length===SEEKER_TERM_ACCOUNT_BYTES.SeekerAuthority,'IDENTITY');
   const authBytes=Buffer.from(auth.data),a=coder.accounts.decode('SeekerAuthority',authBytes),payload=coder.types.encode('SeekerAuthority',a);
   // Optional fields can shrink after rotation; old trailing allocation bytes
   // are not state. Round-trip the complete parsed payload to validate tags.
   need(authBytes.subarray(8,8+payload.length).equals(payload)&&a.version===1&&a.bump===authorityBump&&Buffer.from(a.cluster_genesis).equals(genesis.toBuffer()),'IDENTITY');
   const nonzero=(v:PublicKey)=>!key(v).equals(PublicKey.default);
   need(nonzero(a.admin)&&nonzero(a.guardian)&&nonzero(a.current_policy_key)
    &&(a.pending_admin===null||(nonzero(a.pending_admin)&&!a.pending_admin.equals(a.admin)))
    &&(a.previous_policy_key===null?a.previous_valid_until.isZero():nonzero(a.previous_policy_key)&&!a.previous_policy_key.equals(a.current_policy_key)),'IDENTITY');
   const mintRaw=rows[3]!;need(mintRaw.owner.equals(TOKEN_PROGRAM_ID)&&mintRaw.executable===false&&mintRaw.data.length===MINT_SIZE,'TOKEN');
   const mint=MintLayout.decode(Buffer.from(mintRaw.data));
   need(mintRaw.data[45]===1&&mint.decimals===TOKEN.decimals&&mint.mintAuthorityOption===0&&mint.freezeAuthorityOption===0,'TOKEN');
   const token=(raw:MiningRawAccount,owner:PublicKey)=>{
    need(raw.owner.equals(TOKEN_PROGRAM_ID)&&raw.executable===false&&raw.data.length===ACCOUNT_SIZE,'TOKEN');const t=AccountLayout.decode(Buffer.from(raw.data));
    need(t.mint.equals(identity.keepMint)&&t.owner.equals(owner)&&t.state===1&&t.delegateOption===0&&t.closeAuthorityOption===0&&t.isNativeOption===0&&t.delegatedAmount===0n,'TOKEN');return t.amount;
   };
   const vaultAmount=token(rows[1]!,configAddress),reserveAmount=token(rows[2]!,identity.reserveOwner);need(vaultAmount+reserveAmount<=mint.supply,'TOKEN');
   const clock=rows[7]!;need(clock.owner.equals(SYSVAR)&&clock.executable===false&&clock.data.length===40,'ACCOUNTS');const clockBytes=Buffer.from(clock.data),unixTimestamp=clockBytes.readBigInt64LE(32);
   need(clockBytes.readBigUInt64LE(0)===BigInt(observedSlot)&&unixTimestamp>=0n,'ACCOUNTS');const chainDay=unixTimestamp/BigInt(PHASE_E_MINING_PUBLICATION.daySec);
   need(config.genesisDay>0n&&config.genesisDay<=chainDay&&config.latestDay<=chainDay&&config.totalPublished<=config.totalPublishedHighwater,'ACCOUNTS');
   const totalOutstanding=miningLiabilityFloor(config),playerOutstanding=config.totalPublishedHighwater-config.totalClaimed,taxOutstanding=config.taxHighwater-config.taxPaid;
   need(vaultAmount>=totalOutstanding,'INSOLVENT');const availableBudget=vaultAmount-totalOutstanding,ceiling=BigInt(PHASE_E_POLICY.mining.grossDailyCeilingKeep)*10n**BigInt(TOKEN.decimals);
   return Object.freeze({version:1 as const,slot:observedSlot,unixTimestamp,chainDay,config,playerOutstanding,taxOutstanding,totalOutstanding,vaultAmount,reserveAmount,mintSupply:mint.supply,availableBudget,maximumEpochBudget:availableBudget<ceiling?availableBudget:ceiling,
    source:Object.freeze({trust:'trusted-finalized-rpc-reviewed-program' as const,genesisHash:genesis.toBase58(),programId:identity.programId.toBase58(),reviewedDeploymentSlot:deployment,reviewedProgramDataSha256:programHash,
     accounts:Object.freeze(rows.map(r=>Object.freeze({address:r.address.toBase58(),owner:r.owner.toBase58(),executable:r.executable,dataSha256:digest(r.data)})))}),
    publicationAuthorized:false as const,claimsAuthorized:false as const,scoreFairnessVerified:false as const});
  }catch(error){if(error instanceof MiningBackingSnapshotError)throw error;throw new MiningBackingSnapshotError('UNAVAILABLE');}
 };
}
export type MiningBackingSnapshot=Awaited<ReturnType<ReturnType<typeof createMiningBackingSnapshotReader>>>;
