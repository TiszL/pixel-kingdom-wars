/** M47 §5 release recorder: the ONLY writer of release_history and
 * release_fragment_claims. infra/deploy.sh pipes a manifest into releases/cli.ts
 * after the release is publicly verified; nothing over HTTP reaches this module.
 *
 * Rules the public changelog depends on:
 *  - one row per git sha; recording the same sha again changes nothing;
 *  - the row's identity (sha, version, SIM, build time) is the RUNNING image's,
 *    never the manifest's word: a manifest for another sha is refused;
 *  - a fragment is published once, by the first recorded release carrying it;
 *  - a release claims at most RELEASE_FEED.maxEntriesPerRelease fresh fragments
 *    (the 40 that migration 0500 enforces), in manifest reading order; the rest
 *    stay unclaimed (`deferred`) and the next deploy publishes them (K-night-C2);
 *  - a release with no new fragment still gets a row, with one generic line, and
 *    the result says so (`generic: true`) so deploy.sh can warn loudly;
 *  - curated history (release-notes/history) is inserted once per sha and never
 *    rewritten; the tables refuse UPDATE/DELETE/TRUNCATE (migration 0500). */
import { inArray, sql } from 'drizzle-orm';
import { RELEASE_FEED } from '@shardkeep/shared';
import type { Db } from '../db/client';
import { releaseFragmentClaims, releaseHistory } from '../db/schema';
import { ReleaseEntrySchema, ReleaseManifestSchema, type ReleaseEntry, type ReleaseManifest } from './contracts';

/** What the running image says it is (version.ts BUILD). */
export interface ReleaseIdentity {
  gitSha: string;
  version: string;
  simVersion: number;
  builtAt: string | null;
}

export interface RecordResult {
  gitSha: string;
  /** `inserted` = a new row; `exists` = this sha was already recorded (no-op). */
  status: 'inserted' | 'exists';
  /** Fragment ids this release claimed (empty on `exists`). */
  claimed: string[];
  /** True when the new row carries only the generic maintenance line. */
  generic: boolean;
  /** Fresh fragments over the per-release cap, left unclaimed for the next deploy
   * (manifest reading order; empty on `exists`). */
  deferred: string[];
  /** Fragments present but waiting for their production flag. */
  waiting: string[];
  /** Short shas of curated history rows inserted by this run. */
  backfilled: string[];
}

/** Stable refusal vocabulary; the CLI prints `CODE: message` and exits 1:
 * INVALID_MANIFEST, INVALID_IDENTITY, IDENTITY_MISMATCH. */
export class ReleaseRecordError extends Error {
  constructor(readonly code: string, message: string) {
    super(`release history: ${message}`);
    this.name = 'ReleaseRecordError';
  }
}

/** The line a release gets when it carried no new fragment. Wording follows
 * release-notes/README.md (plain, player-facing, no promises). */
export function maintenanceEntry(gitSha: string): ReleaseEntry {
  return ReleaseEntrySchema.parse({
    id: `maintenance-${gitSha.slice(0, 8)}`, category: 'fixed', platforms: 'all',
    title: 'Stability and maintenance',
    body: 'Behind-the-scenes fixes and upkeep that keep the kingdom running smoothly.',
  });
}

function assertIdentity(identity: ReleaseIdentity): void {
  const problems: string[] = [];
  if (!/^[0-9a-f]{40}$/.test(identity.gitSha)) problems.push('gitSha must be a full 40-hex sha');
  if (!/^\d+\.\d+\.\d+$/.test(identity.version)) problems.push('version must be x.y.z');
  if (!Number.isInteger(identity.simVersion) || identity.simVersion <= 0) problems.push('simVersion must be a positive integer');
  if (identity.builtAt !== null && Number.isNaN(Date.parse(identity.builtAt))) problems.push('builtAt must be a timestamp');
  if (problems.length) {
    throw new ReleaseRecordError('INVALID_IDENTITY', `this image cannot be recorded: ${problems.join(', ')}`);
  }
}

