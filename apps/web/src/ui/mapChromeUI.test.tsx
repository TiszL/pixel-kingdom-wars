/**
 * THE CHROME MUST NOT PAN THE BOARD.
 *
 * The defect these pin (found 2026-08-09, worst on a phone): every control in
 * mapChromeUI is a DESCENDANT of the board root, and the board root carries the
 * pan gesture (map.tsx `panProps`). None of the wrappers attached a pointer
 * handler, so React bubbling delivered a press on GLOBE / WAR ROOM / HIDE
 * SHIELDED / a zoom pill straight into the board's pointer set and the map panned
 * BEHIND the button — while `IconBtn`'s bare `onClick` fired the action anyway.
 * One tap with a few px of unavoidable finger drift therefore did both.
 *
 * There is no jsdom in this package (see admin.test.tsx: screens are tested
 * through their pure helpers, never a React harness), so the rules live in pure
 * exported functions and the components are called DIRECTLY — a React component
 * is a function returning a plain element object, so `el.props.onPointerDown` is
 * readable without rendering anything. That is also why nothing in this file uses
 * a hook: keeping the wrappers hook-free is what keeps them assertable.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { MAPCHROME, mapChrome, type Insets } from './layout';
import {
  chromeDrifted, chromePointerDown, chromePointerMove, chromePointerUp, IconBtn, IconRail,
  MapTopBar, UnderBar, ZoomRail,
} from './mapChromeUI';

const INSET: Insets = { top: 0, right: 0, bottom: 0, left: 0 };
const L = mapChrome(390, 844, MAPCHROME.peek);

/** A pointer event with only the fields the guard reads, on a fresh target. */
const ev = (x: number, y: number, target: EventTarget = {} as EventTarget): {
  clientX: number; clientY: number; currentTarget: EventTarget; stopPropagation: () => void;
} => ({ clientX: x, clientY: y, currentTarget: target, stopPropagation: vi.fn() });

/**
 * React's bubbling contract, as the two handlers that actually matter: the
 * chrome's own, then the BOARD's pan handler on an ancestor. `stopPropagation`
 * ends the walk — which is the whole mechanism being asserted, so it is modelled
 * rather than mocked away.
 *
 * `board` stands for map.tsx `panProps.onPointerDown`, whose only job is to put
 * the pointer into `ptsRef` — i.e. being called at all IS the pan.
 */
function bubble(
  onChrome: ((e: ReturnType<typeof ev>) => void) | undefined,
  e: ReturnType<typeof ev>,
): { boardPanned: boolean } {
  let stopped = false;
  const source = e.stopPropagation as unknown as () => void;
  e.stopPropagation = (): void => { stopped = true; source(); };
  let boardPanned = false;
  const board = (): void => { boardPanned = true; };
  onChrome?.(e);
  if (!stopped) board();
  return { boardPanned };
}

/** Every wrapper's ROOT element, so the guard can be enumerated rather than
 *  spot-checked. All of them are hook-free by design. */
const WRAPPERS: Array<[string, { props: Record<string, unknown> }]> = [
  ['MapTopBar', MapTopBar({
    L, inset: INSET, mode: 'world', onMode: () => {}, onBack: () => {}, title: 'VALLEY',
  }) as unknown as { props: Record<string, unknown> }],
  ['IconRail', IconRail({ L, inset: INSET, children: null }) as unknown as { props: Record<string, unknown> }],
  ['UnderBar', UnderBar({ L, inset: INSET, children: null }) as unknown as { props: Record<string, unknown> }],
  ['ZoomRail', ZoomRail({
    L, inset: INSET, sheetH: MAPCHROME.peek, zoomBy: () => {}, step: 0.15,
  })! as unknown as { props: Record<string, unknown> }],
  ['IconBtn', IconBtn({ glyph: 'COMPASS', label: 'GLOBE', onClick: () => {} }) as unknown as { props: Record<string, unknown> }],
];

