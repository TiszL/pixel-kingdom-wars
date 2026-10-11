import { afterEach, beforeEach, expect, it } from 'vitest';
import { transferStableBase } from '../src/game/baseOwnership';
import { joinClan } from '../src/game/clans';
import { createCharterCreationTerminal } from '../src/game/clanCharterCreationTerminal';
import { charterCreationTerminalFixture, TERMINAL_CLOCK, type TerminalFixture } from './fixtures/charterCreationTerminal';

let f: TerminalFixture;
beforeEach(async () => { f = await charterCreationTerminalFixture(); await f.seedSpendQuests(); }, 120_000);
afterEach(async () => { await f?.dispose(); }, 120_000);

it('activates the exact finalized mint with one escrow burn, real clan/founder and original-base spend credit', async () => {
  const p = await f.prepared({ minted: true }), id = p.consent.creationIntentId;
  const baseBefore = await f.balance('base_shards', p.actor.baseId), burnBefore = await f.balance('shard_burn');
  expect(await p.service().read(p.actor.wallet, id)).toBeNull();
  expect(await f.spendProgress(p.actor.baseId)).toHaveLength(0);
  const result = await p.service().recover(p.actor.wallet, id);
  expect(result).toMatchObject({ consent: p.consent, reserveTransactionId: p.reservation.reserveTransactionId,
    state: 'activated', refundTransactionId: null, refundDestinationBaseId: null });
  expect(result.terminalTransactionId).toMatch(/^[0-9a-f-]{36}$/);
  expect(await f.balance('charter_creation_escrow')).toBe(0n);
  expect(await f.balance('shard_burn')).toBe(burnBefore + f.cost);
  expect(await f.balance('base_shards', p.actor.baseId)).toBe(baseBefore);
  expect(await f.sql`select id,name,tag,leader_wallet,invite_mode from clans where id=${p.consent.clanId}`)
    .toEqual([{ id: p.consent.clanId, name: p.consent.clan.name, tag: p.consent.clan.tag, leader_wallet: p.actor.wallet, invite_mode: 'open' }]);
  expect(await f.sql`select player_wallet,clan_id from clan_members`).toEqual([{ player_wallet: p.actor.wallet, clan_id: p.consent.clanId }]);
  const progress = await f.spendProgress(p.actor.baseId);
  expect(progress).toHaveLength(2); expect(progress.every(row => row.progress === Number(f.cost) && row.completed_at !== null)).toBe(true);
  expect(await f.sql`select * from quest_progress where player_wallet=${p.actor.wallet}`).toHaveLength(0);
  expect(await f.sql`select a.kind::text kind,e.delta::text delta from ledger_entries e join accounts a on a.id=e.account_id
    where e.txn_id=${result.terminalTransactionId} order by e.delta`)
    .toEqual([{ kind: 'charter_creation_escrow', delta: String(-f.cost) }, { kind: 'shard_burn', delta: String(f.cost) }]);
  expect(Object.isFrozen(result)).toBe(true);
});

it('replays offline and paused after later membership/leader changes without imposing the original live roster forever', async () => {
  const p = await f.prepared({ minted: true }), id = p.consent.creationIntentId;
  const original = await p.service().recover(p.actor.wallet, id), member = await f.actor();
  await joinClan(f.db, member.wallet, p.consent.clanId);
  // A later legitimate roster is not the activation transaction's seed state.
  await f.sql`update clans set leader_wallet=${member.wallet} where id=${p.consent.clanId}`;
  await f.sql`delete from clan_members where player_wallet=${p.actor.wallet}`;
  const before = await f.terminalSnapshot(), reopened = f.reopen();
  process.env['PHASE_E_CHARTER_ENABLED'] = 'false'; process.env['MULTI_BASE_ENABLED'] = 'false';
  p.bank.connect.mockImplementation(() => { throw Error('Original terminal replay must not open RPC'); });
  try {
    const offline = createCharterCreationTerminal(reopened.db, { chain: null });
    expect(await offline.read(p.actor.wallet, id)).toEqual(original);
    expect(await offline.recover(p.actor.wallet, id)).toEqual(original);
    expect(await p.service().recover(p.actor.wallet, id)).toEqual(original);
  } finally { await reopened.sql.end(); }
  expect(await f.terminalSnapshot()).toEqual(before);
});

