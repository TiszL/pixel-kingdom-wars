/** M45 §1/§2 native update channel. Rows are written only by the operator CLI
 * (updateChannelCli.ts); game traffic only reads the one row visible to it. */
import { desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../config';
import type { Db, DbOrTx } from '../db/client';
import { nativeUpdateChannel } from '../db/schema';
import { NativeUpdateOfferSchema, type NativeUpdateOffer } from './contracts';

const offer = NativeUpdateOfferSchema.shape;
/** CLI input. Strict: a misspelled key is a refusal, never a silently default field. */
export const NativeUpdateManifestSchema = z.object({
  // apkPath allows at most six digits, which the Caddy route also enforces.
  versionCode: offer.latestVersionCode.max(999_999),
  versionName: offer.versionName,
  sourceCommit: offer.sourceCommit,
  sha256: offer.sha256,
  sizeBytes: offer.sizeBytes,
  signerSha256: offer.signerSha256,
  channel: offer.channel,
  mandatory: z.boolean().default(false),
  notesUrl: offer.notesUrl.default(null),
  createdBy: z.string().trim().min(1).max(200),
}).strict();
export type NativeUpdateManifest = z.infer<typeof NativeUpdateManifestSchema>;

type OriginConfig = Partial<Pick<Config, 'PLAY_URL' | 'WEB_ORIGIN'>>;
export type NativeUpdateVisibilityConfig = OriginConfig & Partial<Pick<Config, 'NATIVE_PRESENTATION_WALLETS' | 'ADMIN_WALLETS'>>;
/** Returns the origin's Content-Length, or null when it has none. `false` skips (fixtures only). */
export type NativeUpdateOriginCheck = ((url: string) => Promise<number | null>) | false;
type Row = typeof nativeUpdateChannel.$inferSelect;

/** Stable refusal vocabulary; the CLI prints `code: message` and exits non-zero:
 * INVALID_MANIFEST, ORIGIN_UNAVAILABLE, ORIGIN_SIZE_MISMATCH, SIGNER_MISMATCH,
 * VERSION_NOT_GREATER, PROMOTION_REFUSED, NOT_FOUND, NO_PUBLIC_ORIGIN. */
export class NativeUpdateChannelError extends Error {
  constructor(readonly code: string, message: string) {
    super(`native update channel: ${message}`);
    this.name = 'NativeUpdateChannelError';
  }
}

export function toApkPath(versionCode: number, sha256: string): string {
  return `/native/releases/${versionCode}-${sha256}.apk`;
}

/** The codebase's canonical public origin (M45 §2); a PLAY_URL path never prefixes the APK route. */
export function publicApkUrl(config: OriginConfig, apkPath: string): string {
  const base = config.PLAY_URL ?? config.WEB_ORIGIN?.[0];
  if (!base) throw new NativeUpdateChannelError('NO_PUBLIC_ORIGIN', 'PLAY_URL or WEB_ORIGIN is required');
  return `${new URL(base).origin}${apkPath}`;
}

function toOffer(row: Row, config: OriginConfig): NativeUpdateOffer {
  return NativeUpdateOfferSchema.parse({
    latestVersionCode: row.versionCode, versionName: row.versionName, sourceCommit: row.sourceCommit,
    apkPath: row.apkPath, apkUrl: publicApkUrl(config, row.apkPath), sha256: row.sha256, sizeBytes: row.sizeBytes,
    signerSha256: row.signerSha256, publishedAt: row.publishedAt.toISOString(), storeStatus: row.storeStatus,
    channel: row.channel, mandatory: row.mandatory, notesUrl: row.notesUrl,
  });
}

/** §2 refusals: code strictly greater than the latest row (or an identical
 * tester->stable promotion), same signer as the latest row, origin bytes present. */
export async function publishNativeUpdate(db: Db, input: unknown,
  opts: { config: OriginConfig; originCheck: NativeUpdateOriginCheck }): Promise<NativeUpdateOffer> {
  const parsed = NativeUpdateManifestSchema.safeParse(input);
  if (!parsed.success) {
    throw new NativeUpdateChannelError('INVALID_MANIFEST',
      `invalid manifest: ${parsed.error.issues.map((issue) => issue.path.join('.') || issue.message).join(', ')}`);
  }
  const manifest = parsed.data;
  const apkPath = toApkPath(manifest.versionCode, manifest.sha256);
  if (opts.originCheck !== false) {
    const url = publicApkUrl(opts.config, apkPath);
    const length = await opts.originCheck(url);
    if (length !== manifest.sizeBytes) {
      throw new NativeUpdateChannelError('ORIGIN_SIZE_MISMATCH',
        `origin ${url} answered content-length ${length ?? 'none'}, manifest says ${manifest.sizeBytes}`);
    }
  }
  const row = await db.transaction(async (tx) => {
    // Plain SELECTs (capabilities) are not blocked; a concurrent publish is.
    await tx.execute(sql`LOCK TABLE native_update_channel IN EXCLUSIVE MODE`);
    const [latest] = await tx.select().from(nativeUpdateChannel).orderBy(desc(nativeUpdateChannel.versionCode)).limit(1);
    if (latest && latest.signerSha256 !== manifest.signerSha256) {
      throw new NativeUpdateChannelError('SIGNER_MISMATCH',
        `signer ${manifest.signerSha256} differs from latest code ${latest.versionCode} signer ${latest.signerSha256}`);
    }
    const [same] = await tx.select().from(nativeUpdateChannel).where(eq(nativeUpdateChannel.versionCode, manifest.versionCode));
    if (same) return promote(tx, same, manifest);
    if (latest && manifest.versionCode <= latest.versionCode) {
      throw new NativeUpdateChannelError('VERSION_NOT_GREATER',
        `code ${manifest.versionCode} is not greater than latest code ${latest.versionCode}`);
    }
    const [inserted] = await tx.insert(nativeUpdateChannel).values({
      versionCode: manifest.versionCode, versionName: manifest.versionName, sourceCommit: manifest.sourceCommit,
      apkPath, sha256: manifest.sha256, sizeBytes: manifest.sizeBytes, signerSha256: manifest.signerSha256,
      channel: manifest.channel, mandatory: manifest.mandatory, notesUrl: manifest.notesUrl, createdBy: manifest.createdBy,
    }).returning();
    return inserted!;
  });
  return toOffer(row, opts.config);
}

/** The only re-publish of an existing code: the identical file moving tester->stable
 * (optionally becoming mandatory). Anything else is a new release under a higher code. */
async function promote(tx: DbOrTx, row: Row, manifest: NativeUpdateManifest): Promise<Row> {
  const identical = row.sha256 === manifest.sha256 && row.versionName === manifest.versionName
    && row.sourceCommit === manifest.sourceCommit && row.sizeBytes === manifest.sizeBytes
    && row.signerSha256 === manifest.signerSha256 && row.notesUrl === manifest.notesUrl
    && (row.mandatory === manifest.mandatory || manifest.mandatory);
  if (!identical || row.channel !== 'tester' || manifest.channel !== 'stable') {
    throw new NativeUpdateChannelError('PROMOTION_REFUSED',
      `code ${manifest.versionCode} exists; only the identical ${row.channel} row may be promoted tester->stable`);
  }
  const [promoted] = await tx.update(nativeUpdateChannel)
    .set({ channel: 'stable', mandatory: manifest.mandatory || row.mandatory })
    .where(eq(nativeUpdateChannel.versionCode, row.versionCode)).returning();
  return promoted!;
}

/** Store publication is a one-way fact; repeating it is a no-op. */
export async function markNativeUpdatePublished(db: Db, versionCode: number, config: OriginConfig): Promise<NativeUpdateOffer> {
  const [row] = await db.update(nativeUpdateChannel).set({ storeStatus: 'published' })
    .where(eq(nativeUpdateChannel.versionCode, versionCode)).returning();
  if (!row) throw new NativeUpdateChannelError('NOT_FOUND', `no channel row for code ${versionCode}`);
  return toOffer(row, config);
}

export async function listNativeUpdates(db: DbOrTx, config: OriginConfig): Promise<NativeUpdateOffer[]> {
  const rows = await db.select().from(nativeUpdateChannel).orderBy(desc(nativeUpdateChannel.versionCode));
  return rows.map((row) => toOffer(row, config));
}

/** §1 visibility: stable rows to everyone; tester rows only to a session wallet in
 * NATIVE_PRESENTATION_WALLETS ∪ ADMIN_WALLETS. The highest visible code wins. */
export async function visibleNativeUpdate(db: DbOrTx, config: NativeUpdateVisibilityConfig,
  wallet: string | null): Promise<NativeUpdateOffer | null> {
  const tester = wallet !== null && (config.NATIVE_PRESENTATION_WALLETS?.includes(wallet) === true
    || config.ADMIN_WALLETS?.includes(wallet) === true);
  const [row] = await db.select().from(nativeUpdateChannel)
    .where(tester ? undefined : eq(nativeUpdateChannel.channel, 'stable'))
    .orderBy(desc(nativeUpdateChannel.versionCode)).limit(1);
  return row ? toOffer(row, config) : null;
}