it('lets a board name the zoom rail’s home slot — the globe’s MY PARCEL rides it (D-097)', () => {
  // WHY: the globe dropped its separate icon rail on a 390 px phone by putting
  // MY PARCEL / CHOOSE LAND in the slot the local boards recentre from. The
  // board names the button; the default stays what map.tsx ships.
  type Rail = { props: { children: Array<{ props: Record<string, unknown> } | false> } };
  const named = ZoomRail({
    L, inset: INSET, sheetH: MAPCHROME.peek, zoomBy: () => {}, step: 0.5,
    onHome: () => {}, homeLabel: 'MY PARCEL', homeGlyph: '⌂',
  }) as unknown as Rail;
  const home = named.props.children.filter(Boolean).at(-1) as { props: Record<string, unknown> };
  expect(home.props['label']).toBe('MY PARCEL');
  const plain = ZoomRail({
    L, inset: INSET, sheetH: MAPCHROME.peek, zoomBy: () => {}, step: 0.5, onHome: () => {},
  }) as unknown as Rail;
  const recentre = plain.props.children.filter(Boolean).at(-1) as { props: Record<string, unknown> };
  expect(recentre.props['label']).toBe('RECENTRE');
  // No home handler, no third button — the slot is the board's to fill or leave.
  const none = ZoomRail({
    L, inset: INSET, sheetH: MAPCHROME.peek, zoomBy: () => {}, step: 0.5,
  }) as unknown as Rail;
  expect(none.props.children.filter(Boolean)).toHaveLength(2);
});

it('uses the authored compass art for globe chrome, never an OS emoji', () => {
  const map = readFileSync(new URL('./screens/map.tsx', import.meta.url), 'utf8');
  const globe = readFileSync(new URL('./screens/globe/GlobeLayer.tsx', import.meta.url), 'utf8');
  const counts = readFileSync(new URL('./screens/globe/GlobeBaseCounts.tsx', import.meta.url), 'utf8');
  expect(`${map}\n${globe}\n${counts}`).not.toContain('🌐');
  expect(map).toContain('name="ui_compass"');
  expect(globe).toContain('<GlobeBaseCounts');
  expect(globe).toContain('name="ui_compass"');
  // The full directory count has a separate row; it cannot compete with the
  // optional WARZONE badge for the narrow phone's top-bar width.
  expect(globe).toMatch(/<UnderBar[^>]*>\s*<GlobeBaseCounts/);
});

it('mounts only the deed globe for WORLD, with no valley descent path', () => {
  const map = readFileSync(new URL('./screens/map.tsx', import.meta.url), 'utf8');
  const globe = readFileSync(new URL('./screens/globe/GlobeLayer.tsx', import.meta.url), 'utf8');
  expect(map).toContain("mode === 'world' && (");
  expect(map).toContain('<GlobeLayer openSeq={1} />');
  expect(map).not.toContain('<WorldMap');
  expect(map).not.toContain('onEnterValley=');
  expect(map).not.toContain('GLOBE_ENABLED');
  expect(globe).not.toContain('onEnterValley');
  expect(globe).not.toContain('ENTER MY REGION');
  expect(globe).not.toContain('LOOK AROUND THIS REGION');
  expect(map).toContain("'Opening the world…'");
  expect(map).toContain('sk-game-loading-back');
  expect(map).not.toContain('<Suspense fallback={null}>\n          <GlobeLayer');
  expect(map).not.toContain('WORLD OPENS ON THE LOCAL MAP');
  expect(map).not.toContain('🔍');
});

describe('a pointerdown on chrome never reaches the board pan handler', () => {
  it('every chrome wrapper attaches the guard to its own root node', () => {
    // ZoomRail is the one that can legitimately be null (the solver drops it when
    // the sheet leaves no band) — assert we got a real element to check.
    for (const [name, el] of WRAPPERS) {
      expect(el, name).toBeTruthy();
      expect(el.props['onPointerDown'], `${name}.onPointerDown`).toBe(chromePointerDown);
      expect(el.props['onPointerMove'], `${name}.onPointerMove`).toBe(chromePointerMove);
      expect(el.props['onPointerUp'], `${name}.onPointerUp`).toBe(chromePointerUp);
      expect(el.props['onPointerCancel'], `${name}.onPointerCancel`).toBe(chromePointerUp);
    }
  });

  it('stops the event, so the board never registers the pointer', () => {
    for (const [name, el] of WRAPPERS) {
      const onDown = el.props['onPointerDown'] as (e: ReturnType<typeof ev>) => void;
      expect(bubble(onDown, ev(120, 300)).boardPanned, name).toBe(false);
    }
  });

  it('…and the same press WITHOUT the guard does pan — the test can fail', () => {
    // Guards against the assertion above passing for the wrong reason (a bubble()
    // that never calls the board would pass no matter what the chrome did).
    expect(bubble(undefined, ev(120, 300)).boardPanned).toBe(true);
  });
});