it('conveys activation spend progress with the original stable base after sale without crediting either owner spendable SHARDS', async () => {
  const p = await f.prepared({ minted: true }), buyer = await f.actor();
  await transferStableBase(f.db, p.actor.baseId, p.actor.wallet, buyer.wallet, p.actor.deed,
    { ...p.actor.proof(buyer.wallet, 101), observedAtMs: Date.now() });
  const sourceBefore = await f.balance('base_shards', p.actor.baseId), buyerOtherBefore = await f.balance('base_shards', buyer.baseId);
  await p.service().recover(p.actor.wallet, p.consent.creationIntentId);
  expect((await f.sql`select owner_wallet from bases where id=${p.actor.baseId}`)[0]!.owner_wallet).toBe(buyer.wallet);
  expect((await f.spendProgress(p.actor.baseId)).map(row => row.progress)).toEqual([Number(f.cost), Number(f.cost)]);
  expect(await f.spendProgress(buyer.baseId)).toHaveLength(0);
  expect(await f.balance('base_shards', p.actor.baseId)).toBe(sourceBefore);
  expect(await f.balance('base_shards', buyer.baseId)).toBe(buyerOtherBefore);
  expect(await f.sql`select * from quest_progress where player_wallet=${p.actor.wallet}`).toHaveLength(0);
  expect((await f.sql`select leader_wallet from clans where id=${p.consent.clanId}`)[0]!.leader_wallet).toBe(p.actor.wallet);
});

it('cancels an explicit zero head without spending or refunding, releasing pending identities but retaining the payer/source obligation', async () => {
  const p = await f.prepared({ count: 0 }), before = await f.snapshot();
  const result = await p.service().recover(p.actor.wallet, p.consent.creationIntentId);
  expect(result).toMatchObject({ state: 'cancelled_unpaid', terminalTransactionId: null, refundTransactionId: null, refundDestinationBaseId: null });
  expect((await f.snapshot()).accounts).toEqual(before.accounts);
  expect(await f.balance('charter_creation_escrow')).toBe(f.cost);
  expect(await f.spendProgress(p.actor.baseId)).toHaveLength(0);
  expect(await f.sql`select * from clans`).toHaveLength(0);
  await expect(f.service().reserve(p.actor.wallet, f.consent(p.actor))).rejects.toThrow();
  await expect(f.inventory().recordPrepared(p.actor.wallet, p.consent.creationIntentId, p.message)).rejects.toThrow();
  const other = await f.actor(), reuse = f.consent(other, p.consent.clanId); reuse.clan = { ...p.consent.clan };
  expect((await f.service().reserve(other.wallet, reuse)).state).toBe('reserved');
  expect(await f.balance('charter_creation_escrow')).toBe(f.cost * 2n);
});

it('returns expired-one-permit backing to the exact original epoch once without burn or spend progress', async () => {
  const p = await f.prepared(), before = await f.balance('base_shards', p.actor.baseId), burnBefore = await f.balance('shard_burn');
  await p.service().recover(p.actor.wallet, p.consent.creationIntentId);
  const result = await p.service().claimRefund(p.actor.wallet, p.consent.creationIntentId);
  expect(result).toMatchObject({ consent: p.consent, state: 'refunded', terminalTransactionId: null, refundDestinationBaseId: p.actor.baseId });
  expect(result.refundTransactionId).toMatch(/^[0-9a-f-]{36}$/);
  expect(await f.balance('base_shards', p.actor.baseId)).toBe(before + f.cost);
  expect(await f.balance('charter_creation_escrow')).toBe(0n); expect(await f.balance('shard_burn')).toBe(burnBefore);
  expect(await f.spendProgress(p.actor.baseId)).toHaveLength(0);
  const settled = await f.terminalSnapshot();
  expect(await createCharterCreationTerminal(f.db, { chain: null }).claimRefund(p.actor.wallet, p.consent.creationIntentId)).toEqual(result);
  expect(await p.service().recover(p.actor.wallet, p.consent.creationIntentId)).toEqual(result);
  expect(await f.terminalSnapshot()).toEqual(settled);
  expect((await f.service().reserve(p.actor.wallet, f.consent(p.actor))).state).toBe('reserved');
});

it('holds auto-refund after A-to-B-to-A but lets only the original payer explicitly choose a fresh paid destination', async () => {
  const p = await f.prepared(), buyer = await f.actor(), destination = await f.actor();
  await transferStableBase(f.db, p.actor.baseId, p.actor.wallet, buyer.wallet, p.actor.deed,
    { ...p.actor.proof(buyer.wallet, 101), observedAtMs: Date.now() });
  await transferStableBase(f.db, p.actor.baseId, buyer.wallet, p.actor.wallet, p.actor.deed,
    { ...p.actor.proof(p.actor.wallet, 102), observedAtMs: Date.now() });
  await transferStableBase(f.db, destination.baseId, destination.wallet, p.actor.wallet, destination.deed,
    { ...destination.proof(p.actor.wallet, 103), observedAtMs: Date.now() });
  await p.service().recover(p.actor.wallet, p.consent.creationIntentId);
  const sourceBefore = await f.balance('base_shards', p.actor.baseId), destinationBefore = await f.balance('base_shards', destination.baseId);
  await expect(p.service().claimRefund(p.actor.wallet, p.consent.creationIntentId)).rejects.toThrow();
  await expect(p.service().claimRefund(buyer.wallet, p.consent.creationIntentId, buyer.baseId)).rejects.toThrow();
  expect((await p.service().read(p.actor.wallet, p.consent.creationIntentId))!.state).toBe('cancelled_unpaid');
  const result = await p.service().claimRefund(p.actor.wallet, p.consent.creationIntentId, destination.baseId);
  expect(result).toMatchObject({ consent: p.consent, state: 'refunded', refundDestinationBaseId: destination.baseId });
  expect(await f.balance('base_shards', p.actor.baseId)).toBe(sourceBefore);
  expect(await f.balance('base_shards', destination.baseId)).toBe(destinationBefore + f.cost);
  expect(await f.balance('charter_creation_escrow')).toBe(0n);
});

