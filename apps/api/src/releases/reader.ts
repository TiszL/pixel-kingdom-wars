/** M47 §5 public reads behind /changelog and /download. Read-only; every row is
 * re-validated against the wire schema before it leaves, and a row that somehow
 * fails is dropped and logged rather than blanking the whole public page. */
import { desc, eq } from 'drizzle-orm';
import { RELEASE_FEED } from '@shardkeep/shared';
import type { DbOrTx } from '../db/client';
import { nativeUpdateChannel, releaseHistory } from '../db/schema';
import {
  PublicAndroidReleaseSchema, PublicReleaseSchema, type PublicAndroidRelease, type PublicRelease,
} from './contracts';

type Warn = (details: Record<string, unknown>, message: string) => void;

/** Newest first by deploy time; the sha breaks exact-time ties deterministically. */
export async function listPublicReleases(db: DbOrTx, limit: number, warn: Warn): Promise<PublicRelease[]> {
  const rows = await db.select().from(releaseHistory)
    .orderBy(desc(releaseHistory.deployedAt), desc(releaseHistory.gitSha))
    .limit(Math.min(Math.max(1, limit), RELEASE_FEED.maxLimit));
  const out: PublicRelease[] = [];
  for (const row of rows) {
    const parsed = PublicReleaseSchema.safeParse({
      gitSha: row.gitSha, shortSha: row.gitSha.slice(0, 8), version: row.version, simVersion: row.simVersion,
      deployedAt: row.deployedAt.toISOString(), kind: row.kind, entries: row.entries,
    });
    if (parsed.success) out.push(parsed.data);
    else warn({ gitSha: row.gitSha, issues: parsed.error.issues.length }, 'release row failed the public schema; omitted');
  }
  return out;
}

/** Stable channel rows only, newest first. Tester rows are filtered in SQL, so
 * no code path below this query can ever see one. */
export async function listStableAndroidReleases(db: DbOrTx, warn: Warn): Promise<PublicAndroidRelease[]> {
  const rows = await db.select().from(nativeUpdateChannel)
    .where(eq(nativeUpdateChannel.channel, 'stable'))
    .orderBy(desc(nativeUpdateChannel.versionCode))
    .limit(RELEASE_FEED.androidHistoryMax);
  const out: PublicAndroidRelease[] = [];
  for (const row of rows) {
    const parsed = PublicAndroidReleaseSchema.safeParse({
      versionCode: row.versionCode, versionName: row.versionName, sizeBytes: row.sizeBytes, sha256: row.sha256,
      signerSha256: row.signerSha256, publishedAt: row.publishedAt.toISOString(), apkPath: row.apkPath,
      notesUrl: row.notesUrl,
    });
    if (parsed.success) out.push(parsed.data);
    else warn({ versionCode: row.versionCode, issues: parsed.error.issues.length }, 'stable channel row failed the public schema; omitted');
  }
  return out;
}
