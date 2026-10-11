package gg.pixelkingdomwars.nativeclient.renderer.realmmap

import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Program
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Texture

/** The view of one realm frame (map.js `makeView`), rewritten in place every frame. CSS px unless marked. */
class RealmView {
    var x = 0.0; var y = 0.0
    /** CSS px per deed. */
    var s = 1.0
    var dpr = 1.0
    /** Device px per deed (s · dpr). */
    var d = 1.0
    var viewW = 1.0; var viewH = 1.0
    /** The target being drawn, device px (the fixed buffer, or the snapshot). */
    var targetW = 1; var targetH = 1
    val bands = RealmBandState()
    /** map.js `BAND_SET` of [bands]: 0 FAR, 1 MAP (and the FAR→MAP fade), 2 TRUE (and the MAP→TRUE fade). */
    var bandSet = 0
    /** Visible deed rect, fractional. */
    var rectX0 = 0.0; var rectY0 = 0.0; var rectX1 = 0.0; var rectY1 = 0.0
    /** Animation clock (frozen at the idle freeze) and the pulse clock, ms. */
    var clockMs = 0L; var pulseMs = 0L
    var frozen = false
    var reducedMotion = false
    /** GPU safe mode (ladder level ≥ 2: heavy passes off, still). */
    var safe = false
    var cols = 1; var rows = 1; var gridX0 = 0; var gridY0 = 0
    var selX = -1; var selY = -1; var hovX = -1; var hovY = -1
    var moving = false
    var speed = 0.0
    /** The ladder level (0–3) and the web level it maps to (0–2). */
    var ladderLevel = 0
    val webLevel: Int get() = minOf(2, ladderLevel)

    // ---- the frame's work budget (plan §5.1, §5.7, §5.9): lanes charge it, the core resets it every frame ----
    /** The host allows uploads and resolves this frame (never in a flight or a fade). */
    var workAllowed = false
    /** GL-thread upload bytes left this frame (`GPU_SAFE.coldUploadBytes` at frame start): subtract every
     *  `core.upload` you issue; a lane that would go below 0 defers to the next frame. */
    var uploadBytesLeft = 0L
    /** Resolve fetches per canvas px this frame (groundcost.js `RESOLVE_BUDGET`); 0 when work is not allowed. */
    var resolveBudget = 0.0
    /** Resolve slices per frame (0 = [resolveBudget] only; 1 at ladder ≥ L1: one sub-tile or one page, plan §5.4). */
    var maxResolves = 0
    /** LIFE's submitted-instance cap this frame (`LIFE_CAPS.submitted.phone` at L0, halved at L1+; plan §5.4). */
    var lifeCap = 0
}

/**
 * The N3 hook (ground, life, bases): a detail lane plugs into the realm engine through this and nothing else, so N3
 * adds lanes without editing the core. The engine calls it in the web's frame order (map.js `frame`): update → the
 * ground slot → shadow → clear depth → shieldBack → sprite → shieldFront → air (heavy only) → fx → the minimap last.
 * Rehearsal and band readiness include its programs (map.js `bandGate`, `laneHeld`, W1 S1/S2/S8):
 * - every (program, target) pair of [programs] × [rehearseTargets] is rehearsed through [rehearse] before its band;
 * - a pair is in the TRUE set when its program name is in `GPU_SAFE.rehearse.trueSet`, else the MAP set;
 * - D-NEXT (amends D-173: overview first): the dive never waits on a lane. The engine [open]s the lanes after the
 *   core's READY, one at a time in list order (GROUND → LIFE → BASES), each once the one before it has [settled] or
 *   failed; every work frame it lets each opened lane [adopt] its finished loads, held or not; while the realm waits
 *   behind the globe it calls [update] and [drawOffscreen] on a whole-realm view (never while held), and on the map
 *   with the live view. A pair whose hook cannot draw yet because its inputs are not resident answers [rehearsable]
 *   false: it is asked again shortly and never backs off;
 * - the zoom stops at `farEnd` / `trueStart` while a pair of that set is not rehearsed (or its program still links) for
 *   a lane whose data is in ([readyFor]); a hook that returns false once the lane is ready means "nothing to draw",
 *   final once the lane's [bandSet] is below that set or another of its pairs drew; until then the lane is still
 *   loading (LIFE's texture arrays): the pair is retried, and it holds the dive and the lane meanwhile;
 * - a lane with any un-rehearsed pair of set ≤ max(1, the band set on screen) is HELD: the engine calls none of
 *   [update], [drawOffscreen], [drawGround] and [draw] for it (the core's chart and dots hold the view).
 * With no lane the engine draws the painted chart (`rm-chart`, the web's FAR program, from the first-frame set) and
 * clamps the zoom to FAR (GLOBE-PRODUCTION-PLAN §2.4.1: "Overview mode is the same engine with bands clamped to FAR").
 */
