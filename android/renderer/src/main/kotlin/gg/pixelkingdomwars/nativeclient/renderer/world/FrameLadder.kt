package gg.pixelkingdomwars.nativeclient.renderer.world

import kotlin.math.ceil

/**
 * The native 60-fps ladder's own tuning (GLOBE-NATIVE-PLAN §5.4, the "native section"). Native design values, not web
 * copies; **RM-21-uncalibrated**: they change only with Seeker-session evidence.
 */
class LadderPolicy(
    /** Down when [downNeed] of the last [window] motion intervals exceed [downOverMs]. */
    val window: Int, val downNeed: Int, val downOverMs: Double,
    /** Up after [upAfter] consecutive motion intervals ≤ [upWithinMs] (no missed slot: see [PLAN]). */
    val upAfter: Int, val upWithinMs: Double,
    /** Thermal headroom (`getThermalHeadroom(10)`) above this steps down one level pre-emptively. */
    val preemptHeadroom: Double,
    val targetFps: Int, val thermalFps: Int,
    /** L2's ground cap in px per CSS px (k ⅓ at dpr 2, still an integer snap). */
    val l2GroundPx: Double,
    /** L1 divides the LIFE submitted cap by this (thinned by the web's `THIN_ORDER`). */
    val l1LifeDivisor: Int,
    /** L1's resolves per frame: one lattice sub-tile or one TRUE page. */
    val l1MaxResolves: Int,
    val globeSlotsFull: Int, val globeSlotsReduced: Int,
) {
    companion object {
        /** The plan §5.4 table, except [upWithinMs]: the plan's 16.7 ms sits 0.03 ms above the 60 Hz period, and the
         *  intervals are frame-start to frame-start on the GL thread, so vsync wake jitter alone puts a third to a half of
         *  them over it (Seeker 2026-09-25 [world-perf] steady motion: p50 16.6, p95 17.9 ms) and 240 in a row never formed:
         *  the ladder never climbed once in the session. An up counts intervals that kept their slot, the same 20 ms line
         *  the down rule uses for a missed one. */
        val PLAN = LadderPolicy(window = 20, downNeed = 6, downOverMs = 20.0, upAfter = 240, upWithinMs = 20.0,
            preemptHeadroom = 0.85, targetFps = 60, thermalFps = 30, l2GroundPx = 0.67, l1LifeDivisor = 2, l1MaxResolves = 1,
            globeSlotsFull = 2, globeSlotsReduced = 1)
    }
}

/** The web numbers the ladder derives from, from the generated constants: `GPU_SAFE.groundPx[0]` and
 *  `LIFE_CAPS.submitted.phone` (the Seeker is a phone to `submittedCap`, plan §5.5). */
class LadderInputs(val groundPxL0: Double, val lifeCapPhone: Int)

/** What one level turns on (plan §5.4 table). [maxResolves] 0 means the ground's own `resolveBudget`. */
class LadderKnobs(
    val level: Int,
    val groundPx: Double, val heavy: Boolean, val lifeCap: Int, val maxResolves: Int,
    val paintingSlots: Int, val cloudShell: Boolean, val shimmer: Boolean,
    val animation: Boolean, val targetFps: Int,
) {
    /** The ground's render scale at this level (core.js `groundScale`): an integer fraction of the canvas. */
    fun groundScale(dpr: Double): Double = groundScale(dpr, groundPx)

    companion object {
        /** core.js `groundScale`: 1/n with n = ceil(dpr / groundPx), 1 ≤ n ≤ 4 (an exact n× snap, never a resample). */
        fun groundScale(dpr: Double, groundPx: Double): Double =
            1.0 / minOf(4.0, maxOf(1.0, ceil(maxOf(dpr, 1e-3) / maxOf(groundPx, 1e-3) - 1e-6)))
    }
}

/** `PowerManager.getCurrentThermalStatus()` values 0..6. */
enum class ThermalStatus { NONE, LIGHT, MODERATE, SEVERE, CRITICAL, EMERGENCY, SHUTDOWN }

/**
 * The native 60-fps ladder (plan §5.4). Levels L0–L3; the effective [level] is the strictest of the frame-time level
 * (0–2), the [HangGuard] floor and the thermal floor (L3 is thermal SEVERE only).
 *
 * Inputs are swap-to-swap intervals of MOTION frames only (frames [IdleScheduler] requested continuously), with cold
 * frames excluded: idle cadence frames (50/125 ms by design) and one-off driver work must never step the ladder.
 * Steps: down when ≥ `downNeed` of the last `window` intervals exceed `downOverMs`; up after `upAfter` consecutive
 * intervals ≤ `upWithinMs`; a step up followed by a step down (or a hang-guard trip) locks further ups for the session.
 * Frames drawn under the hang guard's floor never count toward an up. When the hang guard lets go, the ladder resumes
 * one level below the guard's ([hangLevel]) and climbs the rest by its own rule. Thermal: MODERATE
 * floors L1 and halves the idle cadence, SEVERE floors L3 (30 fps pacing), CRITICAL and above render on input only;
 * headroom above `preemptHeadroom` steps down one level once per crossing. GL thread only; never allocates.
 */
