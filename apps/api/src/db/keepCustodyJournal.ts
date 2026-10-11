/** L1/mail/Forge/league fixture execution. Deliberately absent from the read-only CLI/API. */
import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { BASE_OWNERSHIP, GEMS } from '@shardkeep/shared';
import { eq, sql } from 'drizzle-orm';
import { buildRetirementPlan, checkG8, type CustodialLedger } from '../../../../scripts/src/custody-retirement-model';
import { getOrCreatePlayerAccount, postTransaction } from '../ledger';
import { createDb, type Db, type DbTx } from './client';
import { census } from './keepCustodyRetire';
import { accounts, keepCustodyJournal, mailKeepRetirements, mailMessages, baseForgePositions, deedOwnershipObservations, bases } from './schema';

export interface FixtureRetirementRequest {
  fixtureId: string;
  custodyWindowId?: string;
  asOf: string;
  players: { wallet: string; keep: string; internal: boolean }[];
  mails?: { messageId:string; wallet:string; keep:string; internal:boolean }[];
  forge?: { positionId:string; baseId:string; day:string; wallet:string; keep:string; internal:boolean }[];
  league?: { week:string; baseId:string; wallet:string; keep:string; internal:boolean }[];
}

const lexical = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const json = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (_,v: unknown) => typeof v === 'bigint' ? v.toString() : v));
const canonical = (value: unknown): string => JSON.stringify(value, (_,v: unknown) =>
  v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a],[b])=>lexical(a, b))) : v);
