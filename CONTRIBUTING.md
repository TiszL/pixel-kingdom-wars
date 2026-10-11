# Contributing

Pixel Kingdom Wars is a live devnet alpha. Changes should leave both the game and the repository easier to trust than they were before.

Start with the [README](README.md), [project overview](PROJECT_OVERVIEW.md), [architecture](docs/ARCHITECTURE.md) and [testing](docs/TESTING.md) documents.

## Setup

Requirements: Node.js 22+, pnpm 10.19.0, Docker, and Docker Compose. Anchor work additionally needs the pinned Anchor 0.32.1 and Agave 2.3.13 toolchain. The Android client needs JDK 17 and an Android SDK with platform 36.

```bash
pnpm install --frozen-lockfile
cp .env.example .env
docker compose -f infra/docker-compose.yml up -d
pnpm dev
```

The template sets `RUN_MIGRATIONS_ON_BOOT=true`, so the API migrates the local database when it starts. Production applies migrations as a separate step: `DATABASE_URL=… pnpm --filter @shardkeep/api db:migrate`.

Use only local/devnet credentials. Never copy production secrets or mobile signing files into a checkout.

The API is required for authentication and game state. Running Vite by itself is an isolated client diagnostic, not a functioning game environment.

## Branches and commits

Use a short topic branch for non-trivial work. `main` is the deployment branch. Changes to `packages/sim`, `programs`, migrations, or money paths never qualify as trivial direct-to-main edits.

Use Conventional Commits:

```text
<type>(<scope>): <short subject>

Why the change was needed, what evidence supports it, and what was verified.
```

Common types are `feat`, `fix`, `docs`, `test`, `refactor`, `build`, `ci`, and `chore`.

## Non-negotiable invariants

1. Every gameplay number lives in `packages/shared/src/constants.ts` with its source. Clients display server/shared values; they do not invent rules.
2. `packages/sim` is pure and deterministic: fixed integer math, no wall clock, no `Math.random`, and no transcendental `Math` functions.
3. The server validates all gameplay mutations and settles all value movement.
4. Replay behavior changes require a `SIM_VERSION` bump, history note, and justified fixture changes. Historical playback is archived authoritative events, not an invitation to change old results.
5. Program changes use the pinned toolchain, keep `programs/Cargo.lock`, pass the on-chain security checklist in `docs/ARCHITECTURE.md`, and run `anchor test`.
6. Runtime atlases and audio under `apps/web/public` are generated output; do not hand-edit them.
7. Never delete or skip a test to make a gate pass. Rewrite a test only when a deliberate behavior change makes its previous intent obsolete, and record why.
8. Never commit secrets, APK/AAB files, Android signing material, database dumps, or private user data. See [SECURITY.md](SECURITY.md).

## Verification

For ordinary TypeScript/documentation work:

```bash
pnpm -r typecheck
pnpm -r lint
pnpm -r test
pnpm -r build
```

The API suite uses PostgreSQL and Redis from the local compose stack. A focused package test is useful while iterating, but it does not replace the final relevant gate.

For any Anchor change:

```bash
cd programs
anchor build
anchor test
```

For the Android client, from `android/`:

```bash
./gradlew :renderer:test :content:test :network:testDebugUnitTest :wallet:testDebugUnitTest :app:testDebugUnitTest :app:lintDebug :app:assembleDebug
```

## Pull-request checklist

- Scope and player/operator impact are explained.
- New behavior has tests that encode why it matters.
- Typecheck, lint, tests, and build pass for the affected surface.
- Program, money, migration, or sim-specific gates pass where applicable.
- Documentation describes current code, not an abandoned plan.
- No secret or mobile signing artifact is present.

## Licensing

The repository is source-available for evaluation (see [LICENSE](LICENSE)). Do not assume permission to redistribute code, art, music, fonts, or brand material. Contributions must not introduce material that the project cannot lawfully store and ship; record provenance and licence evidence for every third-party asset.
