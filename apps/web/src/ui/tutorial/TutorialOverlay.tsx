/**
 * First-run tutorial overlay (M23 a6, owner 2026-08-15) — the LAZY half; the
 * eager mount logic lives in TutorialHost.tsx.
 *
 * WHAT THIS IS: a bottom instruction card (Panel9, the game's own chrome) with
 * a step title, two-to-three sentences, step dots, NEXT and SKIP TUTORIAL —
 * plus, where the target is real DOM, a pulsing ring over the HUD control the
 * step talks about. Steps whose target lives INSIDE the Phaser canvas get the
 * card alone: there is nothing to ring.
 *
 * IT IS NOW THREE CARDS LONG, NOT FOURTEEN (owner 2026-08-28). The cards that
 * instructed the player to build, mine, train, raid and buy land are quests —
 * see STEP_COPY's note and QUESTS.onboardingTemplates — and the last card here
 * hands over to the quest board rather than continuing to talk. The chain itself
 * is rendered by OnboardingGuide.tsx, which shares this chunk's anchor machinery
 * (tutorial/anchors.tsx) and takes over the moment this deck ends.
 *
 * THE THREE RULES THIS FILE MUST KEEP:
 *  1. SERVER TRUTH ONLY. Every advance POSTs /tutorial/advance and adopts the
 *     server's returned state; SKIP posts /tutorial/guide/skip so the whole
 *     guided flow stops. A refused advance
 *     re-reads GET /tutorial rather than guessing.
 *  2. NEVER CRASH, NEVER BLOCK. Anchor lookup is fail-soft (missing element →
 *     card alone); the wrapper is pointer-events:none with only the card
 *     interactive; z-index sits UNDER sheets (1050+) and modals (1500), so an
 *     open dialog always covers the coach mark. The ring itself and the anchor
 *     lookup moved to tutorial/anchors.tsx on 2026-08-29 — the guided chain
 *     rings controls too, and one implementation is the point.
 *  3. COPY LIVES HERE, in the lazy chunk — TUTORIAL_STEPS in @shardkeep/shared
 *     is ids+count only, so the first-paint barrel never carries prose.
 *
 * AUTO-ADVANCE where the game already announces the step's deed on the bus
 * (collect → 'base:refresh', placement → 'build:end', FIT → 'base:camera');
 * everywhere else NEXT advances.
 */
import { useEffect, useRef } from 'react';
import { TUTORIAL_STEPS, warePortraitAliasKey } from '@shardkeep/shared';
import { api } from '../../lib/api';
import { selectedBasePath } from '../../lib/baseSelection';
import { captureBaseSnapshotGuard, isBaseSnapshotGuardCurrent } from '../../state/store';
import { EVENTS, track } from '../../lib/analytics';
import { bus, type GameEvents } from '../../lib/events';
import { useApp } from '../../state/store';
import { Btn, COLORS as C, Panel9, Sprite } from '../primitives';
import { tutorialCardBottom, tutorialSurfaceInsets, useWindowSize } from '../layout';
import { AnchorRing, useAnchorBox, type AnchorSpec } from './anchors';
import type { TutorialStateDto } from './TutorialHost';

type AutoEvent = keyof Pick<GameEvents, 'base:refresh' | 'build:end' | 'base:camera'>;

/**
 * `selector` is the shared AnchorSpec — see tutorial/anchors.tsx, which also
 * owns the fail-soft rule. Targets use explicit tutorial data hooks rather than
 * visible copy so count badges and translated labels cannot break guidance.
 */
interface StepCopy extends AnchorSpec {
  title: string;
  body: string;
  /** Bus event that means "the player did the thing" — auto-advances. */
  auto?: AutoEvent;
  /** Atlas sprite drawn 56px on the card (CoC-style visual onboarding —
   *  owner 2026-08-15: cards must SHOW the building they talk about). */
  sprite?: string;
}

/**
 * Copy per TUTORIAL_STEPS id ('done' is terminal — no card; the server stamps
 * completion when the final advance lands on it).
 *
 * ELEVEN CARDS WERE RETIRED HERE ON 2026-08-28 (owner: onboarding "needs more
 * interactive approach, instead of displaying cards we should direct player to
 * do things like in professionally built games"). The five that TOLD the player
 * to collect a Mine, raise a building, train troops, raid and buy land are now
 * real quests with server-tracked progress and a reward — QUESTS.
 * onboardingTemplates — and the six that merely DESCRIBED a building family
 * (keep, economy, defense, heroes, bases, mail) were the card-reading the owner
 * rejected; the same ground is covered by the CODEX and by each building's own
 * info sheet, which are reachable whenever the player wants them rather than
 * stacked in front of a player who wants to play.
 *
 * WHAT IS LEFT IS THE RESIDUE NO QUEST CAN EXPRESS: who you are, how to move the
 * camera, and where your objectives now live.
 */
