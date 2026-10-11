package gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life

import gg.pixelkingdomwars.nativeclient.renderer.generated.WorldEngineConstants.Bands
import gg.pixelkingdomwars.nativeclient.renderer.generated.WorldEngineConstants.GpuSafe
import gg.pixelkingdomwars.nativeclient.renderer.generated.WorldShaders
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.ground.GroundShaderRulesTest
import gg.pixelkingdomwars.nativeclient.renderer.world.FrameLadder
import gg.pixelkingdomwars.nativeclient.renderer.world.LadderInputs
import gg.pixelkingdomwars.nativeclient.renderer.world.LadderPolicy
import gg.pixelkingdomwars.nativeclient.renderer.world.PassCost
import gg.pixelkingdomwars.nativeclient.renderer.world.SeekerRow
import gg.pixelkingdomwars.nativeclient.renderer.world.SeekerRows
import gg.pixelkingdomwars.nativeclient.renderer.world.WorldFrameCost
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * LIFE's whole-frame cost model ([LifeCost]) on the stages and tables that ship. Why it matters: the Seeker's hang guard
 * tripped at the MAP band on L0 while the frame model carried no LIFE at all, so its "ceilings" could not see the pass
 * that submits up to 40k instances × 6 vertices, each running the whole placement. The model's inputs must be the
 * shipped bytes (a new fetch in a LIFE stage moves the constant or fails here), its instance counts must be exactly what
 * the planner submits, and the ladder's LIFE knob must cut what the model says it cuts.
 */
class LifeCostTest {
    private val walker = GroundShaderRulesTest() // the one GLSL walker (groundcost.test's port): Rule 7, no second copy

    private fun walk(key: String, vertex: Boolean): GroundShaderRulesTest.Walk {
        val p = WorldShaders.realm[key] ?: error("$key is not exported")
        return walker.walk(WorldShaders.source(if (vertex) p.vs else p.fs))
    }

    @Test fun `the fetch counts are the worst paths walked from main() of the exported LIFE stages`() {
        // every LIFE program the lane draws is priced: a key the lane loads that this map misses would go unpriced
        val vs = mapOf(LifeLane.K_SCATTER to LifeCost.SCATTER_VS, LifeLane.K_STAND to LifeCost.STAND_VS, LifeLane.K_STAND_MERGED to LifeCost.STAND_VS,
            LifeLane.K_CREATURE to LifeCost.CREATURE_VS, LifeLane.K_BIRD to LifeCost.BIRD_VS, LifeLane.K_PARTICLE to LifeCost.PARTICLE_VS)
        assertEquals(LifeLane.PROGRAM_KEYS.toSet(), vs.keys)
        for ((key, want) in vs) assertEquals("$key vertex fetches", want.toLong(), walk(key, true).fetches)
        // stage B: SPRITE_FS carries a LIFE_GLOW lens branch (one texelFetch). The walker reads every #ifdef arm, but only
        // life-scatter defines LIFE_GLOW: pricing the compiled-out arm in the other programs would double their fragment
        // fetches (and flip the whole-frame ladder's L1→L2 step at sunscar d 200). So the arm is discounted where undefined.
        val fs = mapOf(LifeLane.K_SCATTER to LifeCost.SCATTER_FS, LifeLane.K_STAND to LifeCost.SPRITE_FS, LifeLane.K_STAND_MERGED to LifeCost.SPRITE_FS,
            LifeLane.K_CREATURE to LifeCost.SPRITE_FS)
        for ((key, want) in fs) {
            val src = WorldShaders.source(WorldShaders.realm.getValue(key).fs)
            val defined = Regex("^#define LIFE_GLOW\\b", RegexOption.MULTILINE).containsMatchIn(src)
            val arm = glowArmFetches(src)
            assertEquals("$key: SPRITE_FS's LIFE_GLOW arm fetches the lens colour once", 1L, arm)
            assertEquals("$key: LIFE_GLOW is defined only in life-scatter", key == LifeLane.K_SCATTER, defined)
            assertEquals("$key fragment fetches", want.toLong(), walk(key, false).fetches - (if (defined) 0 else arm))
        }
        for (key in listOf(LifeLane.K_BIRD, LifeLane.K_PARTICLE)) assertEquals("$key fragment fetches", LifeCost.AIR_FS.toLong(), walk(key, false).fetches)
    }

