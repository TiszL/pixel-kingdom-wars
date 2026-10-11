/** Test-only pre-K232 writer for immutable, explicitly unpriced historical
 * observations. Real submitOrders still simulates/posts/captures; only its old
 * membership adapter is restored within the caller's bounded test operation.
 * This must never be used for current rule-covered gameplay acceptance. */
import { CLANS, PHASE_E_POLICY } from '@shardkeep/shared';
import { sql } from 'drizzle-orm';
import { vi } from 'vitest';
import * as chest from '../../src/game/clanCharterRaidChest';
export async function withHistoricalUnpricedClanWriter<T>(run: () => Promise<T>): Promise<T> {
  const route = vi.spyOn(chest, 'resolveOriginalClanRaidChest').mockImplementation(async (tx, raidId, actor, gross) => {
    const [historical] = await tx.execute<{ valid: boolean }>(sql`select exists(select 1 from public.clan_charter_raid_events
      where raid_id=${raidId}::uuid and attacker_wallet=${actor} and tithe_rule_id is null) valid`);
    if (!historical?.valid) throw Error('Historical fixture requires original unpriced capture');
    const [member] = await tx.execute<{ id: string }>(sql`select c.id from public.clan_members m join public.clans c on c.id=m.clan_id
      where m.player_wallet=${actor} for update of c`);
    return { history: 'unenrolled', clanId: member?.id ?? null,
      chestCut: member ? gross * BigInt(CLANS.chestTitheBps) / BigInt(PHASE_E_POLICY.basisPoints) : 0n };
  });
  const posting = vi.spyOn(chest, 'assertOriginalClanRaidChestPosting').mockImplementation(async (tx, raidId, ledgerId) => {
    const [historical] = await tx.execute<{ valid: boolean }>(sql`select exists(select 1 from public.clan_charter_raid_events e
      join public.clan_charter_loot_posts p on p.raid_id=e.raid_id where e.raid_id=${raidId}::uuid
      and e.tithe_rule_id is null and p.ledger_id=${ledgerId}::uuid and p.tx_key=pg_current_xact_id()::text) valid`);
    if (!historical?.valid) throw Error('Historical fixture requires the actual original loot capture');
  });
  try { return await run(); } finally { posting.mockRestore(); route.mockRestore(); }
}
