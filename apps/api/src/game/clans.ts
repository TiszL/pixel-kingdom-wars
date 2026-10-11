/**
 * Clans (Phase 3 pulled forward — docs/CLANS-SELLABLE-DEEDS-PLAN.md C2).
 *
 * MVP: create / join / leave / kick / roster / leaderboard. No wars, no chat
 * (Discord per GDD), no ranks beyond leader/member. The weekly chest is C3 and
 * arrives with its own ledger plumbing.
 *
 * Money: founding a clan burns CLANS.createCostShards through spendShards —
 * a real sink, charged in the SAME transaction as the insert so a clan can
 * never exist unpaid nor a payment land clanless (the raid-ante pattern).
 *
 * Concurrency: joins serialize on a FOR UPDATE lock of the clan row, so the
 * roster cap cannot be raced past; "one clan per player" is the clan_members
 * PRIMARY KEY — schema truth, not application truth.
 */
import { CLANS } from '@shardkeep/shared';
import type { ClanCommandRefusal } from '@shardkeep/shared/clanCommands';
import { randomBytes } from 'node:crypto';
import { and, asc, eq, gt, isNotNull, sql } from 'drizzle-orm';
import type { Db, DbOrTx, DbTx } from '../db/client';
import { multiBaseEnabled } from '../config';
import {
  baseProfiles, bases, baseSlots, clanMembers, clans, players,
} from '../db/schema';
import { HttpError } from '../lib/errors';
import {
  bootstrapSystemAccounts, getOrCreateBaseAccount, getOrCreatePlayerAccount,
} from '../ledger/accounts';
import { InsufficientFundsError, postTransaction } from '../ledger/ledger';
import { spendBaseShards } from './baseEconomy';
import { spendShards } from './spend';
import {
  lockStablePrerequisiteBase, requireStableBaseMutationContext,
  type StableBaseMutationContext,
} from './stableBasePrerequisites';

const NAME_RE = /^[A-Za-z0-9 ._-]+$/;
const TAG_RE = /^[A-Z0-9]+$/;

async function clanOf(db: DbOrTx, wallet: string): Promise<{ clanId: string } | null> {
  const [m] = await db.select({ clanId: clanMembers.clanId }).from(clanMembers)
    .where(eq(clanMembers.playerWallet, wallet));
  return m ?? null;
}

export async function createClan(
  db: Db, wallet: string,
  opts: { name: string; tag: string; inviteMode?: 'open' | 'invite' },
  idempotencyKey: string,
  baseContext?: StableBaseMutationContext,
) {
  const name = opts.name.trim();
  const tag = opts.tag.trim().toUpperCase();
  if (name.length < CLANS.nameMinLen || name.length > CLANS.nameMaxLen || !NAME_RE.test(name)) {
    throw new HttpError(422, `clan name: ${CLANS.nameMinLen}–${CLANS.nameMaxLen} chars, letters/numbers/space/._-`);
  }
  if (tag.length < CLANS.tagMinLen || tag.length > CLANS.tagMaxLen || !TAG_RE.test(tag)) {
    throw new HttpError(422, `clan tag: ${CLANS.tagMinLen}–${CLANS.tagMaxLen} letters/numbers`);
  }
  if (await clanOf(db, wallet)) throw new HttpError(422, 'leave your current clan first');

  return db.transaction(async (tx) => {
    const stableContext = multiBaseEnabled()
      ? requireStableBaseMutationContext(baseContext)
      : undefined;
    let selectedBaseId: string | undefined;
    if (stableContext) {
      // Canonical mutation order is player -> base -> slot -> raid lock. The
      // helper rechecks both DB ownership and finalized deed authority inside
      // this spending transaction, so a route precheck can never authorize a
      // different/sold deed or allow gameplay while that deed is being raided.
      await tx.select({ wallet: players.wallet }).from(players)
        .where(eq(players.wallet, wallet)).for('update');
      const base = await lockStablePrerequisiteBase(tx, wallet, stableContext);
      if (!base.landPaidAt) throw new HttpError(402, 'buy your land to unlock this', 'LAND_NOT_OWNED');
      selectedBaseId = base.id;
    }
    // Charge INSIDE the tx (raid-ante pattern): name-taken, already-in-a-clan
    // (raced) — any throw below rolls the burn back with the insert.
    try {
      const posted = selectedBaseId
        ? await spendBaseShards(
          tx, selectedBaseId, BigInt(CLANS.createCostShards), 'clan.create',
          `clan-create:${selectedBaseId}:${idempotencyKey}`, { wallet, name, tag },
        )
        : await spendShards(
          tx, wallet, BigInt(CLANS.createCostShards), 'clan.create',
          `clan-create:${wallet}:${idempotencyKey}`, { name, tag },
        );
      if (posted.duplicate) throw new HttpError(409, 'duplicate create request');
    } catch (e) {
      if (e instanceof InsufficientFundsError) {
        throw new HttpError(422, `founding a clan costs ${CLANS.createCostShards} shards`);
      }
      throw e;
    }
    const inviteMode = opts.inviteMode ?? 'open';
    let clan;
    try {
      [clan] = await tx.insert(clans).values({
        name, tag, leaderWallet: wallet, inviteMode,
        // 8-char join secret for invite clans; base64url is copy-paste safe.
        inviteCode: inviteMode === 'invite' ? randomBytes(6).toString('base64url') : null,
      }).returning();
    } catch (e) {
      const code = (e as { code?: string }).code ?? (e as { cause?: { code?: string } }).cause?.code;
      const msg = e instanceof Error ? e.message : '';
      if (code === '23505' || msg.includes('clans_name_unique') || msg.includes('clans_tag_unique')) {
        throw new HttpError(422, 'clan name or tag already taken');
      }
      throw e;
    }
    await tx.insert(clanMembers).values({ playerWallet: wallet, clanId: clan!.id });
    return clan!;
  });
}

