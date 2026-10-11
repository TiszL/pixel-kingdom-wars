import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {PHASE_E_POLICY} from '@shardkeep/shared';
import {charterSalesWorkflowFixture,salesPath,noSaleAuthority,type SalesWorkflowFixture} from './fixtures/charterSalesWorkflow';
import {setupCharterSaleRaidActor} from './fixtures/charterSalesRaid';
import {settleCharterSaleFixtureGross} from './fixtures/charterSalesRaidPayout';
import {createRaid,compensatePendingRaid} from '../src/game/raids';
import type {CharterSaleView} from '../src/game/clanCharterSales';
let f:SalesWorkflowFixture|undefined;
beforeEach(async()=>{f=undefined;f=await charterSalesWorkflowFixture();},120000);
afterEach(async()=>{const old=f;f=undefined;try{await old?.dispose();}finally{vi.restoreAllMocks();vi.unstubAllEnvs();}},120000);

it('composes authenticated draft, buyer acceptance, actual members payout, both wallet signatures and finalized roster exactly once',async()=>{
 const c=f!,app=await c.open(),p=await c.prepared(app),id=p.state.id;
 expect(p.state).toMatchObject({status:'prepared',memberPayment:{totalShards:'0'},...noSaleAuthority});
 expect(p.state.preparation!.costs).toMatchObject({priceLamports:'1000000000',sellerLamports:'950000000',royaltyLamports:'50000000'});
 const wire=c.signed(p.state),retained=await c.post(app,`${salesPath}/${id}/signed`,wire.body,c.buyerAuth.cookies);expect(retained.statusCode,retained.body).toBe(200);expect(retained.json().status).toBe('signed');
 await c.finalize(id);
 for(let n=0;n<2;n++){const complete=await c.post(app,`${salesPath}/${id}/recover`);expect(complete.statusCode,complete.body).toBe(200);expect(complete.json()).toMatchObject({status:'completed',terminal:{outcome:'completed'},...noSaleAuthority});}
 expect(await c.sql`select leader_wallet from clans where id=${c.birth.consent.clanId}`).toEqual([{leader_wallet:c.buyer.wallet}]);
 expect(await c.sql`select player_wallet from clan_members where clan_id=${c.birth.consent.clanId}`).toEqual([{player_wallet:c.buyer.wallet}]);
 expect(c.issuer.issueOnce).toHaveBeenCalledTimes(1);expect(await c.sql`select * from clan_charter_member_payments`).toHaveLength(1);
});

it('replays exact original and signed packet history offline before current flags, providers and metadata',async()=>{
 const c=f!,app=await c.open(),p=await c.prepared(app),retained=await c.post(app,`${salesPath}/${p.state.id}/signed`,c.signed(p.state).body);expect(retained.statusCode,retained.body).toBe(200);
 vi.stubEnv('PHASE_E_CHARTER_ENABLED','false');vi.stubEnv('MULTI_BASE_ENABLED','false');c.setOnline(false);
 const offline=await c.open({options:{newSaleDomain:null,chain:null,issuer:null,finalizedDeedReader:null,deedCollection:null}}),before=await c.salesSnapshot(),calls=c.connect.mock.calls.length;
 const replay=await c.post(offline,salesPath,p.input);expect(replay.statusCode,replay.body).toBe(201);expect(replay.json()).toEqual(retained.json());
 for(const suffix of ['', '/prepare','/recover-preparation','/pay-members']){const response=suffix?await c.post(offline,`${salesPath}/${p.state.id}${suffix}`):await offline.inject({url:`${salesPath}/${p.state.id}`,cookies:c.buyerAuth.cookies});expect(response.statusCode,response.body).toBe(200);expect(response.json()).toEqual(retained.json());}
 expect(c.connect).toHaveBeenCalledTimes(calls);expect(await c.salesSnapshot()).toBe(before);
});

it('retains the committed exposure after a lost issuer response and uses lookup only across restart and null lookup',async()=>{
 const c=f!,app=await c.open(),p=await c.accepted(app),id=p.state.id;c.hooks.afterIssue=async()=>{throw Error('Lost genuine issuer receipt');};
 const failed=await c.post(app,`${salesPath}/${id}/prepare`);expect(failed.statusCode,failed.body).toBe(503);
 const saved=await c.store().read(c.birth.actor.wallet,id);expect(saved.status).toBe('issuing');expect(saved.inventory.count).toBe(1);
 const restarted=await c.open();c.hooks.lookupNull=true;const empty=await c.post(restarted,`${salesPath}/${id}/recover-preparation`);expect(empty.statusCode,empty.body).toBe(200);expect(empty.json().status).toBe('issuing');
 c.hooks.lookupNull=false;const restored=await c.post(restarted,`${salesPath}/${id}/prepare`);expect(restored.statusCode,restored.body).toBe(200);expect(restored.json().status).toBe('prepared');
 expect(c.issuer.issueOnce).toHaveBeenCalledTimes(1);expect((await c.store().read(c.buyer.wallet,id)).inventory).toEqual(saved.inventory);
});