const STEP_COPY: Readonly<Record<string, StepCopy>> = {
  welcome: {
    sprite: warePortraitAliasKey('keep', 1),
    title: 'WELCOME, KEEPER',
    body: 'This keep is yours: mine Shards, raise buildings, train an army and raid for more. You will learn it by doing it — your first objectives are waiting on the quest board.',
  },
  // FIT moved into the player menu with the floating HUD (2026-09-17): the
  // selector rings the menu's FIT BASE row when the panel is open and the
  // keep-icon opener when it is not — the same two-stage anchor the quests
  // card uses. Document order decides between them, and only one is ever in
  // the DOM at a time.
  camera: {
    title: 'LOOK AROUND',
    body: 'Open your Keep menu (top-left) and tap FIT BASE to frame your whole base. Drag to pan; pinch or scroll to zoom.',
    selector: '[aria-label="Fit base to screen"], [data-tutorial-target="player-menu"]',
    auto: 'base:camera',
  },
  // THE HAND-OFF. This is the last card, and the only job it has is to leave the
  // player standing in front of the surface that replaced the other eleven.
  quests: {
    title: 'YOUR ORDERS LIVE HERE',
    body: 'The quest board is your to-do list: each step names the next thing to do, takes you there, and pays Shards when it is done. Find it any time under your Keep menu (top-left) › QUESTS.',
    selector: '[data-tutorial-target="daily-quests"], [data-tutorial-target="player-menu"]',
  },
};

/** The deck sits UNDER sheets (1050+) and modals (1500): an open dialog always
 *  covers a card that is only describing the game. */
const DECK_Z = 1020;

