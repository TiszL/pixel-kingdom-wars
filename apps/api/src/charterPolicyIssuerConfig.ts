/** Dedicated issuer settings and protected local secrets. No API/withdrawal
 * configuration, key generation or network calls belong in this loader. */
import {createPrivateKey,createPublicKey,sign,type KeyObject} from 'node:crypto';
import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import {isIP} from 'node:net';
import path from 'node:path';
import {PublicKey} from '@solana/web3.js';
import {SOLANA_GENESIS_HASH} from '@shardkeep/chain';
import type {CharterCreationEvidenceTrust,CharterCreationProgramTrust} from '@shardkeep/chain/charter-creation-evidence';
import {CharterIssuerError} from './charterPolicyIssuerJournal';
import {charterIssuerAuthToken} from './charterPolicyIssuerClient';
import type {SeekerAuctionReadTrust} from './seeker/auctionReadModel';

const CORE='CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d';
const fail=():never=>{throw new CharterIssuerError('CONFIGURATION');};
const required=(env:NodeJS.ProcessEnv,key:string)=>{const value=env['CHARTER_ISSUER_'+key]?.trim();return value||fail();};
const address=(value:string)=>{try{const key=new PublicKey(value);return key.toBase58()===value&&!key.equals(PublicKey.default)?value:fail();}catch{return fail();}};
const absolute=(value:string)=>path.isAbsolute(value)&&!value.includes('\0')?value:fail();
function cluster(env:NodeJS.ProcessEnv){const value=required(env,'CLUSTER');return value==='devnet'||value==='mainnet-beta'?value:fail();}
function loopback(host:string){return host==='localhost'||host==='::1'||host==='[::1]'||isIP(host)===4&&host.split('.')[0]==='127';}
function privateIp(host:string){const clean=host.replace(/^\[|\]$/g,'');if(loopback(clean))return true;
 if(isIP(clean)===6)return /^(fc|fd)/i.test(clean);
 if(isIP(clean)!==4)return false;const parts=clean.split('.').map(Number);return parts[0]===10||parts[0]===172&&parts[1]!>=16&&parts[1]!<=31||parts[0]===192&&parts[1]===168;
}
export function loadCharterIssuerJournalConfig(env:NodeJS.ProcessEnv){
 const selected=cluster(env);return Object.freeze({journalFile:absolute(required(env,'JOURNAL_FILE')),
  domain:Object.freeze({genesisHash:SOLANA_GENESIS_HASH[selected],economyProgram:address(required(env,'ECONOMY_PROGRAM_ID'))})});
}
interface IssuerSkrRegistry {readonly cluster?:unknown;readonly skrMint?:unknown;readonly skrDecimals?:unknown}
function seekerAuctionPins(env:NodeJS.ProcessEnv,selected:string,trust:CharterCreationEvidenceTrust,registry?:IssuerSkrRegistry|null){
 const flag=env.CHARTER_ISSUER_SEEKER_AUCTION_ENABLED??'false';if(flag!=='true'&&flag!=='false')return fail();if(flag==='false')return undefined;
 const mint=address(required(env,'SEEKER_AUCTION_MINT')),prizeOwner=address(required(env,'SEEKER_AUCTION_PRIZE_OWNER')),crankPublicKey=address(required(env,'SEEKER_AUCTION_CRANK_PUBKEY'));
 if(!registry||registry.cluster!==selected||registry.skrMint!==mint||typeof registry.skrDecimals!=='number'
  ||!Number.isInteger(registry.skrDecimals)||registry.skrDecimals<0||registry.skrDecimals>19||!PublicKey.isOnCurve(new PublicKey(crankPublicKey).toBytes()))return fail();
 const auctionTrust:SeekerAuctionReadTrust=Object.freeze({programId:trust.economy.programId,genesisHash:trust.expectedGenesisHash,mint,decimals:registry.skrDecimals,prizeOwner,
  deploymentSlot:trust.economy.reviewedDeploymentSlot,programDataSha256:trust.economy.reviewedProgramDataSha256,upgradeAuthority:trust.economy.upgradeAuthority,stateProvenance:'fresh-reviewed-deployment'});
 return Object.freeze({crankPublicKey,trust:auctionTrust});
}
export function loadCharterPolicyIssuerConfig(env:NodeJS.ProcessEnv,registry?:IssuerSkrRegistry|null){
 try{
  const journal=loadCharterIssuerJournalConfig(env),selected=cluster(env),flag=env.CHARTER_ISSUER_ALLOW_PRIVATE_HTTP??'false';if(flag!=='true'&&flag!=='false')return fail();
  const allowPrivateHttp=flag==='true',url=new URL(required(env,'READ_RPC_URL'));
  if(url.username||url.password||url.hash||!(url.protocol==='https:'||url.protocol==='http:'&&allowPrivateHttp&&privateIp(url.hostname)))return fail();
  if(['api.devnet.solana.com','api.testnet.solana.com','api.mainnet-beta.solana.com'].includes(url.hostname.toLowerCase().replace(/\.$/,'')))return fail();
  const program=(family:'ECONOMY'|'CRAFT'|'CORE'):CharterCreationProgramTrust=>{
   const programId=address(required(env,family+'_PROGRAM_ID')),raw=required(env,family+'_DEPLOYMENT_SLOT'),hash=required(env,family+'_PROGRAM_DATA_SHA256'),authority=required(env,family+'_UPGRADE_AUTHORITY');
   if(!/^(0|[1-9][0-9]*)$/.test(raw)||!Number.isSafeInteger(Number(raw))||!/^[0-9a-f]{64}$/.test(hash)||family==='CORE'&&programId!==CORE)return fail();
   return Object.freeze({programId,reviewedDeploymentSlot:Number(raw),reviewedProgramDataSha256:hash,upgradeAuthority:authority==='none'?null:address(authority)});
  };
  if(required(env,'STATE_PROVENANCE')!=='fresh-reviewed-deployment')return fail();
  const trust:CharterCreationEvidenceTrust=Object.freeze({expectedGenesisHash:journal.domain.genesisHash,economy:program('ECONOMY'),craft:program('CRAFT'),core:program('CORE'),stateProvenance:'fresh-reviewed-deployment'});
  if(new Set([trust.economy.programId,trust.craft.programId,trust.core.programId]).size!==3)return fail();
  const publicKey=address(required(env,'CURRENT_PUBLIC_KEY')),secretKeyFile=absolute(required(env,'SECRET_KEY_FILE')),authTokenFile=absolute(required(env,'AUTH_TOKEN_FILE'));
  if(new Set([journal.journalFile,secretKeyFile,authTokenFile]).size!==3)return fail();
  const host=env.CHARTER_ISSUER_HOST??'127.0.0.1',rawPort=env.CHARTER_ISSUER_PORT??'3004',port=Number(rawPort);
  if(!loopback(host)&&!(allowPrivateHttp&&(privateIp(host)||host==='0.0.0.0'||host==='::')))return fail();
  if(!/^[1-9][0-9]*$/.test(rawPort)||!Number.isSafeInteger(port)||port>65535)return fail();
  const seekerAuction=seekerAuctionPins(env,selected,trust,registry);
  return Object.freeze({...journal,cluster:selected,trust,publicKey,secretKeyFile,authTokenFile,readRpcUrl:url.href,allowPrivateHttp,host,port,
   ...(seekerAuction?{seekerAuction}:{})});
 }catch{return fail();}
}
export type CharterPolicyIssuerConfig=ReturnType<typeof loadCharterPolicyIssuerConfig>;
// Operational secret-file bound; game policy remains in shared constants.
async function secretFile(file:string):Promise<Buffer>{
 const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 const bytes=Buffer.alloc(8193);let length=0;
 try{
  const before=await handle.stat();if(!before.isFile()||(before.mode&0o777)!==0o600||before.uid!==process.getuid?.()||before.nlink!==1||before.size>8192)throw new CharterIssuerError('SECRET_FILE');
  while(length<bytes.length){const read=await handle.read(bytes,length,bytes.length-length,length);if(!read.bytesRead)break;length+=read.bytesRead;}
  const after=await handle.stat();if(length>8192||length!==before.size||after.size!==before.size||after.ctimeMs!==before.ctimeMs||after.mtimeMs!==before.mtimeMs)throw new CharterIssuerError('SECRET_FILE');
  return Buffer.from(bytes.subarray(0,length));
 }finally{bytes.fill(0);await handle.close();}
}
export async function loadCharterPolicyIssuerSecrets(config:Pick<CharterPolicyIssuerConfig,'publicKey'|'secretKeyFile'|'authTokenFile'>){
 let privateKey:KeyObject|null=null;const held:Buffer[]=[];
 try{
  const keyBytes=await secretFile(config.secretKeyFile);held.push(keyBytes);const raw:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(keyBytes));
  if(!Array.isArray(raw)||raw.length!==64||!raw.every(v=>typeof v==='number'&&Number.isInteger(v)&&v>=0&&v<=255))throw new CharterIssuerError('SECRET_FILE');
  const secret=Buffer.from(raw);raw.fill(0);held.push(secret);
  const der=Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),secret.subarray(0,32)]);held.push(der);privateKey=createPrivateKey({key:der,format:'der',type:'pkcs8'});
  const actual=createPublicKey(privateKey).export({format:'der',type:'spki'}).subarray(-32);
  if(!actual.equals(secret.subarray(32))||new PublicKey(actual).toBase58()!==config.publicKey)throw new CharterIssuerError('KEY_MISMATCH');
  const tokenBytes=await secretFile(config.authTokenFile);held.push(tokenBytes);const authToken=charterIssuerAuthToken(new TextDecoder('utf-8',{fatal:true}).decode(tokenBytes).replace(/\r?\n$/,''));
  return Object.freeze({authToken,signer:Object.freeze({publicKey:config.publicKey,sign:(message:Uint8Array)=>{if(!privateKey)throw new CharterIssuerError('CLOSED');return sign(null,message,privateKey);}}),close:()=>{privateKey=null;}});
 }catch{privateKey=null;throw new CharterIssuerError('SECRET_FILE');}finally{for(const bytes of held)bytes.fill(0);}
}
