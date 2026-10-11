/**
 * Lazy Codex screen. Keeping its long-form entries behind this route protects
 * the first-paint bundle while preserving live server-derived troop levels.
 */
import {
  ART_V2, WALL_ART, BUILD_COSTS, DEFENSES, KEEP_BATTERIES, LOOT, SHIELD, STRUCTURES, TRAP_REPAIR,
  TROOP_ABILITIES, TROOPS, TROOP_LEVELING, fmtDur, vaultProtectionBps, warePortraitAliasKey,
} from '@shardkeep/shared';
import { useState } from 'react';
import { api } from '../../lib/api';
import { selectedBasePath } from '../../lib/baseSelection';
import { useApp } from '../../state/store';
import { troopPortrait } from '../icons';
import { useFetch } from '../useFetch';
import {
  Btn, Chip, COLORS as C, Pill, PillVal, ScrollPage, Sprite,
} from '../primitives';

const home = (): void => useApp.getState().setScreen('base');

// --- CODEX (App L1071) — entries across 4 tabs --------------------------------

export interface CodexEntry {
  img: string;
  name: string;
  tag: string;
  who: string;
  strat?: string;
}
export type CodexTab = 'TROOPS' | 'DEFENSE' | 'BUILDINGS' | 'ITEMS';

const trainingTag = (key: keyof typeof TROOPS, suffix?: string): string => {
  const troop = TROOPS[key];
  const points = `${troop.pts} ${troop.pts === 1 ? 'PT' : 'PTS'}`;
  // Training is always minutes-or-less; spell the unit out rather than "2M",
  // which reads as a quantity next to the SHARDS count.
  const time = troop.trainSec % 60 === 0 ? `${troop.trainSec / 60} MIN` : `${troop.trainSec} SEC`;
  return `${points} · ${troop.costKeep} SHARDS · ${time}${suffix ? ` · ${suffix}` : ''}`;
};

