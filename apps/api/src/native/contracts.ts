import {RaidAdvancedPresentationSchema} from '../game/raidAdvancedPresentation';
/** Native transport 1 remains a full replacement protocol. Explicit transport
 * 2 negotiates bounded immutable pages and a proven stable event prefix. Both
 * preserve the simulator's flat event records and canonical presentation clock. */
import { z } from 'zod';
import {RaidStarterPresentationSchema} from '../game/raidStarterPresentation';
import { FORGE_INGOT, GEMS, GEAR_MODIFIER_STATS, HERO_KEYS, HERO_LEVELING, LIVE_RAID, RAID_REPLAY_LIMITS } from '@shardkeep/shared';
import { isBaseVisualContext, REALM_IDS } from '@shardkeep/shared/baseVisual';
import { NativeBuildingHealthSchema } from './health';

export const NATIVE_PRESENTATION_PROTOCOL = 1;
export const NATIVE_MAX_WAIT_MS = 15_000;
export const NATIVE_PAGE_BYTES = 256 * 1024;
export const NATIVE_PAGE_AGE_MS = 120_000;
/** How a request identifies the Android app: exactly `X-PKW-Client: android-native`
 * (network/GameApi.kt stamps it on every call; feedbackOrigin.ts reads the same header). */
export const NATIVE_CLIENT_HEADER = 'x-pkw-client';
export const NATIVE_CLIENT_ANDROID = 'android-native';
/** Optional `X-PKW-Renderer-Contract: <int>` — the render-catalogue contract the
 * installed APK admits (native-compatibility.json rendererContractVersions max).
 * Every APK shipped through contract 14 predates the header, so a native request
 * WITHOUT it is a contract-14-or-older renderer. The value only selects which
 * published ground revision a presentation names (see clientPresentation.ts); it
 * never grants access, changes simulation input or enters an idempotency key. */
export const NATIVE_RENDERER_CONTRACT_HEADER = 'x-pkw-renderer-contract';
/** The first renderer contract whose catalogue carries the revision-5 realm kit
 * section (docs/REALM-KIT-PLAN.md E-8/E-12). An older native renderer asking for a
 * revision-5 base or raid is served the same realm at its published revision 4 —
 * never the artVersion-2 painting its own fallback would pick. Transport-level
 * like the protocol numbers above; if Phase E takes 15 first this becomes 16. */
export const NATIVE_REALM_KIT_RENDERER_CONTRACT = 15;
/** M45 §1: 300 MiB, mirrors the native client's download bound. Transport, not a game number. */
export const NATIVE_UPDATE_MAX_BYTES = 314_572_800;
const jsonObject = z.record(z.string(), z.json());
// Presentation identity is frozen independently of the deterministic snapshot.
// Optional on the wire so retained clients/archives keep their historical fallback.
// Revision 5 (the realm kit) is admitted here because the schema names what the
// SERVER may emit; a renderer below NATIVE_REALM_KIT_RENDERER_CONTRACT receives
// revision 4 instead through the client-presentation hook, not through this schema.
export const NativeVisualContextSchema = z.object({
  version: z.literal(1), realmId: z.enum(REALM_IDS),
  artVersion: z.union([z.literal(1), z.literal(2)]),
  groundRevision: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]).optional(),
}).refine(isBaseVisualContext);
export const NativeClockSchema = z.object({
  protocolVersion: z.union([z.literal(1), z.literal(2)]),
  revision: z.number().int().nonnegative(),
  rate: z.union([z.literal(1), z.literal(2)]),
  anchorWallAt: z.iso.datetime().nullable(),
  anchorSimMs: z.number().int().nonnegative(),
  serverNow: z.iso.datetime(),
  simNowMs: z.number().int().nonnegative(),
  battleEndsAt: z.iso.datetime().nullable(),
  durationMs: z.number().int().positive(),
});
export const NativeCommandSchema = z.object({
  sequence: z.number().int().nonnegative(),
  clientCommandId: z.string(),
  kind: z.enum(['deploy', 'hero', 'rally', 'buff', 'start', 'speed', 'retreat']),
  payload: jsonObject,
  serverOffsetMs: z.number().int().nonnegative(),
  acceptedAt: z.iso.datetime(),
});
/** Frozen sim HeroDeploy identity with the same public order fields, plus its
 * server-stamped research/loadout. No troop orders are duplicated in page state. */
