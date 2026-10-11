/**
 * THE FIRST-RUN CHAIN, client side (owner 2026-08-28: onboarding should be
 * "quest driven"; "instead of displaying cards we should direct player to do
 * things like in professionally built games").
 *
 * This module is the DESTINATION half of that ask. The server owns which step a
 * player is on and how far along it is (QUESTS.onboardingTemplates → quest rows
 * of scope 'onboarding'); all that is left for the client is the one thing a
 * server cannot know: which screen the words "build an Army Camp" mean.
 *
 * IT IS SHARED BY THE TWO SURFACES THAT SHOW THE CHAIN — the quest board
 * (screens/quests.tsx) and the base-screen objective strip (tutorial/
 * OnboardingStrip.tsx) — so a step cannot send the player one way from the board
 * and another way from the strip. Both are lazy chunks; this carries no first-
 * paint cost.
 *
 * NO GAME NUMBERS LIVE HERE. Labels come from QUEST_LABELS (copy.ts), targets
 * and rewards come off the wire. What this file adds is a verb and a route.
 */
import { requestUserCommand, captureBaseSnapshotGuard, isBaseSnapshotGuardCurrent, useApp, type BaseStateDto } from '../state/store';
import { reloadCurrentBaseSnapshot } from '../state/baseSnapshot';
import { api } from '../lib/api';
import { withSelectedBase } from '../lib/baseSelection';
import { bus } from '../lib/events';

/** One step of the chain, exactly as GET /tutorial and GET /quests report it
 *  (apps/api game/quests.ts OnboardingStepDto). */
export interface OnboardingStep {
  questId: string;
  templateCode: string;
  target: number;
  rewardShards: number;
  progress: number;
  completed: boolean;
  claimed: boolean;
}

/**
 * What one tap on a step does.
 *
 * `verb` is the button label, and it is deliberately not always "GO": a player
 * who has never opened the build tray needs to read BUILD, and the one step that
 * costs real money needs to read what it is before they arrive at a payment
 * screen. `hint` is the single line under the label — what the step is FOR,
 * since the retired tutorial cards were where that used to be said.
 */
export interface StepAction {
  verb: string;
  hint: string;
  go: () => void | Promise<void | false>;
  disabled?: boolean;
}

/** The build tray. All three structure steps land in the same place — the tray
 *  is where a building is chosen, and pre-selecting one for the player would
 *  take away the choice the step exists to teach. */
const openBuild = (): void => {
  const app = useApp.getState();
  app.setBuildCategory('bld');
  app.setScreen('build');
};

/**
 * The ENTRY screen, which is the only place that can take a land payment.
 *
 * Copied from screens/menu.tsx `buyLand()` rather than imported: menu.tsx is the
 * whole settings/profile/shop chunk, and pulling it into the onboarding path
 * would drag every one of those screens along behind a new player's first tap.
 */
const buyLand = (): void => {
  const s = useApp.getState();
  s.setLandPrompt(null);
  if (s.entryPaid) {
    bus.emit('onboarding:refresh', undefined);
    return;
  }
  if (!s.landPurchase) s.setLandPurchase({ kind: 'entry', earthCell: null });
  s.setScreen('entry');
};

/** The RAID chooser — campaign or PvP. It is local state inside BaseHud, but the
 * quest board unmounts that HUD. Persist the request across the screen hand-off
 * so React mounting order can never eat it. */
const openRaid = (): void => {
  const app = useApp.getState();
  app.requestRaidChooser();
  app.setScreen('base');
};

const ACTIONS: Readonly<Record<string, StepAction>> = {
  first_camp: {
    verb: 'BUILD',
    hint: 'Camps are the room your army lives in — no camps, no troops to raid with.',
    go: openBuild,
  },
  first_mine: {
    verb: 'BUILD',
    hint: 'Mines make Shards while you are away. Shards pay for everything you build.',
    go: openBuild,
  },
  first_barracks: {
    verb: 'BUILD',
    hint: 'The Barracks trains the troops you send into a raid.',
    go: openBuild,
  },
  first_troops: {
    verb: 'TRAIN',
    hint: 'Select troops, Review Training, then Add to Queue. Your first Finish All is free; remaining troops train in order.',
    go: openTraining,
  },
  first_land: {
    // BUY, not CLAIM. On the quest board a gold CLAIM button means "take your
    // reward"; a grey CLAIM next to it meaning "go and spend SOL" is the one
    // confusion this screen cannot afford, and BUY is the honest word for a step
    // that costs real money (it matches the ENTRY screen's own BUY YOUR LAND).
    verb: 'BUY',
    hint: 'Your own spot on the pixel Earth — it unlocks PvP, KEEP and trading.',
    go: buyLand,
  },
  first_raid: {
    verb: 'RAID',
    hint: 'Take your army out. Start with the Campaign — it teaches the fight and pays.',
    go: openRaid,
  },
};

/** Is this a step of the first-run chain? */
export function isOnboardingStep(templateCode: string): boolean {
  return templateCode in ACTIONS;
}

/** Training completion frees queue room independently of the larger Camp. */
export function trainingQueueBlocked(status: BaseStateDto['armyStatus'] | undefined): boolean {
  return !!status && status.trainingTroopCount > 0
    && (status.trainingPts >= status.barracksQueuePts
      || status.readyPts + status.trainingPts >= status.campCapacityPts);
}

/**
 * The action for a step, or null for a template this build does not know.
 *
 * FAIL-SOFT ON PURPOSE, like every other onboarding lookup: a server that has
 * been given a sixth chain step before this bundle ships must render a readable
 * row with no button, never a crash or a dead tap.
 */
