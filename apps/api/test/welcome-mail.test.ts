/**
 * Playtest welcome mail (owner 2026-08-22, D-067 §4).
 * WHY: the 5,000 KEEP welcome is a money flow — it must be attached exactly
 * once per wallet, debited from the emission pool into the mail escrow, absent
 * on any non-devnet cluster, and never able to block founding the base.
 */
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEVNET_FAUCET, PLAYTEST } from '@shardkeep/shared';
import { ensureStartingBase } from '../src/game/base';
import { accounts, mailMessages } from '../src/db/schema';
import { bootstrapSystemAccounts } from '../src/ledger/accounts';
import { connectTestDb, createTestPlayer } from './helpers';

const conn = connectTestDb();
const db = conn.db;
let cluster: string | undefined;

beforeAll(async () => {
  process.env['MAIL_DELIVERY_ENABLED'] = 'true';
  cluster = process.env['SOLANA_CLUSTER'];
  delete process.env['SOLANA_CLUSTER']; // base.ts defaults to devnet
  await bootstrapSystemAccounts(db);
});
afterAll(async () => {
  delete process.env['MAIL_DELIVERY_ENABLED'];
  if (cluster === undefined) delete process.env['SOLANA_CLUSTER']; else process.env['SOLANA_CLUSTER'] = cluster;
  await conn.sql.end();
});

async function balance(id: string): Promise<bigint> {
  return (await db.select().from(accounts).where(eq(accounts.id, id)))[0]!.balance;
}
async function welcomeFor(wallet: string) {
  const [mail] = await db.select().from(mailMessages)
    .where(and(eq(mailMessages.recipientWallet, wallet), eq(mailMessages.dedupeKey, `welcome:${wallet}`)));
  if (!mail) return null;
  const rows = await db.execute<{ kind: string; amount: string | null }>(sql`select kind, amount::text as amount from mail_attachments where message_id = ${mail.id}`);
  return { mail, attachments: (rows as unknown as Array<{ kind: string; amount: string | null }>) };
}

describe.sequential('playtest welcome mail', () => {
  it('attaches exactly PLAYTEST.welcomeKeep KEEP once per wallet on devnet, reserved from the emission pool', async () => {
    const sys = await bootstrapSystemAccounts(db);
    const p = await createTestPlayer(db);
    const pool0 = await balance(sys.emission_pool);
    const escrow0 = await balance(sys.mail_keep_escrow);

    await ensureStartingBase(db, p.wallet);
    const first = await welcomeFor(p.wallet);
    expect(first).not.toBeNull();
    expect(first!.mail.subject).toBe('⚔ WELCOME TO THE PLAYTEST');
    expect(first!.mail.kind).toBe('reward');
    expect(first!.attachments).toEqual([{ kind: 'KEEP', amount: String(PLAYTEST.welcomeKeep) }]);
    // D-098: the mail points at the in-game CLAIM control with the live policy
    // numbers, never walks the player through faucet.solana.com (which may ask
    // for a mainnet balance) — that faucet is named once, only as a caveat.
    expect(first!.mail.body).toContain('CLAIM');
    expect(first!.mail.body).toContain(`up to ${DEVNET_FAUCET.lifetimeCapSol} SOL per wallet`);
    expect(first!.mail.body).toContain(`${DEVNET_FAUCET.cooldownHours} h apart`);
    expect(first!.mail.body).not.toMatch(/faucet\.solana\.com in your browser/);
    expect(first!.mail.body.match(/faucet\.solana\.com/g) ?? []).toHaveLength(1);
    expect(await balance(sys.emission_pool)).toBe(pool0 - BigInt(PLAYTEST.welcomeKeep));
    expect(await balance(sys.mail_keep_escrow)).toBe(escrow0 + BigInt(PLAYTEST.welcomeKeep));

    // A second base for the same wallet (multi-base) never pays a second reward.
    await ensureStartingBase(db, p.wallet, undefined);
    const count = await db.select({ n: sql<number>`count(*)::int` }).from(mailMessages)
      .where(and(eq(mailMessages.recipientWallet, p.wallet), eq(mailMessages.dedupeKey, `welcome:${p.wallet}`)));
    expect(count[0]!.n).toBe(1);
    expect(await balance(sys.emission_pool)).toBe(pool0 - BigInt(PLAYTEST.welcomeKeep));
  });

  it('sends an info-only welcome (no KEEP, no reservation) on any cluster but devnet', async () => {
    const sys = await bootstrapSystemAccounts(db);
    process.env['SOLANA_CLUSTER'] = 'mainnet-beta';
    try {
      const p = await createTestPlayer(db);
      const pool0 = await balance(sys.emission_pool);
      await ensureStartingBase(db, p.wallet);
      const w = await welcomeFor(p.wallet);
      expect(w).not.toBeNull();
      expect(w!.mail.subject).toBe('⚔ WELCOME TO PIXEL KINGDOM WARS');
      expect(w!.attachments).toEqual([]);
      expect(await balance(sys.emission_pool)).toBe(pool0);
    } finally {
      delete process.env['SOLANA_CLUSTER'];
    }
  });
});
