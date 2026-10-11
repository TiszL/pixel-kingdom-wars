/** B2 local census rehearsal only. No apply mode, postings, latch or migration.
 * A projected G-8 result never authorizes custody retirement or reserve moves. */
import { pathToFileURL } from 'node:url';
import { PublicKey } from '@solana/web3.js';
import { BASE_OWNERSHIP, FORGE, REMOVED_SKIN_REFUNDS } from '@shardkeep/shared';
import { sql, type SQL } from 'drizzle-orm';
import { buildRetirementPlan, assertReadyForRetirement, checkG8, custodialLiability,
  type CustodialLedger, type RetirementCensusInput } from '../../../../scripts/src/custody-retirement-model';
import { createDb, type Db, type DbTx } from './client';

const releaseGates = ['P1 funded mining and shadow replay', 'P2 native release availability', 'P3 Gems rollout and custody fence',
  'P4 operator tools and reconciliation', 'P5 off-host rehearsals', 'P6 published census',
  'P7 Seeker readiness', 'P8 reserve governance attestation'] as const;
const rows = async <T extends Record<string, unknown>>(tx: DbTx, query: SQL) =>
  await tx.execute<T>(query) as unknown as T[];
const sum = (values: readonly { keep: bigint }[]) => values.reduce((total, row) => total + row.keep, 0n);

