/** Actual settled paid/free allocation and actual serialized claim receipts.
 * These finalized fixture banks are local inputs, not live chain acceptance. */
import {randomUUID} from 'node:crypto';
import {PublicKey} from '@solana/web3.js';
import {ORDINARY_REFINED_IDS} from '@shardkeep/shared/phaseEOrdinaryCrafting';
import {createDivineTrials,type DivineTrialOptions} from '../../src/game/divineTrials';
import {withFundedMiningReplayFixture,type FundedReplayFixture} from './fundedMiningReplay';
import {executeFundedMiningClaim} from './fundedMiningClaims';
import vectors from '../../../../packages/shared/src/testFixtures/divineTrialVectors.json' with {type:'json'};
type Client=ReturnType<typeof createDivineTrials>;
type Claim=Awaited<ReturnType<typeof executeFundedMiningClaim>>;
// Keep the exported fixture portable without leaking inferred private fixture types.
export interface DivineTrialFixture {
 f:FundedReplayFixture;db:FundedReplayFixture['conn']['db'];sql:FundedReplayFixture['conn']['sql'];
 domain:DivineTrialOptions['domain'];clock:()=>Date;options:DivineTrialOptions;
 client:Client;service:()=>Client;event:Awaited<ReturnType<Client['fund']>>;budget:Record<string,string>;
 wallet:string;buyer:string;baseId:string;buyerBaseId:string;bank:Claim['post'];first:Claim;second:Claim;
 orders:(name?:string)=>(typeof vectors.plans)[number]['attempt']['orders'];setTime:(value:string|Date)=>void;
 setConfig:(change:Record<string,unknown>)=>Promise<void>;setOnline:(value:boolean)=>void;setDeedOnline:(value:boolean)=>void;
 beforeRead:(fn:(()=>Promise<void>)|null)=>void;
 enter:(wallet?:string,baseId?:string)=>ReturnType<Client['enter']>;
 admit:(wallet?:string,baseId?:string)=>ReturnType<Client['admit']>;
}
async function fixture(f:FundedReplayFixture):Promise<DivineTrialFixture>{
 const stage=await f.stage('2020-01-01');
 // Date-only fixture births follow the database timezone; qualification uses
 // original UTC birth/activity coverage. Seal that real extra closed day through
 // the existing collectors, never fabricate zero XP or qualification journals.
 const coverage=await f.conn.sql<{wallet:string;fromDay:string;timezone:string}[]>`
  select e.wallet,to_char(greatest(date_trunc('day',(e.after_state->>'created_at')::timestamptz at time zone 'UTC'),
   date_trunc('day',a.started_at at time zone 'UTC')+case when a.started_at at time zone 'UTC'=date_trunc('day',a.started_at at time zone 'UTC') then interval '0 days' else interval '1 day' end),'YYYY-MM-DD') as "fromDay",
   current_setting('timezone') as timezone
  from public.mining_free_cohort_events e cross join public.playtest_activity_coverage a
  where a.key='authoritative-v1' and e.source_table='players' and e.operation='INSERT'
   and e.before_state is null and e.wallet in(${f.wallet},${f.buyer}) and e.source_id=e.wallet`;
 if(coverage.length!==2||new Set(coverage.map(row=>row.wallet)).size!==2||coverage.some(row=>!['2019-12-30','2019-12-31'].includes(row.fromDay)))throw Error('Unexpected Divine fixture coverage');
 const diagnostics=process.env.DIVINE_FIXTURE_COVERAGE_DIAGNOSTICS==='1';
 const daysBefore=diagnostics?await f.conn.sql`select day::text from mining_wallet_experience_days order by day`:null;
 if(coverage.some(row=>row.fromDay==='2019-12-30'))await f.collect('2019-12-30');
 if(diagnostics)console.info('Divine fixture UTC coverage',JSON.stringify({coverage:coverage.map(({fromDay,timezone})=>({fromDay,timezone})),daysBefore,daysAfter:await f.conn.sql`select day::text from mining_wallet_experience_days order by day`}));
 const publication=await stage.publish();
 const first=await executeFundedMiningClaim(f,publication,null);f.acceptClaim(first);
 const second=await executeFundedMiningClaim({...f,wallet:f.buyer,walletSigner:f.buyerSigner},f.current()!,null);f.acceptClaim(second);
 if(first.postSnapshot.renownRecord?.renownTotal!==1n||second.postSnapshot.renownRecord?.renownTotal!==1n)throw Error('Actual earned Renown missing');
 const bank=second.post,slot=second.postSnapshot.slot;
 let at=new Date('2020-01-03T00:00:00.000Z'),online=true,deedOnline=true,beforeRead:(()=>Promise<void>)|null=null;
 const clock=()=>new Date(at),domain={genesisHash:f.identity.genesisHash,economyProgram:f.identity.programId};
 const setTime=(value:string|Date)=>{at=new Date(value);(bank.rows[7]!.data as Buffer).writeBigInt64LE(BigInt(Math.floor(at.getTime()/1000)),32);};setTime(at);
 const reader={getGenesisHash:async()=>{if(!online)throw Error('Fixture offline');return domain.genesisHash;},getSlot:async()=>slot,
  getMultipleAccountsInfoAndContext:async(keys:PublicKey[])=>{if(beforeRead)await beforeRead();if(!online)throw Error('Fixture offline');const walletBank=keys.at(-1)?.toBase58()===f.wallet?first.post:keys.at(-1)?.toBase58()===f.buyer?second.post:null;if(!walletBank)throw Error('Unknown wallet');return {context:{slot},value:[...bank.rows.slice(0,10),...walletBank.rows.slice(10)]};}};
 const options={domain,sponsorWallet:f.wallet,qualificationSource:{reader,trust:publication.chain.trusted},clock,
  deedCollection:stage.stock.bank.input.collection,finalizedDeedReader:async(asset:string)=>{if(!deedOnline||asset!==f.assetId)throw Error('Fixture deed unavailable');return {owner:f.buyer,slot:slot+1,collection:stage.stock.bank.input.collection,frozen:false,delegate:null};}},service=()=>createDivineTrials(f.conn.db,options),client=service();
 const budget=Object.fromEntries(ORDINARY_REFINED_IDS.map(item=>[item,'7']));
 for(const item of ORDINARY_REFINED_IDS)await f.conn.sql`insert into crafting_stocks(base_id,item_id,available) values(${f.baseId},${item},11) on conflict(base_id,item_id) do update set available=crafting_stocks.available+11`;
 const event=await client.fund(f.wallet,{id:randomUUID(),baseId:f.baseId,weekStart:'2020-01-04T00:00:00.000Z',budget});
 const orders=(name='south')=>structuredClone(vectors.plans.find(p=>p.name===name)!.attempt.orders);
 return {f,db:f.conn.db,sql:f.conn.sql,domain,clock,options,client,service,event,budget,wallet:f.wallet,buyer:f.buyer,baseId:f.baseId,buyerBaseId:f.paidBaseId,bank,first,second,orders,setTime,
  setConfig:async(change:Record<string,unknown>)=>{Object.assign(bank.backing.model,change);await bank.backing.config();bank.rows[0]=bank.backing.rows[0]!;},
  setOnline:(v:boolean)=>{online=v;},setDeedOnline:(v:boolean)=>{deedOnline=v;},beforeRead:(fn:(()=>Promise<void>)|null)=>{beforeRead=fn;},
  enter:async(wallet=f.wallet,baseId=f.baseId)=>client.enter(wallet,event.id,{baseId,idempotencyKey:randomUUID()}),
  admit:async(wallet=f.wallet,baseId=f.baseId)=>client.admit(wallet,event.id,{baseId,idempotencyKey:randomUUID()}),
 };
}
export async function withDivineTrialFixture(run:(f:DivineTrialFixture)=>Promise<void>){
 const keys=['PHASE_E_CATALOG_ENABLED','PHASE_E_BUILDINGS_ENABLED','PHASE_E_MINING_ENABLED'],prior=keys.map(k=>[k,process.env[k]] as const);for(const k of keys)process.env[k]='true';
 try{await withFundedMiningReplayFixture(async f=>run(await fixture(f)));}finally{for(const [k,v] of prior){if(v===undefined)delete process.env[k];else process.env[k]=v;}}
}
