import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runMigrations as migrate } from '../src/db/migrate';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { createDb } from '../src/db/client';
import { assertEconomyChainIdentity, assertGemsReserveIdentity, gemsReserveAta } from '../src/money/economyIdentity';
import { ADMIN_DATABASE_URL } from './db-url';
import { createMigratedDatabase } from './migratedTemplate';
import { gemsTestAta, gemsTestConfig, gemsTestIdentity, gemsTestOwner, gemsTestReader } from './gems-reserve-fixture';

const MIGRATIONS = fileURLToPath(new URL('../drizzle', import.meta.url));

/** Exercise the production SQL grants verbatim, replacing only the two shared
 * group names with this test's isolated login. No global runtime membership and
 * no broad table UPDATE may hide the column-privilege boundary. */
function reserveGrants(provision: string, role: string): string[] {
  const statements = [...provision.matchAll(/^SELECT '((?:GRANT|REVOKE)[^'\n]*public\.economy_chain_identity[^'\n]*)'$/gm)]
    .map((match) => match[1]!.replaceAll('shardkeep_api_runtime, shardkeep_worker_runtime', role));
  expect(statements).toHaveLength(2);
  expect(statements.every((statement) => !statement.includes('shardkeep_api_runtime') && !statement.includes('shardkeep_worker_runtime'))).toBe(true);
  return statements;
}

