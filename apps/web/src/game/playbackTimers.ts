import type Phaser from 'phaser';
import { sceneCleanup } from './sceneCleanup';

type Timer = Phaser.Time.TimerEvent;
type ClockQueues = { _active: Timer[]; _pendingInsertion: Timer[]; _pendingRemoval: Timer[] };
const retired = new WeakMap<Phaser.Time.Clock, Set<Timer>>();

/** Phaser 4.1's deferred removal uses indexOf/splice once per expired timer.
 * Replacing a full raid journal therefore freezes the next PRE_UPDATE. Retire
 * only our schedule in one pass, after the current Clock iteration returns.
 * Effects retain their timers, insertion order, elapsed time and time scale.
 * The installed-Clock regression pins this deliberately narrow internal seam. */
export function retirePlaybackTimers(clock: Phaser.Time.Clock, timers: readonly Timer[]): void {
  if (timers.length === 0) return;
  let pending = retired.get(clock);
  if (!pending) {
    pending = new Set<Timer>();
    retired.set(clock, pending);
    queueMicrotask(() => flushRetiredPlaybackTimers(clock));
  }
  for (const timer of timers) {
    pending.add(timer);
    sceneCleanup('timeline', () => timer.remove());
  }
}

/** Only call synchronously between manual Clock updates, never from a timer
 * callback. Ordinary cancellation uses the microtask above to avoid shifting
 * the active array while Clock.update is iterating it. */
export function flushRetiredPlaybackTimers(clock: Phaser.Time.Clock): void {
  const pending = retired.get(clock);
  if (!pending) return;
  retired.delete(clock);
  const queues = clock as unknown as ClockQueues;
  // A changed engine contract retains Phaser's ordinary removal semantics.
  if (![queues._active, queues._pendingInsertion, queues._pendingRemoval].every(Array.isArray)) return;
  const removed = new Set<Timer>();
  for (const queue of [queues._active, queues._pendingInsertion, queues._pendingRemoval]) {
    let write = 0;
    for (const timer of queue) {
      if (pending.has(timer)) removed.add(timer);
      else queue[write++] = timer;
    }
    queue.length = write;
  }
  for (const timer of removed) sceneCleanup('timeline', () => timer.destroy());
}
