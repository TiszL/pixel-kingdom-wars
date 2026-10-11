import {randomUUID} from 'node:crypto';
import {mkdtemp,open,readFile,rename,rm,symlink,writeFile,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Keypair} from '@solana/web3.js';
import {afterEach,expect,it,vi} from 'vitest';
import {encodeCharterRegistrationPermit} from '@shardkeep/chain/charter-protocol';
import {sign} from '../../../packages/chain/src/testFixtures/charterPreparation';
import {initializeCharterIssuerJournal,openCharterIssuerJournal,type CharterIssuerAttempt} from '../src/charterPolicyIssuerJournal';

const cleanups:(()=>Promise<void>)[]=[];
afterEach(async()=>{vi.restoreAllMocks();for(const close of cleanups.splice(0).reverse())await close();});
async function fixture(initialize=true){
 const directory=await mkdtemp(path.join(tmpdir(),'charter-journal-'));cleanups.push(()=>rm(directory,{recursive:true,force:true}));
 const file=path.join(directory,'issuer.jsonl'),key=Keypair.generate(),genesis=Keypair.generate().publicKey,economy=Keypair.generate().publicKey;
 const domain={genesisHash:genesis.toBase58(),economyProgram:economy.toBase58()};if(initialize)await initializeCharterIssuerJournal(file,domain);
 const attempt=(permit=1):CharterIssuerAttempt=>({requestId:randomUUID(),kind:'charter-registration-v1',publicKey:key.publicKey.toBase58(),messageHex:encodeCharterRegistrationPermit({genesisHash:genesis,programId:economy,kind:5,permitId:Buffer.alloc(16,permit),wallet:key.publicKey,expiry:1_800_000_550n,payloadHash:Buffer.alloc(32,2)}).toString('hex')});
 const signature=(a:CharterIssuerAttempt)=>sign(key,Buffer.from(a.messageHex,'hex')).toString('hex');
 async function reopen(){const journal=await openCharterIssuerJournal(file,domain);cleanups.push(()=>journal.close());return journal;}
 return {directory,file,domain,key,attempt,signature,reopen};
}
it('persists pending and completed records across reopen and returns detached historical data',async()=>{
 const f=await fixture(),a=f.attempt(),journal=await f.reopen();expect(await journal.begin(a)).toMatchObject({inserted:true,entry:{signatureHex:null}});
 const receipt=await journal.complete(a.requestId,f.signature(a));await journal.close();const recovered=await f.reopen();
 expect(await recovered.read(a.requestId)).toEqual({attempt:a,signatureHex:f.signature(a)});receipt.message.fill(0);receipt.signature.fill(0);
 expect((await recovered.read(a.requestId))?.attempt.messageHex).toBe(a.messageHex);expect(await recovered.begin(a)).toMatchObject({inserted:false});
 expect((await readFile(f.file,'utf8')).trim().split('\n')).toHaveLength(3);
});
it('serializes duplicate requests and rejects conflicting request or native permit reuse',async()=>{
 const f=await fixture(),journal=await f.reopen(),a=f.attempt();const results=await Promise.all([journal.begin(a),journal.begin(a)]);expect(results.map(v=>v.inserted).sort()).toEqual([false,true]);
 await expect(journal.begin({...a,requestId:randomUUID()})).rejects.toMatchObject({code:'CONFLICT'});
 await expect(journal.begin({...f.attempt(2),requestId:a.requestId})).rejects.toMatchObject({code:'CONFLICT'});
 await expect(journal.complete(a.requestId,'00'.repeat(64))).rejects.toMatchObject({code:'SIGNATURE'});
 expect((await journal.read(a.requestId))?.signatureHex).toBeNull();await journal.complete(a.requestId,f.signature(a));
 await expect(journal.complete(a.requestId,f.signature(a))).rejects.toMatchObject({code:'CONFLICT'});
});
it('holds a real OS advisory lock across independent lock-helper processes and releases it on close',async()=>{
 const f=await fixture(),first=await f.reopen();await expect(openCharterIssuerJournal(f.file,f.domain)).rejects.toMatchObject({code:'LOCK'});
 await first.close();const second=await f.reopen();expect(await second.read(randomUUID())).toBeNull();
});
it('never initializes missing state and fails closed on partial, invalid, symlink or unsafe state',async()=>{
 const missing=await fixture(false);await expect(missing.reopen()).rejects.toThrow();
 for(const mode of ['partial','schema','signature','symlink','permissions']){
  const f=await fixture(),journal=await f.reopen(),a=f.attempt();await journal.begin(a);await journal.complete(a.requestId,f.signature(a));await journal.close();
  const text=await readFile(f.file,'utf8');
  if(mode==='partial')await writeFile(f.file,text.slice(0,-1));if(mode==='schema')await writeFile(f.file,text.replace('"version":1','"version":2'));
  if(mode==='signature')await writeFile(f.file,text.replace(f.signature(a),'00'.repeat(64)));
  if(mode==='symlink'){await rename(f.file,f.file+'.original');await symlink(f.file+'.original',f.file);}
  if(mode==='permissions')await chmod(f.file,0o644);
  await expect(f.reopen(),mode).rejects.toThrow();
 }
});
it('detects replacement of the open journal before accepting another operation',async()=>{
 const f=await fixture(),journal=await f.reopen(),a=f.attempt();await journal.begin(a);const text=await readFile(f.file,'utf8');
 await rename(f.file,f.file+'.old');await writeFile(f.file,text,{mode:0o600});await expect(journal.read(a.requestId)).rejects.toMatchObject({code:'JOURNAL_CHANGED'});
 await expect(journal.complete(a.requestId,f.signature(a))).rejects.toMatchObject({code:'JOURNAL'});
});
it('does not return a receipt on append or fsync failure and poisons the live writer',async()=>{
 for(const method of ['writeFile','sync'] as const){
  const f=await fixture(),journal=await f.reopen(),a=f.attempt();await journal.begin(a);
  const probe=await open(f.file,'r'),prototype=Object.getPrototypeOf(probe);await probe.close();const fault=vi.spyOn(prototype,method).mockRejectedValueOnce(Error('fixture storage failure'));
  await expect(journal.complete(a.requestId,f.signature(a))).rejects.toThrow('fixture storage failure');fault.mockRestore();
  await expect(journal.read(a.requestId)).rejects.toMatchObject({code:'JOURNAL'});await journal.close();
  // A completed append with failed fsync may be readable on this OS after a
  // reopen; it is never returned by the failed call. A missing append stays held.
  const reopened=await f.reopen(),saved=await reopened.read(a.requestId);expect(saved?.signatureHex).toBe(method==='sync'?f.signature(a):null);
 }
});
