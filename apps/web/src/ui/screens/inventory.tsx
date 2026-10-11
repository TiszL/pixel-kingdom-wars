/** Lazy inventory/paper-doll screen. The Overlay seam intentionally imports
 * this module dynamically so its layout, copy, and ten handout SVG URLs never
 * join first paint. Gameplay values are rendered from GET /items only. */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  GEAR_MODIFIER_STATS,
  GEAR_SLOTS,
  type GearModifierStat,
  type GearSlot,
  type HeroKey,
  type ItemAcquisition,
  type ItemKind,
  type ItemRarity,
} from '@shardkeep/shared';
import { api, ApiError } from '../../lib/api';
import { selectedBasePath, withSelectedBase } from '../../lib/baseSelection';
import { bus } from '../../lib/events';
import { reloadCurrentBaseSnapshot } from '../../state/baseSnapshot';
import { captureBaseSnapshotGuard, isBaseSnapshotGuardCurrent, useApp } from '../../state/store';
import { itemArtUrl } from '../itemArt';
import { Btn, fmtN, Icon, Panel9, Sprite } from '../primitives';
import { useFetch } from '../useFetch';
import { heroBodyArt } from '../heroBody';
import { heroRecoveryLabel, heroRecoveryRevision } from './heroRecovery';
import { heroPortrait } from '../heroPortrait';
import './inventory.css';

export interface InventoryCatalogItem {
  id: string;
  name: string;
  kind: ItemKind;
  slot?: GearSlot;
  rarity: ItemRarity;
  weight: number;
  costKeep: number;
  asset: string;
  desc: string;
  acquisition: ItemAcquisition;
  maxOwned: number | null;
  activation?: { kind: 'hero' | 'troop'; active: boolean; availableContracts?: number };
  dropOnly?: boolean;
  modifiers?: readonly { stat: GearModifierStat; value: number }[];
}

export interface InventoryHeroLoadout {
  hero: HeroKey;
  recruited: boolean;
  level: number;
  recoveryUntil: string | null;
  available: boolean;
  version: number;
  equipment: Partial<Record<GearSlot, string>>;
  modifiers: Record<GearModifierStat, number>;
  setBonus: { id: string; pieces: number; required: number; active: boolean };
  baseStats: { hp: number; basicDamage: number; skillDamageSeed: number };
  effectiveStats: { hp: number; basicDamage: number; skillDamageSeed: number };
}

export interface InventoryDto {
  catalogRevision: number;
  heroGearCombatEnabled: boolean;
  catalog: InventoryCatalogItem[];
  owned: { itemId: string; qty: number }[];
  discovery: { itemId: string; seenAt: string }[];
  capacity: { used: number; max: number; overflow: boolean };
  heroLoadouts: InventoryHeroLoadout[];
  deeds: {
    id: string; baseId: string | null; name: string; kind: 'deed';
    asset: 'itm_deed_earth'; status: 'active' | 'inactive';
  }[];
}

const RARITY_COLOR: Record<ItemRarity, string> = {
  common: '#C4BBA4', uncommon: '#8CB36E', rare: '#BBD0D6',
  epic: '#9A78B8', legendary: '#E3AE3C', mythic: '#F4D77B',
};

const RARITY_ORDER: readonly ItemRarity[] = [
  'common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic',
];

const SLOT_ART: Readonly<Record<GearSlot, string>> = {
  helm: 'itm_helm', amulet: 'itm_amulet', chest: 'itm_chest', cloak: 'itm_cloak',
  gloves: 'itm_gloves', ring: 'itm_ring', boots: 'itm_boots', banner: 'itm_banner',
  weapon: 'itm_hammer', offhand: 'itm_shield',
};

const STAT_LABEL: Record<GearModifierStat, string> = {
  hero_hp_bps: 'HERO HP', hero_damage_bps: 'DAMAGE', ability_damage_bps: 'ABILITY DAMAGE',
  cooldown_reduction_bps: 'COOLDOWN', move_speed_bps: 'MOVE SPEED',
  incoming_damage_reduction_bps: 'INCOMING DAMAGE', first_hit_reduction_bps: 'FIRST HIT',
  wall_damage_bps: 'WALL DAMAGE', allied_troop_hp_bps: 'TROOP HP',
  allied_troop_damage_bps: 'TROOP DAMAGE',
};