it('does not discharge a sold source obligation or pay its successor before an eligible original-payer claim', async () => {
  const p = await f.prepared(), buyer = await f.actor();
  await transferStableBase(f.db, p.actor.baseId, p.actor.wallet, buyer.wallet, p.actor.deed,
    { ...p.actor.proof(buyer.wallet, 101), observedAtMs: Date.now() });
  await p.service().recover(p.actor.wallet, p.consent.creationIntentId);
  const before = await f.terminalSnapshot(), epoch = (await p.actor.custody.read(p.actor.baseId))!;
  await expect(p.service().claimRefund(p.actor.wallet, p.consent.creationIntentId)).rejects.toThrow();
  await expect(p.service().claimRefund(p.actor.wallet, p.consent.creationIntentId, buyer.baseId)).rejects.toThrow();
  await expect(f.service().reserve(buyer.wallet, f.consent({ ...p.actor, wallet: buyer.wallet, epoch }))).rejects.toThrow();
  expect(await f.terminalSnapshot()).toEqual(before);
});

it('consumes or refunds only one original amount from a shared escrow containing two independent obligations', async () => {
  const minted = await f.prepared({ minted: true }), cancelled = await f.prepared({ actor: await f.actor() });
  expect(await f.balance('charter_creation_escrow')).toBe(f.cost * 2n);
  const targetBefore = await f.balance('base_shards', cancelled.actor.baseId);
  await minted.service().recover(minted.actor.wallet, minted.consent.creationIntentId);
  expect(await f.balance('charter_creation_escrow')).toBe(f.cost);
  expect(await cancelled.service().read(cancelled.actor.wallet, cancelled.consent.creationIntentId)).toBeNull();
  await cancelled.service().recover(cancelled.actor.wallet, cancelled.consent.creationIntentId);
  await cancelled.service().claimRefund(cancelled.actor.wallet, cancelled.consent.creationIntentId);
  expect(await f.balance('charter_creation_escrow')).toBe(0n);
  expect(await f.balance('base_shards', cancelled.actor.baseId)).toBe(targetBefore + f.cost);
  expect(await f.sql`select * from clans`).toHaveLength(1);
});

it('lets an exact finalized mint win over a still-live permit and refuses any refund of activated backing', async () => {
  const p = await f.prepared({ minted: true, expiry: TERMINAL_CLOCK + 1n });
  expect((await p.service().recover(p.actor.wallet, p.consent.creationIntentId)).state).toBe('activated');
  const before = await f.terminalSnapshot();
  await expect(p.service().claimRefund(p.actor.wallet, p.consent.creationIntentId)).rejects.toThrow();
  expect(await f.terminalSnapshot()).toEqual(before);
});

it('keeps live-at-equality permits, residual creation accounts and provider outages backed until definitive recovery', async () => {
  const p = await f.prepared({ expiry: TERMINAL_CLOCK });
  expect(await p.service().read(p.actor.wallet, p.consent.creationIntentId)).toBeNull();
  const before = await f.terminalSnapshot();
  await expect(p.service().recover(p.actor.wallet, p.consent.creationIntentId)).rejects.toThrow();
  p.bank.clock.writeBigInt64LE(TERMINAL_CLOCK + 1n, 32);
  p.bank.rows.push(p.bank.creationRows[2]!);
  await expect(p.service().recover(p.actor.wallet, p.consent.creationIntentId)).rejects.toThrow();
  p.bank.rows.splice(p.bank.rows.indexOf(p.bank.creationRows[2]!), 1);
  const genesis = p.bank.rpc.getGenesisHash; p.bank.rpc.getGenesisHash = async () => { throw Error('offline'); };
  await expect(p.service().recover(p.actor.wallet, p.consent.creationIntentId)).rejects.toThrow();
  expect(await f.terminalSnapshot()).toEqual(before);
  p.bank.rpc.getGenesisHash = genesis;
  expect((await p.service().recover(p.actor.wallet, p.consent.creationIntentId)).state).toBe('cancelled_unpaid');
});