it('cancels only a strictly expired complete original inventory while paused and releases the buyer without undoing members payout',async()=>{
 const c=f!,app=await c.open(),p=await c.prepared(app),id=p.state.id,saved=await c.store().read(c.buyer.wallet,id),candidate=Buffer.from(saved.attempt!.candidateHex,'hex'),before=await c.salesSnapshot();
 c.bank.clock.writeBigInt64LE(candidate.readBigInt64LE(121),32);const live=await c.post(app,`${salesPath}/${id}/cancel`);expect(live.statusCode,live.body).toBe(503);expect(await c.salesSnapshot()).toBe(before);
 const changed=await c.open({options:{chain:{...c.chain,trust:{...c.chain.trust,economy:{...c.chain.trust.economy,reviewedProgramDataSha256:'ab'.repeat(32)}}}}}),calls=c.connect.mock.calls.length;
 const rebound=await c.post(changed,`${salesPath}/${id}/cancel`);expect(rebound.statusCode,rebound.body).toBe(503);expect(c.connect).toHaveBeenCalledTimes(calls);expect(await c.salesSnapshot()).toBe(before);
 c.bank.clock.writeBigInt64LE(candidate.readBigInt64LE(121)+1n,32);c.bank.row.data[c.bank.offsets['paused']!]=1;c.bank.rows.find(r=>r.address.toBase58()===c.birth.consent.chain.craftControl)!.data[137]=1;vi.stubEnv('PHASE_E_CHARTER_ENABLED','false');
 const result=await c.post(app,`${salesPath}/${id}/cancel`,{},c.buyerAuth.cookies);expect(result.statusCode,result.body).toBe(200);expect(result.json()).toMatchObject({status:'cancelled',memberPayment:p.state.memberPayment,terminal:{outcome:'cancelled'}});
 c.setOnline(false);expect((await c.post(app,`${salesPath}/${id}/cancel`)).json()).toEqual(result.json());expect(await c.salesSnapshot()).toBe(before);
});

it('refuses cancellation of a real finalized receipt and reconciles it before exposing completed history',async()=>{
 const c=f!,app=await c.open(),p=await c.prepared(app),id=p.state.id;expect((await c.post(app,`${salesPath}/${id}/signed`,c.signed(p.state).body)).statusCode).toBe(200);await c.finalize(id);
 const response=await c.post(app,`${salesPath}/${id}/cancel`);expect(response.statusCode,response.body).toBe(200);expect(response.json().status).toBe('completed');
 const old=await c.store().read(c.birth.actor.wallet,id);expect(old.terminal!.outcome).toBe('completed');c.setOnline(false);
 const read=await app.inject({url:`${salesPath}/${id}`,cookies:c.buyerAuth.cookies});expect(read.json<CharterSaleView>().terminal!.outcome).toBe('completed');
});

