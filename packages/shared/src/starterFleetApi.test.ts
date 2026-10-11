import { describe, expect, it } from 'vitest';
import { matchStarterFleetEnvelope, StarterFleetEnvelopeSchema, StarterFleetRequestSchema,
  StarterFleetViewSchema } from './starterFleetApi';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const wallet = '11111111111111111111111111111111', at = '2026-09-22T12:00:00.000Z';
const request = { idempotencyKey: id(1), baseId: id(2), berthId: id(3) };
const installation = { installationId: id(4), baseId: id(2), berthId: id(3), family: 'starter',
  completedBuildJobId: id(5), berthCompletedAt: at, installedAt: at };
const proof = { wallet, idempotencyKey: id(1), serverNow: at, status: 'accepted',
  receipt: { wallet, request, installation, acceptedAt: at } };
describe('starter installation public contract', () => {
  it('accepts only explicit canonical ids, never client authority or custody', () => {
    expect(StarterFleetRequestSchema.parse(request)).toEqual(request);
    for (const extra of [{ wallet }, { family: 'starter' }, { completed: true }, { capacity: 1 }])
      expect(StarterFleetRequestSchema.safeParse({ ...request, ...extra }).success).toBe(false);
    expect(StarterFleetRequestSchema.safeParse({ ...request, berthId: 'ABCDEF00-0000-4000-8000-000000000003' }).success).toBe(false);
  });
  it('binds actor/key/base/berth and does not accept changed historical proof', () => {
    expect(matchStarterFleetEnvelope(proof, wallet, request)).toEqual(proof);
    for (const original of [{ ...request, berthId: id(6) }, { ...request, baseId: id(7) }, { ...request, idempotencyKey: id(8) }])
      expect(() => matchStarterFleetEnvelope(proof, wallet, original)).toThrow();
    expect(() => matchStarterFleetEnvelope(proof, `${wallet}1`, request)).toThrow();
    expect(StarterFleetEnvelopeSchema.safeParse({ ...proof, receipt: { ...proof.receipt,
      installation: { ...installation, installedWallet: wallet } } }).success).toBe(false);
  });
  it('unknown has no receipt and acceptance cannot predate installation', () => {
    expect(StarterFleetEnvelopeSchema.safeParse({ ...proof, status: 'unknown', receipt: null }).success).toBe(true);
    expect(StarterFleetEnvelopeSchema.safeParse({ ...proof, status: 'unknown' }).success).toBe(false);
    expect(StarterFleetEnvelopeSchema.safeParse({ ...proof, receipt: { ...proof.receipt, acceptedAt: '2026-09-21T12:00:00.000Z' } }).success).toBe(false);
  });
  it('a current starter cannot advertise a second berth or another base', () => {
    const berth = { berthId: id(3), completedBuildJobId: id(5), berthCompletedAt: at };
    const view = { wallet, baseId: id(2), serverNow: at, features: { starterFleet: { version: 1, receipts: 1 } },
      acceptingInstallations: false, installation, eligibleBerths: [berth] };
    expect(StarterFleetViewSchema.safeParse(view).success).toBe(true);
    for (const changed of [{ ...view, baseId: id(9) }, { ...view, eligibleBerths: [berth, berth] },
      { ...view, eligibleBerths: [{ ...berth, berthId: id(9) }] }]) expect(StarterFleetViewSchema.safeParse(changed).success).toBe(false);
  });
});
