/**
 * THE OBJECTIVE STRIP — one forged bar at the bottom of the base screen saying
 * what to do next, and a button that takes the player there.
 *
 * This is the surface that replaced the tutorial's card deck (owner 2026-08-28:
 * onboarding "needs more interactive approach, instead of displaying cards we
 * should direct player to do things like in professionally built games"). A card
 * says a paragraph and waits to be dismissed; this says one line, is never
 * dismissed, and is still there when the player comes back tomorrow half way
 * through building a Barracks.
 *
 * IT INVENTS NO PROGRESS. Everything it shows is the server's answer to GET
 * /tutorial — `onboarding` is the first chain step the player has not claimed
 * (apps/api game/quests.ts getOnboardingStep), tracked in the same quest_progress
 * rows the quest board reads. This component's only local decisions are which
 * screen the step's verb means (ui/onboardingChain.ts) and when to re-ask.
 *
 * WHY IT RE-ASKS ON 'base:refresh': the step completes on the SERVER, when a
 * builder job finishes or a raid settles, with no response the client can read it
 * from. 'base:refresh' is the game's existing "something about your base changed"
 * signal and fires after exactly those events; a claim on the quest board fires
 * 'onboarding:refresh' directly. Both are cheap — one narrow GET, and only while
 * a chain step is still live.
 *
 * IT SITS UNDER THE CARD. While the three-card deck is still running it does not
 * render at all: two instruction surfaces at once is the noise this lane exists
 * to remove.
 *
 * SINCE 2026-08-29 IT IS THE BASE SCREEN'S HALF OF A GUIDED FLOW, not a lone bar
 * (owner: quests "should be directing player by guiding to do directive like
 * lockin"). OnboardingGuide.tsx mounts it, hands it the live cue — the one line
 * naming the control the coach mark is ringing right now — and hands it SKIP.
 * Off the base screen the guide's own caption bubble takes both jobs, because
 * this bar is a z-1020 base-screen surface and the flow leads the player into
 * the build tray (1100) and the raid chooser (1500), where it cannot be seen.
 */
import { useRef, useState } from 'react';
import { ECONOMY } from '@shardkeep/shared';
import { useSolBalance } from '../useSolBalance';
import { captureBaseSnapshotGuard, isBaseSnapshotGuardCurrent, useApp } from '../../state/store';
import { api } from '../../lib/api';
import { playSfx } from '../../lib/audio';
import { bus } from '../../lib/events';
import { haptic } from '../../lib/juice';
import { failToast } from '../actionError';
import { QUEST_LABELS } from '../copy';
import { HUD_FIELD, hudChipStyle, hudStripStyle } from '../hudChrome';
import { tutorialSurfaceInsets, useWindowSize } from '../layout';
import { onboardingAction, type OnboardingStep } from '../onboardingChain';
import { withSelectedBase } from '../../lib/baseSelection';
import { reloadBase } from '../sheets';
import { Btn, COLORS as C, Icon } from '../primitives';

