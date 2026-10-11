/**
 * WHERE TO TAP NEXT — the guided half of the first-run chain (owner 2026-08-29:
 * "quests should be directing player by guiding to do directive like lockin").
 *
 * THE PROBLEM THIS SOLVES. Before it, the chain INFORMED: the objective strip
 * said "BUILD AN ARMY CAMP" and its button dropped the player into the build
 * tray — on the DEFENSES tab, with the Camp card fifth of seven in a horizontal
 * scroller on the tab next door, and the strip itself buried under the tray at
 * z 1020. From there a new player was on their own for four more taps.
 *
 * THE MODEL: A STEP IS A LIST OF CANDIDATE CUES, RESOLVED AGAINST THE LIVE DOM.
 * Each candidate names a control and the one line that goes with it; the first
 * candidate whose control is actually on screen wins. That single rule buys
 * three properties that a step-machine would each have had to be coded for:
 *
 *  - THE CUE FOLLOWS THE PLAYER. Navigate, and the controls on screen change, so
 *    the winning candidate changes with them. No screen tracking, no state to
 *    get out of sync with where the player really is.
 *  - IT ADVANCES WITHIN A STEP. Deeper candidates are listed first, so opening
 *    the tray moves the cue from the nav tab to the tab bar to the card, and
 *    entering placement moves it to PLACE — because those controls appear.
 *  - IT DEGRADES HONESTLY. Nothing on screen matches (the player is on the world
 *    map mid-raid-step) → no ring, and the caller shows `fallbackText`, which
 *    says what the step wants rather than pointing at nothing.
 *
 * ANCHORS ARE THE TUTORIAL'S OWN (tutorial/anchors.tsx) — aria-label first, a
 * button's exact text where a control has no label, and a `data-` hook only
 * where neither exists and the element is one of many identical siblings. This
 * is not a second highlighting system; it is the same one, given more targets.
 *
 * NO CANDIDATE MATCHES ON A BUTTON'S TEXT WHEN THAT TEXT IS NOT UNIQUE. The
 * obvious cue for a build step was the nav's BUILD tab — but the objective
 * strip's own action button says BUILD too, and findAnchor takes the first match
 * in document order, so the mark would have landed on whichever the tree happened
 * to hold first. `data-onboarding-cta` (the strip's button, and the live row's
 * button on the quest board) is the unambiguous form of the same instruction, and
 * it has the better property besides: the control is beside the words explaining
 * it, and it exists on the quest board too, where the nav is not mounted at all.
 */
import { useEffect, useState } from 'react';
import { useApp } from '../../state/store';
import { BUILD_TYPES, onboardingAction, trainingQueueBlocked } from '../onboardingChain';
import { findAnchor, type AnchorBox, type AnchorSpec } from './anchors';

/** One "tap this, because" pairing. */
interface Candidate {
  spec: AnchorSpec;
  /** The instruction, in the board's voice: an imperative, upper case, short
   *  enough to read at a glance on a 320px phone. */
  text: string;
}

interface StepCues {
  candidates: readonly Candidate[];
  /** Shown with no ring when the player is somewhere none of the controls are. */
  fallbackText: string;
}

/**
 * The three structure steps are the same walk with a different card, so they are
 * generated rather than written out three times — a drifted copy between them is
 * exactly the kind of bug nobody reads carefully enough to catch.
 *
 * `data-build-type` is on the tray card (ui/sheets.tsx). It has to be a data hook:
 * the cards are seven identical buttons whose visible text carries a live owned-
 * count suffix ("MINE ×2"), so neither an exact-text match nor an aria-label that
 * would have to restate the count is stable.
 */
function buildSteps(type: string, label: string): StepCues {
  return {
    candidates: [
      // A placed building does not complete the objective until its server job
      // finishes. This candidate precedes the tray/card controls so guidance
      // never asks for a duplicate while the first one is constructing.
      { spec: { selector: `[data-onboarding-finish="${type}"]` }, text: `TAP FINISH TO COMPLETE YOUR ${label}` },
      { spec: { selector: `[data-onboarding-job~="${type}"]` }, text: `OPEN YOUR ${label} AND TAP FINISH` },
      // Placement mode: the tray is gone and the confirm bar has taken its place.
      { spec: { selector: '[data-tutorial-target="place-building"]' }, text: `PICK A FREE TILE, THEN PLACE YOUR ${label}` },
      { spec: { selector: `[data-build-type="${type}"]` }, text: `TAP THE ${label} CARD` },
      // The tray opens on DEFENSES; all three structures live under BUILDINGS.
      { spec: { selector: '[data-tutorial-target="buildings-tab"]' }, text: 'OPEN THE BUILDINGS TAB' },
      { spec: { selector: '[data-onboarding-cta]' }, text: `TAP BUILD TO RAISE YOUR ${label}` },
    ],
    fallbackText: `GO BACK TO YOUR BASE AND BUILD YOUR ${label}`,
  };
}

