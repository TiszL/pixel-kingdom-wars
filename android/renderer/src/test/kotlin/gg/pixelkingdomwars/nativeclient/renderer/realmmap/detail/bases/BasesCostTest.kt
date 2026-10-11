package gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.bases

import gg.pixelkingdomwars.nativeclient.renderer.generated.WorldShaders
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.ground.GroundShaderRulesTest
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life.LaneCostFixture
import gg.pixelkingdomwars.nativeclient.renderer.world.SeekerRows
import gg.pixelkingdomwars.nativeclient.renderer.world.WorldFrameCost
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * BASES' whole-frame cost bound ([BasesCost]) on the stages and tables that ship. Why it matters: the frame model had a
 * made-up 0.3-screen "bases" pass, so a MAP view full of live kingdoms, their shield domes (the transparent magical dome
 * over every shielded claim) and the paths between them was invisible to the ceilings. The bound must price the shipped
 * stages (a fetch added to SPRITE_FS moves the constant or fails here), must keep the dome caps, must charge the
 * MAP→TRUE fade for both copies of the decor it really draws, and can never charge a quad for more than the screen.
 */
class BasesCostTest {
    private val walker = GroundShaderRulesTest() // the one GLSL walker (Rule 7)
    private val cost = LaneCostFixture.basesCost
    private val bands = BasesBandsIn.fromGenerated()

    private fun walk(key: String, vertex: Boolean): GroundShaderRulesTest.Walk {
        val p = WorldShaders.realm[key] ?: error("$key is not exported")
        return walker.walk(WorldShaders.source(if (vertex) p.vs else p.fs))
    }

    @Test fun `the fetch counts are the worst paths walked from main() of the exported BASES stages`() {
        val fs = mapOf("bases-sprite" to BasesCost.SPRITE_FS, "bases-field" to BasesCost.FIELD_FS, "bases-shield" to BasesCost.SHIELD_FS,
            "bases-fx" to BasesCost.FX_FS, "bases-dot" to BasesCost.DOT_FS)
        for ((key, want) in fs) {
            assertEquals("$key fragment fetches", want.toLong(), walk(key, false).fetches)
            assertEquals("$key vertex fetches", 0L, walk(key, true).fetches)
        }
        assertEquals("the dome's ALU loop", BasesCost.SHIELD_ITERS.toLong(), walk("bases-shield", false).iters)
    }

    @Test fun `a higher keep level composes a larger kingdom, and every realm with a map composes one`() {
        for (realm in LaneCostFixture.REALMS) {
            val l1 = LaneCostFixture.kingdom(realm, 1); val l20 = LaneCostFixture.kingdom(realm, 20)
            assertTrue("$realm L1 draws nothing", l1.decorSprites > 0 && l1.keepArea > 0 && l1.groundCells > 0)
            assertTrue("$realm L20 (${l20.decorArea}) is not larger than L1 (${l1.decorArea})", l20.decorArea > l1.decorArea && l20.claim > l1.claim)
        }
    }

    @Test fun `domes keep their caps, the fade pays for both copies of the decor, and no quad costs more than the screen`() {
        val row = SeekerRows.ALL.last(); val k = LaneCostFixture.kingdom("crownlands", 20)
        for (d in doubleArrayOf(48.0, 280.0, 700.0, 950.0, 1100.0, 3136.0, 6272.0)) {
            val f = cost.bound(d, row.dpr, row.bufferW, row.bufferH)
            val cap = if (d >= bands.trueFull) 8 else 40
            assertTrue("d=$d: ${f.domes} domes over the cap", f.domes <= cap)
            val p = cost.passes(k, f, row.bufferW, row.bufferH).associateBy { it.name }
            assertTrue("d=$d dome coverage", p.getValue("bases-shield back").coverage <= f.domes + 1e-9)
            assertTrue("d=$d field coverage", p.getValue("bases-field").coverage <= f.live + f.links + 1e-9)
        }
        // inside the MAP→TRUE fade the lane draws the MAP minis AND the TRUE sprites: same d-scale, twice the decor
        val dFade = (bands.trueStart + bands.trueFull) / 2
        val one = BasesCost.Frame(dFade, row.dpr, live = 1, icons = 0, dots = 0, domes = 0, links = 0)
        val fade = cost.passes(k, one, row.bufferW, row.bufferH).first { it.name == "bases-sprite" }.coverage
        val noDecor = BasesCost.Kingdom(k.level, k.realm, 0.0, 0, k.keepArea, 0, 0, k.claim, k.smokeEmitters, 0.0, 0, 0)
        val keepOnly = cost.passes(noDecor, one, row.bufferW, row.bufferH).first { it.name == "bases-sprite" }.coverage
        val pxTile = dFade / LaneCostFixture.decor.game.tilesPerDeed
        assertEquals("the fade's decor is charged twice", 2 * k.decorArea * pxTile * pxTile / (row.bufferW.toDouble() * row.bufferH), fade - keepOnly, 1e-9)
    }

