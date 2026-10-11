/**
 * VICTORY / DEFEAT result modals (App L936 / L1531). Stars banner, loot rows,
 * and a saved-replay link into the raid log. The result numbers come from the
 * resolved raid (passed in), never hardcoded.
 */
import { useEffect, useState } from 'react';
import { playSfx } from '../../lib/audio';
import { haptic } from '../../lib/juice';
import { useApp } from '../../state/store';
import { sprite } from '../icons';
import { Btn, COLORS as C, Chip, fmtN, Icon, ModalWrap, Phead, Sp } from '../primitives';

export interface RaidResult {
  stars: number;
  destructionPct: number;
  keepDestroyed: boolean;
  /** Null means the current deed holder inherited this pre-sale record and the
   * server intentionally redacted its prior owner's exact settlement. */
  lootShards: number | null;
  lootRedacted?: boolean;
  attackerTrophyDelta: number;
  /** KEEP credited to the attacker this raid (App VICTORY L946 "KEEP EARNED").
   * BACKEND GAP: /raids/:id/orders result DTO does not expose this yet — KEEP
   * and shards are one currency server-side (lootShards IS the credited KEEP),
   * but the App shows a *separate* KEEP EARNED number. Until the result DTO
   * surfaces a distinct keepEarned delta, this stays undefined and the row hides. */
  keepEarned?: number;
  /** Shards the attacker loses on a defeat (App DEFEAT L1540 "SHARDS LOST").
   * BACKEND GAP: the sim only loots on victory; a loss costs trophies + grants
   * the defender a shield, but the attacker loses no shards (raids.ts L295-359).
   * The result DTO has no shardsLost — the App's −640 was a faked number. */
  shardsLost?: number;
}

const home = (): void => useApp.getState().setScreen('base');

/**
 * DOM frame-swap sprite — the React port of the App's global `data-anim` ticker
 * (App L1673-1695: one 260ms interval cycles each sprite through a comma-list of
 * frame names by swapping `img.src`). Honours REDUCE MOTION (holds frame 0).
 */
function FxSprite({ frames, style }: { frames: string[]; style: React.CSSProperties }): React.JSX.Element {
  const reduceMotion = useApp((s) => s.reduceMotion);
  const [i, setI] = useState(0);
  useEffect(() => {
    if (reduceMotion || frames.length < 2) return;
    const t = setInterval(() => setI((n) => (n + 1) % frames.length), 260);
    return () => clearInterval(t);
  }, [reduceMotion, frames.length]);
  const url = sprite(frames[reduceMotion ? 0 : i] ?? frames[0]!);
  if (!url) return <></>;
  return <img src={url} width={64} height={64} alt="" style={{ position: 'absolute', zIndex: 1700, imageRendering: 'pixelated', ...style }} />;
}

function StarRow({ filled }: { filled: number }): React.JSX.Element {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', gap: 14, padding: '14px 0 4px' }}>
      {[0, 1, 2].map((i) => (
        <Icon key={i} name="star" size={48}
          style={{ opacity: i < filled ? 1 : 0.25, transform: i === 1 ? 'translateY(-10px)' : undefined }} />
      ))}
    </div>
  );
}

