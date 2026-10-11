import { test } from 'vitest';
import assert from 'node:assert/strict';
import { testSolModel, economyModel, type TestSolInput, type EconomyInput, type EconomyStatsRead } from './serviceAdapters';
import type { FaucetStatus } from '../../../auth/useDevnetFaucet';
const status = (): FaucetStatus => ({ enabled: true, eligible: true, reason: 'ok', balanceSol: 0,
  grantSol: 0.5, grantedSol: 0, lifetimeCapSol: 3, minBalanceSol: 0.25, cooldownHours: 6,
  nextEligibleAt: null, last: null });
const faucet = (): TestSolInput => ({ wallet: 'wallet', cluster: 'devnet',
  snapshot: { wallet: 'wallet', cluster: 'devnet', phase: 'idle', status: status() },
  fresh: true, countdown: null, formatSol: String });
const grant = (state: 'requested' | 'sent' | 'failed') => ({ id: 'grant', status: state, lamports: '500000000',
  txSignature: state === 'sent' ? 'signature' : null, error: null, requestedAt: '2026-10-04T07:00:00Z', sentAt: null });
test('test SOL is hidden on mainnet and unknown clusters', () => {
  assert.equal(testSolModel({ ...faucet(), cluster: 'mainnet-beta' }), null);
  assert.equal(testSolModel({ ...faucet(), cluster: 'unknown' }), null);
});
test('test SOL asks for a linked wallet before exposing claim data', () => {
  const m = testSolModel({ ...faucet(), wallet: null })!;
  assert.equal(m.primary?.id, 'wallet.connect'); assert.equal(m.rows.length, 0);
});
test('a foreign wallet or cluster cannot supply a faucet amount or claim', () => {
  for (const change of [{ wallet: 'other' }, { cluster: 'mainnet-beta' as const }]) {
    const x = faucet(); x.snapshot = { ...x.snapshot!, ...change };
    const m = testSolModel(x)!; assert.equal(m.rows.find(r => r.id === 'faucet.sol.amount')?.value, '…');
    assert.notEqual(m.primary?.id, 'faucet.sol.claim');
  }
});
test('a fresh eligible server read offers only the existing SOL claim intent', () => {
  const m = testSolModel(faucet())!;
  assert.deepEqual(m.primary, { id: 'faucet.sol.claim', label: 'CLAIM TEST SOL', state: 'ENABLED', kind: 'action' });
  assert.equal(m.rows.find(r => r.id === 'faucet.sol.amount')?.value, '0.5 SOL');
  assert.doesNotMatch(JSON.stringify(m), /SKR|DEED REQUIRED|wallet fee/i);
});
test('stale eligibility is display only and requires a status refresh', () => {
  const m = testSolModel({ ...faucet(), fresh: false })!;
  assert.equal(m.primary?.id, 'faucet.sol.refresh'); assert.match(m.note!, /last read/i);
});
test('an unresolved requested grant keeps recovery even when the faucet is disabled', () => {
  const x = faucet(); Object.assign(x.snapshot!.status!, { enabled: false, eligible: false, reason: 'disabled', last: grant('requested') });
  const m = testSolModel(x)!; assert.equal(m.primary?.kind, 'recover'); assert.match(m.note!, /checking/i);
  assert.doesNotMatch(JSON.stringify(m), /nothing was spent|claim test sol/i);
});
test('funding and pending status never become a second claim', () => {
  for (const phase of ['funding', 'failed', 'unavailable'] as const) {
    const x = faucet(); x.snapshot!.phase = phase; x.snapshot!.status!.last = grant('requested');
    assert.equal(testSolModel(x)!.primary?.id, 'faucet.sol.refresh');
  }
});
test('a lost SOL request answer cannot be retried as a fresh grant', () => {
  const x = faucet(); x.snapshot!.phase = 'failed';
  const m = testSolModel(x)!; assert.equal(m.primary?.id, 'faucet.sol.refresh');
  assert.doesNotMatch(m.note!, /nothing was spent|failed to send/i);
});
test('funded requires the current controller and an authoritative sent record', () => {
  const x = faucet(); x.snapshot!.phase = 'funded';
  assert.doesNotMatch(testSolModel(x)!.note!, /has arrived/i);
  x.snapshot!.status!.last = grant('sent'); assert.match(testSolModel(x)!.note!, /has arrived/i);
  x.snapshot!.status!.last!.txSignature = null; assert.doesNotMatch(testSolModel(x)!.note!, /has arrived/i);
});
test('a previous sent grant does not hide a new eligible grant after status refresh', () => {
  const x = faucet(); x.snapshot!.status!.last = grant('sent');
  assert.equal(testSolModel(x)!.primary?.id, 'faucet.sol.claim');
});
test('cooldown uses the server target and a supplied display clock without locally opening the faucet', () => {
  const x = faucet(); Object.assign(x.snapshot!.status!, { eligible: false, reason: 'cooldown', nextEligibleAt: '2026-10-04T09:00:00Z' });
  x.countdown = { target: '2026-10-04T09:00:00Z', label: '1h' };
  assert.match(testSolModel(x)!.note!, /1h/); assert.equal(testSolModel(x)!.primary?.id, 'faucet.sol.refresh');
  x.countdown.target = 'old'; assert.doesNotMatch(testSolModel(x)!.note!, /1h/);
});
test('malformed or nonpositive grant amounts never enable a SOL claim', () => {
  for (const amount of [NaN, Infinity, -1, 0]) {
    const x = faucet(); x.snapshot!.status!.grantSol = amount;
    assert.notEqual(testSolModel(x)!.primary?.id, 'faucet.sol.claim');
  }
});
test('server refusals retain their meaning and cannot look claimable', () => {
  for (const reason of ['disabled', 'not_devnet', 'balance_ok', 'cap_reached', 'no_player', 'rpc_unavailable'] as const) {
    const x = faucet(); x.snapshot!.status!.reason = reason; x.snapshot!.status!.eligible = false;
    assert.notEqual(testSolModel(x)!.primary?.id, 'faucet.sol.claim');
    assert.ok(testSolModel(x)!.note);
  }
});

