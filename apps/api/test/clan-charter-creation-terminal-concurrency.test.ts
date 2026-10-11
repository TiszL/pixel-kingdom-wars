import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { spendBaseShards } from '../src/game/baseEconomy';
import { charterCreationTerminalFixture, type TerminalFixture } from './fixtures/charterCreationTerminal';

let f: TerminalFixture;
const outcome = <T>(work: Promise<T>) => work.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
beforeEach(async () => {
  f = await charterCreationTerminalFixture(); await f.seedSpendQuests();
  const control = await f.prepared({ actor: await f.actor(), minted: true });
  expect((await control.service().recover(control.actor.wallet, control.consent.creationIntentId)).state).toBe('activated');
}, 120_000);
afterEach(async () => { await f?.dispose(); }, 120_000);

it('serializes simultaneous mint recoveries into one terminal, burn and spend-quest event', async () => {
  const p = await f.prepared({ minted: true }), burnBefore = await f.balance('shard_burn');
  const results = await Promise.all([p.service().recover(p.actor.wallet, p.consent.creationIntentId),
    p.service().recover(p.actor.wallet, p.consent.creationIntentId)]);
  expect(results[0]).toEqual(results[1]); expect(results[0]!.state).toBe('activated');
  expect(await f.balance('shard_burn')).toBe(burnBefore + f.cost);
  expect(await f.balance('charter_creation_escrow')).toBe(0n);
  expect(await f.sql`select * from charter_creation_terminals where reservation_id=${p.consent.reservationId}`).toHaveLength(1);
  expect((await f.spendProgress(p.actor.baseId)).map(row => row.progress)).toEqual([Number(f.cost), Number(f.cost)]);
});

it('rejects a zero-head absence observation raced by the first persisted candidate and rereads the complete new inventory', async () => {
  const p = await f.prepared({ count: 0 });
  let entered!: () => void, release!: () => void;
  const arrived = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const original = p.bank.rpc.getMultipleAccountsInfoAndContext.bind(p.bank.rpc);
  p.bank.rpc.getMultipleAccountsInfoAndContext = async (addresses, options) => { entered(); await gate; return original(addresses, options); };
  const pending = outcome(p.service().recover(p.actor.wallet, p.consent.creationIntentId));
  try {
    await Promise.race([arrived, pending.then(() => { throw Error('Terminal returned before observing the bank'); })]);
    await f.inventory().recordPrepared(p.actor.wallet, p.consent.creationIntentId, p.message);
    release();
    expect(await pending).toMatchObject({ ok: false, error: { code: 'CLAN_CHARTER_TERMINAL_STALE_INVENTORY' } });
  } finally { release(); await pending; p.bank.rpc.getMultipleAccountsInfoAndContext = original; }
  expect(await p.service().read(p.actor.wallet, p.consent.creationIntentId)).toBeNull();
  expect(await f.balance('charter_creation_escrow')).toBe(f.cost);
  expect((await f.inventory().read(p.actor.wallet, p.consent.creationIntentId)).permitInventory.count).toBe(1);
  expect((await p.service().recover(p.actor.wallet, p.consent.creationIntentId)).state).toBe('cancelled_unpaid');
});

it('does not hold gameplay or independent funding locks while finalized RPC is pending', async () => {
  const p = await f.prepared({ count: 0 }), other = await f.actor();
  let entered!: () => void, release!: () => void;
  const arrived = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const original = p.bank.rpc.getMultipleAccountsInfoAndContext.bind(p.bank.rpc);
  p.bank.rpc.getMultipleAccountsInfoAndContext = async (addresses, options) => { entered(); await gate; return original(addresses, options); };
  const pending = outcome(p.service().recover(p.actor.wallet, p.consent.creationIntentId));
  try {
    await Promise.race([arrived, pending.then(() => { throw Error('Terminal returned before observing the bank'); })]);
    const before = await f.balance('base_shards', p.actor.baseId);
    await spendBaseShards(f.db, p.actor.baseId, 1n, 'test.charter.pending-rpc', randomUUID(), {}, { progressQuests: false });
    expect(await f.balance('base_shards', p.actor.baseId)).toBe(before - 1n);
    expect((await f.service().reserve(other.wallet, f.consent(other))).state).toBe('reserved');
    expect(await f.balance('charter_creation_escrow')).toBe(f.cost * 2n);
    release(); expect(await pending).toMatchObject({ ok: true, value: { state: 'cancelled_unpaid' } });
  } finally { release(); await pending; p.bank.rpc.getMultipleAccountsInfoAndContext = original; }
}, 30_000);

