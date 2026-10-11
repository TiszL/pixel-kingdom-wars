# Research FINISH recovery foundation

This directory has no live UI caller yet. It implements operation-specific
original-command storage, explicit review/retry, browser transport and current
account hydration for research FINISH. It follows the reviewed Hero progression
journal conventions without coupling either operation's history or lifecycle.

New reviews require `researchConsent.version=1`,
`researchSpeedupReceipts.version=1`, independent exact-game-currency capability,
current owned active base mutation support, and the server's per-row `finishQuote`.
The quote contains `currentLevel`, `toLevel`, `finishesAt`, `episodeId` and
`maxCostKeep`; every episode term must agree with the army row and `levels[troop]`.
Missing or invalid quotes fail closed. The browser never uses its own clock or a
copied cost formula to price a paid research command. The additive API quote is root-owned integration work, now added to the
current working tree; absence still intentionally blocks this inactive client.

A new command freezes origin/API/cluster/wallet, original base, troop, exact debit
research episode, original current/target levels, deadline, maximum price, key and
one whole affordable currency. It chooses supported Gems when sufficient, otherwise
whole custodial KEEP, without pooling balances. Retries preserve every term and
require another explicit review; a lower server price may fit the original ceiling
but never changes currency or creates a replacement episode or key.

The compatible POST body contains complete consent, with currency carried only by
the request-local exact header. Attempt persistence commits before dispatch. GET
proof must match the complete original command, original wallet and actual funding;
POST acknowledgements, current research levels and local countdowns are not proof.
Reload/foreground entry is GET-only, including after base loss or feature pauses.
An unsupported route cannot start a command. Accepted preflight proof is saved
atomically with its original draft so a later missing receipt cannot erase it.

Only first-dispatch typed no-debit errors may be saved as refusal: research
consent/price/currency failures, first409 TROOP_ROSTER_INACTIVE, and the existing exact status/code base-authority
matrix. Currency failure must name the original currency. Receipt-invalid collision,
generic400/409/503, auth/network failures, later retry failures and GET errors all
remain uncertain. Original refusal CAS evidence is persisted before rejecting stale
presentation, because the global authority handler may already have navigated away.
A postRaw-only parsed-error observer saves original first-attempt CAS evidence
before late response session/base/navigation/abort rejection. Its already-dispatched
transport drains before the caller can close original storage; actual dispatch
and fetch abort guards remain unchanged. Network/invalid JSON/GET do not invent
refusal evidence. No refusal can replace earlier acceptance or erase an earlier
possible attempt.

Actual request dispatch rechecks session revision/generation, original base and
selection generation, navigation/lifecycle epoch, visibility and the synchronous
update/maintenance latch. The latch and new-action controls do not gate original
receipt reads. Tabs coordinate using Web Locks plus IndexedDB strict-durability CAS.
Accepted/refused/unattempted archives are immutable and permanently reserve keys.

Current research/base/balances are a separate ownership-bracketed refresh. It uses
the normal base commit ordering and refuses changed account/base/ownership, a newer
refresh, or inconsistent held-troop levels. Receipt results never populate current
army or balances. `ResearchMoneyArmy` is deliberately a narrow payment read model;
do not cast it to the complete army UI DTO.

Remaining integration: verify the root-owned API quote together with this client;
a lifecycle hook/provider
that serializes current hydration, invalidates review on navigation/pause, coalesces
foreground reads and drains pending writes before storage close; an explicit actual-
currency research confirmation and saved-command recovery entry; ordinary full
web/type/lint/build/security gates and browser/paired-API journeys. Existing research
UI still uses its previous direct command path until that integration is reviewed.
