// Curated wire boundary, verified against the source routes at the pinned commit.
// This is deliberately an explicit coverage list, not a claim of complete OpenAPI.
// Every schema below names the source handler it was read from; shapes that the
// source validates with Zod (consents, receipts, native presentation) are not
// restated here but referenced by name into tools/native-wire-contracts.mjs.
const string = { type: 'string' };
const integer = { type: 'integer' };
const boolean = { type: 'boolean' };
const number = { type: 'number' };
const long = { type: 'integer', maximum: Number.MAX_SAFE_INTEGER };
const nullable = (spec) => ({ ...spec, type: [spec.type, 'null'] });
const ref = (name) => ({ $ref: `#/schemas/${name}` });
const nullableRef = (name) => ({ anyOf: [ref(name), { type: 'null' }] });
const array = (items) => ({ type: 'array', items });
const anyObject = { type: 'object' };
const any = {};
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: true });
export const schemas = {
  Version: object({ version: string, gitSha: string, builtAt: { type: ['string', 'null'] }, simVersion: integer }),
  AuthChallenge: object({ nonce: string, message: string, expiresAt: string }),
  LoginStatus: object({ loginRequired: boolean, wallet: string, expired: boolean }, ['loginRequired']),
  AuthSession: object({ wallet: string, expiresAt: string, loginRequired: boolean, entryPaid: boolean }, ['wallet']),
  Building: object({ id: string, type: string, level: integer, tx: integer, ty: integer, underConstruction: boolean }),
  // packages/shared/src/baseVisual.ts BaseVisualContext: realm scenery for a base, raid, replay, preview or scout report.
  BaseVisualContext: object({ version: { type: 'integer', const: 1 }, realmId: { type: 'string', enum: ['frostveil', 'elderwood', 'sunscar', 'crownlands', 'seeker-reach', 'stormcairn', 'thornwake', 'cinderfall'] },
    artVersion: { type: 'integer', enum: [1, 2] }, groundRevision: { type: 'integer', enum: [1, 2, 3] } }, ['version', 'realmId', 'artVersion']),
  // apps/api/src/game/base.ts getBaseStateLocked (GET /base): visualContext is required since D-128.
  Base: object({ plotVersion: { type: 'integer', enum: [1, 2] }, baseId: { type: ['string', 'null'] }, visualContext: ref('BaseVisualContext'), player: anyObject,
    claim: anyObject, buildings: array(ref('Building')),
    jobs: { type: 'array' }, army: { type: 'array' }, freeBuilders: integer, obstacles: { type: 'array' }, heroes: { type: 'array' },
    armyStatus: anyObject, energy: anyObject, shield: nullable(anyObject), warzone: anyObject, defences: anyObject,
  }, ['visualContext', 'player', 'claim', 'buildings', 'jobs', 'army', 'freeBuilders']),
  // packages/shared/src/fantasyWorld.ts FantasyTile: the frozen deed address.
  FantasyTile: object({ worldId: string, tileId: integer, realmId: string, allocation: { type: 'string', enum: ['ordinary', 'genesis', 'seeker'] }, lon: number, lat: number }),
  // apps/api/src/game/baseOwnership.ts listWalletBases + routes.ts GET /bases.
  BaseSummary: object({ id: string, deedAssetId: nullable(string), status: string, keepLevel: integer, builders: integer, expansions: integer,
    landPaidAt: nullable(string), slot: nullable(integer), earthCell: nullable(integer), countryA3: nullable(string), fantasyLocation: nullableRef('FantasyTile') }),
  BasesDirectory: object({ enabled: boolean, worldId: { type: 'string', enum: ['fantasy-v1', 'legacy-earth'] }, maxActive: integer,
    capabilities: object({ baseScopedReads: boolean, baseScopedMutations: boolean, cellReservations: boolean }),
    nextLandPurchaseKind: any, bases: array(ref('BaseSummary')) }, ['enabled', 'worldId', 'maxActive', 'capabilities', 'bases']),
  // apps/api/src/game/army.ts buildArmyState + freeTrainingState (GET /army).
  TrainingCompositionItem: object({ troop: string, count: integer }),
  ArmyQueueRow: object({ id: string, troop: string, startedAt: string, finishesAt: string, scheduleVersion: integer, canCancel: boolean, refundShards: nullable(string) }),
  ArmyResearchRow: object({ troop: string, toLevel: integer, finishesAt: string, episodeId: nullable(string), canCancel: boolean, refundShards: nullable(string) }),
  ArmyFeatures: object({ trainingScheduling: object({ version: integer, mode: { type: 'string', enum: ['sequential'] }, lanes: integer, consentRequired: boolean }),
    researchConsent: object({ version: integer }), darkAttackerRoster: object({ enabled: boolean, code: string, message: string }) }),
  TrainingFreeFinishOffer: object({ offer: { type: 'string', enum: ['first_troops'] }, consent: ref('TrainingFinishAllConsent') }),
  TrainingFreeFinishReceipt: object({ idempotencyKey: string, baseId: nullable(string), consent: ref('TrainingFinishAllConsent'), completed: array(ref('TrainingCompositionItem')) }),
  ArmyState: object({ counts: anyObject, levels: anyObject, research: array(ref('ArmyResearchRow')), queue: array(ref('ArmyQueueRow')),
    rosterPts: integer, queuedPts: integer, campCapacityPts: integer, barracksQueuePts: integer, unsupportedTroops: array(string), eliteUnlocks: any,
    finishAllQuote: ref('TrainingFinishAllConsent'), features: ref('ArmyFeatures'),
    freeFinishAllOffer: nullableRef('TrainingFreeFinishOffer'), freeFinishAllReceipt: nullableRef('TrainingFreeFinishReceipt'), freeFinishAllReviewRequired: boolean }),
  // routes.ts POST /army/training/quote and packages/shared/src/types.ts TrainingQuote.
  TrainingQuoteBody: object({ composition: array(ref('TrainingCompositionItem')), baseId: string }, ['composition']),
  TrainingQuoteRemaining: object({ troop: string, count: integer, reason: string }),
  TrainingCapacity: object({ used: integer, capacity: integer, after: integer }),
  TrainingSchedule: object({ version: integer, mode: { type: 'string', enum: ['sequential'] }, serverNow: string, startsAt: string, finishesAt: string, waitMs: integer, durationMs: integer }),
  TrainingQuote: object({ requested: array(ref('TrainingCompositionItem')), queueable: array(ref('TrainingCompositionItem')), remaining: array(ref('TrainingQuoteRemaining')),
    costShards: string, availableShards: string, camp: ref('TrainingCapacity'), barracks: ref('TrainingCapacity'), completionSec: number,
    consent: ref('TrainingScheduleConsent'), schedule: ref('TrainingSchedule') }),
  // routes.ts POST /army/training/batch: consent is the server's TrainingScheduleConsent snapshot (409 TRAINING_CONSENT_REQUIRED without it).
  TrainingBatchBody: object({ composition: array(ref('TrainingCompositionItem')), confirmedCostShards: string, idempotencyKey: string, baseId: string, consent: ref('TrainingScheduleConsent') },
    ['composition', 'confirmedCostShards', 'idempotencyKey']),
  TrainingBatchQueueItem: object({ id: string, troop: string, finishesAt: string }),
  TrainingBatchResult: object({ queue: array(ref('TrainingBatchQueueItem')), costShards: string, replayed: boolean }),
  // routes.ts POST /army/train/speedup: freeOffer 'first_troops' consumes the free first FINISH ALL (D-121).
  TrainingSpeedupBody: object({ idempotencyKey: string, baseId: string, consent: ref('TrainingFinishAllConsent'), freeOffer: { type: 'string', enum: ['first_troops'] } }, ['idempotencyKey']),
  TrainingSpeedupResult: object({ cost: string, completed: array(ref('TrainingCompositionItem')) }),
  // routes.ts POST /army/research, /army/research/speedup, /army/research/:troop/cancel bodies.
  ResearchStartBody: object({ troop: string, idempotencyKey: string, baseId: string, consent: ref('ResearchStartConsent') }, ['troop', 'idempotencyKey']),
  ResearchFinishBody: object({ troop: string, idempotencyKey: string, baseId: string, consent: ref('ResearchFinishConsent') }, ['troop', 'idempotencyKey']),
  ResearchCancelBody: object({ idempotencyKey: string, baseId: string, consent: ref('ResearchEpisodeConsent') }, ['idempotencyKey']),
  // heroes.ts listHeroes: older servers omit additive feature negotiation.
  HeroFeatures: object({ heroConsent: object({ version: integer }), heroReceipts: object({ version: integer }) }),
  HeroesState: object({ heroes: array(anyObject), keepBalance: string, keepLevel: integer, features: ref('HeroFeatures') }, ['heroes', 'keepBalance', 'keepLevel']),
  HeroUpgradeBody: object({ idempotencyKey: string, baseId: string, consent: ref('HeroUpgradeConsent') }, ['idempotencyKey']),
  HeroRecoveryBody: object({ idempotencyKey: string, baseId: string, consent: ref('HeroRecoveryConsent') }, ['idempotencyKey']),
  // routes.ts POST /raids and POST /campaign/:stage/raid (201 { raid }).
  RaidCreated: object({ id: string, defenderWallet: nullable(string), attackerBaseId: nullable(string), defenderBaseId: nullable(string), campaignStage: nullable(integer),
    snapshot: anyObject, visualContext: ref('BaseVisualContext'), armySnapshot: anyObject, ordersDeadlineAt: string, seed: long, simVersion: integer, raidProtocolVersion: integer },
    ['id', 'snapshot', 'visualContext', 'armySnapshot', 'ordersDeadlineAt', 'seed', 'simVersion']),
  RaidCreatedEnvelope: object({ raid: ref('RaidCreated') }),
  // raids.ts pendingRaidResumeDto (GET /raids/pending, /raids/pending/:id).
  PendingRaidResume: object({ id: string, defenderWallet: nullable(string), attackerBaseId: nullable(string), defenderBaseId: nullable(string), pveCampId: any, campaignStage: nullable(integer),
    snapshot: anyObject, visualContext: ref('BaseVisualContext'), armySnapshot: anyObject, ordersDeadlineAt: string, seed: long, simVersion: integer, heroReserved: boolean, raidProtocolVersion: integer, live: nullable(anyObject) },
    ['id', 'snapshot', 'visualContext', 'armySnapshot', 'ordersDeadlineAt', 'seed', 'simVersion', 'heroReserved']),
  PendingRaidResumes: object({ raids: array(ref('PendingRaidResume')) }),
  PendingRaidResumeEnvelope: object({ raid: ref('PendingRaidResume') }),
  // raids.ts replay DTO (GET /bases/:baseId/battles/:raidId/replay, /battles/participated/:raidId/replay).
  BattleReplay: object({ id: string, snapshot: anyObject, visualContext: ref('BaseVisualContext'), orders: any, seed: long, simVersion: integer, events: { type: 'array' }, result: any, armySnapshot: anyObject, buildingHealth: { type: 'array' } },
    ['id', 'snapshot', 'visualContext', 'seed', 'simVersion', 'events', 'armySnapshot']),
  // routes.ts GET /campaign/:stage/preview.
  CampaignPreview: object({ stage: integer, snapshot: anyObject, visualContext: ref('BaseVisualContext') }),
  // apps/api/src/game/fantasyGlobe.ts (GET /globe/fantasy*).
  FantasyRealmCount: object({ realmId: string, total: integer, occupied: integer, held: integer, available: integer, anchorTileId: nullable(integer) }),
  FantasyOwnedTile: object({ baseId: string, tileId: integer, realmId: string, name: nullable(string), avatarUrl: nullable(string), keepLevel: integer, active: boolean, selected: boolean }),
  FantasyGlobeMe: object({ baseId: nullable(string), selectedTileId: nullable(integer), ownedTiles: array(ref('FantasyOwnedTile')) }),
  FantasyGlobe: object({ worldId: string, catalogHash: string, ready: boolean, warzone: anyObject, realms: array(ref('FantasyRealmCount')), me: ref('FantasyGlobeMe') }),
  FantasySearchResult: object({ tileId: integer, realmId: string, name: nullable(string), avatarUrl: nullable(string), keepLevel: integer, trophies: integer, seeker: boolean }),
  FantasySearch: object({ results: array(ref('FantasySearchResult')) }),
  FantasyMarker: object({ tileId: integer, name: nullable(string), avatarUrl: nullable(string), keepLevel: integer }),
  FantasyViewport: object({ worldId: string, scope: object({ x0: integer, x1: integer, y0: integer, y1: integer }), matched: integer, truncated: boolean, markers: array(ref('FantasyMarker')) }),
  FantasyParcel: object({ worldId: string, tile: ref('FantasyTile'), availability: { type: 'string', enum: ['reserved', 'available', 'held', 'occupied'] }, detail: nullable(anyObject) }),
  // apps/api/src/routes-alpha.ts GET /playtest/access (D-118 open playtest).
  PlaytestAccess: object({ open: boolean, playUrl: string }),
};
export const endpoints = [
  { method: 'GET', path: '/version', response: 'Version' },
  { method: 'GET', path: '/auth/challenge', response: 'AuthChallenge' },
  { method: 'GET', path: '/auth/login/status', response: 'LoginStatus' },
  { method: 'POST', path: '/auth/verify', response: 'AuthSession' },
  { method: 'POST', path: '/auth/login/verify', response: 'AuthSession' },
  { method: 'GET', path: '/playtest/access', response: 'PlaytestAccess' },
  { method: 'GET', path: '/base', response: 'Base' },
  { method: 'GET', path: '/bases', response: 'BasesDirectory' },
  { method: 'GET', path: '/army', response: 'ArmyState' },
  { method: 'POST', path: '/army/training/quote', body: 'TrainingQuoteBody', response: 'TrainingQuote' },
  { method: 'POST', path: '/army/training/batch', body: 'TrainingBatchBody', response: 'TrainingBatchResult' },
  { method: 'POST', path: '/army/train/speedup', body: 'TrainingSpeedupBody', response: 'TrainingSpeedupResult' },
  { method: 'POST', path: '/army/research', body: 'ResearchStartBody' },
  { method: 'POST', path: '/army/research/speedup', body: 'ResearchFinishBody' },
  { method: 'POST', path: '/army/research/:troop/cancel', body: 'ResearchCancelBody' },
  { method: 'GET', path: '/heroes', response: 'HeroesState' },
  { method: 'POST', path: '/heroes/:hero/upgrade', body: 'HeroUpgradeBody' },
  { method: 'POST', path: '/heroes/:hero/recovery/speedup', body: 'HeroRecoveryBody' },
  { method: 'POST', path: '/raids', response: 'RaidCreatedEnvelope' },
  { method: 'POST', path: '/campaign/:stage/raid', response: 'RaidCreatedEnvelope' },
  { method: 'GET', path: '/raids/pending', response: 'PendingRaidResumes' },
  { method: 'GET', path: '/raids/pending/:id', response: 'PendingRaidResumeEnvelope' },
  { method: 'GET', path: '/bases/:baseId/battles/:raidId/replay', response: 'BattleReplay' },
  { method: 'GET', path: '/battles/participated/:raidId/replay', response: 'BattleReplay' },
  { method: 'GET', path: '/campaign/:stage/preview', response: 'CampaignPreview' },
  { method: 'GET', path: '/globe/fantasy', response: 'FantasyGlobe' },
  { method: 'GET', path: '/globe/fantasy/search', response: 'FantasySearch' },
  { method: 'GET', path: '/globe/fantasy/parcels', response: 'FantasyViewport' },
  { method: 'GET', path: '/globe/fantasy/parcels/:tileId', response: 'FantasyParcel' },
];
export function validateWire(schemaName, data, additionalSchemas = {}) {
  const resolve = (name) => schemas[name] ?? additionalSchemas[name];
  function visit(schema, value, at) {
    if (schema.$ref) {
      const target = resolve(schema.$ref.split('/').at(-1));
      if (!target) throw new Error(`${at}: unknown wire schema reference ${schema.$ref}`);
      return visit(target, value, at);
    }
    if (schema.anyOf) {
      const failures = [];
      for (const option of schema.anyOf) { try { return visit(option, value, at); } catch (error) { failures.push(error); } }
      throw new Error(`${at}: no wire variant matched (${failures.map((e) => e.message).join('; ')})`);
    }
    if (schema.type === undefined) return;
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    if (!(types.includes(type) || (types.includes('integer') && Number.isSafeInteger(value)))) throw new Error(`${at}: wrong wire type`);
    if (schema.enum && !schema.enum.includes(value)) throw new Error(`${at}: value outside wire enum`);
    if (schema.const !== undefined && value !== schema.const) throw new Error(`${at}: value differs from wire constant`);
    if (type === 'object') {
      for (const key of schema.required ?? []) if (!(key in value)) throw new Error(`${at}.${key}: missing`);
      for (const [key, child] of Object.entries(schema.properties ?? {})) if (key in value) visit(child, value[key], `${at}.${key}`);
    }
    if (type === 'array' && schema.items) value.forEach((item, index) => visit(schema.items, item, `${at}[${index}]`));
  }
  if (!resolve(schemaName)) throw new Error('Unknown wire schema');
  visit(resolve(schemaName), data, schemaName);
  return data;
}
export function kotlinModels(sourceCommit, additionalSchemas = {}) {
  const modelSchemas = { ...schemas, ...additionalSchemas };
  function kotlinType(spec) {
    if (spec.$ref) {
      const name = /^#\/schemas\/([^/]+)$/.exec(spec.$ref)?.[1];
      return name && modelSchemas[name]?.properties ? `${name}Dto` : 'JsonElement';
    }
    const variants = spec.anyOf ?? (Array.isArray(spec.type) ? spec.type.map((type) => ({ ...spec, type })) : null);
    if (variants) {
      const types = [...new Set(variants.filter((value) => value.type !== 'null').map(kotlinType))];
      return types.length === 1 ? types[0] : 'JsonElement';
    }
    if (spec.type === 'array') return spec.items ? `List<${kotlinType(spec.items)}>` : 'JsonElement';
    if (spec.type === 'integer') return spec.maximum > 2_147_483_647 || spec.minimum < -2_147_483_648 ? 'Long' : 'Int';
    if (spec.type === 'number' && Number.isSafeInteger(spec.const)) return Math.abs(spec.const) > 2_147_483_647 ? 'Long' : 'Int';
    return { string: 'String', boolean: 'Boolean', number: 'Double' }[spec.type] ?? 'JsonElement';
  }
  const nullableSpec = (spec) => spec.type === 'null' || (Array.isArray(spec.type) && spec.type.includes('null')) || spec.anyOf?.some(nullableSpec);
  const lines = [`// GENERATED from client contract pack at ${sourceCommit}; do not edit.`,
    'package gg.pixelkingdomwars.nativeclient.generated', '', 'import kotlinx.serialization.Serializable',
    'import kotlinx.serialization.json.JsonElement', ''];
  for (const [name, schema] of Object.entries(modelSchemas)) {
    if (!schema.properties) continue; // Shared recursive JSON definitions are not DTOs.
    lines.push('@Serializable', `data class ${name}Dto(`);
    for (const [key, spec] of Object.entries(schema.properties)) {
      const optional = !(schema.required ?? []).includes(key);
      const nullable = optional || nullableSpec(spec);
      const kotlin = kotlinType(spec);
      lines.push(`    val ${key}: ${kotlin}${nullable ? '?' : ''}${optional ? ' = null' : ''},`);
    }
    lines.push(')', '');
  }
  return lines.join('\n');
}
