import { describe, expect, it } from 'vitest';
import { TOKEN } from '@shardkeep/shared';
import type { MiningClaimStatusView, MiningClaimView } from '@shardkeep/shared/miningClaimsApi';
import type { MiningTaxClaimRecoveryEnvelope } from '@shardkeep/shared/miningTaxClaimRecoveryApi';
import type { MiningClaimState } from '../../../lib/miningClaims/controller';
import type { MiningClaimOperation } from '../../../lib/miningClaims/journal';
import type { MiningTaxClaimState } from '../../../lib/miningTaxClaims/controller';
import type { ForgeClaimState } from '../../../lib/forgeClaims/controller';
import taxFixtures from '../../../../../../packages/shared/src/testFixtures/miningTaxClaimRecoveryApi.json';
import { projectForgeClaim, projectMiningClaim, projectMiningTaxClaim, type ClaimAdmission } from './ClaimAdapters';

// Inert presentation snapshots. Existing controllers own schema, scope and proof verification.
const key = '00000000-0000-4000-8000-000000000001';
const childKey = '00000000-0000-4000-8000-000000000002';
const wallet = 'fixture-wallet-must-never-be-rendered';
const now = '2035-01-01T00:00:00.000Z';
const admitted: ClaimAdmission = {
  scopeMatches: true, observationCurrent: true, actionsAllowed: true,
  ownerHandoffReady: true, freshEntryAllowed: true,
};
function status(overrides: Partial<MiningClaimStatusView> = {}): MiningClaimStatusView {
  return {
    features: { claims: { version: 1, receipts: 1 } }, wallet, program: 'shardkeep-economy',
    programId: 'fixture-program', keepMint: 'fixture-mint', state: 'ready', reason: null,
    rootSequence: '1', cumulativeKeepBaseUnits: '18446744073709551615', claimedBaseUnits: '1',
    claimableBaseUnits: '18446744073709551614', decimals: TOKEN.decimals, observedSlot: 1,
    chainUnixTimestamp: '1', claimableAfterUnixTimestamp: '1', needsAta: false, needsMinerRecords: false,
    preparationAllowed: true, claimSubmissionAuthorized: false, serverNow: now, ...overrides,
  };
}
function operation(overrides: Partial<MiningClaimOperation> = {}): MiningClaimOperation {
  return {
    request: { idempotencyKey: key }, prepareAttempted: false, prepareRefusal: null,
    refusalConfirmedAbsent: false, preparation: null, signingStarted: false, signed: null,
    submitAttempted: false, claim: null, ...overrides,
  };
}
function mining(op: MiningClaimOperation | null = null, overrides: Partial<MiningClaimState> = {}): MiningClaimState {
  return {
    loaded: true, busy: false, status: status(), review: null, error: null,
    journal: { version: 1, revision: 1, identity: { origin: 'https://game.test', api: 'https://api.test', cluster: 'devnet', wallet }, operation: op, archives: [] },
    ...overrides,
  };
}
function claimView(state: 'retained' | 'settled'): MiningClaimView {
  const paid = state === 'settled';
  return {
    version: 1, wallet, claimId: key, state, landing: paid ? 'finalized' : 'pending',
    signature: 'fixture-signature', settledBaseUnits: paid ? '9007199254740993' : null,
    transactions: [{ ordinal: 0, kind: 'claim', signature: 'fixture-signature', landing: paid ? 'finalized' : 'pending',
      settledBaseUnits: paid ? '9007199254740993' : null, acceptedAt: now, settledAt: paid ? now : null }],
    serverNow: now, claimSubmissionAuthorized: false,
  };
}
function tax(kind: 'combined' | 'setup' = 'combined'): MiningTaxClaimState {
  // These checked-in shared fixtures are consumed as data, without a controller or signing helper.
  const envelope = taxFixtures[kind] as MiningTaxClaimRecoveryEnvelope;
  const preparation = envelope.preparation!;
  return {
    loaded: true, busy: false, review: null, settlementHeld: false, error: null,
    journal: {
      version: 1, revision: 1,
      identity: { origin: 'https://game.test', api: 'https://api.test', cluster: 'devnet', wallet: preparation.wallet },
      operation: {
        request: { idempotencyKey: preparation.idempotencyKey, round: preparation.round, spot: preparation.spot, caps: preparation.caps },
        prepareAttempted: true, preparation, transactions: [], observed: [0], unattributedObserved: false,
        setup: kind === 'setup' ? envelope : null,
        settlement: kind === 'combined' ? envelope : null,
      },
    },
  };
}
function forge(receipt = false, finished = false): ForgeClaimState {
  return {
    loaded: true, supported: true, enabled: true, busy: false, review: null, error: null,
    journal: {
      version: 1, revision: 1, identity: { api: 'https://api.test', wallet, cluster: 'devnet' },
      intent: { request: { idempotencyKey: key, baseId: null, day: null } },
      receipt: receipt ? { version: 1, actor: wallet, idempotencyKey: key, baseId: null, day: null,
        result: { claimed: [], totalKeep: '0', remaining: 0 }, createdAt: now } : null,
      hydrated: receipt ? { walletKeep: 'refreshed' } : null, finished,
    },
  };
}

