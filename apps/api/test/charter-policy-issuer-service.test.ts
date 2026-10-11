/** Real authenticated HTTP around the durable issuer; synthetic encoded policy
 * bank and dedicated test key never establish live entitlement or deployment. */
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Keypair,PublicKey} from '@solana/web3.js';
import {afterEach,expect,it,vi} from 'vitest';
import {encodeCharterRetirementPermit,hashCharterRetirementPayload} from '@shardkeep/chain/charter-retirement-protocol';
import {preparationFixture,sign} from '../../../packages/chain/src/testFixtures/charterPreparation';
import {createCharterPolicyIssuer} from '../src/charterPolicyIssuer';
import {initializeCharterIssuerJournal} from '../src/charterPolicyIssuerJournal';
import {createCharterPolicyIssuerService,type CharterPolicyIssuerServiceOptions} from '../src/charterPolicyIssuerService';
import {createCharterPolicyIssuerClient,CHARTER_ISSUER_HTTP} from '../src/charterPolicyIssuerClient';

const token='charter-test-only-opaque-auth-token-123456',cleanups:(()=>Promise<void>|void)[]=[];
afterEach(async()=>{vi.restoreAllMocks();for(const close of cleanups.splice(0).reverse())await close();});
const signal=()=>new AbortController().signal;
function gate(){let enter!:()=>void,release!:()=>void;const arrived=new Promise<void>(resolve=>{enter=resolve;}),wait=new Promise<void>(resolve=>{release=resolve;});return {arrived,release,hold:async()=>{enter();await wait;}};}
async function fixture(){
 const f=preparationFixture(),directory=await mkdtemp(path.join(tmpdir(),'charter-service-')),journalFile=path.join(directory,'state.jsonl');cleanups.push(()=>rm(directory,{recursive:true,force:true}));
 await initializeCharterIssuerJournal(journalFile,{genesisHash:f.trust.expectedGenesisHash,economyProgram:f.trust.economy.programId});const signing=vi.fn((bytes:Uint8Array)=>sign(f.policy,bytes));
 const core=await createCharterPolicyIssuer({journalFile,trust:f.trust,connect:f.connect,signer:{publicKey:f.policy.publicKey.toBase58(),sign:signing}});cleanups.push(()=>core.close());
 const issuer={issueOnce:vi.fn(core.issueOnce),lookup:vi.fn(core.lookup)};
 async function serve(selected:CharterPolicyIssuerServiceOptions['issuer']=issuer){const app=createCharterPolicyIssuerService({issuer:selected,authToken:token});const endpoint=await app.listen({host:'127.0.0.1',port:0});cleanups.push(()=>app.close());
  const client=createCharterPolicyIssuerClient({endpoint,authToken:token,currentPublicKey:f.policy.publicKey.toBase58(),allowPrivateHttp:true});cleanups.push(()=>client.close());return {app,client,endpoint};}
 const request=()=>({kind:'charter-registration-v1' as const,requestId:randomUUID(),message:Buffer.from(f.candidate)});
 return {...f,journalFile,signing,core,issuer,serve,request};
}
it('authenticates before issuer/body handling and rejects oversized, extra, or wrong-purpose requests',async()=>{
 const f=await fixture(),{app}=await f.serve(),r=f.request(),wire={kind:r.kind,requestId:r.requestId,messageHex:r.message.toString('hex')},headers={authorization:'Bearer '+token};
 for(const authorization of [undefined,'Bearer wrong','Basic '+token]){
  const result=await app.inject({method:'POST',url:CHARTER_ISSUER_HTTP.issuePath,payload:'{bad JSON',headers:{'content-type':'application/json',...(authorization?{authorization}:{})}});expect(result.statusCode).toBe(401);expect(result.json()).toEqual({error:'UNAUTHORIZED'});
 }
 for(const body of [{...wire,extra:true},{...wire,kind:'charter-lock-v1'},{...wire,messageHex:'00'.repeat(161)},{...wire,requestId:'bad'}])expect((await app.inject({method:'POST',url:CHARTER_ISSUER_HTTP.issuePath,headers,payload:body})).statusCode).toBe(400);
 const huge=await app.inject({method:'POST',url:CHARTER_ISSUER_HTTP.issuePath,headers,payload:{...wire,padding:'x'.repeat(3000)}});expect(huge.statusCode).toBe(413);expect(huge.json()).toEqual({error:'BODY_TOO_LARGE'});
 const unknown=await app.inject({method:'POST',url:'/unexpected?secret='+token,headers,payload:{}});expect(unknown.body).not.toContain(token);expect(unknown.json()).toEqual({error:'NOT_FOUND'});
 expect(f.issuer.issueOnce).not.toHaveBeenCalled();expect(f.issuer.lookup).not.toHaveBeenCalled();expect(f.signing).not.toHaveBeenCalled();expect((await readFile(f.journalFile,'utf8')).trim().split('\n')).toHaveLength(1);
});
it('issues once over actual HTTP and preserves historical lookup during policy pause and client key rotation',async()=>{
 const f=await fixture(),{client,endpoint}=await f.serve(),request=f.request(),receipt=await client.issueOnce(request,signal());
 expect(await client.issueOnce(request,signal())).toEqual(receipt);expect(await client.lookup(request.requestId,signal())).toEqual(receipt);expect(await client.lookup(randomUUID(),signal())).toBeNull();expect(f.signing).toHaveBeenCalledTimes(1);
 f.authorityData[147]=1;const rotated=createCharterPolicyIssuerClient({endpoint,authToken:token,currentPublicKey:Keypair.generate().publicKey.toBase58(),allowPrivateHttp:true});cleanups.push(()=>rotated.close());
 expect(await rotated.lookup(request.requestId,signal())).toEqual(receipt);await expect(rotated.issueOnce(request,signal())).rejects.toThrow('transport unavailable');expect(f.signing).toHaveBeenCalledTimes(1);
});
it('recovers a fsynced signature after the issue response is lost without a second issue or signature',async()=>{
 const f=await fixture(),held=gate(),{client}=await f.serve({issueOnce:async(request,caller)=>{const receipt=await f.issuer.issueOnce(request,caller);await held.hold();return receipt;},lookup:f.issuer.lookup});
 const controller=new AbortController(),request=f.request(),pending=client.issueOnce(request,controller.signal),refused=expect(pending).rejects.toThrow('transport unavailable');
 await held.arrived;controller.abort();await refused;held.release();const receipt=await client.lookup(request.requestId,signal());expect(receipt?.message).toEqual(request.message);expect(f.issuer.issueOnce).toHaveBeenCalledTimes(1);expect(f.signing).toHaveBeenCalledTimes(1);
});
it('disconnect during a stalled policy read leaves a durable pending record and cannot sign late',async()=>{
 const f=await fixture(),held=gate(),original=f.rpc.getGenesisHash;f.rpc.getGenesisHash=vi.fn(async()=>{await held.hold();return original();});const {client}=await f.serve();
 const controller=new AbortController(),request=f.request(),pending=client.issueOnce(request,controller.signal),refused=expect(pending).rejects.toThrow('transport unavailable');await held.arrived;controller.abort();await refused;
 await expect.poll(()=>f.issuer.issueOnce.mock.calls[0]?.[1].aborted).toBe(true);held.release();expect(await client.lookup(request.requestId,signal())).toBeNull();
 await expect(client.issueOnce(request,signal())).rejects.toThrow('transport unavailable');expect(f.signing).not.toHaveBeenCalled();expect((await readFile(f.journalFile,'utf8')).trim().split('\n')).toHaveLength(2);
});
it('sanitizes issuer errors and bounds an issuer that ignores its aborted call',async()=>{
 let aborted:AbortSignal|undefined;const app=createCharterPolicyIssuerService({authToken:token,timeoutMs:25,issuer:{issueOnce:async(_request,caller)=>{aborted=caller;return new Promise(()=>{});},lookup:async()=>{throw Error(token);}}});cleanups.push(()=>app.close());
 const f=preparationFixture(),headers={authorization:'Bearer '+token};const result=await app.inject({method:'POST',url:CHARTER_ISSUER_HTTP.issuePath,headers,payload:{kind:'charter-registration-v1',requestId:randomUUID(),messageHex:f.candidate.toString('hex')}});
 expect(result.statusCode).toBe(503);expect(result.json()).toEqual({error:'ISSUER_UNAVAILABLE'});expect(aborted?.aborted).toBe(true);
 const failed=await app.inject({method:'POST',url:CHARTER_ISSUER_HTTP.lookupPath,headers,payload:{requestId:randomUUID()}});expect(failed.statusCode).toBe(503);expect(failed.body).not.toContain(token);
});
it('preserves the original request binding even if the supplied issuer mutates its input',async()=>{
 const f=preparationFixture(),requestId=randomUUID(),app=createCharterPolicyIssuerService({authToken:token,issuer:{issueOnce:async request=>{
  Reflect.set(request,'requestId',randomUUID());return {requestId:request.requestId,publicKey:f.policy.publicKey.toBase58(),message:request.message,signature:sign(f.policy,request.message)};
 },lookup:async()=>null}});cleanups.push(()=>app.close());
 const result=await app.inject({method:'POST',url:CHARTER_ISSUER_HTTP.issuePath,headers:{authorization:'Bearer '+token},payload:{kind:'charter-registration-v1',requestId,messageHex:f.candidate.toString('hex')}});
 expect(result.statusCode).toBe(503);expect(result.json()).toEqual({error:'ISSUER_UNAVAILABLE'});
});