export function OnboardingStrip({ step, cue, onDone, onSkip }: {
  step: OnboardingStep;
  /**
   * The guided flow's instruction for right now ("TAP BUILD TO RAISE YOUR ARMY
   * CAMP") — the strip is the base screen's instruction surface, so it says the
   * line rather than letting a second bubble stack on top of it. Null when the
   * step has no cue this build knows (tutorial/guideCues.ts is fail-soft).
   */
  cue: string | null;
  /** Re-read the chain — the step was claimed, so the next one is live. */
  onDone: () => void;
  /** End the guided flow. Present on every step, on purpose. */
  onSkip: () => void;
}): React.JSX.Element | null {
  const viewport = useWindowSize();
  const insets = tutorialSurfaceInsets(viewport.w, viewport.h);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  useApp((s) => s.base);
  useApp((s) => s.placing);
  const entryPaid = useApp((s) => s.entryPaid);
  const action = onboardingAction(step.templateCode);
  const label = QUEST_LABELS[step.templateCode] ?? step.templateCode.toUpperCase();
  const claimable = step.completed;
  // 320px minus the task rail and panel chrome cannot hold icon + copy + reward
  // + a 76px action on one line. Letting flexbox squeeze the copy produced
  // one-character columns in the real 320×568 matrix. The narrow form keeps the
  // facts together on row one and gives the action an honest full-width row.
  const stackAction = viewport.w < 420;

  // A step whose code this bundle does not know still renders — the label and
  // the reward are on the wire — but it must not offer a button that goes
  // nowhere. Same fail-soft rule the coach-mark anchor lookup follows.
  const claim = (): void => {
    if (pending.current) return;
    pending.current = true;
    const guard = captureBaseSnapshotGuard();
    setBusy(true);
    void api.post(`/quests/${step.questId}/claim`, withSelectedBase({}))
      .then(() => {
        if (!isBaseSnapshotGuardCurrent(guard)) return;
        playSfx('sfx_quest_done'); haptic('light');
        bus.emit('ui:toast', { msg: step.templateCode === 'first_raid'
          ? 'FIRST STEPS COMPLETE — EXPLORE THE CAMPAIGN AND DAILY QUESTS' : 'OBJECTIVE COMPLETE' });
        onDone();
        return reloadBase();
      })
      .catch((e: Error) => failToast(e, e.message))
      .finally(() => { pending.current = false; setBusy(false); });
  };

  const act = (): void => {
    if (!action || pending.current) return;
    pending.current = true;
    setBusy(true);
    void Promise.resolve().then(action.go)
      .catch((e: Error) => failToast(e, e.message))
      .finally(() => { pending.current = false; setBusy(false); });
  };

  return (
    <div data-onboarding-strip style={{
      position: 'absolute',
      left: `calc(${insets.left}px + env(safe-area-inset-left))`,
      right: `calc(${insets.right}px + env(safe-area-inset-right))`,
      bottom: `calc(${insets.bottom}px + env(safe-area-inset-bottom))`,
      // Under sheets (1050+) and modals (1500), like the coach-mark card: an open
      // dialog always covers guidance.
      zIndex: 1020,
      pointerEvents: 'auto',
    }}>
      {/* SKIP GETS ITS OWN LINE, and that is a measurement, not a preference.
          At 320px the strip's row is already down to ~85px of label between the
          icon, the reward well and the action button; a fifth item in it would
          have left the objective unreadable. Right-aligned above the bar, it is
          attached to the guidance it ends and it costs the strip no width. */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', maxWidth: 520, margin: '0 auto 4px' }}>
        <SkipBtn onSkip={onSkip} />
      </div>
      <div style={{
        ...hudStripStyle(), display: 'flex', alignItems: 'center', gap: 10,
        flexWrap: stackAction ? 'wrap' : 'nowrap',
        padding: '8px 10px', maxWidth: 520, margin: '0 auto',
      }}>
        <span aria-hidden="true" style={{
          ...hudChipStyle('shard'), width: 38, height: 38, display: 'grid', placeItems: 'center', flex: 'none',
        }}>
          <Icon name={claimable ? 'star' : 'quest'} size={20} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* ONE WORD, and nowrap. At 320px the label column is about 85px wide
              once the icon, the reward well and the button have taken theirs, so
              "YOUR OBJECTIVE" wrapped to two lines and pushed the strip taller
              than the quest label underneath it — the eyebrow shouting over the
              thing it introduces. Measured at 320×568 before and after. */}
          <div style={{
            color: C.textFaint, fontSize: 13, letterSpacing: '1px', whiteSpace: 'nowrap',
          }}>
            {claimable ? 'COMPLETE' : 'OBJECTIVE'}
          </div>
          <div style={{ color: C.text, fontSize: 17, lineHeight: 1.15, overflowWrap: 'anywhere' }}>
            {label}
          </div>
          {/* THE DIRECTIVE. The label says what the objective IS; this says what
              to do about it right now, and it changes as the player moves — the
              ring on screen is marking whatever control this line names. */}
          {cue !== null && (
            <div style={{
              color: C.goldHi, fontSize: 13, lineHeight: 1.2, marginTop: 2, overflowWrap: 'anywhere',
            }}>
              {cue}
            </div>
          )}
          {step.templateCode === 'first_land' && !claimable && !entryPaid && <LandFundingCue />}
          {/* Counted steps would show a track; the chain is single-shot today, so
              this only fires if a future step carries a real target. */}
          {step.target > 1 && (
            <span style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 3 }}>
              <span style={{
                flex: 1, minWidth: 0, height: 6, background: HUD_FIELD, border: `1px solid ${C.ink}`,
              }}>
                <span style={{
                  display: 'block', height: '100%', background: C.gold,
                  width: `${Math.min(100, Math.round((step.progress / step.target) * 100))}%`,
                }} />
              </span>
              {/* One text node — see the same note in screens/quests.tsx. */}
              <span style={{ color: C.textFaint, fontSize: 13 }}>{`${step.progress}/${step.target}`}</span>
            </span>
          )}
        </div>
        <span style={{
          ...hudChipStyle('shard'), display: 'inline-flex', alignItems: 'center', gap: 4,
          padding: '3px 7px', color: C.goldHi, fontSize: 15, flex: 'none',
        }}>
          <Icon name="shard" size={13} />{`+${step.rewardShards}`}
        </span>
        {/* THE COACH-MARK ANCHORS, on a wrapper rather than the button: Btn is a
            shared primitive that forwards no data-* props, and an aria-label
            would have to overwrite the accessible name (CLAIM / BUILD / RAID)
            that is the whole point of the control. The quest board's live row
            wears the same two hooks, so the ring follows whichever surface is on
            screen — see tutorial/guideCues.ts. */}
        {claimable ? (
          <span data-onboarding-claim="1" style={{
            display: 'inline-flex', flex: stackAction ? '1 0 100%' : 'none',
          }}>
            <Btn fontSize={16} disabled={busy}
              style={{
                minHeight: 44, minWidth: 76, padding: '6px 12px 8px',
                ...(stackAction ? { width: '100%' } : {}),
              }}
              onClick={claim}>
              CLAIM
            </Btn>
          </span>
        ) : action ? (
          <span data-onboarding-cta="1" style={{
            display: 'inline-flex', flex: stackAction ? '1 0 100%' : 'none',
          }}>
            <Btn fontSize={16} disabled={busy || !!action.disabled}
              style={{
                minHeight: 44, minWidth: 76, padding: '6px 12px 8px',
                ...(stackAction ? { width: '100%' } : {}),
              }}
              onClick={act}>
              {action.verb}
            </Btn>
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** The base objective keeps the actual price and live wallet funding visible;
 * this read-only poll never requests a faucet grant or starts a payment. */
function LandFundingCue(): React.JSX.Element {
  const wallet = useApp((s) => s.wallet);
  const sol = useSolBalance(wallet, 10_000);
  return (
    <div data-onboarding-funding style={{ color: C.textDim, fontSize: 13, lineHeight: 1.25, marginTop: 4 }}>
      <div>{`PRICE ${ECONOMY.entryFeeSol} SOL + NETWORK FEE`}</div>
      <div>{sol === null ? 'CHECKING WALLET SOL…' : `WALLET ${sol.toFixed(4)} SOL`}</div>
      {sol !== null && sol < ECONOMY.entryFeeSol && <div style={{ color: C.goldHi }}>ADD SOL TO CONTINUE</div>}
    </div>
  );
}

/**
 * THE WAY OUT (owner 2026-08-29: players "should be able to skip tutorial if
 * they dont want to" — a correctness rule, not a nicety).
 *
 * It lives HERE rather than in OnboardingGuide because the guide imports this
 * module: one direction of import, no cycle. Both instruction surfaces render
 * it, so the exit is on screen at every step and on every guided screen.
 *
 * GHOST WEIGHT, FULL SIZE. It must not compete with the gold instruction beside
 * it, and it must still be a 44px target — a skip nobody can hit is the same bug
 * as a skip nobody can find.
 */
export function SkipBtn({ onSkip }: { onSkip: () => void }): React.JSX.Element {
  return (
    <Btn variant="ghost" fontSize={14}
      style={{ minHeight: 44, minWidth: 74, padding: '6px 10px 8px', color: C.textFaint, flex: 'none' }}
      onClick={onSkip}>
      SKIP
    </Btn>
  );
}
