import { useCallback, useState } from 'react';
import type { SheetInset } from './p2Types';

/** Only the normal-base HUD publishes this merged snapshot to the scene. */
export function mergeBasePanelInsets<T extends { top: number; bottom: number; left?: number; right?: number }>(hud: T, sheet: SheetInset | null, bottomClearance = 0): T {
  if (!sheet) return hud;
  return { ...hud, bottom: Math.max(hud.bottom, sheet.bottom > 0 ? sheet.bottom + Math.max(0, bottomClearance) : 0), right: Math.max(hud.right ?? 0, sheet.right) };
}

/** Equal ResizeObserver samples must not retrigger the sole HUD publisher. */
export function usePanelInset(): [SheetInset | null, (next: SheetInset | null) => void] {
  const [inset, setInset] = useState<SheetInset | null>(null);
  const update = useCallback((next: SheetInset | null) => {
    setInset((current) => current?.bottom === next?.bottom && current?.right === next?.right ? current : next);
  }, []);
  return [inset, update];
}
