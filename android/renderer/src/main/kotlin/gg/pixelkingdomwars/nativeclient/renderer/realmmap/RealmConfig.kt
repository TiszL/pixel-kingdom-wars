package gg.pixelkingdomwars.nativeclient.renderer.realmmap

/**
 * The realm map's presentation constants (web `contracts.js` BANDS, GPU_SAFE, IDLE; `groundcost.js` budgets) as the
 * engine reads them. Production builds these from the generated `WorldEngineConstants.kt` (GLOBE-NATIVE-PLAN §4.3,
 * lane NT) and never from a Kotlin copy, so no web value has a default here (the two native-only values of
 * [RealmEngineConfig] are defaulted: this file is their source). Units follow the web: d = device px per deed, s = CSS
 * px per deed.
 */
class RealmBands(
    val farEnd: Double, val mapStart: Double, val trueStart: Double, val trueFull: Double,
    /** `BANDS.impostor` [from, to]. */
    val impostor: DoubleArray,
    /** `BANDS.rest`: open intervals where the camera may not rest, flattened as [a0, b0, a1, b1, …]. */
    val rest: DoubleArray,
    val restEaseMs: Double,
    val selectD: Double, val myBaseD: Double,
    val twins: DoubleArray, val herds: Double, val creatures: Double, val sway: Double, val snap: Double,
    /** s: the base scene's 64 CSS px per tile. */
    val sMax: Double,
    /** s thresholds of the HUD: cluster counters below [uiDots], icons from [uiIcons]; [keepMinCss] keep marker lift. */
    val uiDots: Double, val uiIcons: Double, val keepMinCss: Double,
) {
    init {
        require(impostor.size == 2 && twins.size == 2 && rest.isNotEmpty() && rest.size % 2 == 0) { "Malformed BANDS" }
        require(farEnd < mapStart && mapStart <= trueStart && trueStart < trueFull) { "BANDS out of order" }
    }

    /** camera.js `EDGES`: every band edge a float d may be snapped onto (distinct, in declaration order). */
    val edges: DoubleArray = doubleArrayOf(farEnd, mapStart, trueStart, trueFull, impostor[0], impostor[1], twins[0], twins[1], snap)
        .distinct().toDoubleArray()
}

/** `GPU_SAFE.rehearse` (the band rehearsal and band readiness contract, W1 S1/S2). */
class RealmRehearsal(
    val idleMs: Double, val gapMs: Double, val retryMs: Double, val retryMaxMs: Double,
    /** The locked scissor box of a rehearsal draw (device px). Native core scissors 1×1; kept for parity reports. */
    val box: Int,
    val stallMs: Double, val mapReadyHoldMs: Double,
    /** Programs that belong to the TRUE set (gate at `trueStart`); every other program is in the MAP set. */
    val trueSet: Set<String>,
    /** Rehearsal order of need. A program not listed ranks after every listed one. */
    val order: List<String>,
) {
    /** core.js `retryAt`. */
    fun retryAt(tries: Int, t: Double): Double = t + minOf(retryMaxMs, retryMs * maxOf(1, tries))
}

/**
 * Everything the engine reads that is not a game number. [groundPx]/[heavy] are `GPU_SAFE.groundPx` (per web level 0,
 * 1) and `GPU_SAFE.heavy` (per web level 0, 1, 2); [chartPassFetches], [mapPassFetches], [truePassFetches],
 * [displayBudget], [resolveBudget] are `groundcost.js` `PASS.chart` / `PASS.map` / `PASS.true`, `DISPLAY_BUDGET`,
 * `RESOLVE_BUDGET` (core.js `fullResPass`); [evictMs] is `IDLE.evictMs`; [coldUploadBytes] is `GPU_SAFE.coldUploadBytes`
 * (the GL-thread upload budget of one frame). [dprCap] is core.js's `Math.min(2, devicePixelRatio)`.
 */
