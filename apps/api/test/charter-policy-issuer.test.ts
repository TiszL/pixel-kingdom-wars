/** Encoded finalized-bank fixtures exercise real policy readers and Ed25519.
 * Synthetic keys/banks prove local contracts, never live deployment authority. */
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Keypair,PublicKey} from '@solana/web3.js';
import {afterEach,expect,it,vi} from 'vitest';
import {PHASE_E_CHARTER_PREPARATION} from '@shardkeep/shared';
import {encodeCharterPurposePermit,hashCharterLockPayload,hashCharterTransferPayload} from '@shardkeep/chain/charter-transfer-protocol';
import {encodeCharterRetirementPermit,hashCharterRetirementPayload} from '@shardkeep/chain/charter-retirement-protocol';
import {fixture as bankFixture,key} from '../../../packages/chain/src/testFixtures/charterCreation';
import {candidateFor,sign} from '../../../packages/chain/src/testFixtures/charterPreparation';
import {createCharterPolicyIssuer,type CharterPolicyIssueRequest} from '../src/charterPolicyIssuer';
import {initializeCharterIssuerJournal,openCharterIssuerJournal} from '../src/charterPolicyIssuerJournal';

const cleanups:(()=>Promise<void>)[]=[];
afterEach(async()=>{vi.restoreAllMocks();for(const close of cleanups.splice(0).reverse())await close();});
const signal=()=>new AbortController().signal;
async function setup(){
 const bank=bankFixture(),policy=Keypair.generate(),economy=new PublicKey(bank.trust.economy.programId),craft=new PublicKey(bank.trust.craft.programId);
 const [authority,bump]=PublicKey.findProgramAddressSync([Buffer.from('seeker_authority')],economy),data=Buffer.alloc(213);
 Buffer.concat([createHash('sha256').update('account:SeekerAuthority').digest().subarray(0,8),Buffer.of(1),key(73).toBuffer(),Buffer.of(0),key(75).toBuffer(),policy.publicKey.toBuffer(),Buffer.of(0),Buffer.alloc(8),bank.genesis.toBuffer(),Buffer.of(0,bump)]).copy(data);
 const row={address:authority,owner:economy,executable:false,data};bank.rows.push(row);
 const directory=await mkdtemp(path.join(tmpdir(),'charter-issuer-')),journalFile=path.join(directory,'issuance.jsonl');cleanups.push(()=>rm(directory,{recursive:true,force:true}));
 const domain={genesisHash:bank.trust.expectedGenesisHash,economyProgram:economy.toBase58()};await initializeCharterIssuerJournal(journalFile,domain);
 let tick=0;const connect=vi.fn((_signal:AbortSignal)=>bank.rpc),signMessage=vi.fn((message:Uint8Array)=>sign(policy,message));
 const options={journalFile,trust:bank.trust,connect,signer:{publicKey:policy.publicKey.toBase58(),sign:signMessage},monotonicNow:()=>tick};
 async function open(overrides:Partial<Parameters<typeof createCharterPolicyIssuer>[0]>={}){const issuer=await createCharterPolicyIssuer({...options,...overrides});cleanups.push(()=>issuer.close());return issuer;}
 function request(kind:CharterPolicyIssueRequest['kind']='charter-registration-v1',permit=1):CharterPolicyIssueRequest{
  const permitId=Buffer.alloc(16,permit),expiry=1_800_000_550n,wallet=new PublicKey(bank.saved.payer);
  if(kind==='charter-registration-v1'){const message=candidateFor(bank.saved);permitId.copy(message,73);return {kind,requestId:randomUUID(),message};}
  const terms={clanId:bank.saved.clanId,expectedRevision:0,termsHash:Buffer.alloc(32,3)};
  if(kind==='charter-retirement-v1')return {kind,requestId:randomUUID(),message:encodeCharterRetirementPermit(bank.genesis,economy,wallet,{permitId,expiry},
   hashCharterRetirementPayload(economy,craft,wallet,{clanId:terms.clanId,expectedRevision:0,retirementId:randomUUID(),fenceId:randomUUID(),clearanceHash:Buffer.alloc(32,4)}))};
  const payload=kind==='charter-lock-v1'?hashCharterLockPayload(economy,craft,wallet,{...terms,lockId:randomUUID(),action:'set'}):
   hashCharterTransferPayload({economy,craft,seller:key(81),buyer:wallet,treasury:key(82)},{...terms,transferId:randomUUID(),fenceId:randomUUID(),priceLamports:100n});
  return {kind,requestId:randomUUID(),message:encodeCharterPurposePermit(bank.genesis,economy,kind==='charter-lock-v1'?6:1,wallet,{permitId,expiry},payload)};
 }
 return {...bank,row,policy,domain,journalFile,options,connect,signMessage,open,request,setTick:(value:number)=>{tick=value;}};
}
it('issues all four exact purposes through the real finalized policy reader and persists before returning',async()=>{
 const f=await setup(),issuer=await f.open();let permit=0;
 for(const kind of ['charter-registration-v1','charter-transfer-v1','charter-lock-v1','charter-retirement-v1'] as const){
  const request=f.request(kind,++permit),result=await issuer.issueOnce(request,signal());expect(result.message).toEqual(request.message);expect(result.signature).toEqual(sign(f.policy,request.message));
  expect(await readFile(f.journalFile,'utf8')).toContain(Buffer.from(result.signature).toString('hex'));
  expect(await issuer.issueOnce(request,signal())).toEqual(result);expect(await issuer.lookup(request.requestId,signal())).toEqual(result);
 }
 expect(f.signMessage).toHaveBeenCalledTimes(4);expect(f.rpc.getMultipleAccountsInfoAndContext).toHaveBeenCalledTimes(4);
 expect(vi.mocked(f.rpc.getMultipleAccountsInfoAndContext).mock.calls.every(call=>call[0].length===10)).toBe(true);
});
it('refuses malformed purpose/domain inputs before signing or retaining an attempt',async()=>{
 const f=await setup(),issuer=await f.open(),valid=f.request();
 const wrongDomain=Buffer.from(valid.message);key(90).toBuffer().copy(wrongDomain,8);
 for(const request of [{...valid,kind:'charter-transfer-v1' as const},{...valid,message:wrongDomain},{...valid,message:valid.message.subarray(1)},{...valid,extra:true}]){
  await expect(issuer.issueOnce(request,signal())).rejects.toThrow();expect(await issuer.lookup(valid.requestId,signal())).toBeNull();
 }
 expect(f.signMessage).not.toHaveBeenCalled();expect(f.connect).not.toHaveBeenCalled();
});
it('holds fresh attempts for paused policy, rotated current key, wrong deployment or out-of-range chain expiry',async()=>{
 const f=await setup(),issuer=await f.open();let permit=0;
 for(const mode of ['authority-pause','craft-pause','current-key','program-hash','expired','future']){
  const request=f.request('charter-registration-v1',++permit),authority=Buffer.from(f.row.data),control=Buffer.from(f.get('craftControl').data),program=Buffer.from(f.rows[1]!.data);
  if(mode==='authority-pause')f.row.data[147]=1;if(mode==='craft-pause')f.get('craftControl').data[137]=1;
  if(mode==='current-key')key(91).toBuffer().copy(f.row.data,74);if(mode==='program-hash')f.rows[1]!.data[50]=f.rows[1]!.data[50]!^1;
  if(mode==='expired'||mode==='future')Buffer.from(request.message.buffer,request.message.byteOffset,request.message.byteLength).writeBigInt64LE(mode==='expired'?1_800_000_010n:1_800_000_611n,121);
  await expect(issuer.issueOnce(request,signal()),mode).rejects.toThrow();expect(await issuer.lookup(request.requestId,signal())).toBeNull();
  f.row.data=authority;f.get('craftControl').data=control;f.rows[1]!.data=program;
  await expect(issuer.issueOnce(request,signal())).rejects.toMatchObject({code:'PENDING'});
 }
 expect(f.signMessage).not.toHaveBeenCalled();
});
it('recovers original signatures after restart, rotation and offline policy without renewing or signing',async()=>{
 const f=await setup(),request=f.request(),issuer=await f.open(),original=await issuer.issueOnce(request,signal());await issuer.close();
 const rotated=Keypair.generate(),signer=vi.fn((bytes:Uint8Array)=>sign(rotated,bytes));f.connect.mockImplementation(()=>{throw Error('offline');});
 const resumed=await f.open({signer:{publicKey:rotated.publicKey.toBase58(),sign:signer}});
 expect(await resumed.lookup(request.requestId,signal())).toEqual(original);expect(await resumed.issueOnce(request,signal())).toEqual(original);expect(signer).not.toHaveBeenCalled();
 const changed={...request,message:Buffer.from(request.message)};changed.message[160]=changed.message[160]!^1;await expect(resumed.issueOnce(changed,signal())).rejects.toMatchObject({code:'CONFLICT'});
});
it('owns the request bytes and rejects full-precision age changes before any signing',async()=>{
 const f=await setup(),issuer=await f.open(),request=f.request(),original=Buffer.from(request.message);
 const actual=f.rpc.getGenesisHash;let release!:()=>void,entered!:()=>void;const arrived=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
 f.rpc.getGenesisHash=vi.fn(async()=>{entered();await gate;return actual();});const pending=issuer.issueOnce(request,signal());await arrived;request.message.fill(0);release();expect((await pending).message).toEqual(original);
 f.rpc.getGenesisHash=vi.fn(async()=>{f.setTick(10_000.001);return actual();});
 await expect(issuer.issueOnce(f.request('charter-lock-v1',2),signal())).rejects.toThrow();expect(f.signMessage).toHaveBeenCalledTimes(1);
});
it('cancellation keeps ignored provider work bounded and cannot sign on a late completion',async()=>{
 const f=await setup(),issuer=await f.open({timeoutMs:1000});let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
 f.rpc.getGenesisHash=vi.fn(async()=>{await gate;return f.genesis.toBase58();});
 const calls=[];
 for(let i=0;i<PHASE_E_CHARTER_PREPARATION.maxPending;i++){
  const controller=new AbortController(),request=f.request('charter-registration-v1',i+1),work=issuer.issueOnce(request,controller.signal);const result=work.catch(error=>error);
  await expect.poll(()=>vi.mocked(f.rpc.getGenesisHash).mock.calls.length).toBe(i+1);controller.abort();expect(await result).toMatchObject({code:'ABORTED'});calls.push(request);
 }
 await expect(issuer.lookup(randomUUID(),signal())).rejects.toMatchObject({code:'BUSY'});release();
 await expect.poll(async()=>{try{await issuer.lookup(randomUUID(),signal());return true;}catch{return false;}}).toBe(true);
 for(const request of calls)expect(await issuer.lookup(request.requestId,signal())).toBeNull();expect(f.signMessage).not.toHaveBeenCalled();
});
it('a pre-existing durable pending attempt never re-enters policy or signing',async()=>{
 const f=await setup(),request=f.request(),journal=await openCharterIssuerJournal(f.journalFile,f.domain);
 await journal.begin({requestId:request.requestId,kind:request.kind,messageHex:Buffer.from(request.message).toString('hex'),publicKey:f.policy.publicKey.toBase58()});await journal.close();
 const issuer=await f.open();expect(await issuer.lookup(request.requestId,signal())).toBeNull();await expect(issuer.issueOnce(request,signal())).rejects.toMatchObject({code:'PENDING'});expect(f.connect).not.toHaveBeenCalled();expect(f.signMessage).not.toHaveBeenCalled();
});

it('separates retirement consent from every other purpose and keeps native permit IDs globally unique',async()=>{
 const f=await setup(),issuer=await f.open(),request=f.request('charter-retirement-v1',11);
 for(const kind of ['charter-registration-v1','charter-transfer-v1','charter-lock-v1'] as const){
  await expect(issuer.issueOnce({...request,kind},signal())).rejects.toMatchObject({code:'PURPOSE'});
  await expect(issuer.issueOnce({...f.request(kind,12),kind:'charter-retirement-v1'},signal())).rejects.toMatchObject({code:'PURPOSE'});
 }
 expect(f.signMessage).not.toHaveBeenCalled();expect(await issuer.lookup(request.requestId,signal())).toBeNull();
 const receipt=await issuer.issueOnce(request,signal());
 await expect(issuer.issueOnce(f.request('charter-transfer-v1',11),signal())).rejects.toMatchObject({code:'CONFLICT'});
 await issuer.close();f.connect.mockImplementation(()=>{throw Error('offline');});
 const resumed=await f.open();expect(await resumed.lookup(request.requestId,signal())).toEqual(receipt);
 expect(await resumed.issueOnce(request,signal())).toEqual(receipt);expect(f.signMessage).toHaveBeenCalledTimes(1);
});
