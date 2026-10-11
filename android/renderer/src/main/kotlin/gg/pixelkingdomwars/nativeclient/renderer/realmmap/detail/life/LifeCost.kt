package gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life

import gg.pixelkingdomwars.nativeclient.renderer.world.PassCost

/**
 * LIFE in the whole-frame cost model (GLOBE-NATIVE-PLAN §5.2, `WorldFrameCost`): the passes one PLANNED frame issues,
 * read off a [LifePlanner] after `plan()` exactly as [LifeLane.draw] submits them, per program.
 *
 * - **Vertex work** (the dominant term at MAP): 6 vertices per submitted instance (life.js `quads`:
 *   `drawArraysInstanced(TRIANGLES, 0, 6, n)`), every instance submitted once per texture array its group may live in
 *   (the planner's `submittedTotal` multiplicities), and every vertex runs the whole placement (rank, class lookup,
 *   density, species pick) before it can cull. Each vertex is priced at its program's WORST-PATH fetch count ([SCATTER_VS]
 *   …: both arms of every branch, loops × their literal trips, walked from `main()` of the exported stage; `LifeCostTest`
 *   re-walks the shipped bytes, so a new fetch cannot land unseen). An instance culled early costs less on the GPU: an
 *   upper bound, like groundcost.js.
 * - **Fragment work**: an upper bound on shaded px. An instance shades its whole layer quad (SPRITE_FS discards on alpha,
 *   so every fragment of the quad runs, and sprites are not depth-sorted), at most one per submitted cell and only where
 *   its group's densest class lets one stand (count × max density), at the species-weighted mean layer area, scaled to the
 *   buffer (d device px per deed). Layer sizes are the loaded ones when the lane built its arrays ([LifeSprite.lw]), else
 *   the size class the loader would pick (`LifeLoad.place`: the first class that holds the frame).
 * - The **air pass** (emitter puffs, particles, the birds' air copy) only when [passes]' `air` is true: the engine skips
 *   it in GPU safe mode (`RealmView.safe`, ladder L2+), where reduced motion also stops the planner's birds and ambience.
 *
 * ALU is unmodelled (NaN) until the Mali Offline Compiler report; `WorldFrameCost` counts those passes. Not frame code:
 * it allocates its result (tests and the ladder calibration read it), never called inside a frame.
 */
class LifeCost(private val sc: Scatter, val life: CLife) {
    private val c = sc.c
    /** Art px per map-art px (the twin scale: `k = uMode == 2 ? 7.0 : 1.0` in SCATTER_VS). */
    private val mapK = sc.geo.deedArt.toDouble() / sc.geo.mapArt

    /** Per group: species-weighted mean quad area, art px², of the kit art and of the twin; the weight share of emitters; the densest class (0..1). */
    val kitArea = DoubleArray(life.groups.size)
    val twinArea = DoubleArray(life.groups.size)
    val emitShare = DoubleArray(life.groups.size)
    val groupDensity = DoubleArray(life.groups.size)
    /** Stands: mean member quad (art px²), mean members per variant, mean clump quad (art px², map art × 7²), densest mix class. */
    val memberArea: Double; val membersPerSite: Double; val clumpArea: Double; val standDensity: Double
    val creatureArea: Double; val creatureDensity: Double
    /**
     * life-scatter's fragment fetches for this realm: [SCATTER_FS] when its LIFE has a glowing species (a map-only group's
     * species with a lens anchor: the only fragments that take SPRITE_FS's LIFE_GLOW branch, stage B), else [SPRITE_FS].
     * Still an upper bound where it is 2 (every scatter fragment of such a realm is charged the lens fetch).
     */
    val scatterFs: Int = if (life.groups.any { g -> g.mapOnly && g.species.any { it.glow != null } }) SCATTER_FS else SPRITE_FS

