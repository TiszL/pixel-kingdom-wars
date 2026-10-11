import {
  type GearModifierStat, type ItemAcquisition, type ItemKind, type ItemRarity,
} from '@shardkeep/shared';
import { itemArtUrl } from '../itemArt';
import { Btn, Card, COLORS as C, fmtN, Icon, Sprite } from '../primitives';

export interface ShopItemsDto {
  catalog: {
    id: string; name: string; kind: ItemKind; slot?: string; costKeep: number; asset: string; desc: string;
    rarity: ItemRarity; weight: number; acquisition: ItemAcquisition; maxOwned: number | null;
    activation?: { kind: 'hero' | 'troop'; active: boolean; availableContracts?: number };
    dropOnly?: boolean; modifiers?: readonly { stat: GearModifierStat; value: number }[];
  }[];
  owned: { itemId: string; qty: number }[];
  heroLoadouts?: { equipment: Readonly<Record<string, string | undefined>> }[];
}

export type ShopItemKind = 'all' | 'gear' | 'consumable';

const RARITY_COLOR: Record<ItemRarity, string> = {
  common: C.textDim,
  uncommon: C.success,
  rare: '#BBD0D6',
  epic: '#9A78B8',
  legendary: C.gold,
  mythic: C.goldHi,
};

function acquisitionLabel(gate: ItemAcquisition): string {
  if (gate.type === 'shop') return 'AVAILABLE NOW';
  if (gate.type === 'keep_level') return `KEEP LEVEL ${gate.keepLevel} REQUIRED`;
  if (gate.type === 'campaign_three_star') {
    return `CAMPAIGN ${gate.stage} · 3★${gate.requiresMaxHero ? ' · MAX HERO' : ''}`;
  }
  return 'DROPS FROM GOLD FORGE';
}

function ItemArt({ item }: { item: ShopItemsDto['catalog'][number] }): React.JSX.Element {
  const art = itemArtUrl(item.asset);
  if (art) return <img src={art} width={60} height={60} alt="" style={{ imageRendering: 'pixelated' }} />;
  return <Sprite name={item.asset} w={60} h={60} />;
}

/** Purchase choices live in Shop, never as unowned Inventory cubes. The API
 * remains authoritative for price, unlock, capacity and max-owned checks. */
export function ShopCatalogView({
  data,
  busyId,
  kind,
  onKind,
  onBuy,
}: {
  data: ShopItemsDto | null;
  busyId: string | null;
  kind: ShopItemKind;
  onKind: (kind: ShopItemKind) => void;
  /** The item rides along so the caller can shape the purchase by what the
   *  card already knows (a recruited hero's contract asks first). */
  onBuy: (id: string, item: ShopItemsDto['catalog'][number]) => void;
}): React.JSX.Element {
  const purchasable = (data?.catalog ?? []).filter((item) =>
    !item.dropOnly && item.acquisition.type !== 'drop' && item.acquisition.type !== 'craft');
  const visible = purchasable.filter((item) => kind === 'all' || item.kind === kind);
  const qtyOf = (id: string): number => data?.owned.find((row) => row.itemId === id)?.qty ?? 0;
  // Category tabs come from what is actually for sale: since gear went
  // forge-drop-exclusive (owner 2026-08-16) the GEAR tab must not render an
  // empty aisle — and a single-kind catalog needs no tab row at all.
  const kindsForSale = (['gear', 'consumable'] as const)
    .filter((next) => purchasable.some((item) => item.kind === next));
  const tabs: ShopItemKind[] = kindsForSale.length > 1 ? ['all', ...kindsForSale] : [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {tabs.length > 0 && (
        <div role="tablist" aria-label="Shop item category"
          style={{ display: 'flex', gap: 4, overflowX: 'auto', paddingBottom: 2 }}>
          {tabs.map((next) => (
            <Btn key={next} variant={kind === next ? 'gold' : 'ghost'} fontSize={15}
              style={{ minHeight: 44, flex: '1 0 auto', padding: '5px 10px 7px' }}
              onClick={() => onKind(next)}>{next.toUpperCase()}</Btn>
          ))}
        </div>
      )}
      <div className="shop-catalog-grid" style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(156px, 1fr))', gap: 8,
      }}>
        {visible.map((item) => {
          const owned = qtyOf(item.id);
          const maxed = item.maxOwned !== null && owned >= item.maxOwned;
          // A contract whose hero this base already recruited sells only as a
          // tradeable copy (D-110): the button says so before the tap (tester
          // report 2026-09-16 read the second BUY as a silent KEEP loss).
          const duplicateHero = item.activation?.kind === 'hero' && item.activation.active;
          return (
            <Card key={item.id} style={{
              minWidth: 0, padding: 10, gap: 6, alignItems: 'center',
              borderColor: RARITY_COLOR[item.rarity],
            }}>
              <ItemArt item={item} />
              <span style={{ color: RARITY_COLOR[item.rarity], fontSize: 16, lineHeight: 1.05, textAlign: 'center' }}>
                {item.name}
              </span>
              <span style={{ color: C.textFaint, fontSize: 12, textAlign: 'center' }}>
                {item.rarity.toUpperCase()} · {item.kind.toUpperCase()} · WT {item.weight}
              </span>
              <span style={{ minHeight: 34, color: C.textDim, fontSize: 13, lineHeight: 1.25, textAlign: 'center' }}>
                {item.desc}
              </span>
              <span style={{ color: item.acquisition.type === 'shop' ? C.success : C.goldHi, fontSize: 12, textAlign: 'center' }}>
                {acquisitionLabel(item.acquisition)}
              </span>
              {(owned > 0 || item.activation) && <span style={{ color: C.textFaint, fontSize: 12, textAlign: 'center' }}>
                {item.activation ? `UNUSED ×${owned}` : `OWNED ×${owned}`}
                {item.activation && item.maxOwned !== null ? ` · BAG LIMIT ${item.maxOwned}` : ''}
              </span>}
              {item.activation?.active && <span style={{ color: C.success, fontSize: 13, textAlign: 'center' }}>
                {item.activation.kind === 'hero' ? 'HERO RECRUITED ON THIS BASE' : 'TRAINING UNLOCKED'}
                <br />BUY AN UNUSED COPY TO TRADE. IT CANNOT BE ACTIVATED AGAIN.
              </span>}
              <Btn fontSize={15} disabled={busyId !== null || maxed}
                style={{ width: '100%', minHeight: 44, padding: '6px 5px 8px' }}
                onClick={() => onBuy(item.id, item)}>
                {maxed ? (item.activation ? 'BAG LIMIT REACHED' : 'OWNED · MAX') : <>{duplicateHero ? 'BUY COPY' : 'BUY'} · {fmtN(item.costKeep)} <Icon name="keep" size={15} /></>}
              </Btn>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
