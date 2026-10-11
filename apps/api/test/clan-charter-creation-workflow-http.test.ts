import {randomUUID} from 'node:crypto';
import {CLANS} from '@shardkeep/shared';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {transferStableBase} from '../src/game/baseOwnership';
import type {CharterCreationWorkflowOptions,CharterCreationWorkflowState} from '../src/game/clanCharterCreationWorkflow';
import {charterCreationWorkflowFixture,charterPath,noWorkflowAuthority,type WorkflowFixture} from './fixtures/charterCreationWorkflow';
let f:WorkflowFixture|undefined;
const fixture=()=>{if(!f)throw Error('Workflow fixture incomplete');return f;};
beforeEach(async()=>{f=undefined;f=await charterCreationWorkflowFixture();},120_000);
afterEach(async()=>{vi.restoreAllMocks();const current=f;f=undefined;await current?.dispose();},120_000);

it('funds through real HTTP, issues the actual v0 packet, retains a payer signature and activates exactly once',async()=>{
 const f=fixture();await f.useSigningActor();await f.seedSpendQuests();const app=await f.open(),baseBefore=await f.balance('base_shards',f.payerActor.baseId),burnBefore=await f.balance('shard_burn');
 const p=await f.funded(app),id=p.input.creationIntentId;
 expect(p.state).toMatchObject({status:'funded',wallet:f.payerActor.wallet,request:p.input,original:{price:{shards:String(CLANS.createCostShards)}},...noWorkflowAuthority});
 expect(await f.balance('base_shards',f.payerActor.baseId)).toBe(baseBefore-f.cost);expect(await f.balance('charter_creation_escrow')).toBe(f.cost);expect(await f.spendProgress(f.payerActor.baseId)).toHaveLength(0);
 const prepared=await f.post(app,`${charterPath}/${id}/prepare`);expect(prepared.statusCode,prepared.body).toBe(200);const state=prepared.json<CharterCreationWorkflowState>();
 expect(state.status).toBe('prepared');expect(state.policy!.expiry).toMatch(/^[1-9][0-9]*$/);expect(state.preparation!.costs.totalLamports).toMatch(/^[1-9][0-9]*$/);
 expect(state.preparation!.packet.packetBytes).toBeLessThanOrEqual(1232);const signed=f.signed(state),before=await f.terminalSnapshot();
 const retained=await f.post(app,`${charterPath}/${id}/signed`,signed.body);expect(retained.statusCode,retained.body).toBe(200);expect(retained.json().status).toBe('signed');expect(await f.terminalSnapshot()).toEqual(before);
 await f.sync(id,true);
 for(let n=0;n<2;n++){const result=await f.post(app,`${charterPath}/${id}/recover`);expect(result.statusCode,result.body).toBe(200);expect(result.json()).toMatchObject({status:'activated',terminal:{state:'activated'},...noWorkflowAuthority});}
 expect(await f.balance('charter_creation_escrow')).toBe(0n);expect(await f.balance('shard_burn')).toBe(burnBefore+f.cost);
 expect(await f.sql`select id from clans`).toHaveLength(1);expect(await f.sql`select player_wallet from clan_members`).toEqual([{player_wallet:f.payerActor.wallet}]);
 expect((await f.spendProgress(f.payerActor.baseId)).map(v=>v.progress)).toEqual([Number(f.cost),Number(f.cost)]);expect(f.issuer.issueOnce).toHaveBeenCalledTimes(1);
});

