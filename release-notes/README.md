# Release notes

These fragments are the public changelog at **pixelkingdomwars.com/changelog** (and its
Atom feed). Players read them. Write every one as if a player will quote it back to us.

**Every player-visible change ships a fragment** in the same pull request
A change nobody can see or feel (refactor, tests, docs,
deploy tooling) ships none.

## How a note reaches players

1. You commit `release-notes/unreleased/YYYY-MM-DD-<slug>.md` with the change.
2. CI lints it: `pnpm --filter @shardkeep/scripts run release-notes:lint`.
3. The ordinary production deploy (`infra/deploy.sh`), **after** the release is publicly
   verified, collects every fragment present at the deployed commit and records them
   in the append-only `release_history` table. The website reads them from
   `GET /api/public/releases`. No website publish is needed.
4. A fragment is published **once**, by the first deploy that carries it. Leave it in
   `unreleased/`; later deploys skip it automatically.
5. A deploy that carries no new fragment still appears on the changelog, as a single
   "Stability and maintenance" line, and the deploy log prints a loud WARNING. That is
   correct for a pure infrastructure deploy and a missed note for anything else.

A fragment whose `requires:` flag is not exactly `true` in production waits: it is
listed in the deploy output and published by the first deploy after the flag is on.
Only flags written in `infra/.env.prod` count; a compose default never does.

**Published notes are permanent.** The history table is append-only, so editing a
fragment after its deploy changes nothing on the site. Correct a published mistake with
a new fragment (usually `category: fixed`).

## File layout

| Folder | File name | Use |
|---|---|---|
| `unreleased/` | `YYYY-MM-DD-<slug>.md` | Every new change. The date is when you wrote it. |
| `history/` | `YYYY-MM-DD-<slug>.md` | Curated backfill of releases that shipped before this feed. Needs `date` and `sha`. |
| `android/` | `<versionCode>.md` | What an Android app version brings. Its public anchor is `#android-<versionCode>`, the `--notes-url` every channel publish uses (`docs/APK-RELEASE.md`). |

The slug is lower case, words joined by `-`. The id (file name without `.md`, or
`android-<code>`) is permanent: it becomes the public anchor.

## Front matter

```markdown
---
title: Five-tier walls
category: world
platforms: all
requires: none
---
Walls now show five visual tiers as they level up, across bases, battles and replays.
```

| Key | Required | Values |
|---|---|---|
| `title` | yes | Up to 80 characters. A short headline, no full stop. |
| `category` | yes | `new` · `improved` · `fixed` · `balance` · `world` · `android` |
| `platforms` | yes | `all` · `web` · `android` |
| `requires` | yes | `none`, or the production env flag (e.g. `GEMS_ENABLED`) that must be exactly `true` before the note is published |
| `date` | history only | `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM:SSZ` (the deploy time) |
| `sha` | history only | The full 40-character sha that was deployed |

`android/` notes always use `category: android` and `platforms: android`. Unreleased and
Android notes never carry a `sha`: the deploy that ships them records it.

## Voice

- **Player-facing and plain.** Say what the player can now do, see or stop worrying
  about. Not how we built it.
- **One to three sentences, up to 600 characters, one paragraph.** Plain text only: no
  HTML, Markdown, links, lists or emoji.
- **Present tense, active voice.** "Walls now show five tiers", not "Walls were
  reworked to support tiered rendering".
- **Honest.** Only what is live for players at the deployed commit. Anything still
  behind a flag uses `requires:`. Never promise a date.
- **Numbers.** Live-game numbers must match `packages/shared/src/constants.ts` at that
  commit. Numbers about the upcoming onchain gameplay update may appear only if M47 §1
  lists them as LOCKED; otherwise describe them in words. When in doubt, leave the
  number out.

## Public wording rules (the lint enforces these)

| Never write | Write instead |
|---|---|
| "Phase E", "E1"…"E7" | "onchain gameplay" (prose) · "Onchain Gameplay" (titles) |
| "on-chain gameplay" | "onchain gameplay" |
| "dark", "held" | say what players can do, or "coming" |
| "SIM", "SIM 17", simulator versions | nothing: players never need it |
| D-123, K-45, M47, PR numbers, `#123` | nothing: ids are internal |
| "custody retirement", cutover letters (F, W, D0, gate A) | describe the player change |
| "play-to-earn", "earn" | "win", "collect", "receive" |
| "buy Gems" | "convert KEEP to Gems" |
| profit, ROI, investment, guarantee, passive income | nothing: no financial promises |
| raids that travel, march or arrive | raids are **instant** |
| "sideload" in a title | "Android APK" |
| worktree, handoff, feature flag | nothing: process names are internal |

Terminology: **Gold Forge** (the building), **Forging KEEP** (the process), **KEEP mining**
(the rewards interface), "mint" only for NFTs, Forge Ingots are never NFTs or tokens.
Everything is on Solana **devnet**; devnet items have no monetary value.

## Good and bad

Good:

> **Cancel troops for a full refund** — A troop still in training can be cancelled with
> a tap for its exact cost back.

Bad (internal, vague, promissory):

> **E2 gems cutover (D-152)** — Phase E Gems are now dark-launched behind the flag so
> players can buy Gems and earn more.

## Commands

```sh
pnpm --filter @shardkeep/scripts run release-notes:lint                # what CI runs
pnpm --filter @shardkeep/scripts run --silent release-notes:history-json  # bundled fallback feed for the website
```

The deploy-time collector (`scripts/src/release-notes-collect.ts`) and the recorder
(`apps/api/src/releases/cli.ts`) are run by `infra/deploy.sh`; you never run them by hand
in production.
