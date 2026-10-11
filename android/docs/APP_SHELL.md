# Native app shell — target architecture (M-A0 step 4)

Replaces the `MainActivity` section switch and the 766-line `GameModel`. Everything below
the shell (renderer, network transport, content store, wallet) is kept as documented in
`ANDROID_FIRST_PLAN.md` §3.

## Layers

```
ui/            Compose screens + per-screen ViewModels (UiState data classes)
scene/         SceneHost: one KingdomFragment per content generation; Base/Battle scene mappers
data/          Repositories (typed models, StateFlow, suspend mutations)
ops/           MoneyOp: PendingIntentStore<Body,Receipt> + ReceiptObserver (generic)
session/       AccountSession + AccountScope (CoroutineScope cancelled on identity change)
network/ …     unchanged modules: GameApi, SessionCookieJar, EncryptedStore, battle transport
```

Dependency wiring is a hand-written `AppGraph` created in `PkwApplication` (no Hilt; keeps
the build simple and fast). ViewModels receive repositories through a factory.

## Session and cancellation

- `AccountSessionHolder: StateFlow<AccountSession?>` — identity = wallet + origin + cookie
  generation. Sign-in, TOTP completion, logout and session supersession replace the value.
- `AccountScope` — a `SupervisorJob` scope created per `AccountSession`; **cancelled and
  recreated whenever identity changes**. Repositories launch polling and receipt observation
  in it. This replaces `accountGeneration`, `battleScope` and the per-await `guard()` lambdas.
- Publish rule: a repository publishes a result only if `holder.value === capturedSession`;
  otherwise the result is dropped (the scope is already cancelled in practice).

## Repositories (typed, one per domain)

| Repository | Owns | Endpoints (main) |
|---|---|---|
| `AccountRepository` | `/me`, bases list, active base selection, 2FA status, playtest access, capabilities/version | `/me`, `/bases`, `/bases/:id/activate`, `/2fa/status`, `/playtest/access`, `/version`, `/native/capabilities` |
| `BaseRepository` | base snapshot, balances, jobs, quests, mine status, tutorial | `/base`, `/balances`, `/base/buildings*`, `/base/jobs/*`, `/base/walls/*`, `/base/layouts*`, `/base/obstacles/*`, `/mine/*`, `/quests`, `/tutorial` |
| `ArmyRepository` | army state, quote/consent, presets, research, heroes, items | `/army*`, `/heroes*`, `/items*` |
| `BattleRepository` | campaign, pending/live raids, presentation transport, replays, history, raid-events SSE | `/campaign*`, `/raids*`, `/bases/:id/raid-events`, `/battles/*` |
| `WorldRepository` | fantasy globe, parcels, search, scout, warzone | `/globe/fantasy*`, `/map/scout/:wallet` |
| `EconomyRepository` | wallet balances, deposits, withdrawals, forge, market, shop | `/wallet/*`, `/deposits*`, `/withdrawals*`, `/forge*`, `/market*`, `/items/buy` |
| `CommunityRepository` | clans, chat, mail, leagues, playtest campaigns, feedback, referrals | `/clans*`, `/chat/*`, `/mail/*`, `/leagues*`, `/playtest/*`, `/tester/*`, `/referrals/*` |
| `ContentRepository` | generations, activation guard, update checks | content store |

Models are `@Serializable` data classes with `ignoreUnknownKeys = true`; every money value is a
decimal `String` (or `BigDecimal` at the edge) — never `Double`. Generated DTO validation stays
for auth and base; other routes decode straight into typed models. Repositories expose
`StateFlow<T>` snapshots plus `suspend fun refresh()`; polling cadences come from the constants
catalogue (`WORLD.mapPollSec`, mine 15 s, `/version` 120 s), never hardcoded.

## Money operations (one mechanism)

```kotlin
class MoneyOp<Body, Receipt>(kind, store: PendingIntentStore, post, receiptGet, decode, hydrate)
```
1. Generate `idempotencyKey`; persist `{wallet, baseId, body, quote, label}` **before** POST.
2. POST exactly once. Definitive 4xx on a first attempt clears the intent; 5xx / IO keeps it.
3. Recovery is GET-only through the operation's receipt route; decoded to
   `Unknown | Accepted | Closed | Unsupported`.
4. `Accepted` is applied only after re-hydrating the domain snapshot with the same session.
5. `clearIfMatching(wallet, body)` retires only the exact saved intent.
6. A saved `Unknown` blocks new intents of the same kind and shows the shared
   "Interrupted request" banner with Retry-check / Close.
7. `resolveRejection(intent, error)`: a definitive rejection that carries the server's own
   resolution of this exact intent (a 409 naming the reservation it already holds for the
   wallet) is persisted as the receipt, hydrated and only then retired, exactly like an
   acceptance. Never used to swallow a refusal that leaves the outcome unknown.
8. `disprovesAcceptance(error)`: a coded refusal the server raises before any write on every
   attempt (disabled feature, required update) proves the intent was never accepted, so it is
   cleared even on a retry. Never true for a status that can follow a commit.
9. `forgetsServerUnknownOnClose(intent)` (owner 2026-10-06, Seeker: a saved "Build goldforge" the server
   never recorded blocked every BUILD): where the server has no closure route, the player's explicit CLOSE
   re-reads the key-scoped receipt route once and, only if it answers `unknown` for exactly that key,
   retires the exact saved record on this device. No POST; an acceptance found by that read is hydrated;
   a request with no receipt route (Unsupported) is never forgotten. Opted in: construction (placement +
   builder finish), hero recruitment v1, wall batch v1. The residual risk is an original POST the server
   commits after that read; its effect is a visible building/altar/wall plus its server-side receipt.

