import { NOTIFICATIONS } from '@shardkeep/shared';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { DbTx } from '../db/client';
import { nativePushSubscriptions, pushSubscriptions } from '../db/schema';

/** Caller holds the player row lock. Both transports share the existing cap. */
export async function enforceSubscriptionCap(
  tx: DbTx, wallet: string, keep: { channel: 'web' | 'native'; id: string }, now: Date,
): Promise<void> {
  const web = await tx.select({ id: pushSubscriptions.id, enabledAt: pushSubscriptions.enabledAt })
    .from(pushSubscriptions).where(and(eq(pushSubscriptions.wallet, wallet), isNull(pushSubscriptions.disabledAt)));
  const native = await tx.select({ id: nativePushSubscriptions.id, enabledAt: nativePushSubscriptions.enabledAt })
    .from(nativePushSubscriptions).where(and(eq(nativePushSubscriptions.wallet, wallet), isNull(nativePushSubscriptions.disabledAt)));
  const others = [
    ...web.map((row) => ({ ...row, channel: 'web' as const })),
    ...native.map((row) => ({ ...row, channel: 'native' as const })),
  ].filter((row) => row.channel !== keep.channel || row.id !== keep.id)
    .sort((a, b) => b.enabledAt.getTime() - a.enabledAt.getTime() || b.id.localeCompare(a.id));
  const evict = others.slice(NOTIFICATIONS.subscriptionMaxPerWallet - 1);
  for (const [channel, table] of [['web', pushSubscriptions], ['native', nativePushSubscriptions]] as const) {
    const ids = evict.filter((row) => row.channel === channel).map((row) => row.id);
    if (ids.length) await tx.update(table).set({ disabledAt: now }).where(inArray(table.id, ids));
  }
}