const CUES: Readonly<Record<string, StepCues>> = {
  first_camp: buildSteps('camp', 'ARMY CAMP'),
  first_mine: buildSteps('mine', 'MINE'),
  first_barracks: buildSteps('barracks', 'BARRACKS'),
  first_troops: {
    candidates: [
      { spec: { selector: '[data-tutorial-target="training-free-recovery"]' }, text: 'CHECK YOUR ORIGINAL FREE FINISH — IT NEVER SPENDS KEEP' },
      { spec: { selector: '[data-tutorial-target="training-purchase-recovery"]' }, text: 'CHECK YOUR ORIGINAL PURCHASE BEFORE TRAINING AGAIN' },
      { spec: { selector: '[data-tutorial-target="training-add-to-queue"]' }, text: 'REVIEW THE SHARDS COST, THEN TAP ADD TO QUEUE' },
      { spec: { selector: '[data-tutorial-target="training-review-close"]' }, text: 'CLOSE THIS REVIEW TO ADJUST YOUR TROOPS' },
      { spec: { selector: '[data-tutorial-target="training-free-finish"]' }, text: 'TAP FINISH ALL · FREE — NO KEEP NEEDED' },
      { spec: { selector: '[data-tutorial-target="training-review"]' }, text: 'TAP REVIEW TRAINING TO CHECK YOUR QUEUE AND SHARDS COST' },
      // MAX fills the L1 camp in one tap (2026-09-16 stepper). It is disabled
      // once the camp or queue is full, and the card is the fallback then.
      { spec: { selector: '[data-train-max]' }, text: 'TAP MAX ON A TROOP TO FILL YOUR FIRST ARMY' },
      { spec: { selector: '[data-train-troop]' }, text: 'TAP A TROOP TO ADD IT TO YOUR FIRST ARMY' },
      { spec: { selector: '[data-tutorial-target="train-troops"]' }, text: 'OPEN TRAIN TROOPS AT YOUR BARRACKS' },
      { spec: { selector: '[data-onboarding-cta]' }, text: 'TAP TRAIN TO PREPARE YOUR FIRST ARMY' },
    ],
    fallbackText: 'TRAIN YOUR ARMY AT THE BARRACKS — TROOPS ARRIVE WHEN THEIR TIMERS FINISH',
  },
  first_land: {
    // Payment guidance names the actual stage. The player still reviews the
    // SOL quote and gives explicit wallet consent; verification has no ring.
    candidates: [
      { spec: { selector: '[data-tutorial-target="land-enter"]' }, text: 'YOUR LAND IS PAID — ENTER YOUR BASE' },
      { spec: { selector: '[data-tutorial-target="land-globe-confirm"]' }, text: 'CONFIRM THIS LAND TO RETURN TO YOUR RESERVATION' },
      // K-195: the world stage itself. CHOOSE LAND lives in the world panel (land-globe-confirm,
      // one row up), never inside the stage, so a selector for a button inside the stage never
      // matched and this step fell through to the fallback text. A canvas deed is no DOM target:
      // the ring marks the stage (CPU globe or World v2) until a parcel's CHOOSE LAND exists.
      { spec: { selector: '[data-tutorial-target="land-globe-cell"]' }, text: 'CHOOSE AN AVAILABLE PARCEL ON THE GLOBE' },
      { spec: { selector: '[data-tutorial-target="land-funding-retry"]' }, text: 'CHECK WHETHER YOUR DEVNET SOL HAS ARRIVED' },
      { spec: { selector: '[data-devnet-faucet-claim]' }, text: 'GET DEVNET SOL FOR YOUR LAND PAYMENT' },
      { spec: { selector: '[data-tutorial-target="land-funding"]' }, text: 'ADD DEVNET SOL TO YOUR WALLET BEFORE PAYMENT' },
      { spec: { selector: '[data-tutorial-target="land-reserve"]' }, text: 'RESERVE YOUR SELECTED LAND' },
      { spec: { selector: '[data-tutorial-target="land-pay"]' }, text: 'REVIEW THE SOL PRICE, THEN CONFIRM PAYMENT WHEN READY' },
      { spec: { selector: '[data-tutorial-target="land-pick"]' }, text: 'CHOOSE WHERE YOUR LAND WILL BE' },
      { spec: { selector: '[data-onboarding-cta]' }, text: 'TAP BUY TO CLAIM YOUR OWN LAND' },
    ],
    fallbackText: 'CLAIM YOUR LAND ON THIS SCREEN — IT UNLOCKS PVP, KEEP AND TRADING',
  },
  first_raid: {
    candidates: [
      { spec: { selector: '[data-tutorial-target="campaign-attack"]' }, text: 'ATTACK THIS CAMPAIGN STAGE WITH YOUR ARMY' },
      { spec: { selector: '[data-raid-choice="campaign"]' }, text: 'START WITH THE CAMPAIGN' },
      { spec: { selector: '[data-onboarding-cta]' }, text: 'TAP RAID TO TAKE YOUR ARMY OUT' },
    ],
    fallbackText: 'PICK A CAMPAIGN STAGE AND WIN IT',
  },
};

