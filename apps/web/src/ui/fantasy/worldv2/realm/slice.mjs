// Realm-map main-thread task clock (RM-GPU-1 stage B D1; D-167: no main-thread task over 50 ms). SHELL owns this file.
//
// Every lane slices its load into steps of ≤ SLICE_MS (8 ms on desktop, 4 ms under a coarse pointer). Until stage B each
// lane's sliced() started its OWN clock, so the rule held per sliced() call, not per task: map.js loadModules started GROUND,
// BASES, LIFE and the minimap in one task, pack reads that resolve at once continue as microtasks of the task already
// running, and a job that ends hands straight to the next one (lines bake → bend, palette → mapAtlas → trueSetup). The
// entry's first task was 28–32 ms of JS on performance cores and 51–84 ms on efficiency cores (qa/entry-stretch.mjs).
//
// This is the ONE clock they share. A task start is marked where the engine knows one begins: the delivery of every
// message-channel yield (yieldTask), every animation frame (core's tick), and the loader's I/O continuations (a fetch, a
// decode-worker reply). A job checks spent() BEFORE EVERY STEP, the first one included, so a job that starts in a task
// already spent yields at once instead of adding its slice to it. An unmarked task (a timer, an import) reads as spent:
// its first step costs one extra yield, never a long task.
//
// tasks() → start(f): each f at the head of its own task, in order (loadModules: one lane per task).
// Tests drive a counted clock through createTaskClock({ now, post }) or by replacing performance.now (the lanes' convention).

const defaultNow = () => (globalThis.performance ? performance.now() : Date.now());
/** The slice every lane's step loop keeps to: 8 ms on desktop, 4 ms on a phone (coarse pointer). */
export const SLICE_MS = globalThis.matchMedia?.('(pointer: coarse)')?.matches ? 4 : 8;
/** Post a callback as a new task: a message-channel delivery (setTimeout(0) is clamped to ≥ 4 ms after 5 nested calls). */
const defaultPost = fn => {
  if (typeof MessageChannel !== 'function') { setTimeout(fn, 0); return; }
  const c = new MessageChannel(); c.port1.onmessage = () => { c.port1.close(); fn(); }; c.port2.postMessage(0);
};

/**
 * A task clock. now: ms clock (default performance.now, read at every call so a test may replace it); post(fn): run fn as
 * a new task; sliceMs: the budget. → { sliceMs, mark(), spent(), elapsed(), yieldTask(), ensure(), tasks() }.
 */
export function createTaskClock({ now = () => defaultNow(), post = defaultPost, sliceMs = SLICE_MS } = {}) {
  // the current task's start. A clock that runs backwards (a test that swaps performance.now for its own counted clock)
  // re-marks here instead of reading as never spent; a real performance.now never does
  let t0 = now();
  const since = () => { const t = now(); if (t < t0) t0 = t; return t - t0; };
  const clock = {
    sliceMs,
    /** A task begins now (a frame, an I/O continuation). */
    mark(t = now()) { t0 = t; },
    /** ms since the current task was marked. */
    elapsed: since,
    /** Has the current task used its slice? Check before every step, the first one included. */
    spent: () => since() > sliceMs,
    /** Yield the main thread: resolves at the start of a new task, with the clock marked there. */
    yieldTask: () => new Promise(res => post(() => { t0 = now(); res(); })),
    /** Yield only when the current task is spent → true when it yielded. */
    async ensure() { if (since() > sliceMs) { await clock.yieldTask(); return true; } return false; },
    /**
     * A starter: start(f) runs f at the head of its own task, after the previous start's task (it waits for the previous
     * START, never for a load to finish) → a promise of f's result. map.js loadModules starts one lane per task with it:
     * their synchronous heads and first slices used to add up in the entry's first task.
     */
    tasks() { let q = Promise.resolve(); return f => { const at = q.then(() => clock.yieldTask()); q = at; return at.then(f); }; },
  };
  return clock;
}

/** The page's shared clock: every lane's sliced() and SHELL's loadModules use this one instance. */
export const taskClock = createTaskClock();