describe('Gold Forge claim owner projections', () => {
  it('formats the exact claimable amount without substituting cumulative entitlement', () => {
    const view = projectMiningClaim(mining(), admitted);
    expect(view.amountBaseUnits).toBe('18446744073709551614');
    expect(view.amountLabel).toBe('18,446,744,073.709551614');
    expect(view.status).toBe('ready');
    expect(view.observedAt).toBe(now);
    expect(view.canOpenNewFlow).toBe(true);
    expect(view.paidBaseUnits).toBeNull();
    expect(view.celebration).toBe(false);
  });

  it('defaults every fresh entry gate closed and requires each explicit owner admission', () => {
    expect(projectMiningClaim(mining()).canOpenNewFlow).toBe(false);
    for (const gate of ['scopeMatches', 'observationCurrent', 'actionsAllowed', 'ownerHandoffReady', 'freshEntryAllowed'] as const) {
      expect(projectMiningClaim(mining(), { ...admitted, [gate]: false }).canOpenNewFlow, gate).toBe(false);
    }
    for (const change of [{ loaded: false }, { busy: true }, { error: 'stale read' }]) {
      expect(projectMiningClaim(mining(null, change), admitted).canOpenNewFlow).toBe(false);
    }
    expect(projectMiningClaim(mining(null, { status: status({ preparationAllowed: false }) }), admitted).canOpenNewFlow).toBe(false);
    expect(projectMiningClaim(mining(null, { status: status({ claimableBaseUnits: '0' }) }), admitted).canOpenNewFlow).toBe(false);
  });

  it('keeps no allocation distinct from collected and never invents unknown values or dates', () => {
    const empty = projectMiningClaim(mining(null, { status: status({ state: 'no_allocation', preparationAllowed: false, claimableBaseUnits: '0' }) }), admitted);
    const collected = projectMiningClaim(mining(null, { status: status({ state: 'claimed', preparationAllowed: false, claimableBaseUnits: '0' }) }), admitted);
    expect(empty.amountLabel).toBe('0');
    expect(empty.displayMessage).not.toBe(collected.displayMessage);
    expect(collected.stage).not.toBe('SENT');
    for (const state of ['unavailable', 'revoked'] as const) {
      const view = projectMiningClaim(mining(null, { status: status({ state, preparationAllowed: false, claimableBaseUnits: null }) }), admitted);
      expect(view.amountLabel).toBe('…');
      expect(view.canOpenNewFlow).toBe(false);
      expect(view).not.toHaveProperty('readyDays');
      expect(view).not.toHaveProperty('opensAt');
    }
  });

  it('preserves status and reason metadata while keeping the face free of technical errors', () => {
    const view = projectMiningClaim(mining(null, {
      status: status({ state: 'unavailable', reason: 'SOURCE_UNAVAILABLE', preparationAllowed: false, claimableBaseUnits: null }),
      error: `RPC wallet ${wallet} signature rejected`,
    }), admitted);
    expect(view.status).toBe('unavailable');
    expect(view.reason).toBe('SOURCE_UNAVAILABLE');
    expect(view.displayMessage).not.toMatch(/RPC|signature|transaction|fee|fixture-wallet/i);
    expect(JSON.stringify(view)).not.toContain(wallet);
  });

  it('retains same-owner stale figures and original recovery without allowing a new claim', () => {
    const view = projectMiningClaim(mining(operation({ prepareAttempted: true }), { error: 'refresh failed' }), {
      ...admitted, observationCurrent: false, actionsAllowed: false, freshEntryAllowed: false, refreshError: 'offline',
    });
    expect(view.amountLabel).toBe('18,446,744,073.709551614');
    expect(view.current).toBe(false);
    expect(view.canOpenNewFlow).toBe(false);
    expect(view.recovery).toMatchObject({ available: true, requestKey: key, canOpen: true });
    expect(view.stage).toBe('FAILED');
    expect(view.failure).toBe('UNCERTAIN');
    expect(view.displayMessage).not.toContain('Nothing was');
  });

  it('retains recovery through paused delayed revoked and missing status observations', () => {
    for (const state of ['paused', 'delayed', 'revoked'] as const) {
      const view = projectMiningClaim(mining(operation(), { status: status({ state, preparationAllowed: false }) }), admitted);
      expect(view.canOpenNewFlow).toBe(false);
      expect(view.recovery.canOpen).toBe(true);
      expect(view.recovery.requestKey).toBe(key);
    }
    const unknown = projectMiningClaim(mining(null, { loaded: false, journal: null, status: null, error: 'read failed' }), admitted);
    expect(unknown.recovery).toMatchObject({ available: true, requestKey: null, canOpen: true });
    expect(unknown.amountLabel).toBe('…');
  });

  it('hides prior-owner amounts metadata and original keys when scope is false or unproven', () => {
    const prior = mining(operation({ claim: claimView('settled') }));
    for (const scope of [{}, { scopeMatches: false }]) {
      const view = projectMiningClaim(prior, { ownerHandoffReady: true, ...scope });
      expect(view.amountBaseUnits).toBeNull();
      expect(view.paidBaseUnits).toBeNull();
      expect(view.status).toBeNull();
      expect(view.observedAt).toBeNull();
      expect(view.recovery).toMatchObject({ available: false, requestKey: null, continuationRequestKey: null, canOpen: false });
      expect(JSON.stringify(view)).not.toContain(key);
    }
  });

  it('never turns approval submission or ordered setup finalization into payment', () => {
    const setup = claimView('retained');
    setup.transactions = [{ ordinal: 0, kind: 'setup', signature: 'fixture-signature', landing: 'finalized',
      settledBaseUnits: '0', acceptedAt: now, settledAt: now }];
    for (const op of [operation({ signingStarted: true }), operation({ signed: { ordinal: 0, wire: 'fixture-wire', signature: 'fixture-signature' } }),
      operation({ submitAttempted: true }), operation({ claim: setup })]) {
      const view = projectMiningClaim(mining(op), admitted);
      expect(view.stage).not.toBe('SENT');
      expect(view.paidBaseUnits).toBeNull();
      expect(view.recovery.requestKey).toBe(key);
    }
    const paid = projectMiningClaim(mining(operation({ claim: claimView('settled') })), admitted);
    expect(paid.stage).toBe('SENT');
    expect(paid.paidBaseUnits).toBe('9007199254740993');
    expect(paid.paidLabel).toBe('9,007,199.254740993');
    expect(paid.celebration).toBe(false);
  });

  it('preserves ordered holds and continuation keys without opening another request', () => {
    const op = operation({ ordered: { remainder: { signingStarted: false, signed: null, submitAttempted: false }, held: true,
      continuationRequest: { idempotencyKey: childKey }, continuationAttempted: true, continuationRefusal: null,
      continuationAbsent: false, refusedContinuations: [], continuation: null } });
    const view = projectMiningClaim(mining(op), admitted);
    expect(view.recovery).toMatchObject({ requestKey: key, continuationRequestKey: childKey, held: true, canOpen: true });
    expect(view.canOpenNewFlow).toBe(false);
  });

  it('requires confirmed absent authoritative preparation refusal before refusal copy state', () => {
    const refused = operation({ prepareAttempted: true, prepareRefusal: { status: 409, code: 'CLAIM_ROOT_PENDING' } });
    expect(projectMiningClaim(mining(refused), admitted).failure).toBe('UNCERTAIN');
    expect(projectMiningClaim(mining({ ...refused, refusalConfirmedAbsent: true }), admitted).failure).toBe('REFUSED');
  });

  it('uses the tax owner hold decision and never grants new tax entry from partial evidence', () => {
    const source = tax('setup');
    expect(projectMiningTaxClaim(source, admitted).recovery.held).toBe(true);
    const released = projectMiningTaxClaim(source, { ...admitted, ownerHeld: false });
    expect(released.recovery.held).toBe(false);
    expect(released.canOpenNewFlow).toBe(false);
    expect(projectMiningTaxClaim({ ...source, settlementHeld: true }, { ...admitted, ownerHeld: false }).recovery.held).toBe(true);
    expect(released.recovery.requestKey).toBe(source.journal?.operation?.request.idempotencyKey);
  });

  it('separates tax setup from exact paid proof and keeps held recovery discoverable', () => {
    const setup = projectMiningTaxClaim(tax('setup'), { ...admitted, freshEntryAllowed: false, actionsAllowed: false });
    expect(setup.stage).not.toBe('SENT');
    expect(setup.paidBaseUnits).toBeNull();
    expect(setup.recovery.canOpen).toBe(true);
    const source = tax('combined');
    const settled = projectMiningTaxClaim({ ...source, error: 'missing independent pin' }, { ...admitted, observationCurrent: false });
    expect(settled.stage).toBe('SENT');
    expect(settled.paidBaseUnits).toBe(source.journal?.operation?.settlement?.settlement?.receipt.paidKeepBaseUnits);
    expect(settled.recovery).toMatchObject({ available: true, held: true, canOpen: true });
    expect(settled).not.toHaveProperty('savedKeep');
    expect(projectMiningTaxClaim(source).paidBaseUnits).toBeNull();
    expect(projectMiningTaxClaim(source).recovery.requestKey).toBeNull();
  });

  it('keeps the archived tax key separate from active recovery and payment', () => {
    const source = tax();
    source.journal = { ...source.journal!, operation: null, lastArchivedKey: childKey };
    const view = projectMiningTaxClaim(source, admitted);
    expect(view.historicalRequestKey).toBe(childKey);
    expect(view.historyAvailable).toBe(true);
    expect(view.recovery).toMatchObject({ available: false, requestKey: null, continuationRequestKey: null, canOpen: false });
    expect(view.paidBaseUnits).toBeNull();
    expect(view.intendedBaseUnits).toBeNull();
    expect(view.stage).not.toBe('SENT');
    expect(view.status).toBe('unknown');
    expect(view.canOpenNewFlow).toBe(false);
    expect(view.celebration).toBe(false);
  });

  it('retains same-owner tax history through fresh holds stale observations and failed reads', () => {
    const source = tax();
    source.journal = { ...source.journal!, operation: null, lastArchivedKey: childKey };
    const held = { ...admitted, observationCurrent: false, freshEntryAllowed: false,
      actionsAllowed: false, ownerHandoffReady: false, ownerHeld: true, refreshError: 'Saved read unavailable' };
    for (const snapshot of [source, { ...source, busy: true }, { ...source, error: 'Missing independent pin' }]) {
      const view = projectMiningTaxClaim(snapshot, held);
      expect(view.historicalRequestKey).toBe(childKey);
      expect(view.historyAvailable).toBe(true);
      expect(view.recovery.requestKey).toBeNull();
      expect(view.recovery.canOpen).toBe(false);
      expect(view.current).toBe(false);
      expect(view.canOpenNewFlow).toBe(false);
      expect(view.stage).not.toBe('SENT');
    }
  });

  it('preserves active tax recovery alongside a distinct archived history key', () => {
    const source = tax('setup');
    source.journal = { ...source.journal!, lastArchivedKey: childKey };
    const view = projectMiningTaxClaim(source, { ...admitted, freshEntryAllowed: false, ownerHeld: true });
    expect(view.historicalRequestKey).toBe(childKey);
    expect(view.historyAvailable).toBe(true);
    expect(view.recovery).toMatchObject({ available: true, requestKey: source.journal.operation?.request.idempotencyKey, held: true, canOpen: true });
    expect(view.recovery.requestKey).not.toBe(childKey);
    expect(view.stage).not.toBe('SENT');
    expect(view.paidBaseUnits).toBeNull();
  });

  it('hides tax history for false or unproven scope and does not invent missing history', () => {
    const source = tax();
    source.journal = { ...source.journal!, operation: null, lastArchivedKey: childKey };
    for (const scope of [{}, { scopeMatches: false }]) {
      const view = projectMiningTaxClaim(source, { ownerHandoffReady: true, ...scope });
      expect(view.historicalRequestKey).toBeNull();
      expect(view.historyAvailable).toBe(false);
      expect(JSON.stringify(view)).not.toContain(childKey);
    }
    expect(projectMiningTaxClaim(tax(), admitted).historicalRequestKey).toBeNull();
    expect(projectMiningTaxClaim(tax(), admitted).historyAvailable).toBe(false);
    expect(projectMiningTaxClaim({ ...source, journal: null }, admitted).historicalRequestKey).toBeNull();
    expect(projectMiningTaxClaim({ ...source, journal: null }, admitted).historyAvailable).toBe(false);
  });

  it('keeps forge receipts historical including terminal zero and never invents saved KEEP', () => {
    const view = projectForgeClaim(forge(true), admitted);
    expect(view.stage).toBe('SENT');
    expect(view.historicalKeep).toBe('0');
    expect(view.historicalKeepLabel).toBe('0');
    expect(view.recovery.requestKey).toBe(key);
    expect(view).not.toHaveProperty('savedKeep');
    expect(view).not.toHaveProperty('withdrawals');
    expect(view.celebration).toBe(false);
  });

  it('keeps forge original recovery independent of disabled unsupported and failed reads', () => {
    const view = projectForgeClaim({ ...forge(), supported: false, enabled: false, error: 'offline' }, {
      ...admitted, observationCurrent: false, freshEntryAllowed: false, actionsAllowed: false,
    });
    expect(view.recovery).toMatchObject({ available: true, requestKey: key, canOpen: true });
    expect(view.stage).not.toBe('SENT');
    expect(view.historicalKeep).toBeNull();
    expect(view.canOpenNewFlow).toBe(false);
    expect(projectForgeClaim(forge(true)).recovery.requestKey).toBeNull();
    expect(projectForgeClaim(forge(true)).historicalKeep).toBeNull();
  });

  it('requires the forge owner ready witness and all gates for fresh review navigation', () => {
    const source = forge(true, true);
    expect(projectForgeClaim(source, admitted).canOpenNewFlow).toBe(false);
    expect(projectForgeClaim(source, { ...admitted, ownerReady: true }).canOpenNewFlow).toBe(true);
    expect(projectForgeClaim(forge(), { ...admitted, ownerReady: true }).canOpenNewFlow).toBe(false);
    expect(projectForgeClaim({ ...source, enabled: false }, { ...admitted, ownerReady: true }).canOpenNewFlow).toBe(false);
    expect(projectForgeClaim(source, { ...admitted, ownerReady: true, refreshError: 'stale' }).canOpenNewFlow).toBe(false);
  });

  it('projects without mutating owner snapshots or embedding callbacks', () => {
    const source = mining(operation());
    const before = JSON.stringify(source);
    const view = projectMiningClaim(source, admitted);
    expect(JSON.stringify(source)).toBe(before);
    expect(Object.values(view).some(value => typeof value === 'function')).toBe(false);
    expect(Object.values(view.recovery).some(value => typeof value === 'function')).toBe(false);
    expect(projectMiningClaim({ ...source, busy: true }, admitted).recovery.canOpen).toBe(false);
  });
});
