# `@shardkeep/api`

The Fastify 5, server-authoritative backend for Pixel Kingdom Wars. It owns
authentication, authorization, base progression, armies, deterministic raid
resolution, quests, world state, the Gold Forge, deed transfer, marketplace,
chat/mail, custody ledger and guarded Solana payment paths.

The browser submits intent and renders responses. Costs, timers, balances,
ownership and battle results are validated here; gameplay state is not stored
in the Anchor programs.

## Local development

Run from the repository root:

```sh
pnpm install
cp .env.example .env
docker compose -f infra/docker-compose.yml up -d
pnpm dev
```

With the template's `RUN_MIGRATIONS_ON_BOOT=true` the API applies pending migrations when it starts. To run them as a separate step (what production does): `DATABASE_URL=postgres://shardkeep:shardkeep@localhost:5433/shardkeep pnpm --filter @shardkeep/api db:migrate`.

The root template uses API port `8787` and web port `5173`.

```sh
curl http://localhost:8787/health
curl http://localhost:8787/version
```

`apps/api` loads the root `.env` through its development script. Do not create
or commit a package-local environment file.

## Verification

PostgreSQL and Redis must be running before the API suite:

```sh
pnpm --filter @shardkeep/api typecheck
pnpm --filter @shardkeep/api test
```

The test setup recreates only the dedicated `shardkeep_test` database. It tests
real PostgreSQL transactions, locks, migrations and ledger invariants; the
development database is not touched.

## Source map

```text
src/
├── app.ts          Fastify assembly, security middleware, health/version
├── server.ts       validated configuration, dependencies and worker boot
├── auth/           wallet sessions, social-wallet linking and account security
├── chat/           chat, reports, blocks and moderation records
├── db/             Drizzle schema, migrations and operational DB tasks
├── game/           progression, economy, raids, world, deeds, market and quests
├── ledger/         append-only double-entry accounting
├── mail/           player mail
├── money/          deposits, withdrawals and proof-of-liabilities
└── lib/            bounded shared server utilities
```

## Accounting and chain boundary

Every ledger posting is idempotent, balanced per currency and committed in one
database transaction. Corrections use compensating entries rather than editing
history. The chain layer verifies finalized receipts and ownership; discovery
indexers are never authoritative for money or authorization.

See [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md),
[`docs/SOLANA.md`](../../docs/SOLANA.md), and
[`docs/ECONOMY.md`](../../docs/ECONOMY.md).
