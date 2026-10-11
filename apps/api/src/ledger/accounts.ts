/**
 * Ledger account helpers (ARCHITECTURE §5).
 *
 * System accounts (owner NULL, one per kind) represent the outside world and
 * pools. Mint/world accounts MAY go negative so that internal totals always
 * reconcile (research-security-economy.md §1 "settlement/world accounts");
 * finite allocations and collected pools may not. Player accounts can NEVER
 * go negative.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { accounts } from '../db/schema';

export type AccountKind = (typeof accounts.kind.enumValues)[number];
export type Currency = (typeof accounts.currency.enumValues)[number];

export const PLAYER_ACCOUNT_KINDS = [
  'player_keep', 'player_sol_credit', 'player_shards', 'player_gems', 'player_gems_store',
] as const;
export const BASE_ACCOUNT_KINDS = ['base_shards', 'base_forge_escrow'] as const;
export const SYSTEM_ACCOUNT_KINDS = [
  'emission_pool', 'burn', 'league_pool', 'league_entitlement_escrow', 'treasury', 'quest_bucket', 'sol_treasury',
  'withdrawal_escrow', 'onchain_outflow', 'onchain_inflow', 'keep_genesis', 'league_sol_pool',
  'forge_escrow', 'shard_genesis', 'shard_burn', 'clan_chest', 'forge_payout_escrow',
  'raid_loot_escrow', 'mail_keep_escrow', 'mail_shards_escrow', 'shards_tax_escrow',
  'gems_mint', 'gems_sink', 'gems_reward_budget',
  'charter_creation_escrow', 'mining_contribution_escrow',
] as const;

export type PlayerAccountKind = (typeof PLAYER_ACCOUNT_KINDS)[number];
export type BaseAccountKind = (typeof BASE_ACCOUNT_KINDS)[number];
export type SystemAccountKind = (typeof SYSTEM_ACCOUNT_KINDS)[number];

export const ACCOUNT_CURRENCY: Record<AccountKind, Currency> = {
  player_keep: 'KEEP',
  player_sol_credit: 'SOL',
  emission_pool: 'KEEP',
  burn: 'KEEP',
  league_pool: 'KEEP',
  league_entitlement_escrow: 'KEEP',
  treasury: 'KEEP',
  quest_bucket: 'KEEP',
  sol_treasury: 'SOL',
  withdrawal_escrow: 'KEEP',
  onchain_outflow: 'KEEP',
  onchain_inflow: 'KEEP',
  keep_genesis: 'KEEP',
  league_sol_pool: 'SOL',
  player_shards: 'SHARDS',
  forge_escrow: 'SHARDS',
  forge_payout_escrow: 'KEEP',
  shard_genesis: 'SHARDS',
  shard_burn: 'SHARDS',
  clan_chest: 'SHARDS',
  base_shards: 'SHARDS',
  base_forge_escrow: 'SHARDS',
  raid_loot_escrow: 'SHARDS',
  mail_keep_escrow: 'KEEP',
  mail_shards_escrow: 'SHARDS',
  shards_tax_escrow: 'SHARDS',
  // Gems (D-152, E2-GEMS-CONTRACT §1.1). The reward budget is KEEP on purpose:
  // it is the KEEP backing behind every grant, so a grant is a four-entry
  // posting (budget −k / emission_pool +k / gems_mint −g / player_gems +g).
  player_gems: 'GEMS',
  player_gems_store: 'GEMS',
  gems_mint: 'GEMS',
  gems_sink: 'GEMS',
  gems_reward_budget: 'KEEP',
  charter_creation_escrow: 'SHARDS',
  mining_contribution_escrow: 'SHARDS',
};

/**
 * Player balances must stay ≥ 0. World/mint/sink accounts may go negative — they
 * represent the outside — EXCEPT `emission_pool`, which is now NON-negative
 * (ECONOMY.md §4b, v3): it is seeded with the 500M play allocation and its
 * balance IS the remaining lifetime mint, so the ledger's FOR-UPDATE +
 * non-negative check IS the lifetime-cap invariant (no over-mint race).
 * `quest_bucket` remains non-negative as a zero-balance historical tombstone.
 * The one-way retirement fence rejects every new entry after consolidation;
 * retaining the kind keeps old append-only ledger rows intelligible.
 * The two league prize pools are non-negative for the same reason (security
 * review 2026-07-18): they only ever hold collected slices, so a payout that
 * would overdraw them is ALWAYS a bug (e.g. overlapping weekly resets) and
 * must fail loudly instead of conjuring value.
 */
