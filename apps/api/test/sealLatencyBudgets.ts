/** Explicit per-test budgets for API cases whose wall time is dominated by the Phase E
 * integrity-seal source proofs (K-night-07 in docs/KNOWN_ISSUES.md).
 *
 * Every guarded SQL call rebuilds a ~1.26 MB jsonb contract from pg_get_functiondef:
 * 0.21-0.28 s on an M-series Mac and ~0.65 s on the QA host (K-night-07), 0.76-0.97 s
 * measured on the loaded night Mac on 2026-10-10. A CPU profile of a tax-claim HTTP case
 * shows the Node side idle for ~84% of its wall time, i.e. waiting on Postgres.
 *
 * 2026-10-10 (CI cluster F): these cases timed out in the hosted API shards (run
 * 37503885235), the 100-trip ones even alone on a fresh DB. The budgets are explicit per
 * case so the global testTimeout stays 30 s and a genuine hang in any other case still
 * fails fast. Lower them once the per-transaction seal memo (night/seal-latency f6948c1cb,
 * migration 0300) lands; the rules these cases pin do not depend on the numbers. */

/** One authenticated HTTP lifecycle case: mining-tax-claim-http 23-48 s per case and
 * earned-input-crafting-http 31 s measured on the loaded night Mac, against the 30 s default. */
export const SEAL_BOUND_HTTP_CASE_MS = 180_000;
/** One case that completes 100 (or 200) real returns, each through several guarded calls.
 * Measured on the loaded night Mac (load average ~15): advanced-expeditions 164 s,
 * vehicle-service-intents 230-233 s, vehicle-client-journey 261 s, vehicle-service-lifecycle
 * (201 trips) 348-447 s; the old 120 s / 300 s budgets failed in CI. ~2x the slowest. */
export const SEAL_BOUND_100_TRIP_MS = 900_000;
/** One case built on the earned vehicle-material source (fixtures/vehicleMaterialEarnedSource.ts,
 * also behind fixtures/vehicleCraftClient.ts). Before the case body runs, the fixture creates
 * and migrates a fresh database, replays funded mining, plays and settles a Divine trial, then
 * completes 150 real starter-expedition returns and 8 ordinary refinings: the earned leaves for
 * three survey_balloon originals. 2026-10-10 (r2 lane v-vehicle-seal-latency), measured alone
 * on the night Mac (load ~6) with Postgres function statistics: the fixture made 348 guarded
 * calls, each through shardkeep_bound_cosmetic_wake_sources_valid at ~317 ms (110 s of the
 * 140 s return/refining loop). Each file alone at load 6-13: request-preparation-earned 190-249 s,
 * policy-issuer 178 s, request-delivery 173-231 s, request-preparation 149-222 s, craft-client
 * 139-230 s per case; one request-preparation case took 260 s alone at load ~27. The old 120 s
 * literals timed out in every hosted shard (CI run on PR #165). ~2.3x the slowest (260 s). */
export const SEAL_BOUND_EARNED_VEHICLE_CASE_MS = 600_000;
/** One case on the Divine fragment fixture (fixtures/divineFragments.ts) without the earned
 * returns: a fresh database and all migrations, the funded mining replay and a played, settled
 * and delivered Divine trial, then the case body. 2026-10-10 (r2 lane v-vehicle-seal-latency),
 * vehicle-craft-materials measured alone on the night Mac: 35-58 s per case at load ~9 and
 * 27-37 s at load ~6. Of that, ~15-25 s creates and migrates the database and ~44 guarded calls
 * (21 in the fixture, 23 in the body, ~333 ms each through
 * shardkeep_bound_cosmetic_wake_sources_valid) take ~15 s. The old 60 s literals timed out on all
 * seven cases in the hosted shard (CI run on PR #165). ~3x the slowest. */
export const SEAL_BOUND_DIVINE_FIXTURE_CASE_MS = 180_000;
/** One case on the SHARED test database that settles real raids, base reads or returns
 * through many guarded Phase E calls (no fresh database). 2026-10-10 (r3-t-fresh-db-template):
 * CI run 38043546234 passed them at 21-30 s (survey-lens 'earns both materials' 25.8/29.9 s,
 * base-visual realm cases 21.6/24.7 s, stable-base-raids pvp cases 22.8/23.2 s,
 * phase-e-services-runtime 'collects due cosmetics' 21.2 s; survey-lens 'conserves both
 * ordinary return legs' 27.5 s in 38069074990), and run 38069074990 timed all of them but
 * the last out at exactly 30 s with no assertion failing. Alone on the night Mac (load ~5):
 * 11.1-16.2 s. Sampling pg_stat_activity through the stable-base-raids pvp case shows the
 * active statements are the guarded raid-visual / raid-presentation / settle calls and the
 * raid INSERT's triggers. ~3x the slowest CI pass.
 * r3 lane u-test-design-fixes measured the two survey-lens cases independently and chose the
 * same 90 s (alone at load ~6-8: 'earns both' 14.8 / 12.9 s and 10.7 / 12.1 s; hosted runner
 * ~2.5x local); integration round 3 kept this one constant instead of a second identical one.
 * 2026-10-11 (r4-timeouts-batch, K-night-T2): seeker-realm-sale-renewal-web-paired's one case (two
 * paired browser permit purchases, restarts, a paid starter departure and its return over HTTP on
 * the shared database) timed out at 30.0 s in CI run 38120909148 (also red in 38077589981) and its file
 * averaged 28 s in 38043546234/38050662691 (ci-shard-timings.json); alone on the night Mac (load ~7) 15.7 s. */
export const SEAL_BOUND_SHARED_DB_CASE_MS = 90_000;
/** One case that drives dozens of authenticated HTTP requests through guarded Phase E reads and
 * writes on a fresh vehicle-burn or crafting-market source database: the paired browser-journal
 * clients of survey-lens-web-paired ('crafts a Lens...') and keep-equipment-market-web-paired
 * ('pairs actual earned refined goods...'), and vehicle-berth-occupancy's 20 rounds of concurrent
 * Home + starter-fleet reads. 2026-10-11 (r4-timeouts-batch, K-night-T2): all three timed out at
 * their 120 s literals in CI run 38120909148 (the berth case settled at 155 s, after its timeout;
 * all three files were also red in 38077589981). Alone on the night Mac (load ~7): 53.1 s, 62.9 s
 * and 60.1 s. The berth case's 155 s against 60 s here suggests a hosted runner ~2.6x slower, i.e.
 * up to ~165 s in CI; the budget is ~3x that. */
export const SEAL_BOUND_PAIRED_HTTP_CASE_MS = 480_000;
