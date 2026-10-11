package gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.bases

import gg.pixelkingdomwars.nativeclient.renderer.world.PassCost

/**
 * BASES in the whole-frame cost model (GLOBE-NATIVE-PLAN §5.2, `WorldFrameCost`): an UPPER BOUND on what [BasesLane]
 * draws for a view, per pass, from the kingdoms' pure compositions ([Decor.compose]) and the lane's draw rules:
 *
 * - `bases-field` (shadow pass): every tended ground cell of a live kingdom (1 tile each, plus a fillet in any empty cell
 *   beside one) and every settled path segment between kingdoms (a quad `len + 2e` by `2e`, e = [PATH_HW] + 0.8 tiles,
 *   FIELD_VS); ≤ [LINKS_PER_KINGDOM] links of ≤ PATHS.maxDeeds per kingdom (basePathsJob: a nearest and a second link).
 * - `bases-sprite` (sprite pass): a live kingdom's keep at `keepScale(level, d)`, its decor, walls and plot edge as the
 *   ink boxes the atlas trims to ([Decor.inkRect]) — once as MAP minis while `trueW < 1`, once as TRUE sprites while
 *   `trueW > 0` (both inside the MAP→TRUE fade), plus its chimney smoke (2 sprites per emitter from the smoke band); a
 *   marker icon (`iconLook` width, square) with its tower sprites; 2 texel fetches per fragment (SPRITE_FS).
 * - `bases-shield` back and front: one quad each per dome (SHIELD_VS: `(2rx + 3) × (1.35rx + 3)` tiles, rx = claim / 2 + 2),
 *   domes capped at SHIELD.mapCap / trueCap (bases.js). SHIELD_FS has no fetch: its cost is ALU (8 loop trips), which
 *   stays unmodelled (NaN) until the Mali Offline Compiler report, so WorldFrameCost reports these passes.
 * - `bases-fx` (pennants, torch glows) and `bases-dot` (FAR dots): no fetch; ALU unmodelled likewise.
 *
 * Every vertex stage of BASES fetches nothing (`BasesCostTest` walks them); 6 vertices per instance. Each quad's shaded
 * px is clamped to the buffer (a quad larger than the screen shades the screen once). Not frame code: it allocates.
 */
class BasesCost(private val decor: Decor, private val bands: BasesBandsIn) {
    private val t = decor.t
    private val tiles = decor.game.tilesPerDeed.toDouble()

    /** One kingdom's drawn geometry at keep scale 1, tiles² (and instance counts), from its pure composition. */
    class Kingdom(
        val level: Int, val realm: String,
        /** Decor + walls + plot edge: Σ ink-box area, and how many sprites. */
        val decorArea: Double, val decorSprites: Int,
        /** The keep's ink box at scale 1. */
        val keepArea: Double,
        /** Tended ground cells and the fillet bound (empty cells beside them). */
        val groundCells: Int, val filletCells: Int,
        val claim: Int, val smokeEmitters: Int, val glowArea: Double, val glows: Int, val pennants: Int,
    )

    /** The kingdom [decor] composes for (level, realm, seed) with every gate linked (the most lanes). */
    fun kingdom(level: Int, realm: String, seed: Long): Kingdom {
        val dec = decor.compose(level, realm, seed, t.gateSides)
        var area = 0.0; var n = 0
        val edges = decor.edgeSprites(dec).let { a -> val b = decor.edgeAutotileSprites(dec); if (sum(b) > sum(a)) b else a } // the lane draws one of them
        for (list in arrayOf(dec.sprites, decor.wallSprites(dec), edges)) for (s in list) { area += inkArea(s); n++ }
        val k = decor.keepInkRect(level)
        val tl = decor.game.tilesPerDeed
        val cells = HashSet<Int>()
        for (lane in dec.lanes.values) for (c in lane) cells += c[1] * tl + c[0]
        for (g in dec.ground) cells += g.y * tl + g.x
        val fillets = HashSet<Int>()
        for (c in cells) for (e in intArrayOf(c - tl, c + 1, c + tl, c - 1)) if (!cells.contains(e)) fillets += e
        var smoke = 0; var glowA = 0.0; var glows = 0; var pennants = 0
        for (e in dec.emitters) when (e.kind) {
            "smoke" -> smoke++
            "glow" -> { glows++; val r = (e.r ?: 0.0) / decor.game.art; glowA += 4 * r * r }
            "pennant" -> pennants++
        }
        return Kingdom(level, realm, area, n, (k.x1 - k.x0) * (k.y1 - k.y0), cells.size, fillets.size, decor.plots.rule(level).claim, smoke, glowA, glows, pennants)
    }

