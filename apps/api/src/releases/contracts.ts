/** M47 §5 release-feed wire contracts. The website's /changelog and /download
 * Functions consume the two response schemas; the deploy-time recorder accepts the
 * manifest schema. Every limit comes from RELEASE_FEED in @shardkeep/shared. */
import { z } from 'zod';
import { RELEASE_FEED } from '@shardkeep/shared';
import { NATIVE_UPDATE_MAX_BYTES } from '../native/contracts';

export const RELEASE_CATEGORIES = ['new', 'improved', 'fixed', 'balance', 'android', 'world'] as const;
export const RELEASE_PLATFORMS = ['all', 'web', 'android'] as const;

const GIT_SHA = /^[0-9a-f]{40}$/;
/** Curated fragment ids: `YYYY-MM-DD-<slug>` (unreleased/, history/) or `android-<code>`. */
export const FRAGMENT_ID = /^(?:\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*|android-[1-9]\d{0,5})$/;
/** Entry ids also admit the recorder's own `maintenance-<short sha>` line, never a fragment. */
const ENTRY_ID = /^(?:\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*|android-[1-9]\d{0,5}|maintenance-[0-9a-f]{8})$/;
/** Plain single-line text only: no markup or control character can reach a page
 * that renders these lines (the collector folds a fragment body onto one line). */
const PLAIN = /^[^<>\u0000-\u001f\u007f]*$/;

export const ReleaseEntrySchema = z.object({
  id: z.string().max(96).regex(ENTRY_ID),
  category: z.enum(RELEASE_CATEGORIES),
  platforms: z.enum(RELEASE_PLATFORMS),
  title: z.string().trim().min(1).max(RELEASE_FEED.titleMaxChars).regex(PLAIN),
  body: z.string().trim().min(1).max(RELEASE_FEED.bodyMaxChars).regex(PLAIN),
}).strict();
export type ReleaseEntry = z.infer<typeof ReleaseEntrySchema>;

const FragmentEntrySchema = ReleaseEntrySchema.extend({ id: z.string().max(96).regex(FRAGMENT_ID) }).strict();

/** What infra/deploy.sh pipes in (scripts/src/release-notes-collect.ts builds it).
 * Strict: a misspelled key is a refusal, never a silently dropped field. */
export const ReleaseManifestSchema = z.object({
  gitSha: z.string().regex(GIT_SHA),
  /** Fragments present at gitSha (unreleased/ + android/) whose `requires` flag is on. */
  fragments: z.array(FragmentEntrySchema).max(200),
  /** Fragments present at gitSha whose flag is off: listed, never claimed. */
  skipped: z.array(z.object({ id: z.string().max(96).regex(FRAGMENT_ID), requires: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/) }).strict())
    .max(200).default([]),
  /** Curated backfill (history/), grouped per deployed sha. */
  history: z.array(z.object({
    gitSha: z.string().regex(GIT_SHA),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    simVersion: z.number().int().positive().max(100_000),
    deployedAt: z.iso.datetime(),
    entries: z.array(FragmentEntrySchema).min(1).max(RELEASE_FEED.maxEntriesPerRelease),
  }).strict()).max(500).default([]),
}).strict();
export type ReleaseManifest = z.infer<typeof ReleaseManifestSchema>;

export const PublicReleaseSchema = z.object({
  gitSha: z.string().regex(GIT_SHA),
  shortSha: z.string().regex(/^[0-9a-f]{8}$/),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  simVersion: z.number().int().positive(),
  deployedAt: z.iso.datetime(),
  kind: z.enum(['deploy', 'backfill']),
  entries: z.array(ReleaseEntrySchema).min(1).max(RELEASE_FEED.maxEntriesPerRelease),
}).strict();
export type PublicRelease = z.infer<typeof PublicReleaseSchema>;

export const PublicReleasesResponseSchema = z.object({
  releases: z.array(PublicReleaseSchema).max(RELEASE_FEED.maxLimit),
  /** The running build, even after a manual image rollback that bypassed deploy.sh. */
  live: z.object({ gitSha: z.string().min(1).max(64), version: z.string().min(1).max(64), builtAt: z.iso.datetime().nullable() }).strict(),
  generatedAt: z.iso.datetime(),
}).strict();
export type PublicReleasesResponse = z.infer<typeof PublicReleasesResponseSchema>;

export const PublicAndroidReleaseSchema = z.object({
  versionCode: z.number().int().positive().max(999_999),
  versionName: z.string().regex(/^\d+\.\d+\.\d+$/),
  sizeBytes: z.number().int().min(1).max(NATIVE_UPDATE_MAX_BYTES),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  signerSha256: z.string().regex(/^[0-9a-f]{64}$/),
  publishedAt: z.iso.datetime(),
  apkPath: z.string().regex(/^\/native\/releases\/\d{1,6}-[0-9a-f]{64}\.apk$/),
  notesUrl: z.url().refine((value) => new URL(value).protocol === 'https:').nullable(),
}).strict();
export type PublicAndroidRelease = z.infer<typeof PublicAndroidReleaseSchema>;

export const PublicAndroidResponseSchema = z.object({
  stable: PublicAndroidReleaseSchema.nullable(),
  /** Every stable row, newest first (the current one included); never a tester row. */
  history: z.array(PublicAndroidReleaseSchema).max(RELEASE_FEED.androidHistoryMax),
  minimumVersionCode: z.number().int().nonnegative(),
  generatedAt: z.iso.datetime(),
}).strict();
export type PublicAndroidResponse = z.infer<typeof PublicAndroidResponseSchema>;

/** Unknown query keys are ignored (a cache-buster must not turn into a 400). */
export const ReleasesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(RELEASE_FEED.maxLimit).default(RELEASE_FEED.defaultLimit),
});
