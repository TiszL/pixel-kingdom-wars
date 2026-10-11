/**
 * THE LIMITED STATE, MADE LEGIBLE (owner 2026-08-09, free onboarding).
 *
 * A deedless player can reach the Forge, the market, the raid chooser and the
 * world map — the buttons are all still there, because hiding them would leave
 * a player who has never seen the game unable to find out what the game is. So
 * every one of those refusals has to ARRIVE somewhere that explains itself. The
 * server answers `402 LAND_NOT_OWNED`; api.ts turns that into one global call;
 * this sheet is where it lands.
 *
 * Two pieces, both hook-free and prop-driven (the mapChromeUI.test.tsx pattern:
 * no jsdom in this package, so a component is asserted by CALLING it and reading
 * the element it returns — which only works while it takes no hooks):
 *   • LandGateSheet — the refusal, and the pitch.
 *   • NoLandPrompt  — the standing "you have no land yet" chip on the base HUD,
 *     so the limited state is discoverable BEFORE something refuses you.
 *
 * No new art: Panel9 / Phead / Chip / Btn / existing icons only.
 */
import type { ReactNode } from 'react';
import { LAND_FREE_TIER, LAND_NO_MAP_NOTE, LAND_SHARDS_NOTE, LAND_UNLOCKS } from '../state/land';
import { Btn, Chip, COLORS as C, Icon, ModalWrap, Phead } from './primitives';

/** One "what land buys you" row. */
function Unlock({ title, sub }: { title: string; sub: string }): React.JSX.Element {
  return (
    <Chip style={{ alignItems: 'flex-start', gap: 7 }}>
      <Icon name="sol" size={15} style={{ marginTop: 2, flex: 'none' }} />
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        <span style={{ color: C.goldHi, fontSize: 15, letterSpacing: '1px' }}>{title}</span>
        <span style={{ color: C.textFaint, fontSize: 13, lineHeight: 1.35 }}>{sub}</span>
      </span>
    </Chip>
  );
}

/**
 * The buy-land sheet. `entryFeeSol` is passed in rather than imported so the
 * price stays a single sourced value at the call site (@shardkeep/shared
 * ECONOMY) and this file never becomes a second place a game number lives.
 *
 * `reason` says whether the player was REFUSED something they just tapped or
 * came here to ASK. Opening a sheet titled LAND REQUIRED with "that needs land"
 * when nobody refused anything is the dead toast this replaces, only bigger — so
 * the sheet is told, and never guesses.
 */
export function LandGateSheet({
  entryFeeSol, reason, onBuy, onClose,
}: {
  entryFeeSol: number;
  reason: 'refused' | 'browse';
  onBuy: () => void;
  onClose: () => void;
}): React.JSX.Element {
  return (
    <ModalWrap onBackdrop={onClose}>
      <Phead title={reason === 'refused' ? 'LAND REQUIRED' : 'YOUR LAND'} onClose={onClose} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 9, padding: 13 }}>
        <div style={{ color: C.textDim, fontSize: 15, lineHeight: 1.45 }}>
          {reason === 'refused'
            ? 'That one needs land you do not own yet.'
            : 'Your keep stands on unclaimed ground.'}
          {' '}One on-chain payment of {entryFeeSol} SOL deeds this parcel to you.
        </div>
        {LAND_UNLOCKS.map((u) => <Unlock key={u.title} title={u.title} sub={u.sub} />)}
        <div style={{ color: C.textFaint, fontSize: 13, lineHeight: 1.4 }}>{LAND_NO_MAP_NOTE}</div>
        <div style={{ color: C.textFaint, fontSize: 13, lineHeight: 1.4 }}>{LAND_SHARDS_NOTE}</div>
        <Btn variant="gold" fontSize={21} style={{ padding: '11px 0 14px' }} onClick={onBuy}>
          <Icon name="sol" size={19} />BUY YOUR LAND · {entryFeeSol} SOL
        </Btn>
        {/* Dismissible on purpose. The whole point of the free tier is that a
            refusal is not the end of the session — there is a base to go back to. */}
        <Btn variant="ghost" fontSize={16} style={{ color: C.textFaint }} onClick={onClose}>
          KEEP BUILDING FOR NOW
        </Btn>
        <div style={{ color: C.stoneDark, fontSize: 13, lineHeight: 1.4 }}>{LAND_FREE_TIER}</div>
      </div>
    </ModalWrap>
  );
}

/**
 * THE LOCKED DOOR, IN PLACE OF THE SCREEN — what a deedless player gets instead
 * of a screen whose every request the server would refuse.
 *
 * It is a STATE, not a toast: it keeps the screen's own title and close button
 * (the caller renders it inside the same ScrollPage/ModalWrap), names what the
 * screen was for, says why it waits on land, and offers the purchase. `children`
 * is for the parts of a screen that are genuinely free and must stay reachable —
 * the key-export path under SECURITY is the load-bearing one, since exporting
 * your own private key is a custody right and is NOT gated on land.
 *
 * Hook-free so landLocked.test.tsx can assert its copy by calling it.
 */
export function LandLocked({
  title, why, entryFeeSol, onBuy, children,
}: {
  title: string;
  why: string;
  entryFeeSol: number;
  onBuy: () => void;
  children?: ReactNode;
}): React.JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
      <Chip accent={C.goldDp} style={{ alignItems: 'flex-start', gap: 8 }}>
        <Icon name="sol" size={18} style={{ marginTop: 2, flex: 'none' }} />
        <span style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
          <span style={{ color: C.goldHi, fontSize: 16, letterSpacing: '1px' }}>{title}</span>
          <span style={{ color: C.textDim, fontSize: 14, lineHeight: 1.45 }}>{why}</span>
        </span>
      </Chip>
      <Btn variant="gold" fontSize={18} onClick={onBuy}>
        <Icon name="sol" size={17} />BUY YOUR LAND · {entryFeeSol} SOL
      </Btn>
      <div style={{ color: C.stoneDark, fontSize: 13, lineHeight: 1.4 }}>{LAND_FREE_TIER}</div>
      {children}
    </div>
  );
}

/**
 * Standing base-HUD prompt for a deedless player. Deliberately a PROMPT in the
 * same slot and the same gold-rimmed shape as the first-run name nudge, not a
 * sixth navbar item: it disappears for good the moment land is owned, and a
 * landowner's HUD is byte-identical to what it has always been.
 */
export function NoLandPrompt({ onOpen }: { onOpen: () => void }): React.JSX.Element {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8, background: C.panel,
      border: `2px solid ${C.goldDp}`, boxShadow: `inset 0 2px 0 ${C.borderLt}`,
      padding: '6px 8px 8px', pointerEvents: 'auto',
    }}>
      <Icon name="sol" size={18} />
      <span className="interactive" onClick={onOpen} style={{ cursor: 'pointer', fontSize: 15, color: C.goldHi }}>
        NO LAND YET — GOLD FORGE, MARKET & RAIDS LOCKED
      </span>
    </div>
  );
}