export async function joinClan(db: Db, wallet: string, clanId: string, inviteCode?: string) {
  if (await clanOf(db, wallet)) throw new HttpError(422, 'leave your current clan first');
  return db.transaction(async (tx) => {
    // FOR UPDATE: two concurrent joins serialize here, so the cap check below
    // sees the true count — without it a full clan could over-fill by racing.
    const [clan] = await tx.select().from(clans).where(eq(clans.id, clanId)).for('update');
    if (!clan) throw new HttpError(404, 'clan not found');
    if (clan.inviteMode === 'invite' && clan.inviteCode !== inviteCode) {
      throw new HttpError(422, 'this clan is invite-only — wrong or missing code');
    }
    const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(clanMembers)
      .where(eq(clanMembers.clanId, clanId)) as [{ n: number }];
    if (n >= CLANS.rosterCap) throw new HttpError(422, `clan is full (${CLANS.rosterCap})`);
    try {
      await tx.insert(clanMembers).values({ playerWallet: wallet, clanId });
    } catch (e) {
      const code = (e as { code?: string }).code ?? (e as { cause?: { code?: string } }).cause?.code;
      if (code === '23505') throw new HttpError(422, 'leave your current clan first'); // raced double-join
      throw e;
    }
    return { clanId, members: n + 1 };
  });
}

/** Leave. The LEADER may only leave when alone — the clan row then dissolves
 *  (cascade clears membership). With members present, leadership must move
 *  first (kick everyone, or a future transfer — not in MVP). */
export async function leaveClan(
  db: Db, wallet: string, baseContext?: StableBaseMutationContext,
) {
  return db.transaction(async (tx) => {
    const result = await leaveClanInTransaction(tx, wallet, baseContext);
    return result.state === 'disbanded' ? { left: true, disbanded: true } : { left: true };
  });
}

/** Only these domain refusals may become durable no-effect receipts. Storage,
 * authority and ledger failures remain uncertain and roll back the whole call. */
export class ClanCommandRefused extends HttpError {
  constructor(status: number, message: string, readonly refusal: ClanCommandRefusal) {
    super(status, message, refusal);
  }
}
function refuseClan(expected: string | undefined, status: number, message: string, code: ClanCommandRefusal): never {
  throw expected ? new ClanCommandRefused(status, message, code) : new HttpError(status, message);
}

