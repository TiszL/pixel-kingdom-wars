/** Fixture history tests use the real activity capture and persisted SQL journal. */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { Keypair } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { createDb } from '../src/db/client';
import { runMigrations } from '../src/db/migrate';
import { collectMiningActivityEvidence } from '../src/mining/activityEvidence';
import { ADMIN_DATABASE_URL } from './db-url';
import { createMigratedDatabase } from './migratedTemplate';
import { insertActiveTestBase } from './helpers';

const policyVersion='battle-evidence-v1' as const;
const input=(day:string)=>({day,policyVersion});
async function fixture(run:(f:Awaited<ReturnType<typeof setup>>)=>Promise<void>) {
  const f=await setup();
  try { await run(f); } finally {
    await f.conn.sql.end(); await f.admin.unsafe(`drop database ${f.database} with (force)`); await f.admin.end();
  }
}
async function setup() {
  const database=`mining_activity_${randomUUID().replaceAll('-','')}_test`;
  const url=new URL(ADMIN_DATABASE_URL); url.pathname=`/${database}`;
  if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname)) throw new Error('unsafe fixture host');
  const admin=postgres(ADMIN_DATABASE_URL,{max:1,onnotice:()=>{}});
  await createMigratedDatabase(admin, database);
  const conn=createDb(url.toString(),{max:4}); await runMigrations(conn.db);
  await conn.sql`update playtest_activity_coverage set started_at='2019-01-01T00:00:00Z' where key='authoritative-v1'`;
  const wallets=Array.from({length:3},()=>Keypair.generate().publicKey.toBase58());
  for(const wallet of wallets) await conn.sql`insert into players(wallet) values(${wallet})`;
  const bases=[randomUUID(),randomUUID(),randomUUID()];
  // Production bases always carry their owner's active slot; PvP capture (D153.235/238) requires it.
  for(let i=0;i<bases.length;i++) await insertActiveTestBase(conn.db,{id:bases[i]!,ownerWallet:wallets[i===1?0:i]!,status:'active'});
  const raid=async(day:string,opts:{wallet?:string;base?:string;opponent?:string|null;opponentBase?:string;status?:'resolving'|'resolved'|'expired';stars?:number;at?:string;resolvedAt?:string}={})=>{
    const id=randomUUID(),wallet=opts.wallet??wallets[0]!,base=opts.base??bases[0]!;
    const accepted=opts.at??`${day}T12:00:00.000Z`,resolvedAt=opts.resolvedAt??`${day}T12:05:00.000Z`;
    await conn.sql`insert into raids(id,attacker_wallet,attacker_base_id,defender_wallet,defender_base_id,campaign_stage,seed,snapshot,army_snapshot,orders,orders_deadline_at,status,bulk_deployment_accepted_at,created_at)
      values(${id},${wallet},${base},${opts.opponent??null},${opts.opponent?opts.opponentBase??bases[2]!:null},${opts.opponent?null:1},1,'{}','{}','{"deploys":[{}],"heroDeploys":[]}',${accepted},'resolving',${accepted},${new Date(Date.parse(accepted)-1000).toISOString()})`;
    await conn.sql`update player_action_events set occurred_at=${accepted} where source_table='raids' and source_id=${id} and source_key='battle_fought'`;
    const finish=async(stars=opts.stars??1)=>{
      await conn.sql`update raids set status='resolved',result=${JSON.stringify({stars,retreated:false})}::jsonb,resolved_at=${resolvedAt} where id=${id}`;
      await conn.sql`update player_action_events set occurred_at=${resolvedAt} where source_table='raids' and source_id=${id} and source_key in ('pve_battle','pvp_win')`;
    };
    if((opts.status??'resolved')==='resolved') await finish();
    if(opts.status==='expired') await conn.sql`update raids set status='expired' where id=${id}`;
    return {id,wallet,base,accepted,finish};
  };
  const redeploy=async(r:Awaited<ReturnType<typeof raid>>,at:string)=>{
    const [command]=await conn.sql`insert into raid_commands(raid_id,sequence,client_command_id,kind,payload,server_offset_ms,payload_hash,accepted_at)
      values(${r.id},(select coalesce(max(sequence),0)+1 from raid_commands where raid_id=${r.id}),${randomUUID()},'deploy','{}',1,'fixture',${at}) returning id::text`;
    await conn.sql`update player_action_events set occurred_at=${at} where source_table='raid_commands' and source_id=${command!.id}`;
  };
  return {database,url,admin,conn,wallets,bases,raid,redeploy};
}

