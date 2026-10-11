/**
 * The owner-approved 30/minute shield is shared by /start and /speed. Fastify
 * otherwise creates one store key per route, which silently doubles it.
 */
import { readFileSync } from 'node:fs';
import rateLimit from '@fastify/rate-limit';
import { LIVE_RAID } from '@shardkeep/shared';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { RAID_CLOCK_CONTROL_RATE_LIMIT } from '../src/game/routes';

describe('raid clock control rate limit', () => {
  it('is one grouped budget wired to both production routes', () => {
    expect(RAID_CLOCK_CONTROL_RATE_LIMIT).toEqual({
      max: LIVE_RAID.controlRateLimitPerMin,
      timeWindow: LIVE_RAID.controlRateLimitWindowMs,
      groupId: 'raid-clock-control',
    });
    const source = readFileSync(new URL('../src/game/routes.ts', import.meta.url), 'utf8');
    expect(source).toContain('app.rateLimit(RAID_CLOCK_CONTROL_RATE_LIMIT)');
    expect(source.match(/app\.post\('\/raids\/:id\/(?:start|speed)', raidClockControlRoute/g))
      .toHaveLength(2);
  });

  it('429s the combined 31st alternating start/speed request', async () => {
    const app = Fastify();
    await app.register(rateLimit, { global: false });
    const sharedLimit = app.rateLimit(RAID_CLOCK_CONTROL_RATE_LIMIT);
    const options = { config: { rateLimit: false as const }, preHandler: sharedLimit };
    app.post('/start', options, async () => ({ ok: true }));
    app.post('/speed', options, async () => ({ ok: true }));
    await app.ready();
    try {
      const statuses: number[] = [];
      for (let i = 0; i <= LIVE_RAID.controlRateLimitPerMin; i++) {
        const response = await app.inject({
          method: 'POST',
          url: i % 2 === 0 ? '/start' : '/speed',
        });
        statuses.push(response.statusCode);
      }
      expect(statuses.slice(0, LIVE_RAID.controlRateLimitPerMin))
        .toEqual(Array(LIVE_RAID.controlRateLimitPerMin).fill(200));
      expect(statuses.at(-1)).toBe(429);
    } finally {
      await app.close();
    }
  });
});
