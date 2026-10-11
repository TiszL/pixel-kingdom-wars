/** The new operation must preserve the existing mail/Forge proof predicates. */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { baseForgePositions, baseItems } from '../src/db/schema';
import { getOrCreateBaseAccount, postTransaction } from '../src/ledger';
import { deliverSystemMail, getMail } from '../src/mail/service';
import { custodyLeagueFixture, WEEKS, type CustodyLeagueFixture } from './fixtures/custodyLeague';

let f: CustodyLeagueFixture;
beforeEach(async () => { f = await custodyLeagueFixture(); }, 60_000);
afterEach(async () => { vi.unstubAllEnvs(); await f?.dispose(); });

describe('combined original league retirement operation', () => {
  it('atomically retires L1, real mail, settled Forge and original league, then replays their immutable receipts', async () => {
    await f.capture(); await f.migrateAll();
    const day = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const escrow = await getOrCreateBaseAccount(f.db, f.baseId, 'base_forge_escrow');
    await postTransaction(f.db, { idempotencyKey: randomUUID(), type: 'test.combined-fund', entries: [
      { account: f.sys.keep_genesis, delta: -12n }, { account: f.sys.emission_pool, delta: 12n },
      { account: f.sys.shard_genesis, delta: -8n }, { account: escrow.id, delta: 8n },
    ] });
    const metadata = { day, baseId: f.baseId, counted: '8' };
    const burned = await postTransaction(f.db, { idempotencyKey: `forge:base:${day}:${f.baseId}:shards`, type: 'forge.burn', metadata,
      entries: [{ account: escrow.id, delta: -8n }, { account: f.sys.shard_burn, delta: 8n }] });
    const allocated = await postTransaction(f.db, { idempotencyKey: `forge:base:${day}:${f.baseId}:keep`, type: 'forge.allocate', metadata,
      entries: [{ account: f.sys.emission_pool, delta: -9n }, { account: f.sys.forge_payout_escrow, delta: 9n }] });
    const [position] = await f.db.insert(baseForgePositions).values({ day, baseId: f.baseId, contributedShards: 10n,
      raidDebitedShards: 2n, countedShards: 8n, shardsRefunded: 0n, keepPaid: 9n,
      settlementOwnerWallet: f.seller, itemsDropped: ['keg_of_haste'], shardSettlementTxnId: burned.transaction.id,
      keepEscrowTxnId: allocated.transaction.id, settledAt: new Date(Date.now() - 1000) }).returning();
    await f.db.insert(baseItems).values({ baseId: f.baseId, itemId: 'keg_of_haste', qty: 1 });
    vi.stubEnv('MAIL_DELIVERY_ENABLED', 'true');
    const mail = await deliverSystemMail(f.db, { recipientWallet: f.seller, deliveryKey: 'league-combined',
      subject: 'Combined retirement fixture', body: 'Preserve the original reward', attachments: [{ kind: 'KEEP', amount: 3n }] });
    const at = new Date().toISOString(); await f.authorizeBuyer(at);
    const request = { ...f.retirementRequest(at),
      mails: [{ messageId: mail.message.id, wallet: f.seller, keep: '3', internal: false }],
      forge: [{ positionId: position!.id, baseId: f.baseId, day, wallet: f.buyer, keep: '9', internal: false }],
    };
    const source = await f.historicalGraph();
    const items = JSON.stringify(await f.sql`select * from base_items order by id`);
    const emission = await f.balance('emission_pool');
    expect(await f.balance('league_entitlement_escrow')).toBe(240n);
    expect(await f.balance('forge_payout_escrow')).toBe(9n);
    expect(await f.balance('mail_keep_escrow')).toBe(3n);
    await f.closeCustody();
    const first = await f.apply(request);
    expect(first).toMatchObject({ measuredG8: true, totalKeepConverted: '852', sweptInternalKeep: '0' });
    expect(await f.balance('player_gems', f.seller)).toBe(603n);
    expect(await f.balance('player_gems', f.buyer)).toBe(249n);
    expect(await f.balance('player_keep', f.seller)).toBe(0n);
    for (const kind of ['league_entitlement_escrow', 'forge_payout_escrow', 'mail_keep_escrow', 'base_forge_escrow']) {
      expect(await f.balance(kind)).toBe(0n);
    }
    expect(await f.balance('emission_pool')).toBe(emission + 852n);
    expect(await f.balance('league_pool')).toBe(160n);
    expect((await getMail(f.db, f.seller, mail.message.id)).rewardState).toBe('claimed');
    expect(await f.sql`select public.shardkeep_mail_keep_retired(attachment_id) as retired from mail_keep_retirements`)
      .toEqual([{ retired: true }]);
    const [claimed] = await f.sql<{ claimed_at: string; claim_txn_id: string }[]>`
      select claimed_at,claim_txn_id from base_forge_positions where id=${position!.id}`;
    expect(new Date(claimed!.claimed_at).toISOString()).toBe(at);
    expect(claimed!.claim_txn_id).toEqual(expect.any(String));
    const [journal] = await f.sql<{ operation: string; subcommand: string; receipts: { idempotencyKey: string }[] }[]>`
      select operation,subcommand,receipts from keep_custody_journal where id=${request.fixtureId}`;
    expect(journal).toMatchObject({ operation: 'fixture:l1-mail-forge-league-retirement', subcommand: 'retire-l1-mail-forge-league' });
    expect(journal!.receipts.map(receipt => receipt.idempotencyKey).sort()).toEqual([
      `retirement:${f.seller}`, `mail:retire:${mail.message.id}`, `forge:base:${day}:${f.baseId}:claim`,
      `league:retire:${f.baseId}:${WEEKS[1]}`,
    ].sort());
    expect(await f.historicalGraph()).toBe(source);
    expect(JSON.stringify(await f.sql`select * from base_items order by id`)).toBe(items);
    await f.sql`update bases set owner_wallet=${f.bronze} where id=${f.baseId}`;
    await f.sql`update deed_ownership_observations set status='unavailable' where base_id=${f.baseId}`;
    vi.stubEnv('GEMS_ENABLED', 'false');
    const settled = await f.money();
    expect(await f.apply(request)).toEqual(first); expect(await f.money()).toBe(settled);
    expect(await f.balance('player_gems', f.bronze)).toBe(0n);
    expect(await f.historicalGraph()).toBe(source);
    expect(JSON.stringify(await f.sql`select * from base_items order by id`)).toBe(items);
  }, 60_000);
});
