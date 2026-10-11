import {parseRaidAdvancedPresentation,type RaidAdvancedPresentation} from './raidAdvancedPresentation';
import {parseRaidStarterPresentation,type RaidStarterPresentation} from './raidStarterPresentation';
import {BoundCosmeticBaseReadSchema,type BoundCosmeticBaseRead} from '@shardkeep/shared/boundCosmeticVisual';
/** Immutable compact replay archive for deed battle history. */
import { createHash } from 'node:crypto';
import {
  brotliCompressSync,
  brotliDecompressSync,
  constants as zlibConstants,
} from 'node:zlib';
import { BATTLE_HISTORY } from '@shardkeep/shared';
import type { SimEvent } from '@shardkeep/sim';
import { isBaseVisualContext, type BaseVisualContext } from '@shardkeep/shared/baseVisual';
import type { ReplayBuildingHealth } from './raidReplayHealth';
import type { DbOrTx } from '../db/client';
import { raidReplayTimelines } from '../db/schema';

export interface EncodedReplayTimeline {
  formatVersion: number;
  codec: string;
  timeline: Buffer;
  byteLength: number;
  eventCount: number;
  durationMs: number;
  sha256: string;
}

/** Everything required to reproduce and audit one resolved battle. The archive
 * hashes these fields together so a snapshot/order/result edit cannot be paired
 * with an otherwise-valid event stream. */
export interface ReplayArchiveEnvelope {
  snapshot: unknown;
  /** Absent on old envelopes; do not rewrite historical simulator inputs. */
  visualContext?: BaseVisualContext;
  /** Frozen at original raid insertion, separate from simulator input. */
  boundCosmeticVisual?: BoundCosmeticBaseRead;
  servicePresentation?: RaidStarterPresentation|null;
  advancedServicePresentation?: RaidAdvancedPresentation|null;
  armySnapshot: unknown;
  orders: unknown;
  seed: number;
  simVersion: number;
  events: readonly SimEvent[];
  result: unknown;
  /** New archives only; older immutable envelopes intentionally omit it. */
  buildingHealth?: ReplayBuildingHealth[] | undefined;
}

export function encodeReplayTimeline(
  envelope: ReplayArchiveEnvelope, durationMs: number,
): EncodedReplayTimeline {
  if (!Number.isInteger(durationMs) || durationMs < 0) {
    throw new RangeError('replay duration must be non-negative integer milliseconds');
  }
  if (!Number.isSafeInteger(envelope.seed) || !Number.isInteger(envelope.simVersion)) {
    throw new RangeError('replay seed and simulator version must be integers');
  }
  if (envelope.visualContext !== undefined && !isBaseVisualContext(envelope.visualContext)) {
    throw new Error('replay visual context is invalid');
  }
  if (envelope.boundCosmeticVisual !== undefined) BoundCosmeticBaseReadSchema.parse(envelope.boundCosmeticVisual);
  parseRaidStarterPresentation(envelope.servicePresentation,envelope.snapshot);
  parseRaidAdvancedPresentation(envelope.advancedServicePresentation,envelope.snapshot);
  const source = Buffer.from(JSON.stringify(envelope), 'utf8');
  const timeline = brotliCompressSync(source, {
    params: {
      [zlibConstants.BROTLI_PARAM_QUALITY]: BATTLE_HISTORY.replayCompressionQuality,
    },
  });
  return {
    formatVersion: BATTLE_HISTORY.replayFormatVersion,
    codec: BATTLE_HISTORY.replayCodec,
    timeline,
    byteLength: timeline.byteLength,
    eventCount: envelope.events.length,
    durationMs,
    sha256: createHash('sha256').update(timeline).digest('hex'),
  };
}

export function decodeReplayTimeline(encoded: EncodedReplayTimeline): ReplayArchiveEnvelope {
  if (encoded.formatVersion !== BATTLE_HISTORY.replayFormatVersion
    || encoded.codec !== BATTLE_HISTORY.replayCodec
    || encoded.byteLength !== encoded.timeline.byteLength
    || createHash('sha256').update(encoded.timeline).digest('hex') !== encoded.sha256) {
    throw new Error('replay timeline integrity check failed');
  }
  const value: unknown = JSON.parse(brotliDecompressSync(encoded.timeline).toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !Array.isArray((value as ReplayArchiveEnvelope).events)
    || (value as ReplayArchiveEnvelope).events.length !== encoded.eventCount) {
    throw new Error('replay timeline event count mismatch');
  }
  const envelope = value as ReplayArchiveEnvelope;
  if (envelope.visualContext !== undefined && !isBaseVisualContext(envelope.visualContext)) {
    throw new Error('replay visual context is invalid');
  }
  if (envelope.boundCosmeticVisual !== undefined) BoundCosmeticBaseReadSchema.parse(envelope.boundCosmeticVisual);
  parseRaidStarterPresentation(envelope.servicePresentation,envelope.snapshot);
  parseRaidAdvancedPresentation(envelope.advancedServicePresentation,envelope.snapshot);
  return envelope;
}

export async function persistReplayTimeline(
  tx: DbOrTx, raidId: string, envelope: ReplayArchiveEnvelope, durationMs: number,
): Promise<EncodedReplayTimeline> {
  const encoded = encodeReplayTimeline(envelope, durationMs);
  await tx.insert(raidReplayTimelines).values({ raidId, ...encoded }).onConflictDoNothing();
  return encoded;
}