export const NativeArchivedHeroOrdersSchema = z.object({
  heroDeploys: z.array(z.object({
    hero: z.enum(HERO_KEYS), tx: z.number().int(), ty: z.number().int(),
    tMs: z.number().int().nonnegative(),
    level: z.number().int().min(1).max(HERO_LEVELING.maxLevel).optional(),
    loadout: z.object({
      catalogRevision: z.number().int().nonnegative(), version: z.number().int().nonnegative(),
      hash: z.string().min(1).max(128),
      // Missing modifier keys mean zero in sim normalizedModifiers; preserve
      // that historical omission. Raw integers are clamped by the sim/display.
      modifiers: z.object(Object.fromEntries(GEAR_MODIFIER_STATS.map((key) => [key, z.number().int().optional()]))).strict(),
    }).strict().optional(),
  }).strict()).max(HERO_KEYS.length).refine(
    (orders) => new Set(orders.map((order) => order.hero)).size === orders.length,
    'one drop per hero',
  ),
}).strict();
export const NativePresentationSchema = z.object({
  protocolVersion: z.literal(NATIVE_PRESENTATION_PROTOCOL),
  raidId: z.uuid(),
  revision: z.string().regex(/^[0-9a-f]{64}$/),
  source: z.enum(['live', 'archive']),
  status: z.string(),
  simVersion: z.number().int().positive(),
  raidProtocolVersion: z.number().int().nullable(),
  clock: NativeClockSchema.nullable(),
  lastSequence: z.number().int().min(-1),
  snapshot: jsonObject,
  armySnapshot: jsonObject,
  /** Archived accepted hero orders preserve equipment HP even for a hero
   * scheduled after an early victory. Ordinary deploys remain in event pages. */
  orders: NativeArchivedHeroOrdersSchema.optional(),
  visualContext: NativeVisualContextSchema.optional(),
  servicePresentation: RaidStarterPresentationSchema.nullable().optional(),
  advancedServicePresentation: RaidAdvancedPresentationSchema.nullable().optional(),
  buildingHealth: z.array(NativeBuildingHealthSchema).optional(),
  commands: z.array(NativeCommandSchema),
  events: z.array(z.looseObject({ t: z.number().int().nonnegative(), e: z.string() })),
  // Live predictions never carry an economic result. Persisted archives and
  // the canonical pre-start retreat receipt are the only terminal results.
  result: z.json().nullable(),
  replaceFromTick: z.literal(0),
});
/** Protocol 2 pages are staged by clients until a whole immutable generation
 * arrives. state appears only on the first page; totalEvents counts the delta. */
export const NativePresentationStateSchema = NativePresentationSchema.omit({
  protocolVersion: true, raidId: true, revision: true, events: true, replaceFromTick: true,
});
export const NativePresentationPageSchema = z.object({
  protocolVersion: z.literal(2), raidId: z.uuid(),
  revision: z.string().regex(/^[0-9a-f]{64}$/),
  parentRevision: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  replaceFromTick: z.number().int().nonnegative(), generation: z.string().regex(/^[0-9a-f]{32}$/),
  eventOffset: z.number().int().nonnegative(), totalEvents: z.number().int().min(0).max(RAID_REPLAY_LIMITS.maxEvents),
  commandOffset: z.number().int().nonnegative(), totalCommands: z.number().int().min(0).max(LIVE_RAID.maxCommands),
  commands: z.array(NativeCommandSchema),
  events: NativePresentationSchema.shape.events,
  nextCursor: z.string().max(160).nullable(), state: NativePresentationStateSchema.nullable(),
});
/** M45 §1 frozen wire contract for one native update channel row. The client
 * resolves apkPath against its own API origin; apkUrl is informational. */
