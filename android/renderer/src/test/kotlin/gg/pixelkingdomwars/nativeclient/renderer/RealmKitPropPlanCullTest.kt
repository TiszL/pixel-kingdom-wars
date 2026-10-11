package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.utils.JsonReader
import java.io.File
import org.junit.Test
import kotlin.test.*

/** The prop plan runs on every Home frame over every placement of the realm (~1,700). It now culls before it allocates
 * (precomputed seats, scaled edges compared in place); the plan it returns must stay exactly the documented rule — a prop
 * draws when its seat is outside the claim and edge ring AND its bounds scaled to the renderer's tiles meet the view —
 * or the same kingdom would show different trees on native than on web and the deed. */
class RealmKitPropPlanCullTest {
    private val reader = JsonReader()
    private fun resource(name: String) = checkNotNull(javaClass.getResourceAsStream("/realm-kit/$name")) { "missing test resource $name" }.readBytes()
    private val rules = RealmKitRules.read(reader.parse(resource("constants.json").decodeToString()))
    private val descriptor = reader.parse(resource("layeredGroundV5.json").decodeToString()).get("manifests").get(0)
    private val manifestBytes = resource(descriptor.getString("manifestPath"))
    private val realms = setOf("frostveil", "elderwood", "sunscar", "crownlands", "seeker-reach", "stormcairn", "thornwake", "cinderfall")
    private val kit by lazy { RealmKitManifest(reader.parse(manifestBytes.decodeToString()), rules, realms, manifestBytes.size) }
    private fun claim(tiles: Int): RealmKitClaim { val min = 15 - tiles / 2; return RealmKitClaim(min, min + tiles) }

    /** The rule written plainly, with the allocating helpers the plan used before. */
    private fun reference(T: Double, view: LayeredGroundRect, claim: RealmKitClaim, elapsedMs: Long, still: Boolean) =
        kit.placements.filter { !kit.placementHidden(it, claim) && it.bounds.scaled(T / kit.tilePixels).intersects(view) }
            .map { Triple(it.id, it.bounds.scaled(T / kit.tilePixels), kit.placementFrame(it, elapsedMs, still)) }

    @Test fun `the culled prop plan names the same props at the same places and frames as the plain rule for every view and claim`() {
        var compared = 0; var drawn = 0
        for (T in listOf(32.0, 48.0, 64.0, 96.5)) for (tiles in listOf(14, 20, 26, 30)) for (elapsed in listOf(0L, 100L, 150L)) {
            val c = claim(tiles)
            for (x in -3200..3200 step 400) for (y in -3200..3200 step 400) for (size in listOf(60.0, 700.0, 4000.0)) {
                val view = LayeredGroundRect(x.toDouble(), y.toDouble(), size, size * 0.45)
                val plan = kit.propPlan(T, view, c, elapsed, false).map { Triple(it.id, it.destination, it.frame) }
                assertEquals(reference(T, view, c, elapsed, false), plan, "T=$T claim=$tiles elapsed=$elapsed view=$view")
                compared++; drawn += plan.size
            }
        }
        assertTrue(compared > 1000 && drawn > 0, "the sweep must cover culled and drawn props alike ($compared views, $drawn draws)")
    }

    @Test fun `the band plan is unchanged by building its id index once and repeated frames return equal plans`() {
        val view = LayeredGroundRect(-3000.0, -3000.0, 9000.0, 9000.0)
        val first = kit.groundBandPlan(64.0, view, claim(14), 100, false)
        val second = kit.groundBandPlan(64.0, view, claim(14), 100, false)
        assertEquals(first, second, "the same frame clock gives the same band plan")
        assertEquals(kit.propPlan(64.0, view, claim(14), 100, false).map { it.id }.toSet(),
            first.map { it.draw.id }.filter { id -> kit.placements.any { it.id == id } }.toSet(), "every prop of the plan is in the band")
    }

    @Test fun `the per-frame realm kit region lookup never formats a string key`() {
        // NativeGameRenderer needs a GL batch, so the rule is pinned on the source the way RealmKitPropPassTest pins the pass
        // order: hundreds of prop draws a frame each built a String from four Double formats before, steady garbage that
        // the collector paid for in dropped frames on Home.
        val source = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/renderer/NativeGameRenderer.kt").readText()
        val start = source.indexOf("fun region(draw: LayeredGroundDraw): TextureRegion {"); assertTrue(start >= 0, "missing RealmKitSurface.region")
        val body = source.substring(start, source.indexOf("\n        }\n", start))
        assertFalse("\"\${" in body, "the region cache key must not be a formatted string")
        assertTrue("getOrPut(draw.source)" in body, "the source rect itself is the key")
    }
}