const same = (a: unknown,b: unknown) => canonical(a) === canonical(b);
const fail = (code: string): never => { throw new Error(code); };
const read = async <T extends Record<string,unknown>>(tx: DbTx,q: ReturnType<typeof sql>) => await tx.execute<T>(q) as unknown as T[];
const ledgerFields = ['playerKeep','withdrawalEscrow','forgePayoutEscrow','leagueEntitlementEscrow','mailKeepEscrow','emissionPool','gemsMintedRetirement'] as const;
function decodeLedger(value: unknown): CustodialLedger {
  const record = value as Record<string,unknown>;
  if (!record || !ledgerFields.every(k=>typeof record[k] === 'string' && /^-?\d+$/.test(record[k] as string))) fail('CUSTODY_JOURNAL_CONFLICT');
  return Object.fromEntries(ledgerFields.map(k=>[k,BigInt(record[k] as string)])) as unknown as CustodialLedger;
}
export interface Receipt {
  id: string; type: string; idempotencyKey: string; metadata: unknown; createdAt: string;
  entries: {id:string;account:string;kind:string;currency:string;wallet:string|null;baseId:string|null;delta:string;balanceAfter:string}[];
}
async function receipt(tx: DbTx,id: string): Promise<Receipt> {
  const result=await read<{receipt:Receipt}>(tx,sql`select jsonb_build_object('id',t.id,'type',t.type,
    'idempotencyKey',t.idempotency_key,'metadata',t.metadata,'createdAt',t.created_at,'entries',
    (select jsonb_agg(jsonb_build_object('id',e.id::text,'account',a.id,'kind',a.kind,'currency',a.currency,
      'wallet',a.owner_wallet,'baseId',a.base_id,'delta',e.delta::text,'balanceAfter',e.balance_after::text) order by e.id)
      from public.ledger_entries e join public.accounts a on a.id=e.account_id where e.txn_id=t.id)) receipt
    from public.ledger_transactions t where t.id=${id}::uuid`);
  return result[0]?.receipt ?? fail('CUSTODY_RECEIPT_CONFLICT');
}
function expected(p: FixtureRetirementRequest['players'][number] & {messageId?:string;positionId?:string;baseId?:string;day?:string;week?:string},fixtureId: string) {
  const gems=(BigInt(p.keep)*BigInt(GEMS.gemsPerKeep)).toString();
  return {type:p.internal?'gems.retirement.sweep':'gems.retirement',
    key:p.week?`league:retire:${p.baseId}:${p.week}`:p.positionId?`forge:base:${p.day}:${p.baseId}:claim`:p.messageId?`mail:retire:${p.messageId}`:p.internal?`retirement:sweep:${p.wallet}`:`retirement:${p.wallet}`,
    metadata:p.internal
      ? {wallet:p.wallet,keep:p.keep,reason:'internal-wallet',fixtureId,...(p.messageId?{messageId:p.messageId}: {}),...(p.positionId?{positionId:p.positionId,day:p.day,baseId:p.baseId}:{}),...(p.week?{week:p.week,baseId:p.baseId}:{})}
      : {wallet:p.wallet,class:p.week?'L5':p.positionId?'L2':p.messageId?'L4':'L1',keep:p.keep,gems,reason:'retirement',fixtureId,...(p.messageId?{messageId:p.messageId}:{}),...(p.positionId?{positionId:p.positionId,day:p.day,baseId:p.baseId}:{}),...(p.week?{week:p.week,baseId:p.baseId}:{})},
    legs:[{kind:p.week?'league_entitlement_escrow':p.positionId?'forge_payout_escrow':p.messageId?'mail_keep_escrow':'player_keep',currency:'KEEP',wallet:p.week||p.positionId||p.messageId?null:p.wallet,baseId:null,delta:`-${p.keep}`},
      {kind:'emission_pool',currency:'KEEP',wallet:null,baseId:null,delta:p.keep},
      ...p.internal?[]:[{kind:'gems_mint',currency:'GEMS',wallet:null,baseId:null,delta:`-${gems}`},
        {kind:'player_gems',currency:'GEMS',wallet:p.wallet,baseId:null,delta:gems}]]};
}
function assertReceipt(saved: Receipt,p: FixtureRetirementRequest['players'][number] & {messageId?:string;positionId?:string;baseId?:string;day?:string;week?:string},fixtureId:string) {
  const e=expected(p,fixtureId), legs=saved.entries?.map(({kind,currency,wallet,baseId,delta})=>({kind,currency,wallet,baseId,delta}));
  const ordered=(v:unknown[])=>v.map(canonical).sort();
  if(saved.type!==e.type || saved.idempotencyKey!==e.key || !same(saved.metadata,e.metadata)
    || !legs || !same(ordered(legs),ordered(e.legs)) || new Set(saved.entries.map(x=>x.account)).size!==e.legs.length)
    fail('CUSTODY_RECEIPT_CONFLICT');
}

interface ForgeEvidence { position:Record<string,unknown>; observation:Record<string,unknown>; keep:Receipt; shards:Receipt }
function assertHistoricalForgeAuthority(evidence:ForgeEvidence,f:NonNullable<FixtureRetirementRequest['forge']>[number],asOf:string) {
  const p=evidence.position,o=evidence.observation;
  const checked=typeof o.checkedAt==='string'?Date.parse(o.checkedAt):NaN, at=Date.parse(asOf);
  if(p.id!==f.positionId || p.baseId!==f.baseId || p.day!==f.day || p.keepPaid!==f.keep
    || o.baseId!==f.baseId || o.owner!==f.wallet || o.status!=='owned'
    || typeof o.slot!=='string' || !/^(0|[1-9]\d*)$/.test(o.slot)
    || typeof o.assetId!=='string' || new PublicKey(o.assetId).toBase58()!==o.assetId
    || !Number.isFinite(checked) || checked>at || at-checked>BASE_OWNERSHIP.mutationFreshnessMs)
    fail('CUSTODY_FORGE_EVIDENCE_CONFLICT');
}
function assertForgeSettlement(position:typeof baseForgePositions.$inferSelect, keep:Receipt, shards:Receipt) {
  const metadata={day:position.day,baseId:position.baseId,counted:position.countedShards!.toString()};
  const legs=(r:Receipt)=>r.entries.map(({kind,currency,wallet,baseId,delta})=>canonical({kind,currency,wallet,baseId,delta})).sort();
  const expectedKeep=[{kind:'emission_pool',currency:'KEEP',wallet:null,baseId:null,delta:`-${position.keepPaid}`},
    {kind:'forge_payout_escrow',currency:'KEEP',wallet:null,baseId:null,delta:String(position.keepPaid)}];
  const expectedShards=[{kind:'base_forge_escrow',currency:'SHARDS',wallet:null,baseId:position.baseId,delta:`-${position.countedShards}`},
    {kind:'shard_burn',currency:'SHARDS',wallet:null,baseId:null,delta:String(position.countedShards)}];
  if(keep.type!=='forge.allocate' || keep.idempotencyKey!==`forge:base:${position.day}:${position.baseId}:keep`
    || shards.type!=='forge.burn' || shards.idempotencyKey!==`forge:base:${position.day}:${position.baseId}:shards`
    || !same(keep.metadata,metadata) || !same(shards.metadata,metadata)
    || !same(legs(keep),expectedKeep.map(canonical).sort()) || !same(legs(shards),expectedShards.map(canonical).sort())) fail('CUSTODY_FORGE_EVIDENCE_CONFLICT');
}

