/** Wallet-owned plans, not purchases. Prices and capacity are always re-quoted. */
import { isTrainableTroop, TRAINING_PRESETS, TROOP_TYPES, type PreviousArmy, type TrainingComposition, type TrainingPreset, type TroopType } from '@shardkeep/shared';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { armyPresets, raids } from '../db/schema';
import { multiBaseEnabled } from '../config';
import { HttpError } from '../lib/errors';
import { requireActiveStablePrerequisiteBase } from './stableBasePrerequisites';

export function validateTrainingComposition(input: TrainingComposition): void {
  if (!Array.isArray(input) || input.length === 0 || input.length > TROOP_TYPES.length) {
    throw new HttpError(422, 'choose at least one troop type', 'TRAINING_COMPOSITION_INVALID');
  }
  const seen = new Set<string>();
  let total = 0;
  for (const row of input) {
    if (!row || !TROOP_TYPES.includes(row.troop) || !isTrainableTroop(row.troop)
      || !Number.isSafeInteger(row.count) || row.count < 1 || seen.has(row.troop)) {
      throw new HttpError(422, 'use one positive whole count per trainable troop type', 'TRAINING_COMPOSITION_INVALID');
    }
    seen.add(row.troop); total += row.count;
  }
  if (total > TRAINING_PRESETS.maxCompositionUnits) {
    throw new HttpError(422, `a plan supports up to ${TRAINING_PRESETS.maxCompositionUnits} troops`, 'TRAINING_COMPOSITION_INVALID');
  }
}

function validateSlot(slot: number): void {
  if (!Number.isInteger(slot) || slot < 1 || slot > TRAINING_PRESETS.slots) {
    throw new HttpError(422, 'unknown preset slot', 'TRAINING_PRESET_INVALID');
  }
}

export async function listArmyPresets(db: DbOrTx, wallet: string): Promise<TrainingPreset[]> {
  const rows = await db.select().from(armyPresets).where(eq(armyPresets.playerWallet, wallet)).orderBy(armyPresets.slot);
  return rows.map((r) => ({ slot: r.slot, name: r.name, composition: r.composition as TrainingComposition }));
}

export async function saveArmyPreset(db: DbOrTx, wallet: string, preset: TrainingPreset): Promise<TrainingPreset> {
  validateSlot(preset.slot); validateTrainingComposition(preset.composition);
  const name = preset.name.trim();
  if (!name || name.length > TRAINING_PRESETS.nameMaxLength) throw new HttpError(422, 'enter a short preset name');
  await db.insert(armyPresets).values({ playerWallet: wallet, slot: preset.slot, name, composition: preset.composition })
    .onConflictDoUpdate({ target: [armyPresets.playerWallet, armyPresets.slot], set: { name, composition: preset.composition, updatedAt: new Date() } });
  return { ...preset, name };
}

export async function deleteArmyPreset(db: DbOrTx, wallet: string, slot: number): Promise<{ deleted: true }> {
  validateSlot(slot);
  await db.delete(armyPresets).where(and(eq(armyPresets.playerWallet, wallet), eq(armyPresets.slot, slot)));
  return { deleted: true };
}

/** Hero-only attacks deliberately stop this lookup: an older army is not the
 * previous attack. Empty visits, defence and inherited history cannot qualify. */
export async function previousAttackArmy(db: DbOrTx, wallet: string, baseId?: string): Promise<PreviousArmy> {
  return db.transaction(async (tx) => {
    if (multiBaseEnabled()) {
      if (!baseId) throw new HttpError(409, 'baseId is required', 'BASE_ID_REQUIRED');
      await requireActiveStablePrerequisiteBase(tx, wallet, baseId);
    }
    const [raid] = await tx.select({ id: raids.id, orders: raids.orders }).from(raids).where(and(
      eq(raids.attackerWallet, wallet), eq(raids.status, 'resolved'),
      baseId ? eq(raids.attackerBaseId, baseId) : undefined,
      sql`(COALESCE(jsonb_array_length(${raids.orders}->'deploys'), 0) > 0
        OR COALESCE(jsonb_array_length(${raids.orders}->'heroDeploys'), 0) > 0)`,
    )).orderBy(sql`${raids.resolvedAt} DESC NULLS LAST`, desc(raids.createdAt), desc(raids.id)).limit(1);
    if (multiBaseEnabled() && baseId) await requireActiveStablePrerequisiteBase(tx, wallet, baseId);
    if (!raid) return { raidId: null, composition: [], message: 'No previous attack with deployed troops or heroes on this base.' };
    const orders = raid.orders as { deploys?: Array<{ troop: string }> };
    const counts = new Map<TroopType, number>();
    for (const order of orders.deploys ?? []) {
      if (!TROOP_TYPES.includes(order.troop as TroopType) || !isTrainableTroop(order.troop as TroopType)) continue;
      const troop = order.troop as TroopType;
      counts.set(troop, (counts.get(troop) ?? 0) + 1);
    }
    const composition = [...counts].map(([troop, count]) => ({ troop, count }));
    return { raidId: raid.id, composition, message: composition.length ? null : 'Your previous attack used heroes only; no troops need retraining.' };
  });
}
