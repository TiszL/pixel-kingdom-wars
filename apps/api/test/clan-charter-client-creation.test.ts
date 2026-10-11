import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {CLANS} from '@shardkeep/shared';
import {CharterCreationClientSchema,CharterActivitySchema,CharterDeliverySchema} from '@shardkeep/shared/charterApi';
import {buildApp} from '../src/app';
import {createClanCharterClient,type CharterClientProvider} from '../src/game/clanCharterClient';
import type {CharterClientDeliveryRpc} from '../src/game/clanCharterClientDelivery';
import {TEST_CONFIG} from './helpers';
import {charterCreationWorkflowFixture,type WorkflowFixture} from './fixtures/charterCreationWorkflow';
const path='/clans/charter/client';let f:WorkflowFixture,apps:FastifyInstance[]=[];
beforeEach(async()=>{f=await charterCreationWorkflowFixture({staticLookupTable:true});await f.useSigningActor();apps=[];},120000);
afterEach(async()=>{try{for(const app of apps)await app.close();await f?.dispose();}finally{vi.restoreAllMocks();vi.unstubAllEnvs();}},120000);
async function open(provider:CharterClientProvider){const previous=process.env['MULTI_BASE_ENABLED'];process.env['MULTI_BASE_ENABLED']='false';
 try{const app=await buildApp({...TEST_CONFIG,PLAYTEST_OPEN:'true'},f.db,{charterClientProvider:provider});apps.push(app);await app.ready();return app;}
 finally{if(previous===undefined)delete process.env['MULTI_BASE_ENABLED'];else process.env['MULTI_BASE_ENABLED']=previous;}
}
const get=(app:FastifyInstance,url:string)=>app.inject({url,cookies:f.auth.cookies});
async function prepared(app:FastifyInstance){const input=f.request({name:'X'.repeat(CLANS.nameMaxLen)}),funded=await f.post(app,path+'/creations',input);expect(funded.statusCode,funded.body).toBe(201);
 await f.sync(input.creationIntentId);const url=`${path}/creations/${input.creationIntentId}`,response=await f.post(app,url+'/prepare');expect(response.statusCode,response.body).toBe(200);
 return {input,url,state:CharterCreationClientSchema.parse(response.json())};
}
it('projects the funded maximum metadata original, sends only its retained payer wire and activates only on original recovery',async()=>{
 const sendRawTransaction=vi.fn<CharterClientDeliveryRpc['sendRawTransaction']>(),rpc={...f.rpc,sendRawTransaction,getSignatureStatuses:vi.fn<CharterClientDeliveryRpc['getSignatureStatuses']>().mockResolvedValue({context:{slot:150},value:[null]})};
 const options=f.options(),prefix='https://invalid.example/'+'x'.repeat(231)+'/',app=await open(createClanCharterClient(f.db,{creation:{...options,newCreation:{domain:f.domain,metadataUriPrefix:prefix}},
  delivery:{connect:()=>rpc,trust:f.chain.trust,expectedCurrentSigner:f.chain.expectedCurrentSigner,lookupTable:f.chain.lookupTable}}));
 const before=await f.balance('base_shards',f.payerActor.baseId),p=await prepared(app);
 expect(p.state.state.original.price.shards).toBe(String(CLANS.createCostShards));expect(await f.balance('base_shards',f.payerActor.baseId)).toBe(before-f.cost);
 expect(p.state.signing!.packet.packetBytes).toBe(1228);expect(p.state.signing!.original.metadata.uri).toHaveLength(292);
 const signed=f.signed(p.state.state),retained=await f.post(app,p.url+'/signed',signed.body);expect(retained.statusCode,retained.body).toBe(200);const envelope=CharterCreationClientSchema.parse(retained.json());
 sendRawTransaction.mockResolvedValue(envelope.wire!.signature);const delivered=await f.post(app,p.url+'/deliver');expect(delivered.statusCode,delivered.body).toBe(200);expect(CharterDeliverySchema.parse(delivered.json()).status).toBe('submitted');
 expect(sendRawTransaction.mock.calls[0]![0]).toEqual(signed.bytes);expect((await get(app,p.url)).json().state.status).toBe('signed');
 await f.sync(p.input.creationIntentId,true);const recovered=await f.post(app,p.url+'/recover');expect(recovered.statusCode,recovered.body).toBe(200);expect(CharterCreationClientSchema.parse(recovered.json()).state.status).toBe('activated');
 f.setOnline(false);vi.stubEnv('PHASE_E_CHARTER_ENABLED','false');const offline=await open(createClanCharterClient(f.db)),history=CharterCreationClientSchema.parse((await get(offline,p.url)).json());expect(history.wire).toEqual(envelope.wire);
 expect(CharterActivitySchema.parse((await get(offline,path+'/activity')).json()).items).toContainEqual(expect.objectContaining({kind:'creation',key:p.input.creationIntentId,status:'activated',participantRole:'creator'}));
 expect(CharterDeliverySchema.parse((await f.post(offline,p.url+'/deliver')).json()).status).toBe('terminal');expect(sendRawTransaction).toHaveBeenCalledTimes(1);
});
it('keeps a funded lost-response identity and performs explicit expiry recovery and original-payer refund without duplicate debit',async()=>{
 const app=await open(createClanCharterClient(f.db,{creation:f.options()})),p=await prepared(app),initial=await f.balance('base_shards',f.payerActor.baseId);
 const repeated=await f.post(app,path+'/creations',p.input);expect(repeated.statusCode,repeated.body).toBe(201);expect(repeated.json().key).toBe(p.input.creationIntentId);expect(await f.balance('base_shards',f.payerActor.baseId)).toBe(initial);
 f.bank.clock.writeBigInt64LE(BigInt(p.state.state.policy!.expiry)+1n,32);const recovered=await f.post(app,p.url+'/recover');expect(recovered.statusCode,recovered.body).toBe(200);expect(recovered.json().state.status).toBe('cancelled_unpaid');
 for(let n=0;n<2;n++){const response=await f.post(app,p.url+'/refund');expect(response.statusCode,response.body).toBe(200);expect(response.json().state.status).toBe('refunded');}
 expect(await f.balance('base_shards',f.payerActor.baseId)).toBe(initial+f.cost);expect(await f.sql`select * from charter_creation_refunds`).toHaveLength(1);
});