export const CODEX: Record<CodexTab, CodexEntry[]> = {
  TROOPS: [
    {
      img: 'trp_highlander_portrait', name: 'HIGHLANDER', tag: trainingTag('highlander'),
      who: 'A mountain soldier in a sheepskin cloak. Brave, simple, always first through the gate.',
      strat: 'Your front line. He walks to the nearest building and soaks arrow fire while weaker troops work behind him. Cannons kill him fast — send the Tur Rider at those first.',
    },
    {
      img: 'trp_bowman_portrait', name: 'BOWMAN', tag: trainingTag('bowman'),
      who: 'A quiet hunter in a pine-green hood. Never gets close if he can help it.',
      strat: 'Shoots from 3.5 tiles — just past a Cannon. Fragile: one Mortar shell erases a whole cluster. Spread him out, and kill Mortars before massing.',
    },
    {
      img: 'trp_kegrunner_portrait', name: 'KEG RUNNER', tag: trainingTag('kegrunner', 'THE WALL BREAKER'),
      who: 'A tiny sprinter hugging a powder keg bigger than he is. The fuse is lit the moment he drops. He is not afraid — he simply does not think that far ahead.',
      strat: 'He runs to the exact wall that opens your army’s shortest path and blows it. One keg kills a t1 or t2 wall; t3 takes two kegs, or one plus a Powder Charge. The blast is cross-shaped. Archer Towers and Spike Traps shred him — deploy in pairs so the second finishes the job.',
    },
    {
      img: 'trp_tunneler_portrait', name: 'TUNNELER', tag: trainingTag('tunneler'),
      who: 'A mole of a man — dusty coat, sky-pale goggles, claws on his boots. Walls offend him personally.',
      strat: 'Goes UNDER, not through. He dives at the wall and travels as an untargetable dirt mound, popping up inside — 1 second vulnerable as he emerges. He never damages walls. Spike Traps trigger on his mound: the mole-catcher.',
    },
    {
      img: 'trp_turrider_portrait', name: 'TUR RIDER', tag: trainingTag('turrider'),
      who: 'A lancer on a huge white mountain tur. The horns arrive before the rider does.',
      strat: 'Your tank. He beelines to Cannons and Mortars and soaks their fire so everything else stays alive. Cannons hurt him most; Mortar splash barely matters on one big target.',
    },
    {
      img: 'trp_plunderer_portrait', name: 'PLUNDERER', tag: trainingTag('plunderer'),
      who: 'A wiry shadow in a blood-red mask with an empty sack and one gold-lit eye. He is only here for the money.',
      strat: 'Runs straight at Vaults and Mines and hits them for DOUBLE damage. Dies to anything that looks at him. Send him through the breach after the guns are busy — pure loot runs.',
    },
    {
      img: 'trp_gloamfang_portrait', name: 'GLOAMFANG',
      tag: trainingTag('gloamfang', 'FORGE WRIT'),
      who: 'An elite ground hunter that prioritizes defending troops before turning on the base.',
      strat: 'Howl strengthens nearby attackers, then leap and lunge close distance quickly. Its large camp footprint rewards deploying it where the buff can reach a real push.',
    },
    {
      img: 'trp_direwyvern_portrait', name: 'DIREWYVERN',
      tag: trainingTag('direwyvern', 'FORGE WRIT'),
      who: `A flying siege beast far stronger than a Dragon. It occupies ${TROOPS.direwyvern.pts} camp points—as much as several Dragons.`,
      strat: 'Its firestorm leaves damaging ground behind and maul punishes clustered targets. It flies over walls, but its enormous camp footprint makes every loss matter.',
    },
    {
      img: 'trp_hexbarrow_portrait', name: 'HEXBARROW',
      tag: trainingTag('hexbarrow', 'FORGE WRIT'),
      who: 'A slow mobile siege engine that fires hexshots and carries a brood of temporary Barrowlings.',
      strat: 'It prefers buildings and deals amplified structure damage, but still breaks a blocking wall when no preferred target is reachable. Protect it long enough to disgorge its full brood.',
    },
    {
      img: 'trp_barrowling_portrait', name: 'BARROWLING',
      tag: `SPAWN ONLY · ${TROOP_ABILITIES.hexbarrow.brood.lifespanSec} SEC LIFESPAN · ${TROOP_ABILITIES.hexbarrow.brood.variants} VARIANTS`,
      who: 'A short-lived Hexbarrow spawn. It cannot be trained, researched, stored in camp, or deployed directly.',
      strat: 'Barrowlings are replayed from the Hexbarrow’s server-authored spawn events. They pressure defenses briefly, then expire on the authoritative battle timeline.',
    },
  ],
  DEFENSE: [
    {
      // Rework-v2 (Phase D): the pack's t1 tier portrait — its atlas masters
      // are grid sheets, unusable as single <img> thumbnails.
      // D-060: ranges read the shared DEFENSES table (they were hardcoded 3/4
      // here and silently went stale the moment the owner retuned the guns).
      img: 'ui_portrait_cannon_t1', name: 'CANNON',
      tag: `RANGE ${DEFENSES.cannon.rangeTiles} · 1 SHOT / ${DEFENSES.cannon.fireIntervalSec} SEC`,
      who: 'A squat stone bastion with a pivot gun. Slow, heavy, patient.',
      strat: 'Single target, big hits. Shreds Tur Riders and Highlanders; struggles against fast swarms. Place it behind walls — the range ring you see is exactly what the game uses.',
    },
    {
      img: warePortraitAliasKey('archertower', 1), name: 'ARCHER TOWER',
      tag: `RANGE ${DEFENSES.archertower.rangeTiles} · ${Math.round(1 / DEFENSES.archertower.fireIntervalSec)} SHOTS / SEC`,
      who: 'A slim watchtower with a hooded bowman on top who never sleeps.',
      strat: 'Fast, light, hits many. Your answer to Keg Runners, emerging Tunnelers and Plunderer swarms. Pair it with a Cannon covering the same lane.',
    },
    {
      img: 'ui_portrait_mortar_t1', name: 'MORTAR', tag: 'RANGE 2–7 · SPLASH · KEEP L3+',
      who: 'A wide stone pit that lobs shells in a high arc. You hear it before you see it.',
      strat: 'Deletes clusters of Bowmen and Plunderers at long range — but it CANNOT hit anything closer than 2 tiles. Guard its dead zone or fast troops will hug it to death.',
    },
    {
      img: warePortraitAliasKey('airdefence', 1), name: 'AIR DEFENCE',
      tag: `${DEFENSES.airdefence.footprint.join('×')} · RANGE ${DEFENSES.airdefence.rangeTiles} · AIR ONLY · KEEP L${BUILD_COSTS.airdefence.requiresKeepLevel}`,
      who: 'A dedicated harpoon battery that tracks the sky and ignores every ground target.',
      strat: 'Its long reach punishes Dragons and Direwyverns, but ground armies can walk underneath untouched. Overlap its coverage with ground defenses instead of treating it as a general tower.',
    },
    {
      img: warePortraitAliasKey('spiketrap', 1), name: 'SPIKE TRAP',
      tag: `${BUILD_COSTS.spiketrap.costShards} SHARDS · ONE USE · REPAIR ${TRAP_REPAIR.spiketrap.costShardsByTier[0]}–${TRAP_REPAIR.spiketrap.costShardsByTier[ART_V2.tiers - 1]} SHARDS`,
      who: 'A patch of grass with a secret. Attackers see nothing at all.',
      strat: `${DEFENSES.spiketrap.burstDamageByTier[0]}–${DEFENSES.spiketrap.burstDamageByTier[ART_V2.tiers - 1]} damage to the first ground unit that steps on it. It is then spent and inert until repaired. Seed likely ground lanes rather than feeding it a cheap scout.`,
    },
    {
      img: warePortraitAliasKey('powdermine', 1), name: 'POWDER MINE',
      tag: `${BUILD_COSTS.powdermine.costShards} SHARDS · ONE USE · GROUND SPLASH · KEEP L${BUILD_COSTS.powdermine.requiresKeepLevel}`,
      who: 'A buried powder charge designed to punish a packed ground push.',
      strat: `Deals ${DEFENSES.powdermine.burstDamageByTier[0]}–${DEFENSES.powdermine.burstDamageByTier[ART_V2.tiers - 1]} damage in a tiered blast radius. It cannot hit flying units and remains spent until repaired.`,
    },
    {
      img: warePortraitAliasKey('pitfall', 1), name: 'PITFALL',
      tag: `${BUILD_COSTS.pitfall.costShards} SHARDS · ONE USE · GROUND STUN · KEEP L${BUILD_COSTS.pitfall.requiresKeepLevel}`,
      who: 'A concealed collapse that hurts one ground attacker and stops its advance.',
      strat: `Its stun scales from ${DEFENSES.pitfall.stunTicksByTier[0]} to ${DEFENSES.pitfall.stunTicksByTier[ART_V2.tiers - 1]} simulation ticks. Place it inside overlapping tower fire so the bounded pause matters.`,
    },
    {
      img: warePortraitAliasKey('airmine', 1), name: 'AIR MINE',
      tag: `${BUILD_COSTS.airmine.costShards} SHARDS · ONE USE · FLYING SPLASH · KEEP L${BUILD_COSTS.airmine.requiresKeepLevel}`,
      who: 'A drifting anti-air charge that ignores the ground and bursts among flyers.',
      strat: `Deals ${DEFENSES.airmine.burstDamageByTier[0]}–${DEFENSES.airmine.burstDamageByTier[ART_V2.tiers - 1]} damage to clustered flying attackers. Ground troops never trigger it.`,
    },
    {
      img: 'wall5_t1_straight_intact_f1', name: 'WALLS',
      tag: `${WALL_ART.tiers} ART TIERS · ${STRUCTURES.wall.maxTier} LEVELS`,
      who: 'Old Svan stone. It has outlived every army that touched it — until the kegs came.',
      strat: 'Walls slow and steer attackers. There are two answers to a wall — break it (Keg Runner) or go under it (Tunneler) — so build compartments, not one big box. Every extra wall buys your guns seconds.',
    },
  ],
  BUILDINGS: [
    {
      img: warePortraitAliasKey('keep', 1), name: 'KEEP',
      tag: `${STRUCTURES.keep.footprint.join('×')} · L1–L${STRUCTURES.keep.maxLevel} · THE HEART`,
      who: 'The tallest tower in your land — your home. Everything unlocks through it.',
      strat: `Gates every other building level. At L${KEEP_BATTERIES.highRangeUnlockLevel} it awakens a long-range ground battery, then at L${KEEP_BATTERIES.lowRangeUnlockLevel} gains a close-range battery for its dead zone. Neither fires at flying attackers.`,
    },
    {
      img: warePortraitAliasKey('mine', 1), name: 'MINE',
      tag: `${STRUCTURES.mine.footprint.join('×')} · L1–L${STRUCTURES.mine.maxLevel} · WHERE YOU EARN`,
      who: 'A timber-framed tunnel into the gold seam. The daily claim happens here.',
      strat: 'Each level raises your MINING QUOTA — the fixed shards your Mine makes each day, never split with other players. The best long-term investment in the game.',
    },
    {
      img: warePortraitAliasKey('vault', 1), name: 'VAULT', tag: '1×1 · L1–L20 · THE TARGET',
      who: 'A fat stone drum with a gold-banded door. It looks like money because it is.',
      // D-065 numbers come from LOOT/STRUCTURES so a retune never leaves the
      // Codex describing a rule settlement no longer applies.
      strat: `Raiders can take up to ${LOOT.balanceLootableBps / 100}% of this base's shards. Your best STANDING Vault shields part of that — ${vaultProtectionBps(1) / 100} points at L1, ${LOOT.vaultProtectionMaxBps / 100} at L${STRUCTURES.vault.maxLevel}, so a maxed Vault leaves only ${(LOOT.balanceLootableBps - LOOT.vaultProtectionMaxBps) / 100}% lootable. A Vault that falls in the raid protects nothing: wall it in.`,
    },
    {
      img: warePortraitAliasKey('barracks', 1), name: 'BARRACKS',
      tag: `${STRUCTURES.barracks.footprint.join('×')} · L1–L${STRUCTURES.barracks.maxLevel}`,
      who: 'A long stone hall that smells of oil and rope. Armies are made here.',
      strat: 'Trains troops into the Army Camp; queue size 10/15/20 points by level. Troops are consumed on every raid — treat your army as ammunition, not pets.',
    },
    {
      img: warePortraitAliasKey('forge', 1), name: 'ALCHEMY LAB',
      tag: `${STRUCTURES.forge.footprint.join('×')} · L1–L${STRUCTURES.forge.maxLevel} · TROOP UPGRADES`,
      who: 'A bubbling field laboratory where old recipes turn trained troops into stronger versions of themselves.',
      strat: 'Upgrades troop levels. No troop can out-level the Alchemy Lab — raise the building first, then research the troop. Its internal building identity remains forge for saved-base compatibility.',
    },
    {
      img: warePortraitAliasKey('camp', 1), name: 'ARMY CAMP',
      tag: `${STRUCTURES.camp.footprint.join('×')} · L1–L${STRUCTURES.camp.maxLevel} · CAP ${STRUCTURES.camp.capacityPts[0]}–${STRUCTURES.camp.capacityPts[STRUCTURES.camp.maxLevel - 1]} PTS`,
      who: 'Tents, a fire, and restless soldiers sharpening steel. Your army lives here between raids — you can SEE them waiting.',
      strat: 'Total army size = combined capacity of your camps. The Barracks trains; the Camp holds. Build more camps (or level them) before training a bigger army — a full camp means a full raid.',
    },
    {
      img: warePortraitAliasKey('clanhall', 1), name: 'CLAN HALL',
      tag: `${STRUCTURES.clanhall.footprint.join('×')} · L1–L${STRUCTURES.clanhall.maxLevel} · KEEP L${BUILD_COSTS.clanhall.requiresKeepLevel}`,
      who: 'A permanent gathering hall for the clan, standing inside the base like every other structure.',
      strat: 'It is destructible and counts toward raid destruction. Clan membership remains account-level, so losing the hall in battle never removes anyone from the clan.',
    },
  ],
  ITEMS: [
    { img: 'ui_icon_warhorn', name: 'WAR HORN', tag: '40 KEEP · ONE RAID', who: '+15% troop damage for the whole raid. Blow it when the wall is already down.' },
    { img: 'ui_icon_swiftboots', name: 'SWIFT BOOTS', tag: '30 KEEP · ONE RAID', who: '+20% move speed. Loot runs and dead-zone hugging get much easier.' },
    { img: 'ui_icon_powdercharge', name: 'POWDER CHARGE', tag: '35 KEEP · ONE RAID', who: '+60% damage against walls. Turns one Keg Runner into a t3-wall one-shot.' },
    { img: 'ui_skill_rally', name: 'RALLY', tag: 'FREE · KEEP L3 · ONCE PER RAID', who: 'A 5-second rage pulse (+25% speed and damage) around a point you pick. The skill is WHEN you pop it.' },
    { img: 'ui_icon_shield', name: 'SHIELD', tag: `${fmtDur(SHIELD.hoursOnLoss * 3_600).toUpperCase()} AFTER A LOSS`, who: `Nobody can raid you while it holds. Extend +${fmtDur(SHIELD.extendHours * 3_600).toUpperCase()} with SOL (max ${fmtDur(SHIELD.maxHours * 3_600).toUpperCase()}). It breaks the moment YOU attack another player.` },
    { img: 'ui_icon_energy', name: 'RAID ENERGY', tag: '3 FREE PER DAY', who: 'Each PvP raid costs one. Extra raid: 0.1 SOL, max 6 a day. Ruined Keeps never cost energy.' },
    { img: 'ui_icon_streak', name: 'STREAK', tag: 'UP TO ×1.4 MINING BONUS', who: 'Show up every day; the ×1.4 mining bonus kicks in at a 7-day streak. Miss a day and the streak resets — rebuild it.' },
    { img: 'brand_token_logo', name: 'KEEP', tag: 'PIXEL KINGDOM GOLD', who: 'The kingdom’s currency — everything you mine. Spend it to grow stronger, or withdraw it to your wallet as the KEEP token. That choice IS the game.' },
  ],
};


