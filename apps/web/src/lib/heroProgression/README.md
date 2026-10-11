# Hero progression recovery

The Hero roster and altar recovery now use one persistent, lazily mounted
provider. It covers Hero upgrades and paid recovery with the already-advertised
`heroConsent`, `heroReceipts` and independent exact-game-currency capabilities.

A new command reads current authenticated ownership, original-base roster and
balances before choosing one whole currency: Gems when enabled and sufficient,
otherwise custodial KEEP. It never pools balances. The journal freezes the original
wallet/origin/API/chain, Hero, base, level or injury episode, maximum price and
actual currency. The compatible server body retains `maxCostKeep`; currency travels
only in the request-local `x-pkw-expected-currency` header.

Confirmation reads original GET proof before dispatch, validates the original
terms without switching currency, and persists the attempt before POST. A POST
acknowledgement cannot prove payment. Original GET evidence must match the actual
funding currency and all original terms. Reload/foreground recovery is GET-only;
retry requires a new explicit review of the same key and consent. An accepted
preflight receipt is saved atomically with its command rather than discarded while
waiting for a second read.

Only the exact typed first-POST refusal matrix in `journal.ts` is terminal evidence.
It includes transaction-atomic Hero consent/price/currency refusals, kind-specific
natural-expiry/removed-altar codes, and verified precommand base-authority failures.
The adapter checks the original currency in a currency-refusal response. Later retry
refusals and subsequent GET/hydration errors cannot disprove an earlier ambiguous
request. Original refusal evidence is persisted under the original CAS revision
before presentation guards: a global authority handler may already have navigated
away. The POST's actual-fetch guard is not relaxed.

Explicit archival preserves accepted/refused history or a never-attempted draft
with a fresh matching unknown receipt. Historical keys are permanently reserved.
Current roster/base/balances come from separate fresh, ownership-bracketed reads and
share the normal base refresh ordering. A receipt's amount or result is never used
as live stock. Original receipt access does not depend on today's selected base or
whether new paid actions are admitted.

Every payment opens an explicit actual-currency dialog, regardless of the legacy
KEEP confirmation preference. Cancel/back/Escape closes ephemeral review while
preserving the original draft. The saved-payment door remains available on
base/build/bases/inventory when new payments are paused or the producing base is
no longer owned. A request-local mutation guard includes the one-way global
update/maintenance latch. Receipt GETs remain available. Screen, altar, build-tab,
base generation and page lifecycle changes invalidate approval. Unmount drains
pending actions and evidence writes before closing the journal.

The visual roster retains a separately guarded read-only full `/heroes` fetch;
the narrow browser `HeroMoneyRoster` is not cast to display stats. Obsolete rows
are hidden during payment/refresh and reloaded after authoritative refresh. No
receipt result is merged into current combat stats or recovery state.

Verification checkpoint: core/browser/API independently reviewed SHIP; gate and
hook foundation reviewed by root. Visible integration focused gate passes
160 tests / 15 files, zero skips, with targeted ESLint. Final UI security review,
full-web/build and mobile/browser acceptance remain root-owned gates. No feature
flags were changed and no deployment is implied.