export async function leaveClanInTransaction(
  tx: DbTx, wallet: string, baseContext?: StableBaseMutationContext, expectedClanId?: string,
): Promise<{ state: 'left' | 'disbanded'; payoutShards: bigint; ledgerTransactionId: string | null }> {
  const m = await clanOf(tx, wallet);
  if (!m) refuseClan(expectedClanId, 422, 'you are not in a clan', 'CLAN_CHANGED');
  if (expectedClanId && m.clanId !== expectedClanId) {
    refuseClan(expectedClanId, 409, 'your clan changed; review it again', 'CLAN_CHANGED');
  }
  const stableContext = multiBaseEnabled()
    ? requireStableBaseMutationContext(baseContext)
    : undefined;
  let selectedBaseId: string | undefined;
  if (stableContext) {
    await tx.select({ wallet: players.wallet }).from(players)
      .where(eq(players.wallet, wallet)).for('update');
    const base = await lockStablePrerequisiteBase(tx, wallet, stableContext);
    if (!base.landPaidAt) throw new HttpError(402, 'buy your land to unlock this', 'LAND_NOT_OWNED');
    selectedBaseId = base.id;
  }
  const [clan] = await tx.select().from(clans).where(eq(clans.id, m.clanId)).for('update');
  // Membership can change while waiting for the clan/base locks. Never let an
  // old leave delete the player's subsequently joined clan.
  const current = await clanOf(tx, wallet);
  if (!clan || current?.clanId !== m.clanId) {
    if (expectedClanId) refuseClan(expectedClanId, 409, 'your clan changed; review it again', 'CLAN_CHANGED');
    return { state: 'left', payoutShards: 0n, ledgerTransactionId: null };
  }
  if (clan.leaderWallet === wallet) {
    const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(clanMembers)
      .where(eq(clanMembers.clanId, m.clanId)) as [{ n: number }];
    if (n > 1) refuseClan(expectedClanId, 422, 'the leader leaves last — kick your members first', 'CLAN_LEADER_NOT_ALONE');
    // Any unsettled chest goes to the departing (sole) member — dissolving
    // must never strand pooled shards in the system account (C3 invariant:
    // sum(chest_shards) == pool balance, and this clan's row is about to go).
    // NOT land-gated, deliberately, unlike settleClanChests: the clan row is
    // being DELETED in this same tx, so refusing the payout would strand the
    // shards in clan_chest with no attribution row and permanently break the C3
    // invariant. It is also not a faucet — founding a clan is land-gated, so a
    // deedless sole member here is someone who paid, accrued, and then sold up,
    // and this returns their own clan's accrual rather than minting anything.
    let ledgerTransactionId: string | null = null;
    if (clan.chestShards > 0n) {
      const sys = await bootstrapSystemAccounts(tx);
      const acc = selectedBaseId
        ? await getOrCreateBaseAccount(tx, selectedBaseId, 'base_shards')
        : await getOrCreatePlayerAccount(tx, wallet, 'player_shards');
      const posted = await postTransaction(tx, {
        idempotencyKey: selectedBaseId
          ? `clan-dissolve:${m.clanId}:${selectedBaseId}`
          : `clan-dissolve:${m.clanId}`,
        type: 'clan.chest_dissolve',
        entries: [
          { account: sys.clan_chest, delta: -clan.chestShards },
          { account: acc.id, delta: clan.chestShards },
        ],
        metadata: { clanId: m.clanId, wallet, ...(selectedBaseId ? { baseId: selectedBaseId } : {}) },
      });
      // A live clan with an already-posted dissolution is inconsistent. Do
      // not turn a duplicate historical ledger key into new payout evidence.
      if (posted.duplicate) throw new Error('clan dissolution already posted for a live clan');
      ledgerTransactionId = posted.transaction.id;
    }
    await tx.delete(clans).where(eq(clans.id, m.clanId)); // cascade removes membership
    return { state: 'disbanded', payoutShards: clan.chestShards, ledgerTransactionId };
  }
  await tx.delete(clanMembers).where(and(eq(clanMembers.playerWallet, wallet), eq(clanMembers.clanId, m.clanId)));
  return { state: 'left', payoutShards: 0n, ledgerTransactionId: null };
}

