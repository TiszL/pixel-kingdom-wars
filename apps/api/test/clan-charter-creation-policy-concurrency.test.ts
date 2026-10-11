import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createCharterCreationTerminal } from '../src/game/clanCharterCreationTerminal';
import { createCharterCreationPolicyAdmission } from '../src/game/clanCharterCreationPolicyAdmission';
import { charterCreationPolicyFixture, outcome, pausePolicyBank, policyRefusal,
  type PolicyFixture } from './fixtures/charterCreationPolicyAdmission';
import { terminalBank } from './fixtures/charterCreationTerminal';

let activeFixture: PolicyFixture | undefined;
function fixture(): PolicyFixture {
  if (!activeFixture) throw Error('Policy fixture setup did not complete');
  return activeFixture;
}
beforeEach(async () => { activeFixture = undefined; activeFixture = await charterCreationPolicyFixture(); }, 120_000);
afterEach(async () => {
  vi.restoreAllMocks(); const current = activeFixture; activeFixture = undefined;
  await current?.dispose();
}, 120_000);

it('converges competing first admissions on one permanent candidate and original receipt', async () => {
  const f = fixture();
  const p = await f.policyPrepared(), before = await f.snapshot();
  let arrivals = 0, entered!: () => void, release!: () => void;
  const bothArrived = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const original = p.bank.rpc.getMultipleAccountsInfoAndContext.bind(p.bank.rpc);
  p.bank.rpc.getMultipleAccountsInfoAndContext = vi.fn(async (addresses, options) => {
    arrivals++; if (arrivals === 2) entered(); await gate; return original(addresses, options);
  });
  const pending = [outcome(p.service().admit(p.actor.wallet, p.consent.creationIntentId)),
    outcome(p.service().admit(p.actor.wallet, p.consent.creationIntentId))] as const;
  try {
    await Promise.race([bothArrived, ...pending.map(work => work.then(result => {
      if (!result.ok) throw result.error; throw Error('A competing admission completed before both policy RPC arrivals');
    }))]);
    expect(arrivals).toBe(2); release(); const [first, second] = await Promise.all(pending);
    if (!first.ok) throw first.error; if (!second.ok) throw second.error;
    expect(first.value).toEqual(second.value); expect(await f.policyRows()).toHaveLength(1);
    expect((await f.inventory().read(p.actor.wallet, p.consent.creationIntentId)).permitInventory.messages).toEqual([first.value.candidate]);
  } finally { release(); await Promise.all(pending); p.bank.rpc.getMultipleAccountsInfoAndContext = original; }
  expect(await f.snapshot()).toEqual(before);
});

it('lets zero-head cancellation close issuance while a policy bank is in flight without holding SQL locks', async () => {
  const f = fixture();
  const p = await f.policyPrepared(), gate = pausePolicyBank(p.bank), pending = outcome(p.service().admit(p.actor.wallet, p.consent.creationIntentId));
  try {
    await Promise.race([gate.arrived, pending.then(result => { if (!result.ok) throw result.error; throw Error('Admission bypassed policy RPC'); })]);
    const absence = terminalBank(p.zero), terminal = createCharterCreationTerminal(f.db, { chain: absence.chain });
    expect((await terminal.recover(p.actor.wallet, p.consent.creationIntentId)).state).toBe('cancelled_unpaid');
    gate.release(); expect(await pending).toMatchObject({ ok: false, error: policyRefusal('HELD') });
    expect((await terminal.read(p.actor.wallet, p.consent.creationIntentId))!.state).toBe('cancelled_unpaid');
  } finally { gate.release(); await pending; gate.restore(); }
  expect(await f.policyRows()).toHaveLength(0);
  expect(await f.sql`select * from charter_creation_permit_messages where reservation_id=${p.consent.reservationId}`).toHaveLength(0);
  expect(await f.balance('charter_creation_escrow')).toBe(f.cost);
});