    /**
     * The lens fetch is charged where a fragment can take it: SPRITE_FS's LIFE_GLOW branch runs only for a glowing species
     * (vGlow.z > 0: a map-only species with a lens anchor), so a realm whose LIFE has none prices its scatter at SPRITE_FS.
     * Charging it on every realm (a fetch that never runs off Solana Reach) tipped the whole-frame ladder's L1→L2 step at
     * cinderfall d 200 under a fifth (RealmOverviewCostLanesTest). At the pin only Solana Reach's beacons glow.
     */
    @Test fun `only a realm with a glowing species pays the lens fetch on its scatter fragments`() {
        val glowing = LaneCostFixture.REALMS.filter { LaneCostFixture.life(it).cost.scatterFs == LifeCost.SCATTER_FS }
        assertEquals(listOf("seeker-reach"), glowing)
        for (realm in LaneCostFixture.REALMS) {
            val passes = LaneCostFixture.lifePasses(realm, SeekerRows.ALL[0], 400.0, 0, true).filter { it.name.startsWith("life-scatter") }
            assertEquals("$realm: life-scatter and its puffs", 2, passes.size)
            for (p in passes) assertEquals("$realm ${p.name}", (if (realm in glowing) LifeCost.SCATTER_FS else LifeCost.SPRITE_FS).toDouble(), p.fetchesPerFragment, 0.0)
        }
    }

    /** Fetch calls inside the stage's `#ifdef LIFE_GLOW … #endif` blocks (comments stripped; the blocks do not nest). */
    private fun glowArmFetches(src: String): Long {
        val code = src.replace(Regex("/\\*[\\s\\S]*?\\*/"), " ").replace(Regex("//[^\\n]*"), "")
        val fetch = Regex("\\b(texelFetch|texelFetchOffset|texture|textureOffset|textureLod|textureLodOffset|textureGrad|textureGradOffset|textureProj|textureProjLod)\\s*\\(")
        return Regex("^\\s*#ifdef LIFE_GLOW\\b([\\s\\S]*?)^\\s*#endif", RegexOption.MULTILINE).findAll(code).sumOf { m -> fetch.findAll(m.groupValues[1]).count().toLong() }
    }

    private val mapDs = doubleArrayOf(48.0, 64.0, 100.0, 150.0, 200.0, 250.0, 280.0, 350.0, 500.0, 650.0, 799.0)
    private val trueDs = doubleArrayOf(800.0, 900.0, 1000.0, 1100.0, 1400.0, 2000.0, 3136.0, 6272.0)

    @Test fun `the per-program split is exactly what the planner submits, at every band, row and ladder cap`() {
        var views = 0
        for (realm in LaneCostFixture.REALMS) for (row in SeekerRows.ALL) for (d in mapDs + trueDs) for (cap in intArrayOf(0, L1_CAP)) for (heavy in booleanArrayOf(true, false)) {
            val r = LaneCostFixture.life(realm)
            LaneCostFixture.lifePasses(realm, row, d, cap, heavy)
            val split = r.cost.submitted(r.planner)
            assertEquals("$realm $row d=$d cap=$cap heavy=$heavy", r.planner.total.toLong(), split.total)
            // the model prices every submitted instance at 6 vertices: a pass list that dropped a program would under-price
            val passes = r.cost.passes(r.planner, row.bufferW, row.bufferH, true)
            assertEquals("$realm $row d=$d cap=$cap heavy=$heavy: ${passes.map { it.name to it.vertices }} vs scatter ${split.scatter} puffs ${split.puffs} stand ${split.stand} merged ${split.merged} creature ${split.creature} bird ${split.bird} particle ${split.particle}",
                LifeCost.VERTICES * split.total, passes.sumOf { it.vertices })
            views++
        }
        assertEquals(LaneCostFixture.REALMS.size * SeekerRows.ALL.size * (mapDs.size + trueDs.size) * 2 * 2, views) // 2 caps × heavy/safe
        // stage B (web 69fb02c2): Elderwood, Thornwake and Solana Reach have LIFE tables too, so every realm map is priced
        assertEquals(8, LaneCostFixture.REALMS.size)
    }