    private fun inkArea(s: DecorSprite): Double { val r = decor.inkRect(s); return (r.x1 - r.x0) * (r.y1 - r.y0) }
    private fun sum(l: List<DecorSprite>): Double { var a = 0.0; for (s in l) a += inkArea(s); return a }

    /** What one frame draws, as counts (a view's bound from [bound], or a live frame's own tallies). */
    class Frame(
        /** Device px per deed and device px per CSS px. */
        val d: Double, val dpr: Double,
        /** Kingdoms drawn live (keep + decor), as marker icons, as FAR dots. */
        val live: Int, val icons: Int, val dots: Int,
        /** Shield domes drawn (after the caps) and settled paths in view. */
        val domes: Int, val links: Int,
    ) {
        val s: Double get() = d / dpr
    }

    /**
     * The view's worst case: every deed in the view rect (± 1 deed, the lane's pad) holds a kingdom of [k], shielded
     * (domes capped), each with [LINKS_PER_KINGDOM] paths. [occupancy] (0..1] scales the kingdoms (the realm's share of
     * claimed deeds). Modes as the lane picks them (bases.js `baseMode`, [BasesRules.baseMode]): each base is ONE of dot,
     * icon or live keep, dithered by a uniform per-base hash, so a share iconW of the bases are icons or keeps (0 at
     * UI_DOTS, all from UI_ICONS) and a share keepW of those are live keeps (0 at IMPOSTOR[0], all from IMPOSTOR[1]);
     * the counts are those shares rounded up. (Counting every base at its heaviest mode instead charged the dive's MAP
     * landing, s = UI_DOTS on the dpr-2 buffer where every base is still a dot, with hundreds of overlapping icons.)
     */
    fun bound(d: Double, dpr: Double, bufferW: Int, bufferH: Int, occupancy: Double = 1.0): Frame {
        val deeds = (bufferW / d + 2 * PAD) * (bufferH / d + 2 * PAD)
        val n = Math.ceil(deeds * occupancy).toInt()
        val s = d / dpr
        val iconW = clamp01((s - bands.uiDots) / (bands.uiIcons - bands.uiDots))
        val keepW = clamp01((d - bands.impostor0) / (bands.impostor1 - bands.impostor0))
        val shown = if (s >= bands.uiIcons) n else Math.ceil(n * iconW).toInt()
        val live = if (d >= bands.impostor1) shown else Math.ceil(shown * keepW).toInt()
        val icons = shown - live
        val dots = n - shown
        val cap = if (d >= bands.trueFull) t.shieldTrueCap else t.shieldMapCap
        return Frame(d, dpr, live, icons, dots, Math.min(n, cap), (live + icons) * LINKS_PER_KINGDOM)
    }

