/** Dedicated Charter issuance state. Never shares withdrawal keys or journals. */
import {createPublicKey,verify} from 'node:crypto';
import {spawn} from 'node:child_process';
import {constants} from 'node:fs';
import {open,type FileHandle} from 'node:fs/promises';
import path from 'node:path';
import {PublicKey} from '@solana/web3.js';
import {z} from 'zod';
import {decodeCharterRegistrationPermit} from '@shardkeep/chain/charter-protocol';
import {encodeCharterPurposePermit} from '@shardkeep/chain/charter-transfer-protocol';
import {encodeCharterRetirementPermit} from '@shardkeep/chain/charter-retirement-protocol';
import {decodeSeekerActionPermit} from '@shardkeep/chain/seeker-auction-protocol';
import {SeekerWithdrawPrepareRequestSchema} from '@shardkeep/shared/seekerAuctionApi';

export type CharterIssuerKind='charter-registration-v1'|'charter-transfer-v1'|'charter-lock-v1'|'charter-retirement-v1'|'seeker-auction-open-v1';
export interface CharterIssuerDomain {readonly genesisHash:string;readonly economyProgram:string}
export interface CharterIssuerAttempt {readonly requestId:string;readonly kind:CharterIssuerKind;readonly messageHex:string;readonly publicKey:string;
 readonly auction?:Readonly<{round:string;spot:number}>|undefined}
export interface CharterIssuerReceipt {readonly requestId:string;readonly publicKey:string;readonly message:Uint8Array;readonly signature:Uint8Array}
export interface CharterIssuerEntry {readonly attempt:CharterIssuerAttempt;readonly signatureHex:string|null}
export class CharterIssuerError extends Error {constructor(readonly code:string){super('Charter issuer refused: '+code);this.name='CharterIssuerError';}}
export function issuerNeed(value:unknown,code:string):asserts value {if(!value)throw new CharterIssuerError(code);}
const uuid=z.uuid().refine(v=>v===v.toLowerCase());
export const charterIssuerRequestId=(value:unknown)=>uuid.parse(value);
const address=z.string().refine(value=>{try{const key=new PublicKey(value);return key.toBase58()===value&&!key.equals(PublicKey.default);}catch{return false;}});
const domainSchema=z.object({genesisHash:address,economyProgram:address}).strict();
const attemptSchema=z.object({requestId:uuid,kind:z.enum(['charter-registration-v1','charter-transfer-v1','charter-lock-v1','charter-retirement-v1','seeker-auction-open-v1']),messageHex:z.string().regex(/^[0-9a-f]{322}$/),publicKey:address,
 auction:SeekerWithdrawPrepareRequestSchema.optional()}).strict().superRefine((v,ctx)=>{if((v.kind==='seeker-auction-open-v1')!==(v.auction!==undefined))ctx.addIssue({code:'custom',message:'kind-specific target required'});});
const signatureSchema=z.string().regex(/^[0-9a-f]{128}$/);
// Operational file bounds, not gameplay policy. Exhaustion holds issuance.
const MAX_BYTES=64*1024*1024,MAX_LINE_BYTES=4096;
export function copyCharterIssuerDomain(value:CharterIssuerDomain):CharterIssuerDomain{return Object.freeze(domainSchema.parse(value));}
export function copyCharterIssuerAttempt(value:CharterIssuerAttempt,domain:CharterIssuerDomain){
 const parsed=attemptSchema.parse(value);if(parsed.auction)Object.freeze(parsed.auction);
 const attempt=Object.freeze(parsed),bytes=Buffer.from(attempt.messageHex,'hex');
 const nativeKind=attempt.kind==='charter-registration-v1'?5:attempt.kind==='charter-transfer-v1'?1:attempt.kind==='charter-lock-v1'?6:attempt.kind==='seeker-auction-open-v1'?7:9;
 issuerNeed(bytes.subarray(0,8).equals(Buffer.from('SKPERMT2'))&&bytes[72]===nativeKind,'PURPOSE');
 const genesis=new PublicKey(bytes.subarray(8,40)),economy=new PublicKey(bytes.subarray(40,72)),wallet=new PublicKey(bytes.subarray(89,121));
 const permitId=bytes.subarray(73,89),expiry=bytes.readBigInt64LE(121),payload=bytes.subarray(129);
 if(nativeKind===5)decodeCharterRegistrationPermit(bytes);
 else if(nativeKind===7)issuerNeed(decodeSeekerActionPermit(bytes).kind===7,'MESSAGE');
 else if(nativeKind===9)issuerNeed(encodeCharterRetirementPermit(genesis,economy,wallet,{permitId,expiry},payload).equals(bytes),'MESSAGE');
 else issuerNeed(encodeCharterPurposePermit(genesis,economy,nativeKind,wallet,{permitId,expiry},payload).equals(bytes),'MESSAGE');
 issuerNeed(genesis.toBase58()===domain.genesisHash&&economy.toBase58()===domain.economyProgram,'DOMAIN');
 return {attempt,expiry,permitId:permitId.toString('hex')};
}
export function charterIssuerReceipt(entry:CharterIssuerEntry):CharterIssuerReceipt|null{
 if(entry.signatureHex===null)return null;
 const a=entry.attempt,message=Buffer.from(a.messageHex,'hex'),signature=Buffer.from(signatureSchema.parse(entry.signatureHex),'hex');
 const key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),new PublicKey(a.publicKey).toBuffer()]),format:'der',type:'spki'});
 issuerNeed(verify(null,message,key,signature),'SIGNATURE');
 return {requestId:a.requestId,publicKey:a.publicKey,message,signature};
}
const exact=(value:unknown,keys:string)=>{issuerNeed(value&&typeof value==='object'&&!Array.isArray(value)&&Reflect.ownKeys(value).sort().join(' ')===keys,'JOURNAL');return value as Record<string,unknown>;};
const same=(a:CharterIssuerAttempt,b:CharterIssuerAttempt)=>a.requestId===b.requestId&&a.kind===b.kind&&a.messageHex===b.messageHex&&a.publicKey===b.publicKey
 &&a.auction?.round===b.auction?.round&&a.auction?.spot===b.auction?.spot;
