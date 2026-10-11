/** K-148: welcome aid is a once-per-wallet promise, not a mail delivery or a
 * base reward. Exhaustion must preserve that promise without issuing KEEP. */
import { randomUUID } from 'node:crypto';
import { PLAYTEST } from '@shardkeep/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { accounts, bases, baseSlots, buildings, ledgerEntries, ledgerTransactions, mailAttachments, mailMessages, welcomeGemsObligations } from '../src/db/schema';
import { ensureStartingBase } from '../src/game/base';
import { abandonFreeBase } from '../src/game/baseTransfer';
import { fundGemsRewardBudget, grantGems, grantKey } from '../src/game/gemsGrants';
import { bootstrapSystemAccounts, getOrCreatePlayerAccount, postTransaction } from '../src/ledger';
import { connectTestDb, createTestPlayer } from './helpers';

const conn = connectTestDb();
const db = conn.db;
const amount = BigInt(PLAYTEST.welcomeGems);
const envKeys = ['GEMS_ENABLED', 'DEVNET_WELCOME_GEMS_ENABLED', 'MAIL_DELIVERY_ENABLED', 'SOLANA_CLUSTER'] as const;
let env: Array<string | undefined>;
let previousBudget = 0n;

async function systemBalance(id: string) {
  return (await db.select().from(accounts).where(eq(accounts.id, id)))[0]!.balance;
}
async function drainBudget() {
  const sys = await bootstrapSystemAccounts(db);
  const remaining = await systemBalance(sys.gems_reward_budget);
  if (remaining > 0n) await postTransaction(db, {
    idempotencyKey: `test.welcome.drain:${randomUUID()}`, type: 'test.welcome.drain',
    entries: [{ account: sys.gems_reward_budget, delta: -remaining }, { account: sys.emission_pool, delta: remaining }],
  });
  return remaining;
}
async function fundBudget(keep = amount) {
  const sys = await bootstrapSystemAccounts(db);
  // Fixture backing originates in the mint dimension, not a shared finite pool.
  await postTransaction(db, {
    idempotencyKey: `test.welcome.seed:${randomUUID()}`, type: 'test.seed',
    entries: [{ account: sys.keep_genesis, delta: -keep }, { account: sys.emission_pool, delta: keep }],
  });
  await fundGemsRewardBudget(db, keep, randomUUID());
}
async function stableBase(wallet: string, slot = 1) {
  const [base] = await db.insert(bases).values({ ownerWallet: wallet }).returning();
  await db.insert(baseSlots).values({ wallet, slot, baseId: base!.id });
  return base!.id;
}
async function obligation(wallet: string) {
  return (await db.select().from(welcomeGemsObligations).where(eq(welcomeGemsObligations.wallet, wallet)))[0];
}
async function grants(wallet: string) {
  return db.select().from(ledgerTransactions).where(eq(ledgerTransactions.idempotencyKey, grantKey('welcome', wallet)));
}
async function gems(wallet: string) {
  return (await getOrCreatePlayerAccount(db, wallet, 'player_gems')).balance;
}
async function welcome(wallet: string) {
  const [mail] = await db.select().from(mailMessages).where(and(
    eq(mailMessages.recipientWallet, wallet), eq(mailMessages.dedupeKey, `welcome:${wallet}`),
  ));
  const attachments = mail ? await db.select().from(mailAttachments).where(eq(mailAttachments.messageId, mail.id)) : [];
  return { mail, attachments };
}
function errorCode(error: unknown): string | undefined {
  const e = error as { code?: string; cause?: unknown };
  return e?.code ?? (e?.cause ? errorCode(e.cause) : undefined);
}
async function rejectedCode(operation: PromiseLike<unknown>, code: string) {
  let caught: unknown;
  try { await operation; } catch (error) { caught = error; }
  expect(errorCode(caught)).toBe(code);
}

beforeEach(async () => {
  env = envKeys.map((key) => process.env[key]);
  process.env['GEMS_ENABLED'] = 'true';
  process.env['DEVNET_WELCOME_GEMS_ENABLED'] = 'true';
  process.env['MAIL_DELIVERY_ENABLED'] = 'true';
  process.env['SOLANA_CLUSTER'] = 'devnet';
  previousBudget = await drainBudget();
});
afterEach(async () => {
  try {
    await drainBudget();
    if (previousBudget > 0n) await fundGemsRewardBudget(db, previousBudget, randomUUID());
  } finally {
    envKeys.forEach((key, index) => {
      if (env[index] === undefined) delete process.env[key]; else process.env[key] = env[index];
    });
  }
});
afterAll(async () => { await conn.sql.end(); });

