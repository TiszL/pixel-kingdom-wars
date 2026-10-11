package gg.pixelkingdomwars.nativeclient.renderer.world

/** The web's `IDLE` (contracts.js, C10), from the generated constants: never a Kotlin copy, so no defaults. */
class IdlePolicy(val fullMs: Long, val fullCapFps: Int, val capFps: Int, val freezeMs: Long) {
    init { require(fullMs in 1 until freezeMs && fullCapFps > 0 && capFps > 0) }
}

/**
 * Render on demand with the timed idle policy (GLOBE-NATIVE-PLAN §1.2 C10, §5.8; the port of core.js `idleInterval`
 * and its clock). The pacer asks [delayMs] after every frame and posts NOTHING when it answers [NEVER]: at 0 fps no
 * timer wakes the CPU.
 *
 * - MOTION (a gesture, inertia, a flight or a fade: [setMoving]) renders every paced vsync; those are the only frames
 *   whose intervals the ladder and the sampler count ([motion]).
 * - [invalidate] asks for one frame (an intent, an upload, an adoption).
 * - Otherwise the fastest visible animation period sets the cadence, capped at `fullCapFps` for `fullMs` after input,
 *   then at `capFps` (and × [cadenceScale] under thermal MODERATE).
 * - After `freezeMs` without input everything freezes, **the selection/dome pulse included** (native rule, plan §5.8:
 *   the web keeps a 4 fps pulse; here the pulse stops at full brightness, [frozen] tells the shader).
 * - Hidden, reduced motion, or thermal CRITICAL ([inputOnly]): no idle frames at all.
 *
 * The animation clock is integer ms from the pacer's frame time and stops at the freeze. GL thread only; never allocates.
 */
class IdleScheduler(private val policy: IdlePolicy) {
    private val periods = IntArray(MAX_TAGS)
    private var lastInputMs = 0L
    private var moving = false
    private var dirty = true
    private var lastClockMs = Long.MIN_VALUE

    var hidden = false
    var reducedMotion = false
    var inputOnly = false
    var cadenceScale = 1
        set(value) { field = maxOf(1, value) }

    var phase = PHASE_FULL; private set
    /** The frame [delayMs] last scheduled is a motion frame. */
    var motion = false; private set
    /** Animation clock, integer ms; frozen at the idle freeze. */
    var clockMs = 0L; private set
    var frozen = false; private set

    /** User input: leaves any idle phase and unfreezes the clock. */
    fun input(nowMs: Long) { lastInputMs = nowMs; if (frozen) { frozen = false; lastClockMs = nowMs }; dirty = true }

    /** A camera gesture, inertia, flight or cross-fade is running: render every paced vsync. */
    fun setMoving(moving: Boolean) { this.moving = moving; if (moving) dirty = true }

    fun invalidate() { dirty = true }

    /** Declare an animation on screen with this frame period (ms); 0 stops it. [tag] < [MAX_TAGS]. */
    fun animating(tag: Int, periodMs: Int) { periods[tag] = maxOf(0, periodMs) }

    /** The wait before the next frame: 0 = the next paced vsync, [NEVER] = nothing until input or [invalidate]. */
    fun delayMs(nowMs: Long): Long {
        val since = nowMs - lastInputMs
        phase = if (since < policy.fullMs) PHASE_FULL else if (since < policy.freezeMs) PHASE_CAPPED else PHASE_FROZEN
        motion = moving
        if (moving || dirty) return 0L
        if (hidden || reducedMotion || inputOnly || phase == PHASE_FROZEN) return NEVER
        var base = Int.MAX_VALUE
        for (p in periods) if (p in 1 until base) base = p
        if (base == Int.MAX_VALUE) return NEVER
        val cap = (1000L / (if (phase == PHASE_FULL) policy.fullCapFps else policy.capFps)) * cadenceScale
        if (base < cap) return cap
        return maxOf(1L, base - (clockMs % base))
    }

    /** A frame was drawn at [nowMs] (the pacer's frame time): advance the clock unless frozen, and clear [invalidate]. */
    fun frameRendered(nowMs: Long) {
        if (lastClockMs == Long.MIN_VALUE) lastClockMs = nowMs
        val dt = maxOf(0L, nowMs - lastClockMs)
        lastClockMs = nowMs
        frozen = !moving && nowMs - lastInputMs >= policy.freezeMs
        if (!frozen) clockMs += dt
        dirty = false
    }

    companion object {
        const val NEVER = Long.MAX_VALUE
        const val MAX_TAGS = 16
        const val PHASE_FULL = 0
        const val PHASE_CAPPED = 1
        const val PHASE_FROZEN = 2
        /** Tags (web `animating(tag)`): selection pulse, shield/dome sweep, clouds, water, life, islands, bases. */
        const val TAG_SELECT = 0
        const val TAG_SHIELD = 1
        const val TAG_CLOUDS = 2
        const val TAG_WATER = 3
        const val TAG_LIFE = 4
        const val TAG_ISLANDS = 5
        /** The realm map's BASES keeps (bases.js `animating('bases', 83)`; N3, lead integration). */
        const val TAG_BASES = 6
        /** The realm map's GROUND water (ground.js `animating('ground', …)`; stage B, [RealmLane.idlePeriodMs]). */
        const val TAG_GROUND = 7
    }
}
