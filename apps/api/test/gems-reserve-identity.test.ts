import { readFileSync } from 'node:fs';
import { keepAta } from '@shardkeep/chain';
import { Keypair, PublicKey } from '@solana/web3.js';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { economyChainIdentity } from '../src/db/schema';
import { assertGemsReserveIdentity, gemsReserveAta, verifyGemsReserveAccount } from '../src/money/economyIdentity';
import type { FinalizedAccountReader } from '../src/money/reserves';
import { connectTestDb } from './helpers';
import {
  bindGemsTestReserve, gemsReserveAccount, gemsTestAta, gemsTestConfig, gemsTestIdentity,
  gemsTestMint, gemsTestOwner, gemsTestReader,
} from './gems-reserve-fixture';

const conn = connectTestDb();
beforeAll(async () => bindGemsTestReserve(conn.db));
afterAll(async () => conn.sql.end());

function reader(value: ReturnType<typeof gemsReserveAccount> | null): FinalizedAccountReader {
  return { getAccountInfoAndContext: vi.fn(async () => ({ context: { slot: 123 }, value })) };
}

describe('Gems reserve finalized proof', () => {
  it('derives the Classic SPL ATA and requests finalized evidence on every provider', async () => {
    const first = reader(gemsReserveAccount()); const second = reader(gemsReserveAccount());
    const result = await verifyGemsReserveAccount(gemsTestConfig, gemsTestMint.toBase58(), [first, second]);
    expect(result).toEqual({ owner: gemsTestOwner.toBase58(), ata: gemsTestAta.toBase58(), mint: gemsTestMint.toBase58() });
    for (const rpc of [first, second]) expect(rpc.getAccountInfoAndContext).toHaveBeenCalledWith(gemsTestAta, 'finalized');
  });

  it('accepts a multisig vault PDA authority without weakening wallet source derivation', async () => {
    const [owner] = PublicKey.findProgramAddressSync([Buffer.from('gems-reserve-test')], new PublicKey(gemsTestIdentity.coreProgram));
    expect(PublicKey.isOnCurve(owner.toBytes())).toBe(false);
    const result = await verifyGemsReserveAccount({ ...gemsTestConfig, GEMS_RESERVE_OWNER: owner.toBase58() }, gemsTestMint.toBase58(), [reader(gemsReserveAccount(owner))]);
    expect(result?.ata).toBe(keepAta(owner, gemsTestMint, true).toBase58());
    expect(() => keepAta(owner, gemsTestMint)).toThrow();
  });

  it.each([
    ['missing', (): ReturnType<typeof gemsReserveAccount> | null => null],
    ['wrong token program', () => ({ ...gemsReserveAccount(), owner: Keypair.generate().publicKey })],
    ['executable', () => ({ ...gemsReserveAccount(), executable: true })],
    ['short layout', () => ({ ...gemsReserveAccount(), data: Buffer.alloc(164) })],
    ['extended layout', () => ({ ...gemsReserveAccount(), data: Buffer.alloc(166) })],
    ['wrong mint', () => gemsReserveAccount(gemsTestOwner, Keypair.generate().publicKey)],
    ['wrong authority', () => gemsReserveAccount(Keypair.generate().publicKey)],
    ['uninitialized', () => { const a = gemsReserveAccount(); a.data[108] = 0; return a; }],
    ['frozen', () => { const a = gemsReserveAccount(); a.data[108] = 2; return a; }],
    ['invalid state', () => { const a = gemsReserveAccount(); a.data[108] = 3; return a; }],
    ['delegate', () => { const a = gemsReserveAccount(); a.data.writeUInt32LE(1, 72); return a; }],
    ['invalid delegate tag', () => { const a = gemsReserveAccount(); a.data.writeUInt32LE(2, 72); return a; }],
    ['delegated amount', () => { const a = gemsReserveAccount(); a.data.writeBigUInt64LE(1n, 121); return a; }],
    ['close authority', () => { const a = gemsReserveAccount(); a.data.writeUInt32LE(1, 129); return a; }],
    ['native token', () => { const a = gemsReserveAccount(); a.data.writeUInt32LE(1, 109); return a; }],
  ] as const)('refuses %s before admitting a transfer destination', async (_label, account) => {
    await expect(verifyGemsReserveAccount(gemsTestConfig, gemsTestMint.toBase58(), [reader(account())])).rejects.toThrow(/Gems reserve/);
  });

  it('refuses hot custody, arbitrary ATA, missing owner/custody evidence and provider disagreement', async () => {
    await expect(verifyGemsReserveAccount({ ...gemsTestConfig, GEMS_RESERVE_OWNER: gemsTestConfig.HOT_WALLET_PUBKEY }, gemsTestMint.toBase58(), [gemsTestReader])).rejects.toThrow(/custody hot ATA/);
    await expect(verifyGemsReserveAccount({ ...gemsTestConfig, GEMS_RESERVE_ATA: Keypair.generate().publicKey.toBase58() }, gemsTestMint.toBase58(), [gemsTestReader])).rejects.toThrow(/canonical reserve ATA/);
    await expect(verifyGemsReserveAccount({ GEMS_RESERVE_ATA: gemsTestAta.toBase58() }, gemsTestMint.toBase58(), [gemsTestReader])).rejects.toThrow(/requires GEMS_RESERVE_OWNER/);
    await expect(verifyGemsReserveAccount({ GEMS_RESERVE_OWNER: gemsTestOwner.toBase58() }, gemsTestMint.toBase58(), [gemsTestReader])).rejects.toThrow(/known custody hot wallet/);
    await expect(verifyGemsReserveAccount(gemsTestConfig, gemsTestMint.toBase58(), [])).rejects.toThrow(/finalized RPC evidence/);
    await expect(verifyGemsReserveAccount(gemsTestConfig, gemsTestMint.toBase58(), [gemsTestReader, reader(null)])).rejects.toThrow(/missing/);
    await expect(verifyGemsReserveAccount(gemsTestConfig, gemsTestMint.toBase58(), [{ getAccountInfoAndContext: async () => { throw new Error('RPC unavailable'); } }])).rejects.toThrow(/RPC unavailable/);
  });
});

