package gg.pixelkingdomwars.nativeclient.renderer.world

/**
 * The web's `GPU_SAFE` (contracts.js, RM-GPU-1). These are web presentation constants: they arrive from the generated
 * `WorldEngineConstants.kt` (plan §4.3), never from a Kotlin copy, so this class has no defaults.
 */
class GpuSafePolicy(
    val slowMs: Double, val severeMs: Double, val window: Int, val need: Int, val severeNeed: Int,
    val upMs: Double, val upAfter: Int, val coldUploadBytes: Long, val lossStop: Int, val storeMs: Long,
) {
    init { require(window > 0 && need in 1..window && severeNeed in 1..window && upAfter > 0 && lossStop > 0 && storeMs > 0) }
}

/**
 * The native guard's way back up (native design values, not web numbers). The web steps up after `GPU_SAFE.upAfter`
 * (240) CONSECUTIVE samples ≤ `upMs` (12 ms) and never again once an up was followed by a down. On the Seeker the
 * fence-latency samples rarely string 240 of those together while the realm map works (a resolve slice, a band crossing,
 * an upload), so after a MAP-entry spike the owner looked at ⅓-scale ground for ~50 s (2026-09-25 17:15:17 → 17:16:10),
 * and a second trip would have held it for the session.
 *
 * The run is TIME, not a count of drawn frames: at the guard's L2 the realm declares no idle animation (GpuSafe.HEAVY[2]
 * is off), so a still camera after the MAP-entry trip draws nothing and a count would never complete. While tripped the
 * guard asks the host for a frame every [probeMs] ([HangGuard.wakeInMs]) so the samples keep arriving; a host that does
 * not probe still recovers on the next gesture's first [minSamples] steady frames once the time has passed.
 */
class HangRecovery(
    /** Time with no slow GPU frame (none over `GPU_SAFE.slowMs`) before the guard lets go: the owner's 5 s. */
    val steadyMs: Long,
    /** Steady samples that time must also hold: one frame after a long rest is not evidence ([probeMs] × this ≈ [steadyMs]). */
    val minSamples: Int,
    /** While tripped, the longest the host waits before drawing a frame, so a still view keeps sampling. */
    val probeMs: Long,
    /** Each further trip doubles [steadyMs], at most this many times (2^6 × 5 s ≈ 5 min). */
    val maxDoublings: Int,
    /** One steady GPU sample this long is a FREEZE, not a slow frame: the guard trips at once and the crash record keeps
     *  it for later sessions ([HangGuard.hazard]). Lead bound (RM-21-uncalibrated): 4 × the web's `severeMs`. */
    val freezeMs: Double,
) {
    init { require(steadyMs > 0 && minSamples > 0 && probeMs > 0 && maxDoublings in 0..20 && freezeMs > 0) }

    /** The steady time the recovery after the [trips]-th trip needs. */
    fun steadyRunMs(trips: Int): Long = steadyMs shl (maxOf(trips, 1) - 1).coerceAtMost(maxDoublings)

    companion object {
        /** The owner's "step quality back up once frames are steady (e.g. 5 s)" (orchestrator note 17:16); a probe every
         *  250 ms gives 20 samples in it. */
        val NATIVE = HangRecovery(steadyMs = 5_000, minSamples = 20, probeMs = 250, maxDoublings = 6, freezeMs = 1_000.0)
    }
}

/**
 * The stored-crash record (web: `localStorage['rm-gpu-safe']`; native: persisted by `:app`). [level] is
 * [HangGuard.SAFE_LEVEL] while it holds a [HangGuard.hazard] ([reason]), else 0. [pendingSinceMs] is set while the realm
 * map is open and cleared on a clean leave, so a session that died inside it starts the next one safe.
 */
data class HangRecord(val level: Int, val atMs: Long, val reason: String?, val pendingSinceMs: Long?)

