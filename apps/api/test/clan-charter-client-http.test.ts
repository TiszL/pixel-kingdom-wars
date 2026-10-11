import {randomUUID} from 'node:crypto';
import {Keypair} from '@solana/web3.js';
import {PHASE_E_CHARTER_PREPARATION} from '@shardkeep/shared';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {CharterSaleClientSchema,CharterActivitySchema,CharterDeliverySchema} from '@shardkeep/shared/charterApi';
import {buildApp} from '../src/app';
import {createClanCharterClient,type CharterClientProvider} from '../src/game/clanCharterClient';
import type {CharterClientDeliveryOptions,CharterClientDeliveryRpc} from '../src/game/clanCharterClientDelivery';
import {TEST_CONFIG} from './helpers';
import {charterSalesWorkflowFixture,type SalesWorkflowFixture} from './fixtures/charterSalesWorkflow';
const path='/clans/charter/client';let f:SalesWorkflowFixture,apps:FastifyInstance[]=[];
beforeEach(async()=>{f=await charterSalesWorkflowFixture({staticLookupTable:true});apps=[];},120000);
afterEach(async()=>{try{for(const app of apps)await app.close();await f?.dispose();}finally{vi.restoreAllMocks();vi.unstubAllEnvs();}},120000);
async function open(provider:CharterClientProvider|null=createClanCharterClient(f.db,{sales:f.options()})){
 const previous=process.env['MULTI_BASE_ENABLED'];process.env['MULTI_BASE_ENABLED']='false';
 try{const app=await buildApp({...TEST_CONFIG,PLAYTEST_OPEN:'true'},f.db,{charterClientProvider:provider});apps.push(app);await app.ready();return app;}
 finally{if(previous===undefined)delete process.env['MULTI_BASE_ENABLED'];else process.env['MULTI_BASE_ENABLED']=previous;}
}
const get=(app:FastifyInstance,url:string,cookies=f.sellerAuth.cookies)=>app.inject({method:'GET',url,cookies});
async function prepared(app:FastifyInstance){
 const input=f.request(),draft=await f.post(app,path+'/sales',input);expect(draft.statusCode,draft.body).toBe(201);let state=CharterSaleClientSchema.parse(draft.json());f.selectSale(state.state);
 const accepted=await f.post(app,`${path}/sales/${state.key}/accept`,{termsHash:state.state.original.termsHash,buyerBaseId:f.buyer.baseId},f.buyerAuth.cookies);expect(accepted.statusCode,accepted.body).toBe(200);
 const response=await f.post(app,`${path}/sales/${state.key}/prepare`);expect(response.statusCode,response.body).toBe(200);state=CharterSaleClientSchema.parse(response.json());
 const wire=f.signed(state.state),signature=(i:number)=>({attemptId:state.signing!.attemptId,messageSha256:state.signing!.packet.messageSha256,signature:Buffer.from(wire.tx.signatures[i]!).toString('base64')});
 return {input,state,wire,signature,url:`${path}/sales/${state.key}`};
}
async function signed(app:FastifyInstance){const p=await prepared(app);
 for(const [i,cookies] of [f.buyerAuth.cookies,f.sellerAuth.cookies].entries()){const response=await f.post(app,p.url+'/signature',p.signature(i),cookies);expect(response.statusCode,response.body).toBe(200);}
 return p;
}
function delivery(){
 // The transport returns only the first actual signature, never an invented id.
 const sendRawTransaction=vi.fn<CharterClientDeliveryRpc['sendRawTransaction']>();
 const getSignatureStatuses=vi.fn<CharterClientDeliveryRpc['getSignatureStatuses']>().mockResolvedValue({context:{slot:150},value:[null]});
 const rpc={...f.rpc,sendRawTransaction,getSignatureStatuses};
 const options:CharterClientDeliveryOptions={connect:()=>rpc,trust:f.chain.trust,expectedCurrentSigner:f.chain.expectedCurrentSigner,lookupTable:f.chain.lookupTable};
 return {options,rpc,sendRawTransaction,getSignatureStatuses};
}
it('mounts only the authenticated closed client capability and rejects unknown request fields',async()=>{
 const app=await open(null);expect((await app.inject({method:'GET',url:path+'/activity'})).statusCode).toBe(401);
 const unavailable=await get(app,path+'/activity');expect(unavailable.statusCode).toBe(503);expect(unavailable.headers['cache-control']).toBe('private, no-store');
 expect((await get(app,'/clans/charter/sales/'+randomUUID())).statusCode).toBe(404);
 const ready=await open();expect((await get(ready,path+'/activity?wallet='+f.buyer.wallet)).statusCode).toBe(400);
 expect((await f.post(ready,path+'/sales',{...f.request(),seller:f.buyer.wallet})).statusCode).toBe(400);
});
it('recovers a real seller draft by key, exchanges two wallet approvals and preserves private history during pause and restart',async()=>{
 const app=await open(),p=await prepared(app),byKey=await get(app,path+'/sales/by-key/'+p.input.idempotencyKey);
 expect(byKey.statusCode,byKey.body).toBe(200);expect(byKey.json().sale.key).toBe(p.state.key);
 expect((await get(app,path+'/sales/by-key/'+p.input.idempotencyKey,f.buyerAuth.cookies)).json().sale).toBeNull();
 const other=await f.actor(),auth=await f.session(other.wallet);expect((await get(app,p.url,auth.cookies)).statusCode).toBe(404);
 expect(CharterActivitySchema.parse((await get(app,path+'/activity',auth.cookies)).json()).items).toEqual([]);
 const partial=await f.post(app,p.url+'/signature',p.signature(1));expect(partial.statusCode,partial.body).toBe(200);expect(partial.json().wire).toBeNull();expect(partial.json().contributions).toHaveLength(1);
 expect(CharterDeliverySchema.parse((await f.post(app,p.url+'/deliver')).json()).reason).toBe('NOT_SIGNED');
 f.setOnline(false);vi.stubEnv('PHASE_E_CHARTER_ENABLED','false');const restarted=await open(createClanCharterClient(f.db));
 const complete=await f.post(restarted,p.url+'/signature',p.signature(0),f.buyerAuth.cookies);expect(complete.statusCode,complete.body).toBe(200);
 const state=CharterSaleClientSchema.parse(complete.json());expect(state.wire!.signedTransaction).toBe(p.wire.body.signedTransaction);expect(state.contributions.map(c=>c.wallet)).toEqual([f.buyer.wallet,f.birth.actor.wallet]);
 const activity=CharterActivitySchema.parse((await get(restarted,path+'/activity')).json());expect(activity.newActions).toEqual({creation:false,sale:false});expect(activity.items).toContainEqual(expect.objectContaining({kind:'sale',key:p.state.key,status:'signed',participantRole:'seller'}));
 expect(CharterDeliverySchema.parse((await f.post(restarted,p.url+'/deliver')).json()).reason).toBe('PAUSED');
 expect((await get(restarted,p.url,f.buyerAuth.cookies)).headers['cache-control']).toBe('private, no-store');
});
it('delivers only the exact retained two-party bytes and completes solely through original finalized recovery',async()=>{
 const d=delivery(),app=await open(createClanCharterClient(f.db,{sales:f.options(),delivery:d.options})),p=await signed(app),retained=CharterSaleClientSchema.parse((await get(app,p.url)).json());
 d.sendRawTransaction.mockResolvedValue(retained.wire!.signature);
 const response=await f.post(app,p.url+'/deliver');expect(response.statusCode,response.body).toBe(200);const sent=CharterDeliverySchema.parse(response.json());expect(sent.status).toBe('submitted');expect(sent.original.state.terminal).toBeNull();
 expect(d.sendRawTransaction).toHaveBeenCalledExactlyOnceWith(Buffer.from(p.wire.bytes),{skipPreflight:false,preflightCommitment:'finalized',maxRetries:0,minContextSlot:150});
 d.getSignatureStatuses.mockResolvedValue({context:{slot:150},value:[{slot:150,confirmations:null,err:null,confirmationStatus:'finalized'}]});
 const observed=CharterDeliverySchema.parse((await f.post(app,p.url+'/deliver')).json());expect(observed.status).toBe('observed');expect(d.sendRawTransaction).toHaveBeenCalledTimes(1);
 await f.finalize(p.state.key);const recovered=await f.post(app,p.url+'/recover');expect(recovered.statusCode,recovered.body).toBe(200);expect(CharterSaleClientSchema.parse(recovered.json()).state.status).toBe('completed');
 f.setOnline(false);const terminal=CharterDeliverySchema.parse((await f.post(app,p.url+'/deliver')).json());expect(terminal.status).toBe('terminal');expect(d.sendRawTransaction).toHaveBeenCalledTimes(1);
});
it('holds wrong network, expired height and unverified transaction errors without changing rights or replacing bytes',async()=>{
 const d=delivery(),app=await open(createClanCharterClient(f.db,{sales:f.options(),delivery:d.options})),p=await signed(app),before=CharterSaleClientSchema.parse((await get(app,p.url)).json());
 f.rpc.getGenesisHash.mockResolvedValueOnce(Keypair.generate().publicKey.toBase58());expect(CharterDeliverySchema.parse((await f.post(app,p.url+'/deliver')).json()).reason).toBe('IDENTITY');
 f.rpc.getBlockHeight.mockResolvedValueOnce(301);expect(CharterDeliverySchema.parse((await f.post(app,p.url+'/deliver')).json()).reason).toBe('EXPIRED_UNRESOLVED');
 d.getSignatureStatuses.mockResolvedValue({context:{slot:150},value:[{slot:150,confirmations:null,err:{InstructionError:[2,'Custom']},confirmationStatus:'finalized'}]});
 expect(CharterDeliverySchema.parse((await f.post(app,p.url+'/deliver')).json()).reason).toBe('FINALIZED_ERROR_UNVERIFIED');expect(d.sendRawTransaction).not.toHaveBeenCalled();
 expect(CharterSaleClientSchema.parse((await get(app,p.url)).json())).toEqual(before);
});
it('checks pause again immediately before dispatch and preserves uncertain-send evidence for an explicit retry',async()=>{
 const d=delivery(),app=await open(createClanCharterClient(f.db,{sales:f.options(),delivery:d.options})),p=await signed(app),before=CharterSaleClientSchema.parse((await get(app,p.url)).json());
 d.getSignatureStatuses.mockResolvedValueOnce({context:{slot:150},value:[null]}).mockImplementationOnce(async()=>{vi.stubEnv('PHASE_E_CHARTER_ENABLED','false');return {context:{slot:150},value:[null]};});
 expect(CharterDeliverySchema.parse((await f.post(app,p.url+'/deliver')).json()).reason).toBe('PAUSED');expect(d.sendRawTransaction).not.toHaveBeenCalled();
 vi.stubEnv('PHASE_E_CHARTER_ENABLED','true');d.sendRawTransaction.mockRejectedValueOnce(Error('reply lost'));
 const held=CharterDeliverySchema.parse((await f.post(app,p.url+'/deliver')).json());expect(held.reason).toBe('SEND_UNCERTAIN');expect(held.original).toEqual(before);expect(d.sendRawTransaction).toHaveBeenCalledTimes(1);
 d.sendRawTransaction.mockResolvedValue(before.wire!.signature);expect(CharterDeliverySchema.parse((await f.post(app,p.url+'/deliver')).json()).status).toBe('submitted');
 expect(d.sendRawTransaction.mock.calls[1]![0]).toEqual(d.sendRawTransaction.mock.calls[0]![0]);
});
it('bounds ignored aborts across delivery requests and never dispatches timed-out work after transport recovery',async()=>{
 const d=delivery(),app=await open(createClanCharterClient(f.db,{sales:f.options(),delivery:{...d.options,timeoutMs:25}})),p=await signed(app),resolvers:Array<(value:string)=>void>=[];
 f.rpc.getGenesisHash.mockImplementation(()=>new Promise<string>(resolve=>resolvers.push(resolve)));
 for(let n=0;n<PHASE_E_CHARTER_PREPARATION.maxPending;n++)expect(CharterDeliverySchema.parse((await f.post(app,p.url+'/deliver')).json()).reason).toBe('TIMEOUT');
 expect(CharterDeliverySchema.parse((await f.post(app,p.url+'/deliver')).json()).reason).toBe('BUSY');expect(resolvers).toHaveLength(PHASE_E_CHARTER_PREPARATION.maxPending);expect(d.sendRawTransaction).not.toHaveBeenCalled();
 for(const resolve of resolvers)resolve(f.domain.genesisHash);await new Promise(resolve=>setImmediate(resolve));
 expect(d.getSignatureStatuses).not.toHaveBeenCalled();expect(d.sendRawTransaction).not.toHaveBeenCalled();
 expect((await get(app,p.url)).json().state.status).toBe('signed');
});
it('pages only genuine participant originals with stable cursors and no duplicate or hidden account records',async()=>{
 const app=await open();for(let n=0;n<21;n++){
  const response=await f.post(app,path+'/sales',f.request());expect(response.statusCode,response.body).toBe(201);
  const cancelled=await f.post(app,`${path}/sales/${response.json().key}/cancel`);expect(cancelled.statusCode,cancelled.body).toBe(200);
 }
 const first=CharterActivitySchema.parse((await get(app,path+'/activity')).json());expect(first.items).toHaveLength(20);expect(first.nextCursor).not.toBeNull();
 const second=CharterActivitySchema.parse((await get(app,path+'/activity?cursor='+first.nextCursor)).json());expect(second.items).toHaveLength(2);expect(second.nextCursor).toBeNull();
 expect(new Set([...first.items,...second.items].map(v=>v.kind+v.key)).size).toBe(22);expect([...first.items,...second.items].filter(v=>v.kind==='sale').every(v=>v.status==='cancelled')).toBe(true);
 const buyer=CharterActivitySchema.parse((await get(app,path+'/activity',f.buyerAuth.cookies)).json());expect(buyer.items.every(v=>v.kind==='sale'&&v.participantRole==='buyer')).toBe(true);
 const malformed=await get(app,path+'/activity?cursor='+Buffer.from(JSON.stringify({at:'2026-01-01T00:00:00.000000Z',id:randomUUID(),kind:'sale',wallet:f.buyer.wallet})).toString('base64url'));expect(malformed.statusCode).toBe(400);
},120000);
