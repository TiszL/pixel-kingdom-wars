/** Complete inventory tests cannot share unrelated suites' historical deeds. */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { createDb } from '../src/db/client';
import { runMigrations } from '../src/db/migrate';
import { ADMIN_DATABASE_URL } from './db-url';

export function disposableMintTestDb(purpose: 'mint_worker' | 'mint_reconciliation', max = 12) {
  const name = `${purpose}_${randomUUID().replaceAll('-', '')}_test`;
  const url = new URL(ADMIN_DATABASE_URL);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || !/^mint_(worker|reconciliation)_[a-f0-9]{32}_test$/.test(name)) {
    throw new Error('Mint fixture requires a local disposable test database');
  }
  url.pathname = `/${name}`;
  const connection = createDb(url.toString(), { max });
  let owned = false;
  return {
    ...connection,
    url: url.toString(),
    async create() {
      const maintenance = postgres(ADMIN_DATABASE_URL, { max: 1, onnotice: () => {} });
      try {
        await maintenance.unsafe(`CREATE DATABASE ${name}`);
        owned = true;
      } finally { await maintenance.end(); }
      await runMigrations(connection.db);
    },
    async close() {
      await connection.sql.end();
      if (!owned) return;
      const maintenance = postgres(ADMIN_DATABASE_URL, { max: 1, onnotice: () => {} });
      try {
        await maintenance.unsafe(`DROP DATABASE ${name} WITH (FORCE)`);
        owned = false;
      } finally { await maintenance.end(); }
    },
  };
}