Used by: construction (+receipt), training batch (+receipt/close), training cancel (+receipt),
research (state-advanced heuristic until a receipt route exists), speedups, land checkout,
deposits, withdrawals, market, shop. Each operation supplies only its decoder and hydrate.

Recovery rules of the M-A3 operations (production has no matching receipt routes):
- **Hero upgrade/recovery:** only a saved successful POST acknowledgement is proof. A roster
  level, natural recovery expiry, or later injury cannot identify the saved key. Missing replies
  remain Unsupported and block a fresh operation; explicit hero retries are hidden because a
  never-committed original could buy the next level or recover a new episode. Production needs
  additive key receipt routes and expected-level/episode + maximum KEEP consent before this
  uncertainty path meets parity acceptance. Cached-row checks are not server-enforced consent;
  concurrent web actions can change the price/episode between display and POST.
- **Item buy:** retry reuses the key; inventory reads cannot prove a purchase. Retry 404/422
  leaves it unresolved because acquisition/base gates run before ledger duplicate lookup.
  Definitive first-attempt refusals still retire the intent through MoneyOp.
- **Item use:** no observation; explicit same-key retry. The uncoded `409 duplicate use request`
  proves this key's transaction committed; hydrate before retiring. Replay 404/422 and coded
  409 remain unresolved because current base/item gates run before duplicate lookup.
- **Research:** retains its pre-existing state-advanced heuristic.
- Army/roster/inventory reads validate selected base as well as session before publication;
  roster and bag orders refuse snapshots loaded for a different selected base. Saved receipt
  observation and direct purchase acknowledgements must hydrate the original intent base;
  selecting another base never retires its proof against an unrelated snapshot.

## Navigation

Navigation Compose with type-safe routes:

```
Boot → Title → Totp → LandGate → Home
Home (scaffold: HUD bar, queue band, task rail, bottom nav Kingdom | Army | Attack | World | More)
  sheets: BuildingActions, BuildTray, TrainTray, ResearchTray, HeroTray, Inventory, WallRowUpgrade,
          LayoutEditor, Quests, DailyCache, Funds, Mine
  full-screen: Battle, Replay, Scout, Campaign, RaidChooser, Results
  More: Wallet, Forge, Market, Shop, Economy, Clans, Chat, Mail, Leagues, Playtest, Feedback,
        Account/Security, Bases, Help/Codex/Legal, Settings
Gates (outside the graph, driven by ApiRouting): Update (426), Maintenance (503), AlphaGate (403)
```

Android Back uses a priority registry mirroring the web (`MobileBackConfirm` 1000, sheets 220,
layout editor 160, battle 140, scout 120, globe list 110, globe layers 100; Home = double-back
exit). Deep links `?screen=raidlog|mail|base|bases` and `?ref=` are held until Home hydrates and
never applied over Battle/Scout.

## Global API routing

One interceptor maps responses to navigation: `401` → Title (session cleared), `402
LAND_NOT_OWNED` → LandGate, `403 ALPHA_GATED` → gate, `426` (`WORLD_UPDATE_REQUIRED`,
`BASE_CLIENT_UPGRADE_REQUIRED`, sim mismatch, `minimumNativeBuild`) → Update gate, `503
MAINTENANCE` → Maintenance. `INSUFFICIENT_KEEP|SHARDS|SOL` → Funds sheet.

## Scene hosting

`SceneHost` keeps **one** `KingdomFragment` per content generation across Home, Battle and
Replay; screens hand it a `BaseScene` or `BattleScene`. The teardown ordering and the
activation guard stay; the guard reads `BattleRepository` state (no replay, no visible battle,
no pending/creating battle) instead of the old state blob.

## Theme

Pixel chrome shared with the web: same palette, 9-patch panels from the brand pack, bitmap
font for HUD numerals, gold primary. All copy in a `Copy` object (English), no i18n layer yet.

## Tests

- ViewModel tests with fake repositories (state transitions, error routing, consent flow).
- Repository tests with OkHttp `MockWebServer` (typed decoding, no-retry, session publish rule).
- `MoneyOp` tests: persist-before-POST, definitive-4xx clear, 5xx keep, receipt decode,
  hydrate-before-publish, clearIfMatching, Unknown blocks new intents.
- Compose UI tests for Title → Home and the training consent sheet (later).

## Integrated PvP and base selection

Raid creation keeps TRY AGAIN bound to its saved target, while a verdict's NEXT RAID
starts a fresh automatic PvP match exactly as production `RaidUI.replayAgain` does.
NEXT TARGET retains its separate retreat-then-exclude contract. Campaign continuation
advances its stage. Home recovery is keyed to the currently hydrated selected deed;
late history, scout and recovery replies cannot publish into another deed selection.
Deed and prior-participant history keep their original replay authorization routes.

Selected-deed raid SSE falls back to canonical polling; unknown lock state disables
mutation affordances and a known lock offers watch/history/switch exits. BASE's moved
building/wall/obstacle surfaces and layout save/unlock use the same interlock; drafts
survive uncertainty. Base and Army/Hero KEEP confirmations share one DevicePreferences
store, and retained Home reads its latest preference when a spend is tapped.