/** Leader removes a member (never themself — that is leaveClan's dissolve path). */
export async function kickMember(db: Db, wallet: string, target: string) {
  // Clan row FOR UPDATE (security review #5): an unlocked kick could commit
  // between settlement's roster read and its payout, paying a just-kicked
  // member — and the leader check itself was unlocked. Same serialization
  // point as join/leave/settle.
  return db.transaction(async (tx) => {
    await kickMemberInTransaction(tx, wallet, target);
    return { kicked: target };
  });
}

export async function kickMemberInTransaction(tx: DbTx, wallet: string, target: string, expectedClanId?: string): Promise<void> {
  const m = await clanOf(tx, wallet);
  if (!m) refuseClan(expectedClanId, 422, 'you are not in a clan', 'CLAN_CHANGED');
  if (expectedClanId && m.clanId !== expectedClanId) {
    refuseClan(expectedClanId, 409, 'your clan changed; review it again', 'CLAN_CHANGED');
  }
  const [clan] = await tx.select().from(clans).where(eq(clans.id, m.clanId)).for('update');
  const current = await clanOf(tx, wallet);
  if (current?.clanId !== m.clanId && expectedClanId) {
    refuseClan(expectedClanId, 409, 'your clan changed; review it again', 'CLAN_CHANGED');
  }
  if (!clan || clan.leaderWallet !== wallet) refuseClan(expectedClanId, 403, 'only the leader kicks', 'CLAN_NOT_LEADER');
  if (target === wallet) refuseClan(expectedClanId, 422, 'leave, not kick, yourself', 'CLAN_SELF_KICK');
  const gone = await tx.delete(clanMembers)
    .where(and(eq(clanMembers.playerWallet, target), eq(clanMembers.clanId, m.clanId)))
    .returning({ w: clanMembers.playerWallet });
  if (gone.length === 0) refuseClan(expectedClanId, 404, 'not a member of your clan', 'CLAN_TARGET_ABSENT');
}

/** The caller's clan (with roster) or null — the CLANS screen's main read. */
export async function getMyClan(db: Db, wallet: string) {
  const m = await clanOf(db, wallet);
  if (!m) return { clan: null };
  const [clan] = await db.select().from(clans).where(eq(clans.id, m.clanId));
  if (!clan) return { clan: null };
  const roster = multiBaseEnabled()
    ? await db.select({
      wallet: clanMembers.playerWallet, joinedAt: clanMembers.joinedAt,
      name: players.name,
      // Clan identity is wallet-wide, but competitive strength is deed-owned.
      // One wallet contributes exactly its strongest active paid deed, never a
      // sum and never the lossy players compatibility shadow.
      keepLevel: sql<number>`coalesce(max(${bases.keepLevel}), 1)::int`,
      trophies: sql<number>`coalesce(max(${baseProfiles.trophies}), 0)::int`,
      seeker: players.seekerVerified,
    }).from(clanMembers)
      .innerJoin(players, eq(players.wallet, clanMembers.playerWallet))
      .leftJoin(baseSlots, and(
        eq(baseSlots.wallet, clanMembers.playerWallet), eq(baseSlots.active, true),
      ))
      .leftJoin(bases, and(
        eq(bases.id, baseSlots.baseId), eq(bases.ownerWallet, clanMembers.playerWallet),
        eq(bases.status, 'active'), isNotNull(bases.landPaidAt),
      ))
      .leftJoin(baseProfiles, eq(baseProfiles.baseId, bases.id))
      .where(eq(clanMembers.clanId, m.clanId))
      .groupBy(
        clanMembers.playerWallet, clanMembers.joinedAt,
        players.name, players.seekerVerified,
      )
      .orderBy(asc(clanMembers.joinedAt))
    : await db.select({
      wallet: clanMembers.playerWallet, joinedAt: clanMembers.joinedAt,
      name: players.name, keepLevel: players.keepLevel, trophies: players.trophies,
      seeker: players.seekerVerified,
    }).from(clanMembers)
      .innerJoin(players, eq(players.wallet, clanMembers.playerWallet))
      .where(eq(clanMembers.clanId, m.clanId))
      .orderBy(asc(clanMembers.joinedAt));
  return {
    clan: {
      id: clan.id, name: clan.name, tag: clan.tag, inviteMode: clan.inviteMode,
      leaderWallet: clan.leaderWallet,
      // The join secret is for the LEADER to hand out — members see it too
      // (they can invite), outsiders never (browse/leaderboard omit it).
      inviteCode: clan.inviteCode,
      roster,
    },
  };
}