class FrameLadder(private val policy: LadderPolicy, inputs: LadderInputs) {
    val knobs: Array<LadderKnobs> = Array(LEVELS) { level ->
        val reduced = level >= 1
        LadderKnobs(level,
            groundPx = if (level >= 2) policy.l2GroundPx else inputs.groundPxL0,
            heavy = !reduced,
            lifeCap = if (reduced) inputs.lifeCapPhone / policy.l1LifeDivisor else inputs.lifeCapPhone,
            maxResolves = if (reduced) policy.l1MaxResolves else 0,
            paintingSlots = if (reduced) policy.globeSlotsReduced else policy.globeSlotsFull,
            cloudShell = !reduced, shimmer = !reduced,
            animation = level < 2,
            targetFps = if (level >= 3) policy.thermalFps else policy.targetFps)
    }

    /** The level frame times asked for (0–2). */
    var frameLevel = 0; private set
    var hangFloor = 0; private set
    var thermalFloor = 0; private set
    val level: Int get() = maxOf(frameLevel, hangFloor, thermalFloor)
    val current: LadderKnobs get() = knobs[level]
    /** Why the last step happened (for the overlay and `[world-perf]`). */
    var lastReason = REASON_NONE; private set
    var upLocked = false; private set
    /** Thermal CRITICAL or worse: render on input only. */
    var inputOnly = false; private set
    /** Idle cadence multiplier (2 under thermal MODERATE). */
    var idleCadenceScale = 1; private set

    private val slow = BooleanArray(policy.window)
    private var count = 0
    private var head = 0
    private var slowCount = 0
    private var good = 0
    private var wentUp = false
    private var headroomHigh = false

    /** One motion interval (ms between presented motion frames). Returns [DOWN], [UP] or [HOLD]. */
    fun motionInterval(ms: Double, cold: Boolean): Int {
        if (cold) return HOLD
        val isSlow = ms > policy.downOverMs
        if (count == slow.size) { if (slow[head]) slowCount-- } else count++
        slow[head] = isSlow; if (isSlow) slowCount++
        head = (head + 1) % slow.size
        // a frame drawn under the guard's floor proves the guard's level, not the ladder's: it never counts toward an up
        good = if (ms <= policy.upWithinMs && hangFloor <= frameLevel) good + 1 else 0
        if (slowCount >= policy.downNeed && frameLevel < MAX_FRAME_LEVEL) { stepDown(REASON_SLOW_FRAMES); return DOWN }
        if (good >= policy.upAfter && frameLevel > 0 && !upLocked) {
            frameLevel--; wentUp = true; lastReason = REASON_FAST_FRAMES; clear()
            return UP
        }
        return HOLD
    }

    /**
     * The [HangGuard]'s level (0 or [HangGuard.SAFE_LEVEL]). When it lets go, the frame level becomes at least one below
     * the guard's (L1 from the safe L2) with a fresh window: the steady frames that released the guard were drawn at its
     * level, so they prove that level, not L0. Why: on the Seeker the trip comes from the MAP band's entry at L0, k 1 (the
     * frame the calibrated model prices over the 60 Hz slot); dropping straight back to L0 re-enters that frame, and only
     * the ladder's own fast-frame rule (and its up-then-down lock) may choose to try it again. A trip after the ladder
     * climbed is that step down for the lock: otherwise trip, release, climb, trip repeats for the whole session with the
     * ground at ⅓ between (the guard trips before the ladder's own window fills).
     */
    fun hangLevel(guardLevel: Int) {
        val g = guardLevel.coerceIn(0, MAX_FRAME_LEVEL)
        if (g > hangFloor) { lastReason = REASON_HANG_GUARD; if (wentUp) upLocked = true }
        else if (g < hangFloor) { frameLevel = maxOf(frameLevel, hangFloor - 1); clear() }
        hangFloor = g
    }

    /** Thermal status and headroom (NaN where `getThermalHeadroom` is unavailable, API < 30). */
    fun thermal(status: ThermalStatus, headroom: Double) {
        val floor = when {
            status >= ThermalStatus.SEVERE -> 3
            status == ThermalStatus.MODERATE -> 1
            else -> 0
        }
        if (floor > thermalFloor) lastReason = REASON_THERMAL
        thermalFloor = floor
        inputOnly = status >= ThermalStatus.CRITICAL
        idleCadenceScale = if (status == ThermalStatus.MODERATE) 2 else 1
        val high = !headroom.isNaN() && headroom > policy.preemptHeadroom
        if (high && !headroomHigh && frameLevel < MAX_FRAME_LEVEL) stepDown(REASON_PREEMPT)
        headroomHigh = high
    }

    private fun stepDown(reason: Int) {
        frameLevel++
        if (wentUp) upLocked = true
        lastReason = reason
        clear()
    }

    private fun clear() { count = 0; head = 0; slowCount = 0; good = 0; slow.fill(false) }

    companion object {
        const val LEVELS = 4
        const val MAX_FRAME_LEVEL = 2
        const val HOLD = 0
        const val DOWN = 1
        const val UP = 2
        const val REASON_NONE = 0
        const val REASON_SLOW_FRAMES = 1
        const val REASON_FAST_FRAMES = 2
        const val REASON_HANG_GUARD = 3
        const val REASON_THERMAL = 4
        const val REASON_PREEMPT = 5
    }
}