it('rolls back all terminal effects at a busy legacy table barrier and preserves the same mint for retry', async () => {
  const p = await f.prepared({ minted: true });
  for (const table of ['clans', 'clan_members']) {
    const owner = await f.dedicatedOwner(), before = await f.terminalSnapshot();
    try {
      await owner.sql`begin`; await owner.sql.unsafe(`lock table public.${table} in row exclusive mode`);
      await expect(p.service().recover(p.actor.wallet, p.consent.creationIntentId)).rejects.toMatchObject({ code: 'CLAN_CHARTER_TERMINAL_BUSY' });
      expect(await f.terminalSnapshot()).toEqual(before);
    } finally { await owner.sql`rollback`; await owner.sql.end(); }
  }
  expect((await p.service().recover(p.actor.wallet, p.consent.creationIntentId)).state).toBe('activated');
});

it('serializes duplicate refund claims into one original-payer credit and one liability discharge', async () => {
  const p = await f.prepared(); await p.service().recover(p.actor.wallet, p.consent.creationIntentId);
  const before = await f.balance('base_shards', p.actor.baseId);
  const results = await Promise.all([p.service().claimRefund(p.actor.wallet, p.consent.creationIntentId),
    p.service().claimRefund(p.actor.wallet, p.consent.creationIntentId)]);
  expect(results[0]).toEqual(results[1]); expect(results[0]!.state).toBe('refunded');
  expect(await f.balance('base_shards', p.actor.baseId)).toBe(before + f.cost);
  expect(await f.balance('charter_creation_escrow')).toBe(0n);
  expect(await f.sql`select * from charter_creation_refunds where reservation_id=${p.consent.reservationId}`).toHaveLength(1);
  expect(await f.spendProgress(p.actor.baseId)).toHaveLength(0);
});

it('rechecks paid active authority after a real destination-base lock wait without reopening cancelled issuance', async () => {
  const p = await f.prepared(); await p.service().recover(p.actor.wallet, p.consent.creationIntentId);
  const owner = await f.dedicatedOwner(), before = await f.balance('base_shards', p.actor.baseId);
  let pending: Promise<unknown> | undefined;
  try {
    await owner.sql`begin`; const [pid] = await owner.sql`select pg_backend_pid() pid`;
    await owner.sql`select id from bases where id=${p.actor.baseId} for update`;
    const refund = outcome(p.service().claimRefund(p.actor.wallet, p.consent.creationIntentId)); pending = refund;
    await expect.poll(async () => (await f.sql`select pid from pg_stat_activity where datname=current_database()
      and ${Number(pid!.pid)}::int=any(pg_blocking_pids(pid))`).length, { timeout: 10_000 }).toBeGreaterThan(0);
    await owner.sql`update base_slots set active=false where base_id=${p.actor.baseId}`;
    await owner.sql`commit`; expect((await refund).ok).toBe(false);
  } finally { await owner.sql`rollback`; await pending; await owner.sql.end(); }
  expect((await p.service().read(p.actor.wallet, p.consent.creationIntentId))!.state).toBe('cancelled_unpaid');
  expect(await f.balance('base_shards', p.actor.baseId)).toBe(before); expect(await f.balance('charter_creation_escrow')).toBe(f.cost);
  await expect(f.inventory().recordPrepared(p.actor.wallet, p.consent.creationIntentId, f.message(p.zero))).rejects.toThrow();
  await f.sql`update base_slots set active=true where base_id=${p.actor.baseId}`; await p.actor.refresh(p.actor.wallet, 101);
  expect((await p.service().claimRefund(p.actor.wallet, p.consent.creationIntentId)).state).toBe('refunded');
});