/** Browse + leaderboard: clans ranked by summed member trophies. */
export async function listClans(db: Db, limit = 50) {
  if (multiBaseEnabled()) {
    const memberStrength = db.select({
      clanId: clanMembers.clanId,
      wallet: clanMembers.playerWallet,
      trophies: sql<number>`coalesce(max(${baseProfiles.trophies}), 0)::int`.as('trophies'),
    }).from(clanMembers)
      .leftJoin(baseSlots, and(
        eq(baseSlots.wallet, clanMembers.playerWallet), eq(baseSlots.active, true),
      ))
      .leftJoin(bases, and(
        eq(bases.id, baseSlots.baseId), eq(bases.ownerWallet, clanMembers.playerWallet),
        eq(bases.status, 'active'), isNotNull(bases.landPaidAt),
      ))
      .leftJoin(baseProfiles, eq(baseProfiles.baseId, bases.id))
      .groupBy(clanMembers.clanId, clanMembers.playerWallet)
      .as('member_strength');
    const rows = await db.select({
      id: clans.id, name: clans.name, tag: clans.tag, inviteMode: clans.inviteMode,
      members: sql<number>`count(${memberStrength.wallet})::int`,
      trophies: sql<number>`coalesce(sum(${memberStrength.trophies}), 0)::int`,
    }).from(clans)
      .leftJoin(memberStrength, eq(memberStrength.clanId, clans.id))
      .groupBy(clans.id)
      .orderBy(sql`coalesce(sum(${memberStrength.trophies}), 0) desc`)
      .limit(limit);
    return { clans: rows };
  }
  const rows = await db.select({
    id: clans.id, name: clans.name, tag: clans.tag, inviteMode: clans.inviteMode,
    members: sql<number>`count(${clanMembers.playerWallet})::int`,
    trophies: sql<number>`coalesce(sum(${players.trophies}), 0)::int`,
  }).from(clans)
    .leftJoin(clanMembers, eq(clanMembers.clanId, clans.id))
    .leftJoin(players, eq(players.wallet, clanMembers.playerWallet))
    .groupBy(clans.id)
    .orderBy(sql`coalesce(sum(${players.trophies}), 0) desc`)
    .limit(limit);
  return { clans: rows };
}

/**
 * Weekly chest settlement (C3) — called from the league reset job. Each clan's
 * accrued chest splits EVENLY among current members; the integer remainder
 * stays in the chest (rolls into next week). Ledger + attribution column move
 * in the same tx per clan, so the C3 invariant survives a mid-job crash with at
 * most one clan settled twice-idempotently (the week-keyed idempotency key
 * makes the re-run a no-op).
 */
