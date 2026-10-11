import { useEffect, useRef, useState } from 'react';
import { COLORS as C } from '../primitives';
import { nextParcelRuleRefreshMs, parcelShieldText, type ParcelDetail } from '../screens/globe/parcelDetail';

// Keep server-anchored rule deadlines in this leaf so countdowns do not repaint the globe.
export function FantasyShieldStatus({ detail, onExpire }: {
  detail: Pick<ParcelDetail, 'shield' | 'shielded' | 'warzone'>;
  onExpire(): void;
}): React.JSX.Element {
  const deadline = detail.shield?.expiresAt ?? null;
  const remainingMs = Math.max(0, detail.shield?.remainingMs ?? 0);
  const fingerprint = `${deadline ?? ''}:${remainingMs}:${detail.shield?.active === true}:${detail.shield?.suppressedByWarzone === true}`;
  const anchorRef = useRef({ fingerprint: '', at: 0, serverNow: 0 });
  if (anchorRef.current.fingerprint !== fingerprint) {
    anchorRef.current = {
      fingerprint,
      at: performance.now(),
      serverNow: deadline ? Date.parse(deadline) - remainingMs : 0,
    };
  }
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    setElapsed(0);
    if (!deadline || (!detail.shield.active && !detail.shield.suppressedByWarzone)) return undefined;
    const tick = (): void => {
      const next = Math.max(0, performance.now() - anchorRef.current.at);
      setElapsed(next);
    };
    if (remainingMs === 0) return undefined;
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [deadline, detail.shield.active, detail.shield.suppressedByWarzone, fingerprint, remainingMs]);
  const ruleRefreshMs = nextParcelRuleRefreshMs(detail);
  const ruleBoundaryKey = `${detail.warzone.boundaryAt ?? ''}:${detail.warzone.remainingMs ?? ''}:${deadline ?? ''}:${remainingMs}`;
  const refreshedRuleBoundary = useRef<string | null>(null);
  useEffect(() => {
    if (ruleRefreshMs === null || refreshedRuleBoundary.current === ruleBoundaryKey) return undefined;
    if (ruleRefreshMs === 0) {
      refreshedRuleBoundary.current = ruleBoundaryKey;
      onExpire();
      return undefined;
    }
    const timer = window.setTimeout(() => {
      refreshedRuleBoundary.current = ruleBoundaryKey;
      onExpire();
    }, ruleRefreshMs + 250);
    return () => window.clearTimeout(timer);
  }, [onExpire, ruleBoundaryKey, ruleRefreshMs]);
  const protectedNow = detail.shield?.active ?? detail.shielded;
  const suppressed = detail.shield?.suppressedByWarzone === true;
  const now = anchorRef.current.serverNow + elapsed;
  return (
    <div role="status" style={{
      color: suppressed ? C.goldHi : protectedNow ? C.sky : C.success,
      fontSize: 14, marginTop: 3,
    }}>
      {parcelShieldText(detail.shield, detail.shielded, now)}
    </div>
  );
}