export function CodexScreen(): React.JSX.Element {
  const [tab, setTab] = useState<CodexTab>('TROOPS');
  const list = CODEX[tab];
  const tabs: CodexTab[] = ['TROOPS', 'DEFENSE', 'BUILDINGS', 'ITEMS'];
  // Real per-troop levels (App used S.troopLv; here from /army.levels, the same
  // field /army returns server-side). Lets the codex reflect the player's actual
  // upgrades instead of base stats.
  const selectedBaseId = useApp((s) => s.selectedBaseId);
  const { data: army } = useFetch<{ levels: Record<string, number> }>(
    () => api.get<{ levels: Record<string, number> }>(selectedBasePath('/army')),
    [selectedBaseId],
  );
  return (
    <ScrollPage
      title="CODEX"
      onClose={home}
      tabs={
        <div style={{ display: 'flex', gap: 4, padding: '8px 10px 0', background: C.card }}>
          {tabs.map((t) => (
            <Btn key={t} variant={tab === t ? 'gold' : 'ghost'} fontSize={18}
              style={{ flex: 1, padding: '6px 0 8px' }} onClick={() => setTab(t)}>{t}</Btn>
          ))}
        </div>
      }>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {list.map((e) => {
          const troopKey = e.img.startsWith('trp_') ? e.img.replace('trp_', '').replace('_portrait', '') : null;
          const t = troopKey && troopKey in TROOPS ? TROOPS[troopKey as keyof typeof TROOPS] : null;
          // App L1130: bld_* sprites render taller (50×70) in a 62×74 box;
          // troops/items stay 48×48.
          const big = e.img.startsWith('bld_');
          // App tStat: HP/DMG scale by statMultPerLevel^(lv-1), rounded; SPD/RNG
          // are unleveled. lv from the player's real troop level (default 1).
          const lv = (troopKey && army?.levels[troopKey]) || 1;
          const mult = Math.pow(TROOP_LEVELING.statMultPerLevel, lv - 1);
          return (
            <Chip key={e.name} style={{ alignItems: 'flex-start', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', width: '100%' }}>
                <div style={{ width: 62, height: 74, flex: 'none', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
                  {/* Troop entries route through troopPortrait with the SAME
                      real /army level the stat lines below use — identity for
                      the current roster (none is levelled), and the day a
                      dragon/giant codex entry lands its portrait tracks the
                      player's researched tier for free. Non-troop imgs pass
                      through untouched. */}
                  <Sprite name={troopKey ? troopPortrait(troopKey, army?.levels[troopKey]) : e.img} w={big ? 50 : 48} h={big ? 70 : 48} />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={{ fontSize: 21, color: C.goldHi }}>{e.name}</span>
                  <span style={{ fontSize: 14, color: C.goldDp, letterSpacing: '1px' }}>{e.tag}</span>
                </div>
              </div>
              {t && (
                <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                  <StatBadge label="LV" v={lv} />
                  <StatBadge label="HP" v={Math.round(t.hp * mult)} />
                  <StatBadge label="DMG" v={Math.round(t.dps * mult)} />
                  <StatBadge label="SPD" v={String(t.speedTilesPerSec)} />
                  <StatBadge label="RNG" v={t.range === 'melee' ? 'MELEE' : String(t.range)} />
                  <StatBadge label="MAX LV" v={TROOP_LEVELING.maxLevel} />
                </div>
              )}
              <span style={{ fontSize: 15, color: C.textDim, lineHeight: 1.25 }}>{e.who}</span>
              {e.strat && (
                <span style={{ fontSize: 15, color: C.textFaint, lineHeight: 1.25 }}>
                  <span style={{ color: C.success }}>HOW TO USE: </span>{e.strat}
                </span>
              )}
            </Chip>
          );
        })}
      </div>
    </ScrollPage>
  );
}

function StatBadge({ label, v }: { label: string; v: number | string }): React.JSX.Element {
  return (
    <Pill style={{ fontSize: 14 }}>
      <span style={{ color: C.textFaint, fontSize: 14 }}>{label}</span>
      <PillVal>{v}</PillVal>
    </Pill>
  );
}


export default CodexScreen;