class RealmEngineConfig(
    val bands: RealmBands,
    val rehearsal: RealmRehearsal,
    val groundPx: DoubleArray,
    val heavy: BooleanArray,
    val chartPassFetches: Double,
    val mapPassFetches: Double,
    val truePassFetches: Double,
    val displayBudget: Double,
    val resolveBudget: Double,
    val evictMs: Double,
    val coldUploadBytes: Long,
    val dprCap: Double,
    /** `DEED_PX.thisRealm` / `DEED_PX.otherRealm` (the deeds-mask values). */
    val deedThisRealm: Int, val deedOtherRealm: Int,
    /** `DEED_DEG`: one deed spans this many degrees of lon/lat on the catalog grid. */
    val deedDeg: Double,
    /** Native (D-NEXT, not in contracts.js, so defaulted here, its only source): a realm prepared core-only (the globe's
     *  approach prefetch) and never entered is freed this long after its last prepare. ~8 MB of GL for a dive the player
     *  may take; kept no longer (memory P0: nothing holds a realm nobody wants). */
    val approachEvictMs: Double = APPROACH_EVICT_MS,
    /** Native (D-NEXT, defaulted here, its only source): a lane pair whose inputs are not resident yet
     *  ([RealmLane.rehearsable] false) is asked again this long after, with no failed try counted (two 60 Hz frames). */
    val notResidentMs: Double = NOT_RESIDENT_MS,
) {
    init {
        require(groundPx.size == 2 && heavy.size == 3) { "GPU_SAFE.groundPx has 2 entries and heavy 3" }
        require(coldUploadBytes > 0) { "GPU_SAFE.coldUploadBytes must be positive" }
        require(approachEvictMs > 0 && notResidentMs > 0) { "approachEvictMs and notResidentMs must be positive" }
    }

    /** core.js `divFor`: the smallest integer divisor n (1…4) with dpr / n ≤ px. */
    fun divFor(dpr: Double, px: Double): Int =
        minOf(4.0, maxOf(1.0, Math.ceil(maxOf(dpr, 1e-3) / maxOf(px, 1e-3) - 1e-6))).toInt()

    /** `groundcost.js PASS[pass]`, the worst-case fetches per canvas px of one ground display pass (NaN = unknown). */
    fun passFetches(pass: Int): Double = when (pass) {
        PASS_CHART -> chartPassFetches; PASS_MAP -> mapPassFetches; PASS_TRUE -> truePassFetches; else -> Double.NaN
    }

    /** core.js `fullResPass`: may this lone display pass, drawn alone at rest, render at full resolution (its fetches +
     *  a frame's resolve slices fit the display budget)? At the pin chart 4, MAP 53 and TRUE 22 all do (+ 6 ≤ 64). */
    fun fullResPass(pass: Int): Boolean { val f = passFetches(pass); return !f.isNaN() && f + resolveBudget <= displayBudget }

    /**
     * core.js `groundDiv`: the ground target is the canvas / n. [webLevel] 0 renders a lone rest pass at full
     * resolution when [fullResPass] allows it and a fade at n0; level 1 is n1 everywhere; level 2 one step coarser than
     * level 1. [pass] is the ONE ground display pass drawn ([PASS_CHART], [PASS_MAP], [PASS_TRUE]) or [PASS_NONE] (a
     * cross-fade, two passes, or unknown).
     */
    fun groundDiv(dpr: Double, webLevel: Int, pass: Int): Int {
        val n0 = divFor(dpr, groundPx[0]); val n1 = maxOf(n0, divFor(dpr, groundPx[1]))
        if (webLevel >= 2) return minOf(4, n1 + 1)
        if (webLevel == 1) return n1
        return if (fullResPass(pass)) 1 else n0
    }

    companion object {
        const val PASS_NONE = 0
        const val PASS_CHART = 1
        const val PASS_MAP = 2
        const val PASS_TRUE = 3
        /** [approachEvictMs]'s value (D-NEXT). */
        const val APPROACH_EVICT_MS = 10_000.0
        /** [notResidentMs]'s value (D-NEXT). */
        const val NOT_RESIDENT_MS = 32.0
    }
}

/** One keep level's plot geometry (contracts.js `plotRule`). */
class PlotRule(val level: Int, val claim: Int, val ring: Int, val plotTiles: Int, val wallTier: Int, val wallRings: Int)

