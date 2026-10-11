import {randomUUID} from 'node:crypto';
import {createServer,type Server} from 'node:http';
import {Keypair} from '@solana/web3.js';
import {afterEach,expect,it} from 'vitest';
import {preparationFixture,sign} from '../../../packages/chain/src/testFixtures/charterPreparation';
import {CHARTER_ISSUER_HTTP,createCharterPolicyIssuerClient} from '../src/charterPolicyIssuerClient';

const token='charter-client-test-opaque-auth-token-123456',cleanups:(()=>Promise<void>|void)[]=[];afterEach(async()=>{for(const close of cleanups.splice(0).reverse())await close();});
const signal=()=>new AbortController().signal;
async function listen(server:Server){await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const a=server.address();if(!a||typeof a==='string')throw Error('No test address');cleanups.push(async()=>{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));});return `http://127.0.0.1:${a.port}`;}
function example(){const f=preparationFixture(),request={kind:'charter-registration-v1' as const,requestId:randomUUID(),message:Buffer.from(f.candidate)},receipt={requestId:request.requestId,publicKey:f.policy.publicKey.toBase58(),messageHex:f.candidate.toString('hex'),signatureHex:sign(f.policy,f.candidate).toString('hex')};return {...f,request,receipt};}
function client(endpoint:string,currentPublicKey:string,timeoutMs?:number){const c=createCharterPolicyIssuerClient({endpoint,authToken:token,currentPublicKey,allowPrivateHttp:true,...(timeoutMs?{timeoutMs}:{})});cleanups.push(()=>c.close());return c;}
it('requires explicit private HTTP opt-in and a dedicated bare origin',()=>{
 const currentPublicKey=Keypair.generate().publicKey.toBase58(),base={authToken:token,currentPublicKey};
 for(const endpoint of ['http://127.0.0.1:3004','http://charter-issuer:3004'])expect(()=>createCharterPolicyIssuerClient({...base,endpoint})).toThrow();
 for(const endpoint of ['http://public.example','http://withdrawal-signer:3003','https://user:password@example.test','https://example.test/base','https://example.test/?q=1','https://example.test/#x'])expect(()=>createCharterPolicyIssuerClient({...base,endpoint,allowPrivateHttp:true})).toThrow();
 for(const endpoint of ['https://private.example','http://charter-issuer:3004','http://127.0.0.1:3004']){const c=createCharterPolicyIssuerClient({...base,endpoint,allowPrivateHttp:true});c.close();}
 expect(()=>createCharterPolicyIssuerClient({...base,endpoint:'https://private.example',authToken:'short'})).toThrow();
});
it('captures endpoint/token and request bytes and uses only the fixed authenticated POST path',async()=>{
 const f=example(),seen:unknown[]=[];const endpoint=await listen(createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;seen.push({method:req.method,url:req.url,auth:req.headers.authorization,body:JSON.parse(raw)});res.setHeader('content-type','application/json');res.end(JSON.stringify(f.receipt));}));
 const options={endpoint,authToken:token,currentPublicKey:f.receipt.publicKey,allowPrivateHttp:true},c=createCharterPolicyIssuerClient(options);cleanups.push(()=>c.close());const original=Buffer.from(f.request.message),pending=c.issueOnce(f.request,signal());f.request.message.fill(0);options.endpoint='http://127.0.0.1:1';options.authToken='changed';
 expect((await pending).message).toEqual(original);expect(seen).toEqual([{method:'POST',url:CHARTER_ISSUER_HTTP.issuePath,auth:'Bearer '+token,body:{kind:f.request.kind,requestId:f.request.requestId,messageHex:original.toString('hex')}}]);
});
it('refuses wrong issue identity, bytes, key, or signature and never returns raw remote errors',async()=>{
 const f=example(),other=Keypair.generate(),changed=Buffer.from(f.candidate);changed[160]=changed[160]!^1;
 let reply:unknown=f.receipt,status=200;const endpoint=await listen(createServer((_req,res)=>{res.statusCode=status;res.setHeader('content-type','application/json');res.end(JSON.stringify(reply));})),c=client(endpoint,f.receipt.publicKey);
 for(const value of [{...f.receipt,requestId:randomUUID()},{...f.receipt,messageHex:changed.toString('hex'),signatureHex:sign(f.policy,changed).toString('hex')},
  {...f.receipt,publicKey:other.publicKey.toBase58(),signatureHex:sign(other,f.candidate).toString('hex')},{...f.receipt,signatureHex:'00'.repeat(64)},{...f.receipt,extra:true}]){
  reply=value;await expect(c.issueOnce(f.request,signal())).rejects.toThrow('Charter issuer transport unavailable');
 }
 status=503;reply={error:token};await expect(c.issueOnce(f.request,signal())).rejects.toThrow(/^Charter issuer transport unavailable$/);
});
it('allows a real historical signature from an old key on lookup while preserving exact request identity',async()=>{
 const f=example();let reply:unknown=f.receipt;const seen:string[]=[];const endpoint=await listen(createServer((req,res)=>{seen.push(req.url!);res.setHeader('content-type','application/json');res.end(JSON.stringify(reply));})),c=client(endpoint,Keypair.generate().publicKey.toBase58());
 expect((await c.lookup(f.request.requestId,signal()))?.publicKey).toBe(f.receipt.publicKey);reply={...f.receipt,requestId:randomUUID()};await expect(c.lookup(f.request.requestId,signal())).rejects.toThrow();reply=null;expect(await c.lookup(f.request.requestId,signal())).toBeNull();expect(new Set(seen)).toEqual(new Set([CHARTER_ISSUER_HTTP.lookupPath]));
});
it.each(['redirect','oversize'] as const)('refuses %s with no follow-up or retry',async mode=>{
 const f=example();let calls=0;const endpoint=await listen(createServer((_req,res)=>{calls++;if(mode==='redirect'){res.writeHead(302,{location:'/other'});res.end();}else{res.setHeader('content-type','application/json');res.end('x'.repeat(CHARTER_ISSUER_HTTP.responseBytes+1));}}));
 await expect(client(endpoint,f.receipt.publicKey).issueOnce(f.request,signal())).rejects.toThrow(/^Charter issuer transport unavailable$/);expect(calls).toBe(1);
});
it.each(['caller','deadline','lifetime'] as const)('aborts a stalled actual request by %s and cannot reuse the stopped call',async mode=>{
 const f=example();let arrived!:()=>void,calls=0;const entered=new Promise<void>(resolve=>{arrived=resolve;}),endpoint=await listen(createServer(()=>{calls++;arrived();}));const c=client(endpoint,f.receipt.publicKey,mode==='deadline'?50:5000),controller=new AbortController();
 const refused=expect(c.lookup(f.request.requestId,controller.signal)).rejects.toThrow(/^Charter issuer transport unavailable$/);await entered;if(mode==='caller')controller.abort();if(mode==='lifetime')c.close();await refused;
 if(mode!=='deadline')await expect(c.lookup(f.request.requestId,controller.signal)).rejects.toThrow();expect(calls).toBe(1);
});
