/**
 * THE GUIDED FIRST RUN — the lazy chunk that turns the chain from a to-do list
 * into a hand on the shoulder (owner 2026-08-29: "quests should be directing
 * player by guiding to do directive like lockin but they should be able to skip
 * tutorial if they dont want to").
 *
 * IT OWNS THREE THINGS AND DELEGATES THE REST:
 *  1. the ring on the control the step is about, and the spotlight that dims
 *     everything else (tutorial/anchors.tsx — the tutorial's own coach mark, not
 *     a second highlighting system);
 *  2. the one-line instruction, carried by the objective strip while the marked
 *     control is on the page with it and by a compact caption bubble otherwise —
 *     never both, because two instruction surfaces at once is the noise the card
 *     deck was cut for;
 *  3. SKIP, which is present on whichever of those two is on screen, so the exit
 *     is reachable from every step and every screen.
 * WHICH control and WHICH line is guideCues.ts's job.
 *
 * LOCK-IN IS FOCUS, NOT A CAGE. The spotlight is four pointer-events:none panes;
 * the ring takes no taps; nothing here disables, hides or intercepts a single
 * control. A player who ignores the mark can play the whole game around it, and
 * a player who wants out taps SKIP.
 *
 * IT CLIMBS TO ITS TARGET, which is the opposite of the card deck's rule and
 * deliberate: the deck only DESCRIBED the game, so a dialog covering it was
 * correct, while this points AT controls that live inside the build tray (1100)
 * and the raid chooser (1500) — both of which the flow itself opens. It stays
 * small and it never covers the control it is marking. See layersFor() and the
 * note on the bubble's placement: both are a capture's findings written down.
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../../lib/api';
import { EVENTS, track } from '../../lib/analytics';
import { useApp } from '../../state/store';
import { COLORS as C } from '../primitives';
import { hudStripStyle } from '../hudChrome';
import { tutorialSurfaceInsets, useWindowSize } from '../layout';
import { AnchorRing, Spotlight, type AnchorBox } from './anchors';
import { useGuideCue } from './guideCues';
import { OnboardingStrip, SkipBtn } from './OnboardingStrip';
import type { OnboardingStep } from '../onboardingChain';
import type { TutorialStateDto } from './TutorialHost';

/**
 * THE OBJECTIVE STRIP'S LAYER. The mark has to clear it (the strip carries the
 * button the base-screen cue points at) and the dim has to stay under it (or it
 * greys out the very words it is focusing attention on), so the two are computed
 * from it rather than sharing one constant — a single z-index asked to do both
 * jobs lost, and the first capture of this flow showed a working spotlight with
 * no ring anywhere on screen.
 */
const STRIP_Z = 1020;
/** The dim, whenever the target is on the page itself rather than in a raised
 *  panel: over the HUD chrome (1000), under the strip. */
const BASE_DIM_Z = 1010;

/** How the ring and the dim are stacked for a target sitting at `layer`.
 *
 * The mark clears the target's own layer, so a card in the build tray (1100) and
 * a row in the raid chooser (1500) are both marked ON TOP of the thing they are
 * in. The dim goes just under the mark — except for a target on the page itself,
 * where it drops below the strip so the instruction stays lit. */
function layersFor(layer: number): { dim: number; mark: number } {
  const mark = Math.max(STRIP_Z + 10, layer + 10);
  return { mark, dim: layer <= STRIP_Z ? BASE_DIM_Z : mark - 1 };
}

/** Screens the guidance follows the player onto.
 *
 * NOT AN ALLOW-LIST OF CONVENIENCE: 'battle' is absent because the raid IS the
 * step, and a caption bubble over a live fight is chrome on the one screen that
 * is nothing but game. 'entry' is present because CLAIM YOUR LAND is finished
 * there and the player arrives with no idea which of that screen's blocks is
 * theirs. Everywhere else the guide simply finds no anchor and says nothing. */
const GUIDED_SCREENS: ReadonlySet<string> = new Set(['base', 'build', 'quests', 'entry', 'map']);

/**
 * The caption bubble: the instruction, and the way out.
 *
 * IT GOES TO THE OPPOSITE END OF THE SCREEN FROM THE RING, not merely the
 * opposite side of it. Floating the words just above the mark seemed tidier and
 * was wrong on the screen that matters most: the build tray is a bottom panel
 * ~200px tall, so a bubble tucked 12px over its Camp card sat squarely on the
 * tray's own header and hid the DEFENSES / BUILDINGS / HEROES tabs and the ✕ that
 * closes it — guidance covering the controls it is meant to be teaching. Pinning
 * to the far end clears any panel the target lives in, whatever its height, and
 * it puts the instruction in the same place every time instead of somewhere new
 * for every step.
 *
 * With no ring at all it parks at the bottom, which is where a player who has
 * wandered off the step will be looking for their objective anyway.
 */