    init {
        for ((gi, g) in life.groups.withIndex()) {
            var w = 0.0; var ka = 0.0; var ta = 0.0; var em = 0.0
            for (s in g.species) { w += s.w; ka += s.w * kitQuad(s.sp); ta += s.w * twinQuad(s.sp); if (s.emit != null) em += s.w }
            kitArea[gi] = if (w > 0) ka / w else 0.0; twinArea[gi] = if (w > 0) ta / w else 0.0; emitShare[gi] = if (w > 0) em / w else 0.0
            groupDensity[gi] = densest(g.density)
        }
        val st = life.stands
        if (st != null && st.variants.isNotEmpty()) {
            var n = 0; var a = 0.0; var cl = 0.0
            for (v in st.variants) { for (m in v.members) { a += kitQuad(st.species[m.s].sp); n++ }; cl += clumpQuad(v, st) }
            memberArea = if (n > 0) a / n else 0.0; membersPerSite = n.toDouble() / st.variants.size; clumpArea = cl / st.variants.size
            standDensity = st.mixes.maxOfOrNull { densest(it.density) } ?: 0.0
        } else { memberArea = 0.0; membersPerSite = 0.0; clumpArea = 0.0; standDensity = 0.0 }
        val cr = life.creatures
        creatureArea = cr?.species?.maxOfOrNull { if (it.sh.lw > 0) it.sh.lw.toDouble() * it.sh.lh else classArea(c.sizeClasses, CREATURE_CELL, CREATURE_CELL) } ?: 0.0
        creatureDensity = if (cr != null) densest(cr.density) else 0.0
    }

    private fun densest(a: IntArray): Double { var m = 0; for (v in a) m = Math.max(m, v); return m / 65535.0 }
    private fun classArea(classes: Array<IntArray>, w: Int, h: Int): Double {
        for (k in classes) if (w <= k[0] && h <= k[1]) return k[0].toDouble() * k[1]
        return w.toDouble() * h // too large for any class: the loader drops it; its own size bounds it
    }
    /** The kit layer quad (`size = t2.xy`, art px²). */
    private fun kitQuad(sp: LifeSprite): Double = if (sp.lw > 0) sp.lw.toDouble() * sp.lh else classArea(c.sizeClasses, sp.w, sp.h)
    /** The twin quad (`t5.y` layer in map-art px, drawn × 7 art px). */
    private fun twinQuad(sp: LifeSprite): Double {
        val t = sp.twin
        val m = if (t != null) t.lw.toDouble() * t.lh else classArea(c.twinClasses, ceilDiv(sp.w), ceilDiv(sp.h))
        return m * mapK * mapK
    }
    private fun ceilDiv(v: Int): Int = Math.ceil(v / mapK).toInt()
    /** A stand's clump layer (`composeStands`: its members reduced 7× where they stand), map-art px × 7² . */
    private fun clumpQuad(v: CVariant, st: CStands): Double {
        v.clump?.let { return it.lw.toDouble() * it.lh * mapK * mapK }
        var x0 = Double.POSITIVE_INFINITY; var y0 = Double.POSITIVE_INFINITY; var x1 = Double.NEGATIVE_INFINITY; var y1 = Double.NEGATIVE_INFINITY
        for (m in v.members) {
            val sp = st.species[m.s].sp
            x0 = Math.min(x0, m.dx - sp.ax); y0 = Math.min(y0, m.dy - sp.ay); x1 = Math.max(x1, m.dx - sp.ax + sp.w); y1 = Math.max(y1, m.dy - sp.ay + sp.h)
        }
        if (x1 <= x0) return 0.0
        return classArea(c.twinClasses, Math.ceil((x1 - x0) / mapK).toInt(), Math.ceil((y1 - y0) / mapK).toInt()) * mapK * mapK
    }

    /** Instances the frame submits per program (the split of [LifePlanner.total]; the test pins that they sum to it). */
    class Submitted {
        var scatter = 0L; var puffs = 0L; var stand = 0L; var merged = 0L; var creature = 0L; var bird = 0L; var particle = 0L
        val total: Long get() = scatter + puffs + stand + merged + creature + bird + particle
    }