it('makes admitted exposure invalidate stale cancellation and retains its exact historical record after expiry and refund', async () => {
  const f = fixture();
  const p = await f.policyPrepared(), absence = terminalBank(p.zero);
  let entered!: () => void, release!: () => void;
  const arrived = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const original = absence.rpc.getMultipleAccountsInfoAndContext.bind(absence.rpc);
  absence.rpc.getMultipleAccountsInfoAndContext = async (addresses, options) => { entered(); await gate; return original(addresses, options); };
  const terminal = createCharterCreationTerminal(f.db, { chain: absence.chain });
  const pending = outcome(terminal.recover(p.actor.wallet, p.consent.creationIntentId));
  try {
    await Promise.race([arrived, pending.then(result => { if (!result.ok) throw result.error; throw Error('Terminal bypassed actual bank'); })]);
    const admitted = await p.service().admit(p.actor.wallet, p.consent.creationIntentId); release();
    expect(await pending).toMatchObject({ ok: false, error: { code: 'CLAN_CHARTER_TERMINAL_STALE_INVENTORY' } });
    await expect(terminal.recover(p.actor.wallet, p.consent.creationIntentId)).rejects.toMatchObject({ code: 'CLAN_CHARTER_TERMINAL_HELD' });
    absence.clock.writeBigInt64LE(admitted.candidate.expiry + 1n, 32);
    expect((await terminal.recover(p.actor.wallet, p.consent.creationIntentId)).state).toBe('cancelled_unpaid');
    expect(await p.service().read(p.actor.wallet, p.consent.creationIntentId)).toEqual(admitted);
    const retained = await f.sql`select * from charter_creation_permit_messages where reservation_id=${p.consent.reservationId}`;
    const balance = await f.balance('base_shards', p.actor.baseId); await p.actor.refresh(p.actor.wallet, 101);
    expect((await terminal.claimRefund(p.actor.wallet, p.consent.creationIntentId)).state).toBe('refunded');
    expect(await f.balance('base_shards', p.actor.baseId)).toBe(balance + f.cost);
    process.env['PHASE_E_CHARTER_ENABLED'] = 'false'; process.env['MULTI_BASE_ENABLED'] = 'false';
    const offline = createCharterCreationPolicyAdmission(f.db, { chain: null,
      monotonicNow: () => { throw Error('Historical refunded replay sampled new policy time'); } });
    const refunded = await f.snapshot();
    expect(await offline.read(p.actor.wallet, p.consent.creationIntentId)).toEqual(admitted);
    expect(await offline.admit(p.actor.wallet, p.consent.creationIntentId)).toEqual(admitted);
    expect(await f.snapshot()).toEqual(refunded);
    expect(await f.sql`select * from charter_creation_permit_messages where reservation_id=${p.consent.reservationId}`).toEqual(retained);
  } finally { release(); await pending; }
  expect(await f.policyRows()).toHaveLength(1); expect(await f.balance('charter_creation_escrow')).toBe(0n);
});

it('never adopts a bare candidate that mints and activates while new policy observation is in flight', async () => {
  const f = fixture();
  const p = await f.policyPrepared(); await f.seedSpendQuests();
  const gate = pausePolicyBank(p.bank), pending = outcome(p.service().admit(p.actor.wallet, p.consent.creationIntentId));
  const burn = await f.balance('shard_burn');
  try {
    await Promise.race([gate.arrived, pending.then(result => { if (!result.ok) throw result.error; throw Error('Admission bypassed actual bank'); })]);
    const inventory = await f.inventory().recordPrepared(p.actor.wallet, p.consent.creationIntentId, f.message(p.zero));
    const minted = terminalBank(inventory, true), terminal = createCharterCreationTerminal(f.db, { chain: minted.chain });
    expect((await terminal.recover(p.actor.wallet, p.consent.creationIntentId)).state).toBe('activated');
    gate.release(); expect(await pending).toMatchObject({ ok: false, error: policyRefusal('HELD') });
    expect((await terminal.recover(p.actor.wallet, p.consent.creationIntentId)).state).toBe('activated');
  } finally { gate.release(); await pending; gate.restore(); }
  expect(await f.policyRows()).toHaveLength(0); expect(await f.balance('shard_burn')).toBe(burn + f.cost);
  expect((await f.spendProgress(p.actor.baseId)).map(row => row.progress)).toEqual([Number(f.cost), Number(f.cost)]);
});