function parseManifest(input: unknown): ReleaseManifest {
  const parsed = ReleaseManifestSchema.safeParse(input);
  if (!parsed.success) {
    throw new ReleaseRecordError('INVALID_MANIFEST',
      `invalid manifest: ${parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'} ${issue.message}`).join('; ')}`);
  }
  const manifest = parsed.data;
  const ids = [
    ...manifest.fragments.map((entry) => entry.id),
    ...manifest.skipped.map((entry) => entry.id),
    ...manifest.history.flatMap((group) => group.entries.map((entry) => entry.id)),
  ];
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
  if (duplicate) throw new ReleaseRecordError('INVALID_MANIFEST', `fragment id ${duplicate} appears twice`);
  const shas = manifest.history.map((group) => group.gitSha);
  const repeated = shas.find((sha, index) => shas.indexOf(sha) !== index);
  if (repeated) throw new ReleaseRecordError('INVALID_MANIFEST', `history sha ${repeated} appears twice`);
  const future = manifest.history.find((group) => Date.parse(group.deployedAt) > Date.now() + 86_400_000);
  if (future) throw new ReleaseRecordError('INVALID_MANIFEST', `history ${future.gitSha} is dated in the future`);
  return manifest;
}

export async function recordRelease(db: Db, input: unknown,
  opts: { identity: ReleaseIdentity; recordedBy: string }): Promise<RecordResult> {
  assertIdentity(opts.identity);
  const manifest = parseManifest(input);
  const { identity } = opts;
  if (manifest.gitSha !== identity.gitSha) {
    throw new ReleaseRecordError('IDENTITY_MISMATCH',
      `manifest names ${manifest.gitSha} but this image is ${identity.gitSha}; record from the deployed tree`);
  }
  const recordedBy = opts.recordedBy.trim().slice(0, 200) || 'unknown';
  const waiting = manifest.skipped.map((entry) => `${entry.id} (${entry.requires})`);

  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL lock_timeout = '10s'`);
    await tx.execute(sql`SET LOCAL statement_timeout = '30s'`);
    // Two recorders (a retried deploy, an operator by hand) never interleave claims.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('shardkeep.release-history', 0))`);

    const ids = [...manifest.fragments.map((entry) => entry.id),
      ...manifest.history.flatMap((group) => group.entries.map((entry) => entry.id))];
    const claimedBefore = new Set(ids.length === 0 ? [] : (await tx.select({ id: releaseFragmentClaims.fragmentId })
      .from(releaseFragmentClaims).where(inArray(releaseFragmentClaims.fragmentId, ids))).map((row) => row.id));
    const shas = [identity.gitSha, ...manifest.history.map((group) => group.gitSha)];
    const recordedShas = new Set((await tx.select({ sha: releaseHistory.gitSha }).from(releaseHistory)
      .where(inArray(releaseHistory.gitSha, shas))).map((row) => row.sha));

    // The deploy row first: history carrying this same sha can never outrank it.
    let result: RecordResult;
    if (recordedShas.has(identity.gitSha)) {
      result = { gitSha: identity.gitSha, status: 'exists', claimed: [], generic: false, deferred: [], waiting, backfilled: [] };
    } else {
      const unclaimed = manifest.fragments.filter((entry) => !claimedBefore.has(entry.id));
      // Migration 0500 refuses a row over the cap (23514), which would publish nothing.
      const fresh = unclaimed.slice(0, RELEASE_FEED.maxEntriesPerRelease);
      const deferred = unclaimed.slice(RELEASE_FEED.maxEntriesPerRelease).map((entry) => entry.id);
      const entries = fresh.length > 0 ? fresh : [maintenanceEntry(identity.gitSha)];
      await tx.insert(releaseHistory).values({
        gitSha: identity.gitSha, version: identity.version, simVersion: identity.simVersion,
        builtAt: identity.builtAt === null ? null : new Date(identity.builtAt),
        kind: 'deploy', entries, fragmentIds: fresh.map((entry) => entry.id), recordedBy,
      });
      if (fresh.length > 0) {
        await tx.insert(releaseFragmentClaims).values(fresh.map((entry) => ({ fragmentId: entry.id, gitSha: identity.gitSha })));
      }
      for (const entry of fresh) claimedBefore.add(entry.id);
      recordedShas.add(identity.gitSha);
      result = { gitSha: identity.gitSha, status: 'inserted', claimed: fresh.map((entry) => entry.id),
        generic: fresh.length === 0, deferred, waiting, backfilled: [] };
    }

    // Curated history, oldest first, once per sha. A line already published by
    // another row is not repeated; a group left with nothing is not inserted.
    const groups = [...manifest.history].sort((a, b) => Date.parse(a.deployedAt) - Date.parse(b.deployedAt));
    for (const group of groups) {
      if (recordedShas.has(group.gitSha)) continue;
      const entries = group.entries.filter((entry) => !claimedBefore.has(entry.id));
      if (entries.length === 0) continue;
      await tx.insert(releaseHistory).values({
        gitSha: group.gitSha, version: group.version, simVersion: group.simVersion, builtAt: null,
        deployedAt: new Date(group.deployedAt), kind: 'backfill', entries,
        fragmentIds: entries.map((entry) => entry.id), recordedBy,
      });
      await tx.insert(releaseFragmentClaims).values(entries.map((entry) => ({ fragmentId: entry.id, gitSha: group.gitSha })));
      for (const entry of entries) claimedBefore.add(entry.id);
      recordedShas.add(group.gitSha);
      result.backfilled.push(group.gitSha.slice(0, 8));
    }
    return result;
  });
}
