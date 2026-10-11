import { expect, it } from 'vitest';
import { PHASE_E_VEHICLES } from '@shardkeep/shared';
import { parseAdvancedServicePresentation } from '../src/game/advancedServicePresentation';

const berth = { id: '00000000-0000-4000-8000-000000000001', type: 'berth', level: 1 };
const construction = { id: '00000000-0000-4000-8000-000000000002', type: 'berth', level: 0, underConstruction: true };
const installed = { family: 'survey_balloon', tier: 2, away: false, completedTotal: '0', allowanceStart: '0' };
const facts = (installation: unknown = installed) => ({ version: 1, berths: [
  { buildingId: berth.id, installation }, { buildingId: construction.id, installation: null },
] });
it('keeps exact current construction-null closure independently of frozen and starter facts', () => {
  expect(parseAdvancedServicePresentation(facts(), [construction, berth])).toEqual({ version: 1, berths: [
    { buildingId: berth.id, installation: { family: 'survey_balloon', tier: 2, presence: 'occupied' } },
    { buildingId: construction.id, installation: null },
  ] });
  expect(parseAdvancedServicePresentation(null, [berth])).toBeNull();
  expect(parseAdvancedServicePresentation(facts(null), [berth, construction])!.berths.every(b => b.installation === null)).toBe(true);
});
it('maps applied allowance counters without inventing deadline returns or lifetime resets', () => {
  const limit = BigInt(PHASE_E_VEHICLES.completedUsesPerInstall);
  for (const [completedTotal, allowanceStart, away, presence] of [
    [String(limit), '0', false, 'exhausted'], [String(limit), '0', true, 'away'],
    [String(limit), String(limit), false, 'occupied'], [String(limit + 1n), String(limit), false, 'occupied'],
  ] as const) expect(parseAdvancedServicePresentation(facts({ ...installed, completedTotal, allowanceStart, away }), [berth, construction])!
    .berths[0]!.installation!.presence).toBe(presence);
});
it('fails malformed counters identities positive scaffolds or private payload fields', () => {
  for (const delta of [{ completedTotal: '-1' }, { completedTotal: '01' }, { allowanceStart: '1' },
    { completedTotal: String(PHASE_E_VEHICLES.completedUsesPerInstall + 1) }, { family: 'invented' }, { tier: 99 }, { assetId: 'private' }]) {
    expect(() => parseAdvancedServicePresentation(facts({ ...installed, ...delta }), [berth, construction])).toThrow();
  }
  for (const buildings of [[{ ...berth, underConstruction: true }, construction], [berth, berth, construction],
    [{ ...berth, underConstruction: 'false' }, construction], [berth]]) expect(() => parseAdvancedServicePresentation(facts(), buildings)).toThrow();
  expect(() => parseAdvancedServicePresentation({ ...facts(), berths: facts().berths.reverse() }, [berth, construction])).toThrow();
  expect(() => parseAdvancedServicePresentation(undefined, [berth])).toThrow();
});
