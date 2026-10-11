# Known limitations

This page summarizes the current alpha boundaries.

## Network, token, and programs

- **Devnet alpha only.** Player payments use devnet SOL and the current KEEP token is a devnet asset without represented monetary value.
- **Current devnet KEEP supply.** The live mint has 500 million KEEP with mint and freeze authority retained. Mainnet supply, allocation, authority revocation, and migration policy are unresolved.
- **The distributor is inactive.** Its binary and authority-gated initializer are deployed, but the current-mint Distributor PDA does not exist and there are no production calls or funds. Any future initialization and funding still require a reviewed ceremony and external audit.
- **Mainnet state does not exist.** The repository has no reviewed mainnet address registry and no deployed mainnet game program, KEEP mint, deed collection, Config, or related PDA state.
- **No third-party audit.** Program and custody code has internal review and adversarial tests only.
- **Mainnet custody still requires external review.** Wallet-signed withdrawal intents, non-owner database roles, durable payout bytes and a database-blind policy signer are implemented. The signer enforces exact-transfer, per-wallet and aggregate rolling ceilings from its journal. This remains software with file-backed keys, not an HSM or enclave; provisioning, approved limits and independent review are separate mainnet requirements.
- **Devnet balances do not automatically migrate to mainnet.** Withdrawal proofs and a singleton database identity bind cluster, KEEP mint, core program, and Config PDA. A nonempty legacy database can bind automatically only to the known devnet registry. Mainnet therefore needs a reviewed fresh-ledger or explicit drained migration ceremony rather than a runtime network switch.
- **Reserve proof is a point-in-time custody check.** Only the validated canonical, unencumbered hot-wallet KEEP ATA qualifies; mainnet requires matching finalized evidence from two independent RPC providers. This does not prove future solvency or correctness of all off-chain business logic.
- **Anchor tests are not in GitHub CI.** They are a separate mandatory local/release gate.

## Product availability

- **Open devnet playtest.** Anyone can sign in and start onboarding without an application, invite code or Seeker verification. Wallet/session security, admin authorization and gameplay/deed requirements still apply; referral codes are optional.
- **Android delivery has separate tracks.** The web application is delivered through a signed Trusted Web Activity. Native Android development is separate; web release verification does not certify the native client.
- **Physical-device certification remains incomplete.** Wallet handoff, long-session thermal/frame-rate behavior, and the full 30/60 FPS target matrix still need representative devices.
- **Clans are not a playable alpha feature.** Data preservation and backend foundations exist; the UI correctly says coming soon.
- **KEEP vending is unavailable.** The buy-KEEP-with-SOL route fails closed while reserve funding and product policy are prepared. No fiat on-ramp is shipped.

## Gameplay and presentation

- **Expeditions and reserved land are not claimable features.** The globe includes 32 non-owned islands with locked dispatch. Genesis Sanctuary and Seeker allocations are reserved; awards, claims and resource harvesting are not implemented.
- **Mobile presentation remains under validation.** Initial viewport recovery, artwork loading and close-zoom globe interaction have targeted regressions; desktop responsive checks do not certify every native browser toolbar or physical device.
- **Alpha balance is still being tuned.** Mid-progression campaign balance and several economy/drop curves remain under active evaluation.
- **Some special combat verbs lack full rich event/presentation coverage.** Compact deterministic behavior is preserved, but not every authored ability has its final animation/audio representation.
- **Wyrmling directional art is deferred.** Its simulation behavior exists; presentation uses the bounded fallback contract.
- **Replay sharing links are deferred.** Participant history and replay playback exist inside the product.
- **Proof inclusion lacks a player screen.** The API can return the latest liabilities root and an inclusion proof, but a user currently needs support to obtain it.

## Operations and privacy

- **Manual recovery drills do not replace managed backup operations.** Release backups are copied off-host and restored into isolated scratch databases with ledger and signer checks. A separately provisioned service with immutable retention, scheduling and alerts remains a mainnet requirement.
- **Analytics has no in-app opt-out toggle.** Current legal copy discloses the behavior and support can handle deletion requests; a self-service preference is still missing.
- **Some cache invalidation is process-local.** Multi-process behavior relies on bounded refresh rather than a shared invalidation bus for one presentation cache.

## Assets and licensing

- **Project licensing is not published.** No root licence currently grants redistribution rights.
- **Third-party notices/provenance are incomplete as a public package.** Original art sources and approved generated SFX are tracked through the asset pipeline, but consolidated notices are still being prepared.
- **Music commercial-use evidence is not fully archived.** The tracks have owner provenance, but the supporting commercial-use record must be complete before commercial/mainnet distribution.
- **Runtime media is generated output.** Atlases, approved audio, and brand files are committed as generated output; the original art masters and the pipeline that produces them are not part of this repository.

## Scope statement

These entries distinguish current behavior from future work and do not promise delivery dates. Security-sensitive details should be reported privately under [../SECURITY.md](../SECURITY.md).