const stamp=(s:Awaited<ReturnType<FileHandle['stat']>>)=>`${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
async function secureDirectory(file:string){
 issuerNeed(path.isAbsolute(file),'PATH');const handle=await open(path.dirname(file),constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const s=await handle.stat();issuerNeed(s.isDirectory()&&(s.mode&0o077)===0&&s.uid===process.getuid?.(),'DIRECTORY');}finally{await handle.close();}
}
async function secureFile(handle:FileHandle){const s=await handle.stat();issuerNeed(s.isFile()&&(s.mode&0o077)===0&&s.nlink===1&&s.uid===process.getuid?.(),'FILE');return s;}
async function lock(file:string){
 await secureDirectory(file);const lockFile=file+'.lock',handle=await open(lockFile,constants.O_WRONLY|constants.O_CREAT|constants.O_APPEND|constants.O_NOFOLLOW,0o600);
 let identity:string;try{const s=await secureFile(handle);identity=`${s.dev}:${s.ino}`;}finally{await handle.close();}
 // Keep one lock inode across writers; unlinking on unlock can split waiters.
 const command=process.platform==='darwin'?'/usr/bin/lockf':'flock',args=process.platform==='darwin'?['-k','-t','0',lockFile,'sh','-c','printf LOCKED; cat >/dev/null']:['-n',lockFile,'sh','-c','printf LOCKED; cat >/dev/null'];
 const child=spawn(command,args,{stdio:['pipe','pipe','pipe']});let lost=false;
 child.once('exit',()=>{lost=true;});child.on('error',()=>{lost=true;});child.stderr.resume();
 try{await new Promise<void>((resolve,reject)=>{
  const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new CharterIssuerError('LOCK'));},5000);let out='';
  const fail=()=>{clearTimeout(timer);reject(new CharterIssuerError('LOCK'));};child.once('error',fail);child.once('exit',fail);
  child.stdout.on('data',(part:Buffer)=>{out+=part.toString('utf8');if(out==='LOCKED'){clearTimeout(timer);child.off('error',fail);child.off('exit',fail);resolve();}else if(out.length>6)fail();});
 });}catch(error){child.kill('SIGKILL');throw error;}
 const assert=async()=>{issuerNeed(!lost,'LOCK');const current=await open(lockFile,constants.O_RDONLY|constants.O_NOFOLLOW);try{const s=await secureFile(current);issuerNeed(`${s.dev}:${s.ino}`===identity&&!lost,'LOCK');}finally{await current.close();}};
 const close=async()=>{if(child.exitCode!==null||child.signalCode!==null)return;const done=new Promise<void>(resolve=>child.once('close',()=>resolve()));child.stdin.end();await done;};
 try{await assert();return {assert,close};}catch(error){await close();throw error;}
}
/** Explicit offline ceremony; normal open never initializes missing state. */
export async function initializeCharterIssuerJournal(file:string,input:CharterIssuerDomain){
 const domain=copyCharterIssuerDomain(input),guard=await lock(file);
 try{const handle=await open(file,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try{await handle.writeFile(JSON.stringify({version:1,domain})+'\n');await handle.sync();}finally{await handle.close();}
  const directory=await open(path.dirname(file),constants.O_RDONLY|constants.O_NOFOLLOW);try{await directory.sync();}finally{await directory.close();}
 }finally{await guard.close();}
}
export interface CharterIssuerJournal {
 read(id:string):Promise<CharterIssuerEntry|null>;
 begin(attempt:CharterIssuerAttempt):Promise<{inserted:boolean;entry:CharterIssuerEntry}>;
 complete(id:string,signatureHex:string):Promise<CharterIssuerReceipt>;
 close():Promise<void>;
}
export async function openCharterIssuerJournal(file:string,input:CharterIssuerDomain):Promise<CharterIssuerJournal>{
 const domain=copyCharterIssuerDomain(input),guard=await lock(file);let handle:FileHandle;
 try{handle=await open(file,constants.O_RDWR|constants.O_APPEND|constants.O_NOFOLLOW);}catch(error){await guard.close();throw error;}
 const entries=new Map<string,CharterIssuerEntry>(),permits=new Map<string,string>();let savedStamp='',size=0,closed=false,fatal=false,tail:Promise<unknown>=Promise.resolve();
 const copy=(entry:CharterIssuerEntry):CharterIssuerEntry=>({attempt:{...entry.attempt},signatureHex:entry.signatureHex});
 function apply(value:unknown){
  const row=exact(value,'attempt signatureHex type');issuerNeed(row.type==='pending'||row.type==='complete','JOURNAL');
  const {attempt,permitId}=copyCharterIssuerAttempt(row.attempt as CharterIssuerAttempt,domain),prior=entries.get(attempt.requestId);
  if(row.type==='pending'){
   issuerNeed(row.signatureHex===null&&!prior&&!permits.has(permitId),'JOURNAL');entries.set(attempt.requestId,{attempt,signatureHex:null});permits.set(permitId,attempt.requestId);
  }else{
   issuerNeed(prior&&prior.signatureHex===null&&same(prior.attempt,attempt),'JOURNAL');
   const entry={attempt,signatureHex:signatureSchema.parse(row.signatureHex)};charterIssuerReceipt(entry);entries.set(attempt.requestId,entry);
  }
 }
 async function check(){
  issuerNeed(!closed&&!fatal,'JOURNAL');await guard.assert();await secureDirectory(file);
  const s=await secureFile(handle);issuerNeed(stamp(s)===savedStamp,'JOURNAL_CHANGED');
  const named=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);try{issuerNeed(stamp(await secureFile(named))===savedStamp,'JOURNAL_CHANGED');}finally{await named.close();}
 }
 function serial<T>(operation:()=>Promise<T>):Promise<T>{const work=tail.then(async()=>{try{await check();return await operation();}catch(error){if(!(error instanceof CharterIssuerError)||!['CONFLICT','PENDING','SIGNATURE'].includes(error.code))fatal=true;throw error;}});tail=work.catch(()=>{});return work;}
 async function append(row:{type:'pending'|'complete';attempt:CharterIssuerAttempt;signatureHex:string|null}){
  const line=JSON.stringify(row)+'\n',bytes=Buffer.byteLength(line);issuerNeed(bytes<=MAX_LINE_BYTES&&size+bytes<=MAX_BYTES,'JOURNAL_FULL');
  await check();await handle.writeFile(line,'utf8');await handle.sync();await guard.assert();
  const s=await secureFile(handle);issuerNeed(s.size===size+bytes,'JOURNAL_CHANGED');savedStamp=stamp(s);size=s.size;
  await check();apply(row);
 }
 try{
  const before=await secureFile(handle);issuerNeed(before.size>0&&before.size<=MAX_BYTES,'JOURNAL');const text=await handle.readFile('utf8');
  issuerNeed(text.endsWith('\n')&&stamp(await secureFile(handle))===stamp(before),'JOURNAL');
  const lines=text.slice(0,-1).split('\n');issuerNeed(lines.every(line=>Buffer.byteLength(line)<=MAX_LINE_BYTES),'JOURNAL');
  const header=exact(JSON.parse(lines.shift()!),'domain version');issuerNeed(header.version===1,'JOURNAL');const saved=copyCharterIssuerDomain(header.domain as CharterIssuerDomain);
  issuerNeed(saved.genesisHash===domain.genesisHash&&saved.economyProgram===domain.economyProgram,'DOMAIN');for(const line of lines)apply(JSON.parse(line));
  savedStamp=stamp(before);size=before.size;await check();
 }catch(error){await handle.close();await guard.close();throw error;}
 return Object.freeze({
  read:async(id:string)=>{const requestId=charterIssuerRequestId(id);return serial(async()=>{const found=entries.get(requestId);return found?copy(found):null;});},
  begin:async(value:CharterIssuerAttempt)=>{const {attempt,permitId}=copyCharterIssuerAttempt(value,domain);return serial(async()=>{
   const prior=entries.get(attempt.requestId);if(prior){issuerNeed(same(prior.attempt,attempt),'CONFLICT');return {inserted:false,entry:copy(prior)};}
   issuerNeed(!permits.has(permitId),'CONFLICT');await append({type:'pending',attempt,signatureHex:null});return {inserted:true,entry:copy(entries.get(attempt.requestId)!)};
  });},
  complete:async(id:string,value:string)=>{const requestId=charterIssuerRequestId(id),signatureHex=signatureSchema.parse(value);return serial(async()=>{
   const prior=entries.get(requestId);issuerNeed(prior&&prior.signatureHex===null,'CONFLICT');const entry={attempt:prior.attempt,signatureHex};charterIssuerReceipt(entry);
   await append({type:'complete',...entry});return charterIssuerReceipt(entry)!;
  });},
  close:async()=>{await tail;if(closed)return;closed=true;try{await handle.close();}finally{await guard.close();}},
 });
}