export default function TutorialOverlay({ step, onState }: {
  step: number;
  onState: (s: TutorialStateDto) => void;
}): React.JSX.Element | null {
  const viewport = useWindowSize();
  const screen = useApp((s) => s.screen);
  const insets = tutorialSurfaceInsets(viewport.w, viewport.h);
  const busy = useRef(false);
  const id = TUTORIAL_STEPS.ids[step];
  const copy = id ? STEP_COPY[id] : undefined;
  const contentSteps = TUTORIAL_STEPS.count - 1; // 'done' is not a card
  const last = step === contentSteps - 1;

  const adopt = (s: TutorialStateDto): void => {
    // Analytics (a13 taxonomy): steps and completion are client-tier events;
    // the server-stored row remains the authoritative funnel source.
    track(EVENTS.TUTORIAL_STEP, { step: s.step });
    if (s.completedAt !== null) {
      track(EVENTS.TUTORIAL_COMPLETED);
      bus.emit('ui:toast', { msg: 'TUTORIAL COMPLETE — REPLAY IT FROM SETTINGS' });
    }
    onState(s);
  };

  const advance = (): void => {
    if (busy.current) return;
    busy.current = true;
    const guard = captureBaseSnapshotGuard();
    void api.postRaw<TutorialStateDto>('/tutorial/advance', { step: step + 1 })
      .then((state) => {
        if (!isBaseSnapshotGuardCurrent(guard)) return;
        adopt(state);
        if (last && state.completedAt !== null) useApp.getState().setScreen('quests');
      })
      // Refused (another device advanced past us, or a stale card): adopt the
      // server's truth instead of guessing. Network failure: stay put — NEXT
      // simply works again.
      .catch(() => {
        if (!isBaseSnapshotGuardCurrent(guard)) return;
        return api.get<TutorialStateDto>(selectedBasePath('/tutorial'))
          .then((state) => { if (isBaseSnapshotGuardCurrent(guard)) onState(state); }).catch(() => undefined);
      })
      .finally(() => { busy.current = false; });
  };

  const skip = (): void => {
    if (busy.current) return;
    busy.current = true;
    void api.postRaw<TutorialStateDto>('/tutorial/guide/skip', {})
      .then(adopt)
      .catch(() => undefined)
      .finally(() => { busy.current = false; });
  };

  /**
   * NOBODY IS STRANDED BY A SHORTER DECK.
   *
   * The deck went from 14 content cards to 3 on 2026-08-28, and the server
   * stores progress as an INDEX into that list. A live row parked on a retired
   * index (a player who was on 'heroes' when this shipped) finds no copy: the
   * overlay would render nothing, the host would still believe the tutorial is
   * unfinished, and only the server can end that — `advance` will not reach the
   * final step from an index past it, and there is no card to press.
   *
   * So the no-copy case SETTLES the row through /tutorial/guide/skip, exactly as the
   * SKIP button does. The player loses nothing: the cards they had not reached
   * are the ones the quest chain now walks them through, and that chain's
   * progress is tracked independently of this row.
   *
   * `busy` makes it once per mount, and skip is idempotent server-side
   * (coalesce on completedAt), so a re-render cannot double-post.
   */
  const stranded = !copy;
  useEffect(() => {
    if (!stranded) return;
    skip();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire once per stranded step
  }, [stranded, step]);

  // Auto-advance on the game's own signal. FIT has no mount-time synthetic
  // emitter, so a fast real tap must never be discarded.
  const auto = copy?.auto;
  useEffect(() => {
    if (!auto) return;
    return bus.on(auto, advance);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-arm per step
  }, [auto, step]);

  useEffect(() => {
    if (last && screen === 'quests') advance();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the actual quest-board tap completes this card
  }, [last, screen]);

  // Coach-mark ring: measured from the live DOM by the shared anchor hook.
  // Missing element → card alone (the fail-soft rule lives in anchors.tsx).
  const anchored = !!copy?.selector;
  const ring = useAnchorBox(anchored && copy ? copy : null, `deck:${step}`);
  const cardBottom = tutorialCardBottom(viewport.h, insets.bottom, ring);

  // 'done' (or an id this bundle does not know) has no card. The server state
  // that lands here always carries completedAt for 'done', so the host hides
  // us anyway — this is the belt to that suspender.
  if (!copy) return null;

  return (
    <div style={{
      position: 'absolute', inset: 0, zIndex: DECK_Z, pointerEvents: 'none',
    }}>
      {ring && <AnchorRing box={ring} zIndex={DECK_Z} />}
      <div style={{
        position: 'absolute',
        left: `calc(${insets.left}px + env(safe-area-inset-left))`,
        right: `calc(${insets.right}px + env(safe-area-inset-right))`,
        bottom: `calc(${cardBottom}px + env(safe-area-inset-bottom))`,
        display: 'flex', justifyContent: 'center',
      }}>
        <Panel9 className="interactive" style={{
          pointerEvents: 'auto', width: 440, maxWidth: '100%',
          padding: '10px 12px 12px',
        }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
            <span style={{ color: C.goldHi, fontSize: 21, letterSpacing: '1px' }}>{copy.title}</span>
            <span style={{ flex: 1 }} />
            <span aria-label={`Tutorial step ${step + 1} of ${contentSteps}`} style={{ display: 'inline-flex', gap: 4 }}>
              {Array.from({ length: contentSteps }, (_, i) => (
                <span key={i} aria-hidden="true" style={{
                  width: 7, height: 7, display: 'inline-block',
                  background: i <= step ? C.gold : C.stoneDark,
                }} />
              ))}
            </span>
          </div>
          <div style={{ display: 'flex', gap: 10, marginTop: 6, alignItems: 'flex-start' }}>
            {/* The card SHOWS the building it talks about (owner 2026-08-15 —
                CoC-style visual onboarding). Sprite is fail-soft: an unknown
                key renders an empty box, never a crash. */}
            {copy.sprite && (
              <span aria-hidden="true" style={{
                flex: 'none', width: 60, height: 60, display: 'grid', placeItems: 'center',
                background: C.card, border: `2px solid ${C.borderLt}`,
              }}>
                <Sprite name={copy.sprite} w={52} h={52} />
              </span>
            )}
            <div style={{ color: C.textDim, fontSize: 16, lineHeight: 1.4, flex: 1, minWidth: 0 }}>
              {copy.body}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10, marginTop: 10, alignItems: 'center' }}>
            <Btn variant="ghost" fontSize={15} style={{ color: C.textFaint, padding: '6px 10px 8px' }} onClick={skip}>
              SKIP TUTORIAL
            </Btn>
            <span style={{ flex: 1 }} />
            <Btn variant="gold" fontSize={18} style={{ padding: '7px 22px 10px' }} onClick={advance}>
              {last ? 'OPEN QUESTS' : 'NEXT'}
            </Btn>
          </div>
        </Panel9>
      </div>
    </div>
  );
}