it('carries exact retirement consent over authenticated HTTP and recovers the original after pause',async()=>{
 const f=await fixture(),{app,client}=await f.serve(),economy=new PublicKey(f.trust.economy.programId),craft=new PublicKey(f.trust.craft.programId);
 const leader=new PublicKey(f.candidate.subarray(89,121)),terms={clanId:'e780a590-cfee-40dd-a178-cab0c696539e',retirementId:randomUUID(),fenceId:randomUUID(),expectedRevision:4,clearanceHash:Buffer.alloc(32,8)};
 const message=encodeCharterRetirementPermit(new PublicKey(f.trust.expectedGenesisHash),economy,leader,{permitId:Buffer.alloc(16,21),expiry:f.candidate.readBigInt64LE(121)},hashCharterRetirementPayload(economy,craft,leader,terms));
 const request={kind:'charter-retirement-v1' as const,requestId:randomUUID(),message};
 for(const kind of ['charter-registration-v1','charter-transfer-v1','charter-lock-v1']){
  expect((await app.inject({method:'POST',url:CHARTER_ISSUER_HTTP.issuePath,headers:{authorization:'Bearer '+token},payload:{kind,requestId:request.requestId,messageHex:message.toString('hex')}})).statusCode).toBe(400);
 }
 expect(f.signing).not.toHaveBeenCalled();const receipt=await client.issueOnce(request,signal());
 expect(receipt.message).toEqual(message);expect(receipt.signature).toEqual(sign(f.policy,message));
 f.authorityData[147]=1;expect(await client.lookup(request.requestId,signal())).toEqual(receipt);expect(await client.issueOnce(request,signal())).toEqual(receipt);
 expect(f.signing).toHaveBeenCalledTimes(1);
});