function GuideBubble({ text, box, zIndex, onSkip, inline = false }: {
  text: string; box: AnchorBox | null; zIndex: number; onSkip: () => void; inline?: boolean;
}): React.JSX.Element {
  const viewport = useWindowSize();
  const insets = tutorialSurfaceInsets(viewport.w, viewport.h);
  const vh = viewport.h;
  const sides = {
    left: `calc(${insets.left}px + env(safe-area-inset-left))`,
    right: `calc(${insets.right}px + env(safe-area-inset-right))`,
  };
  // Clear of the measured HUD/queue at the top and the final navigation/task
  // geometry at the foot.
  const atTop = { ...sides, top: `calc(${insets.top}px + env(safe-area-inset-top))` };
  const atBottom = {
    ...sides,
    bottom: `calc(${insets.bottom}px + env(safe-area-inset-bottom))`,
  };
  const position: React.CSSProperties = box !== null && box.top + box.height / 2 > vh / 2
    ? atTop
    : atBottom;
  return (
    <div data-onboarding-bubble style={{
      ...(inline ? { position: 'relative', marginBottom: 10 } : { position: 'fixed', zIndex, ...position }),
      display: 'flex', justifyContent: 'center', pointerEvents: 'none',
    }}>
      <div className="interactive" style={{
        ...hudStripStyle(), pointerEvents: 'auto',
        display: 'flex', alignItems: 'center', gap: 10, padding: '7px 8px 7px 12px',
        maxWidth: 420, width: '100%',
      }}>
        <span style={{ flex: 1, minWidth: 0, color: C.goldHi, fontSize: 16, lineHeight: 1.2, overflowWrap: 'anywhere' }}>
          {text}
        </span>
        <SkipBtn onSkip={onSkip} />
      </div>
    </div>
  );
}

export default function OnboardingGuide({ step, onDone, onState }: {
  step: OnboardingStep;
  /** Re-read the chain — the step was claimed, so the next one is live. */
  onDone: () => void;
  /** Adopt the server's answer to a skip, exactly like the card deck does. */
  onState: (s: TutorialStateDto) => void;
}): React.JSX.Element | null {
  const screen = useApp((s) => s.screen);
  const mapTab = useApp((s) => s.mapTab);
  const selectedBuildingId = useApp((s) => s.selectedBuildingId);
  const selectedObstacleId = useApp((s) => s.selectedObstacleId);
  const placing = useApp((s) => s.placing);
  const busy = useRef(false);
  const [gone, setGone] = useState(false);
  const slotName = screen === 'entry' ? 'entry'
    : screen === 'map' && mapTab === 'campaign' ? 'campaign'
      : step.templateCode === 'first_troops' ? 'training' : null;
  const [captionSlot, setCaptionSlot] = useState<Element | null>(null);
  useEffect(() => {
    if (!slotName) { setCaptionSlot(null); return; }
    const findSlot = (): void => {
      const selector = `[data-onboarding-caption-slot="${slotName}"]`;
      // The confirmation is a body portal above the Barracks sheet. Keep its
      // instruction and Skip inside that dialog while it owns interaction.
      setCaptionSlot((slotName === 'training'
        ? document.querySelector(`[data-training-confirmation] ${selector}`) : null)
        ?? document.querySelector(selector));
    };
    findSlot();
    // These lazy screens can mount after the guide. Wait for their layout slot
    // instead of placing a temporary caption over a payment or attack button.
    const observer = new MutationObserver(findSlot);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [slotName]);
  // The claim state changes which control the player is being sent to, so it is
  // part of the cue, not a decoration on it.
  const cue = useGuideCue(step.templateCode, step.completed);

  /**
   * SKIP: one request, server-stored, so it survives a reload — the requirement
   * is that a player who opts out stays opted out, not that this session goes
   * quiet. `gone` hides the guidance on the spot rather than waiting for the
   * round trip; the server's answer arrives through onState and makes it stick.
   *
   * A FAILED SKIP STILL HIDES. The alternative is a player who tapped the exit
   * twice and is still being pointed at things because their network blinked,
   * and this is guidance — there is nothing to protect by refusing.
   */
  const skip = (): void => {
    if (busy.current) return;
    busy.current = true;
    setGone(true);
    track(EVENTS.TUTORIAL_GUIDE_SKIPPED, { step: step.templateCode });
    void api.postRaw<TutorialStateDto>('/tutorial/guide/skip', {})
      .then(onState)
      .catch(() => undefined)
      .finally(() => { busy.current = false; });
  };

  if (gone || !GUIDED_SCREENS.has(screen)) return null;
  const inlineSlot = captionSlot?.isConnected
    && captionSlot.getAttribute('data-onboarding-caption-slot') === slotName ? captionSlot : null;
  if (slotName && slotName !== 'training' && !inlineSlot) return null;
  const z = layersFor(cue?.layer ?? 0);
  /**
   * WHICH SURFACE SAYS THE LINE — and it is decided by the TARGET, not by the
   * screen name.
   *
   * The strip is the base screen's own objective bar, so it carries the cue
   * there. But it is a base-screen surface at z 1020, which means it is
   * underneath the build tray (1100) and behind the raid chooser (1500) — both
   * of which this flow OPENS. Deciding on `screen === 'base'` alone put the
   * instruction where the player could not read it in exactly those two places,
   * which are the two the guidance is most insistent in. So the strip speaks
   * only while the control being marked is on the page with it.
   */
  const stripSpeaks = !inlineSlot && screen === 'base' && !selectedBuildingId && !selectedObstacleId
    && !placing && (cue?.layer ?? 0) <= STRIP_Z;
  return (
    <>
      {cue?.box && (
        <>
          {!inlineSlot && <Spotlight box={cue.box} zIndex={z.dim} />}
          <AnchorRing box={cue.box} zIndex={z.mark} />
        </>
      )}
      {stripSpeaks
        ? <OnboardingStrip step={step} cue={cue?.text ?? null} onDone={onDone} onSkip={skip} />
        : cue && (inlineSlot
          ? createPortal(<GuideBubble text={cue.text} box={cue.box} zIndex={z.mark} onSkip={skip} inline />, inlineSlot)
          : <GuideBubble text={cue.text} box={cue.box} zIndex={z.mark} onSkip={skip} />)}
    </>
  );
}