    /** [LifePlanner.submittedTotal], split by the program and pass that draws it (life.js drawScatter/Stands/Creatures/Birds/Particles). */
    fun submitted(p: LifePlanner, out: Submitted = Submitted()): Submitted {
        out.scatter = 0; out.puffs = 0; out.stand = 0; out.merged = 0; out.creature = 0; out.bird = 0; out.particle = 0
        for (e in p.groups) {
            val puffs = e.g.submit?.puffs ?: 0 // the planner's kitK counts the puff draws with the kit draws
            if (e.hasKit) { out.scatter += e.kit.count.toLong() * (e.kitK - puffs); out.puffs += e.kit.count.toLong() * puffs }
            if (e.hasTw) out.scatter += (if (e.twIsKit) e.kit.count else e.tw.count).toLong() * e.twK
        }
        val ss = life.stands?.submit
        if (p.stands.active) { out.stand += p.stands.members.toLong() * (ss?.members ?: 1) + p.stands.clumps.toLong() * (ss?.clumps ?: 1); out.merged += p.stands.merged.toLong() * (ss?.clumps ?: 1) }
        if (p.creatures.active) out.creature += p.creatures.count
        if (p.birds.active) out.bird += p.birds.count.toLong() * (life.birds?.submit ?: 1)
        for (j in 0 until p.ambienceCount) out.particle += p.ambience[p.ambienceOn[j]].count
        return out
    }

    /**
     * The frame's LIFE passes on a [bufferW] × [bufferH] buffer after [LifePlanner.plan] at device px per deed [LifePlanner.planD].
     * [air]: the air pass runs (`!RealmView.safe`). Birds draw twice when the air array exists (a ground shadow in the
     * shadow pass, the bird in the air pass): both are in [Submitted.bird]; without [air] only the shadow half remains.
     */
    fun passes(p: LifePlanner, bufferW: Int, bufferH: Int, air: Boolean): List<PassCost> {
        val n = submitted(p)
        val bufferPx = bufferW.toDouble() * bufferH
        val px = p.planD / sc.geo.deedArt // buffer px per art px
        val a2 = px * px
        var kitPx = 0.0; var puffPx = 0.0
        for ((gi, e) in p.groups.withIndex()) {
            val dens = groupDensity[gi]
            if (e.hasKit) {
                // kit art stands in [0, truHi): the twin range [truHi, twinHi) of a twin group is drawn as twins below
                val kitCells = if (e.hasTw && !e.twIsKit) Math.max(0, e.kit.count - e.tw.count) else if (e.twIsKit) 0 else e.kit.count
                kitPx += kitCells * dens * kitArea[gi] * a2
                puffPx += e.kit.count * dens * emitShare[gi] * (e.g.submit?.puffs ?: 0) * PUFF_ART * PUFF_ART * a2
            }
            if (e.hasTw) kitPx += (if (e.twIsKit) e.kit.count else e.tw.count) * dens * twinArea[gi] * a2
        }
        val st = p.stands
        val standPx = if (st.active) (st.mem.count * membersPerSite * memberArea + st.clu.count * clumpArea) * standDensity * a2 else 0.0
        val mergedPx = if (st.active) st.merged * standDensity * clumpArea * MERGE_AREA * a2 else 0.0
        val creaturePx = if (p.creatures.active) p.creatures.count * creatureDensity * p.creatures.keep * creatureArea * a2 else 0.0
        val sky = p.birds.scale
        val birdOnePx = if (p.birds.active) p.birds.count * p.birds.keep * BIRD_ART * BIRD_ART * sky * sky * a2 else 0.0
        var particlePx = 0.0
        for (j in 0 until p.ambienceCount) { val e = p.ambience[p.ambienceOn[j]]; particlePx += e.count * e.keep * densest(e.ambience!!.density) * PARTICLE_ART * PARTICLE_ART * a2 }
        val birdDraws = life.birds?.submit ?: 1
        val birdShadowN = if (birdDraws >= 2) n.bird / birdDraws else n.bird
        return buildList {
            add(pass("life-scatter", n.scatter, SCATTER_VS, kitPx / bufferPx, scatterFs))
            add(pass("life-stand", n.stand, STAND_VS, standPx / bufferPx, SPRITE_FS))
            add(pass("life-stand-merged", n.merged, STAND_VS, mergedPx / bufferPx, SPRITE_FS))
            add(pass("life-creature", n.creature, CREATURE_VS, creaturePx / bufferPx, SPRITE_FS))
            add(pass("life-bird shadow", birdShadowN, BIRD_VS, birdOnePx / bufferPx, AIR_FS))
            if (air) {
                add(pass("life-scatter puffs", n.puffs, SCATTER_VS, puffPx / bufferPx, scatterFs)) // the same program as life-scatter
                add(pass("life-bird", n.bird - birdShadowN, BIRD_VS, if (n.bird > birdShadowN) birdOnePx / bufferPx else 0.0, AIR_FS))
                add(pass("life-particle", n.particle, PARTICLE_VS, particlePx / bufferPx, AIR_FS))
            }
        }
    }

