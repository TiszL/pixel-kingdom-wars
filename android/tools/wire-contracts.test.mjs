import test from 'node:test';
import assert from 'node:assert/strict';
import { validateWire, kotlinModels, endpoints } from './wire-contracts.mjs';

test('pending MFA cannot be misread as a complete login', () => {
  assert.equal(validateWire('LoginStatus', { loginRequired: true, wallet: 'wallet' }).loginRequired, true);
  assert.throws(() => validateWire('LoginStatus', {}), /missing/);
  assert.throws(() => validateWire('LoginStatus', { loginRequired: 'false' }), /type/);
});
test('schema supports additive fields but rejects changed required wire types', () => {
  validateWire('Version', { version: '0.3.3', gitSha: 'a', builtAt: 'date', simVersion: 14, newField: true });
  assert.throws(() => validateWire('Version', { version: '0.3.3', gitSha: 'a', builtAt: 'date', simVersion: '14' }));
});
test('generated models preserve nullable optional fields without guessing balances', () => {
  const kotlin = kotlinModels('a'.repeat(40));
  assert.match(kotlin, /val baseId: String\? = null/);
  assert.match(kotlin, /val buildings: List<BuildingDto>/);
  assert.match(kotlin, /val loginRequired: Boolean,/);
  assert.match(kotlin, /val builtAt: String\?,/);
  assert.doesNotMatch(kotlin, /val builtAt: String\? = null/);
});
test('unstamped builds explicitly carry null rather than losing a required version field', () => {
  validateWire('Version', { version: 'dev', gitSha: 'dev', builtAt: null, simVersion: 14 });
  assert.throws(() => validateWire('Version', { version: 'dev', gitSha: 'dev', simVersion: 14 }), /missing/);
});

test('source DTO extensions keep required nulls distinct from absent optional fields and preserve wide integers', () => {
  const kotlin = kotlinModels('source', { NativeExample: { type: 'object', required: ['clock', 'sequence', 'records'], properties: {
    clock: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    optional: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    sequence: { type: 'integer', maximum: Number.MAX_SAFE_INTEGER },
    records: { type: 'array', items: { type: 'object', additionalProperties: {} } },
  } } });
  assert.match(kotlin, /val clock: String\?,/);
  assert.doesNotMatch(kotlin, /val clock: String\? = null/);
  assert.match(kotlin, /val optional: String\? = null/);
  assert.match(kotlin, /val sequence: Long,/);
  assert.match(kotlin, /val records: List<JsonElement>,/);
});

test('contract 13 curated DTOs carry visual context, training v2 consent references and fantasy parcels', () => {
  const consent = { TrainingScheduleConsent: { type: 'object', properties: { version: { type: 'number', const: 2 } }, required: ['version'] },
    TrainingFinishAllConsent: { type: 'object', properties: { maxCostKeep: { type: 'string' } }, required: ['maxCostKeep'] } };
  const visual = { version: 1, realmId: 'crownlands', artVersion: 2 };
  validateWire('Base', { baseId: null, visualContext: visual, player: {}, claim: {}, buildings: [], jobs: [], army: [], freeBuilders: 1 });
  assert.throws(() => validateWire('Base', { baseId: null, player: {}, claim: {}, buildings: [], jobs: [], army: [], freeBuilders: 1 }), /visualContext: missing/);
  assert.throws(() => validateWire('BaseVisualContext', { ...visual, realmId: 'earth' }), /enum/);
  assert.throws(() => validateWire('BaseVisualContext', { ...visual, version: 2 }), /constant/);
  validateWire('BaseVisualContext', {...visual, groundRevision:1});
  validateWire('BaseVisualContext', {...visual, realmId:'frostveil', groundRevision:2});
  validateWire('BaseVisualContext',{...visual,groundRevision:3});
  assert.throws(()=>validateWire('BaseVisualContext',{...visual,groundRevision:4}),/enum/);
  assert.throws(()=>validateWire('BaseVisualContext',{...visual,groundRevision:'1'}),/type/);
  const army = { counts: {}, levels: {}, research: [], queue: [], rosterPts: 0, queuedPts: 0, campCapacityPts: 1, barracksQueuePts: 1, unsupportedTroops: [], eliteUnlocks: {},
    finishAllQuote: { version: 2, queue: [], maxCostKeep: '0' }, features: { trainingScheduling: { version: 2, mode: 'sequential', lanes: 1, consentRequired: true },
      researchConsent: { version: 1 }, darkAttackerRoster: { enabled: true, code: 'active', message: 'AVAILABLE' } },
    freeFinishAllOffer: { offer: 'first_troops', consent: { version: 2, queue: [], maxCostKeep: '0' } }, freeFinishAllReceipt: null, freeFinishAllReviewRequired: false };
  validateWire('ArmyState', army, consent);
  assert.throws(() => validateWire('ArmyState', { ...army, freeFinishAllOffer: { offer: 'later', consent: army.finishAllQuote } }, consent), /no wire variant matched/);
  assert.throws(() => validateWire('ArmyState', army), /unknown wire schema reference/);
  validateWire('FantasyParcel', { worldId: 'fantasy-v1', tile: { worldId: 'fantasy-v1', tileId: 7, realmId: 'crownlands', allocation: 'ordinary', lon: 1.5, lat: 2.5 }, availability: 'available', detail: null });
  assert.throws(() => validateWire('FantasyParcel', { worldId: 'fantasy-v1', tile: { worldId: 'fantasy-v1', tileId: 7, realmId: 'crownlands', allocation: 'ordinary', lon: 1.5, lat: 2.5 }, availability: 'sold', detail: null }), /enum/);
  const kotlin = kotlinModels('source', consent);
  assert.match(kotlin, /data class BaseDto\([^)]*val visualContext: BaseVisualContextDto,/s);
  assert.match(kotlin, /data class BaseVisualContextDto\([^)]*val groundRevision: Int\? = null,/s);
  assert.match(kotlin, /data class ArmyStateDto\([^)]*val finishAllQuote: TrainingFinishAllConsentDto,[^)]*val freeFinishAllOffer: TrainingFreeFinishOfferDto\?,/s);
  assert.match(kotlin, /data class TrainingBatchBodyDto\([^)]*val consent: TrainingScheduleConsentDto\? = null,/s);
  assert.match(kotlin, /data class TrainingSpeedupBodyDto\([^)]*val freeOffer: String\? = null,/s);
  assert.match(kotlin, /data class BattleReplayDto\([^)]*val seed: Long,/s);
  assert.match(kotlin, /data class BaseSummaryDto\([^)]*val fantasyLocation: FantasyTileDto\?,/s);
  for (const path of ['/army', '/army/training/quote', '/army/training/batch', '/army/train/speedup', '/base', '/bases', '/globe/fantasy', '/globe/fantasy/search',
    '/globe/fantasy/parcels', '/globe/fantasy/parcels/:tileId', '/playtest/access', '/campaign/:stage/preview', '/bases/:baseId/battles/:raidId/replay', '/raids', '/raids/pending'])
    assert.ok(endpoints.some((endpoint) => endpoint.path === path), path);
});
