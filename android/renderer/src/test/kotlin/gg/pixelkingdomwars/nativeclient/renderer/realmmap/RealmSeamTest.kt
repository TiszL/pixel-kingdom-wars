package gg.pixelkingdomwars.nativeclient.renderer.realmmap

import com.badlogic.gdx.utils.JsonReader
import com.badlogic.gdx.utils.JsonWriter
import gg.pixelkingdomwars.nativeclient.renderer.RealmKitRules
import gg.pixelkingdomwars.nativeclient.renderer.world.WorldBases
import org.junit.Test
import java.io.File
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * The enter-base seam (D-162.3: "every deed is one base world … at exactly in-game proportions, so Enter base is
 * seamless"; GLOBE-PRODUCTION-PLAN F8). The realm map and the base scene (`RealmKitGround`, r5 e7ab4db, read-only) must
 * agree on the one world: the deed is the kit field, the plot the map draws at its hashed offset is the base scene's
 * plot, and the scale carries over. Why it matters: "Enter base" on your own deed must open on the kingdom the map just
 * showed; a tile off, and the player sees their keep jump.
 */
class RealmSeamTest {
    private val constants = JsonReader().parse(File("../app/src/main/assets/native/catalogue.json").readText()).get("constants")
    private val kit = RealmKitRules.read(constants)
    private val plots = RealmTestData.plots
    private val seam = RealmSeam(kit, plots)

    @Test fun `the app's catalogue makes one deed exactly one realm-kit base world`() {
        assertEquals(plots.tiles, kit.fieldTiles, "a deed is the kit field")
        assertEquals(RealmWebPin.DEED_ART, seam.deedArt, "DEED_ART = fieldTiles × tilePixels")
        assertEquals(RealmWebPin.PLOT_CENTRE * 2, -kit.fieldOriginTiles * 2 + kit.plotTiles, "PLOT_CENTRE is the kit's plot centre")
    }

    @Test fun `every kingdom's plot the map draws lands on the base scene's plot, for 20 deeds per realm and every keep level`() {
        val g = RealmTestData.golden("grid")
        var r = g.get("realms").child; var n = 0
        val centre = kit.plotTiles / 2.0 * kit.tilePixels // the base scene's plot centre, art px
        while (r != null) {
            val gg = r.get("grid"); val cols = gg.getInt("cols"); val rows = gg.getInt("rows")
            for (i in 0 until 20) {
                val dx = (i * 37 + 3) % cols; val dy = (i * 53 + 5) % rows
                for (L in 1..plots.maxLevel) {
                    val px = plots.centreX(dx, dy, L); val py = plots.centreY(dx, dy, L)
                    assertEquals(centre, seam.baseX(dx, dy, L, px), 1e-9, "${r.getString("id")} ($dx, $dy) L$L x")
                    assertEquals(centre, seam.baseY(dx, dy, L, py), 1e-9, "${r.getString("id")} ($dx, $dy) L$L y")
                    // and back: the base point maps to the same realm point (the return path)
                    assertEquals(px, seam.realmU(dx, dy, L, seam.baseX(dx, dy, L, px)), 1e-9)
                    assertEquals(py, seam.realmV(dx, dy, L, seam.baseY(dx, dy, L, py)), 1e-9)
                    n++
                }
            }
            r = r.next
        }
        assertEquals(8 * 20 * plots.maxLevel, n)
    }

    @Test fun `the deed's corners are the kit field's corners when the plot sits centred, and the scale carries over`() {
        // an open deed (no kingdom) has no offset: its west edge is the field's origin, its east edge the field's end
        assertEquals(kit.fieldOriginTiles.toDouble() * kit.tilePixels, seam.baseX(7, 9, 0, 7.0))
        assertEquals(kit.fieldEndTile.toDouble() * kit.tilePixels, seam.baseX(7, 9, 0, 8.0))
        assertTrue(seam.inField(seam.baseX(7, 9, 0, 7.5), seam.baseY(7, 9, 0, 9.5)))
        assertFalse(seam.inField(seam.baseX(7, 9, 0, 8.0), seam.baseY(7, 9, 0, 9.5)), "the far edge is outside the half-open field")
        // TRUE's pixel snap: d 3136 on the dpr-2 buffer is one device px per art px; the base scene at 2 px per dp shows the
        // same size at zoom 1 (one world px per surface px)
        val s = 3136.0 / 2
        assertEquals(1.0, seam.baseZoom(s, 2.0), 1e-12)
        for (z in doubleArrayOf(0.25, 0.5, 1.0, 1.7)) assertEquals(z, seam.baseZoom(seam.realmS(z, 2.75), 2.75), 1e-12)
    }

    @Test fun `a catalogue whose kit field is not one deed is refused, never opened a few tiles off`() {
        fun rulesWith(edit: (com.badlogic.gdx.utils.JsonValue) -> Unit): RealmKitRules {
            val c = JsonReader().parse(constants.toJson(JsonWriter.OutputType.json)); edit(c); return RealmKitRules.read(c)
        }
        val shifted = rulesWith { it.get("REALM_KIT").get("fieldOriginTiles").set(-33, null) }
        assertFailsWith<IllegalArgumentException> { RealmSeam(shifted, plots) }
        val otherPlot = rulesWith { it.get("GRID").get("plotTiles").set(32, null) }
        assertFailsWith<IllegalArgumentException> { RealmSeam(otherPlot, plots) }
    }

    @Test fun `Enter base continues the TRUE view into the base, and the return flies back to TRUE behind band readiness`() {
        val rig = RealmGlRig()
        val sources = RealmPrograms.load()
        val lane = FakeLane(rig.core, "detail", listOf("rm-map", "rm-true")).apply { createOnOpen = sources; groundBands = 1 }
        val e = RealmMapEngine(rig.core, RealmWebPin.CONFIG, plots, RealmWebPin.DEED_ART, RealmLoader(FixturePack("overview"), PNG_DECODER),
            null, rig.uploads, DirectExecutor, { rig.nowMs }, RealmDiveFade.PLAN_FADE_MS, shaderSources = { sources }, lanes = listOf(lane))
        e.setViewport(240, 520, 2.0)
        fun frame(realm: Boolean) {
            rig.compiler.runAll(); rig.nowMs += 16.667; check(rig.begin()); e.update(rig.nowMs, true); rig.uploads.poll(rig.core)
            if (realm) e.frame(rig.nowMs, rig.nowMs.toLong(), false) else { e.rehearseStep(rig.nowMs); rig.core.beginScreen(0f, 0f, 0f, 1f) }
            rig.end()
        }
        e.prepare("alpha")
        var n = 0; while (!e.ready && n < 300) { frame(false); n++ }
        val g = e.grid!!
        e.enter(g.lonAt(g.cols / 2.0), g.latAt(g.rows / 2.0), 10.0)
        // your kingdom (L9) on a deed of this realm
        val cell = (0 until g.size).first { (e.deeds[it].toInt() and 0xff) == 255 }
        val dx = cell % g.cols; val dy = cell / g.cols; val tile = g.tileId(dx, dy)
        val cx = tile % RealmGrid.LATTICE_W; val cy = tile / RealmGrid.LATTICE_W
        e.setBases(WorldBases(1, "alpha", intArrayOf(cx), intArrayOf(cy), intArrayOf(9), intArrayOf(RealmBases.FLAG_OCCUPIED or RealmBases.FLAG_MINE)))
        val out = RealmSeamCamera()
        assertTrue(e.seamToBase(seam, cx, cy, 2.75, out))
        assertFalse(out.seamless, "at FAR the base scene cannot continue the picture")
        // the player goes to TRUE on the kingdom (the flight waits for TRUE readiness), then taps OPEN BASE
        e.myBase()
        n = 0; while ((e.cam.moving || e.cam.d < RealmWebPin.BANDS.trueFull) && n < 3000) { frame(true); n++ }
        assertEquals(RealmWebPin.BANDS.myBaseD, e.cam.d, 1e-6)
        assertEquals(0L, rig.core.stats.liveFirstDraws, "TRUE was entered only after its pairs were rehearsed")
        // TRUE readiness is the lane's TRUE ground on screen, not the camera's scale: with the core's chart standing in
        // at TRUE scale (the ground lane not drawing) the base scene would open on a different picture
        lane.groundBands = 3; frame(true)
        assertTrue(e.seamToBase(seam, cx, cy, 2.75, out))
        assertFalse(out.seamless, "no TRUE ground drawn: not seamless")
        lane.groundBands = 1; frame(true)
        assertTrue(e.seamToBase(seam, cx, cy, 2.75, out))
        assertTrue(out.seamless, "at TRUE on the deed: the base scene opens on the same picture")
        assertEquals(kit.plotTiles / 2.0 * kit.tilePixels, out.baseX, 1e-6, "myBase centres the plot: the base scene's plot centre")
        assertEquals(seam.baseZoom(e.cam.s, 2.75), out.zoom)
        // back from the base: a fresh visit, then the flight to that base point at that size
        e.leave(rig.nowMs); frame(false)
        e.enter(g.lonAt(g.cols / 2.0), g.latAt(g.rows / 2.0), 10.0)
        e.setBases(WorldBases(2, "alpha", intArrayOf(cx), intArrayOf(cy), intArrayOf(9), intArrayOf(RealmBases.FLAG_OCCUPIED or RealmBases.FLAG_MINE)))
        assertTrue(e.returnFromBase(seam, cx, cy, out.baseX + 64.0, out.baseY - 32.0, out.zoom, 2.75))
        n = 0; while (e.cam.moving && n < 3000) { frame(true); n++ }
        assertEquals(seam.realmU(dx, dy, 9, out.baseX + 64.0), e.cam.x, 1e-6)
        assertEquals(seam.realmV(dx, dy, 9, out.baseY - 32.0), e.cam.y, 1e-6)
        assertEquals(RealmWebPin.BANDS.myBaseD, e.cam.d, 1e-6, "the same size as the base camera")
        assertEquals(0, e.bases.selectedBase, "the kingdom's card is open again")
        assertFalse(e.returnFromBase(seam, 0, 0, 0.0, 0.0, 1.0, 2.75), "a deed of another realm is refused")
    }
}