const BENEFICIAL_NEGATIVE = new Set<GearModifierStat>([
  'cooldown_reduction_bps', 'incoming_damage_reduction_bps', 'first_hit_reduction_bps',
]);

export function modifierLabel(stat: GearModifierStat, value: number): string {
  const displayed = BENEFICIAL_NEGATIVE.has(stat) ? -value : value;
  const sign = displayed > 0 ? '+' : displayed < 0 ? '−' : '';
  return `${STAT_LABEL[stat]} ${sign}${Math.abs(displayed) / 100}%`;
}

export function modifierIsBeneficial(_stat: GearModifierStat, value: number): boolean {
  // Reduction stats flip only their DISPLAY sign (800 bps => "−8% incoming
  // damage"). Their authoritative magnitude is still positive when beneficial.
  return value > 0;
}

export function acquisitionLabel(gate: ItemAcquisition): string {
  if (gate.type === 'shop') return 'KEEP SHOP';
  // Every drop-acquired item is a Gold Forge settlement roll (FORGE_DROPS) —
  // gear included since the owner made gear forge-drop-exclusive (2026-08-16).
  if (gate.type === 'drop') return 'DROPS FROM GOLD FORGE';
  if (gate.type === 'keep_level') return `KEEP LEVEL ${gate.keepLevel}`;
  // Crafted materials (Phase E, dark until FORGE_INGOTS_ENABLED) come from a
  // building job, never the shop.
  if (gate.type === 'craft') return 'REFINED AT THE WORKSHOP';
  return `CAMPAIGN ${gate.stage} · 3★${gate.requiresMaxHero ? ' · MAX HERO' : ''}`;
}

type Tab = 'all' | 'gear' | 'consumable' | 'relic' | 'deed' | 'cosmetic';
type MobilePane = 'equipment' | 'backpack';

interface InventoryViewProps {
  data: InventoryDto | null;
  loading: boolean;
  error: string | null;
  busy: boolean;
  selectedHero: HeroKey;
  selectedId: string | null;
  tab: Tab;
  mobilePane: MobilePane;
  onClose: () => void;
  onHero: (hero: HeroKey) => void;
  onSelect: (id: string | null) => void;
  onTab: (tab: Tab) => void;
  onMobilePane: (pane: MobilePane) => void;
  onEquip: (id: string) => void;
  onUse: (id: string) => void;
  onSell: (id: string) => void;
  onViewDeeds: () => void;
  onOpenShop: () => void;
}