/** The cue for a finished-but-unclaimed step: one control, everywhere it
 *  appears (the objective strip and the quest board carry the same hook). */
const CLAIM_CUE: Candidate = {
  spec: { selector: '[data-onboarding-claim]' },
  text: 'TAP CLAIM TO TAKE YOUR REWARD',
};

/** A finished build can become claimable while the build tray is still open.
 * The claim control lives on the base strip/quest board, underneath that tray;
 * point at the tray's stable close control first instead of showing an
 * unanchored CLAIM instruction behind the panel. */
const RETURN_TO_CLAIM_CUE: Candidate = {
  spec: { selector: '[aria-label="Close build tray"]' },
  text: 'CLOSE BUILD, THEN CLAIM YOUR REWARD',
};

/** What the guide should draw right now: a line to read, a box to ring (null
 *  when the control this step is about is not on this screen), and how high the
 *  control sits so the mark can be drawn over it. */
export interface GuideCue {
  text: string;
  box: AnchorBox | null;
  /**
   * The largest z-index on the control or any of its ancestors — 0 for anything
   * sitting on the page itself.
   *
   * THE MARK'S HEIGHT IS A PROPERTY OF ITS TARGET, not of the screen the player
   * is on, and assuming otherwise cost this lane a capture: the raid chooser is
   * a modal at 1500 that the guided flow OPENS, and a coach mark pinned to the
   * base screen's layer was drawn perfectly, underneath it, where nobody could
   * see it. Reading the target's own layer is the only version of this rule that
   * cannot be wrong — a sheet that changes its z-index tomorrow moves the mark
   * with it.
   */
  layer: number;
}

/** Walk to the top, taking the highest z-index on the way. `auto` and unparsable
 *  values contribute nothing, which is right: they do not raise the element. */
function stackingLayer(el: Element): number {
  let max = 0;
  for (let node: Element | null = el; node && node !== document.body; node = node.parentElement) {
    const z = Number.parseInt(getComputedStyle(node).zIndex, 10);
    if (Number.isFinite(z) && z > max) max = z;
  }
  return max;
}

/** How often the candidate list is re-resolved. Fast enough that opening the
 *  build tray moves the mark before the player's thumb has left the button;
 *  cheap because it is a handful of querySelectors on one live step. */
const RESOLVE_MS = 260;

/** Standoff between the ring and the control it marks — matches anchors.tsx. */
const PAD = 5;

/** Don't nudge the same off-screen control more than this often — the resolver
 *  runs four times a second and the player is allowed to scroll too. */
const SCROLL_COOLDOWN_MS = 1_500;
let lastScrollAt = 0;

/**
 * BRING THE CONTROL INTO VIEW WHEN IT IS NOT.
 *
 * The build tray is a horizontal scroller and its BUILDINGS tab holds seven
 * cards — mine, vault, barracks, forge, camp, clanhall, goldforge. On a 320px
 * phone the Army Camp starts off the right-hand edge, so the shipped flow's
 * answer to "build an Army Camp" was a card the player could not see. A ring
 * around it would have been the same failure with a mark on it.
 *
 * ONLY WHEN IT IS FULLY OUT OF THE VIEWPORT, and no more than once every
 * SCROLL_COOLDOWN_MS: partially visible is visible, and a guide that yanks the
 * tray back every 260ms is fighting the player rather than helping them.
 */