    /**
     * What the ladder's L1 LIFE cap does to LIFE. L1 halves the §9 submitted cap (native: [LadderPolicy.PLAN]'s
     * `l1LifeDivisor`; the web's quality level 1 changes only the ground's scale, GPU_SAFE.groundPx, and its LIFE cap is
     * per device class alone, scatter.js `submittedCap`). The planner's fitted cap (planDraws, golden-pinned) then thins its
     * tiers least visible first: 1 the TRUE-only groups, 2 the stands, 3 the twin groups. In MAP (no TRUE-only tier) the
     * stands take the cut; from TRUE_START the TRUE-only scatter takes it and the stands keep ≥ 93 % of their load.
     *
     * This test used to claim a fifth off LIFE's own load wherever LIFE runs over the cap. That was the native model's
     * own claim, not the plan's: §5.4's rule is the whole frame's (every ladder step cuts the modelled frame by at least a
     * fifth wherever it runs over the budget), pinned over the MAP band on the Seeker in RealmOverviewCostLanesTest. At
     * web stage B 205b6326 the cheaper species pick (LifeCost.SCATTER_VS 184 → 110) left stand members at 70 % or more of
     * LIFE's modelled load at the TRUE entry, which the fit thins last but one, so L1 cuts LIFE there by 15.5–22.8 %
     * (23 of the 31 over-cap views at d 1000–1100 under a fifth; the 24 in MAP at d 150 by 48.6–58.5 %).
     *
     * What holds, pinned: L1 never adds LIFE work; wherever LIFE runs over the L1 cap the fit meets the cap, LIFE's
     * modelled load falls by at least 15 % (the measured worst, 15.5 %, rounded down: a change that thins LIFE less at L1
     * fails here); from TRUE_START the cut comes from the tier the fit takes first, the TRUE-only scatter (it loses at least
     * half its instances, measured ≥ 69.6 %; in MAP, where the stands are the only tier on, n1 ≤ the cap already says they
     * take it: members −73 % or more); and a cut short of a fifth happens only where the stands carry most of LIFE's load
     * (a new unthinned stream heavy enough to hold the cut down fails here).
     */
    @Test fun `the ladder's L1 LIFE cap cuts LIFE where it runs over it, and short of a fifth only where stands carry it`() {
        var over = 0; var shortOfFifth = 0
        fun stands(passes: List<PassCost>, row: SeekerRow) = WorldFrameCost.evaluate(passes.filter { it.name.startsWith("life-stand") }, row.bufferW, row.bufferH, 1.0, 60).ms
        for (realm in LaneCostFixture.REALMS) for (row in SeekerRows.ALL) for (d in mapDs + trueDs) {
            val r = LaneCostFixture.life(realm)
            val p0 = LaneCostFixture.lifePasses(realm, row, d, 0, true)
            val n0 = r.planner.total; val k0 = r.cost.submitted(r.planner)
            val p1 = LaneCostFixture.lifePasses(realm, row, d, L1_CAP, true)
            val n1 = r.planner.total; val k1 = r.cost.submitted(r.planner)
            val at = "$realm $row d=$d"
            // the cap is the planner's fitted model, not a hard count (a thinned group keeps its floor until it is off):
            // the knob must never add work
            assertTrue("$at: L1 submits $n1 > L0's $n0", n1 <= n0)
            if (n0 <= L1_CAP * 5 / 4) continue
            over++
            assertTrue("$at: L1 submits $n1 over its cap $L1_CAP", n1 <= L1_CAP)
            val l0 = WorldFrameCost.evaluate(p0, row.bufferW, row.bufferH, 1.0, 60).ms; val l1 = WorldFrameCost.evaluate(p1, row.bufferW, row.bufferH, 1.0, 60).ms
            assertTrue("$at: L0 $l0 ms → L1 $l1 ms is not a real cut", l1 <= 0.85 * l0)
            if (d >= Bands.TRUE_START) assertTrue("$at: the TRUE-only tier is fitted first, yet scatter ${k0.scatter} → ${k1.scatter}", 2 * k1.scatter <= k0.scatter)
            if (l1 > 0.8 * l0) {
                shortOfFifth++
                val s0 = stands(p0, row)
                assertTrue("$at: L1 cut LIFE only ${100 * (1 - l1 / l0)} % with the stands at ${100 * s0 / l0} % of its load", s0 >= 0.6 * l0)
            }
        }
        assertTrue("no view ran LIFE over the L1 cap: the cut was never exercised", over > 0)
        assertTrue("no L1 cut fell short of a fifth: the stand rule was never exercised (re-read this test's note)", shortOfFifth > 0)
    }

