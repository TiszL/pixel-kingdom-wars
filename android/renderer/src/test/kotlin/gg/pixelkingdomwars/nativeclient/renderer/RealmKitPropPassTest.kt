package gg.pixelkingdomwars.nativeclient.renderer

import java.io.File
import org.junit.Test
import kotlin.test.*

/** Revision-5 props draw in the GROUND band on every surface. Web seats every kit prop at depth `1 + layer`
 * (E-7, under WORLD_DEPTH.structure) and the deed rasterizer composites `renderRealmKitPixels` — floor plus
 * props — before any placed building or obstacle; native must not sort the same props into its depth-keyed
 * structure pass. Before the E-6 amendment no prop shared a tile with anything, so the divergence was
 * invisible; now the woods scatter covers the whole field, so a 96-px tree seated one row south of the ring
 * would cover a building on the kingdom's last row here and sit under it on web and on the deed, and troops
 * in the deploy ring would interleave with canopies on one client only. The renderer's draw passes need a GL
 * batch, so this pins the source order the same way the web pins BaseScene: props leave [drawTerrain] with
 * the floor, and neither depth-sorted pass names them. */
class RealmKitPropPassTest {
    private val source = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/renderer/NativeGameRenderer.kt").readText()
    /** A class member's body: from its declaration to the first closing brace at member indentation. */
    private fun member(declaration: String): String {
        val start = source.indexOf(declaration); assertTrue(start >= 0, "missing $declaration")
        val end = source.indexOf("\n    }\n", start); assertTrue(end > start, "unterminated $declaration")
        return source.substring(start, end)
    }

    @Test fun `revision-5 props draw with the floor under every structure and actor on native as on web and the deed`() {
        val terrain = member("private fun drawTerrain(")
        val floor = terrain.indexOf("drawFloor("); val props = terrain.indexOf("drawProps("); val fallback = terrain.indexOf("layeredGround?.let")
        assertTrue(floor >= 0 && props > floor && fallback > props,
            "the realm kit branch of drawTerrain must draw the floor, then the props, before any older-ground fallback")
        for (pass in listOf("private fun drawBase(", "private fun drawBattle(")) {
            val body = member(pass)
            for (call in listOf("drawProps(", "propPlan(", "pathPlan(", "groundBandPlan(", ".props(")) assertFalse(call in body,
                "$pass must not seat kit props or creatures in its depth-sorted pass ($call): the prop band is the ground band on every surface")
        }
        // The surface draws the shared GROUND BAND plan itself (D-153 creature paths: props and roaming creatures in one
        // painter's order, `realmKitGroundBandPlan`), through the same region draw the overview still uses. A prop-only
        // plan here would leave the creatures undrawn or sorted by some other rule than web and the deed.
        val surface = source.substring(source.indexOf("fun drawProps("), source.indexOf("fun obstacle("))
        assertTrue("groundBandPlan(" in surface && "drawRegion(" in surface, "drawProps must draw the shared ground band plan in its own order")
        assertFalse("propPlan(" in surface || "pathPlan(" in surface, "drawProps must not re-sort props and creatures itself: the band plan owns the order")
    }

    /** E-8 under E-6 amended: the builder bakes the overview still from the tile layers only, because the claim
     * decides at draw time which props show and a bake cannot follow the claim. So below `overviewMaxZoom` every
     * prop on screen must come from the culled prop plan drawn over the still: a still that carried the props put
     * a ring of hidden trees on the zoom floor that vanished when the player zoomed in, and nothing on this side
     * can unbake it. The renderer must therefore never treat the still as "the props at far zoom" — the overview
     * branch of drawFloor draws the still and the kingdom fill only, and drawTerrain draws the props right after
     * drawFloor at every zoom, never behind an overview guard. */
    @Test fun `the zoom floor draws its props from the culled plan over the still and never from the still itself`() {
        val start = source.indexOf("fun drawFloor(tilePixels: Float, sceneClaim: RealmKitClaim)"); assertTrue(start >= 0, "missing RealmKitSurface.drawFloor")
        val floor = source.substring(start, source.indexOf("\n        }\n", start))
        val overview = floor.substring(floor.indexOf("if (overviewZoom(T))").also { assertTrue(it >= 0, "drawFloor branches on overviewZoom") })
        assertTrue("plan.overview" in overview && "plan.kingdom" in overview, "the overview branch draws the still and the kingdom fill")
        for (call in listOf("drawProps(", "propPlan(", "groundBandPlan(", "pathPlan(")) assertFalse(call in floor,
            "drawFloor must not own the props ($call): its overview return would skip them, leaving the still as the only prop source")
        val terrain = member("private fun drawTerrain(")
        val between = terrain.substring(terrain.indexOf("drawFloor("), terrain.indexOf("drawProps("))
        assertFalse("if (" in between || "overviewZoom" in between, "drawProps follows drawFloor unconditionally: the zoom floor draws the culled plan too")
    }
}
