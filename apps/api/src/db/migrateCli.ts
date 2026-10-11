import { createDb } from './client';
import { runMigrations } from './migrate';

// Explicit operator command only. Normal API startup remains assert-only.
const databaseUrl = process.env['DATABASE_URL'];
if (!databaseUrl) throw new Error('DATABASE_URL is required for db:migrate');
const connection = createDb(databaseUrl, { max: 1 });
try {
  await runMigrations(connection.db);
} finally {
  await connection.sql.end();
}
