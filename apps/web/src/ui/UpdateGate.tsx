/**
 * The update engine's face.
 *
 * The game ships as a PWA behind a TWA, so a fix reaches players the moment we
 * deploy web assets — no store review. The cost of that speed is that a phone can
 * sit on a cached bundle for days. This watches for that and reacts in one of two
 * ways, which are NOT the same severity:
 *
 *   forced — our simulator disagrees with the server's. The client renders the
 *            battle; the server scores it. Disagreement means the player watches
 *            a fight that did not happen and is awarded the result of one they
 *            never saw. Unskippable: there is no version of "later" that is safe.
 *
 *   soft   — new build, same simulator. A one-line nudge they can dismiss. It is
 *            deliberately not a modal: interrupting someone mid-raid to tell them
 *            about a UI tweak is how players learn to ignore update prompts, and
 *            then they ignore the forced one too.
 *
 *   artwork — the server's ground revision is newer than this bundle draws, so
 *            the scene is painting OLD ground (the owner's "old realms" after the
 *            2026-09-26 flip). Unskippable, but raiding stays open (the simulator
 *            agrees) and it waits for the base screen: never over a battle or scout.
 *
 * Two independent triggers, on purpose. The poll notices a deploy while the
 * player is idle on the base screen; the 426 from the API catches the case where
 * they act before the next poll comes round. Either one is enough.
 */
import { useEffect, useState } from 'react';
import { setMaintenanceHandler, setOutdatedHandler } from '../lib/api';
import { bus } from '../lib/events';
import { mutationGate } from '../lib/mutationGate';
import {
  BUILD, UPDATE_POLL_MS, compareVersions, fetchDeployedWeb, fetchServerVersion,
  reloadToLatest, type UpdateState,
} from '../lib/version';
import { useApp } from '../state/store';
import { Btn, COLORS as C, ModalWrap } from './primitives';

/** Fast watch cadence while the deploy drain window is up (M23 a18): the
 *  window is minutes, so the two-minute update poll would overshoot it. */
const MAINTENANCE_WATCH_MS = 10_000;