it('completes a second sale after positive member payment and a later source event without rewriting the first paid prefix or founder history',async()=>{
 const c=f!;
 async function legacy<T>(run:()=>Promise<T>){const prior=process.env['MULTI_BASE_ENABLED'];process.env['MULTI_BASE_ENABLED']='false';try{return await run();}finally{if(prior===undefined)delete process.env['MULTI_BASE_ENABLED'];else process.env['MULTI_BASE_ENABLED']=prior;}}
 await setupCharterSaleRaidActor(c,c.source.wallet);const defender=await c.actor();
 const firstRaid=await legacy(()=>createRaid(c.db,c.source.wallet,{defenderWallet:defender.wallet,idempotencyKey:randomUUID()}));
 // Real captured charge, original clan route, ledger and terminal. Gross is the
 // explicitly declared B6p fixture boundary, not a protected combat-writer claim.
 const tithe=await legacy(()=>settleCharterSaleFixtureGross(c.db,firstRaid.id,BigInt(PHASE_E_POLICY.basisPoints)));
 expect(tithe.chestCut).toBeGreaterThan(0n);
 const baseBefore=BigInt((await c.sql`select balance::text from accounts where id=${c.source.account.id}`)[0]!.balance);
 const app=await c.open(),first=await c.prepared(app);expect(first.state.memberPayment!.totalShards).toBe(tithe.chestCut.toString());
 expect(BigInt((await c.sql`select balance::text from accounts where id=${c.source.account.id}`)[0]!.balance)-baseBefore).toBe(tithe.chestCut);
 expect((await c.post(app,`${salesPath}/${first.state.id}/signed`,c.signed(first.state).body)).statusCode).toBe(200);await c.finalize(first.state.id);
 const completed=await c.post(app,`${salesPath}/${first.state.id}/recover`);expect(completed.statusCode,completed.body).toBe(200);const original=await c.store().read(c.birth.actor.wallet,first.state.id);
 const oldPost=await c.sql`select to_jsonb(t) transaction,(select jsonb_agg(to_jsonb(e) order by e.id) from ledger_entries e where e.txn_id=t.id) entries from ledger_transactions t where idempotency_key=${'clan-charter:member-payment:'+first.state.memberPayment!.id}`;
 expect(oldPost).toHaveLength(1);const ordinal=BigInt((await c.sql`select ordinal::text from clan_charter_event_heads where clan_id=${c.birth.consent.clanId}`)[0]!.ordinal);
 // A genuine new leader raid is later refunded by the existing compensation
 // service. History must validate its original prefix, not today's longer head.
 await setupCharterSaleRaidActor(c,c.buyer.wallet);const laterDefender=await c.actor();
 const laterRaid=await legacy(()=>createRaid(c.db,c.buyer.wallet,{defenderWallet:laterDefender.wallet,idempotencyKey:randomUUID()}));
 await legacy(()=>compensatePendingRaid(c.db,{id:laterRaid.id,attackerWallet:c.buyer.wallet,simVersion:laterRaid.simVersion},false,undefined,true));
 expect(BigInt((await c.sql`select ordinal::text from clan_charter_event_heads where clan_id=${c.birth.consent.clanId}`)[0]!.ordinal)).toBeGreaterThan(ordinal);
 expect(await c.store().read(c.birth.actor.wallet,first.state.id)).toEqual(original);
 const next=await c.actor(),auth=await c.session(next.wallet),second=await c.open({options:{deedCollection:next.collection}}),draft=await c.post(second,salesPath,{clanId:c.birth.consent.clanId,buyer:next.wallet,priceLamports:'2000000000',sellerLeaves:false,idempotencyKey:randomUUID()},c.buyerAuth.cookies);
 expect(draft.statusCode,draft.body).toBe(201);const state=draft.json<CharterSaleView>();c.selectSale(state);expect(state.original).toMatchObject({seller:c.buyer.wallet,expectedRevision:1});
 const accepted=await c.post(second,`${salesPath}/${state.id}/accept`,{termsHash:state.original.termsHash,buyerBaseId:next.baseId},auth.cookies);expect(accepted.statusCode,accepted.body).toBe(200);
 const prepared=await c.post(second,`${salesPath}/${state.id}/prepare`,{},c.buyerAuth.cookies);expect(prepared.statusCode,prepared.body).toBe(200);
 const wire=c.signed(prepared.json<CharterSaleView>()),saved=await c.post(second,`${salesPath}/${state.id}/signed`,wire.body,auth.cookies);expect(saved.statusCode,saved.body).toBe(200);await c.finalize(state.id);
 const result=await c.post(second,`${salesPath}/${state.id}/recover`,{},auth.cookies);expect(result.statusCode,result.body).toBe(200);expect(result.json().status).toBe('completed');
 expect(await c.sql`select leader_wallet from clans where id=${c.birth.consent.clanId}`).toEqual([{leader_wallet:next.wallet}]);
 expect((await c.sql`select player_wallet from clan_members where clan_id=${c.birth.consent.clanId}`).map(v=>v.player_wallet).sort()).toEqual([c.buyer.wallet,next.wallet].sort());
 expect(await c.store().read(c.birth.actor.wallet,first.state.id)).toEqual(original);expect(await c.sql`select * from clan_charter_member_payments`).toHaveLength(2);expect(c.issuer.issueOnce).toHaveBeenCalledTimes(2);
 expect(await c.sql`select to_jsonb(t) transaction,(select jsonb_agg(to_jsonb(e) order by e.id) from ledger_entries e where e.txn_id=t.id) entries from ledger_transactions t where idempotency_key=${'clan-charter:member-payment:'+first.state.memberPayment!.id}`).toEqual(oldPost);
},120000);
