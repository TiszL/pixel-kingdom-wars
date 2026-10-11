import { isDarkAttackerTroop } from '@shardkeep/shared';

export interface DarkAttackerRosterFeature {
  enabled?: boolean;
  code?: string;
  message?: string;
}

/** The SIM6 roster is an expand/activate rollout. Membership is shared, but
 * activation is exclusively the capability returned by the server. An old
 * response that omits the field therefore fails closed instead of exposing an
 * order that rollback code cannot understand. */
export function troopRolloutGate(
  troop: string,
  capability: DarkAttackerRosterFeature | undefined,
): { locked: boolean; message?: string } {
  if (!isDarkAttackerTroop(troop)) return { locked: false };
  if (capability?.enabled === true) return { locked: false };
  const message = capability?.message?.trim();
  return { locked: true, message: message || 'COMING SOON' };
}