/**
 * Hang defence only (GLOBE-NATIVE-PLAN §5.4): the port of core.js `watchdog` + `qualityStep`, `GPU_SAFE` verbatim for the
 * trip, [HangRecovery] for the way back.
 * It never tunes for 60 fps (that is [FrameLadder]); when it trips it floors the ladder at [SAFE_LEVEL].
 *
 * - Input: one GPU-cost sample per STEADY frame, in ms (the fence-latency lower bound, `Gl3FrameReport.gpuSamplesMs`:
 *   the Seeker reportedly has no timer query), timed from the fence's insertion at `endFrame`, so the frame's own CPU
 *   time is never GPU time (web core.js `gpuEnd`). Cold samples (a first-drawn pair, an adoption, a large upload, or the
 *   frame after one) are ignored: one-off driver work is not the view's cost.
 * - Down (to [SAFE_LEVEL]) when `need` of the last `window` samples exceed `slowMs`, or `severeNeed` reach
 *   `severeMs` (the web keeps severeNeed 2: "one stall is a hiccup, two in a window are a GPU that cannot draw this
 *   view").
 * - Up (back to the floor) once [HangRecovery.steadyMs] of frame time passed with no slow sample (≤ `slowMs`) and at
 *   least [HangRecovery.minSamples] steady ones arrived: the guard answers hangs, and a frame that is only slow for 60 fps
 *   (12–50 ms) is the [FrameLadder]'s, which resumes one level below the guard's ([FrameLadder.hangLevel]). Each further
 *   trip doubles the time the next recovery needs ([trips]), so the guard never oscillates faster than that backoff and
 *   never locks for the session. While tripped it asks the host for a frame every [HangRecovery.probeMs] ([wakeInMs]).
 *   The web's `upMs`/`upAfter` are not used natively ([HangRecovery]).
 * - One steady sample of [HangRecovery.freezeMs] or more is a freeze: [FREEZE], the guard trips at once.
 * - A lost context floors it at [SAFE_LEVEL] for the session; `lossStop` losses stop the realm map ([stopped]).
 * - Only a real freeze outlives the session ([hazard], [record]): a lost context, a freeze, or the young stored record the
 *   session started from. A session that starts from one starts at [SAFE_LEVEL] and lets go by the same steady-time rule
 *   as a trip (it is not a floor), and [forget]s it once clean realm-map visits followed it (`HangMemory`, the web's
 *   `gpuRecord.leave`). A slow-frame trip is never stored: the web's "a watchdog step is not stored: it is
 *   re-measured within a few frames, and a slow-but-alive GPU is not a hazard" (map.js `setLevel`). Code 30 stored every
 *   trip and floored the next session with it: after one MAP-entry trip the owner's Seeker drew ⅓-scale ground in every
 *   later World session (2026-09-26 12:28:37 on, no "recovered" line).
 */
class HangGuard(private val policy: GpuSafePolicy, private val recovery: HangRecovery = HangRecovery.NATIVE) {
    var level = 0; private set
    /** The level the guard never lets go below this session: only a lost context in it sets one. */
    var floor = 0; private set
    var stopped = false; private set
    var losses = 0; private set
    var reason: String? = null; private set
    /** Slow-frame trips this session: the backoff of the next recovery ([upAfterMs]). */
    var trips = 0; private set
    /** The steady time the current recovery needs. */
    val upAfterMs: Long get() = recovery.steadyRunMs(trips)
    private val samples = DoubleArray(policy.window)
    private var count = 0
    private var head = 0
    private var good = 0
    /** Why this device's crash record must outlive the session (a real freeze), or null ([record]). */
    var hazard: String? = null; private set
    /** Frame time of the last slow sample or trip: the steady time counts from here. */
    private var lastSlowMs = 0L
    /** False until the session's first sample: a start at the safe level times its steady run from that frame. */
    private var timed = false

    /** Start a session from the stored record (web `startLevel`): a stored hazard or a pending marker younger than
     *  `storeMs` starts safe, not floored: it lets go after [upAfterMs] of steady frames, as a trip does. Returns the level. */
    fun start(record: HangRecord?, nowMs: Long): Int {
        val start = startLevel(record, nowMs, policy.storeMs)
        level = start; floor = 0; timed = false
        reason = when {
            start == 0 -> null
            record?.pendingSinceMs != null && nowMs - record.pendingSinceMs < policy.storeMs -> "the last visit ended inside the realm map"
            else -> record?.reason ?: "an earlier graphics reset"
        }
        hazard = reason
        return level
    }

