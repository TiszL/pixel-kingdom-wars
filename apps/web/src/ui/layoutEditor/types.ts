import type { BaseStateDto } from '../../state/store';

export type LayoutSlot = 'HOME' | 'FARM';

export interface LayoutPosition {
  buildingId: string;
  tx: number;
  ty: number;
}

export interface LayoutSlotDto {
  slot: LayoutSlot;
  locked: boolean;
  etag: string;
  positions: LayoutPosition[];
  compatibility: 'empty' | 'ready' | 'needs_repair';
  unplacedBuildingIds: string[];
  removedBuildingIds: string[];
}

export interface LayoutsDto {
  baseId: string;
  geometryVersion: number;
  plotVersion?: number;
  claim: { min: number; max: number; size: number };
  active: { slot: LayoutSlot | null; etag: string };
  farmUnlock: { locked: boolean; costShards: number };
  slots: LayoutSlotDto[];
}

export interface UnlockFarmDto {
  baseId: string;
  slot: 'FARM';
  locked: false;
  chargedShards: string;
  balanceShards: string;
}

export interface SaveLayoutDto {
  baseId: string;
  slot: LayoutSlot;
  geometryVersion: number;
  plotVersion?: number;
  slotEtag: string;
  activeEtag: string;
  activeSlot: LayoutSlot | null;
  moved: number;
  unchanged: number;
  replayed: boolean;
}

export interface LayoutClient {
  read(baseId: string): Promise<LayoutsDto>;
  unlockFarm(baseId: string, idempotencyKey: string): Promise<UnlockFarmDto>;
  save(
    baseId: string,
    slot: LayoutSlot,
    input: {
      geometryVersion: number;
      plotVersion?: number;
      mode: 'save' | 'save_apply';
      expectedSlotEtag: string;
      expectedActiveEtag?: string | undefined;
      positions: LayoutPosition[];
    },
  ): Promise<SaveLayoutDto>;
}

export type LayoutBuilding = BaseStateDto['buildings'][number];
export type LayoutObstacle = BaseStateDto['obstacles'][number];