    /** The frame's BASES passes on a [bufferW] × [bufferH] buffer for kingdoms shaped like [k]. */
    fun passes(k: Kingdom, f: Frame, bufferW: Int, bufferH: Int): List<PassCost> {
        val bufferPx = bufferW.toDouble() * bufferH
        val pxTile = f.d / tiles // device px per tile
        val a2 = pxTile * pxTile
        fun clampPx(px: Double) = Math.min(px, bufferPx)
        val trueW = clamp01((f.d - bands.trueStart) / (bands.trueFull - bands.trueStart))
        val keepScale = decor.keepScale(k.level, f.d)

        // shadow pass: tended ground and the paths between kingdoms (fade in from IMPOSTOR[0] − 50)
        val pathOn = f.d >= bands.impostor0 - 50
        val e = PATH_HW + 0.8
        val linkTiles = t.paths.maxDeeds * tiles
        val segs = Math.max(4.0, Math.ceil(linkTiles / t.paths.stepTiles))
        val linkPx = clampPx((linkTiles + 2 * e * segs) * 2 * e * a2)
        val groundPx = clampPx((k.groundCells + k.filletCells) * a2)
        val fieldPx = f.live * groundPx + (if (pathOn) f.links * linkPx else 0.0)
        val fieldN = f.live.toLong() * (k.groundCells + k.filletCells) + (if (pathOn) f.links.toLong() * segs.toLong() else 0L)

        // sprite pass: keeps, minis / TRUE decor, smoke, icons and their towers
        val keepPx = clampPx(k.keepArea * keepScale * keepScale * a2)
        val decorPx = clampPx(k.decorArea * a2)
        val copies = (if (trueW < 1) 1 else 0) + (if (trueW > 0) 1 else 0)
        val smokeOn = f.s >= bands.smoke
        val smokePx = if (smokeOn) clampPx(k.smokeEmitters * 2 * SMOKE_TILES * SMOKE_TILES * a2) else 0.0
        val iconCss = bands.keepMinCss * ICON_MAX_GROWTH
        val iconSide = iconCss * f.dpr
        val towers = if (k.level >= 18) 3 else if (k.level >= 15) 2 else if (k.level >= 12) 1 else 0
        val iconPx = clampPx(iconSide * iconSide * (1 + towers * TOWER_SHARE * TOWER_SHARE))
        val spritePx = f.live * (keepPx + copies * decorPx + smokePx) + f.icons * iconPx
        val spriteN = f.live.toLong() * (1 + copies * k.decorSprites + (if (smokeOn) 2 * k.smokeEmitters else 0)) + f.icons.toLong() * (1 + towers)

        // shields: back and front, one quad each per dome
        val rx = k.claim / 2.0 + 2
        val domePx = clampPx((2 * rx + 3) * (1.35 * rx + 3) * a2)

        // fx: pennants (≥ 20 px keeps) and TRUE torch glows; dots at FAR
        val pennantPx = k.pennants * clampPx(PENNANT_TILES * keepScale * PENNANT_TILES * keepScale * 4.0 / 6 * a2)
        val glowPx = if (trueW > 0) clampPx(k.glowArea * a2) else 0.0
        val fxPx = f.live * (pennantPx + glowPx)
        val dotSide = DOT_CSS_MAX * f.dpr
        val dotPx = f.dots * dotSide * dotSide

        return listOf(
            PassCost("bases-field", coverage = fieldPx / bufferPx, fetchesPerFragment = FIELD_FS.toDouble(), vertices = VERTICES * fieldN, vsFetchesPerVertex = 0.0),
            PassCost("bases-shield back", coverage = f.domes * domePx / bufferPx, fetchesPerFragment = SHIELD_FS.toDouble(), vertices = VERTICES * f.domes, vsFetchesPerVertex = 0.0),
            PassCost("bases-sprite", coverage = spritePx / bufferPx, fetchesPerFragment = SPRITE_FS.toDouble(), vertices = VERTICES * spriteN, vsFetchesPerVertex = 0.0),
            PassCost("bases-shield front", coverage = f.domes * domePx / bufferPx, fetchesPerFragment = SHIELD_FS.toDouble(), vertices = VERTICES * f.domes, vsFetchesPerVertex = 0.0),
            PassCost("bases-fx", coverage = fxPx / bufferPx, fetchesPerFragment = FX_FS.toDouble(), vertices = VERTICES * f.live * (k.pennants + (if (trueW > 0) k.glows else 0)), vsFetchesPerVertex = 0.0),
            PassCost("bases-dot", coverage = dotPx / bufferPx, fetchesPerFragment = DOT_FS.toDouble(), vertices = VERTICES * f.dots, vsFetchesPerVertex = 0.0),
        )
    }

    private fun clamp01(v: Double) = Math.min(1.0, Math.max(0.0, v))

    companion object {
        /** Texel fetches per fragment of the exported BASES stages (`BasesCostTest` walks them); every BASES vertex stage fetches 0. */
        const val SPRITE_FS = 2
        const val FIELD_FS = 1
        const val SHIELD_FS = 0
        const val FX_FS = 0
        const val DOT_FS = 0
        /** SHIELD_FS loop trips per fragment (ALU only). */
        const val SHIELD_ITERS = 8
        const val VERTICES = 6L
        /** FIELD_VS path half width, tiles (the lane's `uPathHW`). */
        const val PATH_HW = 1.0
        /** The lane culls kingdoms to the view rect ± 1 deed. */
        const val PAD = 1.0
        /** basePathsJob links a kingdom to its nearest and a second neighbour. */
        const val LINKS_PER_KINGDOM = 2
        /** iconLook's widest icon: (1 + 0.34) × (0.94 + 0.12) of KEEP_MIN_CSS. */
        const val ICON_MAX_GROWTH = 1.34 * 1.06
        /** A flanking tower sprite is at most 0.7 of the icon's height (iconLook), counted square. */
        const val TOWER_SHARE = 0.7
        /** A chimney smoke sprite (kit smoke_drift, 32 art px = 1 tile), a pennant (6 art px wide at keep scale 1, in tiles). */
        const val SMOKE_TILES = 1.0
        const val PENNANT_TILES = 6.0 / 32
        /** The largest FAR dot, CSS px (yours: clamp(s · 0.45, 4, 6)). */
        const val DOT_CSS_MAX = 6.0
    }
}
