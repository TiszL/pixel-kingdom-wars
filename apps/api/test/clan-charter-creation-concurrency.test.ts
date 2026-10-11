/** Real PostgreSQL locks exercise funding versus legacy clan writers. Each
 * case owns its database and leaves the opening-balance trust boundary intact. */
import { randomUUID } from 'node:crypto';
import type { StableBaseMutationContext } from '../src/game/stableBasePrerequisites';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { assertFreshLockedBaseAuthority } from '../src/game/baseOwnership';
import { createClan, joinClan } from '../src/game/clans';
import { charterCreationFundingFixture } from './fixtures/charterCreationFunding';

let f: Awaited<ReturnType<typeof charterCreationFundingFixture>>;
beforeEach(async () => { f = await charterCreationFundingFixture(); }, 120_000);
afterEach(async () => { await f?.dispose(); }, 120_000);
const outcome = <T>(work: Promise<T>) => work.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
function sqlLeaf(error: unknown) {
  let leaf: { code: string; message: string } | undefined;
  for (let i = 0; i < 8 && error && typeof error === 'object'; i++) {
    if ('code' in error && typeof error.code === 'string' && /^[A-Z0-9]{5}$/.test(error.code)
      && 'message' in error && typeof error.message === 'string') leaf = { code: error.code, message: error.message };
    error = 'cause' in error ? error.cause : undefined;
  }
  return leaf;
}
async function blockedBy(pid: number) {
  await expect.poll(async () => (await f.sql`select pid from pg_stat_activity where datname=current_database()
    and ${pid}::int=any(pg_blocking_pids(pid))`).length, { timeout: 10_000 }).toBeGreaterThan(0);
}

it('rolls back every funding effect when either legacy table barrier is busy, then retries the same consent', async () => {
  for (const table of ['clans', 'clan_members']) {
    const actor = await f.actor(), consent = f.consent(actor), before = await f.snapshot(), owner = await f.dedicatedOwner();
    try {
      await owner.sql`begin`;
      await owner.sql.unsafe(`lock table public.${table} in row exclusive mode`);
      await expect(f.service().reserve(actor.wallet, consent)).rejects.toMatchObject({ code: 'CLAN_CHARTER_CREATION_BUSY' });
      expect(await f.snapshot()).toEqual(before);
    } finally { await owner.sql`rollback`; await owner.sql.end(); }
    expect(await f.service().reserve(actor.wallet, consent)).toMatchObject({ consent, state: 'reserved' });
  }
});

it('admits one of simultaneous competing names, tags or clan IDs and charges only that winner', async () => {
  for (const field of ['name', 'tag', 'clanId'] as const) {
    const a = await f.actor(), b = await f.actor(), ca = f.consent(a), cb = f.consent(b, field === 'clanId' ? ca.clanId : undefined);
    if (field !== 'clanId') cb.clan[field] = ca.clan[field];
    else cb.clan = f.consent(b).clan;
    expect(cb.clanId === ca.clanId).toBe(field === 'clanId');
    expect(cb.clan.name === ca.clan.name).toBe(field === 'name');
    expect(cb.clan.tag === ca.clan.tag).toBe(field === 'tag');
    const before = await f.escrowAccount(), actors = [a, b], consents = [ca, cb];
    const results = await Promise.all(actors.map((actor, i) => outcome(f.service().reserve(actor.wallet, consents[i]!))));
    expect(results.filter(r => r.ok)).toHaveLength(1);
    const loser = results.findIndex(r => !r.ok), rejected = results[loser]!;
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(['CLAN_CHARTER_CREATION_BUSY', 'CLAN_CHARTER_CREATION_PENDING']).toContain(rejected.error.code);
    await expect(f.service().reserve(actors[loser]!.wallet, consents[loser]!))
      .rejects.toMatchObject({ code: 'CLAN_CHARTER_CREATION_PENDING' });
    expect((await f.escrowAccount()).balance).toBe(before.balance + f.cost);
    const [loserBalance] = await f.sql`select balance::text n from accounts where id=${actors[loser]!.account.id}`;
    expect(BigInt(loserBalance!.n)).toBe(actors[loser]!.account.balance);
    for (let i = 0; i < results.length; i++) {
      expect(await f.service().read(actors[i]!.wallet, consents[i]!.creationIntentId)).toEqual(results[i]!.ok ? (results[i] as { ok: true; value: unknown }).value : null);
    }
  }
});

