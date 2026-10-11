# Analytics and error reporting

How product events and errors leave this system, under what identity, and how
to tell after a deploy that they still do. Written from the relay rework of
2026-09-05 (`lane/analytics-relay`), which followed the owner's complaint that
Sentry mail was noise ("most errors can be fixed because we are fixing game
and redeploying several times a day") and that no PostHog dashboard showed
anything.

## Posture

- **No vendor SDK in the client.** `posthog-js` / `@sentry/browser` are
  first-paint dependencies against the 1000 KB gzip wall
  (`apps/web/scripts/size-check.mjs`). The client is a ~200-line shim,
  `apps/web/src/lib/analytics.ts`, that batches to `POST /telemetry`.
- **The server relays.** `apps/api/src/telemetry.ts` forwards to PostHog
  (`/batch/`) and Sentry (legacy `/api/<project>/store/`). Both are optional:
  with `POSTHOG_API_KEY` / `SENTRY_DSN` unset every call is a validated no-op.
- **The authoritative record is Postgres + Solana.** Anything that must be
  TRUE (raid resolved, deed minted, login) is emitted server-side after its
  transaction commits. Client events are the "screen viewed" tier.
- **Fire-and-forget.** Nothing here throws, holds a request, or adds latency
  to an error path beyond building a payload. Vendor answers are read, not
  swallowed: `GET /health.relay` = `{ sent, rejected, failed }` in events since
  boot; a non-2xx logs one `[telemetry] <vendor> relay rejected batch { status, n }`
  per minute, never the key. The buffer is drained on `onClose`, so a deploy's
  SIGTERM does not lose the last 10 s.

## Event taxonomy

Tiers: **product** (client shim, `EVENTS` in `analytics.ts` — `track()` only
accepts these names, so a typo fails typecheck) · **authoritative** (server
commit points via `serverTrack`) · **reliability** (Sentry) · **system**
(PostHog built-ins the relay synthesises).

| Event | Tier | Props | Emit point | Funnel frame |
|---|---|---|---|---|
| `app_opened` | product | context only | `initAnalytics()` at boot | Acquisition |
| `$pageview` | system | `$current_url`, `$host`, `$pathname` (from `PLAY_URL`, else `WEB_ORIGIN[0]`), context | relay, once per `app_opened` | Acquisition (PostHog stock dashboards) |
| `phantom_mobile_connect` | product | `phase`, `manual`, `primed`, `live`, `reason` | `auth/mobilePhantomAdapter.ts` | Sign-in (also logged server-side, allowlisted fields) |
| `login_completed` | authoritative | `entryPaid` | `auth/routes.ts` after the session row | Sign-in |
| `auth_session_phase` | product | allowlisted `phase`, `reason`, `operation` only | auth coordinator, session discovery and game entry | Sign-in recovery (also sanitized server logs; no signatures, challenges, wallets or authorization tokens) |
| `$identify` | system | `$anon_distinct_id: anon:<deviceId>`, `$set.is_internal` | relay, once per (wallet, device) after `login_completed` | Sign-in — joins the anonymous funnel to the wallet |
| `land_reserve` | product | `kind`, `mode: globe\|random` | `ui/land/EntryScreen.tsx` | Land |
| `land_pay` | product | `kind` | EntryScreen PAY | Land |
| `land_credited` | product | `kind` | EntryScreen on server credit | Land (client-observed; the truth is `players.entryPaidAt` / `bases.landPaidAt`) |
| `land_failed` / `land_expired` | product | `kind` | `landFlowEvent()` shape transition | Land drop-off |
| `land_deed_minted` | authoritative | — (`event_id: deed:<asset>`) | `game/deed.ts` after the mint | Land |
| `tutorial_step` | product | `step` | `ui/tutorial/TutorialOverlay.tsx` | Onboarding |
| `tutorial_completed` | product | — | TutorialOverlay | Onboarding |
| `tutorial_guide_skipped` | product | `step` (template code) | `ui/tutorial/OnboardingGuide.tsx` | Onboarding drop-off |
| `raid_completed` | authoritative | `kind: pvp\|pve\|campaign`, `stars`, `victory`, `stage?` | `game/raids.ts` after settlement | Play |
| `exchange_opened` | product | — | `ui/screens/wallet.tsx` | Economy |
| `referral_link_shared` | product | — | `ui/screens/menu.tsx` | Growth |
| `referral_redeemed` | authoritative | `code_hash` (keyed HMAC, 8 hex — never the code) | `routes-alpha.ts` after admission | Growth |
| `tester_screen_opened` | product | — | `ui/screens/tester.tsx` | Tester program |
| `tester_milestones_announced` | product | `count`, `points` | `ui/testerDaily.ts` toast aggregate | Tester program (UI-observed; do not sum with the server rows) |
| `tester_milestone_earned` | authoritative | `key`, `points`, `source`; timestamp = `achievedAt` | `game/tester.ts` per inserted row | Tester program |
| `tester_daily_earned` | authoritative | `key`, `day`, `count`, `points` | `game/tester.ts` | Tester program |
| `tester_feedback_submitted` | authoritative | `category`, `basePoints` | `game/tester.ts` after insert (the only emitter — the client copy was removed) | Tester program |
| `tester_feedback_rated` | authoritative | `importance`, `status`, `bonus`, `fixed` | `game/tester.ts` | Tester program |
| `devnet_faucet_claim` / `_funded` / `_failed` | product | `error?` (60 chars) | `auth/useDevnetFaucet.ts` | Devnet onboarding (client view) |
| `devnet_faucet_requested` / `_granted` | authoritative | `lamports`, `recovered?` | `money/devnetFaucet.ts` | Devnet onboarding (truth) |
| `push_enabled` / `push_disabled` | product | `registered?` | `lib/pushSubscription.ts` | Retention |
| `notifications_permission` | product | `result` | `lib/mobileShell.ts` | Retention |
| `landscape_pref` | product | `on` | `lib/mobileShell.ts` | Mobile shell |
| `perf_summary` | product | frame/timing summary (bounded) | `lib/perfDiag.ts`, capped per session | Performance |
| `world_v2_fallback` | product | `reason` (coarse category + our own message, ≤ 120 chars) | `ui/fantasy/worldV2Support.ts`, once per reason per session | World v2 kill switch / CPU-globe fallback (D-186) |
| `totp_recovery_started` / `_holding` / `_cancelled` / `_completed` / `_expired` | authoritative | `recovery_id`, `cancelled_withdrawals?` | `auth/totpRecovery*.ts` | Account recovery |
| `app_error` | reliability | `message`, `source`, `name?`, `code?`, `boundary?`, `screen?`, `count` | window `error`, both React boundaries | → Sentry only |
| `app_unhandled_rejection` | reliability | `message`, `name?`, `code?`, `count` | window `unhandledrejection` | → Sentry only |
| `client_errors` | system | `count`, `gitSha` | relay, once per `/telemetry` batch that carried errors | Reliability trend in PostHog (deploy bursts stay one row) |

Every relayed event also carries `is_internal`, `network: 'devnet'`, and —
for client events — the client context (`sessionId`, `deviceId`,
`buildVersion`, `gitSha`, `simVersion`, `platform`, `solanaMobile`) plus
`source: 'client'`.

Adding a client event: add it to `EVENTS`, emit with `track(EVENTS.X, …)`,
add a row here. Adding a server event: `serverTrack` after the commit, pass an
`eventId` that is stable per fact (`raid:<id>`) so retries are visible as
duplicates, and add a row here. A name must never exist in both tiers with a
different meaning (the old `tester_milestones_earned` vs
`tester_milestone_earned` collision is why this table exists).

## Identity model

```
first load          sign-in                       after
anon:<deviceId>  →  $identify($anon_distinct_id)  →  <HMAC pseudonym>
```

- **`deviceId`** — random UUID the client persists in
  `localStorage['pkw:analytics-device']` (random per load if storage fails)
  and sends in the telemetry context and in the `/auth/verify` body. It
  identifies a browser profile, never a person; the server never stores it.
- **`sessionId`** — random per tab load. Fallback anonymous id only when a
  client sends no device id (old bundles).
- **Pseudonym** — `HMAC-SHA256('pkw-analytics:' + JWT_SECRET, wallet)[0:16]`.
  Stable per wallet, irreversible without the server secret. **Raw wallets
  never leave the API.**
- **`$identify`** — emitted once per (wallet, device) pair after
  `login_completed`, `distinct_id` = pseudonym, `$anon_distinct_id` =
  `anon:<deviceId>`. Idempotency is an in-memory set (one replica, K-020); a
  restart re-sends at most one per pair, which PostHog treats as a no-op.
  `$merge_dangerously` is never used — it can fuse two real players.
- Sentry `user.id` is the same pseudonym (or `anon:<deviceId>`), so a Sentry
  issue's affected users and a PostHog cohort line up.

## `is_internal`

`true` when the wallet is in `ALPHA_WALLETS` or `ADMIN_WALLETS`
(`isInternalWallet`). Set on every event's properties and, at `$identify`, on
the person via `$set`. Dashboards and insights should filter
`is_internal = false`; the public statistics page already does its own
labelled-row exclusion in SQL and does not read PostHog.

## Sentry conventions

Native Android reliability uses the same `app_error` event and `/telemetry`
envelope with exact `context.platform='android-native'`. It is a separate
binary release: `pkw-native@<native gitSha7>` (or `dev`/`unknown`), Sentry platform
`java`, logger `pkw-native`, source tag `android-native`, and dist
`VERSION_NAME:VERSION_CODE`. Browser Android retains the existing web contract.
The API reconstructs native context before either vendor relay: platform,
validated gitSha, bounded version/code and optional solanaMobile only. Native
session/device IDs and arbitrary context are discarded. The native client uses
an anonymous transport; if a valid server session is present, only its existing
HMAC pseudonym may reach the error relay.

Native reports use four fixed codes and server-reconstructed messages:
`NATIVE_UNCAUGHT` (stopped unexpectedly), `NATIVE_STARTUP` (startup failed),
`NATIVE_RENDER` (rendering failed), and `NATIVE_SCREEN` (screen action failed).
Unknown codes become `NATIVE_ERROR`. No raw exception message/name, source,
stack, file/line, User-Agent, wallet, cookie, token, signature or provider data
is forwarded. The error-count PostHog summary uses the same sanitized context
and no native session/device identity. Both vendor paths are covered by an
armed, mocked `/telemetry` regression. Existing web relays remain unchanged.

- **Releases**: `pkw-web@<gitSha7>` for client events — the sha of the bundle
  that threw, taken from the client context (`BUILD.gitSha`), NOT
  `buildVersion` (that only changes for Android shell releases) and NOT the
  API sha; `dist` = `buildVersion`. `pkw-api@<gitSha7>` for API and worker
  events (`BUILD.gitSha`, `dev` outside an image build). `environment` is
  `production` iff `NODE_ENV=production`, else `development`.
- **Loggers / tags**: `logger: pkw-client | pkw-api | pkw-worker`; client tags
  `source=web-client, kind=error|unhandledrejection, platform, solanaMobile,
  buildVersion, code?`; server tags `source=pkw-api|pkw-worker, route
  (pattern, never the URL), method, statusCode`.
- **Fingerprint** (client): `[kind, normalizedMessage, normalizedSource]`
  where normalisation strips Vite content hashes (`index-BQ3jK2sr.js` →
  `index.js`), line/column, asset URLs and long numbers. Server events use
  Sentry's default stack grouping (dist paths carry no hashes).
- **Client denylist** (`shouldReport` in `analytics.ts`): `Script error.` with
  no source, ResizeObserver loop, codes `NETWORK_UNAVAILABLE`, `MAINTENANCE`,
  `4001`, `AbortError`, `/user rejected|denied|cancell?ed/i`, chunk-load
  messages. These are deploy or user artefacts, not bugs.
- **Per-session dedupe**: first `(kind|message|source)` occurrence is sent
  with `count: 1`; repeats are counted and sent as ONE event per 15 s flush
  with `count: n` (`extra.count` in Sentry).
- **Chunk-load recovery**: `vite:preloadError` → `reloadToLatest()` once per
  60 s window (`lib/preloadError.ts`); no event, no Sentry.
- **Server relay budget**: 10 events/min token bucket (`relayServerError`).
  A crash loop spends its tokens and goes quiet until the bucket refills;
  the pino log still has every line.
- **Not covered**: source maps are not uploaded (web stacks are minified
  frames under a correct release); `process.on('uncaughtException')` is not
  hooked (see K-079).

## PostHog

- **Account setup verified 2026-09-05:** production's capture-token fingerprint
  matches US project **560475**, `Default project`. The pinned, non-public
  [Pixel Kingdom Wars — Onboarding & Battles dashboard](https://us.posthog.com/project/560475/dashboard/2068096)
  contains nine validated insights: daily active players, open/login and land
  funnels, intro-card completion/skip, raid modes/outcomes, client-error batches
  by build, affected players, and faucet stages. All use a 14-day window and
  `is_internal=false`, `network=devnet`; ordered player funnels allow seven days.
  API queries and the rendered Chrome charts passed; the starter dashboard remains.
  The owner's temporary personal API key was used only for account setup, never
  installed in production or committed, and its private local copy was removed.
- **Interpretation limits:** `tutorial_completed` is the introductory card deck,
  not the full claimed onboarding quest chain. Login funnels include returning
  players. Land funnels are per person, not purchase reconciliation;
  `land_credited` is client-observed server credit and mint is server-emitted.
  There is no raid-start event, so completed-raid charts cannot establish
  abandonment. `client_errors` counts batches and has no session identifier;
  affected-player counts are not crash-free-session rates.
- **Region: US cloud.** `POSTHOG_HOST` is unset in production, so the relay
  posts to `https://us.i.posthog.com/batch/`. The project must therefore live
  in the **US** PostHog organisation. A project created in the EU cloud
  answers 401 to every batch — visible as `/health.relay.rejected` climbing
  and the one-per-minute warn in the API log.
- **Verified 2026-09-05** by a probe from the production box with the
  configured key: `us.i.posthog.com` answered **200**, `eu.i.posthog.com`
  answered **401** — the project is US-hosted and the default host is right.
  The same probe posted to the Sentry DSN's store endpoint (DE region) and got
  **200**. Re-run both if either key is rotated.
- The relay sends a plain `api_key` + `batch` body; no `$lib`, no feature
  flags, no session replay.
- Stock dashboards work off `$pageview` (one per app open) and `$identify`;
  custom events appear under Activity → Events and in insights.

## Sentry account verification (2026-09-05)

Production routes to the DE-region project **4511919446687824**,
`pixelkingdomwars/javascript`. Its existing enabled
[high-priority email alert](https://pixelkingdomwars.sentry.io/monitors/alerts/763166/)
fires when Sentry marks a new or existing issue high priority, across all
environments, notifying suggested assignees with recently active members as
fallback. It recorded 36 triggers at inspection; this is not an email for every
repeated exception. Keep it enabled. No alert, subscription or auto-resolution
setting was changed, and unresolved issues were not bulk-resolved on deployment.

During `40fb4e0` observation, Sentry captured one iPhone Phantom React loading
error ([145135356](https://pixelkingdomwars.sentry.io/issues/145135356/)) and one
Windows Chrome `meta.json` boot failure
([145135386](https://pixelkingdomwars.sentry.io/issues/145135386/)). They are distinct
from clean infrastructure observation and the recorded browser smoke. See K-087
and the active handoff for evidence and disposition; neither was attributed to
QA merely from timing. Account setup added no vendor SDK, session recording,
public sharing or production environment change.

## Post-deploy canary

Run after every deploy that touches `telemetry.ts`, `analytics.ts`,
`/telemetry`, auth, or the workers. Every step is read-only.

1. `curl -s https://api.<host>/health | jq .relay` — `sent` climbs within a
   minute of real traffic; `rejected` and `failed` stay flat. `rejected > 0`
   growing = wrong key / wrong cloud; `failed > 0` growing = egress or vendor.
2. API log: no `[telemetry] … relay rejected batch` lines.
3. PostHog → Activity: `app_opened`, `$pageview`, `login_completed`,
   `$identify` arriving with `gitSha` = the deployed sha; one
   `client_errors` row at most per batch, never `app_error`.
4. Sentry → Issues: new events under release `pkw-web@<sha7>` /
   `pkw-api@<sha7>` for the deployed sha only. Old-release events from stale
   phones must stay under their old release, not reopen resolved issues.
5. Open the game in a stale tab from before the deploy, navigate to a lazy
   screen: it reloads to the new bundle without a Sentry event.
6. `curl -s https://api.<host>/version` — `gitSha` matches what step 4 shows.

## Owner-side configuration (not in this repository)

- **Sentry**: set the project's release semantics to resolve-in-next-release
  and an alert rule that fires on *new issues* / *regressions* per release
  rather than every event; confirm the DSN in `infra/.env.prod` belongs to a
  project whose platform is JavaScript (the store endpoint accepts both
  `javascript` and `node` payloads).
- **PostHog**: sign in to the US cloud organisation that owns the project key
  in `POSTHOG_API_KEY`; if the key belongs to an EU project, either move the
  project or set `POSTHOG_HOST=https://eu.i.posthog.com`. A personal API key
  is only needed for dashboard automation (none exists in the repo).