describe('server-derived mining battle evidence',()=>{
  it('seals fourteen past days from source facts and replays unchanged after reconnect and ownership transfer',async()=>fixture(async f=>{
    const expected=[];
    for(let i=1;i<=14;i++) {
      const day=`2020-01-${String(i).padStart(2,'0')}`;
      const a=await f.raid(day),b=await f.raid(day,{wallet:f.wallets[1]!,base:f.bases[2]!,opponent:f.wallets[2]!});
      expected.push({day,rows:[a,b]});
    }
    await f.conn.sql`update bases set owner_wallet=${f.wallets[2]!} where id=${f.bases[0]!}`;
    const sealed=[];
    for(const {day,rows} of expected) {
      const result=await collectMiningActivityEvidence(f.conn.db,input(day));
      expect(result).toEqual({day,policyVersion,allocationReady:false,
        unavailable:['contribution','epoch-roster','bonus','progression','source-attribution'],
        wallets:rows.map(r=>({wallet:r.wallet,playedRaidIds:[r.id],freshBattleEvidence:true,lastActionAt:r.accepted})).sort((a,b)=>a.wallet<b.wallet?-1:1)});
      sealed.push(result);
    }
    const reconnected=createDb(f.url.toString(),{max:1});
    try { for(let i=0;i<expected.length;i++) expect(await collectMiningActivityEvidence(reconnected.db,input(expected[i]!.day))).toEqual(sealed[i]); }
    finally { await reconnected.sql.end(); }
    expect((await f.conn.sql`select count(*)::int n from mining_activity_evidence`)[0]!.n).toBe(14);
    await expect(f.conn.sql`update mining_activity_evidence set evidence='{}'`).rejects.toThrow();
    await expect(f.conn.sql`delete from mining_activity_evidence`).rejects.toThrow();
    await expect(f.conn.sql`truncate mining_activity_evidence`).rejects.toThrow();
  }),60_000);

  it('assigns midnight redeploys and delayed resolution to the first accepted raid day across two bases',async()=>fixture(async f=>{
    const first=await f.raid('2020-02-01',{at:'2020-02-01T23:59:59.000Z',resolvedAt:'2020-02-03T00:00:00.000Z'});
    await f.redeploy(first,'2020-02-02T00:00:01.000Z');
    const second=await f.raid('2020-02-01',{base:f.bases[1]!});
    const result=await collectMiningActivityEvidence(f.conn.db,input('2020-02-01'));
    expect(result.wallets).toEqual([{wallet:f.wallets[0],playedRaidIds:[first.id,second.id].sort(),freshBattleEvidence:true,lastActionAt:first.accepted}]);
    expect((await collectMiningActivityEvidence(f.conn.db,input('2020-02-02'))).wallets).toEqual([]);
    await f.redeploy(first,'2020-02-04T00:00:01.000Z');
    expect(await collectMiningActivityEvidence(f.conn.db,input('2020-02-01'))).toEqual(result);
  }),30_000);

  it('defers pending participation without sealing, then retries; proven losses, expiry and self battles do not qualify',async()=>fixture(async f=>{
    const pending=await f.raid('2020-03-01',{status:'resolving'});
    await expect(collectMiningActivityEvidence(f.conn.db,input('2020-03-01'))).rejects.toMatchObject({code:'PENDING_BATTLES'});
    expect((await f.conn.sql`select count(*)::int n from mining_activity_evidence`)[0]!.n).toBe(0);
    await pending.finish();
    expect((await collectMiningActivityEvidence(f.conn.db,input('2020-03-01'))).wallets[0]!.playedRaidIds).toEqual([pending.id]);
    await f.raid('2020-03-02',{stars:0}); await f.raid('2020-03-02',{status:'expired'});
    // A self battle defends a base its own wallet owns (bases[1]): since D153.235/238 the
    // raid capture refuses a defender wallet that does not own the defender base.
    await f.raid('2020-03-02',{opponent:f.wallets[0]!,opponentBase:f.bases[1]!});
    expect((await collectMiningActivityEvidence(f.conn.db,input('2020-03-02'))).wallets).toEqual([]);
  }),30_000);

  it('ignores payments, chat, passive collection, refining, claims and construction',async()=>fixture(async f=>{
    for(const key of ['keep_deposit','chat_sent','mine_collected','forge_refine','mail_claimed','build_started'])
      await f.conn.sql`select record_player_action(${f.wallets[0]!},${key},'fixture',${key},'2020-04-01T12:00:00Z',${f.bases[0]!},true,false,'{}')`;
    expect((await collectMiningActivityEvidence(f.conn.db,input('2020-04-01'))).wallets).toEqual([]);
  }),30_000);

  it('rejects caller policy/clock/scores, uncovered days, old raids and contradictory resolution evidence',async()=>fixture(async f=>{
    for(const value of [{...input('2020-04-02'),bps:100},{...input('2020-04-02'),ownership:[]},{...input('2020-04-02'),contributions:[]},
      {...input('2020-04-02'),now:'2020-04-03'},input('2020-02-30'),{day:'2020-04-02',policyVersion:'caller'},input('2999-01-01')])
      await expect(collectMiningActivityEvidence(f.conn.db,value)).rejects.toThrow();
    await f.conn.sql`update playtest_activity_coverage set started_at='2020-04-02T00:00:01Z'`;
    await expect(collectMiningActivityEvidence(f.conn.db,input('2020-04-02'))).rejects.toMatchObject({code:'COVERAGE_UNAVAILABLE'});
    await f.conn.sql`update playtest_activity_coverage set started_at='2019-01-01'`;
    const r=await f.raid('2020-04-02');
    await f.conn.sql`update raids set created_at='2018-01-01' where id=${r.id}`;
    await expect(collectMiningActivityEvidence(f.conn.db,input('2020-04-02'))).rejects.toMatchObject({code:'COVERAGE_UNAVAILABLE'});
    await f.conn.sql`update raids set created_at='2020-04-02T11:59:59Z' where id=${r.id}`;
    await f.conn.sql`update player_action_events set metadata=metadata||'{"stars":2}' where source_id=${r.id} and source_key='pve_battle'`;
    await expect(collectMiningActivityEvidence(f.conn.db,input('2020-04-02'))).rejects.toMatchObject({code:'SOURCE_CONFLICT'});
    await f.conn.sql`delete from playtest_activity_coverage`;
    await expect(collectMiningActivityEvidence(f.conn.db,input('2020-04-03'))).rejects.toMatchObject({code:'COVERAGE_UNAVAILABLE'});
    expect((await f.conn.sql`select count(*)::int n from mining_activity_evidence`)[0]!.n).toBe(0);
  }),30_000);

  it('fails fast on an active writer, rolls back a refused seal, and preserves migration replay',async()=>fixture(async f=>{
    let release!:()=>void, ready!:()=>void;
    const gate=new Promise<void>(r=>{release=r}),locked=new Promise<void>(r=>{ready=r});
    const writer=f.conn.sql.begin(async tx=>{await tx`lock table player_action_events in row exclusive mode`;ready();await gate;});
    try { await locked; await expect(collectMiningActivityEvidence(f.conn.db,input('2020-05-01'))).rejects.toMatchObject({code:'ACTIVITY_BUSY'}); }
    finally {release();await writer;}
    await f.conn.sql`create function refuse_activity_seal() returns trigger language plpgsql as $$ begin raise exception 'fixture seal failure'; end $$`;
    await f.conn.sql`create trigger fixture_refusal before insert on mining_activity_evidence for each row execute function refuse_activity_seal()`;
    await expect(collectMiningActivityEvidence(f.conn.db,input('2020-05-01'))).rejects.toMatchObject({cause:{message:'fixture seal failure'}});
    expect((await f.conn.sql`select count(*)::int n from mining_activity_evidence`)[0]!.n).toBe(0);
    await f.conn.sql`drop trigger fixture_refusal on mining_activity_evidence`;
    const result=await collectMiningActivityEvidence(f.conn.db,input('2020-05-01'));
    const migration=readFileSync(new URL('../drizzle/0159_mining_activity_evidence.sql',import.meta.url),'utf8');
    for(const statement of migration.split('--> statement-breakpoint').filter(s=>s.trim())) await f.conn.sql.unsafe(statement);
    expect(await collectMiningActivityEvidence(f.conn.db,input('2020-05-01'))).toEqual(result);
  }),30_000);

  it('refuses an oversized source window instead of sealing a truncated zero',async()=>fixture(async f=>{
    await f.conn.sql`insert into player_action_events(id,wallet,source_key,occurred_at,active,fought,source_table,source_id,metadata)
      select 'large-'||n,${f.wallets[0]!},'battle_fought','2020-06-01T12:00:00Z',false,false,'fixture',n::text,'{}'::jsonb
      from generate_series(1,2001) n`;
    await expect(collectMiningActivityEvidence(f.conn.db,input('2020-06-01'))).rejects.toMatchObject({code:'TOO_LARGE'});
    expect((await f.conn.sql`select count(*)::int n from mining_activity_evidence`)[0]!.n).toBe(0);
  }),30_000);
});
