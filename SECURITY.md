# Security policy

Pixel Kingdom Wars is a live **devnet alpha**. Please report vulnerabilities privately before publishing them.

## Reporting

Email [support@pixelkingdomwars.com](mailto:support@pixelkingdomwars.com) with:

- the affected component, route, program, or transaction;
- reproduction steps and the minimum proof needed to confirm impact;
- whether any player data or funds may be at risk;
- a safe way to contact you for follow-up.

Do not include private keys, seed phrases, session tokens, signing-keystore passwords, or another player's personal data. We ask researchers not to access other players' data, degrade the service, move assets that are not theirs, or test against production beyond the minimum safe proof. Good-faith reports following those limits are welcome.

No bounty amount or response SLA is promised. Reports are acknowledged and triaged as quickly as possible.

## Current trust boundary

- The web client is untrusted. It submits intent and renders responses; it does not decide costs, eligibility, timers, ownership, or raid outcomes.
- The Fastify API is authoritative for gameplay and keeps the append-only custody ledger in PostgreSQL.
- Raid resolution uses a versioned deterministic simulator. The API freezes inputs and settles results idempotently.
- Privileged deed-backed mutations require a fresh confirmed Metaplex Core ownership observation and fail closed when chain authority cannot be proven.
- SOL payments and SPL-token transfers are accepted only after transaction verification and idempotent crediting.
- KEEP withdrawals require a player-wallet signature over the exact payout intent. The worker independently verifies that immutable proof and ledger freeze before producing one signed transaction whose exact bytes are stored before broadcast to every configured economy RPC and finalized reconciliation.
- Proof-of-reserves and the payout brake count only the finalized, canonical, unencumbered hot-wallet KEEP ATA. Mainnet requires matching evidence from two independent RPC providers.
- On-chain programs constrain signers, PDAs, treasuries, token accounts, and arithmetic; their validator suite includes adversarial cases.

This separation is described in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/SOLANA.md](docs/SOLANA.md).

## On-chain status

There are exactly two custom Anchor programs:

- `shardkeep-core` is active on devnet and holds configuration for SOL routing, receipts, pause/admin state, and immutable liability roots. Its Config is already initialized. The authority-gated initializer is live: the program was upgraded at finalized devnet slot `485153145` ([transaction](https://explorer.solana.com/tx/31nQ3tECj5TPboXx9V5pyt8Rix9J5MZ3jyTwmcHYqpes3M64B9yggYPWFppHJheKZwKJ1moWBp2cMVqTaGtQmFxc?cluster=devnet)), and its on-chain IDL was updated at slot `485153368`. A fresh Config can now be created only by the program's current upgrade authority through the canonical ProgramData account; the existing Config was not recreated or changed.
- `shardkeep-distributor` is deployed, upgrade-authority-gated code for a future Merkle-claim flow, but its PDA for the current KEEP mint is absent, it has no application call sites, and it holds no funds.

The programs have internal review and adversarial tests. **They have not received a third-party security audit.** Nothing in this repository should be treated as mainnet-ready solely because devnet tests pass.

The current Classic SPL devnet mint has 500 million KEEP. Mint and freeze authorities remain enabled during alpha; fixed supply and authority revocation remain future mainnet design work.

## Known mainnet prerequisites

- Provision and exercise the source-implemented non-owner API/worker database roles and the database-blind withdrawal policy signer. Wallet-signed authorization prevents silent changes to an exact payout; worker reservations enforce each wallet's rolling limit; and the signer independently enforces exact-transfer, per-wallet, and aggregate rolling ceilings from its fsynced journal. The aggregate ceiling is a custody circuit breaker, not a player-facing shared withdrawal pool. The implemented signer is isolated software with a file-backed key, not an HSM or enclave; mainnet still requires approved key custody, limits, off-host recovery, and an independent release audit.
- Before enabling the distributor, complete an externally reviewed initialization/funding ceremony and choose a long-lived distributor admin or add reviewed admin rotation. The arbitrary first-signer initialization issue is fixed; the current-mint PDA remains absent and unfunded.
- Finalize token supply/allocation, mint-authority, freeze-authority, and old-mint migration policy.
- Create and review the mainnet address registry, then deploy and initialize the program, mint, collection, and PDA state through a recorded ceremony. The current core upgrade authority must sign Config initialization before program finalization, followed by reviewed authority transfers if needed; the legacy devnet bootstrap helper is not a mainnet ceremony. Use a fresh economy database or an explicit drained owner migration—the singleton chain identity refuses repointing the live devnet ledger. No mainnet game state exists today.
- Complete an independent program and custodial-backend security review.
- Provision authenticated off-host backups with immutable retention, scheduling, alerts, and a successful live remote restore drill. The repository tooling is fail-closed and verifies uploads/restores, but it cannot provision the external service or credentials.
- Complete production RPC provisioning and representative physical-device payment, wallet-handoff, and withdrawal verification.
- Complete commercial-use records and third-party notices for distributed media.

The broader, current list is in [docs/KNOWN_LIMITATIONS.md](docs/KNOWN_LIMITATIONS.md).

## Secrets and build artifacts

Never commit:

- `.env` or production environment files;
- Solana keypair JSON files or seed phrases;
- Android `.jks`, `.keystore`, password files, APKs, AABs, or dApp Store upload bundles;
- database dumps, session exports, or private invite lists;
- vendor API keys, RPC secrets, JWT secrets, or signing credentials.

Mobile signing credentials and build artifacts, Solana keypairs, and deployment keys are excluded from Git and checked by repository-readiness tests. Public addresses belong in `infra/devnet.addresses.json`; secret material does not.

If a secret is committed, removing the working-tree file is insufficient. Rotate it immediately, stop using the compromised credential, identify every reachable and unreachable Git object or release artifact, and coordinate remote object removal with the host. Do not rewrite public history casually; contain first, then choose the narrowest remediation that actually removes access.

## Supported scope

Security reports are useful for:

- `apps/api` authentication, authorization, custody, payments, deeds, markets, raids, and privacy boundaries;
- `programs/` account validation, payment routing, Merkle proofs, initialization, and admin controls;
- `packages/chain` transaction construction and chain observation;
- `packages/sim` determinism or settlement-integrity failures;
- `apps/web` wallet, session, injection, or sensitive-data exposure;
- deployment, mobile signing, artifact, and secret-handling paths.

Pure balance suggestions, expected devnet resets, and already-disclosed product gaps are not vulnerabilities, though ordinary bug reports are still welcome at the same address.
