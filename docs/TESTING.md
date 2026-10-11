# Testing and verification

Pixel Kingdom Wars treats tests as executable product and safety contracts. A passing package test is useful evidence, but no single test count or green badge makes a live custody-bearing alpha mainnet-ready.

## Standard local gate

```bash
docker compose -f infra/docker-compose.yml up -d
pnpm -r typecheck
pnpm -r lint
pnpm -r test
pnpm -r build
```

PostgreSQL listens on local port 5433 and Redis on 6380. The API suite uses both for real transactions, advisory locks, job state, and ledger behavior. Copy `.env.example` to `.env` for local development; never use a production environment file in routine tests.

Run the narrowest useful package while iterating:

```bash
pnpm --filter @shardkeep/shared test
pnpm --filter @shardkeep/sim test
pnpm --filter @shardkeep/chain test
pnpm --filter @shardkeep/api test
pnpm --filter @shardkeep/web test
pnpm --filter @shardkeep/scripts test
```

A focused result does not replace the relevant full gate before merge.

## What each package proves

| Package | Primary contracts |
|---|---|
| `shared` | constants, schemas, level tables, unlock relations, quest/asset registries, and cross-system invariants |
| `sim` | deterministic combat, target/path behavior, loot conservation, actor abilities, campaign difficulty, golden replays, and banned nondeterminism |
| `chain` | instruction/account construction, token parsing, deed mint/update/recovery, royalty/freeze policy, and address consistency |
| `api` | authentication, authorization, database migrations, double-entry ledger, deposits/withdrawals, deeds, economy, raids, markets, quests, social systems, and jobs |
| `web` | screens, interactions, wallet/mobile behavior, battle rendering, asset loading, responsive UI, service worker, and bundle contracts |
| `scripts` | asset/audio pipeline, bootstrap/release guards, economy models, and operational transformation logic |

## Deterministic simulator gate

`packages/sim` is a replay protocol, not merely a helper library.

- Simulation advances at a fixed tick and uses integer positions at 256 units per tile.
- Seeded RNG and stable actor ordering make repeated inputs reproduce the same outcome.
- Tests ban wall-clock access, `Math.random`, and transcendental `Math` calls inside simulator sources.
- Golden fixtures pin event/result behavior for representative battles.
- A source fingerprint and CI base-branch comparison require `SIM_VERSION` to move with behavior or fixture changes.

When simulator behavior changes, update the version history, regenerate only justified fixtures, prove affected pending raids are handled at deployment, and retain old archived event timelines for playback. Never silently re-pin a hash just to make a test green.

## API and value-path gate

Value paths are tested against real PostgreSQL transactions. Important properties include:

- every ledger transaction balances and has an idempotency key;
- a retry cannot double-credit a deposit, reward, market sale, or withdrawal;
- stale or unavailable deed ownership fails privileged actions closed;
- quoted payments are revalidated against current eligibility and exact transaction evidence;
- raid creation locks/freeze state atomically and settlement executes once;
- reserve and withdrawal controls stop rather than guess when prerequisites are missing.

Changes to deposits, withdrawals, the ledger, marketplace settlement, deed transfer, or migrations require a security-focused review in addition to ordinary tests.

## Anchor programs

The workspace test is separate from the pnpm gate:

```bash
cd programs
anchor build
anchor test
```

The validator suite covers both programs and includes malicious-account and replay-style cases. Every program change must also be checked against the on-chain checklist in [ARCHITECTURE.md](ARCHITECTURE.md).

GitHub CI currently runs TypeScript typecheck, lint, tests, build, and the simulator change gate. It does **not** currently execute `anchor test`; program verification remains a mandatory manual/release gate and a documented CI gap.

## Asset and mobile verification

Runtime atlases, audio and brand output under `apps/web/public` are committed in this repository (they are generated from the original art masters by a private pipeline). The checks that read them:

```bash
pnpm --filter @shardkeep/scripts test
pnpm --filter @shardkeep/web build
```

Asset tests cover runtime IDs, atlas metadata, mobile pack integrity, and build-size limits. Visual changes still need human/device review because a byte-valid atlas can contain the wrong frame, anchor, scale, or direction.

Android release verification occurs outside Git. The signing keystore, password material, APK/AAB output, and dApp Store upload bundle must never be added to the repository. Physical-device orientation, wallet handoff, notification, and frame-rate checks cannot be replaced by jsdom tests.

## Production evidence

The live deployment publishes its release through [`/api/version`](https://play.pixelkingdomwars.com/api/version). Deployment checks compare the intended commit, schema state, service health, deed coverage, ledger reconciliation, proof-of-reserves status, and logs. These operational checks are evidence for the deployed alpha, not substitutes for source tests.

## Reporting results

- Report skipped tests and known flakes; do not summarize them as “all tests pass.”
- Do not quote a historical test count as the current count.
- Do not remove or weaken a test to hide a changed invariant.
- No external security audit has been completed; current assurance comes from internal review and tests.
- A devnet smoke test proves devnet behavior only.

Current product and release caveats are listed in [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md).