async function assertLeagueAuthority(tx:DbTx,l:NonNullable<FixtureRetirementRequest['league']>[number],asOf:string) {
  const [base]=await tx.select().from(bases).where(eq(bases.id,l.baseId));
  const [observation]=await tx.select().from(deedOwnershipObservations).where(eq(deedOwnershipObservations.baseId,l.baseId))
    .orderBy(sql`${deedOwnershipObservations.checkedAt} desc`,sql`${deedOwnershipObservations.id} desc`).limit(1);
  const checked=observation?.checkedAt.getTime()??NaN, at=Date.parse(asOf), now=Date.now();
  // A league right follows its deed even while inactive. Require the latest
  // exact ownership observation at F and still fresh at actual acceptance.
  if(!base || !base.deedAssetId || base.ownerWallet!==l.wallet || !observation
    || observation.status!=='owned' || observation.owner!==l.wallet || observation.assetId!==base.deedAssetId
    || observation.slot===null || observation.slot<0n || new PublicKey(observation.assetId).toBase58()!==observation.assetId
    || !Number.isFinite(checked) || checked>at || at-checked>BASE_OWNERSHIP.mutationFreshnessMs
    || checked>now || now-checked>BASE_OWNERSHIP.mutationFreshnessMs) fail('CUSTODY_LEAGUE_OWNERSHIP_REQUIRED');
}