it('keeps changed-owner cancellation and explicit original-payer destination refunds separate and once-only',async()=>{
 const f=fixture();await f.useSigningActor();const app=await f.open(),p=await f.prepared(app),id=p.input.creationIntentId;
 const stored=await f.post(app,`${charterPath}/${id}/signed`,f.signed(p.state).body);expect(stored.statusCode,stored.body).toBe(200);
 const buyer=await f.actor(),destination=await f.actor(),source=f.payerActor;
 await transferStableBase(f.db,source.baseId,source.wallet,buyer.wallet,source.deed,{...source.proof(buyer.wallet,101),observedAtMs:Date.now()});
 await transferStableBase(f.db,destination.baseId,destination.wallet,source.wallet,destination.deed,{...destination.proof(source.wallet,102),observedAtMs:Date.now()});
 await f.sync(id);f.bank.clock.writeBigInt64LE(BigInt(p.state.policy!.expiry)+1n,32);const prior=await f.balance('base_shards',destination.baseId),buyerBefore=await f.balance('base_shards',source.baseId),burn=await f.balance('shard_burn');
 expect((await f.post(app,`${charterPath}/${id}/recover`)).json().status).toBe('cancelled_unpaid');
 const automatic=await f.post(app,`${charterPath}/${id}/refund`);expect(automatic.statusCode,automatic.body).toBe(503);
 const buyerAuth=await f.session(buyer.wallet);expect((await f.post(app,`${charterPath}/${id}/refund`,{destinationBaseId:buyer.baseId},buyerAuth.cookies)).statusCode).toBe(404);
 for(let n=0;n<2;n++){const result=await f.post(app,`${charterPath}/${id}/refund`,{destinationBaseId:destination.baseId});expect(result.statusCode,result.body).toBe(200);expect(result.json()).toMatchObject({status:'refunded',terminal:{refundDestinationBaseId:destination.baseId},...noWorkflowAuthority});}
 expect(await f.balance('base_shards',destination.baseId)).toBe(prior+f.cost);expect(await f.balance('base_shards',source.baseId)).toBe(buyerBefore);expect(await f.balance('shard_burn')).toBe(burn);expect(await f.spendProgress(source.baseId)).toHaveLength(0);
 expect(await f.sql`select * from charter_creation_refunds`).toHaveLength(1);
});

it('replays funded identity and signed history offline before current flags, metadata or deployment configuration',async()=>{
 const f=fixture();await f.useSigningActor();const app=await f.open(),p=await f.prepared(app),id=p.input.creationIntentId;
 const retained=await f.post(app,`${charterPath}/${id}/signed`,f.signed(p.state).body);expect(retained.statusCode,retained.body).toBe(200);
 process.env['PHASE_E_CHARTER_ENABLED']='false';process.env['MULTI_BASE_ENABLED']='false';f.setOnline(false);
 const offline=await f.open({options:{newCreation:null,chain:null,issuer:null,finalizedDeedReader:null,deedCollection:null}}),before=await f.terminalSnapshot(),calls=f.connect.mock.calls.length;
 const replay=await f.post(offline,charterPath,p.input);expect(replay.statusCode,replay.body).toBe(201);expect(replay.json().original).toEqual(retained.json().original);
 for(const suffix of ['', '/prepare','/recover-preparation']){const result=suffix?await f.post(offline,`${charterPath}/${id}${suffix}`):await offline.inject({url:`${charterPath}/${id}`,cookies:f.auth.cookies});
  expect(result.statusCode,result.body).toBe(200);expect(result.json()).toEqual(retained.json());}
 expect(f.connect).toHaveBeenCalledTimes(calls);expect(await f.terminalSnapshot()).toEqual(before);
});

it('keeps uncertain issuance recoverable by lookup only, including null lookup and a restarted provider',async()=>{
 const f=fixture(),app=await f.open(),p=await f.funded(app),id=p.input.creationIntentId;
 f.hooks.afterIssue=async()=>{throw Error('Fixture lost issuer response after genuine signature');};
 const failed=await f.post(app,`${charterPath}/${id}/prepare`);expect(failed.statusCode,failed.body).toBe(503);expect(failed.json().error).toMatchObject({creationIntentId:id,status:'held'});
 const state=await app.inject({url:`${charterPath}/${id}`,cookies:f.auth.cookies});expect(state.json().status).toBe('issuing');expect(state.json().policy.expiry).toMatch(/^[1-9][0-9]*$/);
 const restarted=await f.open();f.hooks.lookupNull=true;const empty=await f.post(restarted,`${charterPath}/${id}/recover-preparation`);expect(empty.statusCode,empty.body).toBe(200);expect(empty.json().status).toBe('issuing');
 f.hooks.lookupNull=false;const recovered=await f.post(restarted,`${charterPath}/${id}/recover-preparation`);expect(recovered.statusCode,recovered.body).toBe(200);expect(recovered.json().status).toBe('prepared');
 expect(recovered.json().policy).toEqual(state.json().policy);expect(f.issuer.issueOnce).toHaveBeenCalledTimes(1);expect(await f.sql`select * from charter_creation_issuance_attempts`).toHaveLength(1);
});

