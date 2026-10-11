/**
 * usePresence: the web twin of KIT Motion.kt `Presence(onGone)`. Pass the value to show or null to dismiss; the last
 * value keeps rendering while it animates out, and `gone()` (called from the exit animation's `animationend`, never
 * from a guessed timeout) clears it and runs `onGone` once. The host keeps Back priority until then (design ruling
 * 092decf3 item 5).
 */
import { useCallback, useRef, useState } from 'react';

export interface Presence<T> {
  /** What to render: the live value, or the last one while it leaves. */
  shown: T | null;
  /** True while the last value animates out (taps are ignored; Back still belongs to it). */
  leaving: boolean;
  /** Call from the exit animation's end. */
  gone: () => void;
}

export function usePresence<T>(value: T | null, onGone?: () => void): Presence<T> {
  const [shown, setShown] = useState<T | null>(value);
  // Derived-state update during render (React's "store information from previous renders" pattern): no effect flash.
  if (value != null && value !== shown) setShown(value);
  const onGoneRef = useRef(onGone);
  onGoneRef.current = onGone;
  const gone = useCallback(() => {
    setShown(null);
    onGoneRef.current?.();
  }, []);
  return { shown: value ?? shown, leaving: value == null && shown != null, gone };
}
