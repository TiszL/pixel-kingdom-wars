/** Response wiring only: source freshness/custody is proven by the separate real
 * collector tests. A mock capability here never establishes economic authority. */
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FleetJourneyEvent } from '@shardkeep/shared/fleetJourneyPresentation';
import { registerAdvancedExpeditionGameplay, type AdvancedExpeditionGameplayProvider } from '../src/game/advancedExpeditionGameplay';

const baseId = '00000000-0000-4000-8000-000000000001';
const event: FleetJourneyEvent = {
  version: 1, kind: 'return', baseId, berthId: '00000000-0000-4000-8000-000000000002',
  installationId: '00000000-0000-4000-8000-000000000003',
  expeditionId: '00000000-0000-4000-8000-000000000004',
  returnId: '00000000-0000-4000-8000-000000000005', at: '2026-10-01T03:52:08.000Z',
  vehicle: { family: 'survey_balloon', tier: 1 }, wake: { state: 'legacy', visual: null },
};
const body = () => ({ baseId, player: { wallet: 'actor', extra: 'preserved' }, stock: 'untouched',
  advancedServicePresentation: { version: 1, berths: [{ buildingId: event.berthId,
    installation: { family: 'survey_balloon', tier: 1, presence: 'occupied' } }] },
  // CONTINUITY: the SAME response's current installed identity; the callback animates only when it names the event's installation.
  advancedFleetIdentity: { version: 1, berths: [{ buildingId: event.berthId,
    installation: { installationId: event.installationId, family: 'survey_balloon', tier: 1 } }] } });
const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); vi.unstubAllEnvs(); });

async function open(provider: AdvancedExpeditionGameplayProvider, output: unknown = body(), status = 200) {
  vi.stubEnv('MULTI_BASE_ENABLED', 'true');
  const app = Fastify(); apps.push(app); app.decorateRequest('wallet', '');
  registerAdvancedExpeditionGameplay(app, provider);
  app.get('/base', { preHandler: async req => { req.wallet = 'actor'; } }, async (req, reply) => {
    expect(req.query).toEqual({ baseId });
    return reply.code(status).send(output);
  });
  await app.ready(); return app;
}
const provider = (): AdvancedExpeditionGameplayProvider => ({
  collectForBaseRead: vi.fn(async () => baseId),
  collectForBaseReadPresentation: vi.fn(async () => ({ baseId, events: [event] })),
});

describe('advanced fresh return response attachment', () => {
  it('preserves the legacy provider response without inventing a presentation callback', async () => {
    const legacy = { collectForBaseRead: vi.fn(async () => baseId) }, app = await open(legacy);
    const response = await app.inject('/base');
    expect(response.statusCode).toBe(200); expect(response.json()).toEqual(body());
    expect(legacy.collectForBaseRead).toHaveBeenCalledExactlyOnceWith('actor', undefined);
  });

  it('merges actual capability callbacks with starter siblings once, preserving unrelated response fields', async () => {
    const source = provider(), starter = { ...event, vehicle: { family: 'starter' },
      returnId: '00000000-0000-4000-8000-000000000006' };
    vi.mocked(source.collectForBaseReadPresentation!).mockResolvedValueOnce({ baseId, events: [event] })
      .mockResolvedValueOnce({ baseId, events: [] });
    const original = { ...body(), fleetJourneyEvents: { version: 1, events: [starter] } };
    const app = await open(source, original), response = await app.inject('/base');
    expect(response.json()).toEqual({ ...original, fleetJourneyEvents: { version: 1, events: [starter, event] } });
    expect(source.collectForBaseRead).not.toHaveBeenCalled();
    expect((await app.inject('/base')).json()).toEqual(original);
  });

  it('drops callbacks after changed ownership, tier, departure, unavailable current presentation or a missing, null or replaced installation identity', async () => {
    const variants = [
      { ...body(), baseId: '00000000-0000-4000-8000-000000000007' },
      { ...body(), player: { wallet: 'buyer' } },
      { ...body(), advancedServicePresentation: null },
      // CONTINUITY: no identity sibling, a null one, or one naming a replacement installation — the same berth/family/tier appearance
      // alone never animates an arrival (a separate fleet read or the event itself cannot fill the identity).
      { ...body(), advancedFleetIdentity: undefined },
      { ...body(), advancedFleetIdentity: null },
      { ...body(), advancedFleetIdentity: { version: 1, berths: [{ buildingId: event.berthId,
        installation: { installationId: '00000000-0000-4000-8000-000000000008', family: 'survey_balloon', tier: 1 } }] } },
      ...[{ tier: 2, presence: 'occupied' }, { tier: 1, presence: 'away' }].map(change => ({ ...body(),
        advancedServicePresentation: { version: 1, berths: [{ buildingId: event.berthId,
          installation: { family: 'survey_balloon', ...change } }] } })),
    ];
    for (const output of variants) {
      const app = await open(provider(), output), response = await app.inject('/base');
      expect(response.statusCode).toBe(200); expect(response.json()).toEqual(output);
    }
  });

  it('does not attach a committed callback to an unsuccessful base read', async () => {
    const error = { error: { message: 'base no longer owned' } }, app = await open(provider(), error, 404);
    const response = await app.inject('/base');
    expect(response.statusCode).toBe(404); expect(response.json()).toEqual(error);
  });
});