const stats = (): EconomyStatsRead => ({
  pool: { emissionPool: '9007199254740993', playPoolInitial: '10000000000000000', poolPct: 90,
    circulating: '0', withdrawalEscrow: '3', forgePayoutEscrow: '4', leagueEntitlementEscrow: '5' },
  keepFlows: { emittedTotal: '6', emittedToday: '7', recycledTotal: '8', expiredReturnedTotal: '9' },
  shards: { circulating: '10', forgeEscrow: '11', clanChest: '12', burned: '13', flows: {
    issuedTotal: '14', minedTotal: '15', minedToday: '16', cacheClaimedTotal: '17', starterGrantedTotal: '18', convertedTotal: '19', otherIssuedTotal: '20' } },
  onchain: { withdrawnNet: '-2', withdrawnTotal: '21', withdrawnToday: '22', feesBurned: '23', deposited: '24' },
  health: { netEmissionDrain: '-1' },
});
const economy = (): EconomyInput => ({ cluster: 'devnet', snapshot: { cluster: 'devnet', data: stats() }, loading: false, error: null, fresh: true, formatAmount: value => value });
test('economy retains exact decimal strings beyond Number safe integer range', () => {
  const m = economyModel(economy());
  assert.equal(m.rows.find(r => r.id === 'economy.pool.emissionPool')?.value, '9007199254740993');
  assert.equal(m.rows.find(r => r.id === 'economy.pool.circulating')?.value, '0');
  assert.equal(m.rows.find(r => r.id === 'economy.onchain.withdrawnNet')?.value, '-2');
  assert.equal(m.rows.find(r => r.id === 'economy.health.netEmissionDrain')?.value, '-1');
});
test('an unread economy does not invent zeroes or healthy pool copy', () => {
  const m = economyModel({ ...economy(), snapshot: null, loading: true });
  assert.ok(m.rows.every(r => r.value === '…')); assert.doesNotMatch(JSON.stringify(m), /pool healthy|90%/);
});
test('economy hides reads from another or unknown cluster', () => {
  const x = economy(); x.snapshot!.cluster = 'mainnet-beta';
  assert.ok(economyModel(x).rows.every(r => r.value === '…'));
  assert.ok(economyModel({ ...economy(), cluster: 'unknown' }).rows.every(r => r.value === '…'));
});
test('economy rejects exponent whitespace and negative unsigned aggregates', () => {
  const x = economy(); x.snapshot!.data.pool.emissionPool = '1e20'; x.snapshot!.data.keepFlows.emittedTotal = '-1';
  x.snapshot!.data.shards.flows.minedToday = ' 0 '; x.snapshot!.data.pool.poolPct = NaN;
  const m = economyModel(x);
  for (const id of ['pool.emissionPool', 'keepFlows.emittedTotal', 'shards.flows.minedToday', 'pool.poolPct'])
    assert.equal(m.rows.find(r => r.id === `economy.${id}`)?.value, '…');
});
test('a stale economy read stays visible and labelled instead of regaining current status', () => {
  const m = economyModel({ ...economy(), fresh: false });
  assert.equal(m.rows[0]?.tag, 'LAST READ'); assert.match(m.note!, /last read/i);
  assert.equal(m.primary, null);
});
test('economy errors retain current-cluster data without injecting mutation controls', () => {
  const m = economyModel({ ...economy(), error: 'Read failed' });
  assert.equal(m.load, 'ERROR'); assert.equal(m.rows[0]?.tag, 'LAST READ');
  assert.ok(m.rows.every(r => r.action === undefined)); assert.equal(m.primary, null);
});
test('all existing dashboard rows retain a named destination and group', () => {
  const m = economyModel(economy());
  assert.equal(m.rows.length, 25); assert.equal(new Set(m.rows.map(r => r.id)).size, 25);
  assert.ok(m.rows.every(r => r.sub));
  assert.ok(m.rows.some(r => r.id === 'economy.keepFlows.expiredReturnedTotal'));
  assert.ok(m.rows.some(r => r.id === 'economy.shards.flows.otherIssuedTotal'));
});
test('isolated funding with eligible fresh status and no prior grant cannot claim twice',()=>{const x=faucet();x.snapshot!.phase='funding';assert.equal(x.snapshot!.status!.last,null);assert.equal(testSolModel(x)!.primary?.id,'faucet.sol.refresh');});
test('isolated unavailable phase with eligible fresh status cannot become a claim',()=>{const x=faucet();x.snapshot!.phase='unavailable';assert.equal(x.snapshot!.status!.last,null);assert.equal(testSolModel(x)!.primary?.id,'faucet.sol.refresh');});
test('isolated checking phase with retained eligible status cannot become a claim',()=>{const x=faucet();x.snapshot!.phase='checking';assert.equal(x.snapshot!.status!.last,null);assert.notEqual(testSolModel(x)!.primary?.id,'faucet.sol.claim');assert.equal(testSolModel(x)!.load,'LOADING');});
test('other SHARDS issued is a signed exact difference',()=>{const x=economy();x.snapshot!.data.shards.flows.otherIssuedTotal='-9007199254740993';assert.equal(economyModel(x).rows.find(r=>r.id==='economy.shards.flows.otherIssuedTotal')?.value,'-9007199254740993');});
test('fresh known economy drain alone determines the pool verdict without Number',()=>{const x=economy();for(const [raw,copy] of [['0','POOL HEALTHY'],['-0.000','POOL HEALTHY'],['-9007199254740993','POOL HEALTHY'],['0.000000000000000000000001','POOL SHRINKING'],['9007199254740993','POOL SHRINKING']]){x.snapshot!.data.health.netEmissionDrain=raw!;assert.match(economyModel(x).rows.find(r=>r.id==='economy.health.netEmissionDrain')?.sub??'',new RegExp(copy!));}});
test('stale invalid loading and error economy never claim a current health verdict',()=>{for(const patch of [{fresh:false},{loading:true},{error:'Read failed'}]){const m=economyModel({...economy(),...patch});assert.doesNotMatch(JSON.stringify(m),/POOL HEALTHY|POOL SHRINKING/);}const x=economy();x.snapshot!.data.health.netEmissionDrain='bad';assert.doesNotMatch(JSON.stringify(economyModel(x)),/POOL HEALTHY|POOL SHRINKING/);});


test('a disabled unavailable faucet with no saved request shows the disabled copy', () => {
  const x = faucet(); x.snapshot!.phase = 'unavailable';
  Object.assign(x.snapshot!.status!, { enabled: false, eligible: false, reason: 'disabled' });
  assert.equal(x.snapshot!.status!.last, null);
  const m = testSolModel(x)!;
  assert.equal(m.note, 'The test SOL faucet is unavailable.');
  assert.equal(m.primary?.id, 'faucet.sol.refresh');
  assert.equal(m.primary?.kind, 'recover');
});
test('a disabled unavailable faucet still checks its unresolved original grant first', () => {
  const x = faucet(); x.snapshot!.phase = 'unavailable';
  Object.assign(x.snapshot!.status!, { enabled: false, eligible: false, reason: 'disabled', last: grant('requested') });
  const m = testSolModel(x)!;
  assert.equal(m.note, 'We are checking your existing request. Check again for its result.');
  assert.equal(m.primary?.id, 'faucet.sol.refresh');
  assert.equal(m.primary?.kind, 'recover');
});