it('refuses legacy writes from a repeatable-read snapshot opened before the pending reservation existed', async () => {
  const owner = await f.dedicatedOwner(), c = f.consent(f.source);
  try {
    await owner.sql`begin isolation level repeatable read`;
    expect(await owner.sql`select * from charter_creation_reservations`).toHaveLength(0);
    await f.service().reserve(f.source.wallet, c);
    // The old snapshot still cannot see the pending row. RC-first refusal must
    // precede its visibility query instead of silently accepting a duplicate.
    expect(await owner.sql`select * from charter_creation_reservations`).toHaveLength(0);
    const before = await f.snapshot();
    const result = await outcome(owner.sql`insert into clans(name,tag,leader_wallet,invite_mode)
      values(${c.clan.name},${c.clan.tag},${f.source.wallet},'open')`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(sqlLeaf(result.error)).toEqual({ code: 'P0001', message: 'CLAN_CHARTER_CREATION_READ_COMMITTED' });
    expect(await f.snapshot()).toEqual(before);
  } finally { await owner.sql`rollback`; await owner.sql.end(); }
});

it.each(['create', 'join', 'update'] as const)('makes a legacy %s waiting behind funded admission observe the newly committed pending rights', async mode => {
  const legacy = await f.actor(), lc = f.consent(legacy), c = f.consent(f.source);
  const context: StableBaseMutationContext = { baseId: legacy.baseId,
    assertAuthority: async (tx, wallet, baseId) => { await assertFreshLockedBaseAuthority(tx, wallet, baseId); } };
  const clan = mode === 'create' ? null : await createClan(f.db, legacy.wallet, lc.clan, randomUUID(), context);
  const originalClans = await f.sql`select * from clans order by id`, originalMembers = await f.sql`select * from clan_members order by player_wallet`;
  const [legacyBalance] = await f.sql`select balance::text n from accounts where id=${legacy.account.id}`;
  const burn = await f.sql`select id,balance from accounts where kind::text='shard_burn'`, blocker = await f.dedicatedOwner();
  // A fixture-only AFTER hook pauses an otherwise real reservation with its
  // money and SHARE locks held. The legacy writer must wait on those locks.
  await f.sql.unsafe(`create function public.b6l_pause_reservation() returns trigger language plpgsql as $$ begin
    perform pg_advisory_xact_lock(7300220);return NEW;end $$;
    create trigger zzz_b6l_pause_reservation after insert on charter_creation_reservations
    for each row execute function public.b6l_pause_reservation();`);
  let pending: Promise<unknown> | undefined;
  let competing: Promise<ReturnType<typeof sqlLeaf> | { succeeded: true }> | undefined;
  try {
    await blocker.sql`select pg_advisory_lock(7300220)`;
    pending = outcome(f.service().reserve(f.source.wallet, c));
    let reservationPid = 0;
    await expect.poll(async () => {
      const [row] = await f.sql`select pid from pg_stat_activity where datname=current_database()
        and wait_event='advisory' and query like '%charter_creation_reservations%'`;
      reservationPid = row ? Number(row.pid) : 0; return reservationPid;
    }, { timeout: 10_000 }).toBeGreaterThan(0);
    const work = mode === 'create'
      ? createClan(f.db, legacy.wallet, { name: c.clan.name, tag: lc.clan.tag }, randomUUID(), context)
      : mode === 'join' ? joinClan(f.db, f.source.wallet, clan!.id)
      : f.sql`update clans set name=${c.clan.name} where id=${clan!.id}`;
    competing = Promise.resolve(work).then(() => ({ succeeded: true as const }), sqlLeaf);
    await blockedBy(reservationPid);
    await blocker.sql`select pg_advisory_unlock(7300220)`;
    expect(await pending).toMatchObject({ ok: true, value: { consent: c, state: 'reserved' } });
    expect(await competing).toEqual({ code: 'P0001', message: 'CLAN_CHARTER_CREATION_PENDING' });
    expect(await f.sql`select * from clans order by id`).toEqual(originalClans);
    expect(await f.sql`select * from clan_members order by player_wallet`).toEqual(originalMembers);
    expect(await f.sql`select id,balance from accounts where kind::text='shard_burn'`).toEqual(burn);
    expect(await f.sql`select balance::text n from accounts where id=${legacy.account.id}`).toEqual([legacyBalance]);
    expect((await f.escrowAccount()).balance).toBe(f.cost);
  } finally {
    await blocker.sql`select pg_advisory_unlock(7300220)`;
    await Promise.all([pending, competing]);
    await blocker.sql.end();
    await f.sql`drop trigger zzz_b6l_pause_reservation on charter_creation_reservations`;
  }
}, 60_000);

it.each(['pause', 'inactive'] as const)('rechecks %s after a real base-lock wait and rolls back money', async mode => {
  const c = f.consent(f.source), owner = await f.dedicatedOwner(), before = await f.snapshot();
  let pending: Promise<unknown> | undefined;
  try {
    await owner.sql`begin`;
    const [pid] = await owner.sql`select pg_backend_pid() pid`;
    await owner.sql`select id from bases where id=${f.source.baseId} for update`;
    const reservation = outcome(f.service().reserve(f.source.wallet, c)); pending = reservation;
    await blockedBy(Number(pid!.pid));
    if (mode === 'pause') process.env['PHASE_E_CHARTER_ENABLED'] = 'false';
    else await owner.sql`update base_slots set active=false where base_id=${f.source.baseId} and wallet=${f.source.wallet}`;
    await owner.sql`commit`;
    const result = await reservation;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatchObject({ code: mode === 'pause' ? 'CLAN_CHARTER_CREATION_DISABLED' : 'BASE_NOT_OWNED' });
    expect(await f.snapshot()).toEqual(before);
  } finally { await owner.sql`rollback`; await pending; await owner.sql.end(); }
});

it('rolls back both completed cache movements when paused during the actual funding transaction', async () => {
  const c = f.consent(f.source), before = await f.snapshot(), blocker = await f.dedicatedOwner();
  await f.sql.unsafe(`create function public.b6l_pause_funding() returns trigger language plpgsql as $$ begin
    if exists(select 1 from charter_creation_funding_posts p where p.tx_key=pg_current_xact_id()::text
      and public.shardkeep_charter_creation_money(p.ledger_id,true)) then perform pg_advisory_xact_lock(7300221);end if;
    return NEW;end $$;
    create trigger zzz_b6l_pause_funding after update on accounts for each row execute function public.b6l_pause_funding();`);
  let pending: Promise<unknown> | undefined;
  try {
    const [pid] = await blocker.sql`select pg_backend_pid() pid`;
    await blocker.sql`select pg_advisory_lock(7300221)`;
    const reservation = outcome(f.service().reserve(f.source.wallet, c)); pending = reservation;
    await blockedBy(Number(pid!.pid));
    process.env['PHASE_E_CHARTER_ENABLED'] = 'false';
    await blocker.sql`select pg_advisory_unlock(7300221)`;
    expect(await reservation).toMatchObject({ ok: false, error: { code: 'CLAN_CHARTER_CREATION_DISABLED' } });
    expect(await f.snapshot()).toEqual(before);
  } finally {
    await blocker.sql`select pg_advisory_unlock(7300221)`;
    await pending; await blocker.sql.end();
    await f.sql`drop trigger zzz_b6l_pause_funding on accounts`;
  }
  process.env['PHASE_E_CHARTER_ENABLED'] = 'true';
  expect(await f.service().reserve(f.source.wallet, c)).toMatchObject({ consent: c, state: 'reserved' });
});
