/**
 * Operator tool (owner 2026-08-22): list — and only with --apply delete — GHOST
 * player rows: wallets that signed in but never did anything and hold nothing.
 *
 * A ghost is a `players` row with NO base/slot, NO buildings, NO ledger
 * account with a non-zero balance and NO ledger entries at all, NO deposits,
 * withdrawals, items, mail, feedback or tester rows, NO referral links, NO
 * alpha_access grant, and whose last sign-in (sessions) is older than the
 * grace window. Anything else is never touched: the money-honoured rule means
 * a wallet with any economic history is history, not clutter.
 *
 * Default is a DRY RUN that prints the candidates. `--apply` deletes them in
 * one transaction, child rows first (sessions, auth nonces, email otps,
 * tutorial, streaks, the signed_in tester row, any tester_daily_points rows,
 * an empty ledger account are the only rows a ghost can own); any other FK
 * aborts the whole delete. Production:
 * run as a one-shot inside the api image. `--grace-hours=N` (default 24).
 */
import { sql } from 'drizzle-orm';
import { loadConfig } from '../config';
import { createDb } from './client';

function intArg(argv: readonly string[], flag: string, fallback: number): number {
  const raw = argv.find((a) => a.startsWith(`${flag}=`));
  if (!raw) return fallback;
  const n = Number(raw.slice(flag.length + 1));
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`${flag} must be a positive integer (got ${JSON.stringify(raw.slice(flag.length + 1))})`);
  return n;
}
function parseArgs(argv: readonly string[]): { apply: boolean; graceHours: number; limit: number } {
  return { apply: argv.includes('--apply'), graceHours: intArg(argv, '--grace-hours', 24), limit: intArg(argv, '--limit', 500) };
}

/** `only` restricts the census to already-printed wallets (the apply path
 * re-checks them inside the transaction); `lock` takes row locks on players. */
const GHOST_SQL = (graceHours: number, limit: number, only?: readonly string[], lock = false) => sql`
  select p.wallet, p.created_at, p.name,
    (select max(s.created_at) from sessions s where s.wallet = p.wallet) as last_session_at
  from players p
  where p.created_at < now() - make_interval(hours => ${graceHours})
    ${only ? sql`and p.wallet in (${sql.join(only.map((w) => sql`${w}`), sql`, `)})` : sql``}
    and not exists (select 1 from bases b where b.owner_wallet = p.wallet)
    and not exists (select 1 from base_slots bs where bs.wallet = p.wallet)
    and not exists (select 1 from buildings bl where bl.player_wallet = p.wallet)
    and not exists (select 1 from accounts a where a.owner_wallet = p.wallet and (a.balance <> 0
      or exists (select 1 from ledger_entries e where e.account_id = a.id)))
    and not exists (select 1 from deposits d where d.player_wallet = p.wallet)
    and not exists (select 1 from withdrawals w where w.player_wallet = p.wallet)
    and not exists (select 1 from player_items i where i.player_wallet = p.wallet)
    and not exists (select 1 from mail_messages m where m.recipient_wallet = p.wallet)
    and not exists (select 1 from tester_feedback f where f.wallet = p.wallet)
    and not exists (select 1 from tester_milestones t where t.wallet = p.wallet and t.key <> 'signed_in')
    and not exists (select 1 from referrals r where r.referrer_wallet = p.wallet or r.referee_wallet = p.wallet)
    and not exists (select 1 from alpha_access aa where aa.wallet = p.wallet)
    and not exists (select 1 from seeker_links sl where sl.wallet = p.wallet)
    and not exists (select 1 from devnet_faucet_grants g where g.wallet = p.wallet)
    and not exists (select 1 from mine_state ms where ms.player_wallet = p.wallet)
    and coalesce((select max(s.created_at) from sessions s where s.wallet = p.wallet), p.created_at)
        < now() - make_interval(hours => ${graceHours})
  order by p.created_at asc
  limit ${limit}
  ${lock ? sql`for update of p` : sql``}`;

async function main(): Promise<void> {
  const { apply, graceHours, limit } = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const { db, sql: pg } = createDb(config.DATABASE_URL);
  try {
    const rows = await db.execute<{ wallet: string; created_at: Date; name: string; last_session_at: Date | null }>(GHOST_SQL(graceHours, limit));
    const ghosts = rows as unknown as Array<{ wallet: string; created_at: Date; name: string; last_session_at: Date | null }>;
    console.log(`${apply ? 'APPLY' : 'DRY RUN'}: ${ghosts.length} ghost player row(s) (grace ${graceHours}h, limit ${limit})`);
    for (const g of ghosts) {
      console.log(`  ${g.wallet}  created=${new Date(g.created_at).toISOString()}  last_session=${g.last_session_at ? new Date(g.last_session_at).toISOString() : '-'}  name=${JSON.stringify(g.name)}`);
    }
    if (!apply || ghosts.length === 0) {
      if (!apply && ghosts.length > 0) console.log('re-run with --apply to delete exactly these rows');
      return;
    }
    const printed = ghosts.map((g) => g.wallet);
    let wallets: string[] = [];
    try {
      await db.transaction(async (tx) => {
        // Re-run the census on the printed wallets only, with row locks, so a
        // wallet that signed in between the dry run and now is left alone.
        const again = await tx.execute<{ wallet: string }>(GHOST_SQL(graceHours, limit, printed, true));
        wallets = (again as unknown as Array<{ wallet: string }>).map((r) => r.wallet);
        const skipped = printed.filter((w) => !wallets.includes(w));
        for (const w of skipped) console.log(`  skipped ${w} — no longer a ghost`);
        if (wallets.length === 0) return;
        const list = sql.join(wallets.map((w) => sql`${w}`), sql`, `);
        // Child rows a sign-in-only player can own; everything economic was
        // proven absent above. Any other FK still holding a row aborts the
        // whole transaction (nothing deleted) — fail loud, never partial.
        await tx.execute(sql`delete from tester_board_hidden where wallet in (${list})`);
        await tx.execute(sql`delete from sessions where wallet in (${list})`);
        await tx.execute(sql`delete from auth_nonces where wallet in (${list})`);
        await tx.execute(sql`delete from email_otps where player_wallet in (${list})`);
        await tx.execute(sql`delete from tutorial_progress where player_wallet in (${list})`);
        await tx.execute(sql`delete from streaks where player_wallet in (${list})`);
        await tx.execute(sql`delete from tester_daily_points where wallet in (${list})`);
        await tx.execute(sql`delete from tester_milestones where wallet in (${list})`);
        await tx.execute(sql`delete from accounts where owner_wallet in (${list})`);
        await tx.execute(sql`delete from players where wallet in (${list})`);
      });
    } catch (e) {
      console.error(`delete ABORTED — nothing was deleted: ${e instanceof Error ? e.message : String(e)}`);
      process.exitCode = 2;
      return;
    }
    console.log(`deleted ${wallets.length} ghost player row(s)`);
  } finally {
    await pg.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