export const NativeUpdateOfferSchema = z.object({
  latestVersionCode: z.number().int().positive(),
  versionName: z.string().regex(/^\d+\.\d+\.\d+$/),
  sourceCommit: z.string().regex(/^[0-9a-f]{40}$/),
  apkPath: z.string().regex(/^\/native\/releases\/\d{1,6}-[0-9a-f]{64}\.apk$/),
  apkUrl: z.url(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  sizeBytes: z.number().int().min(1).max(NATIVE_UPDATE_MAX_BYTES),
  signerSha256: z.string().regex(/^[0-9a-f]{64}$/),
  publishedAt: z.iso.datetime(),
  storeStatus: z.enum(['pending', 'published']),
  channel: z.enum(['tester', 'stable']),
  mandatory: z.boolean(),
  notesUrl: z.url().refine((value) => new URL(value).protocol === 'https:').nullable(),
});
export type NativeUpdateOffer = z.infer<typeof NativeUpdateOfferSchema>;
export const NativeCapabilitiesSchema = z.object({
  protocolVersion: z.literal(1),
  sourceCommit: z.string(),
  simVersion: z.number().int().positive(),
  minimumVersionCode: z.number().int().nonnegative(),
  contentManifestUrl: z.url().nullable(),
  // Additive opt-in; older/legacy-renderer responses omit this permission.
  phaseEArt: z.object({ version: z.literal(1), enabled: z.boolean() }).optional(),
  presentation: z.object({
    enabled: z.boolean(),
    protocolVersions: z.array(z.union([z.literal(1), z.literal(2)])),
    raidProtocolVersions: z.array(z.literal(2)),
    supportsStablePrefix: z.boolean(),
    maxWaitMs: z.literal(NATIVE_MAX_WAIT_MS),
    maxPageBytes: z.literal(NATIVE_PAGE_BYTES),
    maxEvents: z.literal(RAID_REPLAY_LIMITS.maxEvents),
    maxCommands: z.literal(LIVE_RAID.maxCommands),
    maxPageAgeMs: z.literal(NATIVE_PAGE_AGE_MS),
  }),
  notifications: z.object({ enabled: z.literal(false) }),
  // D-152 / E2-GEMS-CONTRACT §4 (additive, protocolVersion stays 1): whether the
  // server charges Gems and where a wallet-KEEP "Get Gems" transfer goes.
  economy: z.object({
    gameCurrency: z.object({ version: z.literal(1), exactSpendCurrency: z.literal(1) }),
    workshop: z.object({ enabled: z.boolean(), recipeVersion: z.literal(FORGE_INGOT.recipeVersion) }),
    gems: z.object({
      exactConsent: z.literal(1).optional(),
      enabled: z.boolean(),
      sources: z.array(z.enum(['ledger-keep', 'wallet-keep', 'store'])),
      destinationAta: z.string().nullable(),
      gemsPerKeep: z.literal(GEMS.gemsPerKeep),
      shardsPerGem: z.literal(GEMS.shardsPerGem),
      minConvertKeep: z.literal(GEMS.minConvertKeep),
      maxConvertKeepPerTx: z.literal(GEMS.maxConvertKeepPerTx),
    }),
  }),
  // M45 §1 / D-153.47 (additive, protocolVersion stays 1): present only when the
  // channel flag is on AND a row is visible to the caller; otherwise ABSENT, never null.
  update: NativeUpdateOfferSchema.optional(),
  // D-180 (additive, protocolVersion stays 1): the native new-world kill switch.
  // Optional here so older fixtures parse; this server always sends it. A client
  // runs the new world unless it reads enabled === false.
  worldV2: z.object({ enabled: z.boolean() }).optional(),
});