    /**
     * L2 (GPU safe mode) is NOT a LIFE cut, and the models must know why: L2 keeps L1's LIFE cap, reduced motion stops the
     * birds and the ambience, and the planner's fitted cap (web scatter.js planDraws, golden-pinned) refills the share they
     * free with the groups it had thinned. The cap counts instances, not their price: a refilled scatter instance walks
     * [LifeCost.SCATTER_VS] fetches per vertex where the particle it replaces walked [LifeCost.PARTICLE_VS], so LIFE at L2
     * may cost a few per cent MORE than at L1 (worst at the pin: Frostveil d 900 on the 914 × 2034 row, +4.5 %). An earlier
     * draft bounded that growth at 2 % with no derivation; the model was right and the bound was not. What holds is the
     * mechanism, pinned here: at L2 nothing of LIFE's own grows but the refilled tiers. Whether the refill eats the ground's
     * L2 cut is a whole-frame question, answered on the Seeker by RealmOverviewCostLanesTest (every step ≥ a fifth).
     */
    @Test fun `L2 draws no birds or particles and grows LIFE only by the fitted cap's refill of the thinned groups`() {
        var views = 0; var grew = 0
        for (realm in LaneCostFixture.REALMS) for (row in SeekerRows.ALL) for (d in mapDs + trueDs) {
            val r = LaneCostFixture.life(realm)
            LaneCostFixture.lifePasses(realm, row, d, L1_CAP, true)
            val s1 = r.cost.submitted(r.planner)
            val l1 = WorldFrameCost.evaluate(r.cost.passes(r.planner, row.bufferW, row.bufferH, true), row.bufferW, row.bufferH, 1.0, 60)
            val l2 = WorldFrameCost.evaluate(LaneCostFixture.lifePasses(realm, row, d, L1_CAP, false), row.bufferW, row.bufferH, 1.0, 60)
            val s2 = r.cost.submitted(r.planner)
            val at = "$realm $row d=$d"
            assertEquals("$at: reduced motion stops the birds", 0L, s2.bird)
            assertEquals("$at: reduced motion stops the ambience", 0L, s2.particle)
            assertTrue("$at: creatures ${s1.creature} → ${s2.creature}", s2.creature <= s1.creature)
            assertTrue("$at: puffs ${s1.puffs} → ${s2.puffs}", s2.puffs <= s1.puffs)
            // what grew is the refill: scatter and stands, the tiers the fit thins
            if (l2.ms > l1.ms) { grew++; assertTrue("$at: L2 grew LIFE without refilling scatter or stands", s2.scatter > s1.scatter || s2.stand > s1.stand || s2.merged > s1.merged) }
            views++
        }
        assertEquals(LaneCostFixture.REALMS.size * SeekerRows.ALL.size * (mapDs.size + trueDs.size), views)
        assertTrue("the refill never happened: this test no longer sees the L2 growth it explains", grew > 0)
    }

    /** The table the integrate step and the handoff read (build/reports/lane-cost/life.txt): worst LIFE frame per band and row. */
    @Test fun `report the worst LIFE frame per band on every Seeker row`() {
        val out = StringBuilder("LIFE worst modelled frame (placeholder GPU rates; vertex = walked worst path), realm centre\n")
        for (row in SeekerRows.ALL) for ((band, ds) in listOf("MAP" to mapDs, "TRUE" to trueDs)) for (level in 0..2) {
            val cap = LADDER.knobs[level].lifeCap
            var worst = 0.0; var at = ""; var inst = 0
            for (realm in LaneCostFixture.REALMS) for (d in ds) {
                val f = WorldFrameCost.evaluate(LaneCostFixture.lifePasses(realm, row, d, cap, LaneCostFixture.heavy(level)), row.bufferW, row.bufferH, 1.0, 60)
                if (f.ms > worst) { worst = f.ms; at = "$realm d=$d"; inst = LaneCostFixture.life(realm).planner.total }
            }
            out.append(String.format("%-28s %-4s L%d  %6.2f ms  %6d instances  (%s)%n", row, band, level, worst, inst, at))
        }
        val f = File("build/reports/lane-cost"); f.mkdirs(); File(f, "life.txt").writeText(out.toString())
        assertTrue(out.isNotEmpty())
    }

    private companion object {
        /** The production ladder's knobs on the phone (FrameLadder over the generated GPU_SAFE / LIFE_CAPS numbers). */
        val LADDER = FrameLadder(LadderPolicy.PLAN, LadderInputs(GpuSafe.GROUND_PX[0], LifeTablesFile.load().constants.submittedPhone))
        /** L1's LIFE cap (LIFE_CAPS.submitted.phone / LadderPolicy.PLAN.l1LifeDivisor). */
        val L1_CAP = LADDER.knobs[1].lifeCap
    }
}
