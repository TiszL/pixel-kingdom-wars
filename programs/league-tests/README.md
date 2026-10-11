# Isolated league validator suite

This suite lives outside `programs/tests/**/*.ts` so the existing Anchor
economy/craft/charter regression glob and default tsconfig stay unchanged. A
missing fixture or missing public artifact is a failure, never a skip.

## Running it

Build the programs first so both the league and core IDL artifacts exist, then
run the suite from `programs/` with the oracle wrapper:

```sh
PKW_LEAGUE_ORACLE_EVIDENCE_PATH=/absolute/path/to/new-public-oracle.json ../scripts/node_modules/.bin/tsx league-tests/run.ts --fixture ./league-tests/leagueProofOracle.ts --admission-receipt <receipt>
```

The oracle uses the macOS Homebrew binary `/opt/homebrew/opt/openssl@3/bin/openssl`.
On any other host (a Linux CI runner) set `PKW_LEAGUE_OPENSSL` to an absolute OpenSSL that offers
`KECCAK-256`; there is no PATH lookup or fallback, and a binary without `KECCAK-256` or with a wrong
empty-input answer is refused before the fixture starts.

Nothing installs, builds, deploys or accesses an owner wallet implicitly. For
Anchor IDL commands use the library selector `-p shardkeep_league`; program
source/package names remain unchanged. Never use `anchor keys sync`, copy an
owner key into the build tree or run `cargo update`.

The selected module exports an async `leagueFixture({ admissionReceipt,
programsDirectory })` factory returning `{ fixture, dispose }`. Importing the
module has no execution side effects. The runner explicitly awaits the factory,
validates its public receipt/loopback metadata and installs the fixture only for
the selected suites. It awaits disposal after validation, loading, test and
ordinary completion paths; both test and cleanup failures remain failures.
The factory handles partial-startup failures before a handle can be returned.
The oracle wrapper calls the fixture factory once and returns its original handle;
do not launch a second fixture or validator for the oracle step.

Six files run: `runnerOptions.test.ts`, `runnerLifecycle.test.ts`,
`leagueFixtureLifecycle.test.ts`, `leagueFixture.test.ts`,
`committedFailure.test.ts`, and `shardkeep-league.ts`. None is discovered by the
existing regression glob. `league-tests/tsconfig.json` selects this directory and
the generated league types for a separate no-emit typecheck. From `programs/`:

```sh
node_modules/.bin/tsc --noEmit -p league-tests/tsconfig.json
```

The 20 pure oracle mock cases run separately; from the repository root:

```sh
programs/node_modules/.bin/ts-mocha -p programs/league-tests/tsconfig.json programs/league-tests/leagueProofOracle.test.ts
```

## Fixture contract

The bootstrap owns one fresh local validator on `127.0.0.1:18899`. It verifies
public ELF/IDL inputs and checks ports before creating exactly seven in-memory
actor keypairs: admin, guardian, funder, claimant, second, stranger and nextAdmin.
Actor key bytes are never written or printed. The league and core programs are
loaded upgradeably with the generated admin as authority, using only public
program IDs and ELF paths. No existing validator, default CLI wallet or public
RPC is borrowed.

Mint and noncanonical token-account addresses are derived with seeded account
creation, requiring no additional actor/mint keypairs. The public fixture has:

- A classic reward mint with both authorities revoked and a funder balance above
  100000 raw test units.
- A mint retaining its mint authority, one retaining only its freeze authority,
  an otherMint, and a Token-2022 mint; authority-refusal mints have their required
  funder ATAs so errors reach the intended program guards.
- Canonical test ATAs and two initialized noncanonical token accounts owned by
  claimant and funder respectively.
- Seven SOL-funded actors; nextAdmin's good-mint ATA is deliberately absent.
- A 120-second local test window. maxPlaces, claimWindowMaxSec and settlementDelaySec
  are loaded from the shared policy (accepted values 500, 4838400 and 900),
  not alternate game tuning.

The lifecycle requires `solana-test-validator --version` to report exactly
2.3.13 before allocating its ledger or spawning the validator. Its dynamic range
is 19010–19035, and every port in that range is probed over TCP and UDP.
The lifecycle refuses occupied ports, bounds readiness and checks both loaded
ProgramData authorities and exact ELF bytes before fixture transactions.
Transaction confirmation polls HTTP status at the requested commitment, with
bounded cancellation and blockheight expiry; unused durable nonce strategies
are refused. It stops only its own child and releases only its own temporary
ledger on completion/failure/signals. The runner never starts a background
watcher or takes over an unrelated process. An externally killed runner can
leave its child or temporary ledger behind; an occupied port is a refusal, not
permission to adopt or kill another process.

## Assertions

The validator cases include explicit week-PDA/vault substitutions: claim and
sweep pass A's accounts with B's argument, require `ConstraintSeeds` and compare
A/B snapshots. The isolated-week check is retained as a smoke case. The fixture
precondition checks nextAdmin SOL funding as well as its absent ATA.

Committed failures use `skipPreflight: true` and require exact instruction
error/log name, finalized transaction and unchanged account snapshots, with only
the payer's fee deducted.

The proof oracle derives fixed P1–P5 digest/root/proof literals with OpenSSL
KECCAK-256 after an empty-input known-answer self-test. Identical literals live
in the test module of `programs/shardkeep-league/src/proof.rs` and in
`packages/chain/src/leagueClaimProof.test.ts`, with exact input bytes, command and
outputs in their public evidence file. These literal comparisons run without a
runtime oracle. The fixed 500-leaf fixture remains separate from policy-sized
maximum-tree tests, even when the current maxPlaces policy also equals 500.

Validator binding is the separate, named `C3-INDEPENDENT-KECCAK-ORACLE` evidence
step before suite initialization. The wrapper first checks algorithm availability
and the empty-input known answer, refusing missing capability without fallback
or a silent skip. All seven actors remain random and in memory; no fixed seed is
introduced to make a vector. Their public program/config/week/claimant inputs
are frozen into an exclusive record before `open_week`. The independent root
must equal the production tree root; that exact root is funded and claimed,
with account root, payouts, bitmap and finality verified.