    @Test fun `the bound gives each base the one mode the lane dithers it into, so the dive's MAP landing is charged dots`() {
        // Why: the dive lands at MAP_START (D-173), s = UI_DOTS on the dpr-2 buffer, where the lane still draws every base
        // as a dot. A bound that charged every base its heaviest mode there priced hundreds of overlapping icons into the
        // very frame the Seeker's hang guard watches, and would have pushed the ladder (or the L0 scale) for nothing.
        val rules = BasesRules(LaneCostFixture.decor.t, bands.uiDots, bands.uiIcons, bands.keepMinCss, bands.impostor0, bands.impostor1)
        var checked = 0
        for (row in SeekerRows.ALL) for (d in doubleArrayOf(48.0, 60.0, 72.0, 96.0, 150.0, 200.0, 225.0, 250.0, 279.0, 280.0, 700.0)) {
            val f = cost.bound(d, row.dpr, row.bufferW, row.bufferH)
            val n = f.live + f.icons + f.dots
            // the lane's baseMode over n bases whose two dither hashes (bases.js h 7 and h 8) are spread evenly and independently
            var live = 0; var shown = 0
            for (i in 0 until n) when (rules.baseMode(f.s, d, (i + 0.5) / n, ((i + 0.5) * PHI) % 1.0)) { BasesRules.KEEP -> { live++; shown++ }; BasesRules.ICON -> shown++ }
            val slack = 2 + 0.02 * n
            assertTrue("d=$d $row: bound ${f.live} live, the lane $live", Math.abs(f.live - live) <= slack)
            assertTrue("d=$d $row: bound ${f.live + f.icons} icons or keeps, the lane $shown", Math.abs(f.live + f.icons - shown) <= slack)
            checked++
        }
        assertEquals(SeekerRows.ALL.size * 11, checked)
        for (row in SeekerRows.ALL) {
            val land = cost.bound(bands.uiDots * row.dpr, row.dpr, row.bufferW, row.bufferH)
            assertEquals("the MAP landing on $row draws only dots", 0, land.live + land.icons)
        }
    }

    /** The table the integrate step and the handoff read (build/reports/lane-cost/bases.txt). */
    @Test fun `report the BASES bound per band on every Seeker row`() {
        val out = StringBuilder("BASES bound (every deed in view claimed by an L20 kingdom, shielded, 2 paths each; placeholder rates)\n")
        for (row in SeekerRows.ALL) for (d in doubleArrayOf(48.0, 96.0, 200.0, 280.0, 500.0, 799.0, 950.0, 1100.0, 1400.0, 3136.0)) {
            var worst = 0.0; var alu = 0; var at = ""
            for (realm in LaneCostFixture.REALMS) {
                val f = WorldFrameCost.evaluate(LaneCostFixture.basesPasses(realm, row, d), row.bufferW, row.bufferH, 1.0, 60)
                if (f.ms > worst) { worst = f.ms; alu = f.unmodelledAlu; at = realm }
            }
            val b = cost.bound(d, row.dpr, row.bufferW, row.bufferH)
            out.append(String.format("%-28s d=%-6.0f %6.2f ms  live %3d icons %3d dots %4d domes %2d links %3d  unmodelled-ALU passes %d (%s)%n",
                row, d, worst, b.live, b.icons, b.dots, b.domes, b.links, alu, at))
        }
        val f = File("build/reports/lane-cost"); f.mkdirs(); File(f, "bases.txt").writeText(out.toString())
        assertTrue(out.isNotEmpty())
    }

    private companion object {
        /** The golden-ratio step: a second, evenly spread dither sequence independent of (i + ½) / n. */
        const val PHI = 0.6180339887498949
    }
}
