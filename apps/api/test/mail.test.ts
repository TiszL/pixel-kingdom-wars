/** M22 mail custody: privacy, idempotency, escrow conservation and races. */
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import {
  issueRecentAuthChallenge, issueRecentAuthGrant, issueSessionJwt, RECENT_AUTH_HEADER,
  SESSION_COOKIE,
} from '../src/auth/session';
import type { DbTx } from '../src/db/client';
import {
  accounts, baseItems, bases, baseSlots, ledgerEntries, ledgerTransactions, mailMessages, players,
  sessions,
} from '../src/db/schema';
import { HttpError } from '../src/lib/errors';
import {
  adminRewardMailIntentSummary, archiveMail, claimMailReward, deliverAdminMail,
  deliverSystemMail, expireDueMailRewards, getMail, getMailStatus, listMail,
  MAINNET_KEEP_MAIL_BUDGET_EXCEEDED, MAINNET_KEEP_MAIL_DISABLED,
  MAINNET_KEEP_MAIL_MISCONFIGURED, markMailRead,
  type AdminKeepCampaignPolicy, type MailClaimAuthority,
} from '../src/mail/service';
import { buildWeeklySnapshot, checkReserves, getInclusionProof } from '../src/money/snapshot';
import { bootstrapSystemAccounts, getOrCreateBaseAccount, getOrCreatePlayerAccount } from '../src/ledger/accounts';
import { TEST_CONFIG, connectTestDb, createTestPlayer } from './helpers';

const conn = connectTestDb();
const db = conn.db;
const unique = (label: string): string => `mail:${label}:${randomUUID()}`;
const campaign = (budget: bigint, enabled = true): AdminKeepCampaignPolicy => ({
  cluster: 'mainnet-beta',
  enabled,
  campaignId: `test_${randomUUID()}`,
  budget,
});
let app: FastifyInstance;
let admin: Awaited<ReturnType<typeof createTestPlayer>>;
let recipient: Awaited<ReturnType<typeof createTestPlayer>>;

async function sessionFor(wallet: string) {
  const id = randomUUID();
  await db.insert(sessions).values({
    id, wallet, expiresAt: new Date(Date.now() + 60_000),
  });
  return { id, cookie: await issueSessionJwt(TEST_CONFIG, wallet, id) };
}

async function activeBase(wallet: string) {
  const [base] = await db.insert(bases).values({ ownerWallet: wallet, status: 'active' }).returning();
  const existing = await db.select({ slot: baseSlots.slot }).from(baseSlots)
    .where(eq(baseSlots.wallet, wallet));
  await db.insert(baseSlots).values({ wallet, slot: existing.length + 1, baseId: base!.id });
  return base!;
}

const authority: MailClaimAuthority = {
  prepare: async (database, wallet, baseId) => {
    const [base] = await database.select({ id: bases.id }).from(bases).where(and(
      eq(bases.id, baseId), eq(bases.ownerWallet, wallet), eq(bases.status, 'active'),
    ));
    if (!base) throw new HttpError(409, 'deed ownership changed', 'DEED_OWNERSHIP_CHANGED');
  },
  assertLocked: async (tx: DbTx, wallet, baseId) => {
    const [base] = await tx.select({ id: bases.id }).from(bases).where(and(
      eq(bases.id, baseId), eq(bases.ownerWallet, wallet), eq(bases.status, 'active'),
    )).for('update');
    if (!base) throw new HttpError(409, 'deed ownership changed', 'DEED_OWNERSHIP_CHANGED');
  },
};

beforeAll(async () => {
  process.env['MAIL_DELIVERY_ENABLED'] = 'true';
  await bootstrapSystemAccounts(db);
  admin = await createTestPlayer(db);
  recipient = await createTestPlayer(db);
  app = await buildApp({ ...TEST_CONFIG, ADMIN_WALLETS: [admin.wallet] }, db);
  await app.ready();
});

afterAll(async () => {
  delete process.env['MAIL_DELIVERY_ENABLED'];
  await app.close();
  await conn.sql.end();
});