describe.sequential('durable welcome Gems', () => {
  it('keeps a failed promise and base, then settles from a fresh process handle while new grants are paused', async () => {
    const { wallet } = await createTestPlayer(db);
    const baseId = await stableBase(wallet);
    await ensureStartingBase(db, wallet, baseId);
    const accepted = await obligation(wallet);
    expect(accepted).toMatchObject({ wallet, gems: amount });
    expect(await grants(wallet)).toHaveLength(0);
    expect(await gems(wallet)).toBe(0n);
    expect(await db.select().from(buildings).where(and(eq(buildings.baseId, baseId), eq(buildings.type, 'keep')))).toHaveLength(1);
    const pending = await welcome(wallet);
    expect(pending.mail?.kind).toBe('info');
    expect(pending.mail?.body).toContain('GEMS are pending');
    expect(pending.mail?.body).not.toContain('already in your balance');
    expect(pending.attachments).toEqual([]);

    await fundBudget();
    process.env['GEMS_ENABLED'] = 'false';
    process.env['DEVNET_WELCOME_GEMS_ENABLED'] = 'false';
    const restarted = connectTestDb();
    try {
      await ensureStartingBase(restarted.db, wallet, baseId); // populated stable-base early return
      await ensureStartingBase(restarted.db, wallet, baseId);
    } finally { await restarted.sql.end(); }
    expect(await gems(wallet)).toBe(amount);
    expect(await obligation(wallet)).toEqual(accepted);
    const [grant] = await grants(wallet);
    expect(await grants(wallet)).toHaveLength(1);
    const entries = await db.select({ kind: accounts.kind, delta: ledgerEntries.delta }).from(ledgerEntries)
      .innerJoin(accounts, eq(accounts.id, ledgerEntries.accountId)).where(eq(ledgerEntries.txnId, grant!.id));
    expect(entries.map((e) => `${e.kind}:${e.delta}`).sort()).toEqual([
      `emission_pool:${amount}`, `gems_mint:${-amount}`, `gems_reward_budget:${-amount}`, `player_gems:${amount}`,
    ].sort());
    expect((await welcome(wallet)).attachments).toEqual([]);
  });

  it('serializes simultaneous first access and never pays again for a second stable base', async () => {
    await fundBudget(amount * 2n);
    const { wallet } = await createTestPlayer(db);
    const first = await stableBase(wallet);
    await Promise.all(Array.from({ length: 4 }, () => ensureStartingBase(db, wallet, first)));
    const second = await stableBase(wallet, 2);
    await ensureStartingBase(db, wallet, second);
    expect(await gems(wallet)).toBe(amount);
    expect(await grants(wallet)).toHaveLength(1);
    const sys = await bootstrapSystemAccounts(db);
    expect(await systemBalance(sys.gems_reward_budget)).toBe(amount);
    const received = await welcome(wallet);
    expect(received.attachments).toEqual([]);
    expect(received.mail?.body).toContain('GEMS are already in your balance');
  });

  it('retains an obligation when mail is disabled and after abandoning the free base', async () => {
    process.env['MAIL_DELIVERY_ENABLED'] = 'false';
    const { wallet } = await createTestPlayer(db);
    await ensureStartingBase(db, wallet);
    expect(await obligation(wallet)).toMatchObject({ gems: amount });
    expect((await welcome(wallet)).mail).toBeUndefined();
    await abandonFreeBase(db, wallet);
    await fundBudget();
    await ensureStartingBase(db, wallet);
    await ensureStartingBase(db, wallet);
    expect(await gems(wallet)).toBe(amount);
    expect(await grants(wallet)).toHaveLength(1);
    expect((await welcome(wallet)).attachments).toEqual([]);
  });

  it('does not add Gems to an earlier KEEP welcome, including after moving to another base', async () => {
    process.env['GEMS_ENABLED'] = 'false';
    const { wallet } = await createTestPlayer(db);
    await ensureStartingBase(db, wallet);
    const legacy = await welcome(wallet);
    expect(legacy.attachments).toMatchObject([{ kind: 'KEEP', amount: BigInt(PLAYTEST.welcomeKeep) }]);
    process.env['GEMS_ENABLED'] = 'true';
    await fundBudget();
    const next = await stableBase(wallet);
    await ensureStartingBase(db, wallet, next);
    expect(await obligation(wallet)).toBeUndefined();
    expect(await grants(wallet)).toHaveLength(0);
    expect(await gems(wallet)).toBe(0n);
    expect((await welcome(wallet)).mail?.id).toBe(legacy.mail!.id);
  });

  it('recognizes an old direct welcome grant even if no welcome mail was delivered', async () => {
    await fundBudget(amount * 2n);
    const { wallet } = await createTestPlayer(db);
    await grantGems(db, { wallet, gems: amount, reason: 'welcome' });
    await ensureStartingBase(db, wallet);
    expect(await obligation(wallet)).toBeUndefined();
    expect(await gems(wallet)).toBe(amount);
    expect(await grants(wallet)).toHaveLength(1);
    expect((await welcome(wallet)).attachments).toEqual([]);
  });

  it('cannot make an old wallet eligible by adding another stable base when its initial mail was disabled', async () => {
    process.env['GEMS_ENABLED'] = 'false';
    process.env['MAIL_DELIVERY_ENABLED'] = 'false';
    const { wallet } = await createTestPlayer(db);
    const first = await stableBase(wallet);
    await ensureStartingBase(db, wallet, first);
    process.env['GEMS_ENABLED'] = 'true';
    await fundBudget();
    const second = await stableBase(wallet, 2);
    await ensureStartingBase(db, wallet, second);
    expect(await obligation(wallet)).toBeUndefined();
    expect(await grants(wallet)).toHaveLength(0);
    expect(await gems(wallet)).toBe(0n);
  });

  it.each([
    ['SOLANA_CLUSTER', 'mainnet-beta'],
    ['GEMS_ENABLED', 'false'],
    ['DEVNET_WELCOME_GEMS_ENABLED', 'false'],
  ] as const)('does not accept a new obligation when %s=%s', async (key, value) => {
    process.env[key] = value;
    process.env['MAIL_DELIVERY_ENABLED'] = 'false';
    await fundBudget();
    const { wallet } = await createTestPlayer(db);
    await ensureStartingBase(db, wallet);
    expect(await obligation(wallet)).toBeUndefined();
    expect(await grants(wallet)).toHaveLength(0);
  });

  it('freezes the accepted positive amount and server timestamp; retries never read a new tuning amount', async () => {
    const { wallet } = await createTestPlayer(db);
    // Simulate a promise accepted under earlier tuning, before the process
    // running today's constant started. SQL still supplies acceptance time.
    const frozen = amount + 1n;
    const before = Date.now();
    await db.insert(welcomeGemsObligations).values({ wallet, gems: frozen, acceptedAt: new Date(0) });
    const accepted = await obligation(wallet);
    expect(accepted!.acceptedAt.getTime()).toBeGreaterThanOrEqual(before - 1_000);
    await rejectedCode(db.update(welcomeGemsObligations).set({ gems: amount }).where(eq(welcomeGemsObligations.wallet, wallet)), 'P0001');
    await rejectedCode(db.update(welcomeGemsObligations).set({ acceptedAt: new Date(0) }).where(eq(welcomeGemsObligations.wallet, wallet)), 'P0001');
    await rejectedCode(db.delete(welcomeGemsObligations).where(eq(welcomeGemsObligations.wallet, wallet)), 'P0001');
    const invalid = await createTestPlayer(db);
    await rejectedCode(db.insert(welcomeGemsObligations).values({ wallet: invalid.wallet, gems: 0n }), '23514');
    await fundBudget(frozen);
    process.env['GEMS_ENABLED'] = 'false';
    await ensureStartingBase(db, wallet);
    expect(await gems(wallet)).toBe(frozen);
    expect(await obligation(wallet)).toEqual(accepted);
    expect((await grants(wallet))[0]!.metadata).toMatchObject({ gems: frozen.toString() });
  });
});
