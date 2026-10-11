# Deploying the devnet alpha

Running Pixel Kingdom Wars for real users, on devnet, for a month or two.

Two places, on purpose — but split by *product*, not by static-vs-dynamic:

| | Where | Why |
|---|---|---|
| **The game** — web dist + API + Postgres + Redis | One VPS, Docker Compose, behind Caddy on `play.pixelkingdomwars.com` | **ONE origin.** The session cookie is SameSite=Lax and host-only, and the installed APK is built against this hostname. Game and `/api` on different sites means the cookie is never sent and every login bounces (see `infra/Caddyfile.single-origin`'s header comment for the full autopsy). |
| **The landing site** | Cloudflare Pages at the apex (`pixelkingdomwars.com`) | Marketing pages plus narrow public-statistics Pages Functions; separate repo folder; see [landing/DEPLOY.md](../landing/DEPLOY.md). |

An earlier version of this document put the game's web dist on Cloudflare
Pages with the API on an `api.*` subdomain. **That split is rejected** — it
breaks the cookie and the shipped APK — and any instructions shaped like it
are stale. The one-time migration from the Mac to the VPS is a separate,
step-by-step document: the operations runbook. This file is
the steady state.

---

## 1. The box

A CX32 (4 vCPU / 8 GB) is comfortable — the box builds the web dist and the
api image itself. A CX22 works with swap. Debian 12, x86_64.

Full first-time preparation (docker, ufw, Node 22 + pnpm for the on-box web
build, swap, docker log rotation, backup directory permissions, SSH hardening)
is the operations runbook §1 — run that
block verbatim on a fresh box rather than improvising from memory.

DNS:

- `play.pixelkingdomwars.com` → the VPS IP (**A record, DNS-only** — Caddy
  answers the ACME challenge itself, so do not proxy it through Cloudflare).
  Caddy deliberately ignores client-supplied `CF-Connecting-IP`; proxying later
  needs both a certificate change and a reviewed trusted-Cloudflare-CIDR policy.
- `pixelkingdomwars.com` / `www` → Cloudflare Pages (the landing site,
  proxied — Pages terminates TLS at the edge).

## 2. Secrets

```bash
git clone git@github.com:TiszL/shardkeep.git ~/shardkeep && cd ~/shardkeep
cp infra/.env.prod.example infra/.env.prod
$EDITOR infra/.env.prod          # gitignored; never commit it
```

`infra/.env.prod.example` is the complete, commented truth — fill it top to
bottom. Generate fresh values (never reuse another machine's):

```bash
openssl rand -base64 32   # POSTGRES_PASSWORD
openssl rand -base64 48   # JWT_SECRET  (rotating it signs every player out once)
```

`WEB_ORIGIN` is `https://play.pixelkingdomwars.com` — under a single origin
CORS is never consulted for the game itself, but `PLAY_URL` falls back to the
first entry, so keep the play origin first if more are ever added. The landing
form's origins live in `LANDING_ORIGINS`, which has a correct default — leave
it unset.

Three keypairs in `infra/keys/` (gitignored, mounted read-only at
`/app/infra/keys` — the `*_KEYPAIR_PATH` vars must use those **container**
paths):

```bash
mkdir -p infra/keys && chmod 700 infra/keys
# from the machine that holds them:
scp ~/.config/solana/id.json        <box>:~/shardkeep/infra/keys/admin.keypair.json
scp infra/keys/deed-ops.keypair.json   <box>:~/shardkeep/infra/keys/
scp infra/keys/hot-wallet.keypair.json <box>:~/shardkeep/infra/keys/
```

`config.ts` validates every variable at boot and refuses to start
half-configured, so a typo is a failed `up`, not a subtly broken game — and
`deploy.sh` additionally fails on the degradations that *don't* fail boot
(missing hot wallet, deed minting disabled, R2 misconfigured).

## 3. First deploy

```bash
./infra/deploy.sh
```

One script does everything in the safe order: build assets/web and the matching API
image → signer/queue/PoR preflight → prove Caddy maintenance → drain API → let
the compatible worker settle started and v2 armed raids → stop worker/signer →
quiescent backup → migrations/TOTP verification → replacement-worker
freshness gate → API/worker health verification → publish the verified dist → return
Caddy traffic. The old public release remains intact until maintenance begins, and
the new dist is not exposed until both server processes are verified.

Then, once, **only if this is a genuinely fresh environment** (empty database
*and* un-bootstrapped devnet programs — not the migration case):

```bash
pnpm bootstrap:devnet    # on the HOST, from the repo root
```

On the host, not in the container: the api image deliberately carries only
`@shardkeep/api` and its workspace deps — `@shardkeep/scripts` is not in it, so
in-container the root script's `--filter` matches nothing and silently no-ops.
The host checkout has the full workspace (deploy.sh already ran
`pnpm install`), and the script is chain-side only (Solana RPC + keypairs, no
database connection), so it needs nothing from the compose network.

If the database was migrated from a previous box, do **not** run bootstrap —
the restored data already carries the live world, and the devnet programs were
bootstrapped long ago
(the operations runbook §4).

## 4. The web app

Built **on the box, by `deploy.sh`** — not on a CDN builder. This keeps every
deploy reproducible from a commit and keeps the web bundle's `GIT_SHA`
identical to the api image's, which is what the SIM_VERSION raid lockout keys
on.

Two things the build needs that a fresh clone does not have:

- `apps/web/public/{atlas,audio,brand}` are **generated and gitignored** —
  `deploy.sh` runs `pnpm assets` first. Without it you ship a game with no
  textures, and the api image build fails outright (its Dockerfile copies the
  atlas for the deed renderer).
- `apps/web/vite.config` reads public build settings from the **repo root**, and
  root `.env` is gitignored. `VITE_PRIVY_APP_ID` and a browser-safe
  `VITE_SOLANA_RPC_URL` must exist on the box. `deploy.sh` verifies that RPC's
  genesis, then forces the client cluster and every economic address from
  `SOLANA_CLUSTER` plus the matching reviewed `infra/*.addresses.json`. The
  browser therefore cannot silently drift from the API's mint, program, Config,
  or treasuries. `VITE_API_URL` is pinned to `/api` (same-origin) by the script.

`GIT_SHA` is not decoration. It names the service-worker cache and drives the
update check; without it every build looks identical to the last and players
are never told to reload.

## 5. Deploying an update

Selected-base raid alerts are independently controlled by `RAID_EVENTS_ENABLED`
(default `false`). Enable through the guarded API/worker rollout after stream
acceptance. `false` returns the typed `RAID_EVENTS_DISABLED` response and clients
retain single-flight status polling. No migration is needed. An authenticated
owned-base `/bases/:baseId/raid-events` connection must receive a `snapshot`, then
changed snapshots or heartbeat comments; healthy clients must stop status polling.
Reconciliation and session/ownership checks run every15 seconds even when Redis
notifications are unavailable. Do not cache or buffer this API route in a proxy.

Steady-state updates with no new migration may use:

```bash
git pull --ff-only && ./infra/deploy.sh
```

**Any migration-bearing release, including M26, must use the restore interlock:**

```bash
git pull --ff-only
git status --short
git rev-parse HEAD
HOLD_BEFORE_MIGRATE=1 ./infra/deploy.sh
```

Before starting M26, production configuration must retain rewards disabled. Set
the start week to the next complete Monday boundary: `2026-09-07` only when the
release is live before 2026-09-07 00:00 UTC; otherwise use `2026-09-14`.

```dotenv
LEAGUE_REWARDS_ENABLED=false
LEAGUE_REWARD_START_WEEK=2026-09-07 # or 2026-09-14 after the first boundary
```

The deploy proves Caddy maintenance, drains API (including in-flight requests),
lets the compatible worker finish started and v2 armed raids, stops worker and
signer, then creates the
authoritative quiescent database + signer-state backup. During the hold, copy the
exact four-file set named by `backup.sh` (dump, dump checksum, paired signer state,
signer-state checksum) to a trusted recovery host. Verify and restore that copied
dump there, using a reviewed checkout, compatible isolated Postgres stack and an
explicit dump path:

```bash
# production VPS, while the post-drain deploy hold is active. Run the standard
# labeled census and carry the value beside "player rows (all sign-ins, ...)"
# to the recovery host. Do not substitute an unlabeled ad-hoc count.
./infra/ops/census.sh

# recovery host — never the production VPS
SHARDKEEP_ENV_FILE=/secure/path/recovery.env \
  COMPOSE_PROJECT_NAME=shardkeep_release_restore \
  BACKUP_EXPECTED_PLAYER_ROWS=<exact-positive-integer-from-production> \
  ./infra/backup/verify-restore.sh /secure/off-host/shardkeep-<backup-id>.dump

# production VPS, only after the off-host command succeeds
touch /tmp/shardkeep-release-migration
```

The explicit dump path is the off-host contract: all schema, custody-journal and
ledger checks target the restored scratch database, and the verifier does not
assume the recovery stack's otherwise-empty base database has an application
schema. `BACKUP_EXPECTED_PLAYER_ROWS` is required, must be positive, and must
exactly equal the player-row census captured from the stopped production source;
this is the independent data-presence oracle that prevents an empty but
structurally valid archive from passing. Transfer that public number with the
four artifacts and do not derive it from the blank recovery stack. The selected
`SHARDKEEP_ENV_FILE` supplies the public custody identity used to authenticate
the paired signer journal. No-argument scheduled drills still query the adjacent
live database and reject an empty backup when live player rows exist.

Running `verify-restore.sh` with no argument on the current VPS is not this gate:
without rclone configured it selects the same-disk local dump. If a verified
rclone remote is provisioned instead, force `BACKUP_VERIFY_SOURCE=remote` and
prove the downloaded object before signaling.

The `touch` is authorization to migrate and must happen only after the restore
reports success. The hold expires after 60 minutes. A casual pre-deploy dump is
not a substitute for the post-drain paired backup. The currently audited local
backup window starts at 03:15 UTC daily; Sunday restore verification starts at
04:45 UTC. Do not overlap either job.

**Ordering is handled for you.** `SIM_VERSION` must agree between client and
server. `deploy.sh` drains Caddy before replacing either serving half, verifies the
replacement worker and API while traffic remains stopped, publishes the matching
web dist, and only then returns Caddy. There is no public mixed-version window.

**Maintenance mode (M23 a18).** During the drain window Caddy now serves the
self-contained page in `infra/maintenance/` via `infra/Caddyfile.maintenance`
(swapped with `caddy reload`; hard `stop caddy` remains the automatic
fail-safe). The maintenance config proxies nothing and never reads the
mid-publish web root, so the window keeps its writer-free guarantees.
**The page is proven, not assumed (K-071).** A bind mount pins the host inode at
container creation, so a host directory or file that is deleted and recreated
(git checkouts replace files by rename) stays invisible to a running caddy: the
M27/M28 windows served a body-less 503 because `/srv/maintenance` was an
orphaned, empty inode while `caddy reload` still exited 0. Before the window,
`deploy.sh` compares the host and in-container inodes of `infra/maintenance`,
`infra/Caddyfile.maintenance` and `infra/Caddyfile.vps`, checks that caddy sees a
non-empty `index.html`, and force-recreates caddy on the normal config (≈1–2 s
of dropped connections) when any is stale. After the reload it fetches the
public origin with node: `/` must answer 503 **with** the page body and
`/api/version` must answer the coded `MAINTENANCE` JSON; otherwise it falls back
to the hard stop instead of exposing a blind window. `/api/*`
answers a coded 503 (`MAINTENANCE`) that an open game client turns into the
"RAISING THE DRAWBRIDGE" hold screen; the client then watches `/api/version`
every 10 s and reloads itself to the fresh bundle when the server returns —
players are never interrupted mid-raid because the drain (above) finishes
every started live battle before the window begins.

**The maintenance page itself (2026-09-25).** `infra/maintenance/index.html` is one
self-contained file generated by `node infra/maintenance/src/build.mjs` from tracked inputs in
`infra/maintenance/src/`: the "PIXEL KINGDOM WARS" wordmark cut from the approved
`art/source/brand-wave2/brand_logo_main.png` (owner 2026-09-25: text only, at the top, no castle over
the wallpaper's keep), the game's VT323 woff2, and landscape + portrait backdrops derived from the
`art/loading-v1` masters (720 px, 80 colours). Caddy rewrites every path to this file during the
drain window, so nothing may be referenced externally. `scripts/src/maintenance-page.test.ts` pins:
no external or `/srv/www` references, no emoji, the inline font and wordmark, the 30 s refresh, the
drawbridge copy, the 250 KB ceiling, and that `index.html` equals the build output. To change the
art, replace an input and re-run the build; never hand-edit `index.html`.

### Release channels around the dApp Store listing (M23 a18)

The Android app is a thin signed TWA shell; the game is the web deploy.

| Change | Channel | Review |
|---|---|---|
| Any game fix/feature/balance/art | `./infra/deploy.sh` (this section) | none — live in minutes |
| Simulator change (`SIM_VERSION` bump) | same, but stale clients are LOCKED out of raiding (426) until they take the unskippable update; the drain gate settles started raids first | none |
| Shell change (icon, name, orientation, domain) | `pnpm apk:release <version> <versionCode>` — the only sanctioned way (D-101): bumps the three version files + CHANGELOG, gates the store key, builds, verifies, copies; then resubmit to the dApp Store **with the same signing key**. Runbook: [`docs/APK-RELEASE.md`](APK-RELEASE.md) | 3–5 business days |

Pre-listing (now): sideload builds go straight to the Seeker; `assetlinks.json`
must be live (web deploy) BEFORE installing a new-key APK. Post-listing: the
store build and the sideload build must use the same key and `applicationId`,
and every web deploy keeps working for both unchanged. Never publish a store
update without running the K-017 physical-device FPS check first.

`deploy.sh` refuses to run on a dirty tree, backs up before migrating, runs
migrations before starting the new container, and fails if the new container
does not report the expected sha.

### Rolling back

> **M34 / raid protocol v2 is a compatibility boundary even though SIM13 is
> unchanged.** Once v2 is enabled, do not use the generic previous-image rollback
> to M33. M33 lacks v2 start/speed/retreat controls and armed-raid recovery; a
> matching SIM13 number does not make its command protocol compatible. Completed
> v2 replays also remain part of the compatibility obligation after active raids
> finish. Prefer a compatible forward fix, or disable both
> `MINE_FULL_NOTIFICATIONS_ENABLED` and `LIVE_RAID_V2_ENABLED` on the same reviewed
> M34-compatible release. Flag-OFF still reads/resolves v2 and permits safe 2→1;
> it does not cancel staged troops or refund them.
>
> The guarded deploy stops API before checking the drain, so an already accepted
> request cannot stage an army after the zero count. It keeps the compatible
> worker running until every unresolved started raid **or v2 armed raid** has
> resolved. Its JSON lookup for `armed_at` is safe before migration 0102 and does
> not drain/expire the known unstarted v1/SIM11 legacy row. Do not manually edit
> raid statuses or balances to make the drain pass.
>
> These flags come from the services' `infra/.env.prod` at container creation.
> Edit only the intended keys, then recreate through the guarded deployment at
> the exact approved SHA; `docker compose restart` retains the old environment.
> Verify the non-secret flag values inside API and worker. Initial M34 deploys
> with both OFF, then stages Mine notifications before new v2 admission. See
> [the M34 rollout audit](reviews/2026-09-04-m34-rollout-readiness.md) for backup,
> flag-staging, evidence, and physical-device boundaries. Any downgrade to a
> pre-M34 protocol implementation needs a separate reviewed procedure.

> **M22 / migration `0083` is a forward-only mail-custody boundary.** Once new
> mail delivery has ever been enabled, a pre-M22 image cannot account for the
> `mail_keep_escrow` liability and cannot claim or expire pending rewards. It
> may start against the newer database, so a successful boot is **not** proof
> that rollback is safe. Prefer an M22-compatible image or a forward fix.
>
> A pre-M22 rollback is allowed only from the current M22+ checkout, during a
> maintenance window, after both API and worker are stopped, and only after:
>
> ```bash
> ./infra/ops/assert-m22-mail-rollback-safe.sh
> ```
>
> proves zero pending reward rows, zero KEEP mail escrow, and zero SHARDS mail
> escrow. The assertion includes item-only pending rewards. Run it **before**
> checking out an older SHA—the older checkout does not contain the fence. If
> it fails or cannot query the database, do not restore traffic on an older
> image. Do not manually zero an escrow; drain through claim/expiry while an
> M22-compatible worker is running.

> **SIM6 / migration `0055` exception (M19 dark-attacker roster):** after `0055`
> has been applied, the generic `<previous-sha>` rollback below is unsafe if that
> image is SIM5 or older. The PostgreSQL enum and frozen raid/army snapshots can
> contain `gloamfang`, `direwyvern`, `hexbarrow`, or `barrowling`, which an older
> binary cannot interpret. Roll back operationally by keeping the same
> SIM6-compatible release running with `DARK_ATTACKER_ROSTER_ENABLED=false`, or
> deploy a newer forward-fix built from that compatibility line. In particular,
> **never roll back this rollout to `d0cf501`/SIM5**. Follow the staged procedure
> in the operations runbook (the “SIM6 dark-attacker
> rollout” decision box).

> **SIM15 / migration `0132` (playable 50×50 expansions):** `0132` widens the
> `bases.expansions` CHECK from 0..6 to 0..12. Roll back to `fb0bf362` (SIM14)
> only while `select max(expansions) from bases` is still ≤ 6: once any base has
> been credited expansion 7+, the older API throws `RangeError('expansions out
> of range')` on every read of that base, so roll forward instead. Started SIM15
> raids also cannot be replayed by a SIM14 worker; the interlock drain before
> `0132` is mandatory in both directions.

> **Withdrawal policy-signer boundary:** the ordinary rollback is API-only.
> Keep the current reviewed worker and private signer running; never roll a
> worker back across the policy-signer introduction. A pre-signer worker can
> possess the hot key and bypass durable aggregate limits. If an incident truly
> requires that worker generation, first set `WITHDRAWALS_ENABLED=false`, stop
> the worker and then signer, preserve the signer journal, and reconcile every
> signed artifact on chain. Do not restore withdrawals until a reviewed
> roll-forward reinstates the signer boundary.

> **Withdrawal-policy changes:** `withdrawFeeBps`, `minWithdrawKeep`, and
> `unbondingHours` are checked again before signing. Do not retune them while a
> withdrawal is `unbonding` or `processing`: an already frozen request can then
> fail closed under the new policy. Disable new withdrawals, drain or manually
> reconcile every in-flight row, take the paired database+journal backup, deploy
> the worker and signer together, and only then reopen withdrawals. Supporting
> zero-downtime policy changes requires a separately reviewed, persisted policy
> version; never weaken these checks to make an old request pass.

```bash
API_IMAGE=shardkeep-api:<previous-sha> docker compose \
  --env-file infra/.env.prod -f infra/docker-compose.prod.yml up -d api
```

Images are tagged by sha, and after a verified deploy `deploy.sh` keeps four
(`KEEP_RELEASE_IMAGES`, K-082): the live release, the release it replaced, and
the newest other builds by build time. So rolling back to the release that was
serving before the last deploy is immediate. The other slots may hold candidates
that built but failed a later gate, so an older release can already be gone
(`docker image ls shardkeep-api`) and must then be rebuilt from its commit.
Caveats:

- **A migration is not rolled back by this** — check whether the schema change
  was backward compatible before relying on it. The pre-migration dump
  `deploy.sh` took is the real escape hatch. Migration `0055` is the explicit
  exception above: its enum expansion is intentionally irreversible in place,
  so restoring an older dump is a disaster-recovery operation, not the normal
  application rollback.
- **A simulator protocol is not rolled back by this.** Pending raids are pinned
  to the `SIM_VERSION` that created them. Before downgrading to an older API,
  query pending rows and let newer-version raids resolve/expire, or use an
  explicitly authorized expiry/refund procedure. A matching old web/API pair
  can still correctly refuse a row created by the newer simulator. Prefer a
  forward fix while any newer-version pending raid exists.
- **0055 / SIM6 is an explicit exception to the generic previous-image path.**
  Once migration 0055 has run (or any dark-attacker row exists), never roll the
  API back to d0cf501/SIM5: that binary cannot safely interpret the expanded
  troop enum. The rollback target is the same SIM6-compatible binary with
  `DARK_ATTACKER_ROSTER_ENABLED=false`; this hides training/deployment while
  retaining tolerant readers and the compensation path for pending raids.
- **0083 / M22 is another explicit exception.** Never use the generic path to
  cross backward over M22 while any pending mail reward or mail escrow balance
  exists. The mandatory quiescent assertion above is the release fence.
- The web dist on disk is still the *new* build. If the release moved
  `SIM_VERSION`, roll the dist back too:
  `git checkout <previous-sha> && ./infra/deploy.sh` (which rebuilds both
  halves at that sha), then return to main. **Do not use this command across
  the `0055`/SIM6 boundary; use the flag-off SIM6 path above.**

## 6. Backups

The Postgres volume holds every player's base, army and ledger. There is no
other copy — and the ledger is off-chain, so chain state cannot reconstruct
it.

The tooling is `infra/backup/`. Current production state and the desired mainnet
state are intentionally distinguished here; K-021 remains open until the off-host
target, credentials, retention and monitoring are actually provisioned.

- **`backup.sh` — currently 03:15 UTC daily from the deploy user's cron.** Dumps
  to `/var/backups/shardkeep/` and keeps 48 h locally. It validates the PostgreSQL
  archive catalog, writes a SHA-256 sidecar, copies both to the configured
  rclone destination, then reads both objects back and compares byte size and
  SHA-256 before reporting success or pruning old local copies when an off-host
  target is configured. The audited devnet host has no rclone target today, so
  this job is local-only. Use backup-only R2 credentials when provisioning one,
  never the API's deed-bucket token.
- **`verify-restore.sh` — currently 04:45 UTC Sunday from the deploy user's
  cron.** Restores the newest configured-source dump with `--exit-on-error` into
  a unique scratch database and proves the required schema, cached account balances,
  global and per-transaction double-entry invariants, and account references
  are coherent. A restore failure is fatal and the scratch database is always
  removed.

Required production configuration before mainnet/off-host enforcement:

```dotenv
BACKUP_NETWORK=devnet              # change to mainnet-beta at mainnet cutover
BACKUP_OFFSITE_REQUIRED=true       # mainnet refuses false
BACKUP_VERIFY_SOURCE=remote
BACKUP_DIR=/var/backups/shardkeep
BACKUP_KEEP_LOCAL_HOURS=48
BACKUP_RCLONE_REMOTE=backup-r2:shardkeep-db
BACKUP_RCLONE_CONFIG=/home/deploy/.config/rclone/rclone.conf
```

Create the rclone config as the `deploy` user with mode `0600`, using a token
scoped only to the backup bucket. Do not paste its access key or secret into
the repository, cron line, or logs. Configure immutable/versioned remote
retention with an R2 bucket lock, plus an external alert on either cron
command's non-zero exit or a stale latest object. The scripts never delete
remote objects.

`BACKUP_OFFSITE_REQUIRED=false` with `BACKUP_NETWORK=local` is for disposable
rehearsals. Devnet technically permits it and the current live host temporarily
uses that local-only posture under K-021; every migration release compensates
with a manual off-host copy and explicit-path restore. `mainnet` and
`mainnet-beta` reject the opt-out. Passing a dump path to `verify-restore.sh`
is the required manual-copy proof; once rclone is provisioned, the scheduled
no-argument drill must use the remote source.

Desired post-K-021 schedule (not the currently installed daily/Sunday cron):

```cron
0 * * * *  /home/deploy/shardkeep/infra/backup/backup.sh        >> /var/log/shardkeep-backup.log 2>&1
20 4 * * 1 /home/deploy/shardkeep/infra/backup/verify-restore.sh >> /var/log/shardkeep-verify.log 2>&1
```

(`deploy.sh` also calls `backup.sh` after writers drain and immediately before
every migration. With off-host backup required, a failed dump, upload,
round-trip verification, or checksum stops the migration.)

## 7. When something is wrong

```bash
cd ~/shardkeep
C="docker compose --env-file infra/.env.prod -f infra/docker-compose.prod.yml"

$C ps                       # what is up — watch for (unhealthy) on the worker
$C logs -f --tail=200 api   # what it is saying
curl -s https://play.pixelkingdomwars.com/api/version   # what is actually running
$C exec postgres psql -U shardkeep shardkeep
```

| Symptom | Look at |
|---|---|
| API restarts in a loop | `$C logs api` — config validation prints exactly which variable is wrong. A keypair path that isn't `/app/infra/keys/...` (container path) is the classic ENOENT crash-loop. |
| Every player sees UPDATE REQUIRED | `/version` simVersion vs the deployed bundle's. Re-run `./infra/deploy.sh` — it rebuilds both halves at one sha. |
| Raids 426 for everyone | Same: the two halves disagree on `SIM_VERSION`. |
| TLS not issuing | The `play.` record must be **DNS-only**, not Cloudflare-proxied. `$C logs caddy`. |
| Landing form CORS errors | `LANDING_ORIGINS` — it has a correct default; it was probably overridden. Never add landing origins to `WEB_ORIGIN` (that list carries player cookies). |
| Deeds not minting / metadata stale | `docker compose ps` — is the **worker** `(unhealthy)`? The deed-R2 and deed-chain sync legs run there, not in the api. `$C logs worker | grep -i deed`. |
| Withdrawals sit in 'unbonding' forever | Hot wallet: `$C logs worker | grep -i hot-wallet`. An **unset** `HOT_WALLET_KEYPAIR_PATH` logs *nothing* — which is why `deploy.sh` pre-flights it. |

### External uptime check

Point UptimeRobot (or any HTTPS keyword monitor) at
`https://play.pixelkingdomwars.com/api/health`, keyword `"ok":true`.

Know its blind spot: the public URL lands on the **api** container, which
reports the deed-sync legs as "worker owns it" and stays green even when the
worker's sync is stalled. The external check therefore covers api + Postgres +
Caddy + DNS + TLS; the worker's legs are covered by its compose healthcheck —
visible as `(unhealthy)` in `$C ps`, checked at every deploy, not from the
internet.

## 8. Before inviting real users

If GitHub Actions refuses to start with a billing/spending-limit annotation,
inspect the failed job annotation before treating it as a code failure. In the
repository owner's GitHub Settings → Billing and licensing, check Actions usage,
budgets and payment status. If the included allowance is exhausted, either wait
for its reset or deliberately enable additional usage with a capped budget; a
plan upgrade is not inherently required. If usage and payment status are healthy,
contact GitHub Support with the failed run URL. After the account issue is fixed,
rerun the failed checks and verify the actual deployed commit succeeds.

An alternative is an isolated self-hosted runner, which does not consume hosted
Actions minutes but uses our own infrastructure. Configure that through a
separate reviewed change; never run untrusted PR jobs on the production game host
or expose deployment credentials to them. Local checks remain useful during an
Actions outage; they do not silently satisfy the green-CI gate below. Any owner
exception must be explicit and recorded with the exact local checks and release
commit. Do not alter billing or repository visibility just to unblock a release.
See [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions).

- [ ] `pnpm -r test` green, CI green on the deployed commit
- [ ] A backup has been taken **and restored** (`verify-restore.sh` passing)
- [ ] `/version` reports the sha you intended
- [ ] A full raid completes end to end against production
- [ ] Withdrawal personal cap/cooldown and `WITHDRAWALS_ENABLED` are what you intend — and the
      hot wallet is *deliberately* on or off, not accidentally unset
- [ ] `mobile/keystore/` backed up off the machine ([mobile/README.md](../mobile/README.md))
- [ ] Open items in [AUDIT-FIX-PLAN.md](AUDIT-FIX-PLAN.md) reviewed — some are
      mainnet-only, some are not
