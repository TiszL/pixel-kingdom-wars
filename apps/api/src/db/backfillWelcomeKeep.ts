/**
 * Operator tool (owner 2026-08-22: "distribute 5000 keep to existing players
 * via mail to mitigate unfairness"): every EXISTING Keeper who founded a base
 * before the playtest release (and therefore never received the attached
 * welcome reward, D-067 §4 / K-047) gets one reward mail carrying
 * `PLAYTEST.welcomeKeep` KEEP from the emission pool through the normal mail
 * escrow. Idempotent by deliveryKey `welcome-keep:<wallet>`.
 *
 * Who: wallets that founded a base (any `bases` row, active or inactive — a
 * sold or reconciled deed still leaves a real Keeper — or the latched
 * `base_founded` milestone) and have at least one session, minus wallets whose
 * first-base welcome already carried KEEP, minus wallets already backfilled,
 * minus the synthetic burst cohort (K-048) and zero-session rows.
 *
 * Default is a DRY RUN. `--apply` delivers exactly the printed list.
 */
import { pathToFileURL } from 'node:url';
import { sql } from 'drizzle-orm';
import { PLAYTEST } from '@shardkeep/shared';
import { loadConfig } from '../config';
import { createDb, type Db, type DbTx } from './client';
import { deliverSystemMail } from '../mail/service';
import { selectSyntheticAccounts } from './purgeSyntheticAccounts';

export const WELCOME_KEEP_DELIVERY_PREFIX = 'welcome-keep:';

export interface WelcomeKeepCandidate { wallet: string; name: string; createdAt: Date }

export async function selectWelcomeKeepCandidates(db: Db | DbTx, only?: readonly string[]): Promise<WelcomeKeepCandidate[]> {
  // Exactly the purge's selection is excluded (not a hand-rolled copy of it),
  // so no wallet can fall between "not a player" and "not rewarded".
  const synthetic = (await selectSyntheticAccounts(db)).map((c) => c.wallet);
  const rows = await db.execute<{ wallet: string; name: string; created_at: Date }>(sql`
    select p.wallet, p.name, p.created_at from players p
    where (exists (select 1 from bases b where b.owner_wallet = p.wallet)
        or exists (select 1 from tester_milestones t where t.wallet = p.wallet and t.key = 'base_founded'))
      and exists (select 1 from sessions s where s.wallet = p.wallet)
      ${only ? sql`and p.wallet in (${sql.join(only.map((w) => sql`${w}`), sql`, `)})` : sql``}
      -- already rewarded: the post-release first-base welcome carries KEEP
      and not exists (select 1 from mail_messages m join mail_attachments at on at.message_id = m.id
        where m.recipient_wallet = p.wallet and m.dedupe_key = 'welcome:' || p.wallet and at.kind = 'KEEP')
      -- already backfilled
      and not exists (select 1 from mail_messages m where m.recipient_wallet = p.wallet and m.dedupe_key = ${WELCOME_KEEP_DELIVERY_PREFIX} || p.wallet)
      -- the synthetic sign-in bursts (K-048) are not players
      ${synthetic.length > 0 ? sql`and p.wallet not in (${sql.join(synthetic.map((w) => sql`${w}`), sql`, `)})` : sql``}
    order by p.created_at asc`);
  return (rows as unknown as Array<{ wallet: string; name: string; created_at: Date }>)
    .map((r) => ({ wallet: r.wallet, name: r.name, createdAt: new Date(r.created_at) }));
}

export function welcomeKeepMail(wallet: string) {
  return {
    recipientWallet: wallet,
    deliveryKey: `${WELCOME_KEEP_DELIVERY_PREFIX}${wallet}`,
    subject: '⚔ PLAYTEST WELCOME REWARD',
    body: [
      'Keeper — thank you for being here early.',
      '',
      `New Keepers now receive ${PLAYTEST.welcomeKeep.toLocaleString('en-US')} KEEP with their welcome letter, so to keep`,
      `things fair yours is attached to this mail: tap CLAIM to add ${PLAYTEST.welcomeKeep.toLocaleString('en-US')} KEEP to your wallet.`,
      'Spend it in the SHOP, on elite troops, or hold it — it is devnet KEEP, with no',
      'real-world value, for testing the game.',
      '',
      'Build, raid, and hold the line.',
    ].join('\n'),
    attachments: [{ kind: 'KEEP' as const, amount: BigInt(PLAYTEST.welcomeKeep) }],
  };
}

/** Deliver to every candidate; returns what was delivered (duplicates are no-ops by deliveryKey). */
export async function backfillWelcomeKeep(db: Db, opts: { only?: readonly string[]; now?: Date } = {}): Promise<{ delivered: string[]; candidates: number }> {
  const candidates = await selectWelcomeKeepCandidates(db, opts.only);
  const delivered: string[] = [];
  for (const c of candidates) {
    await deliverSystemMail(db, welcomeKeepMail(c.wallet), opts.now ?? new Date());
    delivered.push(c.wallet);
  }
  return { delivered, candidates: candidates.length };
}

function isMain(): boolean {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]!).href;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const config = loadConfig();
  // The KEEP welcome is a devnet playtest reward (D-067 §4) — never on another cluster.
  if (config.SOLANA_CLUSTER !== 'devnet') throw new Error(`backfillWelcomeKeep runs on devnet only (SOLANA_CLUSTER=${config.SOLANA_CLUSTER})`);
  const { db, sql: pg } = createDb(config.DATABASE_URL);
  try {
    const candidates = await selectWelcomeKeepCandidates(db);
    const total = BigInt(candidates.length) * BigInt(PLAYTEST.welcomeKeep);
    console.log(`${apply ? 'APPLY' : 'DRY RUN'}: ${candidates.length} existing Keeper(s) to receive ${PLAYTEST.welcomeKeep} KEEP each (${total} KEEP from the emission pool)`);
    for (const c of candidates) console.log(`  ${c.wallet}  ${JSON.stringify(c.name)}  created=${c.createdAt.toISOString().slice(0, 10)}`);
    if (!apply) { if (candidates.length > 0) console.log('re-run with --apply to deliver exactly these mails'); return; }
    const r = await backfillWelcomeKeep(db);
    console.log(`delivered ${r.delivered.length} reward mail(s)`);
  } finally {
    await pg.end();
  }
}

if (isMain()) main().catch((e) => { console.error(e); process.exit(1); });