describe.sequential('mail service', () => {
  it('keeps inbox data recipient-private and makes read/archive idempotent', async () => {
    const other = await createTestPlayer(db);
    const sent = await deliverSystemMail(db, {
      recipientWallet: recipient.wallet,
      deliveryKey: unique('info'),
      subject: 'Kingdom update',
      body: 'The walls are ready.',
    });
    const mine = await getMail(db, recipient.wallet, sent.message.id);
    expect(mine).toMatchObject({ sender: 'system', subject: 'Kingdom update', readAt: null });
    expect(JSON.stringify(mine)).not.toContain(recipient.wallet);
    await expect(getMail(db, other.wallet, sent.message.id)).rejects.toMatchObject({ statusCode: 404 });
    expect((await getMailStatus(db, recipient.wallet)).unread).toBeGreaterThanOrEqual(1);
    const read = await markMailRead(db, recipient.wallet, sent.message.id);
    const retry = await markMailRead(db, recipient.wallet, sent.message.id);
    expect(retry.readAt).toEqual(read.readAt);
    await archiveMail(db, recipient.wallet, sent.message.id);
    await archiveMail(db, recipient.wallet, sent.message.id);
    expect((await listMail(db, recipient.wallet, {})).messages.map((m) => m.id)).not.toContain(sent.message.id);
    expect((await listMail(db, recipient.wallet, { archived: true })).messages.map((m) => m.id)).toContain(sent.message.id);
  });

  it('reserves currency once, rejects conflicting retries and claims exactly once under concurrency', async () => {
    const base = await activeBase(recipient.wallet);
    const key = unique('mixed');
    const input = {
      recipientWallet: recipient.wallet,
      deliveryKey: key,
      subject: 'Founders reward',
      body: 'Thank you for testing.',
      attachments: [
        { kind: 'KEEP' as const, amount: 321n },
        { kind: 'SHARDS' as const, amount: 654n },
        { kind: 'ITEM' as const, itemId: 'keg_of_haste', qty: 2 },
      ],
    };
    const sys = await bootstrapSystemAccounts(db);
    const emissionBefore = (await db.select().from(accounts)
      .where(eq(accounts.id, sys.emission_pool)))[0]!.balance;
    const escrowBefore = (await db.select().from(accounts)
      .where(eq(accounts.id, sys.mail_keep_escrow)))[0]!.balance;
    const first = await deliverAdminMail(db, admin.wallet, input);
    const replay = await deliverAdminMail(db, admin.wallet, input);
    expect(replay).toMatchObject({ duplicate: true });
    expect(replay.message.id).toBe(first.message.id);
    await expect(deliverAdminMail(db, admin.wallet, { ...input, body: 'Changed' }))
      .rejects.toMatchObject({ statusCode: 409 });
    expect((await db.select().from(accounts).where(eq(accounts.id, sys.mail_keep_escrow)))[0]!.balance)
      .toBe(escrowBefore + 321n);
    expect((await db.select().from(accounts).where(eq(accounts.id, sys.emission_pool)))[0]!.balance)
      .toBe(emissionBefore - 321n);

    const settled = await Promise.all(Array.from({ length: 8 }, () =>
      claimMailReward(db, recipient.wallet, first.message.id, base.id, authority)));
    expect(settled.every((mail) => mail.rewardState === 'claimed')).toBe(true);
    expect((await getOrCreatePlayerAccount(db, recipient.wallet, 'player_keep')).balance).toBe(321n);
    expect((await getOrCreateBaseAccount(db, base.id, 'base_shards')).balance).toBe(654n);
    const [item] = await db.select().from(baseItems).where(and(
      eq(baseItems.baseId, base.id), eq(baseItems.itemId, 'keg_of_haste'),
    ));
    expect(item?.qty).toBe(2);
    expect(await db.select().from(ledgerTransactions).where(eq(
      ledgerTransactions.idempotencyKey, `mail:claim:${first.message.id}`,
    ))).toHaveLength(1);
    expect((await db.select().from(accounts).where(eq(accounts.id, sys.emission_pool)))[0]!.balance)
      .toBe(emissionBefore - 321n);

    const laterBuyer = await createTestPlayer(db);
    await db.transaction(async (tx) => {
      await tx.delete(baseSlots).where(eq(baseSlots.baseId, base.id));
      await tx.update(bases).set({ ownerWallet: laterBuyer.wallet }).where(eq(bases.id, base.id));
      await tx.insert(baseSlots).values({ wallet: laterBuyer.wallet, slot: 1, baseId: base.id });
    });
    // A successful claim remains safely retryable after the deed later moves;
    // this is an outcome read and cannot credit either wallet/base again.
    expect((await claimMailReward(
      db, recipient.wallet, first.message.id, undefined, authority,
    )).rewardState).toBe('claimed');
  });

  it('keeps admin KEEP fail-closed on mainnet while SHARDS, items and info remain unchanged', async () => {
    const owner = await createTestPlayer(db);
    const disabled = campaign(100n, false);
    await expect(deliverAdminMail(db, admin.wallet, {
      recipientWallet: owner.wallet,
      deliveryKey: unique('mainnet-disabled-keep'),
      subject: 'KEEP disabled',
      body: 'This must not reserve KEEP.',
      attachments: [{ kind: 'KEEP', amount: 1n }],
    }, { keepCampaign: disabled })).rejects.toMatchObject({
      statusCode: 503, code: MAINNET_KEEP_MAIL_DISABLED,
    });
    await expect(deliverAdminMail(db, admin.wallet, {
      recipientWallet: owner.wallet,
      deliveryKey: unique('mainnet-misconfigured-keep'),
      subject: 'KEEP misconfigured',
      body: 'Enabled without an audited campaign must still fail closed.',
      attachments: [{ kind: 'KEEP', amount: 1n }],
    }, {
      keepCampaign: {
        cluster: 'mainnet-beta', enabled: true, campaignId: null, budget: null,
      },
    })).rejects.toMatchObject({
      statusCode: 503, code: MAINNET_KEEP_MAIL_MISCONFIGURED,
    });

    const shards = await deliverAdminMail(db, admin.wallet, {
      recipientWallet: owner.wallet,
      deliveryKey: unique('mainnet-shards'),
      subject: 'SHARDS remain available',
      body: 'The KEEP campaign switch is currency-specific.',
      attachments: [{ kind: 'SHARDS', amount: 3n }],
    }, { keepCampaign: disabled });
    const item = await deliverAdminMail(db, admin.wallet, {
      recipientWallet: owner.wallet,
      deliveryKey: unique('mainnet-item'),
      subject: 'Item remains available',
      body: 'The KEEP campaign switch is currency-specific.',
      attachments: [{ kind: 'ITEM', itemId: 'keg_of_haste', qty: 1 }],
    }, { keepCampaign: disabled });
    const info = await deliverAdminMail(db, admin.wallet, {
      recipientWallet: owner.wallet,
      deliveryKey: unique('mainnet-info'),
      subject: 'Info remains available',
      body: 'No reward is reserved.',
    }, { keepCampaign: disabled });
    expect([shards, item, info].every((result) => result.duplicate === false)).toBe(true);
  });

  it('caps cumulative campaign reservations, does not charge a replay, and never replenishes on expiry', async () => {
    const owner = await createTestPlayer(db);
    const policy = campaign(100n);
    const sentAt = new Date('2025-01-01T00:00:00Z');
    const input = {
      recipientWallet: owner.wallet,
      deliveryKey: unique('campaign-first'),
      subject: 'Community campaign',
      body: 'A bounded mainnet KEEP reward.',
      attachments: [{ kind: 'KEEP' as const, amount: 60n }],
    };
    const first = await deliverAdminMail(db, admin.wallet, input, {
      now: sentAt, keepCampaign: policy,
    });
    const replay = await deliverAdminMail(db, admin.wallet, input, {
      keepCampaign: { ...policy, enabled: false },
    });
    expect(replay.duplicate).toBe(true);
    expect(replay.message.id).toBe(first.message.id);

    await expireDueMailRewards(db, first.message.expiresAt!);
    expect((await getMail(db, owner.wallet, first.message.id)).rewardState).toBe('expired');
    await expect(deliverAdminMail(db, admin.wallet, {
      ...input,
      deliveryKey: unique('campaign-over-cap'),
      attachments: [{ kind: 'KEEP', amount: 41n }],
    }, { keepCampaign: policy })).rejects.toMatchObject({
      statusCode: 409, code: MAINNET_KEEP_MAIL_BUDGET_EXCEEDED,
    });
    const exact = await deliverAdminMail(db, admin.wallet, {
      ...input,
      deliveryKey: unique('campaign-exact-cap'),
      attachments: [{ kind: 'KEEP', amount: 40n }],
    }, { keepCampaign: policy });
    await claimMailReward(db, owner.wallet, exact.message.id, undefined, authority);

    const rows = await db.select({ metadata: ledgerTransactions.metadata })
      .from(ledgerTransactions).where(and(
        eq(ledgerTransactions.type, 'mail.reward.reserve'),
        sql`${ledgerTransactions.metadata} ->> 'communityKeepCampaignId' = ${policy.campaignId!}`,
      ));
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.metadata)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        communityKeepCampaignId: policy.campaignId,
        communityKeepCampaignBudget: '100',
        communityKeepReserved: '60',
        campaignAdminWallet: admin.wallet,
      }),
      expect.objectContaining({ communityKeepReserved: '40' }),
    ]));
  });

  it('serializes concurrent campaign reservations so only work inside the cumulative cap commits', async () => {
    const [firstOwner, secondOwner] = await Promise.all([createTestPlayer(db), createTestPlayer(db)]);
    const policy = campaign(70n);
    const results = await Promise.allSettled([
      deliverAdminMail(db, admin.wallet, {
        recipientWallet: firstOwner.wallet,
        deliveryKey: unique('campaign-race-a'),
        subject: 'Concurrent A', body: 'Only one reservation fits.',
        attachments: [{ kind: 'KEEP', amount: 50n }],
      }, { keepCampaign: policy }),
      deliverAdminMail(db, admin.wallet, {
        recipientWallet: secondOwner.wallet,
        deliveryKey: unique('campaign-race-b'),
        subject: 'Concurrent B', body: 'Only one reservation fits.',
        attachments: [{ kind: 'KEEP', amount: 50n }],
      }, { keepCampaign: policy }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: { code: MAINNET_KEEP_MAIL_BUDGET_EXCEEDED },
    });
    const rows = await db.select({ metadata: ledgerTransactions.metadata })
      .from(ledgerTransactions).where(and(
        eq(ledgerTransactions.type, 'mail.reward.reserve'),
        sql`${ledgerTransactions.metadata} ->> 'communityKeepCampaignId' = ${policy.campaignId!}`,
      ));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metadata).toMatchObject({ communityKeepReserved: '50' });
    const succeeded = results.find((result) => result.status === 'fulfilled');
    if (!succeeded || succeeded.status !== 'fulfilled') throw new Error('campaign winner missing');
    await claimMailReward(
      db,
      succeeded.value.message.recipientWallet,
      succeeded.value.message.id,
      undefined,
      authority,
    );
  });

  it('expires a sold-base reward before deed preflight', async () => {
    const owner = await createTestPlayer(db);
    const buyer = await createTestPlayer(db);
    const base = await activeBase(owner.wallet);
    const sent = await deliverSystemMail(db, {
      recipientWallet: owner.wallet, deliveryKey: unique('sold-expiry'),
      subject: 'Returned supplies', body: 'Expiry must not depend on the sold deed.',
      attachments: [{ kind: 'SHARDS', amount: 31n }],
    }, new Date('2025-01-01T00:00:00Z'));
    await db.transaction(async (tx) => {
      await tx.delete(baseSlots).where(eq(baseSlots.baseId, base.id));
      await tx.update(bases).set({ ownerWallet: buyer.wallet }).where(eq(bases.id, base.id));
      await tx.insert(baseSlots).values({ wallet: buyer.wallet, slot: 1, baseId: base.id });
    });
    expect((await claimMailReward(
      db, owner.wallet, sent.message.id, base.id, authority, sent.message.expiresAt!,
    )).rewardState).toBe('expired');
  });

  it('expires a base reward during finalized RPC outage without invoking authority', async () => {
    const owner = await createTestPlayer(db);
    const base = await activeBase(owner.wallet);
    const sent = await deliverSystemMail(db, {
      recipientWallet: owner.wallet, deliveryKey: unique('rpc-expiry'),
      subject: 'Returned item', body: 'Expiry must remain authority-free.',
      attachments: [{ kind: 'ITEM', itemId: 'powder_charge', qty: 1 }],
    }, new Date('2025-01-01T00:00:00Z'));
    let authorityCalls = 0;
    const unavailable: MailClaimAuthority = {
      prepare: async () => { authorityCalls++; throw new Error('finalized RPC unavailable'); },
      assertLocked: async () => { authorityCalls++; throw new Error('finalized RPC unavailable'); },
    };
    expect((await claimMailReward(
      db, owner.wallet, sent.message.id, base.id, unavailable, sent.message.expiresAt!,
    )).rewardState).toBe('expired');
    expect(authorityCalls).toBe(0);
  });

  it('expires a due base reward when baseId is omitted', async () => {
    const owner = await createTestPlayer(db);
    const sent = await deliverSystemMail(db, {
      recipientWallet: owner.wallet, deliveryKey: unique('no-base-expiry'),
      subject: 'Returned shards', body: 'Expiry precedes request validation.',
      attachments: [{ kind: 'SHARDS', amount: 37n }],
    }, new Date('2025-01-01T00:00:00Z'));
    expect((await claimMailReward(
      db, owner.wallet, sent.message.id, undefined, authority, sent.message.expiresAt!,
    )).rewardState).toBe('expired');
  });

  it('fails a transferred-base claim closed without consuming wallet-owned mail', async () => {
    const owner = await createTestPlayer(db);
    const buyer = await createTestPlayer(db);
    const base = await activeBase(owner.wallet);
    const sent = await deliverSystemMail(db, {
      recipientWallet: owner.wallet,
      deliveryKey: unique('transfer'),
      subject: 'Base supplies', body: 'Claim to an active deed.',
      attachments: [{ kind: 'SHARDS', amount: 77n }],
    });
    await db.transaction(async (tx) => {
      await tx.delete(baseSlots).where(eq(baseSlots.baseId, base.id));
      await tx.update(bases).set({ ownerWallet: buyer.wallet }).where(eq(bases.id, base.id));
      await tx.insert(baseSlots).values({ wallet: buyer.wallet, slot: 1, baseId: base.id });
    });
    await expect(claimMailReward(db, owner.wallet, sent.message.id, base.id, authority))
      .rejects.toMatchObject({ code: 'DEED_OWNERSHIP_CHANGED' });
    expect((await getMail(db, owner.wallet, sent.message.id)).rewardState).toBe('pending');
    expect((await getOrCreateBaseAccount(db, base.id, 'base_shards')).balance).toBe(0n);
  });

  it('rolls back currency credit when an item stack would overflow', async () => {
    const owner = await createTestPlayer(db);
    const base = await activeBase(owner.wallet);
    await db.insert(baseItems).values({ baseId: base.id, itemId: 'powder_charge', qty: 2_147_483_647 });
    const sys = await bootstrapSystemAccounts(db);
    const sent = await deliverSystemMail(db, {
      recipientWallet: owner.wallet, deliveryKey: unique('overflow'),
      subject: 'Overflow guard', body: 'This claim must be all-or-nothing.',
      attachments: [
        { kind: 'KEEP', amount: 19n },
        { kind: 'ITEM', itemId: 'powder_charge', qty: 1 },
      ],
    });
    const reserveTxns = await db.select().from(ledgerTransactions).where(eq(
      ledgerTransactions.idempotencyKey, `mail:reserve:${sent.message.id}`,
    ));
    expect(reserveTxns).toHaveLength(1);
    expect(sent.message.reserveLedgerTxnId).toBe(reserveTxns[0]!.id);
    const reserveEntries = await db.select().from(ledgerEntries)
      .where(eq(ledgerEntries.txnId, reserveTxns[0]!.id));
    expect(reserveEntries).toHaveLength(2);
    expect(reserveEntries).toEqual(expect.arrayContaining([
      expect.objectContaining({ accountId: sys.emission_pool, delta: -19n }),
      expect.objectContaining({ accountId: sys.mail_keep_escrow, delta: 19n }),
    ]));

    await expect(claimMailReward(db, owner.wallet, sent.message.id, base.id, authority))
      .rejects.toMatchObject({ code: 'ITEM_STACK_OVERFLOW' });
    expect((await getOrCreatePlayerAccount(db, owner.wallet, 'player_keep')).balance).toBe(0n);
    expect((await getMail(db, owner.wallet, sent.message.id)).rewardState).toBe('pending');
    expect((await db.select().from(mailMessages)
      .where(eq(mailMessages.id, sent.message.id)))[0]).toMatchObject({
        rewardState: 'pending', claimLedgerTxnId: null, unwindLedgerTxnId: null,
      });
    expect(await db.select().from(ledgerTransactions).where(eq(
      ledgerTransactions.idempotencyKey, `mail:claim:${sent.message.id}`,
    ))).toHaveLength(0);
    expect((await db.select().from(baseItems).where(and(
      eq(baseItems.baseId, base.id), eq(baseItems.itemId, 'powder_charge'),
    )))[0]?.qty).toBe(2_147_483_647);

    await expireDueMailRewards(db, sent.message.expiresAt!);
    const expireTxns = await db.select().from(ledgerTransactions).where(eq(
      ledgerTransactions.idempotencyKey, `mail:expire:${sent.message.id}`,
    ));
    expect(expireTxns).toHaveLength(1);
    expect((await getMail(db, owner.wallet, sent.message.id)).rewardState).toBe('expired');
    expect((await db.select().from(mailMessages)
      .where(eq(mailMessages.id, sent.message.id)))[0]).toMatchObject({
        rewardState: 'expired', claimLedgerTxnId: null, unwindLedgerTxnId: expireTxns[0]!.id,
      });
    const expireEntries = await db.select().from(ledgerEntries)
      .where(eq(ledgerEntries.txnId, expireTxns[0]!.id));
    expect(expireEntries).toHaveLength(2);
    expect(expireEntries).toEqual(expect.arrayContaining([
      expect.objectContaining({ accountId: sys.mail_keep_escrow, delta: -19n }),
      expect.objectContaining({ accountId: sys.emission_pool, delta: 19n }),
    ]));
    expect((await getOrCreatePlayerAccount(db, owner.wallet, 'player_keep')).balance).toBe(0n);
  });

  it('serializes claim against expiry and conserves one reward outcome', async () => {
    const owner = await createTestPlayer(db);
    const sentAt = new Date('2026-01-01T00:00:00Z');
    const sent = await deliverSystemMail(db, {
      recipientWallet: owner.wallet, deliveryKey: unique('race'),
      subject: 'Race', body: 'Exactly one terminal path.',
      attachments: [{ kind: 'KEEP', amount: 91n }],
    }, sentAt);
    const due = sent.message.expiresAt!;
    await Promise.allSettled([
      claimMailReward(db, owner.wallet, sent.message.id, undefined, authority, new Date(due.getTime() - 1)),
      expireDueMailRewards(db, due),
    ]);
    const terminal = await getMail(db, owner.wallet, sent.message.id);
    expect(['claimed', 'expired']).toContain(terminal.rewardState);
    const playerKeep = (await getOrCreatePlayerAccount(db, owner.wallet, 'player_keep')).balance;
    expect(playerKeep === 0n || playerKeep === 91n).toBe(true);
    const claimTx = await db.select().from(ledgerTransactions).where(eq(
      ledgerTransactions.idempotencyKey, `mail:claim:${sent.message.id}`,
    ));
    const expireTx = await db.select().from(ledgerTransactions).where(eq(
      ledgerTransactions.idempotencyKey, `mail:expire:${sent.message.id}`,
    ));
    expect(claimTx.length + expireTx.length).toBe(1);
  });

  it('keeps claims and expiry unwinds live while new delivery is switched off', async () => {
    const owner = await createTestPlayer(db);
    const claimable = await deliverSystemMail(db, {
      recipientWallet: owner.wallet, deliveryKey: unique('gate-claim'),
      subject: 'Already delivered', body: 'The switch cannot strand this.',
      attachments: [{ kind: 'KEEP', amount: 13n }],
    });
    const old = await deliverSystemMail(db, {
      recipientWallet: owner.wallet, deliveryKey: unique('gate-expire'),
      subject: 'Already due', body: 'The switch cannot block this unwind.',
      attachments: [{ kind: 'KEEP', amount: 17n }],
    }, new Date('2025-01-01T00:00:00Z'));
    delete process.env['MAIL_DELIVERY_ENABLED'];
    try {
      expect((await claimMailReward(
        db, owner.wallet, claimable.message.id, undefined, authority,
      )).rewardState).toBe('claimed');
      await expireDueMailRewards(db, new Date('2025-03-01T00:00:00Z'));
      expect((await getMail(db, owner.wallet, old.message.id)).rewardState).toBe('expired');
      await expect(deliverSystemMail(db, {
        recipientWallet: owner.wallet, deliveryKey: unique('gate-new'), subject: 'No', body: 'No',
      })).rejects.toMatchObject({ code: 'MAIL_DELIVERY_DISABLED' });
    } finally {
      process.env['MAIL_DELIVERY_ENABLED'] = 'true';
    }
  });

  it('counts pending mail KEEP once in both Merkle attribution and live PoR', async () => {
    const owner = await createTestPlayer(db);
    const before = await checkReserves(db, async () => 10n ** 12n);
    const sent = await deliverSystemMail(db, {
      recipientWallet: owner.wallet, deliveryKey: unique('por'),
      subject: 'PoR', body: 'Escrow must be visible.',
      attachments: [{ kind: 'KEEP', amount: 47n }],
    });
    const check = await checkReserves(db, async () => 10n ** 12n);
    const sys = await bootstrapSystemAccounts(db);
    const mailEscrow = (await db.select().from(accounts).where(eq(accounts.id, sys.mail_keep_escrow)))[0]!.balance;
    expect(check.liabilityKeep).toBeGreaterThanOrEqual(mailEscrow);
    expect(check.liabilityKeep - before.liabilityKeep).toBe(47n);
    const snap = await buildWeeklySnapshot(db, new Date('2048-06-01T00:00:00Z'));
    const proof = await getInclusionProof(db, owner.wallet);
    expect(proof.epoch).toBe(snap.epoch.toString());
    expect(proof.amount).toBe('47');

    await claimMailReward(db, owner.wallet, sent.message.id, undefined, authority);
    const afterClaim = await checkReserves(db, async () => 10n ** 12n);
    expect(afterClaim.liabilityKeep).toBe(check.liabilityKeep); // escrow → player, still exactly one liability
    await buildWeeklySnapshot(db, new Date('2048-06-08T00:00:00Z'));
    expect((await getInclusionProof(db, owner.wallet)).amount).toBe('47');

    const expiringOwner = await createTestPlayer(db);
    const expiring = await deliverSystemMail(db, {
      recipientWallet: expiringOwner.wallet, deliveryKey: unique('por-expire'),
      subject: 'PoR expiry', body: 'This liability must disappear on unwind.',
      attachments: [{ kind: 'KEEP', amount: 29n }],
    }, new Date('2048-06-09T00:00:00Z'));
    const beforeExpiry = await checkReserves(db, async () => 10n ** 12n);
    await buildWeeklySnapshot(db, new Date('2048-06-15T00:00:00Z'));
    expect((await getInclusionProof(db, expiringOwner.wallet)).amount).toBe('29');
    await expireDueMailRewards(db, expiring.message.expiresAt!);
    const afterExpiry = await checkReserves(db, async () => 10n ** 12n);
    expect(beforeExpiry.liabilityKeep - afterExpiry.liabilityKeep).toBe(29n);
    await buildWeeklySnapshot(db, new Date('2048-07-13T00:00:00Z'));
    await expect(getInclusionProof(db, expiringOwner.wallet)).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe.sequential('mail HTTP/admin contract', () => {
  it('keeps reads on while delivery is disabled and binds admin rewards to exact recent intent', async () => {
    const recipientSession = await sessionFor(recipient.wallet);
    const adminSession = await sessionFor(admin.wallet);
    const key = unique('route-info');
    delete process.env['MAIL_DELIVERY_ENABLED'];
    const disabled = await app.inject({
      method: 'POST', url: '/admin/mail/send',
      cookies: { [SESSION_COOKIE]: adminSession.cookie },
      payload: { recipientWallet: recipient.wallet, idempotencyKey: key, subject: 'Off', body: 'No delivery' },
    });
    expect(disabled.statusCode).toBe(503);
    const status = await app.inject({
      method: 'GET', url: '/mail/status', cookies: { [SESSION_COOKIE]: recipientSession.cookie },
    });
    expect(status.statusCode).toBe(200);
    expect(status.headers['cache-control']).toBe('no-store, private');

    process.env['MAIL_DELIVERY_ENABLED'] = 'true';
    const body = {
      recipientWallet: recipient.wallet,
      idempotencyKey: unique('route-reward'),
      subject: 'Admin reward', body: 'Intent-bound.',
      attachments: [
        { kind: 'KEEP', amount: '23' },
        { kind: 'SHARDS', amount: '17' },
        { kind: 'ITEM', itemId: 'keg_of_haste', qty: 2 },
      ],
    };
    const noGrant = await app.inject({
      method: 'POST', url: '/admin/mail/send', cookies: { [SESSION_COOKIE]: adminSession.cookie }, payload: body,
    });
    expect(noGrant.statusCode).toBe(428);

    const input = {
      recipientWallet: body.recipientWallet, deliveryKey: body.idempotencyKey,
      subject: body.subject, body: body.body,
      attachments: [
        { kind: 'KEEP' as const, amount: 23n },
        { kind: 'SHARDS' as const, amount: 17n },
        { kind: 'ITEM' as const, itemId: 'keg_of_haste', qty: 2 },
      ],
    };
    const intent = {
      recipientWallet: recipient.wallet,
      idempotencyKey: body.idempotencyKey,
      ...adminRewardMailIntentSummary(input),
    };
    const challengeRoute = await app.inject({
      method: 'POST', url: '/auth/reauth/challenge',
      cookies: { [SESSION_COOKIE]: adminSession.cookie },
      payload: { purpose: 'admin_mail_reward', intent },
    });
    expect(challengeRoute.statusCode).toBe(200);
    const signedMessage = challengeRoute.json().message as string;
    expect(signedMessage).toContain(recipient.wallet);
    expect(signedMessage).toContain('Subject: "Admin reward"');
    expect(signedMessage).toContain('Attachment 1: 23 KEEP');
    expect(signedMessage).toContain('Attachment 2: 17 SHARDS');
    expect(signedMessage).toContain('Attachment 3: 2 × keg_of_haste');
    expect(signedMessage).toContain(intent.contentHash);
    const nonAdminChallenge = await app.inject({
      method: 'POST', url: '/auth/reauth/challenge',
      cookies: { [SESSION_COOKIE]: recipientSession.cookie },
      payload: { purpose: 'admin_mail_reward', intent },
    });
    expect(nonAdminChallenge.statusCode).toBe(403);
    const challenged = await issueRecentAuthChallenge(
      TEST_CONFIG, { wallet: admin.wallet, sessionId: adminSession.id }, 'admin_mail_reward', intent,
    );
    const granted = await issueRecentAuthGrant(TEST_CONFIG, challenged.claims);
    const tampered = await app.inject({
      method: 'POST', url: '/admin/mail/send',
      cookies: { [SESSION_COOKIE]: adminSession.cookie },
      headers: { [RECENT_AUTH_HEADER]: granted.grant },
      payload: { ...body, subject: 'Tampered reward' },
    });
    expect(tampered.statusCode).toBe(428);
    const tamperedAmount = await app.inject({
      method: 'POST', url: '/admin/mail/send',
      cookies: { [SESSION_COOKIE]: adminSession.cookie },
      headers: { [RECENT_AUTH_HEADER]: granted.grant },
      payload: {
        ...body,
        attachments: [{ kind: 'KEEP', amount: '24' }, ...body.attachments.slice(1)],
      },
    });
    expect(tamperedAmount.statusCode).toBe(428);
    const sent = await app.inject({
      method: 'POST', url: '/admin/mail/send',
      cookies: { [SESSION_COOKIE]: adminSession.cookie },
      headers: { [RECENT_AUTH_HEADER]: granted.grant }, payload: body,
    });
    expect(sent.statusCode, sent.body).toBe(200);

    const inbox = await app.inject({
      method: 'GET', url: '/mail', cookies: { [SESSION_COOKIE]: recipientSession.cookie },
    });
    expect(inbox.statusCode).toBe(200);
    expect(inbox.headers['cache-control']).toBe('no-store, private');
    expect(inbox.body).not.toContain(recipient.wallet);
    expect(inbox.body).not.toContain(admin.wallet);
  });

  it('threads parsed mainnet config into the KEEP gate while admin info mail remains available', async () => {
    const mainnetConfig = {
      ...TEST_CONFIG,
      SOLANA_CLUSTER: 'mainnet-beta' as const,
      SOLANA_RPC_URL: 'https://mainnet.provider-a.example',
      SOLANA_RPC_URL_2: 'https://mainnet.provider-b.example',
      SOLANA_RPC_PROVIDER: 'provider-a',
      SOLANA_RPC_PROVIDER_2: 'provider-b',
      MAINNET_COMMUNITY_KEEP_MAIL_ENABLED: 'false' as const,
      ADMIN_WALLETS: [admin.wallet],
    };
    const mainnetApp = await buildApp(mainnetConfig, db);
    await mainnetApp.ready();
    try {
      const adminSession = await sessionFor(admin.wallet);
      const keepBody = {
        recipientWallet: recipient.wallet,
        idempotencyKey: unique('mainnet-route-disabled'),
        subject: 'Mainnet disabled',
        body: 'A route may not fall back to the process devnet default.',
        attachments: [{ kind: 'KEEP', amount: '1' }],
      };
      const input = {
        recipientWallet: keepBody.recipientWallet,
        deliveryKey: keepBody.idempotencyKey,
        subject: keepBody.subject,
        body: keepBody.body,
        attachments: [{ kind: 'KEEP' as const, amount: 1n }],
      };
      const intent = {
        recipientWallet: recipient.wallet,
        idempotencyKey: keepBody.idempotencyKey,
        ...adminRewardMailIntentSummary(input),
      };
      const challenge = await issueRecentAuthChallenge(
        mainnetConfig,
        { wallet: admin.wallet, sessionId: adminSession.id },
        'admin_mail_reward',
        intent,
      );
      const grant = await issueRecentAuthGrant(mainnetConfig, challenge.claims);
      const blocked = await mainnetApp.inject({
        method: 'POST',
        url: '/admin/mail/send',
        cookies: { [SESSION_COOKIE]: adminSession.cookie },
        headers: { [RECENT_AUTH_HEADER]: grant.grant },
        payload: keepBody,
      });
      expect(blocked.statusCode, blocked.body).toBe(503);
      expect(blocked.json()).toMatchObject({
        error: { code: MAINNET_KEEP_MAIL_DISABLED },
      });

      const info = await mainnetApp.inject({
        method: 'POST',
        url: '/admin/mail/send',
        cookies: { [SESSION_COOKIE]: adminSession.cookie },
        payload: {
          recipientWallet: recipient.wallet,
          idempotencyKey: unique('mainnet-route-info'),
          subject: 'Information',
          body: 'Information mail is not a KEEP campaign.',
        },
      });
      expect(info.statusCode, info.body).toBe(200);
    } finally {
      await mainnetApp.close();
    }
  });
});