    /** Feed one steady-frame GPU sample drawn at [frameMs] (monotonic ms; only differences count, and the default is
     *  the same clock as the host's frame time). Returns [FREEZE], [DOWN], [UP] or [HOLD]. */
    fun sample(ms: Double, cold: Boolean, frameMs: Long = System.nanoTime() / 1_000_000L): Int {
        if (cold || stopped) return HOLD
        if (!timed) { timed = true; lastSlowMs = frameMs }
        if (ms >= recovery.freezeMs) {
            if (level < SAFE_LEVEL) { level = SAFE_LEVEL; trips++ }
            reason = FROZEN; hazard = FROZEN
            clear(); lastSlowMs = frameMs
            return FREEZE
        }
        samples[head] = ms; head = (head + 1) % samples.size; if (count < samples.size) count++
        if (ms <= policy.slowMs) good++ else { good = 0; lastSlowMs = frameMs }
        var severe = 0; var slow = 0
        for (i in 0 until count) { val s = samples[i]; if (s >= policy.severeMs) severe++; if (s > policy.slowMs) slow++ }
        if ((severe >= policy.severeNeed || slow >= policy.need) && level < SAFE_LEVEL) {
            level = SAFE_LEVEL; reason = "slow GPU frames"; trips++ // in-session only: never a [hazard]
            clear(); lastSlowMs = frameMs
            return DOWN
        }
        if (level > floor && good >= recovery.minSamples && frameMs - lastSlowMs >= upAfterMs) {
            level = floor; reason = null
            clear()
            return UP
        }
        return HOLD
    }

    /** Clean realm-map visits followed the stored freeze (`HangMemory`'s count, the web's `gpuRecord.leave`): it no longer
     *  outlives the session, so the next one starts at full quality. The session's own level is left as it is. */
    fun forget() { hazard = null }

    /** While tripped, the longest the host may wait before the next frame ([HangRecovery.probeMs]); -1 when it need
     *  not wake: a still view at the guard's level declares no idle frames, and without samples it never lets go. */
    fun wakeInMs(): Long = if (level > floor && !stopped) recovery.probeMs else -1L

    /** A lost context (Gl3Stats.contextLosses increased): restore at [SAFE_LEVEL]; `lossStop` of them stop the map. */
    fun contextLost(): Boolean {
        losses++
        level = SAFE_LEVEL; floor = SAFE_LEVEL; reason = LOST; hazard = LOST
        clear()
        if (losses >= policy.lossStop) stopped = true
        return stopped
    }

    /** What to persist now: the [hazard] (at [SAFE_LEVEL]), and the pending marker while the realm map is open. The
     *  guard's current level is not persisted: a slow-frame trip, and the recovery from any start, are this session's. */
    fun record(nowMs: Long, realmOpenSinceMs: Long?): HangRecord? =
        if (hazard == null && realmOpenSinceMs == null) null
        else HangRecord(if (hazard != null) SAFE_LEVEL else 0, nowMs, hazard, realmOpenSinceMs)

    private fun clear() { count = 0; head = 0; good = 0 }

    companion object {
        /** The ladder level the guard forces when it trips. */
        const val SAFE_LEVEL = 2
        const val HOLD = 0
        const val DOWN = 1
        const val UP = 2
        /** A frozen frame ([HangRecovery.freezeMs]): the guard is at [SAFE_LEVEL] and the [hazard] is new; persist it. */
        const val FREEZE = 3
        private const val FROZEN = "a frozen GPU frame"
        private const val LOST = "a lost graphics context"

        fun startLevel(record: HangRecord?, nowMs: Long, storeMs: Long): Int {
            if (record == null) return 0
            val pending = record.pendingSinceMs
            if (pending != null && nowMs - pending < storeMs) return SAFE_LEVEL
            if (record.level > 0 && nowMs - record.atMs < storeMs) return SAFE_LEVEL
            return 0
        }
    }
}