function nudgeIntoView(el: Element, r: DOMRect, now: number, clipped = false): void {
  const offScreen = r.right <= 0 || r.bottom <= 0
    || r.left >= window.innerWidth || r.top >= window.innerHeight;
  if ((!offScreen && !clipped) || now - lastScrollAt < SCROLL_COOLDOWN_MS) return;
  lastScrollAt = now;
  try {
    el.scrollIntoView({ block: 'nearest', inline: 'center' });
  } catch {
    /* fail-soft with everything else here: an old webview without the options
       form must not take the guidance down. */
  }
}

function resolve(templateCode: string, claimable: boolean): GuideCue | null {
  const app = useApp.getState();
  // Players may open BUY from a future quest. Checkout guidance follows the
  // purchase they chose; a completed build's CLAIM is not on this screen.
  if (app.screen === 'entry') {
    templateCode = 'first_land';
    claimable = false;
  }
  const action = onboardingAction(templateCode);
  const training = templateCode === 'first_troops' || action?.verb === 'TRAIN' || action?.verb === 'WAIT';
  const cues = training ? CUES.first_troops : CUES[templateCode];
  // FAIL-SOFT, like every other onboarding lookup: a server that has been given
  // a sixth chain step before this bundle ships gets no guidance, never a crash.
  if (!cues) return null;
  const closeSheet: Candidate = {
    spec: { selector: '[aria-label="Close sheet"]' }, text: 'CLOSE THIS PANEL TO CONTINUE YOUR OBJECTIVE',
  };
  const type = BUILD_TYPES[templateCode];
  // Pending controls are deliberately disabled: read their explicit status,
  // without treating them as hittable anchors or sending the player elsewhere.
  if (!claimable && type && app.placing === type) {
    const pending = document.querySelector('[data-tutorial-target="place-building"][aria-busy="true"]');
    if (pending) return { text: 'PLACING YOUR BUILDING — WAITING FOR CONFIRMATION', box: null, layer: stackingLayer(pending) };
  }
  const job = type ? app.base?.jobs.find((j) => j.kind === 'build'
    && app.base?.buildings.some((b) => b.id === j.buildingId && b.type === type)) : undefined;
  if (!claimable && job && Date.parse(job.finishesAt) <= Date.now()) {
    return { text: 'FINISHING YOUR BUILDING — CHECKING YOUR REWARD', box: null, layer: 0 };
  }
  if (!claimable && training) {
    const pending = document.querySelector('[data-training-confirmation] [aria-busy="true"]');
    if (pending) return { text: 'CHECKING YOUR TRAINING PURCHASE — KEEP THIS REQUEST', box: null, layer: stackingLayer(pending) };
    const dialog = document.querySelector('[data-training-confirmation]');
    if (dialog) {
      // A short landscape dialog scrolls. Its review phase remains current even
      // when the confirmation button is below the visible part of the panel.
      const add = dialog.querySelector<HTMLButtonElement>('[data-tutorial-target="training-add-to-queue"]');
      const selector = `[data-training-confirmation] [data-tutorial-target="${add?.disabled ? 'training-review-close' : 'training-add-to-queue'}"]`;
      const target = findAnchor({ selector });
      const rect = target?.getBoundingClientRect();
      return {
        text: add?.disabled ? 'CLOSE THIS REVIEW TO ADJUST YOUR TROOPS'
          : target ? 'REVIEW THE SHARDS COST, THEN TAP ADD TO QUEUE'
            : 'REVIEW THE SHARDS COST, THEN SCROLL DOWN TO ADD TO QUEUE',
        box: rect ? { left: rect.left - PAD, top: rect.top - PAD, width: rect.width + PAD * 2, height: rect.height + PAD * 2 } : null,
        layer: stackingLayer(dialog),
      };
    }
  }
  if (!claimable && training && trainingQueueBlocked(app.base?.armyStatus)
    && !findAnchor({ selector: '[data-tutorial-target="training-free-finish"], [data-tutorial-target="training-free-recovery"], [data-tutorial-target="training-purchase-recovery"], [data-tutorial-target="training-add-to-queue"], [data-tutorial-target="training-review-close"]' })) {
    const queue = findAnchor({ selector: '[data-training-queue]' });
    return { text: 'YOUR TROOPS ARE TRAINING — THEY ARRIVE WHEN THEIR TIMERS FINISH', box: null,
      layer: queue ? stackingLayer(queue) : 0 };
  }
  if (!claimable && templateCode === 'first_land') {
    const signing = app.screen === 'entry'
      ? document.querySelector('[data-tutorial-pending="signing"], [data-tutorial-pending="wallet-approval"]') : null;
    if (signing) return {
      text: signing.getAttribute('data-tutorial-pending') === 'signing'
        ? 'SIGNING YOUR PAYMENT — PLEASE WAIT' : 'CONFIRM OR CANCEL THE PAYMENT IN YOUR WALLET',
      box: null, layer: stackingLayer(signing),
    };
    const confirming = findAnchor({ selector: '[data-tutorial-target="land-confirming"]' });
    if (confirming) return { text: 'PAYMENT IS VERIFYING — YOUR RESERVATION IS SAVED', box: null, layer: stackingLayer(confirming) };
  }
  const candidates = cues.candidates.filter((candidate) => {
    const selector = candidate.spec.selector ?? '';
    if (!type) return true;
    if (job || action?.verb === 'VIEW' || action?.verb === 'CHECK') {
      return selector.includes('onboarding-finish') || selector.includes('onboarding-job')
        || selector === '[data-onboarding-cta]';
    }
    if (selector.includes('place-building') && app.placing && app.placing !== type) return false;
    return true;
  });
  const list = claimable ? [CLAIM_CUE, RETURN_TO_CLAIM_CUE, closeSheet] : [
    ...candidates, closeSheet,
  ];
  for (const c of list) {
    let el = findAnchor(c.spec);
    if (!el && (c.spec.selector?.startsWith('[data-build-type=')
      || c.spec.selector === '[data-tutorial-target="campaign-attack"]')) {
      const offscreen = findAnchor(c.spec, true);
      if (offscreen) nudgeIntoView(offscreen, offscreen.getBoundingClientRect(), Date.now(), true);
      el = findAnchor(c.spec);
    }
    if (!el) continue;
    const r = el.getBoundingClientRect();
    return {
      text: c.spec.selector === '[data-onboarding-cta]' && action?.verb !== 'BUILD'
        && type ? action?.hint.toUpperCase() ?? c.text : c.text,
      box: { left: r.left - PAD, top: r.top - PAD, width: r.width + PAD * 2, height: r.height + PAD * 2 },
      layer: stackingLayer(el),
    };
  }
  return { text: claimable ? CLAIM_CUE.text : cues.fallbackText, box: null, layer: 0 };
}