interface RealmLane {
    val name: String
    /** The realm is READY and this lane's turn came (GL thread; again after a context restore, after [dispose]): start
     *  this lane's load for it (map.js `loadModules` → `lane.load(pack)`), reading detail files through
     *  [RealmOpen.loader] on [RealmOpen.executor] and calling [RealmOpen.wake] when a worker result waits for the GL
     *  thread. D-NEXT: the lane before it in the engine's list has settled or failed; [basesChanged] follows at once. */
    fun open(realm: RealmOpen) {}
    /**
     * D-NEXT: move finished worker loads into uploads and poll their residency (GL thread, every work frame while the
     * realm is READY, whether or not the lane is held; never draws, never resolves). A held lane got no [update], so its
     * load waited on the heap until its pairs were rehearsed, and its pairs could not rehearse until its textures were
     * resident. Idempotent within a frame: [update] calls it first.
     */
    fun adopt(nowMs: Double) {}
    /** D-NEXT: can [program]'s [rehearse] hook draw now (every input it binds is resident)? False skips the pair for a
     *  moment (`RealmEngineConfig.notResidentMs`) without counting a failed try, so a lane still uploading never enters
     *  the 1.5 → 6 s retry back-off. */
    fun rehearsable(program: Gl3Program): Boolean = true
    /** Programs whose (program, state) pairs must be rehearsed before the band that uses them (map.js `laneProgs`).
     *  Must return a STABLE list (the same instance until it changes; no allocation per call): the engine polls it
     *  every frame to rebuild its pairs when it changes. */
    fun programs(): List<Gl3Program>
    /** The targets [program]'s real passes draw into: [RealmMapEngine.TARGET_SCREEN] and/or
     *  [RealmMapEngine.TARGET_RGBA] (the k× ground target and the fade snapshot), or [RealmMapEngine.TARGET_OWN] for a
     *  bake program drawn into a target of its own format ([rehearseScratch] supplies the scratch; rehearsed once). */
    fun rehearseTargets(program: Gl3Program): IntArray = SCREEN_AND_RGBA
    /** For a [RealmMapEngine.TARGET_OWN] pair: a small (1×1) texture of [program]'s real target format that the lane
     *  owns; the engine binds it as the rehearsal's scratch (a bake cannot bind its own framebuffer inside a rehearsal:
     *  `Gl3Core.offscreen` refuses there). Null: not ready (retried later). */
    fun rehearseScratch(program: Gl3Program): Gl3Texture? = null
    /** The highest band set (1 = MAP, 2 = TRUE) this lane can draw for the resident realm, 0 = FAR only. */
    fun bandSet(): Int
    /** The lane's load has settled (its falsy rehearsal hooks now mean "nothing to draw"). */
    fun settled(): Boolean
    /** map.js `laneReady`: may this lane's pairs of band [set] (1 MAP, 2 TRUE) gate the zoom yet? GROUND answers with its
     *  `ready.map` / `ready.true` (its data for that band is in); every other lane with [settled]. */
    fun readyFor(set: Int): Boolean = settled()
    /** GROUND's `mapReady(view)` (the FAR→MAP hold), true for other lanes. Not asked of a lane that settled with no
     *  programs (GROUND after a failed load): there is nothing to wait for. */
    fun mapReady(view: RealmView): Boolean = true
    fun update(view: RealmView)
    /** Offscreen work (resolve slices, the lowres ground): only before the screen pass. */
    fun drawOffscreen(view: RealmView) {}
    /** Does this lane draw the ground for [view] (then the core's chart does not)? */
    fun drawsGround(view: RealmView): Boolean = false
    /** web `ground.passes(view)`: the display passes the ground draws for [view], a bitmask of [GROUND_CHART],
     *  [GROUND_MAP], [GROUND_TRUE] (one bit = a lone rest pass, which may render at full resolution; two = a fade).
     *  0 = unknown: the engine derives it from the band weights like map.js `groundPass`. */
    fun groundPasses(view: RealmView): Int = 0
    fun drawGround(view: RealmView) {}
    /** Does this lane draw the bases for [view] (then the core's stand-in occupancy dots do not)? */
    fun drawsBases(view: RealmView): Boolean = false
    /** web `basesMod.pick(sx, sy)`: the base index (in the engine's [RealmBases]) under the CSS px point, −1 for none;
     *  asked before the core's deed-cell pick (keep rects, dome ellipses at MAP/TRUE). */
    fun pickBase(view: RealmView, cssX: Double, cssY: Double): Int = -1
    /** The resident bases, filter or selection changed (map.js `setBases`/`applyFilter`/`pushSelection`). */
    fun basesChanged(bases: RealmBases) {}
    /** A sprite pass after the ground (map.js 'shadow', 'shieldBack', 'sprite', 'shieldFront', 'air', 'fx'). */
    fun draw(view: RealmView, pass: Int) {}
    /** GPU_SAFE.rehearse hook: draw [program] in every state its real passes use, into the bound scratch target;
     *  false when it cannot draw now. [target] is [RealmMapEngine.TARGET_SCREEN], [RealmMapEngine.TARGET_RGBA] or
     *  [RealmMapEngine.TARGET_OWN]. */
    fun rehearse(program: Gl3Program, target: Int, view: RealmView): Boolean
    /** The frame period (ms) this lane's idle animation needs on screen after its last [update] (web
     *  `core.animating(tag, ms)`), 0 for none. The host declares GROUND's under `IdleScheduler.TAG_GROUND` (ground.js
     *  `animating('ground', …)`: the water loop at TRUE, its slow drift at MAP); without it a realm at rest freezes its
     *  water between inputs. LIFE and BASES publish theirs as `animationPeriodMs`, read by the host directly. */
    fun idlePeriodMs(): Int = 0
    fun dispose()

    companion object {
        const val PASS_SHADOW = 0
        const val PASS_SPRITE = 1
        const val PASS_AIR = 2
        const val PASS_FX = 3
        const val PASS_SHIELD_BACK = 4
        const val PASS_SHIELD_FRONT = 5
        const val GROUND_CHART = 1
        const val GROUND_MAP = 2
        const val GROUND_TRUE = 4
        val SCREEN_AND_RGBA = intArrayOf(RealmMapEngine.TARGET_SCREEN, RealmMapEngine.TARGET_RGBA)
    }
}