    private fun pass(name: String, instances: Long, vs: Int, coverage: Double, fs: Int) = PassCost(name, coverage = coverage, fetchesPerFragment = fs.toDouble(),
        vertices = VERTICES * instances, vsFetchesPerVertex = vs.toDouble())

    companion object {
        /** Worst-path texel fetches per vertex of the exported LIFE vertex stages (`LifeCostTest` walks them from `main()`).
         *  Stage B (web 69fb02c2): SCATTER_VS's three species picks became ≤ 7-fetch lower-bound searches (were 32-trip
         *  scans, 184 → 110 with the lens glow's one T4 fetch); CREATURE_VS's and BIRD_VS's one pick likewise (532 → 507, 41 → 16). */
        const val SCATTER_VS = 110
        /** life-stand and life-stand-merged (+STAND_MERGED=1) walk to the same bound (both arms of the #ifdef'd paths are one stage each). */
        const val STAND_VS = 502
        const val CREATURE_VS = 507
        const val BIRD_VS = 16
        const val PARTICLE_VS = 26
        /** Texel fetches per fragment: SPRITE_FS one `textureGrad` (bilinear: LINEAR_MIPMAP_NEAREST), AIR_FS one. */
        const val SPRITE_FS = 1
        /**
         * life-scatter's SPRITE_FS (stage B, web 69fb02c2): compiled with `LIFE_GLOW`, whose lens branch adds one `texelFetch`
         * of the lens colour. The other sprite programs compile that arm out, so they stay at [SPRITE_FS]: `LifeCostTest`
         * walks each stage and discounts a `LIFE_GLOW` arm only where the stage does not define it (the walker itself reads
         * every `#ifdef` arm, as STAND_VS's both STAND_MERGED arms show). Only a realm with a glowing species takes the
         * branch at run time: see [scatterFs].
         */
        const val SCATTER_FS = 2
        const val AIR_FS = 1
        /** Vertices per instance (two triangles, no index reuse). */
        const val VERTICES = 6L
        /** Quad sides, art px: an emitter puff (SCATTER_VS `size = vec2(32.0)`), a bird and a particle (the 32-px air layer). */
        const val PUFF_ART = 32.0
        const val BIRD_ART = 32.0
        const val PARTICLE_ART = 32.0
        /** A creature sheet frame when the pack's sheet is not loaded (bases.js/life.js default cell, 64 art px). */
        const val CREATURE_CELL = 64
        /** A merged block draws its first stand's clump doubled (STAND_VS `k = 14.0`: STAND.merge 2 per axis). */
        const val MERGE_AREA = 4.0
    }
}
