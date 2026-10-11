/**
 * Inline building info + Keep unlock list (owner 2026-08-15, M23 a7/a19).
 *
 * The ActionSheet's INFO button used to dump the player onto the Codex screen,
 * which always opened on the TROOPS tab regardless of what they tapped. This
 * panel renders the SAME authored Codex prose in place, keyed by building
 * type, plus — for the Keep — the derived "next level unlocks" list from
 * @shardkeep/shared's reverse index.
 *
 * LAZY on purpose: sheets.tsx is first-paint code and this module pulls the
 * whole Codex prose in; it must only ever load behind the lazy() boundary
 * (same discipline as the train/research trays). K-007 still governs copy:
 * entries the owner has not authored (epic towers, gold forge, altars) get a
 * stats-only note, never invented lore.
 */
import { HEROES, unlocksAtKeepLevel, type HeroKey, type KeepLevelUnlock } from '@shardkeep/shared';
import { CODEX, type CodexEntry } from './screens/codex';
import { BODY_TEXT_STYLE, COLORS as C, Sprite } from './primitives';
import { TROOP_DISPLAY } from './copy';
import { sheetPortrait, trayLabel } from './sheets';
import { heroPortrait } from './heroPortrait';

/** Codex entries are keyed by display name (reference-App shape); this is the
 *  building-type → entry-name bridge. Types absent here have no authored copy
 *  yet — see K-007. */
const CODEX_NAME_BY_TYPE: Record<string, string> = {
  cannon: 'CANNON', archertower: 'ARCHER TOWER', mortar: 'MORTAR',
  airdefence: 'AIR DEFENCE', spiketrap: 'SPIKE TRAP', powdermine: 'POWDER MINE',
  pitfall: 'PITFALL', airmine: 'AIR MINE', wall: 'WALLS',
  keep: 'KEEP', mine: 'MINE', vault: 'VAULT', barracks: 'BARRACKS',
  forge: 'ALCHEMY LAB', camp: 'ARMY CAMP', clanhall: 'CLAN HALL',
};

function entryFor(type: string): CodexEntry | null {
  const name = CODEX_NAME_BY_TYPE[type];
  if (!name) return null;
  // DEFENSE and BUILDINGS are the two tabs that describe placeable structures;
  // ITEMS also has a 'KEEP' (the currency) which must never match a building.
  return [...CODEX.DEFENSE, ...CODEX.BUILDINGS].find((e) => e.name === name) ?? null;
}

function unlockLabel(u: KeepLevelUnlock): string {
  switch (u.kind) {
    case 'building': return `NEW BUILDING — ${trayLabel(u.id!)}`;
    case 'troop': return `NEW TROOP — ${TROOP_DISPLAY[u.id!] ?? u.id!.toUpperCase()}`;
    case 'hero': return `HERO — ${(HEROES as Record<string, { name: string }>)[u.id!]?.name?.toUpperCase() ?? u.id!.toUpperCase()}`;
    case 'rally': return 'RALLY — RAGE PULSE IN RAIDS';
    case 'keepBattery': return u.id === 'high' ? 'KEEP BATTERY — LONG-RANGE GUN' : 'KEEP BATTERY — CLOSE-RANGE GUN';
    case 'buildCount': return `+${u.delta} ${trayLabel(u.id!)} (MAX ${u.value})`;
    case 'mineCap': return `+${u.delta} MINE (MAX ${u.value})`;
    case 'trapCap': return `+${u.delta} TRAPS (MAX ${u.value})`;
    case 'expansion': return `LAND EXPANSION AVAILABLE (${u.value}×${u.value})`;
  }
}

export default function BuildingInfo({ type, level, maxLevel }: {
  type: string;
  level: number;
  /** The building's own max level — the unlock list hides at the cap. */
  maxLevel: number;
}): React.JSX.Element {
  const entry = entryFor(type);
  const unlocks = type === 'keep' && level < maxLevel ? unlocksAtKeepLevel(level + 1) : [];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingTop: 6 }}>
      {entry ? (
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
          {/* The card shows the selected wall tier; generic building entries
              keep their authored Codex portrait. */}
          <span aria-hidden="true" style={{
            flex: 'none', width: 56, height: 56, display: 'grid', placeItems: 'center',
            background: C.card, border: `2px solid ${C.borderLt}`,
          }}>
            <Sprite name={type === 'wall' ? sheetPortrait(type, level) : entry.img} w={48} h={48} />
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ ...BODY_TEXT_STYLE, color: C.textDim }}>{entry.who}</div>
            {entry.strat && (
              <div style={{ ...BODY_TEXT_STYLE, color: C.textDim, marginTop: 4 }}>{entry.strat}</div>
            )}
          </div>
        </div>
      ) : (
        <div style={{ color: C.textFaint, fontSize: 13, lineHeight: 1.4 }}>
          Field reports on this structure are still being written. Its numbers
          above are live.
        </div>
      )}
      {unlocks.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <div style={{ color: C.goldHi, fontSize: 14, letterSpacing: '1px' }}>
            LEVEL {level + 1} UNLOCKS
          </div>
          {unlocks.map((u, i) => {
            // Rows SHOW what unlocks (owner 2026-08-15): building rows reuse
            // the Codex portrait, troop rows their portrait, hero rows theirs.
            const art = u.kind === 'building' ? entryFor(u.id!)?.img
              : u.kind === 'troop' ? `trp_${u.id}_portrait`
              : u.kind === 'hero' ? heroPortrait(u.id as HeroKey)
              : null;
            return (
              <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center', minHeight: 24 }}>
                {art ? (
                  <span aria-hidden="true" style={{ flex: 'none', width: 24, height: 24, display: 'grid', placeItems: 'center' }}>
                    <Sprite name={art} w={22} h={22} />
                  </span>
                ) : (
                  <span style={{ color: C.gold, fontSize: 12, width: 24, textAlign: 'center' }}>▸</span>
                )}
                <span style={{ color: C.textDim, fontSize: 13 }}>{unlockLabel(u)}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