export async function settleClanChests(db: Db, week: string): Promise<{ settled: number }> {
  const stable = multiBaseEnabled();
  const due = await db.select().from(clans).where(gt(clans.chestShards, 0n));
  let settled = 0;
  for (const clan of due) {
    // Per-clan isolation + one deadlock retry (security review #4): a raid
    // resolving for a member can deadlock with this tx; without the catch one
    // 40P01 aborted EVERY remaining clan's settlement. Chests roll over and the
    // week key is idempotent, so skip-and-log is safe.
    const attempt = async (): Promise<void> => await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(clans).where(eq(clans.id, clan.id)).for('update');
      if (!locked || locked.chestShards <= 0n) return;
      // ONLY LANDOWNING MEMBERS SHARE THE CHEST (locked owner decision 2026-08-09,
      // §7 Q3 "clans are DEED-GATED — chests pay every member"). Route-gating
      // `POST /clans/:id/join` is NOT sufficient, and this is the payout path that
      // proves it: membership OUTLIVES land. `baseTransfer` clears the seller's
      // `entryPaidAt` when they sell their base, so a landowner who founded or
      // joined a clan and then sold up stays on the roster as a deedless member and
      // would keep drawing chest payouts forever — plus any member who joined
      // before the gate shipped. The gate has to live where the money moves.
      // The C3 invariant (sum(clans.chest_shards) == clan_chest balance) is
      // preserved because `paidOut` is recomputed from the ELIGIBLE count below;
      // an ineligible member's share simply rolls over to next week.
      let recipients: Array<{ w: string; baseId?: string }>;
      if (stable) {
        // A member with several deeds receives exactly one share. Slot order
        // is the durable deterministic selector for background settlement;
        // ownership/status/paid predicates prevent stale transferred deeds
        // and inactive storage deeds from receiving money.
        const eligible = await tx.select({
          w: clanMembers.playerWallet, baseId: baseSlots.baseId, slot: baseSlots.slot,
        }).from(clanMembers)
          .innerJoin(baseSlots, and(
            eq(baseSlots.wallet, clanMembers.playerWallet), eq(baseSlots.active, true),
          ))
          .innerJoin(bases, and(
            eq(bases.id, baseSlots.baseId), eq(bases.ownerWallet, clanMembers.playerWallet),
            eq(bases.status, 'active'), isNotNull(bases.landPaidAt),
          ))
          .where(eq(clanMembers.clanId, clan.id))
          .orderBy(asc(clanMembers.playerWallet), asc(baseSlots.slot));
        const firstByWallet = new Map<string, { w: string; baseId: string }>();
        for (const row of eligible) {
          if (!firstByWallet.has(row.w)) firstByWallet.set(row.w, row);
        }
        recipients = [...firstByWallet.values()];
      } else {
        recipients = await tx.select({ w: clanMembers.playerWallet }).from(clanMembers)
          .innerJoin(players, eq(players.wallet, clanMembers.playerWallet))
          .where(and(eq(clanMembers.clanId, clan.id), isNotNull(players.entryPaidAt)));
      }
      // Reachable now (an all-deedless clan), not just "leader-leaves-last" theory:
      // the chest rolls over untouched rather than being stranded or force-paid.
      if (recipients.length === 0) return;
      const each = locked.chestShards / BigInt(recipients.length);
      if (each <= 0n) return; // sub-member-count chest rolls over whole
      const paidOut = each * BigInt(recipients.length);
      const sys = await bootstrapSystemAccounts(tx);
      const entries = [{ account: sys.clan_chest, delta: -paidOut }];
      for (const r of recipients) {
        const acc = stable
          ? await getOrCreateBaseAccount(tx, r.baseId!, 'base_shards')
          : await getOrCreatePlayerAccount(tx, r.w, 'player_shards');
        entries.push({ account: acc.id, delta: each });
      }
      const posted = await postTransaction(tx, {
        idempotencyKey: `clan-chest:${week}:${clan.id}`,
        type: 'clan.chest_split',
        entries,
        metadata: {
          clanId: clan.id, members: recipients.length, each: each.toString(),
          ...(stable ? { baseIds: recipients.map((r) => r.baseId) } : {}),
        },
      });
      if (!posted.duplicate) {
        await tx.update(clans).set({ chestShards: sql`${clans.chestShards} - ${paidOut}` })
          .where(eq(clans.id, clan.id));
        settled++;
      }
    });
    try {
      await attempt();
    } catch (e) {
      const code = (e as { code?: string }).code ?? (e as { cause?: { code?: string } }).cause?.code;
      if (code === '40P01') {
        try { await attempt(); } catch (e2) {
          console.error(`[clan-chest] settle retry failed for ${clan.id} (rolls over):`, e2);
        }
      } else {
        console.error(`[clan-chest] settle failed for ${clan.id} (rolls over):`, e);
      }
    }
  }
  return { settled };
}

/** Test/ops helper: the C3 conservation check — per-clan attribution must sum
 *  to the pooled account at every commit boundary. */
export async function clanChestInvariantHolds(db: DbOrTx): Promise<boolean> {
  const sys = await bootstrapSystemAccounts(db);
  const [{ total }] = await db.select({ total: sql<string>`coalesce(sum(${clans.chestShards}), 0)::text` })
    .from(clans) as [{ total: string }];
  const [pool] = await db.execute(
    sql`select balance::text as b from accounts where id = ${sys.clan_chest}`,
  ) as unknown as Array<{ b: string }>;
  return BigInt(total) === BigInt(pool?.b ?? '0');
}
