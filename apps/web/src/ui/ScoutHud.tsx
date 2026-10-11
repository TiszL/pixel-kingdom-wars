/**
 * Scout preview HUD (GDD §3.4). The target base is drawn by the real BattleScene
 * in read-only 'scout' mode (reused renderer, not a flat board); this React HUD
 * floats over the canvas with the target's name + trophies and a live countdown
 * that auto-closes after previewSec. CLOSE / timeout emits battle:exit (tears the
 * scene down + wakes the base) and returns to the originating board/history.
 */
import { useEffect, useRef, useState } from 'react';
import { bus } from '../lib/events';
import { readGameViewport, readGameUiViewport, subscribeGameViewport } from '../lib/gameViewport';
import { useMobileBackHandler } from '../lib/mobileBackGuard';
import { useApp } from '../state/store';
import { Btn, COLORS as C, fmtN, Icon, Pill } from './primitives';
import { readSafeAreaInsets } from './layout';

export function ScoutHud(): React.JSX.Element | null {
  const report = useApp((s) => s.scoutReport);
  const setScreen = useApp((s) => s.setScreen);
  const setScoutReport = useApp((s) => s.setScoutReport);

  const previewSec = report?.previewSec ?? 0;
  const [left, setLeft] = useState(previewSec);
  const hudRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const hud = hudRef.current;
    if (!report || !hud) return;
    const publish = (): void => {
      const safe = readSafeAreaInsets();
      const canvasTop = document.querySelector('[data-game-canvas-container]')?.getBoundingClientRect().top ?? 0;
      bus.emit('battle:insets', {
        top: Math.max(safe.top, Math.ceil(hud.getBoundingClientRect().bottom - canvasTop)),
        bottom: safe.bottom + Math.max(0, readGameViewport().h - readGameUiViewport().h),
        left: safe.left, right: safe.right,
      });
    };
    const offRequest = bus.on('battle:insetsRequest', publish);
    const offViewport = subscribeGameViewport(publish);
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(publish);
    observer?.observe(hud); publish();
    return () => { offRequest(); offViewport(); observer?.disconnect(); };
  }, [report]);

  // close() held in a ref so the auto-close timer isn't restarted by re-renders.
  const closeRef = useRef<() => void>(() => {});
  closeRef.current = (): void => {
    bus.emit('battle:exit', undefined); // stops the scout scene + wakes 'base'
    setScoutReport(null);
    setScreen(report?.returnScreen ?? 'map');
  };

  // Android Back during a scout is the same safe, read-only CLOSE action as
  // the HUD button. Register it above the screen fallback so the guard cannot
  // strand the battle canvas or return to a different destination.
  useMobileBackHandler(() => closeRef.current(), report !== null, 120);

  useEffect(() => {
    if (!previewSec) return;
    setLeft(previewSec);
    const tick = setInterval(() => setLeft((s) => Math.max(0, s - 1)), 1000);
    const close = setTimeout(() => closeRef.current(), previewSec * 1000);
    return () => { clearInterval(tick); clearTimeout(close); };
  }, [previewSec]);

  if (!report) return null;

  return (
    <div ref={hudRef} className="interactive" style={{ position: 'absolute', top: 'calc(8px + env(safe-area-inset-top))', left: 'calc(8px + env(safe-area-inset-left))', right: 'calc(8px + env(safe-area-inset-right))', zIndex: 1400, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, pointerEvents: 'none' }}>
      <Pill style={{ pointerEvents: 'auto', minHeight: 48, minWidth: 48 }}>
        <Icon name="scout" size={20} />SCOUT · {report.name}
      </Pill>
      <Pill style={{ pointerEvents: 'auto', minHeight: 48, minWidth: 48 }}>KEEP L{report.keepLevel}</Pill>
      <Pill style={{ pointerEvents: 'auto', minHeight: 48, minWidth: 48 }}><Icon name="trophy" size={18} />{fmtN(report.trophies)}</Pill>
      <div style={{ flex: 1 }} />
      <Pill style={{ pointerEvents: 'auto', color: C.gold }}>{left}s</Pill>
      {report.attackTarget && <Btn disabled={!!report.attackUnavailable} style={{ pointerEvents: 'auto', minHeight: 48, minWidth: 48 }}
        onClick={() => {
          const target = report.attackTarget;
          if (!target || report.attackUnavailable) return;
          bus.emit('battle:exit', undefined);
          setScoutReport(null);
          useApp.getState().setRaidTarget(target);
          setScreen('battle');
        }}>
        <Icon name="attack" size={18} />ATTACK
      </Btn>}
      <Btn variant="sec" style={{ pointerEvents: 'auto', minHeight: 48, minWidth: 48 }} onClick={() => closeRef.current()}>
        <Icon name="close" size={18} />CLOSE
      </Btn>
      {report.attackUnavailable && <Pill style={{ pointerEvents: 'auto', color: C.textDim }}>{report.attackUnavailable}</Pill>}
    </div>
  );
}
