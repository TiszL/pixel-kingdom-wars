/**
 * Eager probe for FIRST-RUN GUIDANCE (M23 a6; quest-driven since 2026-08-28;
 * GUIDED since 2026-08-29). The two things it can mount — the three-card deck
 * and the guided chain (objective strip, coach mark, spotlight, SKIP) — are both
 * LAZY chunks (the ChatLauncher pattern); this probe is all the first-paint graph
 * carries, and it renders nothing at all for the vast majority of sessions
 * (anyone whose server row says the deck is done AND whose onboarding chain is
 * finished, plus anyone who has switched guidance off).
 *
 * ONE PROBE, TWO ANSWERS. GET /tutorial returns the card-deck step alongside
 * `onboarding` — the first chain step this player has not claimed, or null when
 * the chain is done (apps/api game/quests.ts getOnboardingStep). A second request
 * for the chain would be a new GET on the hottest path in the client, so the
 * server folds it into the probe that was already being made.
 *
 * SERVER-AUTHORITATIVE: progress comes from that probe and every change is the
 * server's answer to an advance/skip/reset or a quest claim — this component
 * never invents a step (CLAUDE.md hard rule: state is the server's). The settings
 * screen's REPLAY chip resets server-side and republishes the response on the bus
 * ('tutorial:state'), which re-arms this host without a refetch.
 *
 * THE DECK COMES FIRST. While the cards are still running the strip stays hidden:
 * two instruction surfaces at once is exactly the card-stacking this lane was
 * asked to remove.
 *
 * FAIL-SOFT BY DESIGN: a rolling old API without the route, a network hiccup,
 * or a 4xx never blocks the game; transient failures retry within the current session. This is
 * guidance, never a gate.
 */
import { TUTORIAL_STEPS } from '@shardkeep/shared';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api } from '../../lib/api';
import { selectedBasePath } from '../../lib/baseSelection';
import { bus } from '../../lib/events';
import { captureBaseSnapshotGuard, isBaseSnapshotGuardCurrent, useApp } from '../../state/store';
import type { OnboardingStep } from '../onboardingChain';

const TutorialOverlay = lazy(() => import('./TutorialOverlay'));
const OnboardingGuide = lazy(() => import('./OnboardingGuide'));

export interface TutorialStateDto {
  step: number;
  completedAt: string | null;
  /** The live chain step, or null once every step is claimed. Optional so a
   *  server that predates the chain simply shows no strip. */
  onboarding?: OnboardingStep | null;
  /**
   * The player switched the GUIDED flow off (owner 2026-08-29). Server-stored,
   * so it survives a reload; reversible from settings. Optional so a server that
   * predates the switch reads as "still guided", which is the correct default.
   *
   * IT DOES NOT TOUCH THE QUESTS. `onboarding` keeps arriving and the chain
   * keeps ticking and paying on the board — only the hand-holding stops.
   */
  guideSkipped?: boolean;
}

