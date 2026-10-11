# Paid builder-job FINISH recovery core

Inactive foundation only: no hook, provider, dialog or existing FINISH control imports this module. Initial construction and the current free-finish path are untouched.

`BuilderJobSpeedupJournalStore` follows the Training/Research IndexedDB design: a strict record per canonical page origin, API URL, cluster and wallet, with permanent original-key reservation in append-only archives. CAS revisions advance for every attempt, even the identical explicit retry, so a late first response cannot overwrite a newer attempt. Per-identity Web Locks serialize tab actions. Storage, lock and schema failures refuse payment.

The browser reads authenticated `/me`, owned `/bases`, selected `/base` and `/balances`, then brackets identity/ownership again. New review requires an explicit active owned base, base-scoped mutation capability, `features.builderJobSpeedup {version:1,receipts:1}`, and exact game-currency support. A paid row must be upgrade, repair or clear_obstacle, with a strict server quote matching the row's kind, target, original start/deadline and positive price. Free `build`, zero price, absent/ambiguous quote or mismatched DTO cannot become paid permission. No client-clock pricing exists.

Only whole Gems when sufficient, otherwise whole custodial KEEP, can be selected. The chosen currency and full original consent are saved. Later validation accepts an identical episode and lower server price only; it never changes the target, deadline, maximum, body, key or currency. Missing, canceled, naturally completed and replaced jobs require receipt recovery, not inferred acceptance.

`begin` probes the versioned receipt endpoint before saving, atomically retaining any matching accepted preflight evidence. `confirm` requires ephemeral approval, repeats original GET proof and fresh authority/quote/balance validation, saves the attempted marker, then sends one request-local exact-currency POST to the original job URL. Only an authenticated matching GET receipt can prove acceptance. POST acknowledgements, current job disappearance and current balances cannot.

`open` is GET-only. Explicit `reviewCommand` plus `confirm` is the sole retry, preserving the exact saved command. Typed refusals in journal.ts are first-dispatch candidates only; browser classification requires exact status/code, and currency refusal requires matching expected-currency details. K161 `api.postRaw` invokes the original CAS observer before stale-session/navigation rejection and drains it before settling. Later retry errors, GET failures, generic4xx, collision errors, malformed bodies and network failure remain uncertain. A proven refused command can archive after matching unknown GET; a never-attempted draft can explicitly abandon the same way. An ambiguous attempted command cannot be discarded.

Future integration must:

- Maintain one wallet owner and serialize action/current-read publication. Bind real session, visibility/navigation epoch, base selection generation and mutation allowance. Call `dismiss()` on back/background/base/gate changes; this clears review only.
- On unmount call `dispose()`, await its returned drain, then close the captured original store. New actions on a disposed controller cannot dispatch. Never close IndexedDB while a returned original response is still parsing/persisting evidence.
- Keep saved recovery/history reachable under payment pause or missing original base. Do not automatically POST, replace keys, or use a new selected base to hydrate the old receipt.
- Use `refreshBuilderJobSpeedupSnapshot` for independently fetched current base/balances. Its atomic latest-read/selection-epoch guard prevents old HUD publication; any hook-local state returned from it still needs a captured hook request/payment revision before publication.
- Display original base/job/kind/target/timer, maximum and exact currency explicitly. Keep initial construction's free path separate. Receipt completion is historical, never a HUD patch.

Tests live beside the hook. Full types/build/paired browser acceptance and UI lifecycle integration remain separate gates.
