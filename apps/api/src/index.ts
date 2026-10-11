/**
 * @shardkeep/api — Fastify 5 server-authoritative backend (ARCHITECTURE §5).
 * Foundation phase: schema, double-entry ledger engine, SIWS auth, app skeleton.
 * Entrypoint: src/server.ts (`pnpm --filter @shardkeep/api dev`).
 */
export { buildApp } from './app';
export { loadConfig, type Config } from './config';
export { createDb, type Db } from './db/client';
export * from './ledger';