export function TutorialHost(): React.JSX.Element | null {
  const authed = useApp((s) => s.authed);
  const wallet = useApp((s) => s.wallet);
  const screen = useApp((s) => s.screen);
  const playtestWelcomeOpen = useApp((s) => s.playtestWelcomeOpen);
  const selectedBaseId = useApp((s) => s.selectedBaseId);
  const selectionEpoch = useApp((s) => s.baseSelectionEpoch);
  // Keep the final deck card alive across the real QUESTS-rail tap so its
  // advance request can complete after the board opens.
  const inBase = screen === 'base' || screen === 'build';
  const [state, setState] = useState<TutorialStateDto | null>(null);
  const probed = useRef(false);
  const stateGuard = useRef<ReturnType<typeof captureBaseSnapshotGuard> | null>(null);
  const [guideGeneration, setGuideGeneration] = useState(0);
  const sequence = useRef(0);
  const retry = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearRetry = useCallback((): void => {
    if (retry.current !== null) clearTimeout(retry.current);
    retry.current = null;
  }, []);

  const probe = useCallback((): void => {
    if (!useApp.getState().authed) return;
    clearRetry();
    const guard = captureBaseSnapshotGuard();
    const request = ++sequence.current;
    void api.get<TutorialStateDto>(selectedBasePath('/tutorial'))
      .then((next) => {
        if (request !== sequence.current || !isBaseSnapshotGuardCurrent(guard)) return;
        probed.current = true;
        stateGuard.current = guard;
        setState(next);
      })
      .catch((error: unknown) => {
        if (request !== sequence.current || !isBaseSnapshotGuardCurrent(guard)) return;
        // Auth/refusal/old-server errors need a real state change, not a loop.
        // Transport and server failures retry while the current scope survives.
        if (!(error instanceof ApiError) || error.status >= 500) {
          retry.current = setTimeout(probe, 3_000);
        }
      });
  }, [clearRetry]);

  useEffect(() => {
    ++sequence.current;
    clearRetry();
    probed.current = false;
    stateGuard.current = null;
    setState(null);
    useApp.getState().setOnboardingStepCode(null);
    return () => { ++sequence.current; clearRetry(); };
  }, [authed, wallet, selectedBaseId, selectionEpoch, clearRetry]);

  useEffect(() => {
    if (authed && inBase && !probed.current) probe();
  }, [authed, wallet, selectedBaseId, selectionEpoch, inBase, probe]);

  const scope = captureBaseSnapshotGuard();
  const adopt = (next: TutorialStateDto): void => {
    if (!useApp.getState().authed || !isBaseSnapshotGuardCurrent(scope)) return;
    ++sequence.current;
    clearRetry();
    probed.current = true;
    stateGuard.current = captureBaseSnapshotGuard();
    setState((prev) => prev ? { ...prev, ...next } : next);
  };

  const hasProbeState = state !== null;
  useEffect(() => bus.on('tutorial:state', (next) => {
    if (!useApp.getState().authed) return;
    setGuideGeneration((generation) => generation + 1);
    ++sequence.current;
    clearRetry();
    probed.current = true;
    stateGuard.current = captureBaseSnapshotGuard();
    setState((prev) => prev ? { ...prev, ...next } : next);
    if (!hasProbeState) probe();
  }), [clearRetry, hasProbeState, probe]);

  const chainLive = !!state?.onboarding;
  useEffect(() => {
    if (!authed || (!chainLive && probed.current)) return;
    const off = [bus.on('base:refresh', probe), bus.on('onboarding:refresh', probe)];
    const recover = (): void => {
      if (!probed.current && document.visibilityState !== 'hidden') probe();
    };
    window.addEventListener('online', recover);
    window.addEventListener('focus', recover);
    return () => {
      off.forEach((unsubscribe) => unsubscribe());
      window.removeEventListener('online', recover);
      window.removeEventListener('focus', recover);
    };
  }, [authed, chainLive, state, probe]);

  useEffect(() => {
    useApp.getState().setOnboardingStepCode(state?.onboarding?.templateCode ?? null);
  }, [state?.onboarding?.templateCode]);

  // The playtest welcome is the first-run instruction while it is open. Keep
  // the server probe warm, then reveal the tutorial after that dialog closes.
  if (playtestWelcomeOpen || !authed || !state || !stateGuard.current || !isBaseSnapshotGuardCurrent(stateGuard.current)) return null;
  const deckRunning = state.completedAt === null;
  if (deckRunning) {
    // The three cards stay a BASE-SCREEN surface: they describe the base, and
    // they are what the camera step is about.
    if (!inBase && !(screen === 'quests' && TUTORIAL_STEPS.ids[state.step] === 'quests')) return null;
    return (
      <Suspense fallback={null}>
        <TutorialOverlay key={`${wallet}:${selectedBaseId}:${selectionEpoch}`} step={state.step} onState={adopt} />
      </Suspense>
    );
  }
  // A SKIPPER KEEPS THE QUESTS, LOSES THE HAND. `state.onboarding` still arrives
  // and the chain still ticks and pays on the board (screens/quests.tsx); what
  // stops is this — the strip, the ring and the spotlight.
  if (!state.onboarding || state.guideSkipped) return null;
  return (
    <Suspense fallback={null}>
      <OnboardingGuide key={`${wallet}:${selectedBaseId}:${selectionEpoch}:${state.guideSkipped}:${guideGeneration}`} step={state.onboarding} onDone={probe} onState={adopt} />
    </Suspense>
  );
}