/**
 * Plot placement (contracts.js `plotRule`, `plotRoom`, `plotHash`, `plotOffset`, `plotCentre`). The keep-level tables are
 * GAME numbers and arrive from the generated constants catalogue (`CAMPAIGN.claimTilesByKeep`,
 * `CAMPAIGN_LAYOUT.wallRingsByKeep`, `BASE_GROUND_WORLD_GEOMETRY.worldTiles`); [plotCentre] and the `PLOT_OFFSET`
 * margins and salt are the web's presentation constants. Integer maths only, so every value equals the web and the
 * GLSL twin (`common.glsl.js plotHash/plotOffset`) exactly. Visual only: the deed stays the unit of picking and
 * selection; a plot's centre is where the minimap dot, fly targets and tags aim.
 */
class RealmPlotRules(
    claimTilesByKeep: IntArray,
    wallRingsByKeep: IntArray,
    /** Tiles per deed (98). */
    val tiles: Int,
    /** Deed-local centre of every plot, tiles (49). */
    val plotCentre: Int,
    val lensMargin: Int, val rimGap: Int, val plotMargin: Int, val salt: Int,
) {
    private val claims = claimTilesByKeep.copyOf()
    private val walls = wallRingsByKeep.copyOf()
    val maxLevel: Int = claims.size
    private val rules: Array<PlotRule>
    private val rooms: IntArray

    init {
        require(claims.isNotEmpty() && claims.size == walls.size) { "Keep-level tables disagree" }
        require(tiles > 0 && plotCentre in 1 until tiles) { "Bad deed geometry" }
        rules = Array(claims.size) { i ->
            val level = i + 1; val claim = claims[i]; val ring = 4 + Math.floorDiv(level, 4)
            PlotRule(level, claim, ring, claim + 2 * ring, (level + 3) / 4, walls[i])
        }
        rooms = IntArray(claims.size) { i ->
            val p = rules[i]
            maxOf(0, plotCentre - lensMargin - rimGap - plotMargin - p.ring - (p.claim + 1) / 2)
        }
    }

    /** JS `Math.min(max, Math.max(1, Math.round(level) || 1))`: NaN and 0 become level 1; .5 rounds up. */
    fun clampLevel(level: Double): Int {
        val r = Math.floor(level + 0.5)
        val l = if (r.isNaN() || r == 0.0) 1.0 else r
        return minOf(maxLevel.toDouble(), maxOf(1.0, l)).toInt()
    }

    fun rule(level: Int): PlotRule = rules[clampLevel(level.toDouble()) - 1]

    /** Offset budget per axis at a keep level, whole tiles. */
    fun room(level: Int): Int = rooms[clampLevel(level.toDouble()) - 1]

    /** uint32 hash of a deed (realm-grid col, row), as an Int bit pattern. */
    fun hash(deedX: Int, deedY: Int): Int {
        var h = (deedX * 0x8da6b343.toInt()) xor (deedY * 0xd8163841.toInt()) xor salt
        h = h xor (h ushr 16); h *= 0x7feb352d; h = h xor (h ushr 15); h *= 0x846ca68b.toInt(); h = h xor (h ushr 16)
        return h
    }

    private fun axis(v: Int, room: Int): Int {
        val t = 2 * v - 65535
        val m = (Math.abs(t) * room + 32767) / 65535
        return if (t < 0) -m else m
    }

    /** Whole-tile x offset of the plot centre from the deed centre. */
    fun offsetX(deedX: Int, deedY: Int, level: Int): Int = axis(hash(deedX, deedY) and 0xffff, room(level))
    fun offsetY(deedX: Int, deedY: Int, level: Int): Int = axis(hash(deedX, deedY) ushr 16, room(level))

    /** The plot centre in realm deed units (a centred plot is x + 0.5). */
    fun centreX(deedX: Int, deedY: Int, level: Int): Double = deedX + (plotCentre + offsetX(deedX, deedY, level)).toDouble() / tiles
    fun centreY(deedX: Int, deedY: Int, level: Int): Double = deedY + (plotCentre + offsetY(deedX, deedY, level)).toDouble() / tiles
}
