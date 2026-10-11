/** Pure strictness of the current advanced identity projection against its own appearance (no database). */
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { parseCurrentAdvancedIdentity } from '../src/game/currentAdvancedIdentity';

const berth = randomUUID(), other = randomUUID(), installed = randomUUID(), replacement = randomUUID();
const buildings = (...ids: string[]) => ids.map(id => ({ id, type: 'berth', level: 1, underConstruction: false }));
const appearance = (tier = 1, buildingId = berth, away = false) => ({ version: 1, berths: [{ buildingId,
  installation: { family: 'survey_balloon', tier, away, completedTotal: '0', allowanceStart: '0' } }] });
const identity = (installationId: string = installed, tier = 1, family = 'survey_balloon', buildingId = berth) =>
  ({ version: 1, berths: [{ buildingId, installation: { installationId, family, tier } }] });
const parse = (value: unknown, b: unknown = buildings(berth)) => parseCurrentAdvancedIdentity(value, b);

it('returns the unchanged appearance beside the exact same-berth installation identity', () => {
  const result = parse({ appearance: appearance(), identity: identity() });
  expect(result.presentation).toEqual({ version: 1, berths: [{ buildingId: berth, installation: { family: 'survey_balloon', tier: 1, presence: 'occupied' } }] });
  expect(result.identity).toEqual(identity());
  const away = parse({ appearance: appearance(2, berth, true), identity: identity(installed, 2) });
  expect(away.presentation!.berths[0]!.installation!.presence).toBe('away'); expect(away.identity!.berths[0]!.installation!.tier).toBe(2);
});

it('null appearance yields null optional identity; a lone sibling in either direction is corruption', () => {
  expect(parse({ appearance: null, identity: null })).toEqual({ presentation: null, identity: null });
  expect(() => parse({ appearance: null, identity: identity() })).toThrow('without an appearance');
  expect(() => parse({ appearance: appearance(), identity: null })).toThrow('without its identity');
  expect(() => parse({ appearance: appearance(), identity: identity(), extra: 1 })).toThrow();
});

it('refuses every disagreement with the same visual projection', () => {
  expect(() => parse({ appearance: appearance(), identity: identity(installed, 2) })).toThrow('differs');
  expect(() => parse({ appearance: appearance(), identity: identity(installed, 1, 'cargo_cutter') })).toThrow('differs');
  expect(() => parse({ appearance: appearance(), identity: identity(installed, 1, 'not_a_family') })).toThrow();
  expect(() => parse({ appearance: appearance(), identity: identity(installed, 1, 'survey_balloon', other) })).toThrow('differs');
  expect(() => parse({ appearance: appearance(), identity: { version: 1, berths: [{ buildingId: berth, installation: null }] } })).toThrow('differs');
  expect(() => parse({ appearance: appearance(), identity: { version: 1, berths: [] } })).toThrow('differs');
  expect(() => parse({ appearance: appearance(), identity: identity('not-a-uuid') })).toThrow();
  expect(() => parse({ appearance: appearance(), identity: { version: 1, berths: [{ buildingId: berth, installation: { installationId: installed, family: 'survey_balloon', tier: 1, presence: 'occupied' } }] } })).toThrow();
  // Two admitted berths (sorted, distinct families) whose identity rows repeat ONE installation id: only the duplicate guard refuses.
  const [first, second] = [berth, other].sort() as [typeof berth, typeof other]; // two known fixture UUIDs: erased tuple annotation only
  const two = { version: 1, berths: [appearance(1, first).berths[0]!,
    { buildingId: second, installation: { ...appearance().berths[0]!.installation, family: 'cargo_cutter' } }] };
  expect(parse({ appearance: two, identity: { version: 1, berths: [identity(installed, 1, 'survey_balloon', first).berths[0]!, identity(replacement, 1, 'cargo_cutter', second).berths[0]!] } }, buildings(first, second)).identity!.berths).toHaveLength(2);
  expect(() => parse({ appearance: two, identity: { version: 1, berths: [identity(installed, 1, 'survey_balloon', first).berths[0]!, identity(installed, 1, 'cargo_cutter', second).berths[0]!] } }, buildings(first, second)))
    .toThrow('Duplicate');
  // Mandatory appearance corruption still throws through the unchanged parser.
  expect(() => parse({ appearance: { version: 1, berths: [] }, identity: { version: 1, berths: [] } })).toThrow('differs from its buildings');
});

it('a same-family same-tier replacement is a different identity, never the same one', () => {
  const before = parse({ appearance: appearance(), identity: identity(installed) }).identity;
  const after = parse({ appearance: appearance(), identity: identity(replacement) }).identity;
  expect(before).not.toEqual(after);
  expect(before!.berths[0]!.installation!.installationId).not.toBe(after!.berths[0]!.installation!.installationId);
});