export function InventoryView(props: InventoryViewProps): React.JSX.Element {
  const itemRefs = useRef(new Map<string, HTMLButtonElement>());
  const closeDetailRef = useRef<HTMLButtonElement>(null);
  const closeInventoryRef = useRef<HTMLButtonElement>(null);
  const activeTabRef = useRef<HTMLButtonElement>(null);
  const activePaneRef = useRef<HTMLButtonElement>(null);
  const detailTriggerRef = useRef<HTMLButtonElement | null>(null);
  const restoreFocusId = useRef<string | null>(null);
  const priorSelectedId = useRef(props.selectedId);
  const priorSelectedHero = useRef(props.selectedHero);
  const [nowMs, setNowMs] = useState(Date.now());

  useEffect(() => {
    // Inventory replaces the base HUD, so put keyboard/switch users on the
    // modal's first escape route as soon as the lazy screen mounts.
    closeInventoryRef.current?.focus();
  }, []);

  useEffect(() => {
    if (priorSelectedHero.current === props.selectedHero) return;
    priorSelectedHero.current = props.selectedHero;
    // The hero switch itself owns focus. Do not send keyboard users back to
    // an item from the previous hero when that switch intentionally closes it.
    detailTriggerRef.current = null;
    restoreFocusId.current = null;
    priorSelectedId.current = props.selectedId;
  }, [props.selectedHero, props.selectedId]);

  useEffect(() => {
    const prior = priorSelectedId.current;
    priorSelectedId.current = props.selectedId;
    if (props.selectedId) {
      closeDetailRef.current?.focus();
      return;
    }
    if (!prior) return;
    const itemId = restoreFocusId.current ?? prior;
    const candidates = [
      detailTriggerRef.current,
      itemRefs.current.get(itemId),
      activePaneRef.current,
      activeTabRef.current,
      closeInventoryRef.current,
    ];
    restoreFocusId.current = null;
    detailTriggerRef.current = null;
    for (const candidate of candidates) {
      if (!candidate?.isConnected || candidate.disabled) continue;
      candidate.focus();
      if (document.activeElement === candidate) break;
    }
  }, [props.selectedId]);

  useEffect(() => {
    if (!props.data?.heroLoadouts.some((hero) => (
      !hero.available && hero.recoveryUntil !== null && Date.parse(hero.recoveryUntil) > Date.now()
    ))) return;
    const timer = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [props.data]);

  const { data } = props;
  const hero = data?.heroLoadouts.find((entry) => entry.hero === props.selectedHero) ?? null;
  const selectedHeroRecovery = heroRecoveryLabel(
    hero?.recoveryUntil ?? null, nowMs, hero?.available,
  );
  const deedCatalog: InventoryCatalogItem[] = (data?.deeds ?? []).map((deed) => ({
    id: deed.id, name: deed.name, kind: 'deed', rarity: 'legendary', weight: 0, costKeep: 0,
    asset: deed.asset, desc: `${deed.status.toUpperCase()} STABLE LAND · ${deed.id}`,
    acquisition: { type: 'drop' }, maxOwned: 1,
  }));
  const ownedIds = new Set((data?.owned ?? [])
    .filter((row) => row.qty > 0)
    .map((row) => row.itemId));
  // Inventory answers "what do I own?". The full catalog is still carried by
  // GET /items for the Shop, but an unowned entry must never become a bag cube.
  const catalog = [
    ...(data?.catalog ?? []).filter((item) => ownedIds.has(item.id)),
    ...deedCatalog,
  ];
  const isDeed = (id: string): boolean => (data?.deeds ?? []).some((deed) => deed.id === id);
  const selected = catalog.find((item) => item.id === props.selectedId) ?? null;
  const qty = (id: string): number => data?.owned.find((row) => row.itemId === id)?.qty ?? 0;
  const equippedCount = (id: string): number => data?.heroLoadouts.reduce(
    (sum, row) => sum + Object.values(row.equipment).filter((itemId) => itemId === id).length, 0,
  ) ?? 0;
  const visible = catalog.filter((item) =>
    props.tab === 'all'
      || item.kind === props.tab,
  );
  const currentSlotItem = selected?.kind === 'gear' && selected.slot
    ? hero?.equipment[selected.slot] ?? null : null;
  const storedQty = selected ? Math.max(0, qty(selected.id) - equippedCount(selected.id)) : 0;
  const sellable = !!selected && selected.kind !== 'deed' && !selected.dropOnly && storedQty > 0;
  const displayedStats = hero
    ? data?.heroGearCombatEnabled ? hero.effectiveStats : hero.baseStats
    : null;
  const compared = currentSlotItem && currentSlotItem !== selected?.id
    ? catalog.find((item) => item.id === currentSlotItem) ?? null : null;
  const comparison = selected?.kind === 'gear' && compared
    ? GEAR_MODIFIER_STATS.flatMap((stat) => {
      const next = selected.modifiers?.find((modifier) => modifier.stat === stat)?.value ?? 0;
      const current = compared.modifiers?.find((modifier) => modifier.stat === stat)?.value ?? 0;
      return next === current ? [] : [{ stat, value: next - current }];
    }) : [];
  const capacityPct = data && data.capacity.max > 0
    ? Math.min(100, Math.round((data.capacity.used / data.capacity.max) * 100))
    : 0;
  const capacityClass = data?.capacity.overflow || capacityPct >= 100
    ? 'is-overflow' : capacityPct >= 80 ? 'is-warning' : '';
  const capacityLabel = data?.capacity.overflow
    ? 'OVER CAPACITY' : capacityPct >= 100 ? 'PACK FULL' : capacityPct >= 80 ? 'NEAR CAPACITY' : 'CAPACITY';

  return (
    <div className="inventory-screen interactive" role="dialog" aria-modal="true" aria-label="Inventory">
      <header className="inventory-header">
        <div>
          <span className="inventory-kicker">KEEP QUARTERMASTER</span>
          <h1>INVENTORY</h1>
        </div>
        <div className="inventory-header-actions">
          <button ref={closeInventoryRef} className="inventory-icon-btn" aria-label="Close inventory" onClick={props.onClose}>
            <Icon name="close" size={24} />
          </button>
        </div>
      </header>

      <nav className="inventory-heroes" aria-label="Hero loadouts">
        {(data?.heroLoadouts ?? []).map((entry) => {
          const recovery = heroRecoveryLabel(entry.recoveryUntil, nowMs, entry.available);
          return (
            <button
              key={entry.hero}
              className={`${entry.hero === props.selectedHero ? 'is-active' : ''}${recovery ? ' is-recovering' : ''}`}
              onClick={() => props.onHero(entry.hero)}
              aria-pressed={entry.hero === props.selectedHero}
            >
              <Sprite name={heroPortrait(entry.hero, entry.level)} w={42} h={42} />
              <span>
                <b>{entry.hero === 'vex' ? 'VEX' : 'THEODOR'}</b>
                <small>{!entry.recruited ? 'NOT RECRUITED' : recovery ?? `LEVEL ${entry.level}`}</small>
              </span>
            </button>
          );
        })}
      </nav>

      <div className="inventory-mobile-panes" role="tablist" aria-label="Inventory pane">
        {(['equipment', 'backpack'] as const).map((pane) => (
          <button key={pane} ref={props.mobilePane === pane ? activePaneRef : undefined}
            role="tab" aria-selected={props.mobilePane === pane}
            className={props.mobilePane === pane ? 'is-active' : ''}
            onClick={() => props.onMobilePane(pane)}>{pane.toUpperCase()}</button>
        ))}
      </div>

      {props.loading && <div className="inventory-state">OPENING THE ARMORY…</div>}
      {props.error && <div className="inventory-state is-error" role="alert" aria-atomic="true">{props.error.toUpperCase()}</div>}
      {data && (
        <main className={`inventory-layout ${selected ? 'has-detail' : ''}`}>
          <Panel9 className={`inventory-doll ${props.mobilePane === 'equipment' ? 'is-mobile-active' : ''}`}>
            <div className="inventory-panel-title">
              <span>{props.selectedHero === 'vex' ? 'VEX' : 'THEODOR'} LOADOUT</span>
              <small>{hero?.setBonus.pieces ?? 0}/{hero?.setBonus.required ?? 9} WARDEN</small>
            </div>
            <div className="inventory-paper-doll">
              <div className="inventory-hero-figure" aria-hidden="true">
                <img src={heroBodyArt(props.selectedHero)} width={112} height={112} alt="" />
              </div>
              {GEAR_SLOTS.map((slot) => {
                const itemId = hero?.equipment[slot];
                const item = catalog.find((candidate) => candidate.id === itemId);
                return (
                  <button
                    key={slot}
                    data-slot={slot}
                    className={`inventory-slot ${item ? 'is-filled' : ''}`}
                    disabled={!item}
                    onClick={(event) => {
                      if (!item) return;
                      detailTriggerRef.current = event.currentTarget;
                      restoreFocusId.current = item.id;
                      props.onSelect(item.id);
                    }}
                    aria-label={`${slot}${item ? `: ${item.name}` : ': empty'}`}
                  >
                    <small>{slot}</small>
                    {item && itemArtUrl(item.asset)
                      ? <img src={itemArtUrl(item.asset)!} width={44} height={44} alt="" />
                      : item ? <Sprite name={item.asset} w={44} h={44} />
                        : <img className="inventory-slot-ghost" src={itemArtUrl(SLOT_ART[slot])!} width={36} height={36} alt="" />}
                  </button>
                );
              })}
            </div>
            {selectedHeroRecovery && (
              <div className="inventory-hero-recovery" role="status">
                {selectedHeroRecovery} · UNAVAILABLE FOR ATTACK OR DEFENCE
              </div>
            )}
            <div className={`inventory-set ${hero?.setBonus.active && data.heroGearCombatEnabled ? 'is-active' : ''}`}>
              <b>WARDEN OF THE NINE</b>
              <span>{!data.heroGearCombatEnabled
                ? 'EQUIPMENT SAVED · COMBAT ROLLOUT OFF'
                : hero?.setBonus.active ? '+8% NONHERO TROOP HP ACTIVE' : 'EQUIP 9 PIECES TO AWAKEN'}</span>
            </div>
            {hero && displayedStats && (
              <div className="inventory-hero-stats">
                <span>HP <b>{fmtN(displayedStats.hp)}</b><small>{data.heroGearCombatEnabled && hero.baseStats.hp !== displayedStats.hp ? ` BASE ${fmtN(hero.baseStats.hp)}` : ''}</small></span>
                <span>DAMAGE <b>{fmtN(displayedStats.basicDamage)}</b><small>{data.heroGearCombatEnabled && hero.baseStats.basicDamage !== displayedStats.basicDamage ? ` BASE ${fmtN(hero.baseStats.basicDamage)}` : ''}</small></span>
                <span>SKILL <b>{fmtN(displayedStats.skillDamageSeed)}</b><small>{data.heroGearCombatEnabled && hero.baseStats.skillDamageSeed !== displayedStats.skillDamageSeed ? ` BASE ${fmtN(hero.baseStats.skillDamageSeed)}` : ''}</small></span>
              </div>
            )}
          </Panel9>

          <section className={`inventory-bag ${props.mobilePane === 'backpack' ? 'is-mobile-active' : ''}`} aria-label="Item bag">
            <div className="inventory-tabs" role="tablist">
              {(['all', 'gear', 'consumable', 'relic', 'deed', 'cosmetic'] as const).map((next) => (
                <button key={next} ref={props.tab === next ? activeTabRef : undefined}
                  role="tab" aria-selected={props.tab === next}
                  className={props.tab === next ? 'is-active' : ''} onClick={() => props.onTab(next)}>
                  {next.toUpperCase()}
                </button>
              ))}
            </div>
            <div className={`inventory-capacity-row ${capacityClass}`} role="status" aria-live="polite"
              aria-label={`Backpack capacity ${data.capacity.used} of ${data.capacity.max}${data.capacity.overflow ? ', over capacity' : ''}`}>
              <span>{capacityLabel}</span>
              <i aria-hidden="true"><b style={{ width: `${capacityPct}%` }} /></i>
              <strong>{data.capacity.used}/{data.capacity.max}</strong>
            </div>
            <div className="inventory-items">
              {visible.length === 0 && (
                <div className="inventory-empty-bag">
                  <span>{props.tab === 'all' ? 'YOUR BACKPACK IS EMPTY' : `NO OWNED ${props.tab.toUpperCase()} ITEMS`}</span>
                  <button onClick={props.onOpenShop}>OPEN SHOP</button>
                </div>
              )}
              {visible.map((item) => {
                const owned = qty(item.id);
                const available = isDeed(item.id) ? 1 : Math.max(0, owned - equippedCount(item.id));
                const deed = data.deeds.find((entry) => entry.id === item.id);
                const displayedOwned = deed ? 1 : owned;
                const isNew = owned > 0 && !data.discovery.some((row) => row.itemId === item.id);
                const equippedCopies = equippedCount(item.id);
                return (
                  <button
                    key={item.id}
                    ref={(node) => {
                      if (node) itemRefs.current.set(item.id, node);
                      else itemRefs.current.delete(item.id);
                    }}
                    className={`inventory-item ${props.selectedId === item.id ? 'is-selected' : ''}`}
                    style={{ '--rarity': RARITY_COLOR[item.rarity] } as React.CSSProperties}
                    onClick={(event) => {
                      detailTriggerRef.current = event.currentTarget;
                      restoreFocusId.current = item.id;
                      props.onSelect(props.selectedId === item.id ? null : item.id);
                    }}
                    aria-pressed={props.selectedId === item.id}
                    aria-label={`${item.name}, ${displayedOwned} owned, ${available} available${equippedCopies > 0 ? `, ${equippedCopies} equipped` : ''}${isNew ? ', new' : ''}`}
                    title={item.name}
                  >
                    <span className="inventory-item-name">{item.name}</span>
                    {isNew && <em aria-hidden="true" />}
                    {itemArtUrl(item.asset)
                      ? <img src={itemArtUrl(item.asset)!} width={40} height={40} alt="" />
                      : <Sprite name={item.asset} w={40} h={40} />}
                    {displayedOwned > 1 && <span className="inventory-item-qty">×{displayedOwned}</span>}
                    {equippedCopies > 0 && <span className="inventory-item-equipped">E{equippedCopies > 1 ? `×${equippedCopies}` : ''}</span>}
                    {deed && <span className="inventory-item-status">{deed.status.toUpperCase()}</span>}
                  </button>
                );
              })}
              {visible.length > 0 && Array.from({ length: Math.max(0, 18 - visible.length) }, (_, index) => (
                <span key={`empty-${index}`} className="inventory-item is-empty" aria-hidden="true" />
              ))}
            </div>
          </section>

          <aside className={`inventory-detail ${selected ? '' : 'is-empty'}`} aria-live="polite">
            {selected ? (
              <>
                <button ref={closeDetailRef} className="inventory-detail-close" aria-label="Close item details"
                  onClick={() => {
                    restoreFocusId.current = props.selectedId;
                    props.onSelect(null);
                  }}>
                  <Icon name="close" size={22} />
                </button>
                <div className="inventory-detail-art" style={{ '--rarity': RARITY_COLOR[selected.rarity] } as React.CSSProperties}>
                  {itemArtUrl(selected.asset)
                    ? <img src={itemArtUrl(selected.asset)!} width={40} height={40} alt="" />
                    : <Sprite name={selected.asset} w={40} h={40} />}
                </div>
                <span className="inventory-rarity" style={{ color: RARITY_COLOR[selected.rarity] }}>{selected.rarity}</span>
                <h2>{selected.name}</h2>
                <span className="inventory-rarity-rank">{RARITY_ORDER.indexOf(selected.rarity) + 1}/6</span>
                <p>{selected.desc}
                {selected.activation && <span style={{ display: 'block', marginTop: 6 }}>
                  UNUSED ×{storedQty}{selected.maxOwned !== null ? ` · BAG LIMIT ${selected.maxOwned}` : ''}.
                  {selected.activation.active
                    ? selected.activation.kind === 'hero'
                      ? ' HERO ALREADY RECRUITED ON THIS BASE. SELL THE UNUSED CONTRACT ON THE MARKET.'
                      : ' TRAINING ALREADY UNLOCKED. SELL THE UNUSED WRIT ON THE MARKET.'
                    : selected.activation.kind === 'hero'
                      ? ' PLACE THE HERO ALTAR TO USE THIS CONTRACT. IT IS CONSUMED WHEN PLACED.'
                      : ' USE ONCE TO UNLOCK TRAINING. THE WRIT IS CONSUMED.'}
                </span>}</p>
                <div className="inventory-detail-meta">
                  <span>{selected.kind}</span><span>WT {selected.weight}</span>
                  <span>{selected.kind === 'deed' ? 'STABLE CORE NFT' : acquisitionLabel(selected.acquisition)}</span>
                </div>
                <div className="inventory-modifiers">
                  {(selected.modifiers ?? []).map((modifier) => (
                    <span key={modifier.stat} className={modifierIsBeneficial(modifier.stat, modifier.value) ? '' : 'is-penalty'}>
                      {modifierLabel(modifier.stat, modifier.value)}
                    </span>
                  ))}
                </div>
                {compared && comparison.length > 0 && (
                  <div className="inventory-comparison">
                    <b>VS {compared.name}</b>
                    {comparison.map(({ stat, value }) => (
                      <span key={stat} className={modifierIsBeneficial(stat, value) ? 'is-upgrade' : 'is-penalty'}>
                        {modifierLabel(stat, value)}
                      </span>
                    ))}
                  </div>
                )}
                {selected.kind === 'gear' && selected.slot && (storedQty > 0 || currentSlotItem === selected.id) && (
                  <Btn disabled={props.busy || !hero?.recruited} style={{ width: '100%', minHeight: 48 }}
                    onClick={() => props.onEquip(selected.id)}>
                    {currentSlotItem === selected.id ? 'UNEQUIP' : `EQUIP · ${selected.slot.toUpperCase()}`}
                  </Btn>
                )}
                {selected.kind === 'consumable' && storedQty > 0 && !selected.activation?.active && (
                  <Btn disabled={props.busy} style={{ width: '100%', minHeight: 48 }}
                    onClick={() => props.onUse(selected.id)}>
                    {selected.activation?.kind === 'hero' ? 'USE · PLACE HERO ALTAR' : 'USE'}
                  </Btn>
                )}
                {sellable && (
                  <Btn variant="sec" disabled={props.busy} style={{ width: '100%', minHeight: 48 }}
                    onClick={() => props.onSell(selected.id)}>
                    SELL ON MARKET
                  </Btn>
                )}
                {selected.kind === 'deed' && (
                  <Btn variant="sec" style={{ width: '100%', minHeight: 48 }} onClick={props.onViewDeeds}>
                    VIEW ON GLOBE
                  </Btn>
                )}
              </>
            ) : <div className="inventory-empty-detail">SELECT AN ITEM</div>}
          </aside>
        </main>
      )}
    </div>
  );
}

export default function InventoryScreen({ onClose }: { onClose?: () => void }): React.JSX.Element {
  const wallet = useApp((state) => state.wallet);
  const selectedBaseId = useApp((state) => state.selectedBaseId);
  const selectionEpoch = useApp((state) => state.baseSelectionEpoch);
  return <InventoryContext key={JSON.stringify([wallet, selectedBaseId, selectionEpoch])} {...(onClose ? { onClose } : {})} />;
}

function InventoryContext({ onClose }: { onClose?: () => void }): React.JSX.Element {
  const [guard] = useState(captureBaseSnapshotGuard);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const current = (): boolean => mounted.current && isBaseSnapshotGuardCurrent(guard);
  const selectedBaseId = guard.selectedBaseId;
  const base = useApp((state) => state.base);
  const { data, loading, error: loadError, reload, refresh } = useFetch<InventoryDto>(
    () => current() ? api.get(selectedBasePath('/items')) : Promise.reject(new Error('Inventory context changed')),
    [selectedBaseId],
  );
  const [selectedHero, setSelectedHero] = useState<HeroKey>('vex');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('all');
  const [mobilePane, setMobilePane] = useState<MobilePane>('backpack');
  const [busy, setBusy] = useState(false);
  const [committedUseUnverified, setCommittedUseUnverified] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const recoveryRevision = base?.baseId === selectedBaseId
    ? heroRecoveryRevision(base.heroes) : null;
  const priorRecoveryRevision = useRef(recoveryRevision);

  useEffect(() => {
    const prior = priorRecoveryRevision.current;
    priorRecoveryRevision.current = recoveryRevision;
    if (prior !== null && recoveryRevision !== null && prior !== recoveryRevision) reload();
  }, [recoveryRevision, reload]);

  useEffect(() => {
    if (!data || !selectedId) return;
    const ownedIds = new Set(data?.owned.filter((row) => row.qty > 0).map((row) => row.itemId) ?? []);
    if (!ownedIds.has(selectedId) && !data.deeds.some((deed) => deed.id === selectedId)) {
      setSelectedId(null);
    }
  }, [data, selectedId]);

  const seen = useMemo(() => new Set(data?.discovery.map((row) => row.itemId) ?? []), [data]);
  const ready = (): boolean => current() && !loading && !loadError && data !== null;
  const select = (id: string | null): void => {
    if (!ready()) return;
    setSelectedId(id);
    if (!id) return;
    if (!(data?.deeds ?? []).some((deed) => deed.id === id) && !seen.has(id)) {
      void api.postRaw(`/items/${encodeURIComponent(id)}/seen`, withSelectedBase({})).then(() => { if (current()) reload(); }).catch(() => {});
    }
  };
  const blockUnverifiedUse = (): void => {
    if (!current()) return;
    setCommittedUseUnverified(true);
    setActionError(
      'Item may already have been used, but Inventory could not verify the new quantity. '
      + 'Close and reopen Inventory before using another item.',
    );
  };
  const act = (
    fn: () => Promise<unknown>, afterCommit: () => Promise<void> | void = reload,
    recoverRejected?: (cause: unknown) => Promise<boolean>,
  ): void => {
    if (!ready() || busy || committedUseUnverified) return;
    setBusy(true); setActionError(null);
    void fn().then(
      async () => {
        if (!current()) return;
        try {
          await afterCommit();
        } catch {
          // The mutation is already committed. A failed follow-up read may
          // leave this view stale, but must never tell the player USE failed
          // and tempt them to spend another item.
        }
      },
      async (cause: unknown) => {
        if (!current()) return;
        if (recoverRejected && await recoverRejected(cause)) return;
        if (!current()) return;
        if (cause instanceof ApiError && cause.status === 409) {
          // Equipment writes are optimistic. A stale version must refresh the
          // authoritative loadout or every retry would resend the same version.
          reload();
          setActionError('Inventory changed elsewhere. Refreshed — try again.');
          return;
        }
        setActionError(cause instanceof Error ? cause.message : 'Action failed');
      },
    ).finally(() => { if (current()) setBusy(false); });
  };
  const refreshAfterUse = async (id: string): Promise<boolean> => {
    if (!current()) return false;
    const inventoryRefresh = refresh();
    // These two consumables complete a builder job in the same server
    // transaction as the item debit. Refresh the guarded deed snapshot so
    // its finished job/timer disappears without leaving Inventory.
    if (id !== 'keg_of_haste' && id !== 'finishers_seal') {
      try {
        await inventoryRefresh;
        return current();
      } catch {
        blockUnverifiedUse();
        return false;
      }
    }
    const [inventoryResult, baseRefresh] = await Promise.allSettled([
      inventoryRefresh,
      reloadCurrentBaseSnapshot(),
    ]);
    if (!current()) return false;
    if (inventoryResult.status === 'rejected') blockUnverifiedUse();
    if (baseRefresh.status === 'fulfilled' && baseRefresh.value) {
      bus.emit('base:refresh', undefined);
    }
    return inventoryResult.status === 'fulfilled';
  };
  const use = (id: string): void => {
    if (!ready() || busy || committedUseUnverified) return;
    const item = data?.catalog.find((candidate) => candidate.id === id);
    if (!item || !data?.owned.some((entry) => entry.itemId === id && entry.qty > 0) || item.activation?.active) return;
    if (item?.activation?.kind === 'hero') {
      // Recruitment consumes the contract only when its altar is placed.
      // The existing tray retains Keep/land/cap and placement validation.
      onClose?.();
      if (!isBaseSnapshotGuardCurrent(guard)) return;
      const state = useApp.getState();
      state.setBuildCategory('her');
      state.setScreen('build');
      return;
    }
    act(
      () => api.post('/items/use', withSelectedBase({ itemId: id })),
      () => refreshAfterUse(id).then(() => undefined),
      async (cause: unknown) => {
        const ambiguous = !(cause instanceof ApiError) || cause.status === 0 || cause.status >= 500;
        if (!ambiguous) return false;
        // A successful GET cannot prove the failed POST stopped: the response
        // can be lost while the server transaction is still committing. Keep
        // this screen fenced even if the immediate read still shows the old qty.
        setCommittedUseUnverified(true);
        setActionError('The game server response was interrupted. Verifying Inventory…');
        const verified = await refreshAfterUse(id);
        if (verified && current()) {
          setActionError(
            'The game server response was interrupted. Inventory was refreshed, but the item-use '
            + 'outcome is still uncertain. Close and reopen Inventory before using another item.',
          );
        }
        return true;
      },
    );
  };
  const equip = (id: string): void => {
    if (!ready()) return;
    const item = data?.catalog.find((candidate) => candidate.id === id);
    const hero = data?.heroLoadouts.find((candidate) => candidate.hero === selectedHero);
    if (!item || item.kind !== 'gear' || !item.slot || !hero) return;
    const desired = hero.equipment[item.slot] === id ? null : id;
    act(() => api.put(`/heroes/${selectedHero}/equipment/${item.slot}`, withSelectedBase({
      itemId: desired, expectedVersion: hero.version,
    })));
  };

  const close = (): void => {
    if (!current()) return;
    if (onClose) onClose();
    else useApp.getState().setScreen('base');
    const restore = (): void => {
      if (!isBaseSnapshotGuardCurrent(guard)) return;
      document.querySelector<HTMLButtonElement>(
        'button[aria-label="Inventory"], button[aria-label="Open inventory"]',
      )?.focus();
    };
    // The BAG control is part of BaseHud and remounts after this modal leaves.
    // One paint boundary is enough; no polling or global focus registry.
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(restore);
    else setTimeout(restore, 0);
  };

  return <InventoryView
    data={data} loading={loading} error={actionError ?? loadError}
    busy={!ready() || busy || committedUseUnverified}
    selectedHero={selectedHero} selectedId={selectedId} tab={tab} mobilePane={mobilePane}
    onClose={close}
    onHero={(hero) => { if (ready()) { setSelectedId(null); setSelectedHero(hero); } }} onSelect={select}
    // Filters and the compact pane switch are presentation only. Keep the
    // chosen item/detail stable through them, matching resize/rotation.
    onTab={setTab}
    onMobilePane={setMobilePane}
    onEquip={equip} onUse={use}
    onSell={(id) => {
      if (!ready() || busy || committedUseUnverified) return;
      const state = useApp.getState();
      state.setMarketSellItemId(id);
      state.setScreen('market');
    }}
    onViewDeeds={() => {
      if (!ready()) return;
      const state = useApp.getState();
      state.setMapTab('world');
      state.setWorldIntent('view-deeds');
      state.setScreen('map');
    }}
    onOpenShop={() => { if (current()) useApp.getState().setScreen('shop'); }}
  />;
}