export async function applyFixtureL1Retirement(request: FixtureRetirementRequest,env: NodeJS.ProcessEnv,
  connect: (url:string)=>{db:Db;close:()=>Promise<void>} = url=>{
    const c=createDb(url,{max:1}); return {db:c.db,close:()=>c.sql.end()};
  }) {
  if(env['HOLD_BEFORE_MIGRATE']!=='1' || !env['TEST_DATABASE_URL']) fail('CUSTODY_FIXTURE_REQUIRED');
  const url=new URL(env['TEST_DATABASE_URL']!),database=url.pathname.slice(1);
  if(!['postgres:','postgresql:'].includes(url.protocol) || !['localhost','127.0.0.1','[::1]'].includes(url.hostname)
    || !/^shardkeep_custody_apply_[0-9a-f]{32}_test$/.test(database) || url.search || url.hash) fail('CUSTODY_FIXTURE_REQUIRED');
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(request.fixtureId)
    || !Number.isFinite(Date.parse(request.asOf)) || new Date(request.asOf).toISOString()!==request.asOf) fail('CUSTODY_INPUT_INVALID');
  if (request.custodyWindowId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(request.custodyWindowId)) fail('CUSTODY_INPUT_INVALID');
  const mails=[...(request.mails??[])].sort((a,b)=>lexical(a.messageId,b.messageId));
  const forge=[...(request.forge??[])].sort((a,b)=>lexical(a.positionId,b.positionId));
  if(new Set(forge.map(f=>f.positionId)).size!==forge.length || forge.some(f=>!/^[-0-9a-f]{36}$/.test(f.positionId) || !/^[-0-9a-f]{36}$/.test(f.baseId) || !/^\d{4}-\d{2}-\d{2}$/.test(f.day) || f.day>=request.asOf.slice(0,10))) fail('CUSTODY_INPUT_INVALID');
  const league=[...(request.league??[])].sort((a,b)=>lexical(`${a.baseId}:${a.week}`,`${b.baseId}:${b.week}`));
  if(new Set(league.map(l=>`${l.baseId}:${l.week}`)).size!==league.length || league.some(l=>!/^[-0-9a-f]{36}$/.test(l.baseId) || !/^\d{4}-\d{2}-\d{2}$/.test(l.week) || !Number.isFinite(Date.parse(l.week)) || new Date(l.week).toISOString().slice(0,10)!==l.week || l.week>=request.asOf.slice(0,10))) fail('CUSTODY_INPUT_INVALID');
  const operation=request.league?'fixture:l1-mail-forge-league-retirement':request.forge?'fixture:l1-mail-forge-retirement':request.mails?'fixture:l1-mail-retirement':'fixture:l1-retirement';
  const subcommand=request.league?'retire-l1-mail-forge-league':request.forge?'retire-l1-mail-forge':request.mails?'retire-l1-mail':'retire-l1';
  if(new Set(mails.map(m=>m.messageId)).size!==mails.length || mails.some(m=>!/^[-0-9a-f]{36}$/.test(m.messageId))) fail('CUSTODY_INPUT_INVALID');
  const players=[...request.players].sort((a,b)=>lexical(a.wallet, b.wallet));
  if(new Set(players.map(p=>p.wallet)).size!==players.length || [...players,...mails,...forge,...league].some(p=>
    !/^[1-9]\d*$/.test(p.keep) || typeof p.internal!=='boolean' || new PublicKey(p.wallet).toBase58()!==p.wallet)) fail('CUSTODY_INPUT_INVALID');
  const explicitInternal=[env['ALPHA_WALLETS'],env['ADMIN_WALLETS']].flatMap(v=>v?.split(',').map(w=>w.trim()).filter(Boolean)??[]);
  for(const wallet of explicitInternal) if(new PublicKey(wallet).toBase58()!==wallet) fail('CUSTODY_INPUT_INVALID');
  const bound={fixtureId:request.fixtureId,asOf:request.asOf,players,...(request.custodyWindowId ? {custodyWindowId:request.custodyWindowId}:{}),...(request.mails?{mails}:{}),...(request.forge?{forge}:{}),...(request.league?{league}:{}),explicitInternal:[...new Set(explicitInternal)].sort()};
  const inputHash=createHash('sha256').update(canonical(bound)).digest('hex');
  const plan=buildRetirementPlan({playBalances:players.map(p=>({wallet:p.wallet,keep:BigInt(p.keep)})),
    internalWallets:[...players,...mails,...forge,...league].filter(p=>p.internal).map(p=>p.wallet),forgeUnclaimed:forge.map(f=>({wallet:f.wallet,baseId:f.baseId,keep:BigInt(f.keep),lapsed:false})),legacyForgeUnclaimed:[],
    pendingMailKeep:mails.map(m=>({wallet:m.wallet,mailId:m.messageId,keep:BigInt(m.keep),mixed:false,welcome:false})),leagueEntitlements:league.map(l=>({wallet:l.wallet,entitlementId:`${l.baseId}:${l.week}`,keep:BigInt(l.keep)})),expiredWelcomeWallets:[],withdrawalEscrowKeep:0n});
  const connection=connect(url.toString());
  try { return await connection.db.transaction(async tx=>{
    await tx.execute(sql`set local search_path=pg_catalog,public,pg_temp`);
    // JSON timestamps are part of immutable receipt evidence. Session time zone
    // changes must not make an identical transaction appear to be different.
    await tx.execute(sql`set local time zone 'UTC'`);
    const identity=(await read<{database:string;operator:string;owner:boolean}>(tx,sql`select current_database() as database,current_user as operator,
      current_user=(select pg_get_userbyid(relowner) from pg_catalog.pg_class where oid='public.keep_custody_journal'::regclass)
      and current_user=(select pg_get_userbyid(relowner) from pg_catalog.pg_class where oid='public.keep_custody_cutover_state'::regclass) as owner`))[0]!;
    if(identity.database!==database || !identity.owner) fail('CUSTODY_FIXTURE_IDENTITY_REQUIRED');
    // Full 0154 barrier precedes ALL latch/account locks. Busy writers cause an
    // atomic refusal, not a lock-order inversion or an automatic retry.
    await tx.execute(sql`lock table public.ledger_transactions,public.accounts,public.ledger_entries,public.players,public.bases,public.base_slots,
      public.deed_ownership_observations,public.base_forge_positions,public.forge_contributions,public.raid_loot_reservations,
      public.base_raid_locks,public.mail_messages,public.mail_attachments,public.base_league_entitlements,
      public.withdrawals,public.withdrawal_attempts,public.withdrawal_payout_reservations,public.deposits,
      public.player_items,public.item_listings,public.keep_custody_journal,public.mail_keep_retirements,
      public.keep_custody_source_observations,public.keep_custody_source_windows in access exclusive mode nowait`);
    await tx.execute(sql`lock table public.keep_custody_league_bridge,public.keep_custody_league_weeks,public.keep_custody_league_retirements in access exclusive mode nowait`);
    if (request.custodyWindowId) await tx.execute(sql`select public.shardkeep_keep_source_barrier()`);
    const phase=(await read<{phase:string}>(tx,sql`select phase from public.keep_custody_cutover_state where id for update`))[0]?.phase;
    const [journal]=await tx.select().from(keepCustodyJournal).where(eq(keepCustodyJournal.operation,operation));
    let before:CustodialLedger,after:CustodialLedger,saved:Receipt[];
    let sourceEvidence:Record<string,ForgeEvidence> = {};
    if(journal) {
      if(journal.id!==request.fixtureId || journal.inputHash!==inputHash || !same(journal.request,bound)
        || journal.operatorName!==identity.operator || journal.databaseName!==database || journal.scope!=='fixture'
        || journal.subcommand!==subcommand || journal.dryRun || phase!=='frozen') fail('CUSTODY_JOURNAL_CONFLICT');
      saved=journal.receipts as Receipt[];
      if(!Array.isArray(saved) || saved.length!==players.length+mails.length+forge.length+league.length || new Set(saved.map(r=>r.id)).size!==saved.length) fail('CUSTODY_JOURNAL_CONFLICT');
      for(let i=0;i<players.length+mails.length+forge.length+league.length;i++) {
        assertReceipt(saved[i]!,[...players,...mails,...forge,...league][i]!,request.fixtureId);
        if(!same(saved[i],await receipt(tx,saved[i]!.id))) fail('CUSTODY_RECEIPT_CONFLICT');
      }
      for(const m of mails) {
        const proof=await read<{valid:boolean}>(tx,sql`select bool_and(public.shardkeep_mail_keep_retired(id)) as valid from public.mail_attachments where message_id=${m.messageId}::uuid and kind='KEEP'`);
        if(proof[0]?.valid!==true) fail('CUSTODY_RECEIPT_CONFLICT');
      }
      for(const l of league) await tx.execute(sql`select public.shardkeep_assert_fixture_league_retirement(${l.week}::date,${l.baseId}::uuid,${request.fixtureId}::uuid)`);
      sourceEvidence=journal.sourceEvidence as Record<string,ForgeEvidence>;
      if(!same(Object.keys(sourceEvidence).sort(),forge.map(f=>f.positionId).sort())) fail('CUSTODY_FORGE_EVIDENCE_CONFLICT');
      for(const f of forge) {
        const evidence=sourceEvidence[f.positionId]!;
        // The normal observer refreshes its cache row in place, including on
        // deed transfer. Recovery binds the immutable at-retirement evidence,
        // never today's mutable slot/owner; no second credit is posted.
        assertHistoricalForgeAuthority(evidence,f,request.asOf);
        const [position]=await tx.select().from(baseForgePositions).where(eq(baseForgePositions.id,f.positionId));
        const claimed=saved.find(r=>r.idempotencyKey===`forge:base:${f.day}:${f.baseId}:claim`)!;
        if(!same(json(position),{...evidence.position,claimedAt:request.asOf,claimTxnId:claimed.id,updatedAt:request.asOf})) fail('CUSTODY_FORGE_EVIDENCE_CONFLICT');
        assertForgeSettlement(position!,evidence.keep,evidence.shards);
        if(!same(evidence.keep,await receipt(tx,evidence.keep.id)) || !same(evidence.shards,await receipt(tx,evidence.shards.id))) fail('CUSTODY_FORGE_EVIDENCE_CONFLICT');
      }
      before=decodeLedger(journal.beforeState); after=decodeLedger(journal.afterState);
    } else {
      if(phase!=='withdrawals_closed') fail('CUSTODY_PHASE_REQUIRED');
      const measured=await census(tx,new Date(request.asOf),explicitInternal,request.custodyWindowId);
      if(measured.blockers.length || (!request.forge && measured.input.forgeUnclaimed.length) || measured.input.legacyForgeUnclaimed.length
        || (!request.mails && measured.input.pendingMailKeep.length) || (!request.league && measured.input.leagueEntitlements.length)
        || measured.before.withdrawalEscrow!==0n || (!request.forge && measured.before.forgePayoutEscrow!==0n)
        || (!request.mails && measured.before.mailKeepEscrow!==0n) || (!request.league && measured.before.leagueEntitlementEscrow!==0n)) fail('CUSTODY_UNSUPPORTED_STATE');
      const actual=measured.input.playBalances.filter(p=>p.keep>0n).map(p=>({wallet:p.wallet,keep:p.keep.toString(),internal:measured.input.internalWallets.includes(p.wallet)})).sort((a,b)=>lexical(a.wallet, b.wallet));
      if(!same(players,actual)) fail('CUSTODY_INPUT_MISMATCH');
      const actualMails=measured.input.pendingMailKeep.map(m=>({messageId:m.mailId,wallet:m.wallet,keep:m.keep.toString(),internal:measured.input.internalWallets.includes(m.wallet)})).sort((a,b)=>lexical(a.messageId,b.messageId));
      if(!same(mails,actualMails)) fail('CUSTODY_INPUT_MISMATCH');
      const actualLeague=measured.input.leagueEntitlements.map(l=>{
        const [baseId,week]=l.entitlementId.split(':');
        return {baseId,week,wallet:l.wallet,keep:l.keep.toString(),internal:measured.input.internalWallets.includes(l.wallet)};
      }).sort((a,b)=>lexical(`${a.baseId}:${a.week}`,`${b.baseId}:${b.week}`));
      if(!same(league,actualLeague)) fail('CUSTODY_INPUT_MISMATCH');
      const positions=await tx.select().from(baseForgePositions).where(sql`${baseForgePositions.keepEscrowTxnId} is not null and ${baseForgePositions.claimedAt} is null and ${baseForgePositions.expiredAt} is null`).orderBy(baseForgePositions.id);
      const actualForge=[];
      for(const position of positions) {
        const [base]=await tx.select().from(bases).where(eq(bases.id,position.baseId));
        const [observation]=await tx.select().from(deedOwnershipObservations).where(eq(deedOwnershipObservations.baseId,position.baseId)).orderBy(sql`${deedOwnershipObservations.checkedAt} desc`,sql`${deedOwnershipObservations.id} desc`).limit(1);
        if(!base || base.status!=='active' || !observation || position.countedShards===null || position.countedShards<=0n || !position.keepEscrowTxnId || !position.shardSettlementTxnId) throw new Error('CUSTODY_FORGE_EVIDENCE_CONFLICT');
        const keep=await receipt(tx,position.keepEscrowTxnId), shards=await receipt(tx,position.shardSettlementTxnId);
        assertForgeSettlement(position,keep,shards);
        sourceEvidence[position.id]={position:json(position) as Record<string,unknown>,observation:json(observation) as Record<string,unknown>,keep,shards};
        actualForge.push({positionId:position.id,baseId:position.baseId,day:position.day,wallet:base.ownerWallet,keep:position.keepPaid!.toString(),internal:measured.input.internalWallets.includes(base.ownerWallet)});
      }
      actualForge.sort((a,b)=>lexical(a.positionId,b.positionId));
      if(!same(forge,actualForge)) fail('CUSTODY_INPUT_MISMATCH');
      before=measured.before; saved=[];
      for(const p of [...players,...mails,...forge,...league] as (FixtureRetirementRequest['players'][number] & {messageId?:string;positionId?:string;baseId?:string;day?:string;week?:string})[]) {
        if(!p.internal) await getOrCreatePlayerAccount(tx,p.wallet,'player_gems');
        const e=expected(p,request.fixtureId), entries=[];
        for(const leg of e.legs) {
          const found=await tx.select().from(accounts).where(sql`${accounts.kind}=${leg.kind} and ${accounts.currency}=${leg.currency}
            and ${accounts.ownerWallet} is not distinct from ${leg.wallet}::text and ${accounts.baseId} is null`);
          if(found.length!==1) fail('CUSTODY_ACCOUNT_IDENTITY_REQUIRED');
          entries.push({account:found[0]!.id,delta:BigInt(leg.delta)});
        }
        if(p.week) {
          await assertLeagueAuthority(tx,p as NonNullable<FixtureRetirementRequest['league']>[number],request.asOf);
          const prepared=await read<{wallet:string;keep:string;posting_key:string;posting_type:string;metadata:unknown;entries:{account:string;delta:string}[]}>(tx,
            sql`select * from public.shardkeep_prepare_fixture_league_retirement(${p.week}::date,${p.baseId}::uuid,${request.fixtureId}::uuid,${request.asOf}::timestamptz,${p.internal})`);
          const ordered=(v:unknown[])=>v.map(canonical).sort();
          if(prepared.length!==1 || prepared[0]!.wallet!==p.wallet || prepared[0]!.keep!==p.keep
            || prepared[0]!.posting_key!==e.key || prepared[0]!.posting_type!==e.type || !same(prepared[0]!.metadata,e.metadata)
            || !Array.isArray(prepared[0]!.entries) || !same(ordered(prepared[0]!.entries),ordered(entries.map(x=>({account:x.account,delta:x.delta.toString()})))))
            fail('CUSTODY_LEAGUE_EVIDENCE_CONFLICT');
        }
        const posted=await postTransaction(tx,{idempotencyKey:e.key,type:e.type,metadata:e.metadata,entries});
        if(posted.duplicate) fail('CUSTODY_RECEIPT_CONFLICT');
        const original=await receipt(tx,posted.transaction.id); assertReceipt(original,p,request.fixtureId); saved.push(original);
        if(p.positionId) {
          const updated=await tx.update(baseForgePositions).set({claimedAt:new Date(request.asOf),claimTxnId:original.id,updatedAt:new Date(request.asOf)}).where(sql`${baseForgePositions.id}=${p.positionId}::uuid and ${baseForgePositions.claimedAt} is null and ${baseForgePositions.expiredAt} is null`).returning({id:baseForgePositions.id});
          if(updated.length!==1) fail('CUSTODY_FORGE_EVIDENCE_CONFLICT');
        }
        if(p.messageId) {
          const legs=await read<{id:string;expires_at:Date;kind:string;amount:string}>(tx,sql`select a.id,a.kind,a.amount::text,m.expires_at from public.mail_attachments a join public.mail_messages m on m.id=a.message_id where m.id=${p.messageId}::uuid order by a.position`);
          for(const leg of legs.filter(l=>l.kind==='KEEP')) await tx.insert(mailKeepRetirements).values({attachmentId:leg.id,messageId:p.messageId,recipientWallet:p.wallet,amount:BigInt(leg.amount),originalExpiresAt:new Date(leg.expires_at),ledgerTxnId:original.id,journalId:request.fixtureId,receipt:original});
          if(legs.every(l=>l.kind==='KEEP')) await tx.update(mailMessages).set({rewardState:'claimed',claimedAt:new Date(request.asOf),claimLedgerTxnId:original.id}).where(eq(mailMessages.id,p.messageId));
        }
      }
      after=(await census(tx,new Date(request.asOf),explicitInternal,request.custodyWindowId)).before;
      if(!checkG8(plan,before,after)) fail('CUSTODY_MEASURED_G8_FAILED');
      // Preserve the exact unknown expired sources while the complete barrier
      // still excludes writers. A later observation cannot invent a source that
      // was absent at F, and prior journals default to no admitted sources.
      const lateDepositSources=(await read<{source:unknown}>(tx,request.custodyWindowId
        ? sql`select to_jsonb(d) as source from public.deposits d where public.shardkeep_keep_source_eligible(${request.custodyWindowId}::uuid,d.id) order by d.id`
        : sql`select to_jsonb(d) as source from public.deposits d where kind='keep_deposit' and status='expired'
        and payment_signature is null and tx_signature is null and amount is null
        and mint is null and finalized_at is null and ledger_txn_id is null order by id`)).map(r=>r.source);
      await tx.insert(keepCustodyJournal).values({id:request.fixtureId,operation,scope:'fixture',subcommand,dryRun:false,
        inputHash,operatorName:identity.operator,databaseName:database,request:bound,receipts:saved,sourceEvidence,lateDepositSources,beforeState:json(before),afterState:json(after)});
      await tx.execute(sql`select public.shardkeep_advance_keep_custody_phase('withdrawals_closed','frozen')`);
      for(const l of league) await assertLeagueAuthority(tx,l,request.asOf);
    }
    if(!checkG8(plan,before,after) || before.forgePayoutEscrow!==forge.reduce((n,f)=>n+BigInt(f.keep),0n) || before.leagueEntitlementEscrow!==league.reduce((n,l)=>n+BigInt(l.keep),0n) || before.mailKeepEscrow!==mails.reduce((n,m)=>n+BigInt(m.keep),0n) || before.playerKeep!==players.reduce((n,p)=>n+BigInt(p.keep),0n)
      || [after.playerKeep,after.withdrawalEscrow,after.forgePayoutEscrow,after.mailKeepEscrow,after.leagueEntitlementEscrow].some(n=>n!==0n)) fail('CUSTODY_JOURNAL_CONFLICT');
    return {fixtureOnly:true,retirementAuthorized:false,fixtureId:request.fixtureId,measuredG8:true,
      totalKeepConverted:plan.totalKeepConverted.toString(),sweptInternalKeep:plan.sweptInternalKeep.toString(),
      before:json(before),after:json(after),receipts:saved,
      releaseEvidence:['P1','P2','P3','P4','P5','P6','P7','P8'].map(gate=>({gate,status:'unverified' as const}))};
  }); } finally { await connection.close(); }
}