export async function census(tx: DbTx, asOf: Date, explicitInternal: string[], custodyWindowId?: string) {
  const unresolvedDeposit = sql`d.kind in ('keep_deposit','keep_vend') and (d.status in ('pending','finalized') or (d.status<>'credited' and (d.payment_signature is not null or d.tx_signature is not null or d.finalized_at is not null or d.amount is not null)))`;
  const lateEligible = custodyWindowId ? sql`public.shardkeep_keep_source_eligible(${custodyWindowId}::uuid,d.id)` : sql`false`;
  const accounts = await rows<{ kind: string; wallet: string | null; balance: string }>(tx,
    sql`select kind, owner_wallet as wallet, balance::text from accounts order by kind, owner_wallet nulls first, id`);
  const balance = (kind: string) => accounts.filter(a => a.kind === kind).reduce((n, a) => n + BigInt(a.balance), 0n);
  const forge = await rows<{ wallet: string; base_id: string; keep: string; lapsed: boolean; owned: boolean; settled: boolean }>(tx, sql`
    select b.owner_wallet as wallet, p.base_id, p.keep_paid::text as keep,
      coalesce(p.settled_at <= ${asOf.toISOString()},false) as settled,
      p.settled_at <= ${new Date(asOf.getTime() - FORGE.claimWindowDays * 86_400_000).toISOString()} as lapsed,
      coalesce(o.status='owned' and o.asset_id=b.deed_asset_id and o.owner=b.owner_wallet and o.slot is not null and o.slot>=0
        and o.checked_at between ${new Date(asOf.getTime() - BASE_OWNERSHIP.mutationFreshnessMs).toISOString()} and ${asOf.toISOString()},false) as owned
    from base_forge_positions p join bases b on b.id=p.base_id
    left join lateral (select * from deed_ownership_observations where base_id=b.id
      order by checked_at desc, id desc limit 1) o on true
    where p.keep_escrow_txn_id is not null and p.claimed_at is null and p.expired_at is null
    order by p.base_id,p.day,p.id`);
  const legacy = await rows<{ wallet: string; keep: string }>(tx, sql`select player_wallet as wallet, keep_paid::text as keep
    from forge_contributions where keep_escrow_txn_id is not null and claimed_at is null and expired_at is null order by id`);
  const mails = await rows<{ wallet: string; id: string; keep: string; mixed: boolean; welcome: boolean; expired: boolean }>(tx, sql`
    select m.recipient_wallet as wallet,m.id,sum(a.amount) filter(where a.kind='KEEP')::text as keep,
      (m.expires_at is null or m.expires_at <= ${asOf.toISOString()}) as expired,
      bool_or(a.kind <> 'KEEP') as mixed,(m.dedupe_key like 'welcome:%' or m.dedupe_key like 'welcome-keep:%') as welcome
    from mail_messages m join mail_attachments a on a.message_id=m.id where m.reward_state='pending' AND (a.kind<>'KEEP' OR NOT public.shardkeep_mail_keep_retired(a.id))
    group by m.id,m.recipient_wallet,m.dedupe_key,m.expires_at having bool_or(a.kind='KEEP') order by m.id`);
  const expired = await rows<{ wallet: string }>(tx, sql`select distinct recipient_wallet as wallet from mail_messages
    where reward_state='expired' and (dedupe_key like 'welcome:%' or dedupe_key like 'welcome-keep:%') order by wallet`);
  const rawLeague = await rows<{ wallet: string; id: string; keep: string }>(tx, sql`
    select b.owner_wallet as wallet,e.base_id::text || ':' || e.week::text as id,e.keep_amount::text as keep
    from base_league_entitlements e join bases b on b.id=e.base_id where paid_at is null and keep_amount>0 order by id`);
  await tx.execute(sql`select public.shardkeep_assert_league_census()`);
  const archivedLeague = await rows<{ wallet: string | null; id: string; keep: string; owned: boolean }>(tx, sql`
    select b.owner_wallet as wallet,r->>'base_id' || ':' || w.week::text as id,r->>'keep_amount' as keep,
      coalesce(o.status='owned' and o.asset_id=b.deed_asset_id and o.owner=b.owner_wallet and o.slot is not null and o.slot>=0
        and o.checked_at between ${new Date(asOf.getTime() - BASE_OWNERSHIP.mutationFreshnessMs).toISOString()} and ${asOf.toISOString()},false) as owned
    from public.keep_custody_league_weeks w cross join lateral jsonb_array_elements(w.original_rows) r
    left join public.bases b on b.id=(r->>'base_id')::uuid
    left join lateral (select * from public.deed_ownership_observations where base_id=b.id
      order by checked_at desc,id desc limit 1) o on true
    where (r->>'keep_amount')::bigint>0 and r->>'paid_at' is null
      and not exists(select 1 from public.keep_custody_league_retirements z where z.week=w.week and z.base_id=(r->>'base_id')::uuid)
    order by id`);
  const league = [...rawLeague,...archivedLeague];
  const dev = await rows<{ wallet: string }>(tx, sql`select distinct a.owner_wallet as wallet from ledger_entries e
    join accounts a on a.id=e.account_id join ledger_transactions t on t.id=e.txn_id
    where t.type='dev.fund' and a.kind='player_keep' and a.owner_wallet is not null and e.delta>0 order by wallet`);
  const minted = await rows<{ total: string }>(tx, sql`select coalesce(-sum(e.delta),0)::text as total from ledger_entries e
    join accounts a on a.id=e.account_id join ledger_transactions t on t.id=e.txn_id
    where a.kind='gems_mint' and t.type='gems.retirement' and t.metadata->>'reason'='retirement'`);
  const counts = (await rows<Record<string, number>>(tx, sql`select
    (select count(*)::int from withdrawals where status in ('unbonding','processing','failed')) as withdrawals,
    (select count(*)::int from withdrawals where status='unbonding') as unbonding,
    (select count(*)::int from withdrawals where status='processing') as processing,
    (select count(*)::int from deposits d where ${unresolvedDeposit} and not (${lateEligible})) as deposits,
    (select count(*)::int from deposits d where ${unresolvedDeposit}) as deposits_inventory,
    (select count(*)::int from deposits d where d.kind in ('keep_deposit','keep_vend') and d.status<>'credited') as deposits_originals,
    (select count(*)::int from deposits d where ${lateEligible}) as deposits_late_admitted,
    (select count(*)::int from deposits where kind='mine_build' and (status<>'credited' or ledger_txn_id is null)) as mine_build,
    (select count(*)::int from base_forge_positions where settled_at is null) as open_forge,
    (select count(*)::int from forge_contributions) as legacy_forge,
    (select count(*)::int from forge_contributions where settled_at is null) as open_legacy_forge,
    (select count(*)::int from raid_loot_reservations where state='reserved' and forge_reserved_shards>0) as reservations,
    (select count(*)::int from base_raid_locks) as raid_locks,
    (select count(*)::int from accounts a where a.kind='player_keep' and (a.owner_wallet is null or a.balance<0
      or not exists(select 1 from players p where p.wallet=a.owner_wallet))) as invalid_players,
    (select count(*)::int from accounts a where a.balance <> coalesce((select sum(e.delta) from ledger_entries e where e.account_id=a.id),0)) as ledger_mismatch,
    (select count(*)::int from player_items where item_id in (${sql.join(Object.keys(REMOVED_SKIN_REFUNDS).map(id => sql`${id}`), sql`, `)})) as skin_refunds,
    (select count(*)::int from item_listings where status in ('active','reserved') and item_id in (${sql.join(Object.keys(REMOVED_SKIN_REFUNDS).map(id => sql`${id}`), sql`, `)})) as skin_listings`))[0]!;
  const withdrawal = (await rows<{ total: string }>(tx, sql`select coalesce(sum(amount),0)::text as total from withdrawals
    where currency='KEEP' and status in ('unbonding','processing','failed')`))[0]!;
  const input: RetirementCensusInput = {
    playBalances: accounts.filter(a => a.kind === 'player_keep' && a.wallet !== null).map(a => ({ wallet: a.wallet!, keep: BigInt(a.balance) })),
    forgeUnclaimed: forge.filter(f => f.owned && f.settled).map(f => ({ wallet: f.wallet, baseId: f.base_id, keep: BigInt(f.keep), lapsed: f.lapsed })),
    legacyForgeUnclaimed: legacy.map(f => ({ wallet: f.wallet, keep: BigInt(f.keep) })),
    pendingMailKeep: mails.filter(m => !m.expired).map(m => ({ wallet: m.wallet, mailId: m.id, keep: BigInt(m.keep), mixed: m.mixed, welcome: m.welcome })),
    leagueEntitlements: league.filter((e):e is typeof e & {wallet:string}=>e.wallet!==null).map(e => ({ wallet: e.wallet, entitlementId: e.id, keep: BigInt(e.keep) })),
    expiredWelcomeWallets: expired.map(w => w.wallet), internalWallets: [...new Set([...explicitInternal, ...dev.map(w => w.wallet)])].sort(),
    withdrawalEscrowKeep: balance('withdrawal_escrow'),
  };
  const before: CustodialLedger = { playerKeep: balance('player_keep'), withdrawalEscrow: input.withdrawalEscrowKeep,
    forgePayoutEscrow: balance('forge_payout_escrow'), mailKeepEscrow: balance('mail_keep_escrow'),
    leagueEntitlementEscrow: balance('league_entitlement_escrow'), emissionPool: balance('emission_pool'), gemsMintedRetirement: BigInt(minted[0]!.total) };
  const blockers: string[] = [];
  const block = (condition: boolean, code: string) => { if (condition) blockers.push(code); };
  for (const [field, code] of Object.entries({ withdrawals: 'WITHDRAWALS_NOT_DRAINED', deposits: 'KEEP_DEPOSITS_NOT_DRAINED',
    mine_build: 'MINE_BUILD_RECONCILIATION_REQUIRED', open_forge: 'FORGE_POSITIONS_OPEN', legacy_forge: 'LEGACY_FORGE_RECONCILIATION_REQUIRED',
    reservations: 'FORGE_RAID_RESERVATIONS_OPEN', raid_locks: 'RAID_LOCKS_OPEN', invalid_players: 'PLAYER_KEEP_INVALID',
    ledger_mismatch: 'LEDGER_BALANCE_MISMATCH', skin_refunds: 'SKIN_REFUNDS_PENDING', skin_listings: 'SKIN_LISTINGS_PENDING' })) block(counts[field]! > 0, code);
  block(before.withdrawalEscrow !== 0n, 'WITHDRAWAL_ESCROW_NOT_ZERO');
  block(before.withdrawalEscrow !== BigInt(withdrawal.total), 'WITHDRAWAL_ESCROW_MISMATCH');
  block(forge.some(f => !f.owned), 'FORGE_OWNERSHIP_UNRESOLVED');
  block(forge.some(f => !f.settled), 'FORGE_SETTLEMENT_INVALID');
  block(forge.some(f => f.lapsed), 'LAPSED_FORGE_UNSWEPT');
  block(before.forgePayoutEscrow !== forge.reduce((n, f) => n + BigInt(f.keep), 0n) + sum(input.legacyForgeUnclaimed), 'FORGE_ESCROW_MISMATCH');
  block(mails.some(m => m.expired), 'MAIL_EXPIRY_UNRESOLVED');
  block(before.mailKeepEscrow !== mails.reduce((n,m) => n + BigInt(m.keep),0n), 'MAIL_ESCROW_MISMATCH');
  block(before.leagueEntitlementEscrow !== sum(input.leagueEntitlements), 'LEAGUE_ESCROW_MISMATCH');
  block(rawLeague.length > 0, 'LEGACY_LEAGUE_RECONCILIATION_REQUIRED');
  block(archivedLeague.some(l=>!l.owned), 'LEAGUE_OWNERSHIP_UNRESOLVED');
  block(balance('forge_escrow') !== 0n || balance('base_forge_escrow') !== 0n, 'FORGE_SHARDS_NOT_DRAINED');
  // P6 measurements describe this read-only snapshot, not a reconstructed
  // historical database or a published production census. Count messages before
  // joining attachments so multiple KEEP legs never multiply welcome counts.
  const welcome = (await rows<Record<string, string>>(tx, sql`select
    count(*) filter(where reward_state='pending')::text as pending,
    count(*) filter(where reward_state='claimed')::text as claimed,
    count(*) filter(where reward_state='expired')::text as expired,
    count(distinct recipient_wallet) filter(where reward_state='expired')::text as expired_wallets,
    count(*) filter(where reward_state='pending' and expires_at <= ${asOf.toISOString()})::text as pending_due,
    count(*) filter(where reward_state='pending' and expires_at is null)::text as pending_unknown_expiry
    from mail_messages where dedupe_key like 'welcome:%' or dedupe_key like 'welcome-keep:%'`))[0]!;
  const withdrawalsByStatus = await rows<{ status: string; count: string; keep: string; overdue: string }>(tx, sql`
    select status,count(*)::text as count,coalesce(sum(amount),0)::text as keep,
      count(*) filter(where unbonds_at < ${asOf.toISOString()})::text as overdue
    from withdrawals where currency='KEEP' and status in ('unbonding','processing','failed') group by status order by status`);
  const classCounts = (await rows<Record<string, string>>(tx, sql`select
    (select coalesce(sum(contributed_shards-raid_debited_shards),0)::text from base_forge_positions where settled_at is null) as open_forge_shards,
    (select count(distinct day)::text from base_forge_positions where settled_at is null) as open_forge_days,
    (select coalesce(sum(forge_reserved_shards),0)::text from raid_loot_reservations where state='reserved' and forge_reserved_shards>0) as reserved_shards,
    (select count(*)::text from clans) as clans,
    (select coalesce(sum(chest_shards),0)::text from clans) as clan_shards,
    (select count(*)::text from base_items) as base_items,
    (select coalesce(sum(qty),0)::text from base_items) as base_item_quantity,
    (select count(*)::text from player_items) as player_items,
    (select coalesce(sum(qty),0)::text from player_items) as player_item_quantity,
    (select count(*)::text from deposits d where d.kind='mine' and d.status='pending'
      and exists(select 1 from buildings b where b.id::text=d.payload->>'buildingId' and b.type='goldforge')) as goldforge_intents,
    (select count(*)::text from item_listings where status in ('active','reserved')) as open_listings`))[0]!;
  const goldForgeLevels = await rows<{ level: number; buildings: string }>(tx, sql`
    select level,count(*)::text as buildings from buildings where type='goldforge' group by level order by level`);
  const playerAccounts = accounts.filter(a => a.kind === 'player_keep' && a.wallet !== null);
  const claimableForge = forge.filter(f => f.settled && !f.lapsed);
  const lapsedForge = forge.filter(f => f.lapsed);
  const forgePredicate = 'keep_escrow_txn_id IS NOT NULL AND claimed_at IS NULL AND expired_at IS NULL; joined to current base';
  const metric = (id: string, table: string, predicate: string, unit: string, value: bigint | number | string) =>
    ({ id, table, predicate, unit, value: String(value) });
  const welcomePredicate = "(dedupe_key LIKE 'welcome:%' OR dedupe_key LIKE 'welcome-keep:%') AND reward_state";
  const internalL1 = accounts.filter(a => a.kind === 'player_keep' && a.wallet !== null && input.internalWallets.includes(a.wallet));
  const p6 = {
    scope: 'local-fixture-snapshot' as const,
    asOfSemantics: 'asOf evaluates expiry and proof freshness in the current repeatable-read snapshot; not a historical reconstruction',
    localClassCoverage: { liabilities: ['L1','L2','L3','L4','L5','L6','L7'], shards: ['S1','S2','S3','S4','S5','S6','S7'], rights: ['R1','R2','R3'] },
    metrics: [
      metric('L5_UNPAID_LEAGUE_ROWS', 'base_league_entitlements, keep_custody_league_weeks, keep_custody_league_retirements, bases', 'unpaid positive raw rows plus archived original rows without retirement; current base owner if present', 'rows', league.length),
      metric('L5_UNPAID_LEAGUE_KEEP', 'base_league_entitlements, keep_custody_league_weeks, keep_custody_league_retirements', 'same unpaid positive raw and archived rows; SUM(keep_amount)', 'whole KEEP', sum(league.map(l=>({keep:BigInt(l.keep)})))),
      metric('L5_ESCROW_KEEP', 'accounts', "kind = 'league_entitlement_escrow'; SUM(balance)", 'whole KEEP', before.leagueEntitlementEscrow),
      metric('S2_OPEN_LEGACY_FORGE_ROWS', 'forge_contributions', 'settled_at IS NULL', 'rows', counts['open_legacy_forge']!),
      metric('S3_LEGACY_FORGE_ESCROW_SHARDS', 'accounts', "kind = 'forge_escrow'; SUM(balance)", 'SHARDS', balance('forge_escrow')),
      metric('L6_OPEN_KEEP_INTENTS', 'deposits', "pending/finalized KEEP intents plus noncredited known-payment rows", 'rows', counts['deposits_inventory']!),
      metric('L6_NONCREDITED_ORIGINALS', 'deposits', 'all noncredited KEEP/vend originals; includes unused expired rows without payment facts', 'rows', counts['deposits_originals']!),
      metric('L6_ADMITTED_LATE_SOURCES', 'deposits, keep_custody_source_windows, keep_custody_source_observations', 'explicit selected W source, unchanged pending original and confirmed pre-W payment', 'rows', counts['deposits_late_admitted']!),
      metric('L6_UNRESOLVED_BLOCKERS', 'deposits', 'full unresolved inventory minus explicitly admitted late sources', 'rows', counts['deposits']!),
      metric('L4_MIXED_PENDING_KEEP_MAILS', 'mail_messages, mail_attachments', "reward_state = 'pending'; has KEEP and non-KEEP attachments, including lazy-expired mail", 'messages', mails.filter(m => m.mixed).length),
      metric('WELCOME_PENDING_MESSAGES', 'mail_messages', `${welcomePredicate} = 'pending'; includes mail without KEEP attachments`, 'messages', welcome['pending']!),
      metric('WELCOME_PENDING_KEEP_MESSAGES', 'mail_messages, mail_attachments', `${welcomePredicate} = 'pending'; has a KEEP attachment, including lazy-expired mail`, 'messages', mails.filter(m => m.welcome).length),
      metric('WELCOME_PENDING_KEEP', 'mail_messages, mail_attachments', `${welcomePredicate} = 'pending'; SUM(KEEP attachment amount), including lazy-expired mail`, 'whole KEEP', mails.filter(m => m.welcome).reduce((n,m) => n + BigInt(m.keep), 0n)),
      metric('WELCOME_EXPIRED_MESSAGES', 'mail_messages', `${welcomePredicate} = 'expired'`, 'messages', welcome['expired']!),
      metric('WELCOME_EXPIRED_WALLETS', 'mail_messages', `${welcomePredicate} = 'expired'; DISTINCT recipient_wallet`, 'wallets', welcome['expired_wallets']!),
      metric('WELCOME_CLAIMED_MESSAGES', 'mail_messages', `${welcomePredicate} = 'claimed'; includes mail without KEEP attachments`, 'messages', welcome['claimed']!),
      metric('WELCOME_PENDING_DUE_MESSAGES', 'mail_messages', `${welcomePredicate} = 'pending'; expires_at <= asOf (does not change stored state)`, 'messages', welcome['pending_due']!),
      metric('WELCOME_PENDING_UNKNOWN_EXPIRY_MESSAGES', 'mail_messages', `${welcomePredicate} = 'pending'; expires_at IS NULL`, 'messages', welcome['pending_unknown_expiry']!),
      metric('SKIN_REFUND_ITEM_ROWS', 'player_items', 'item_id IN keys(REMOVED_SKIN_REFUNDS)', 'rows', counts['skin_refunds']!),
      metric('SKIN_REFUND_LISTING_ROWS', 'item_listings', "item_id IN keys(REMOVED_SKIN_REFUNDS) AND status IN ('active','reserved')", 'rows', counts['skin_listings']!),
      metric('L1_POSITIVE_ACCOUNTS', 'accounts', "kind = 'player_keep' AND owner_wallet IS NOT NULL AND balance > 0", 'accounts', playerAccounts.filter(a => BigInt(a.balance) > 0n).length),
      metric('L1_POSITIVE_KEEP', 'accounts', "kind = 'player_keep' AND owner_wallet IS NOT NULL AND balance > 0; SUM(balance)", 'whole KEEP', playerAccounts.reduce((n,a) => n + (BigInt(a.balance) > 0n ? BigInt(a.balance) : 0n), 0n)),
      metric('L1_ALL_ACCOUNTS', 'accounts', "kind = 'player_keep' AND owner_wallet IS NOT NULL; includes zero and negative balances", 'accounts', playerAccounts.length),
      metric('L2A_CLAIMABLE_ROWS', 'base_forge_positions, bases', `${forgePredicate}; settled_at <= asOf and within FORGE.claimWindowDays; temporal eligibility only, ownership holds reported separately`, 'rows', claimableForge.length),
      metric('L2A_CLAIMABLE_KEEP', 'base_forge_positions, bases', `${forgePredicate}; same temporal eligibility; SUM(keep_paid)`, 'whole KEEP', claimableForge.reduce((n,f) => n + BigInt(f.keep), 0n)),
      metric('L2A_LAPSED_ROWS', 'base_forge_positions, bases', `${forgePredicate}; settled_at <= asOf minus FORGE.claimWindowDays`, 'rows', lapsedForge.length),
      metric('L2A_LAPSED_KEEP', 'base_forge_positions, bases', `${forgePredicate}; same lapsed rows; SUM(keep_paid)`, 'whole KEEP', lapsedForge.reduce((n,f) => n + BigInt(f.keep), 0n)),
      metric('L2A_INVALID_SETTLEMENT_ROWS', 'base_forge_positions, bases', `${forgePredicate}; settled_at IS NULL or > asOf`, 'rows', forge.filter(f => !f.settled).length),
      metric('L2A_OWNERSHIP_HELD_ROWS', 'base_forge_positions, bases, deed_ownership_observations', `${forgePredicate}; latest observation fails owned identity, nonnegative slot or BASE_OWNERSHIP freshness at asOf`, 'rows', forge.filter(f => !f.owned).length),
      metric('L2B_UNCLAIMED_ROWS', 'forge_contributions', 'keep_escrow_txn_id IS NOT NULL AND claimed_at IS NULL AND expired_at IS NULL', 'rows', legacy.length),
      metric('L2B_UNCLAIMED_KEEP', 'forge_contributions', 'same unclaimed escrowed legacy rows; SUM(keep_paid)', 'whole KEEP', sum(input.legacyForgeUnclaimed)),
      metric('L2_ESCROW_KEEP', 'accounts', "kind = 'forge_payout_escrow'; SUM(balance)", 'whole KEEP', before.forgePayoutEscrow),
      ...(['unbonding','processing','failed'] as const).flatMap(status => {
        const row = withdrawalsByStatus.find(w => w.status === status);
        return [metric(`L3_${status.toUpperCase()}_ROWS`, 'withdrawals', `currency = 'KEEP' AND status = '${status}'`, 'rows', row?.count ?? '0'),
          metric(`L3_${status.toUpperCase()}_KEEP`, 'withdrawals', `currency = 'KEEP' AND status = '${status}'; SUM(amount) before fees`, 'whole KEEP', row?.keep ?? '0')];
      }),
      metric('L3_UNBONDING_OVERDUE_ROWS', 'withdrawals', "currency = 'KEEP' AND status = 'unbonding' AND unbonds_at < asOf", 'rows', withdrawalsByStatus.find(w => w.status === 'unbonding')?.overdue ?? '0'),
      metric('L3_ESCROW_KEEP', 'accounts', "kind = 'withdrawal_escrow'; SUM(balance)", 'whole KEEP', before.withdrawalEscrow),
      metric('L4_PENDING_KEEP_MAILS', 'mail_messages, mail_attachments', "reward_state = 'pending'; has KEEP attachment, including lazy-expired mail", 'messages', mails.length),
      metric('L4_PENDING_KEEP', 'mail_messages, mail_attachments', "reward_state = 'pending'; SUM(KEEP attachment amount), including lazy-expired mail", 'whole KEEP', mails.reduce((n,m) => n + BigInt(m.keep), 0n)),
      metric('L4_EXPIRY_UNRESOLVED_KEEP_MAILS', 'mail_messages, mail_attachments', "reward_state = 'pending'; has KEEP attachment AND (expires_at IS NULL OR expires_at <= asOf)", 'messages', mails.filter(m => m.expired).length),
      metric('L4_ESCROW_KEEP', 'accounts', "kind = 'mail_keep_escrow'; SUM(balance)", 'whole KEEP', before.mailKeepEscrow),
      ...(['emission_pool','league_pool','treasury','burn','keep_genesis','onchain_inflow','onchain_outflow'] as const).map(kind =>
        metric(`L7_${kind.toUpperCase()}_KEEP`, 'accounts', `kind = '${kind}'; SUM(balance); non-player pool, not converted`, 'whole KEEP', balance(kind))),
      metric('S1_OPEN_DEED_FORGE_ROWS', 'base_forge_positions', 'settled_at IS NULL', 'rows', counts['open_forge']!),
      metric('S1_OPEN_DEED_FORGE_SHARDS', 'base_forge_positions', 'settled_at IS NULL; SUM(contributed_shards - raid_debited_shards)', 'SHARDS', classCounts['open_forge_shards']!),
      metric('S1_OPEN_DEED_FORGE_DAYS', 'base_forge_positions', 'settled_at IS NULL; DISTINCT day', 'days', classCounts['open_forge_days']!),
      metric('S4_POSITIVE_DEED_ESCROW_ACCOUNTS', 'accounts', "kind = 'base_forge_escrow' AND balance > 0", 'accounts', accounts.filter(a => a.kind === 'base_forge_escrow' && BigInt(a.balance) > 0n).length),
      metric('S4_DEED_ESCROW_SHARDS', 'accounts', "kind = 'base_forge_escrow'; SUM(balance)", 'SHARDS', balance('base_forge_escrow')),
      metric('S5_RESERVED_FORGE_ROWS', 'raid_loot_reservations', "state = 'reserved' AND forge_reserved_shards > 0", 'rows', counts['reservations']!),
      metric('S5_RESERVED_FORGE_SHARDS', 'raid_loot_reservations', "state = 'reserved' AND forge_reserved_shards > 0; SUM(forge_reserved_shards)", 'SHARDS', classCounts['reserved_shards']!),
      metric('S5_BASE_RAID_LOCKS', 'base_raid_locks', 'all rows', 'rows', counts['raid_locks']!),
      metric('S6_CLANS', 'clans', 'all rows', 'clans', classCounts['clans']!),
      metric('S6_CLAN_CHEST_SHARDS', 'clans', 'SUM(chest_shards)', 'SHARDS', classCounts['clan_shards']!),
      metric('S6_LEDGER_CHEST_SHARDS', 'accounts', "kind = 'clan_chest'; SUM(balance)", 'SHARDS', balance('clan_chest')),
      metric('S7_BASE_SHARDS', 'accounts', "kind = 'base_shards'; SUM(balance); preserved, not converted", 'SHARDS', balance('base_shards')),
      metric('S7_BASE_ITEM_ROWS', 'base_items', 'all rows; preserved, not converted', 'rows', classCounts['base_items']!),
      metric('S7_BASE_ITEM_QUANTITY', 'base_items', 'SUM(qty); preserved, not converted', 'items', classCounts['base_item_quantity']!),
      metric('S7_PLAYER_ITEM_ROWS', 'player_items', 'all rows; preserved, not converted', 'rows', classCounts['player_items']!),
      metric('S7_PLAYER_ITEM_QUANTITY', 'player_items', 'SUM(qty); preserved, not converted', 'items', classCounts['player_item_quantity']!),
      metric('R1_GOLDFORGE_BUILDINGS', 'buildings', "type = 'goldforge'; actual levels reported separately, no compensation inferred", 'buildings', goldForgeLevels.reduce((n,l) => n + BigInt(l.buildings), 0n)),
      metric('R2_PENDING_GOLDFORGE_SOL_INTENTS', 'deposits, buildings', "kind = 'mine' AND status = 'pending'; payload.buildingId names an existing goldforge", 'rows', classCounts['goldforge_intents']!),
      metric('R3_OPEN_ITEM_LISTINGS', 'item_listings', "status IN ('active','reserved')", 'rows', classCounts['open_listings']!),
    ],
    goldForgeLevels,
    predicates: [
      ['P6_L5_ZERO', league.length === 0 && before.leagueEntitlementEscrow === 0n],
      ['P6_S2_ZERO', counts['open_legacy_forge'] === 0],
      ['P6_S3_ZERO', balance('forge_escrow') === 0n],
      ['P6_L6_ZERO', counts['deposits'] === 0],
      ['P6_SKIN_REFUNDS_ZERO', counts['skin_refunds'] === 0 && counts['skin_listings'] === 0],
    ].map(([id, pass]) => ({ id: String(id), status: pass ? 'pass' as const : 'fail' as const })),
    internalWalletDisclosure: { sources: ['ALPHA_WALLETS', 'ADMIN_WALLETS', 'positive dev.fund entries into player_keep'],
      l1Scope: 'all disclosed internal player_keep accounts, including zero/negative balances; invalid negatives remain blockers',
      wallets: input.internalWallets, l1Wallets: new Set(internalL1.map(a => a.wallet)).size,
      l1Keep: internalL1.reduce((n,a) => n + BigInt(a.balance), 0n).toString(), sourceCompleteness: 'unverified' as const },
    unverified: ['verbatim published census-e3 baseline', 'production L1–L7 / S1–S7 / R1–R3 census',
      'production/internal-wallet source completeness', 'operator and external release evidence'],
  };
  return { input, before, counts, blockers, p6 };
}

