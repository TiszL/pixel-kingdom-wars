/**
 * FOUNDING KINGDOMS on the HUD (D-103, owner 2026-09-04: daily tester points
 * "small and competitive", a 14-day playtest that should be VISIBLE while you
 * play, not three taps deep — the owner's primary-surface bar).
 *
 * Two forms of one fact, "+N TODAY · 🔥S" from `/tester/me`:
 *
 *  - FoundingTaskButton — the persistent task rail (QUESTS · CACHE · MAIL · BAG
 *    · ARMY · FOUNDING), the same "label carries the number" contract as its
 *    neighbours: the badge is today's points, the face is the streak.
 *  - FoundingRow — the overflow panel row that replaced the bare TESTER row, so
 *    the destination is still one tap away from the player menu.
 *
 * Both open the TESTER screen. Both read the shared snapshot in testerDaily.ts
 * (one cached read per wallet per server gate; never a poll) and, like BAG and
 * ARMY, show NO number until the server has answered — a "+0" invented while
 * the read is in flight would be exactly the fake HUD figure the bar forbids.
 *
 * Nothing here imports the shared catalog: the HUD is eager, and the numbers
 * it shows are the server's, so it needs no titles or point tables.
 */
import { CHROME } from './layout';
import { HudChip, HudTaskButton } from './hudChrome';
import { COLORS as C, Icon, PillSub, PillVal } from './primitives';
import { useTesterMe } from './testerDaily';

export const FOUNDING_LABEL = 'FOUNDING';
export const FOUNDING_ARIA = 'Founding Kingdoms';

/** The chip's numbers, or null while the server has not answered (or the
 *  API cut predates daily points — then the chip is a plain destination). */
export function foundingView(data: { daily?: { todayPoints: number; streakDays: number } | undefined } | null):
  { today: number; streak: number } | null {
  if (!data?.daily) return null;
  return { today: data.daily.todayPoints, streak: data.daily.streakDays };
}

export function foundingAria(view: { today: number; streak: number } | null): string {
  return view && view.streak > 0 ? `${FOUNDING_ARIA} · ${view.streak}-day streak` : FOUNDING_ARIA;
}

export function FoundingTaskButton({ onOpen }: { onOpen: () => void }): React.JSX.Element {
  const { data } = useTesterMe();
  const view = foundingView(data);
  return (
    <HudTaskButton
      ariaLabel={foundingAria(view)}
      label={FOUNDING_LABEL}
      // The streak is the face once it exists — a run is the thing the daily
      // ledger asks you to keep — and the keep crest before one starts.
      icon={view && view.streak > 0
        ? <span aria-hidden="true" style={{ fontSize: 13, lineHeight: 1, whiteSpace: 'nowrap' }}>🔥{view.streak}</span>
        : <Icon name="keep" size={20} />}
      // Gold once today has paid something; red while today is still empty —
      // the daily loop's one call to action, in the CACHE badge's own idiom.
      {...(view ? { count: `+${view.today}`, settled: view.today > 0 } : {})}
      onClick={onOpen}
    />
  );
}

/** The overflow-panel form. Same 44px row contract as the panel's other rows
 *  (hudOverflow.tsx Row): a control, so it has an onClick and answers a press. */
export function FoundingRow({ onOpen }: { onOpen: () => void }): React.JSX.Element {
  const { data } = useTesterMe();
  const view = foundingView(data);
  return (
    <HudChip ariaLabel={foundingAria(view)} onClick={onOpen}
      style={{ minHeight: CHROME.tapRow, justifyContent: 'flex-start', padding: '0 8px' }}>
      {/* The star is the points mark; the keep already means BASES one row up. */}
      <Icon name="star" size={20} />
      <PillSub>{FOUNDING_LABEL} KINGDOMS</PillSub>
      {view && (
        <PillVal color={view.today > 0 ? C.goldHi : C.stoneDark}>
          +{view.today} TODAY{view.streak > 0 ? ` · 🔥${view.streak}` : ''}
        </PillVal>
      )}
    </HudChip>
  );
}