describe('database-pinned Gems destination', () => {
  it('restarts with the same binding and cannot use it with a different mint', async () => {
    await assertGemsReserveIdentity(conn.db, gemsTestConfig, gemsTestIdentity, [gemsTestReader]);
    expect(gemsReserveAta(conn.db, gemsTestMint.toBase58())).toBe(gemsTestAta.toBase58());
    expect(gemsReserveAta(conn.db, Keypair.generate().publicKey.toBase58())).toBeNull();
  });

  it('rejects removal or drift even while purchase flags are off and leaves no admitted target after failure', async () => {
    await expect(assertGemsReserveIdentity(conn.db, {}, gemsTestIdentity, [])).rejects.toThrow(/identity differs/);
    expect(gemsReserveAta(conn.db)).toBeNull();
    const owner = Keypair.generate().publicKey;
    await expect(assertGemsReserveIdentity(conn.db, { ...gemsTestConfig, GEMS_RESERVE_OWNER: owner.toBase58() }, gemsTestIdentity, [reader(gemsReserveAccount(owner))])).rejects.toThrow(/identity differs/);
    await expect(assertGemsReserveIdentity(conn.db, gemsTestConfig, { ...gemsTestIdentity, cluster: 'mainnet-beta' }, [gemsTestReader])).rejects.toThrow(/selected database/);
    await bindGemsTestReserve(conn.db);
  });

  it('the DB trigger forbids rebinding, clearing, changing chain identity and deletion', async () => {
    const other = Keypair.generate().publicKey.toBase58();
    await expect(conn.db.update(economyChainIdentity).set({ gemsReserveOwner: other, gemsReserveAta: other })).rejects.toThrow();
    await expect(conn.db.update(economyChainIdentity).set({ gemsReserveOwner: null, gemsReserveAta: null })).rejects.toThrow();
    await expect(conn.db.update(economyChainIdentity).set({ keepMint: other })).rejects.toThrow();
    await expect(conn.db.delete(economyChainIdentity)).rejects.toThrow();
    const [row] = await conn.db.select().from(economyChainIdentity);
    expect(row).toMatchObject({ gemsReserveOwner: gemsTestOwner.toBase58(), gemsReserveAta: gemsTestAta.toBase58(), keepMint: gemsTestMint.toBase58() });
  });

  it('the one-time transition cannot smuggle changes to the immutable chain fields', async () => {
    // Roll back a temporary table populated with the same real trigger, avoiding
    // any disable/reset escape on the persistent identity shared by the suite.
    await conn.db.transaction(async (tx) => {
      await tx.execute(sql`CREATE TEMP TABLE gems_identity_trigger_probe (LIKE economy_chain_identity INCLUDING ALL) ON COMMIT DROP`);
      await tx.execute(sql`CREATE TRIGGER probe_guard BEFORE INSERT OR UPDATE OR DELETE ON gems_identity_trigger_probe FOR EACH ROW EXECUTE FUNCTION public.shardkeep_guard_economy_chain_identity()`);
      await tx.execute(sql`INSERT INTO gems_identity_trigger_probe(singleton, cluster, keep_mint, core_program, config_pda) VALUES (true, 'devnet', ${gemsTestIdentity.keepMint}, ${gemsTestIdentity.coreProgram}, ${gemsTestIdentity.configPda})`);
      await tx.transaction(async (nested) => {
        await nested.execute(sql`UPDATE gems_identity_trigger_probe SET gems_reserve_owner = ${gemsTestOwner.toBase58()}, gems_reserve_ata = ${gemsTestAta.toBase58()}, cluster = 'mainnet-beta'`);
      }).then(() => { throw new Error('unexpected identity rewrite'); }, (error: unknown) => expect(String(error)).toMatch(/immutable|Failed query/));
      await tx.execute(sql`UPDATE gems_identity_trigger_probe SET gems_reserve_owner = ${gemsTestOwner.toBase58()}, gems_reserve_ata = ${gemsTestAta.toBase58()}`);
    });
  });

  it('API and worker prove the reserve before any routes, credits or worker queues start', () => {
    const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
    const worker = readFileSync(new URL('../src/jobs.ts', import.meta.url), 'utf8');
    expect(server.indexOf('await assertGemsReserveIdentity(db')).toBeLessThan(server.indexOf('bootstrapEconomyAllocations(db)'));
    const start = worker.slice(worker.indexOf('export async function startWorkers'));
    expect(start.indexOf('await assertGemsReserveIdentity(db')).toBeGreaterThan(0);
    expect(start.indexOf('await assertGemsReserveIdentity(db')).toBeLessThan(start.indexOf('new Queue('));
  });
});