export const NON_NEGATIVE_KINDS: readonly string[] = [
  'charter_creation_escrow', 'mining_contribution_escrow',
  ...PLAYER_ACCOUNT_KINDS, ...BASE_ACCOUNT_KINDS,
  'emission_pool', 'quest_bucket', 'league_pool', 'league_entitlement_escrow', 'league_sol_pool',
  // clan_chest only ever holds collected slices (security review 2026-07-26 #3):
  // every debit is bounded by attribution, so an overdraw is a BUG and must
  // fail loudly instead of conjuring value.
  'clan_chest',
  // forge_payout_escrow holds SETTLED-but-UNCLAIMED forge KEEP. Every debit is
  // bounded by exactly one forge_contributions row's keep_paid, so an overdraw
  // is ALWAYS a claim-gate bug — and being non-negative is what converts that
  // bug from a silent double-credit against real balances into a loud
  // InsufficientFundsError (the third, structural, non-bypassable guard).
  'forge_payout_escrow',
  // Legacy open Forge positions are transferred from this pooled account into
  // deed escrows during cutover. An attribution bug must not make that source
  // negative and silently create SHARDS in the destination base.
  'forge_escrow',
  // withdrawal_escrow has the IDENTICAL shape (+gross at request, -gross at
  // payout/cancel/refund, never legitimately negative), and the refund path made
  // the gap dangerous: a second refund posting would have SILENTLY MINTED KEEP
  // instead of failing loudly, because nothing bounded the debit structurally
  // (money review 2026-07-29 #3). The row-level status claim and the ledger
  // idempotency key are the first two guards; this is the third, the one that
  // cannot be bypassed by a future caller that forgets the other two.
  'withdrawal_escrow',
  // Every reserved balance shard is attributed to exactly one raid row. An
  // overdraw means settlement/release escaped its row-state gate.
  'raid_loot_escrow',
  // Reward currency is moved here before a message becomes visible. Claim and
  // expiry may debit only one still-pending row, so either pool going negative
  // is an attribution/lifecycle bug and must abort the transaction loudly.
  'mail_keep_escrow', 'mail_shards_escrow', 'shards_tax_escrow',
  // Gems (D-152, GEMS-CURRENCY §3 G-3). player_gems / player_gems_store are
  // covered by the PLAYER_ACCOUNT_KINDS spread above. gems_mint is deliberately
  // ABSENT: it is the world account (shard_genesis shape) whose −balance is the
  // outstanding + sunk Gems. gems_sink only ever holds spent Gems and every
  // refund out of it is bounded by the original debit, so an overdraw is a
  // refund-bound bug that must fail loudly instead of conjuring Gems.
  'gems_sink',
  // gems_reward_budget holds the KEEP that backs grants; a grant that would
  // overdraw it must fail closed (GEMS_BUDGET_EXHAUSTED) — the non-negative
  // check IS the daily-cap invariant, exactly like emission_pool's lifetime cap.
  'gems_reward_budget',
];

export function canGoNegative(kind: AccountKind): boolean {
  return !NON_NEGATIVE_KINDS.includes(kind);
}

export interface AccountRow {
  id: string;
  ownerWallet: string | null;
  baseId: string | null;
  kind: AccountKind;
  currency: Currency;
  balance: bigint;
}

/** Ensures one deed-owned SHARDS account exists for a stable base. Unlike a
 * wallet account this row transfers automatically with the deed because its
 * identity never contains the current owner wallet. */
export async function getOrCreateBaseAccount(
  db: DbOrTx,
  baseId: string,
  kind: BaseAccountKind,
): Promise<AccountRow> {
  await db.insert(accounts)
    .values({ baseId, kind, currency: ACCOUNT_CURRENCY[kind] })
    .onConflictDoNothing();

  const [row] = await db.select().from(accounts)
    .where(and(eq(accounts.baseId, baseId), eq(accounts.kind, kind)));
  if (!row) throw new Error(`getOrCreateBaseAccount: insert/select failed for ${baseId}/${kind}`);
  return row;
}

/**
 * Ensures every system account exists (idempotent — safe to run on every
 * boot). Returns kind → account id.
 */
export async function bootstrapSystemAccounts(db: DbOrTx): Promise<Record<SystemAccountKind, string>> {
  const kinds = await insertSystemAccounts(db);

  const rows = await db.select().from(accounts).where(isNull(accounts.ownerWallet));
  const map = {} as Record<SystemAccountKind, string>;
  for (const kind of kinds) {
    const row = rows.find((r) => r.kind === kind);
    if (!row) throw new Error(`bootstrapSystemAccounts: missing system account '${kind}'`);
    map[kind] = row.id;
  }
  return map;
}

/** One idempotent insert on both current and deliberately older schemas.
 * Filter text through the actual kind column's enum before casting: catching an
 * unsupported enum after INSERT cannot recover inside a caller's transaction.
 * The materialized boundary keeps unsupported kinds out of enum casts, while
 * other schema, permission and trigger errors still propagate unchanged.
 * Return every supported kind, including accounts that already existed, so the
 * caller still refuses a missing account instead of accepting a partial map. */
async function insertSystemAccounts(db: DbOrTx): Promise<readonly SystemAccountKind[]> {
  const requested = JSON.stringify(SYSTEM_ACCOUNT_KINDS.map((kind) => ({ kind, currency: ACCOUNT_CURRENCY[kind] })));
  const supported = await db.execute<{ kind: SystemAccountKind }>(sql`
    with supported as materialized (
      select requested.kind, requested.currency
      from jsonb_to_recordset(${requested}::jsonb) as requested(kind text, currency text)
      join pg_catalog.pg_attribute a on a.attrelid = 'public.accounts'::regclass
        and a.attname = 'kind' and not a.attisdropped
      join pg_catalog.pg_enum e on e.enumtypid = a.atttypid and e.enumlabel = requested.kind
    ), inserted as (
      insert into public.accounts (kind, currency)
      select kind::public.account_kind, currency::public.currency from supported
      on conflict do nothing
    )
    select kind from supported
  `);
  return supported.map((row) => row.kind);
}

/**
 * Fetches (creating if absent) a player account. The players row must already
 * exist (FK). Idempotent under concurrency via the (owner, kind) unique.
 */
export async function getOrCreatePlayerAccount(
  db: DbOrTx,
  ownerWallet: string,
  kind: PlayerAccountKind,
): Promise<AccountRow> {
  await db
    .insert(accounts)
    .values({ ownerWallet, kind, currency: ACCOUNT_CURRENCY[kind] })
    .onConflictDoNothing();

  const [row] = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.ownerWallet, ownerWallet), eq(accounts.kind, kind)));
  if (!row) throw new Error(`getOrCreatePlayerAccount: failed for ${ownerWallet}/${kind}`);
  return row;
}
