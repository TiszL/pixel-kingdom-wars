# Gems web ledger client — M41 B5

Implemented, inactive until server capabilities enable it, September 21, 2026.
The existing exchange route now opens the Gems wallet for supported balance
capabilities. The HUD uses the server Gems amount and admitted native 24px chip;
the wallet uses the native 32px chip. Legacy/unknown capabilities retain KEEP.
This is the ledger conversion/task vertical slice, not the entire B5 milestone.

The authority is `docs/phase-e/E2-GEMS-CONTRACT.md` and the actual receipt
implementations in `apps/api/src/game/{routes,gems,gemsGrants}.ts`. All quantities,
source availability, rates, bounds and task rewards come from server responses.
Optional balance fields tolerate older payloads; absent or unsupported features
disable new Gems operations. No shared request header is changed.

## Durable operation contract

`useGemsRecovery` creates a journal/controller for the exact API origin, wallet
and network. Cookie generation, active lifecycle and selected-base epochs fence
new operations. Hidden/unmounted views cancel approval. Foreground/online recovery
is GET-only. IndexedDB strict writes and CAS retain exact consent before POST;
Web Locks coordinate tabs. Missing locks, malformed records and storage failure
fail closed. POST uses `api.postRaw` with the exact persisted body and admission
guard. Wallet token balances are never substituted for custodial KEEP.

`review` requires `features.gems.exactConsent: 1` and freezes the actual input,
reviewed rate and output (task rewards use a null rate). The confirmation renders
that immutable saved output. `confirm` and explicit retry compare fresh server
terms with the original consent and send it as `expected: { rate, output }`.
The server checks those terms atomically with a new debit; a final client GET
alone cannot prevent a rolling-version race. See `docs/phase-e/GEMS-LEDGER-CONSENT.md`.
`confirm` persists the original key/amount/base/task/consent and then the attempted marker
before one POST. Neither the POST response nor a changed balance proves success.
The matching authenticated GET receipt must bind wallet/key/body/base/task,
funding, receipt ID/time, original expected terms and historical arithmetic. Receipt proof is saved before
hydration, and terminal success follows hydration. Browser tests exercise original
base A while B is selected; fresh `/bases` authority requires explicit owned base
scope in multi-base mode before a Gems→SHARDS request.

Hydration rechecks `/me` and `/bases` around the original `/balances` read and uses
the existing base snapshot commit guard. A transferred/unavailable historical base
is not replaced with the current base. Its historical receipt can finish without
publishing a base balance; UI labels it as the **original receipt**, while displayed
custodial KEEP is explicitly **last loaded**. The current journal stores hydration
completion as a boolean, not an availability reason. It must not be used later to
claim that an unavailable original base's current stock was refreshed.

A server pause does not hide recovery: legacy wallets expose a local-evidence
recovery door when this browser has a saved Gems request (or cannot read its
storage). Hydration does not depend on gated `/gems` and accepts a legacy balance
without a Gems field. After receipt/hydration persistence, catalogue refresh may
still report the pause; the accepted receipt remains complete and new actions
remain disabled.

Unknown receipts, auth outages and ambiguous sends retain the operation. Explicit
**RETRY SAME REQUEST** first observes its receipt, then revalidates current support
and resends only the original key/body. There is no automatic POST, local discard,
or new key for an unresolved operation. Unfamiliar/uncoded rejections remain
pending. Older journals without exact consent remain GET-only; they cannot acquire
today's terms and resend. Old servers can still provide historical receipt recovery
but cannot admit a new guarded conversion. An unavailable task or unsupported route can remain unresolved because
the backend has no general terminal closure receipt.

Only a definitively rejected **first POST** may finish without acceptance proof:
`TASK_UNKNOWN` 404 / `CLAIM_ALREADY_SETTLED` 409 for task claims;
`GEMS_PURCHASE_BELOW_MINIMUM` / `GEMS_PURCHASE_ABOVE_MAXIMUM` /
`INSUFFICIENT_KEEP` 422 for ledger conversion; `INSUFFICIENT_GEMS` 422 or
`BASE_NOT_OWNED` 404 for SHARDS conversion; `GEMS_TERMS_CHANGED` 409 for any of the
three actions. The refusal is bound to and retained with original consent; a later
new request archives that refusal. The exact status/code/kind allowlist excludes
`IDEMPOTENCY_BODY_MISMATCH`. A retry rejection or receipt/hydration error cannot
close an earlier ambiguous attempt. Security re-review accepted this narrow rule.

The pure `gemsSpendFunding` helper models Gems-first, then the **whole** KEEP price;
it never adds insufficient balances together. It is not yet wired into paid sinks.
New confirmations require the separately negotiated exact-currency constraint
chosen in D-153/K-155, because a balance snapshot cannot authorize a later switch
of currency. That backend/client integration is still pending. Historical receipt
funding remains authoritative. Existing KEEP sinks do not opt into Gems here.

## Verification and remaining work

Focused command:

```sh
pnpm --filter @shardkeep/web exec vitest run src/lib/gems src/ui/screens/gems.test.tsx src/ui/screens/menu.walletNavigation.test.tsx src/ui/layout.test.ts
pnpm --filter @shardkeep/web typecheck
```

The parent established the original 4,487-test web baseline. An early accidental
full run passed 4,508 tests / 315 files after the first 21 new cases; that run does
not cover the later source changes. Final focused verification passed **279 tests / 7 files** (40 Gems foundation,
7 Gems UI, 11 wallet navigation, 221 layout; zero failures/skips). The expanded suite covers receipt/currency proof,
persistence failures, restart, first-refusal vs ambiguous retry, old payloads,
account/network/API/base fencing, pause recovery, same-key retry, actual-currency
confirmation/cancel, unchanged legacy navigation and the native icon HUD budget.
Targeted ESLint, web typecheck and whitespace checks pass. K157 follow-up focused
checks pass **65/5**, and the full web suite passes **4,555/318**, zero skips. Added
coverage binds frozen terms across review/restart/retry, negotiates atomic server
support, forbids consent mutation, proves receipt output and preserves ambiguous
requests after a later terms refusal. The prior full checkpoint was4,539/318.

Visual inspection used a local read-only fixture in ignored
`apps/web/.reports/gems-preview.{html,tsx}` at port 5184. It supplies dummy account
and API read responses; POST always throws before any network call. Native Chrome
via CUA showed the wallet, native icon, scrolling panel, and 10 KEEP review with
explicit output, visible confirm/cancel, and review-region keyboard focus. This
is component visual evidence, not live authenticated local/QA end-to-end evidence.
The K157 fixture rerun in the in-app browser showed the frozen10 KEEP→10 Gems
confirmation and then a changed-rate refusal with no POST. Focus moved to the
review region and both confirm/cancel controls remained readable in the342px panel.

Remaining: paid-sink actual-currency confirmations and per-request negotiation;
durable wallet KEEP→Gems token-transfer journal/UI; Workshop start/collect UI;
other Phase E web surfaces; full build/size and authenticated local/QA acceptance.
No wallet transfer source is advertised in this slice even if the backend source
exists. No deployment, activation, wallet signing, release change or realm/base
art edits occurred. Parent owns the admitted currency asset pipeline/provenance.
