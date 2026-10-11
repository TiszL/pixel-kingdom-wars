import { describe, expect, it, vi } from 'vitest';
import { withInitialFreeMiningFixture as fixture } from './fixtures/initialFreeMining';

describe('first-free scoring uses only its declared complete XP range', () => {
 it.each(['2019-12-31T00:00:00.000001Z', '2019-12-31T00:00:00.000999Z'])('excludes actual partial-day awards with coverage at %s and preserves the original journals', async sourceCoverageAt => fixture(async f => {
  await f.battle('2019-12-31', false, '2019-12-31T14:00:00Z');
  await f.reserve('2020-01-01'); await f.battle('2020-01-01'); await f.clock(null);
  await f.collect('2019-12-31'); await f.collect('2020-01-01');
  const journals = await f.conn.sql`select day::text,result_hash from mining_wallet_experience_days order by day`;
  expect((await f.conn.sql`select sum(points)::int total from mining_wallet_experience_awards where wallet=${f.wallet}`)[0]!.total).toBe(200);
  const result = await f.evaluate('2020-01-01');
  expect(result).toMatchObject({ reason: 'qualified', eligibleUnits: 1, recordedXp: 100, experienceBps: 238,
   experienceCoverage: { fromDay: '2020-01-01', throughDay: '2020-01-01', partialBirthDayExcluded: true } });
  vi.stubEnv('PHASE_E_MINING_ENABLED', 'false');
  expect(await f.evaluate('2020-01-01')).toEqual(result);
  expect(await f.conn.sql`select day::text,result_hash from mining_wallet_experience_days order by day`).toEqual(journals);
  expect((await f.conn.sql`select sum(points)::int total from mining_wallet_experience_awards where wallet=${f.wallet}`)[0]!.total).toBe(200);
 }, { sourceCoverageAt, birthAt: '2019-12-31T12:00:00Z' }), 30_000);
 it('keeps the existing refusal of an ordinary partial day and scores the next full day', async () => fixture(async f => {
  await f.battle('2019-12-31', false, '2019-12-31T14:00:00Z');
  await f.reserve('2020-01-01'); await f.battle('2020-01-01'); await f.clock(null);
  await expect(f.collect('2019-12-31')).rejects.toMatchObject({ code: 'COVERAGE_UNAVAILABLE' });
  await f.collect('2020-01-01');
  expect(await f.evaluate('2020-01-01')).toMatchObject({ recordedXp: 100, experienceCoverage: { fromDay: '2020-01-01', partialBirthDayExcluded: true } });
 }, { sourceCoverageAt: '2019-12-31T06:00:00Z', birthAt: '2019-12-31T12:00:00Z' }), 30_000);
});