/**
 * The live cue for a chain step.
 *
 * One poll does BOTH jobs — pick the candidate and measure it — because the two
 * questions have the same answer source and splitting them would mean two timers
 * disagreeing about which control is on screen for a frame at a time.
 */
export function useGuideCue(templateCode: string, claimable: boolean): GuideCue | null {
  const base = useApp((s) => s.base);
  const placing = useApp((s) => s.placing);
  const screen = useApp((s) => s.screen);
  const [cue, setCue] = useState<GuideCue | null>(() => resolve(templateCode, claimable));
  useEffect(() => {
    const tick = (): void => {
      const next = resolve(templateCode, claimable);
      setCue((prev) => (same(prev, next) ? prev : next));
    };
    tick();
    window.addEventListener('resize', tick);
    const t = setInterval(tick, RESOLVE_MS);
    return () => {
      window.removeEventListener('resize', tick);
      clearInterval(t);
    };
  }, [templateCode, claimable, base, placing, screen]);
  return cue;
}

/** Unchanged cue → same object → no re-render. At a 260ms poll this is the
 *  difference between a still screen and four re-renders a second. */
function same(a: GuideCue | null, b: GuideCue | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.text !== b.text || a.layer !== b.layer) return false;
  if (a.box === null || b.box === null) return a.box === b.box;
  return a.box.left === b.box.left && a.box.top === b.box.top
    && a.box.width === b.box.width && a.box.height === b.box.height;
}

/** Exposed for the test that pins every chain step against the shared template
 *  list — a step with no cues is a step the guide silently abandons. */
export function hasGuideCues(templateCode: string): boolean {
  return templateCode in CUES;
}