describe('a drifted press does not fire the button it started on', () => {
  /** IconBtn's real click path: the element's own onClick with a currentTarget. */
  interface BtnEl {
    props: {
      onPointerDown(e: ReturnType<typeof ev>): void;
      onPointerMove(e: ReturnType<typeof ev>): void;
      onPointerUp(e: ReturnType<typeof ev>): void;
      onClick(e: { currentTarget: EventTarget }): void;
    };
  }
  const button = (action: () => void): BtnEl =>
    IconBtn({ glyph: '⚔', label: 'WAR ROOM', onClick: action }) as unknown as BtnEl;

  /** The full browser sequence: down, moves, up, then the click it synthesises. */
  const press = (
    action: () => void,
    moves: Array<[number, number]>,
    target: EventTarget = {} as EventTarget,
  ): void => {
    const el = button(action);
    el.props.onPointerDown(ev(100, 100, target));
    for (const [x, y] of moves) el.props.onPointerMove(ev(x, y, target));
    const last = moves.at(-1) ?? [100, 100];
    el.props.onPointerUp(ev(last[0], last[1], target));
    el.props.onClick({ currentTarget: target });
  };

  it('fires on a still press', () => {
    const action = vi.fn();
    press(action, []);
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('fires through the jitter a real finger always has', () => {
    const action = vi.fn();
    press(action, [[102, 101], [103, 104]]); // 7px cumulative — under the gate
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire once the press has travelled past the pan threshold', () => {
    const action = vi.fn();
    press(action, [[100, 106], [100, 118]]); // 18px — this press was a pan attempt
    expect(action).not.toHaveBeenCalled();
  });

  it('uses the SAME threshold as the board pan gate, so the two can never disagree', () => {
    // Exactly at MAPCHROME.dragPx is still a tap; one px past it is a drag. Both
    // gates read this constant, which is the point of hoisting it into MAPCHROME:
    // a chrome press that the board would have treated as a pan must not commit.
    const at = vi.fn(); press(at, [[100 + MAPCHROME.dragPx, 100]]);
    expect(at).toHaveBeenCalledTimes(1);
    const past = vi.fn(); press(past, [[100 + MAPCHROME.dragPx + 1, 100]]);
    expect(past).not.toHaveBeenCalled();
  });

  it('is CUMULATIVE from the press origin, not a per-event delta', () => {
    // The bug the board's own gate was fixed for: a slow drag made of ≤8px steps
    // must still count. Per-event deltas here would let a 300px rail scroll fire
    // the button under the finger.
    const action = vi.fn();
    press(action, [[104, 100], [108, 100], [112, 100], [116, 100]]);
    expect(action).not.toHaveBeenCalled();
  });

  it('resets per press, so a drifted press does not poison the next one', () => {
    const target = {} as EventTarget;
    chromePointerDown(ev(0, 0, target));
    chromePointerMove(ev(40, 0, target));
    expect(chromeDrifted(target)).toBe(true);
    chromePointerDown(ev(0, 0, target));
    expect(chromeDrifted(target)).toBe(false);
  });

  it('does not leave a drifted press latched onto the element (observed live)', async () => {
    // THE BUG THIS PINS, found driving the fix in a browser: the flag was only ever
    // reset by the NEXT pointerdown, so one abandoned drifted press left the button
    // permanently suppressed for any click that arrives without a pointer sequence —
    // Enter, a screen reader, a synthetic click. The GLOBE button was dead to
    // keyboard activation for the rest of the session after one drifted press.
    const target = {} as EventTarget;
    const drifted = vi.fn();
    press(drifted, [[100, 40]], target);
    expect(drifted).not.toHaveBeenCalled(); // the drifted press is still suppressed…
    // …and the record is dropped on the next task, not carried forever.
    await new Promise((r) => { setTimeout(r, 0); });
    expect(chromeDrifted(target)).toBe(false);
    const later = vi.fn();
    button(later).props.onClick({ currentTarget: target });
    expect(later).toHaveBeenCalledTimes(1);
  });

  it('keeps the flag alive for the click that immediately follows pointerup', () => {
    // The clear MUST be deferred: clearing it inside pointerup would let the very
    // click it exists to suppress through, which is the original defect.
    const target = {} as EventTarget;
    chromePointerDown(ev(0, 0, target));
    chromePointerMove(ev(40, 0, target));
    chromePointerUp(ev(40, 0, target));
    expect(chromeDrifted(target)).toBe(true);
  });

  it('treats an untouched element as undrifted (a keyboard/AT click still works)', () => {
    // A click with no preceding pointer sequence — screen reader, Enter key,
    // synthetic — must not be swallowed for lack of a drift record.
    expect(chromeDrifted({} as EventTarget)).toBe(false);
  });
});
