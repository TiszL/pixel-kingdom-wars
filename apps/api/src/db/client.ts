import { BASE_OWNERSHIP, RAID_RULES } from '@shardkeep/shared';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import type { Socket } from 'node:net';
import * as schema from './schema';

/** postgres.js's documented custom-socket hook receives its parsed endpoints;
 * the driver still performs its existing SSL negotiation after connection. */
export interface DatabaseSocketOptions { host: string[]; port: number[]; path?: string | false; ssl: unknown }

/**
 * Creates the postgres.js pool + Drizzle instance. Caller owns `sql.end()`.
 *
 * Pool size matters more here than the number suggests. `requestWithdrawal`
 * takes a GLOBAL advisory lock for its entire transaction (money/withdrawals.ts)
 * — correct for the money invariant, but it means concurrent withdrawal requests
 * queue while each still holds a pool connection. At 10, a burst of eleven
 * starves the pool and every unrelated route stalls behind it. DB_POOL_MAX makes
 * that an ops knob instead of a code change.
 */
export function createDb(
  databaseUrl: string,
  opts: { max?: number; deedEconomyWriter?: boolean; legacyTestEscape?: boolean; marketRecoveryWriter?: boolean; connectTimeoutSeconds?: number; statementTimeoutMs?: number; socketFactory?: (options: DatabaseSocketOptions) => Promise<Socket> } = {},
) {
  if (opts.connectTimeoutSeconds !== undefined && (!Number.isInteger(opts.connectTimeoutSeconds) || opts.connectTimeoutSeconds < 1 || opts.connectTimeoutSeconds > 30)) {
    throw new RangeError('Database connect timeout must be an integer from 1 to 30 seconds');
  }
  if (opts.statementTimeoutMs !== undefined && (!Number.isInteger(opts.statementTimeoutMs) || opts.statementTimeoutMs < 1 || opts.statementTimeoutMs > 60_000)) {
    throw new RangeError('Database statement timeout must be an integer from 1 to 60000 milliseconds');
  }
  const envMax = Number(process.env['DB_POOL_MAX']);
  const sql = postgres(databaseUrl, {
    // The installed driver's documented socket option is absent from its .d.ts;
    // structural spreading preserves the narrow hook without weakening Db types.
    ...(opts.socketFactory === undefined ? {} : { socket: opts.socketFactory }),
    // Dedicated background pools may bound connection establishment without changing the API pool.
    ...(opts.connectTimeoutSeconds === undefined ? {} : { connect_timeout: opts.connectTimeoutSeconds }),
    max: opts.max ?? (Number.isInteger(envMax) && envMax > 0 ? envMax : 10),
    onnotice: () => {}, // silence NOTICEs (e.g. from migrations)
    // A database-level rollback fence distinguishes this deed-aware build from
    // pre-cutover binaries. PostgreSQL accepts dotted custom startup settings;
    // old images never send this exact value and therefore cannot mutate stable
    // gameplay after the one-way cutover latch is activated.
    connection: {
      ...(opts.statementTimeoutMs === undefined ? {} : { statement_timeout: opts.statementTimeoutMs }),
      // D-118: SQL evidence uses the same revenge window as gameplay.
      'shardkeep.revenge_lock_hours': String(RAID_RULES.revengeLockHours),
      // 0145: SQL checks original proof age without duplicating the game number.
      'shardkeep.deed_mutation_freshness_ms': String(BASE_OWNERSHIP.mutationFreshnessMs),
      ...(opts.deedEconomyWriter === false ? {} : { 'shardkeep.deed_economy_writer': 'v1' }),
      ...(opts.marketRecoveryWriter === false ? {} : { 'shardkeep.item_market_recovery': 'v1' }),
      // Opt-in fixture compatibility. The DB function additionally requires
      // current_database()='shardkeep_test', so copying this option into any
      // non-test process grants nothing.
      ...(opts.legacyTestEscape ? { 'shardkeep.allow_legacy_test': 'on' } : {}),
    },
  });
  const db = drizzle(sql, { schema });
  return { db, sql };
}

export type Db = ReturnType<typeof createDb>['db'];

/**
 * The transaction handle passed to a `db.transaction(async (tx) => …)` callback.
 * Money-mutating helpers (postTransaction, account helpers, spend.ts) accept
 * `Db | DbTx` so a caller can run several ledger posts + row updates inside ONE
 * outer transaction with row locks — the ledger then opens a SAVEPOINT instead
 * of a fresh top-level transaction. This is what makes collect/cache/raid
 * atomic with their FOR UPDATE locks (security review findings 1–5).
 */
export type DbTx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Either the pool-backed db or an open transaction handle. */
export type DbOrTx = Db | DbTx;
