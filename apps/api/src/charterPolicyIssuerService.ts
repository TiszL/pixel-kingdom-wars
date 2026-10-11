/** Dedicated authenticated Charter issue/lookup service; no keys or Db here. */
import {createHash,timingSafeEqual} from 'node:crypto';
import Fastify from 'fastify';
import type {CharterPolicyIssueRequest} from './charterPolicyIssuer';
import type {CharterIssuerReceipt} from './charterPolicyIssuerJournal';
import {CHARTER_ISSUER_HTTP,CharterIssuerWireLookup,charterIssuerAuthToken,charterIssuerHttpTimeout,decodeCharterIssuerWireRequest,encodeCharterIssuerWireReceipt} from './charterPolicyIssuerClient';

export interface CharterPolicyIssuerServiceOptions {
 readonly issuer:Readonly<{issueOnce(request:CharterPolicyIssueRequest,signal:AbortSignal):Promise<CharterIssuerReceipt>;lookup(requestId:string,signal:AbortSignal):Promise<CharterIssuerReceipt|null>}>;
 readonly authToken:string;readonly timeoutMs?:number;
}
export function createCharterPolicyIssuerService(options:CharterPolicyIssuerServiceOptions){
 const digest=(value:string)=>createHash('sha256').update(value).digest(),expected=digest('Bearer '+charterIssuerAuthToken(options.authToken));
 const issue=options.issuer.issueOnce.bind(options.issuer),lookup=options.issuer.lookup.bind(options.issuer),timeout=charterIssuerHttpTimeout(options.timeoutMs??CHARTER_ISSUER_HTTP.timeoutMs),lifetime=new AbortController();
 const app=Fastify({logger:false,disableRequestLogging:true,bodyLimit:CHARTER_ISSUER_HTTP.requestBytes,requestTimeout:timeout,connectionTimeout:timeout,forceCloseConnections:true});
 app.addHook('preClose',async()=>{lifetime.abort();});
 app.addHook('onRequest',async(request,reply)=>{
  reply.header('cache-control','no-store');
  const header=request.headers.authorization??'',matches=timingSafeEqual(digest(header),expected);
  let count=0;for(let i=0;i<request.raw.rawHeaders.length;i+=2)if(request.raw.rawHeaders[i]?.toLowerCase()==='authorization')count++;
  if(!matches||count!==1)return reply.code(401).send({error:'UNAUTHORIZED'});
 });
 app.setNotFoundHandler((_request,reply)=>reply.code(404).send({error:'NOT_FOUND'}));
 app.setErrorHandler((error,_request,reply)=>{const code=error&&typeof error==='object'&&'code'in error?error.code:null;
  return reply.code(code==='FST_ERR_CTP_BODY_TOO_LARGE'?413:400).send({error:code==='FST_ERR_CTP_BODY_TOO_LARGE'?'BODY_TOO_LARGE':'INVALID_REQUEST'});
 });
 async function bounded<T>(signal:AbortSignal,operation:()=>Promise<T>):Promise<T>{
  signal.throwIfAborted();let abort!:()=>void;
  const interrupted=new Promise<never>((_resolve,reject)=>{abort=()=>reject(Error('Aborted'));signal.addEventListener('abort',abort,{once:true});});
  try{return await Promise.race([Promise.resolve().then(()=>{signal.throwIfAborted();return operation();}),interrupted]);}finally{signal.removeEventListener('abort',abort);}
 }
 app.post(CHARTER_ISSUER_HTTP.issuePath,async(request,reply)=>{
  let wire:CharterPolicyIssueRequest;try{wire=decodeCharterIssuerWireRequest(request.body);}catch{return reply.code(400).send({error:'INVALID_REQUEST'});}const originalHex=Buffer.from(wire.message).toString('hex'),requestId=wire.requestId;
  const controller=new AbortController(),signal=AbortSignal.any([controller.signal,lifetime.signal,AbortSignal.timeout(timeout)]),abort=()=>controller.abort();
  request.raw.once('aborted',abort);reply.raw.once('close',abort);
  try{
   const receipt=await bounded(signal,()=>issue(wire,signal));signal.throwIfAborted();
   const encoded=encodeCharterIssuerWireReceipt(receipt,requestId);if(encoded.messageHex!==originalHex)throw Error('Binding');
   return reply.send(encoded);
  }catch{return reply.code(503).send({error:'ISSUER_UNAVAILABLE'});}
  finally{request.raw.off('aborted',abort);reply.raw.off('close',abort);controller.abort();}
 });
 app.post(CHARTER_ISSUER_HTTP.lookupPath,async(request,reply)=>{
  const parsed=CharterIssuerWireLookup.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:'INVALID_REQUEST'});
  const controller=new AbortController(),signal=AbortSignal.any([controller.signal,lifetime.signal,AbortSignal.timeout(timeout)]),abort=()=>controller.abort();
  request.raw.once('aborted',abort);reply.raw.once('close',abort);
  try{const receipt=await bounded(signal,()=>lookup(parsed.data.requestId,signal));signal.throwIfAborted();return reply.send(receipt===null?null:encodeCharterIssuerWireReceipt(receipt,parsed.data.requestId));}
  catch{return reply.code(503).send({error:'ISSUER_UNAVAILABLE'});}
  finally{request.raw.off('aborted',abort);reply.raw.off('close',abort);controller.abort();}
 });
 return app;
}