export function VictoryScreen({ result, onNext, onHome = home, nextLabel = 'NEXT RAID', homePrimary = false, onTrain }: {
  result: RaidResult | null; onNext: () => void; onHome?: () => void;
  /** Campaign wins advance to the next STAGE, so the button says so. */
  nextLabel?: string;
  homePrimary?: boolean;
  onTrain?: () => void;
}): React.JSX.Element {
  const stars = result?.stars ?? 0;
  // §3.10: escalating star stinger + banner slam (1★→3★ haptic light→heavy).
  useEffect(() => {
    const n = Math.min(3, Math.max(1, stars)) as 1 | 2 | 3;
    playSfx(`sfx_star_${n}` as 'sfx_star_1' | 'sfx_star_2' | 'sfx_star_3');
    haptic(n >= 3 ? 'heavy' : n === 2 ? 'medium' : 'light');
  }, [stars]);
  const keepEarned = result?.keepEarned;
  return (
    <>
      <ModalWrap>
        <Phead title="VICTORY" fontSize={32} center />
        <StarRow filled={stars} />
        <div style={{ textAlign: 'center', color: C.textFaint, fontSize: 18 }}>
          {result ? `${result.destructionPct}% DESTROYED${result.keepDestroyed ? ' · KEEP FELL' : ''}` : ''}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7, padding: '12px 16px' }}>
          <Chip><Icon name="shard" size={22} /><span>SHARDS LOOTED</span><Sp /><span style={{ color: result?.lootRedacted ? C.textFaint : C.goldHi }}>{result?.lootRedacted ? 'REDACTED' : fmtN(result?.lootShards ?? 0)}</span></Chip>
          {keepEarned != null && (
            <Chip><Icon name="keep" size={22} /><span>KEEP EARNED</span><Sp /><span style={{ color: C.goldHi }}>+{fmtN(keepEarned)}</span></Chip>
          )}
          <Chip>
            <Icon name="trophy" size={22} /><span>TROPHIES</span><Sp />
            <span style={{ color: C.success }}>{(result?.attackerTrophyDelta ?? 0) >= 0 ? '+' : ''}{result?.attackerTrophyDelta ?? 0}</span>
          </Chip>
        </div>
        <div style={{ display: 'flex', gap: 10, padding: '2px 16px 16px' }}>
          <Btn variant={homePrimary ? 'gold' : 'sec'} style={{ flex: 1 }} onClick={onHome}>HOME</Btn>
          <Btn variant={homePrimary ? 'sec' : 'gold'} style={{ flex: 1 }} onClick={onNext}>{nextLabel}</Btn>
        </div>
        {onTrain && <div style={{ padding: '0 16px 16px' }}><Btn variant="sec" style={{ width: '100%' }} onClick={onTrain}>TRAIN ARMY</Btn></div>}
      </ModalWrap>
      {/* App L957-958: two decorative FX overlays at z1700, screen-anchored over the scrim. */}
      <FxSprite frames={['fx_sparkle_f1', 'fx_sparkle_f2', 'fx_sparkle_f3']} style={{ left: '8%', top: '10%' }} />
      <FxSprite frames={['fx_loot_f1', 'fx_loot_f2', 'fx_loot_f3']} style={{ right: '7%', bottom: '12%' }} />
    </>
  );
}

export function DefeatScreen({ result, onReplay, onHome = home, onTrain }: { result: RaidResult | null; onReplay: () => void; onHome?: () => void; onTrain?: () => void }): React.JSX.Element {
  // A loss grants you a protective shield (§3.11 sfx_shield_up). Defeat is never
  // juiced as hard as victory (§3.10) — one soft note, no haptic.
  useEffect(() => { playSfx('sfx_shield_up', { volume: 0.8 }); }, []);
  // The saved replay lives in the RAID LOG. onReplay is honoured first so the
  // parent can tear down the raid scene, then we route to the log. (There is no
  // revenge endpoint, so no revenge affordance is advertised here.)
  const openReplay = (): void => { onReplay(); useApp.getState().setScreen('raidlog'); };
  const shardsLost = result?.shardsLost;
  return (
    <ModalWrap>
      <Phead title="DEFEAT" fontSize={32} center color={C.textFaint} />
      <StarRow filled={0} />
      <div style={{ textAlign: 'center', color: C.textFaint, fontSize: 18 }}>
        {result ? `${result.destructionPct}% DESTROYED · THE WALLS HELD` : 'THE WALLS HELD'}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 7, padding: '12px 16px' }}>
        {shardsLost != null && (
          <Chip>
            <Icon name="shard" size={22} /><span>SHARDS LOST</span><Sp />
            <span style={{ color: C.danger }}>−{fmtN(shardsLost)}</span>
          </Chip>
        )}
        <Chip>
          <Icon name="trophy" size={22} /><span>TROPHIES</span><Sp />
          <span style={{ color: C.danger }}>{result?.attackerTrophyDelta ?? 0}</span>
        </Chip>
        <Chip onClick={openReplay}>
          <Icon name="replay" size={22} /><span>REPLAY SAVED</span><Sp /><span style={{ color: C.success }}>OPEN ›</span>
        </Chip>
      </div>
      <div style={{ display: 'flex', gap: 10, padding: '2px 16px 16px' }}>
        <Btn variant="sec" style={{ flex: 1 }} onClick={onHome}>HOME</Btn>
        <Btn style={{ flex: 1 }} onClick={openReplay}>RAID LOG</Btn>
      </div>
      {onTrain && <div style={{ padding: '0 16px 16px' }}><Btn variant="sec" style={{ width: '100%' }} onClick={onTrain}>TRAIN ARMY</Btn></div>}
    </ModalWrap>
  );
}