export async function runCustodyRetirement(args: readonly string[], env: NodeJS.ProcessEnv,
  connect: (url: string) => { db: Db; close: () => Promise<void> } = url => {
    const conn = createDb(url, { max: 1, deedEconomyWriter: false, marketRecoveryWriter: false });
    return { db: conn.db, close: () => conn.sql.end() };
  }) {
  if (env['HOLD_BEFORE_MIGRATE'] !== '1') throw new Error('HOLD_BEFORE_MIGRATE=1 is required for the fixture rehearsal');
  const mode = args[0], rest = mode === 'retire' && args[1] === '--dry-run' ? args.slice(2) : args.slice(1);
  if (!(mode === 'census' || (mode === 'retire' && args[1] === '--dry-run')) || rest.length !== 2 || rest[0] !== '--as-of')
    throw new Error('Only census --as-of ISO or retire --dry-run --as-of ISO is supported');
  const asOf = new Date(rest[1]!);
  if (!Number.isFinite(asOf.getTime()) || asOf.toISOString() !== rest[1]) throw new Error('An explicit canonical ISO fixture clock is required');
  const databaseUrl = env['TEST_DATABASE_URL'];
  if (!databaseUrl) throw new Error('Explicit TEST_DATABASE_URL is required');
  const url = new URL(databaseUrl), database = url.pathname.slice(1);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || !/^[a-zA-Z0-9_]+_test$/.test(database) || url.search || url.hash) throw new Error('Only an explicit loopback *_test database without URL options is supported');
  const internal = [env['ALPHA_WALLETS'], env['ADMIN_WALLETS']].flatMap(value => value?.split(',').map(w => w.trim()).filter(Boolean) ?? []);
  for (const wallet of internal) if (new PublicKey(wallet).toBase58() !== wallet) throw new Error('Invalid explicit internal wallet');
  const connection = connect(databaseUrl);
  try {
    return await connection.db.transaction(async tx => {
      const identity = (await rows<{ database: string; read_only: string }>(tx,
        sql`select current_database() as database,current_setting('transaction_read_only') as read_only`))[0]!;
      if (identity.database !== database || identity.read_only !== 'on') throw new Error('Fixture database/read-only transaction identity mismatch');
      const { input, before, counts, blockers, p6 } = await census(tx, asOf, internal), plan = buildRetirementPlan(input);
      try { assertReadyForRetirement(plan, { unbonding: counts['unbonding']!, processing: counts['processing']!, pendingKeepDeposits: counts['deposits']! }); }
      catch { blockers.push('MODEL_DRAIN_PRECONDITION_FAILED'); }
      // Subtract only attributable planned rows from independently measured
      // balances. Missing, held or lapsed obligations must remain as residue.
      const after: CustodialLedger = { ...before, playerKeep: before.playerKeep - sum(input.playBalances),
        forgePayoutEscrow: before.forgePayoutEscrow - sum(input.forgeUnclaimed.filter(f => !f.lapsed)) - sum(input.legacyForgeUnclaimed),
        mailKeepEscrow: before.mailKeepEscrow - sum(input.pendingMailKeep), leagueEntitlementEscrow: before.leagueEntitlementEscrow - sum(input.leagueEntitlements),
        emissionPool: before.emissionPool + plan.totalKeepConverted + plan.sweptInternalKeep,
        gemsMintedRetirement: before.gemsMintedRetirement + plan.totalGemsMinted };
      const projectedG8 = checkG8(plan, before, after)
        && [after.playerKeep, after.withdrawalEscrow, after.forgePayoutEscrow, after.mailKeepEscrow, after.leagueEntitlementEscrow].every(n => n === 0n);
      if (!projectedG8) blockers.push('PROJECTED_G8_FAILED');
      return { mode, fixtureOnly: true, retirementAuthorized: false, asOf: asOf.toISOString(),
        census: input, counts, plan, before, after, projectedResidualKeep: custodialLiability(after), projectedG8, blockers, releaseGates,
        localProjectionPassed: projectedG8 && blockers.length === 0, p6,
        releaseEvidence: releaseGates.map(requirement => ({ gate: requirement.slice(0, 2), requirement,
          status: 'unverified' as const, reason: 'Not established by the local fixture census or its projected G-8 result' })) };
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
  } finally { await connection.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCustodyRetirement(process.argv.slice(2), process.env).then(result => {
    console.log(JSON.stringify(result, (_, value: unknown) => typeof value === 'bigint' ? value.toString() : value, 2));
    if (result.blockers.length) process.exitCode = 1;
  }).catch(() => { console.error('Custody fixture rehearsal refused; check mode, fixture URL, HOLD and census integrity.'); process.exitCode = 1; });
}
