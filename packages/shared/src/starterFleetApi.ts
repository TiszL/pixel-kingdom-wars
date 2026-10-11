/** D153.30 free starter installation; lazy transport, no departure authority. */
import { z } from 'zod';

export const STARTER_FLEET_FEATURE = { version: 1, receipts: 1 } as const;
export const StarterFleetUuidSchema = z.uuid().regex(/^[0-9a-f-]+$/);
const Timestamp = z.iso.datetime().refine(v => Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v);
const Wallet = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
export const StarterFleetRequestSchema = z.object({ idempotencyKey: StarterFleetUuidSchema,
  baseId: StarterFleetUuidSchema, berthId: StarterFleetUuidSchema }).strict();
export type StarterFleetRequest = z.infer<typeof StarterFleetRequestSchema>;
export const StarterFleetBerthSchema = z.object({ berthId: StarterFleetUuidSchema,
  completedBuildJobId: StarterFleetUuidSchema, berthCompletedAt: Timestamp }).strict();
export const StarterFleetInstallationSchema = z.object({ ...StarterFleetBerthSchema.shape,
  installationId: StarterFleetUuidSchema, baseId: StarterFleetUuidSchema, family: z.literal('starter'), installedAt: Timestamp,
}).strict().refine(v => Date.parse(v.installedAt) >= Date.parse(v.berthCompletedAt), 'Installation predates berth completion');
export type StarterFleetInstallation = z.infer<typeof StarterFleetInstallationSchema>;
export const StarterFleetReceiptSchema = z.object({ wallet: Wallet, request: StarterFleetRequestSchema,
  installation: StarterFleetInstallationSchema, acceptedAt: Timestamp,
}).strict().refine(v => v.request.baseId === v.installation.baseId && v.request.berthId === v.installation.berthId
  && Date.parse(v.acceptedAt) >= Date.parse(v.installation.installedAt), 'Receipt differs from original installation');
export type StarterFleetReceipt = z.infer<typeof StarterFleetReceiptSchema>;
const envelope = { wallet: Wallet, idempotencyKey: StarterFleetUuidSchema, serverNow: Timestamp };
export const StarterFleetEnvelopeSchema = z.discriminatedUnion('status', [
  z.object({ ...envelope, status: z.literal('unknown'), receipt: z.null() }).strict(),
  z.object({ ...envelope, status: z.literal('accepted'), receipt: StarterFleetReceiptSchema }).strict(),
]).refine(v => v.status === 'unknown' || v.wallet === v.receipt.wallet
  && v.idempotencyKey === v.receipt.request.idempotencyKey, 'Envelope differs from original actor/key');
export type StarterFleetEnvelope = z.infer<typeof StarterFleetEnvelopeSchema>;
export const StarterFleetViewSchema = z.object({ wallet: Wallet, baseId: StarterFleetUuidSchema, serverNow: Timestamp,
  features: z.object({ starterFleet: z.object({ version: z.literal(1), receipts: z.literal(1) }).strict() }).strict(),
  acceptingInstallations: z.boolean(), installation: StarterFleetInstallationSchema.nullable(),
  eligibleBerths: z.array(StarterFleetBerthSchema),
}).strict().refine(v => (!v.installation || v.installation.baseId === v.baseId
  && Date.parse(v.installation.installedAt) <= Date.parse(v.serverNow))
  && new Set(v.eligibleBerths.map(b => b.berthId)).size === v.eligibleBerths.length
  && v.eligibleBerths.every(b => Date.parse(b.berthCompletedAt) <= Date.parse(v.serverNow)
    && (!v.installation || b.berthId === v.installation.berthId
      && b.completedBuildJobId === v.installation.completedBuildJobId
      && b.berthCompletedAt === v.installation.berthCompletedAt)), 'Fleet must describe one completed base snapshot');
export type StarterFleetView = z.infer<typeof StarterFleetViewSchema>;
export function matchStarterFleetEnvelope(raw: unknown, wallet: string, original: StarterFleetRequest): StarterFleetEnvelope {
  const request = StarterFleetRequestSchema.parse(original), proof = StarterFleetEnvelopeSchema.parse(raw);
  if (proof.wallet !== wallet || proof.idempotencyKey !== request.idempotencyKey
    || proof.status === 'accepted' && JSON.stringify(proof.receipt.request) !== JSON.stringify(request))
    throw new Error('Starter fleet receipt differs from original command');
  return proof;
}
