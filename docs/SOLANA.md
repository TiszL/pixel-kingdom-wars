# Solana integration

Pixel Kingdom Wars uses Solana for ownership, player-signed payments, token movement, and public commitments. Gameplay state and real-time combat remain server-authoritative. This document describes current devnet code and chain state, not future tokenomics.

## Deployed custom programs

| Program | Devnet program ID | Status |
|---|---|---|
| `shardkeep-core` | [`mYYQFnpyGofG31y5oJkiKVmNwifbSXBMnQ5aUgQkL6b`](https://explorer.solana.com/address/mYYQFnpyGofG31y5oJkiKVmNwifbSXBMnQ5aUgQkL6b?cluster=devnet) | Active; Config PDA initialized and used by production payment/root flows |
| `shardkeep-distributor` | [`6Tgc32nfuEDwvVQii47eLKZXeu39evzG5142UheuxpKU`](https://explorer.solana.com/address/6Tgc32nfuEDwvVQii47eLKZXeu39evzG5142UheuxpKU?cluster=devnet) | Authority-gated binary deployed; current-mint distributor PDA absent; no production call sites or funds |

Both are Anchor 0.32.1 programs built with the repository's pinned Agave 2.3.13 toolchain. Public addresses are also recorded in [`infra/devnet.addresses.json`](../infra/devnet.addresses.json).

### Cluster and registry gates

The checked-in registry and live game state are devnet-only. Source mainnet mode refuses to open the database or serve routes without a reviewed `infra/mainnet.addresses.json`, two different RPC provider hosts/vendor labels, and the mainnet genesis hash from both endpoints. Both providers must then attest the registry's reviewed core program ID and executable, canonical Config owner and decoded mint/treasury/split/price state, initialized nine-decimal Classic SPL KEEP mint, and Metaplex Core deed collection. A listed distributor is attested the same way; it is optional while that feature remains inactive.

No mainnet registry or corresponding program, mint, Config, collection, or PDA state exists in this repository today. These startup gates validate a ceremony's result; they do not perform the deployment or replace external review.

## `shardkeep-core`

Source: [`programs/shardkeep-core/src/lib.rs`](../programs/shardkeep-core/src/lib.rs)

The core program does not store bases or resolve combat. It routes SOL and records compact receipts/commitments.

### Accounts

- `Config` PDA `['config']` — admin and pending admin, a legacy KEEP-mint field, three treasury addresses, payment split, legacy prices, pause state, and bump. The existing devnet account still names an earlier mint; current custody reads `infra/devnet.addresses.json`, and no active core instruction uses the Config mint field.
- `Player` PDA `['player', wallet]` — an init-once entry receipt with wallet, open time, legacy builder/expansion counters, and bump. It is not the authoritative playable base.
- `EpochRoot` PDA `['root', epoch_le]` — one immutable root per epoch with Merkle root, total liability, post time, and bump.

The existing devnet Config is already initialized, so the fresh-initialization path cannot be used against that account. The deployed program now binds `initialize` to its canonical upgradeable-loader ProgramData account and requires the creating admin to be the program's current upgrade authority. That closes the first-signer race for a fresh deployment without pinning a stale public key.

The reviewed core binary was upgraded in place at finalized devnet slot
`485153145` ([transaction](https://explorer.solana.com/tx/31nQ3tECj5TPboXx9V5pyt8Rix9J5MZ3jyTwmcHYqpes3M64B9yggYPWFppHJheKZwKJ1moWBp2cMVqTaGtQmFxc?cluster=devnet)). Its canonical ProgramData account is
[`BeQw6n6hKp8DCf7shN1E2ddv2LvaTH51KPZTiey15RvW`](https://explorer.solana.com/address/BeQw6n6hKp8DCf7shN1E2ddv2LvaTH51KPZTiey15RvW?cluster=devnet). A fresh finalized read on 2026-09-06 at context slot `494127420` confirmed the unchanged deployment slot, a 357,941-byte ProgramData account and 357,896 executable bytes after the 45-byte loader header. The executable-data SHA-256 matches the local artifact at
`70c5a035e868c58accd098deb65a4d91e2fbc13e6c8b5ee5e2588e30e722408d`.
This corrects the previously recorded hash; it does not describe a new program deployment. See the land recovery security review for the read-only verification basis.
The on-chain IDL was updated at finalized slot `485153368`
([transaction](https://explorer.solana.com/tx/2JUaZfpTX8MkQBbHdePGkMWK8Xg8MWcz1U69AwQJtA5g7Erqogg8YTgx2J9p6NhY1UFH4y7TbsuLAHMBo8DEHvgp?cluster=devnet)) and exposes the authority-gated `initialize` accounts. The existing Config
[`AEtsnqdSXDwGDBeovnD9XoutQmNptcPWC8ygieZSkKHH`](https://explorer.solana.com/address/AEtsnqdSXDwGDBeovnD9XoutQmNptcPWC8ygieZSkKHH?cluster=devnet) remained owned by the core program; its current account-data SHA-256 is
`def8e53436d4337765150c2ee6388ebd0606bcc4963ae2b4029a6f21511099c0`.

A fresh mainnet ceremony must initialize Config while the program still has an upgrade authority. The current authority can sign and then complete the reviewed two-step authority transfers, or the intended multisig can be installed first and invoke initialization itself. Finalizing the program beforehand would make the authority-gated initializer unusable. The legacy `runBootstrap` helper is devnet-only and is not the reviewed mainnet initialization path.

### Instructions

| Instruction | Purpose |
|---|---|
| `initialize` | Upgrade-authority-only fresh Config creation; validates that the three split values total 10,000 basis points and records that authority as the first admin |
| `pay_entry` | Init-once first-land payment; routes configured SOL split and creates the wallet Player receipt |
| `buy_sink` | Repeatable tagged SOL payment; emits kind, amount, wallet, and client reference without granting gameplay itself |
| `buy_builder` | Legacy sequential builder receipt path retained for compatibility |
| `buy_expansion` | Legacy sequential expansion receipt path retained for compatibility |
| `post_root` | Admin-only init-once publication of an immutable liabilities root for an epoch |
| `set_paused` | Stops payment instructions when Config is paused |
| `propose_admin` / `accept_admin` | Two-step admin transfer |

Every payment routes directly from the player signer to the Config-constrained treasury accounts. The remainder from integer basis-point division goes deterministically to the liquidity leg. A client-supplied reference public key is present only so the API can find and reconcile the transaction; the program does not trust it for authorization.

Current product paths use:

- `pay_entry` for a wallet's first paid land;
- `buy_sink(kind = 3)` for single raid energy;
- `buy_sink(kind = 4)` for normal shield extension;
- `buy_sink(kind = 6)` for Warzone shield payment;
- `buy_sink(kind = 7)` for an energy pack;
- `buy_sink(kind = 8)` for additional builders;
- `buy_sink(kind = 9)` for additional deeds;
- `post_root` for proof-of-liabilities commitments.

Mine, Gold Forge, and expansion paths that must pay entirely to liquidity use verified direct SOL transfers because the generic 40/35/25 sink does not match their economic rule. The API, not `buy_sink`, maps a tag and exact amount to an eligible gameplay effect; an invalid or underpaid transaction grants nothing.

## `shardkeep-distributor`

Source: [`programs/shardkeep-distributor/src/lib.rs`](../programs/shardkeep-distributor/src/lib.rs)

The distributor is a prepared TGE-simulation Merkle claim mechanism. It is not the same system as weekly proof-of-liabilities roots.

### Accounts

- `Distributor` PDA `['distributor', mint]` — admin, mint, vault ATA, root, claim/clawback times, total claimed, version, and bump.
- vault-authority PDA `['vault']` — token authority for the distributor vault.
- `ClaimStatus` PDA `['claim', distributor, claimant]` — init-once lifetime claim marker for that claimant/distributor pair.

### Instructions

- `initialize_distributor` creates the mint-specific distributor and its vault ATA only when the signer is the program's current upgrade authority, verified through the upgradeable-loader ProgramData account. It sets version 1 and records that signer as distributor admin.
- `claim` verifies a domain-separated Merkle proof, creates `ClaimStatus`, and transfers with `transfer_checked` from the vault.
- `set_root` is admin-only, replaces the root/window, and increments the version used in new leaves.
- `clawback` is admin-only after the configured time and sweeps remaining vault tokens to a same-mint destination token account.

Leaves hash `0x00 || claimant || amount_le || version_le`; internal nodes hash `0x01 || min(left,right) || max(left,right)`. Domain separation prevents a node preimage from being reinterpreted as a leaf.

`ClaimStatus` is not versioned in its seeds, so each claimant can claim only once over the lifetime of a Distributor account, even if `set_root` advances the root version. The program is therefore a one-claim distribution with revisable pre-claim snapshots, not a recurring weekly rewards distributor.

### Current inactive state and initialization control

On 18 August 2026 the distributor was upgraded in place at devnet slot
`485044452` ([transaction](https://explorer.solana.com/tx/4jhLcXHmDa7g7jZXGXXVCrSGCohcSVNHC42hN3abhhUQB1NVyqd7tfT8WoHLcs4Z34bzUqsRM37ZUovZfqu3h1mm?cluster=devnet)).
The deployed executable hash matches the reviewed local binary, the on-chain IDL
contains the Program/ProgramData authority accounts, and an adversarial validator
test proves an unrelated signer receives `Unauthorized` without creating the PDA.

Post-upgrade RPC verification confirms that the deterministic Distributor PDA for
the current KEEP mint remains absent. No production package calls the program and
no production funds are assigned to it. A future initialization would snapshot
the then-current upgrade authority as distributor admin; it therefore still needs
a reviewed authority, initialization, and funding ceremony before use.

## Land Deeds: Metaplex Core

Land Deeds are **Metaplex Core NFTs**, not Bubblegum compressed NFTs. The server mints a deterministically recoverable asset into a Core collection after a verified land payment.

Each deed carries:

- an asset identity tied to a stable `base_id`, never the current wallet;
- dynamic name/URI metadata synchronized from authoritative base state;
- a permanent freeze delegate controlled by the configured authority, with new deeds currently transferable because trading is enabled;
- a 5% royalty plugin copied from the collection to the asset.

The royalty uses a `None` rule set. It is marketplace-honoured rather than enforced on every direct transfer. The collection screen provides Tensor and Magic Eden links; after a Core transfer, the buyer claims the base and the server re-reads ownership before rebinding it. There is no custom deed-market escrow program. The separate in-game **item** market verifies one atomic buyer-signed SOL transaction that pays 95% to the seller and 5% to the configured fee treasury.

The deed conveys the complete playable base, including local SHARDS and open economic positions. Wallet KEEP/SOL and identity remain outside the deed. See [GAMEPLAY.md](GAMEPLAY.md).

## KEEP token

The current alpha uses a **Classic SPL Token** mint with nine decimals:

[`5GQh8Dg2BFtH3Yso5drRA2K8omw46m3KAQrhH3TMpWJC`](https://explorer.solana.com/address/5GQh8Dg2BFtH3Yso5drRA2K8omw46m3KAQrhH3TMpWJC?cluster=devnet)

Live devnet state verified on 18 August 2026:

- supply: 500,000,000 KEEP;
- mint authority: retained;
- freeze authority: retained.

Older design documents described one billion fixed KEEP with both authorities revoked. That remains a target-model discussion and is not current chain fact. The final mainnet supply, allocation, migration, and authority policy require a deliberate product and security decision.

The game mirrors custodial KEEP liabilities in an append-only double-entry ledger. Deposits verify finalized SPL transfers to the configured hot-wallet ATA. The public standard and instant withdrawal paths apply the configured unbonding, authentication, per-wallet limit, fee, idempotency, reserve, and kill-switch controls before settlement. Each request also includes a player-wallet signature over the selected Solana cluster and KEEP mint plus the exact gross amount, 2% fee, net amount, destination, idempotency key, mode, and unbonding period. The raw proof is stored with the escrow freeze; the worker independently checks the signature, session-at-submission, frozen network, immutable request fields, and exact two-entry ledger freeze before the hot wallet signs.

Immediately before signing, the worker also reserves the gross request amount against a worker-only rolling-24-hour allowance for that wallet. Under the source-supported isolated runtime roles, the API credential cannot read or write those reservations or invoke their reserve/finalize/release functions. This independently re-enforces a bounded per-wallet outflow, but it is not proof that the underlying API-authored gameplay balance was legitimately earned.

The database also carries a singleton economy identity binding its Solana cluster, KEEP mint, core program, and Config PDA. API and worker startup refuse any mismatch before gameplay or payout work begins. A nonempty legacy database can bind automatically only to the checked-in devnet identity; mainnet requires a fresh database or an explicit drained owner migration. This prevents devnet-earned balances from becoming mainnet liabilities merely by changing otherwise valid runtime configuration. The remaining multi-wallet signer risk is tracked as issue K-013.

The resulting Solana transaction is decoded and validated locally, then its signature, exact signed bytes, blockhash horizon, and transfer snapshot are committed before any broadcast. The same bytes are fanned out to every configured RPC provider and reconciled at `finalized`. Mainnet configuration requires a two-provider quorum for finalized success or error. Null history after blockhash expiry remains unresolved and non-refundable even when ordinary RPC providers agree, because finalized history may have been pruned; archival or operator evidence is required to resolve it. A single-RPC devnet configuration can accept that provider's finalized success or error, while ambiguous outcomes remain held for investigation.

## Proof of liabilities

The API builds a Merkle tree over custody balances and publishes an immutable epoch root plus total balance through `shardkeep-core::post_root`. The `/por` API exposes the latest root, per-user inclusion proofs, coverage, and structured custody evidence. There is not yet a player-facing proof screen.

Only the canonical Classic SPL KEEP associated-token account owned by the configured hot wallet qualifies as withdrawal-ready reserve. The reader verifies the token program, mint, authority, canonical address, account state, exact balance, and absence of a delegate at `finalized`; liquidity pools, unrelated treasuries, and encumbered token accounts are excluded. Mainnet configuration requires two independent economy RPC providers, and reserve evidence must agree across them before it can authorize payout.

An inclusion proof establishes that a published balance was included in a committed liability set. The live reserve check establishes only the observed liquid custody coverage at its recorded finalized slots. Neither claim by itself proves correct off-chain business logic or future reserve availability.

## What stays off-chain

- base layouts, structures, timers, progression, SHARDS, Mine and Forge state;
- armies, heroes, items, quests, trophies, clans, mail, chat, and moderation;
- raid snapshots, commands, simulation, settlement, and replay event archives;
- admission, authentication, rate limits, and anti-cheat decisions;
- custodial ledger accounting and operational jobs.

That boundary is intentional. The server validates these systems while Solana provides wallet authorization and public ownership/settlement anchors.

For the exact playtest reward budget, token flows, fees, prices, and upgrade curves, see [ECONOMY.md](ECONOMY.md). The distributor is not the gameplay emission pool and does not receive ordinary KEEP spending or deposits.

## Program assurance

The Anchor workspace has validator tests covering success and adversarial cases such as wrong signers, substituted treasuries, double entry, forged proofs, node-as-leaf proofs, paused payments, claim windows, and clawback constraints. Release overflow checks are enabled and account constraints use typed accounts, canonical PDAs, and checked arithmetic.

The programs have not received a third-party audit. Program changes require the checklist in [ARCHITECTURE.md](ARCHITECTURE.md), a dedicated security review, `anchor build`, and `anchor test`.