describe('K-153 restricted runtime reserve binding', () => {
  it('refuses binding with current production grants, then pins once with an isolated fixture column grant', async () => {
    const suffix = randomUUID().replaceAll('-', '');
    const database = `shardkeep_gems_role_${suffix}_test`;
    const role = `sk_gems_${suffix}`;
    if (!/^shardkeep_gems_role_[0-9a-f]{32}_test$/.test(database) || !/^sk_gems_[0-9a-f]{32}$/.test(role)) {
      throw new Error('unsafe disposable identity');
    }
    const password = randomUUID();
    const admin = postgres(ADMIN_DATABASE_URL, { max: 1, onnotice: () => {} });
    const databaseUrl = new URL(ADMIN_DATABASE_URL); databaseUrl.pathname = `/${database}`;
    let owner: ReturnType<typeof createDb> | undefined;
    let runtime: ReturnType<typeof createDb> | undefined;
    let restarted: ReturnType<typeof createDb> | undefined;
    let roleCreated = false;
    try {
      await createMigratedDatabase(admin, database);
      owner = createDb(databaseUrl.toString(), { max: 1 });
      await migrate(owner.db, { migrationsFolder: MIGRATIONS });
      await owner.sql.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
      roleCreated = true;
      await owner.sql.unsafe(`GRANT CONNECT ON DATABASE ${database} TO ${role}; GRANT USAGE ON SCHEMA public TO ${role}; GRANT SELECT ON players, accounts, ledger_transactions TO ${role}`);
      const provision = await readFile(new URL('../../../infra/db/provision-runtime-roles.sh', import.meta.url), 'utf8');
      for (const grant of reserveGrants(provision, role)) await owner.sql.unsafe(grant);

      const runtimeUrl = new URL(databaseUrl); runtimeUrl.username = role; runtimeUrl.password = password;
      runtime = createDb(runtimeUrl.toString(), { max: 1 });
      // SELECT FOR UPDATE also requires an UPDATE privilege. With the held
      // column grant absent, startup must fail before attempting any binding.
      await expect(assertEconomyChainIdentity(runtime.db, gemsTestIdentity, gemsTestIdentity))
        .rejects.toMatchObject({ cause: { code: '42501' } });
      // Owner approval covers false-default infra lines only. Production grants
      // therefore still refuse reserve binding. This fixture-only grant proves
      // the proposed narrow privilege; it is not an applied infra change.
      await expect(runtime.sql`UPDATE economy_chain_identity SET gems_reserve_owner = ${gemsTestOwner.toBase58()}, gems_reserve_ata = ${gemsTestAta.toBase58()}`)
        .rejects.toMatchObject({ code: '42501' });
      await owner.sql.unsafe(`GRANT UPDATE (gems_reserve_owner, gems_reserve_ata) ON public.economy_chain_identity TO ${role}`);
      const [attributes] = await runtime.sql`
        SELECT rolsuper, rolcreatedb, rolcreaterole, rolbypassrls, rolreplication, rolinherit,
          EXISTS(SELECT 1 FROM pg_auth_members WHERE member = pg_roles.oid) AS has_membership
        FROM pg_roles WHERE rolname = current_user
      `;
      expect(attributes).toEqual({ rolsuper: false, rolcreatedb: false, rolcreaterole: false,
        rolbypassrls: false, rolreplication: false, rolinherit: false, has_membership: false });
      const [tablePrivileges] = await runtime.sql`
        SELECT has_table_privilege(current_user, 'public.economy_chain_identity', 'SELECT') AS can_select,
          has_table_privilege(current_user, 'public.economy_chain_identity', 'INSERT') AS can_insert,
          has_table_privilege(current_user, 'public.economy_chain_identity', 'UPDATE') AS can_update,
          has_table_privilege(current_user, 'public.economy_chain_identity', 'DELETE') AS can_delete,
          has_table_privilege(current_user, 'public.economy_chain_identity', 'TRUNCATE') AS can_truncate
      `;
      expect(tablePrivileges).toEqual({ can_select: true, can_insert: true, can_update: false, can_delete: false, can_truncate: false });
      const columnPrivileges = await runtime.sql<{ column: string; can_update: boolean }[]>`
        SELECT attname AS column,
          has_column_privilege(current_user, 'public.economy_chain_identity', attname, 'UPDATE') AS can_update
        FROM pg_attribute WHERE attrelid = 'public.economy_chain_identity'::regclass
          AND attnum > 0 AND NOT attisdropped ORDER BY attname
      `;
      expect(Object.fromEntries(columnPrivileges.map((column) => [column.column, column.can_update]))).toEqual({
        singleton: false, cluster: false, keep_mint: false, core_program: false, config_pda: false,
        bound_at: false, gems_reserve_owner: true, gems_reserve_ata: true,
      });

      // Both operations use the actual advisory/row locks under the restricted
      // login. A broad owner session never performs the first reserve pin.
      await assertEconomyChainIdentity(runtime.db, gemsTestIdentity, gemsTestIdentity);
      expect((await runtime.sql`SELECT gems_reserve_owner, gems_reserve_ata FROM economy_chain_identity`)[0])
        .toEqual({ gems_reserve_owner: null, gems_reserve_ata: null });
      await assertGemsReserveIdentity(runtime.db, gemsTestConfig, gemsTestIdentity, [gemsTestReader]);
      expect(gemsReserveAta(runtime.db)).toBe(gemsTestAta.toBase58());
      const [original] = await runtime.sql`SELECT * FROM economy_chain_identity`;
      expect(original).toMatchObject({ gems_reserve_owner: gemsTestOwner.toBase58(), gems_reserve_ata: gemsTestAta.toBase58() });

      restarted = createDb(runtimeUrl.toString(), { max: 1 });
      expect(gemsReserveAta(restarted.db)).toBeNull();
      await assertEconomyChainIdentity(restarted.db, gemsTestIdentity, gemsTestIdentity);
      await assertGemsReserveIdentity(restarted.db, gemsTestConfig, gemsTestIdentity, [gemsTestReader]);
      expect(gemsReserveAta(restarted.db)).toBe(gemsTestAta.toBase58());

      // Column permission admits these statements, then the write-once trigger
      // must reject them. SQLSTATE distinguishes policy rejection from a grant
      // accidentally too narrow to permit the legitimate initial pin.
      await expect(runtime.sql`UPDATE economy_chain_identity SET gems_reserve_owner = ${gemsTestIdentity.coreProgram}, gems_reserve_ata = ${gemsTestIdentity.configPda}`)
        .rejects.toMatchObject({ code: 'P0001' });
      await expect(runtime.sql`UPDATE economy_chain_identity SET gems_reserve_owner = NULL, gems_reserve_ata = NULL`)
        .rejects.toMatchObject({ code: 'P0001' });
      await expect(runtime.sql`UPDATE economy_chain_identity SET cluster = 'mainnet-beta'`)
        .rejects.toMatchObject({ code: '42501' });
      await expect(runtime.sql`UPDATE economy_chain_identity SET keep_mint = ${gemsTestIdentity.coreProgram}`)
        .rejects.toMatchObject({ code: '42501' });
      await expect(runtime.sql`DELETE FROM economy_chain_identity`).rejects.toMatchObject({ code: '42501' });
      await expect(runtime.sql`TRUNCATE economy_chain_identity`).rejects.toMatchObject({ code: '42501' });
      expect((await runtime.sql`SELECT * FROM economy_chain_identity`)[0]).toEqual(original);
    } finally {
      try {
        await restarted?.sql.end();
        await runtime?.sql.end();
        if (roleCreated && owner) {
          await owner.sql.unsafe(`DROP OWNED BY ${role}`);
          await owner.sql.unsafe(`DROP ROLE ${role}`);
          roleCreated = false;
        }
      } finally {
        await owner?.sql.end();
        try {
          await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
          // Also clean up after an unexpected cleanup failure above; the test
          // role owns nothing outside this unique disposable database.
          if (roleCreated) await admin.unsafe(`DROP ROLE IF EXISTS ${role}`);
        } finally { await admin.end(); }
      }
    }
  });
});
