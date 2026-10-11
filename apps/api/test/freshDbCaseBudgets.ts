/** Explicit per-case budget for API cases whose fixture creates a fresh database and
 * replays the whole migration chain before the case body runs.
 *
 * 2026-10-10 (release/r2-j-ci-shard-harness): with 301 migrations in apps/api/drizzle, a
 * fresh-database fixture spends 18-20 s in runMigrations alone on the night Mac (load ~6)
 * before any assertion; 0301 by itself adds ~3 s of that (K-night-J1).
 * - CI at d080b2405 (run 37503885235): all six files below passed at 14-30 s per case,
 *   mining-claim-ordered already at 28-30 s.
 * - CI on the release head (runs 38043546234, 38050662691): passing cases took 20-27 s,
 *   and these timed out at exactly 30 s with no assertion failing: all six cases of
 *   mining-claim-ordered, two or three of mining-tax-claim-continuation-http, one or two of
 *   mining-claim-failure-http, one case each of mining-roster-checkpoints and
 *   mining-roster-checkpoint-history (both runs) and of mining-gems-finalized-origin
 *   (first run only).
 * - Locally, alone, one file at a time on a fresh database (night Mac, load 6-10): 68/68
 *   pass, slowest case 40.0 s (mining-claim-ordered), 38.7 s (gems-finalized-origin),
 *   32.5 s (claim-failure-http), 29.5 s (tax continuation), 25.8 s and 20.5 s (roster).
 * The same file also ran up to 1.7x slower on one hosted runner than on another, so the
 * budget is 3x the slowest case measured. A real assertion still fails at once; only a
 * hang now costs more. Lower it if these fixtures move to a pre-migrated template
 * database.
 *
 * 2026-10-10 (release/r3-t-fresh-db-template): most fresh-database fixtures now clone a
 * migrated template (test/migratedTemplate.ts) instead of replaying. The budget also
 * covers the cases whose SUBJECT is the replay itself, so they can never use a template:
 * migration-0098 / 0115 / 0122 (a truncated journal, rows written at that head, then the
 * upgrade) and the mining-tax failure/review HTTP files (0186-0190 applied to an empty
 * database first, then the whole chain on top). On CI run 38069074990 these timed out at
 * exactly 30 s with no assertion failing (migration 0302 had just added ~1.9 s, +18%, to
 * every replay); locally, alone on an otherwise idle stack, a full replay is 12.5 s.
 *
 * 2026-10-11 (release/r4-timeouts-batch, K-night-R3c / K-night-T2): four more cases whose
 * subject is the replay itself. migration-0132 (journal cut before 0132, rows written, then the
 * rest of the chain) timed out at 30.006 s in CI run 38120909148; alone on the night Mac (load
 * ~7-9) 17.0 s and 15.4 s. keep-custody-league-bridge's three cases that migrate their 0094-prefix
 * database to head in the body (custodyLeagueFixture.migrateAll): in that run 31.1 s and 31.3 s
 * (vitest's figure includes the 0094-prefix beforeEach, ~2 s, which has its own 60 s hook budget)
 * and one timed out ('fences an old payer...', 32.4 s); alone 15.1-20.0 s with the same
 * beforeEach. */
export const FRESH_DB_CASE_MS = 120_000;