it('converges concurrent identical fund requests on server-generated original IDs and refuses changed intent',async()=>{
 const f=fixture(),app=await f.open(),input=f.request(),results=await Promise.all([f.post(app,charterPath,input),f.post(app,charterPath,input)]);
 for(const result of results)expect(result.statusCode,result.body).toBe(201);expect(results[0]!.json()).toEqual(results[1]!.json());
 const state=results[0]!.json<CharterCreationWorkflowState>();expect(state.original.reservationId).not.toBe(input.creationIntentId);expect(state.original.clanId).not.toBe(input.creationIntentId);
 expect(await f.sql`select * from charter_creation_reservations`).toHaveLength(1);expect(await f.balance('charter_creation_escrow')).toBe(f.cost);
 for(const change of [{name:'Other Clan'},{tag:'OTHER'},{inviteMode:'invite'},{baseId:randomUUID()}]){const conflict=await f.post(app,charterPath,{...input,...change});expect(conflict.statusCode,conflict.body).toBe(409);}
});

it('admits the exact maximum server metadata packet and refuses known invalid setup before any debit',async()=>{
 const f=fixture(),prefix='https://invalid.example/'+'x'.repeat(231)+'/',options=f.options();
 expect(Buffer.byteLength(prefix)).toBe(256);
 const app=await f.open({options:{newCreation:{domain:f.domain,metadataUriPrefix:prefix}}}),p=await f.prepared(app,f.request({name:'X'.repeat(CLANS.nameMaxLen)}));
 expect(p.state.preparation!.packet.packetBytes).toBe(1228);expect(Buffer.byteLength(p.state.original.metadata.uri)).toBe(292);
 const before=await f.snapshot();
 for(const newCreation of [{domain:f.domain,metadataUriPrefix:prefix+'x'},{domain:f.domain,metadataUriPrefix:'http://invalid.example/'},
  {domain:{...f.domain,economyProgram:'invalid'},metadataUriPrefix:options.newCreation!.metadataUriPrefix}]){
  const bad=await f.open({options:{newCreation}}),result=await f.post(bad,charterPath,f.request());expect(result.statusCode,result.body).toBe(503);expect(result.json().error.code).toBe('CLAN_CHARTER_WORKFLOW_CONFIGURATION');
 }
 for(const chain of [{...f.chain,trust:undefined},{...f.chain,lookupTable:{...f.chain.lookupTable,dataSha256:'invalid'}},
  {...f.chain,costLimits:{...f.chain.costLimits,maxTotalLamports:0n}},{...f.chain,expectedCurrentSigner:'invalid'}]){
  const bad=await f.open({options:{chain:chain as unknown as NonNullable<CharterCreationWorkflowOptions['chain']>}}),replay=await f.post(bad,charterPath,p.input);
  expect(replay.statusCode,replay.body).toBe(201);expect(replay.json().original).toEqual(p.state.original);
  const result=await f.post(bad,charterPath,f.request());expect(result.statusCode,result.body).toBe(503);expect(result.json().error.code).toBe('CLAN_CHARTER_WORKFLOW_CONFIGURATION');
 }
 expect(await f.snapshot()).toEqual(before);
});

it('preserves the admitted candidate when preparation is unavailable and resumes the original after configuration returns',async()=>{
 const f=fixture(),app=await f.open({options:{issuer:null}}),p=await f.funded(app),id=p.input.creationIntentId;
 const refused=await f.post(app,`${charterPath}/${id}/prepare`);expect(refused.statusCode,refused.body).toBe(503);expect(refused.json().error).toMatchObject({creationIntentId:id,status:'held'});
 const admitted=(await app.inject({url:`${charterPath}/${id}`,cookies:f.auth.cookies})).json<CharterCreationWorkflowState>();expect(admitted.status).toBe('admitted');
 const restored=await f.open(),prepared=await f.post(restored,`${charterPath}/${id}/prepare`);expect(prepared.statusCode,prepared.body).toBe(200);expect(prepared.json().policy).toEqual(admitted.policy);
 expect(await f.sql`select * from charter_creation_permit_messages`).toHaveLength(1);expect(await f.balance('charter_creation_escrow')).toBe(f.cost);
});