function resolveOnboardingAction(templateCode: string): StepAction | null {
  const fallback = ACTIONS[templateCode];
  if (!fallback) return null;
  const app = useApp.getState();
  const type = BUILD_TYPES[templateCode];
  if (type) {
    const building = app.base?.buildings.find((b) => b.type === type);
    const job = app.base?.jobs.find((j) => j.kind === 'build'
      && app.base?.buildings.some((b) => b.id === j.buildingId && b.type === type));
    if (job) return jobAction(job);
    if (building && !building.underConstruction) return {
      verb: 'CHECK', hint: 'Your building is ready. Check your objective reward.',
      go: () => { bus.emit('onboarding:refresh', undefined); },
    };
    if (app.placing === type) return {
      verb: 'PLACE', hint: 'Pick an empty tile, then confirm PLACE on your base.',
      go: () => {
        const control = document.querySelector<HTMLButtonElement>('[data-tutorial-target="place-building"] button');
        if (control && !control.disabled) control.click();
      },
    };
    if (app.base && app.base.freeBuilders <= 0 && app.base.jobs[0]) {
      const occupying = app.base.jobs.slice().sort((a, b) => a.finishesAt.localeCompare(b.finishesAt))[0]!;
      return {
        verb: 'VIEW', hint: 'Your builder is working. Open that job to finish it or wait.',
        go: () => focusJob(occupying),
      };
    }
  }
  if (templateCode === 'first_land' && app.entryPaid) return {
    verb: 'CHECK', hint: 'Your land is paid. Check your objective reward.',
    go: () => { bus.emit('onboarding:refresh', undefined); },
  };
  const needsTraining = templateCode === 'first_troops' || (templateCode === 'first_raid' && app.base
    && !app.base.army.some((unit) => unit.count > 0)
    && !app.base.heroes?.some((hero) => hero.available));
  if (needsTraining) {
    const status = app.base?.armyStatus;
    if (trainingQueueBlocked(status)) return {
      verb: 'WAIT', hint: `${status!.readyPts}/${status!.campCapacityPts} army points ready. Wait for troop timers, then train the next group.`,
      go: openTraining,
    };
    return ACTIONS.first_troops!;
  }
  return fallback;
}

/** Capture the original action and its inputs together. In particular a job's
 * zero quote must never survive a refreshed snapshot or a changed quote.
 * The confirmed continuation includes focus flags AND the existing completion
 * controller; that controller retains its own transport/completion guards. */
export function onboardingAction(templateCode: string): StepAction | null {
  const action = resolveOnboardingAction(templateCode);
  if (!action) return null;
  const original = useApp.getState();
  const jobs = JSON.stringify(original.base?.jobs);
  return { ...action, go: async () => {
    const handle = requestUserCommand(() => action.go(), () => {
      const current = useApp.getState();
      return current.base === original.base && JSON.stringify(current.base?.jobs) === jobs
        && current.entryPaid === original.entryPaid && current.landPurchase === original.landPurchase
        && current.placing === original.placing;
    });
    return new Promise<void | false>((resolve, reject) => handle.onSettled(result => {
      if (result.status === 'rejected') reject(result.error);
      else resolve(result.status === 'cancelled' ? false : undefined);
    }));
  } };
}

export const BUILD_TYPES: Readonly<Record<string, string>> = {
  first_camp: 'camp', first_mine: 'mine', first_barracks: 'barracks',
};

function focusJob(job: BaseStateDto['jobs'][number]): void {
  const app = useApp.getState();
  if (job.buildingId) app.requestBaseFocus({ kind: 'building', id: job.buildingId });
  else if (job.obstacleId) app.requestBaseFocus({ kind: 'obstacle', id: job.obstacleId });
  app.setScreen('base');
}

function openTraining(): void {
  const app = useApp.getState();
  const barracks = app.base?.buildings.find((b) => b.type === 'barracks' && !b.underConstruction);
  if (!barracks) { openBuild(); return; }
  app.requestBaseFocus({ kind: 'building', id: barracks.id });
  app.requestTraining();
  app.setScreen('base');
}

const finishingJobs = new Set<string>();

// Both objective surfaces share the same server quote and free action. Paid
// jobs open their own HUD, where the existing KEEP confirmation remains.
function jobAction(job: BaseStateDto['jobs'][number]): StepAction {
  const elapsed = Date.parse(job.finishesAt) <= Date.now();
  return {
    verb: elapsed ? 'CHECK' : 'FINISH',
    hint: elapsed ? 'Finishing your building — check its progress.'
      : job.finishCostKeep === '0' ? 'Finish this construction now for free, then claim your reward.'
        : 'Open this building to review its finish cost.',
    go: async () => {
      const guard = captureBaseSnapshotGuard();
      const key = `${guard.wallet}:${guard.selectedBaseId}:${job.id}`;
      // Focusing from the quest board mounts a second objective surface while
      // the request is pending. Both taps must share the same completion.
      if (finishingJobs.has(key)) return;
      finishingJobs.add(key);
      try {
        focusJob(job);
        if (!elapsed && job.finishCostKeep === '0') {
          await api.post(`/base/jobs/${job.id}/speedup`, withSelectedBase({}));
        }
        if (!isBaseSnapshotGuardCurrent(guard)) return;
        await reloadCurrentBaseSnapshot();
        if (!isBaseSnapshotGuardCurrent(guard)) return;
        bus.emit('base:refresh', undefined);
        bus.emit('onboarding:refresh', undefined);
      } finally {
        finishingJobs.delete(key);
      }
    },
  };
}