export function UpdateGate(): React.JSX.Element | null {
  const [state, setState] = useState<UpdateState>({ kind: 'current' });
  const [dismissed, setDismissed] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [maintenance, setMaintenance] = useState<'waiting' | 'ready' | null>(null);
  const screen = useApp((s) => s.screen);

  useEffect(() => {
    const ac = new AbortController();
    let timer: ReturnType<typeof setTimeout>;

    const poll = async (): Promise<void> => {
      // Two independent questions per poll: the API for the replay protocol
      // (forced), the origin's version.json for the deployed bundle (soft).
      const [server, web] = await Promise.all([
        fetchServerVersion(ac.signal), fetchDeployedWeb(ac.signal),
      ]);
      const next = compareVersions(server, web);
      if (!ac.signal.aborted) {
        if (next.kind === 'forced') mutationGate.close();
        // Never downgrade a forced state back to current on a later poll: once we
        // know the simulator disagrees, a flaky /version answer must not quietly
        // unlock raiding again. Old ground likewise stays old until a reload; only
        // a forced answer outranks it.
        setState((prev) => (prev.kind === 'forced' || (prev.kind === 'artwork' && next.kind !== 'forced') ? prev : next));
        timer = setTimeout(() => void poll(), UPDATE_POLL_MS);
      }
    };
    void poll();

    // The API said 426 on a raid attempt. We may not know the server's version
    // yet, so synthesise the forced state from what we do know: ours is wrong.
    setOutdatedHandler(() => {
      mutationGate.close();
      setState((prev) => (prev.kind === 'forced' ? prev : {
        kind: 'forced',
        server: { version: 'newer', gitSha: 'unknown', builtAt: null, simVersion: -1 },
      }));
    });

    // A coded 503 from the drain-window Caddy page (M23 a18): hold instead of
    // failing actions. Recovery offers a reload; it must never interrupt a
    // battle or a wallet callback that is still saving its payment receipt.
    setMaintenanceHandler(() => {
      mutationGate.close();
      setMaintenance('waiting');
    });

    // A scene met a ground revision this bundle cannot draw. A dev build draws
    // whatever the local server stamps, so it is never told to reload.
    const offArtwork = bus.on('scene:artworkOutdated', ({ groundRevision }) => {
      if (import.meta.env.DEV || BUILD.gitSha === 'dev') return;
      setState((prev) => (prev.kind === 'forced' ? prev : { kind: 'artwork', groundRevision }));
    });

    return () => { ac.abort(); clearTimeout(timer); offArtwork(); };
  }, []);

  useEffect(() => {
    if (maintenance !== 'waiting') return;
    const ac = new AbortController();
    let watch: ReturnType<typeof setTimeout>;
    const probe = async (): Promise<void> => {
      const server = await fetchServerVersion(ac.signal);
      if (ac.signal.aborted) return;
      if (server) { setMaintenance('ready'); return; }
      watch = setTimeout(() => void probe(), MAINTENANCE_WATCH_MS);
    };
    void probe();
    return () => { ac.abort(); clearTimeout(watch); };
  }, [maintenance]);

  const go = (): void => { setReloading(true); void reloadToLatest(); };

  // Maintenance outranks the update states: while the drain window is up, no
  // action can succeed and the reload button below would land on the same page.
  if (maintenance) {
    return (
      <ModalWrap>
        <div style={{ padding: 16, textAlign: 'center' }}>
          <div style={{ fontSize: 26, color: C.gold, letterSpacing: '2px', marginBottom: 10 }}>
            {maintenance === 'ready' ? 'THE KINGDOM IS READY' : 'RAISING THE DRAWBRIDGE'}
          </div>
          <div style={{ fontSize: 17, color: C.textDim, lineHeight: 1.45, marginBottom: 8 }}>
            {maintenance === 'ready'
              ? 'The upgrade is ready. Reload the game when you are ready to continue.'
              : 'The kingdom is being upgraded — back in a few minutes. Wait here while the server returns.'}
          </div>
          <div style={{ fontSize: 15, color: C.textFaint }}>
            Nothing is lost — your base, army and balances are on the server.
          </div>
          {maintenance === 'ready' && <Btn onClick={go} disabled={reloading} style={{ width: '100%', marginTop: 14 }}>
            {reloading ? 'UPDATING…' : 'RELOAD GAME'}
          </Btn>}
        </div>
      </ModalWrap>
    );
  }

  if (state.kind === 'current') return null;

  if (state.kind === 'forced') {
    return (
      <ModalWrap>
        <div style={{ padding: 16, textAlign: 'center' }}>
          <div style={{ fontSize: 26, color: C.gold, letterSpacing: '2px', marginBottom: 10 }}>
            UPDATE REQUIRED
          </div>
          <div style={{ fontSize: 17, color: C.textDim, lineHeight: 1.45, marginBottom: 8 }}>
            A new version of the battle simulator is live. This one would show you
            a different battle than the one the server records, so raiding is
            locked until you update.
          </div>
          <div style={{ fontSize: 15, color: C.textFaint, marginBottom: 14 }}>
            Nothing is lost — your base, army and balances are on the server.
          </div>
          <Btn onClick={go} disabled={reloading} style={{ width: '100%' }}>
            {reloading ? 'UPDATING…' : 'UPDATE NOW'}
          </Btn>
          <div style={{ fontSize: 13, color: C.stoneDark, marginTop: 10 }}>
            {BUILD.version} · {BUILD.gitSha.slice(0, 7)} · sim v{BUILD.simVersion}
          </div>
        </div>
      </ModalWrap>
    );
  }

  if (state.kind === 'artwork') {
    // Deferred, never dropped: a battle or scout plays out and the prompt waits
    // for the player to be back on the base screen.
    if (screen !== 'base') return null;
    return (
      <ModalWrap>
        <div style={{ padding: 16, textAlign: 'center' }}>
          <div style={{ fontSize: 26, color: C.gold, letterSpacing: '2px', marginBottom: 10 }}>
            NEW REALM ARTWORK IS LIVE
          </div>
          <div style={{ fontSize: 17, color: C.textDim, lineHeight: 1.45, marginBottom: 8 }}>
            New realm artwork is live. Reload to see it.
          </div>
          <div style={{ fontSize: 15, color: C.textFaint, marginBottom: 14 }}>
            Nothing is lost — your base, army and balances are on the server.
          </div>
          <Btn onClick={go} disabled={reloading} style={{ width: '100%' }}>
            {reloading ? 'UPDATING…' : 'RELOAD'}
          </Btn>
        </div>
      </ModalWrap>
    );
  }

  if (dismissed) return null;
  return (
    <div
      className="interactive"
      style={{
        position: 'absolute', left: 10, right: 10, bottom: 10, zIndex: 1400,
        background: C.ink, border: `2px solid ${C.borderLt}`, padding: '8px 10px',
        display: 'flex', alignItems: 'center', gap: 10, fontSize: 16, color: C.text,
      }}>
      <span style={{ flex: 1 }}>NEW VERSION AVAILABLE</span>
      <Btn variant="sec" onClick={go} disabled={reloading}>
        {reloading ? '…' : 'RELOAD'}
      </Btn>
      <span
        onClick={() => setDismissed(true)}
        style={{ cursor: 'pointer', color: C.stoneDark, padding: '0 4px' }}>
        ✕
      </span>
    </div>
  );
}
