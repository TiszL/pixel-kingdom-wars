package gg.pixelkingdomwars.nativeclient.renderer.realmmap

import com.badlogic.gdx.utils.JsonReader
import gg.pixelkingdomwars.nativeclient.renderer.BaseCameraSpec
import gg.pixelkingdomwars.nativeclient.renderer.BaseWorldBounds
import gg.pixelkingdomwars.nativeclient.renderer.RealmKitManifest
import gg.pixelkingdomwars.nativeclient.renderer.RealmKitRules
import gg.pixelkingdomwars.nativeclient.renderer.drawnWorldFrame
import gg.pixelkingdomwars.nativeclient.renderer.fitBaseFrame
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.ground.Classify
import org.junit.Test
import java.io.File
import kotlin.math.max
import kotlin.math.min
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * The enter-base seam against the base scene as the r5 realm kit draws it (the ground band: the kit floor, then its
 * props, `RealmKitPropPassTest`; `RealmKitManifest.drawsOverview` picks the far-zoom still or the tiles). OPEN BASE on
 * your own deed flies the realm map to the kingdom at TRUE and hands the base scene that camera
 * (`SceneCameraControls.enterAt`, world px and libGDX zoom). Why it matters: the owner opens his base from the map and
 * must land on the same kingdom at the same size, drawn with the real kit tiles and props. A zoom the base clamps is a
 * jump at the seam; a zoom under the still's texel limit opens on the flat mosaic he reported (Seeker 2026-09-25); a
 * point in the wrong units opens the base half-way to its origin, twice as close.
 */
class RealmSeamBaseSceneTest {
    private val reader = JsonReader()
    private val root = File("../app/src/main/assets/native")
    private val constants = reader.parse(root.resolve("catalogue.json").readText()).get("constants")
    private val rules = RealmKitRules.read(constants)
    private val plots = RealmTestData.plots
    private val seam = RealmSeam(rules, plots)
    /** `presentation.tilePixels`: the base scene's world tile (64), read from the catalogue like SceneMappers does. */
    private val T = reader.parse(root.resolve("catalogue.json").readText()).get("presentation").getDouble("tilePixels")
    private val baseCamera = constants.get("BASE_CAMERA")
    private val bands = RealmWebPin.BANDS
    private val bandRules = RealmBandRules(bands, RealmWebPin.DEED_ART)
    /** Every shipped revision-5 kit (render-catalog `layeredGroundV5`), as the base scene loads them. */
    private val kits: List<RealmKitManifest> by lazy {
        val manifests = reader.parse(root.resolve("render-catalog.json").readText()).get("layeredGroundV5").get("manifests")
        val realms = manifests.map { it.getString("realmId") }.toSet()
        manifests.map { m -> val bytes = root.resolve(m.getString("manifestPath")).readBytes()
            RealmKitManifest(reader.parse(bytes.decodeToString()), rules, realms, bytes.size) }
    }

    /** The base scene's zoom floor under backend D-185 (owner 2026-09-27: "they should be able to see full base art but they
     *  should not be able to zoom out in a way to see past it"), superseding D-183's claim plus ring: the drawn world, the
     *  kit field (`RealmKitManifest.floorBounds`), covering the FULL w x h surface, so the libGDX zoom is field world px over
     *  the surface's long side, whatever the kingdom's claim. The base scene clamps a wider handed zoom to it. */
    private fun fieldCoverZoom(w: Int, h: Int): Double = rules.fieldTiles * T / max(w, h)
    /** The same floor from the renderer's own functions, for the level's claim centred on the legacy plot (SceneMappers):
     *  the authored BASE_CAMERA home band (`fitBaseFrame`) bounded by `drawnWorldFrame` over the kit field. */
    private fun rendererFloorZoom(claim: Int, w: Int, h: Int, density: Double): Double {
        val lo = (rules.fieldOriginTiles * T).toFloat(); val hi = (rules.fieldEndTile * T).toFloat()
        val min = (rules.plotTiles - claim) / 2f
        val spec = BaseCameraSpec(min, min + claim, baseCamera.getFloat("fitPadTiles"), baseCamera.getFloat("absoluteMinZoom"),
            baseCamera.getFloat("maxZoom"), skirtTiles = baseCamera.getFloat("skirtTiles"), extendedPlot = true)
        val authored = fitBaseFrame(spec, w, h, density.toFloat(), hi - lo, T.toFloat())
        return drawnWorldFrame(authored, BaseWorldBounds(lo, lo, hi, hi), w, h, density.toFloat()).maxZoom.toDouble()
    }
    /** The base scene's closest zoom (libGDX): `BASE_CAMERA.maxZoom`, its close-up limit, as `fitBaseFrame` inverts it. */
    private fun closestZoom(density: Double) = 1 / (baseCamera.getDouble("maxZoom") * density)
    /** The libGDX zoom Enter base hands the base scene for the map resting at [d] on a [dpr] buffer (seamToBase, then
     *  the host's world-per-art scale). */
    private fun handedZoom(d: Double, dpr: Double, density: Double) = seam.baseZoom(d / dpr, density) * seam.worldPerArt(T)

    // Why the landing is the floor: the owner opens his base from the map and must land on the same kingdom at the same
    // size. Under D-185 the base's widest view is its whole drawn field covering the screen; a handed zoom wider than that
    // floor is clamped on the base's first frame, a jump at the seam, and a landing closer than the floor opens the base
    // closer than it is when zoomed fully out. D-183's claim-plus-ring floor made the landing depend on the kingdom's level;
    // the field does not.

    @Test fun `Enter base lands exactly on the base scene's field-cover floor and draws the kit tiles, never the still, on the Seeker`() {
        // the owner's Seeker: 1200 x 2670 px at density 3 (400 x 890 dp), the realm map on its dpr-2 buffer
        val w = 1200; val h = 2670; val density = 3.0; val dpr = 2.0
        val d = seam.landingD(w / density, h / density, dpr, bands.trueFull, bands.snap, bands.sMax)
        assertEquals(890.0 * dpr, d, 1e-9, "the field (one deed) spans the Seeker's 890 dp long side")
        assertTrue(d >= bands.trueFull, "lands at full TRUE, where the seam can be seamless")
        assertTrue(d < bands.snap, "below the pixel snap the landing is the exact cover, not a snapped rest")
        assertTrue(d <= bands.sMax * dpr, "the map can reach the landing")
        assertEquals(d, bandRules.snapD(bandRules.restTarget(d)), "the map camera rests exactly at the landing (rest rule, pixel snap)")
        val zoom = handedZoom(d, dpr, density); val floor = fieldCoverZoom(w, h)
        assertEquals(floor, zoom, floor * 1e-9, "lands exactly on the floor: the field's whole height, nothing past it")
        assertEquals(rules.fieldTiles * T, h * zoom, 1e-6, "the whole 98-tile field height on the glass")
        assertTrue(zoom >= closestZoom(density) * (1 - 1e-6), "zoom $zoom not closer than the base's closest ${closestZoom(density)}")
        for (level in 1..plots.maxLevel) {
            // every kingdom level: the base scene's own floor for that claim is this same field cover
            assertEquals(floor, rendererFloorZoom(plots.rule(level).claim, w, h, density), floor * 1e-5, "L$level: the renderer's floor")
        }
        for (kit in kits) assertFalse(kit.drawsOverview(T, zoom, density), "${kit.realmId}: the kit floor and props at the seam, not the far-zoom still")
    }

    @Test fun `every device the renderer supports lands on its base's field-cover floor, within the map's reach, drawn with the kit tiles`() {
        // the LOD test's devices (phones and tablets, both orientations, density 1 to 3; the realm map caps its buffer at dpr 2),
        // plus a 4K external display at density 1, the one surface here whose cover lies past the pixel snap
        val capped = ArrayList<String>(); val snapped = ArrayList<String>()
        for ((w, h, density) in listOf(Triple(1200, 2670, 3.0), Triple(2670, 1200, 3.0), Triple(1080, 2400, 2.625), Triple(720, 1280, 2.0),
                Triple(1600, 2560, 2.0), Triple(800, 1280, 1.0), Triple(3840, 2160, 1.0))) {
            val dpr = min(2.0, density); val reach = bands.sMax * dpr
            val d = seam.landingD(w / density, h / density, dpr, bands.trueFull, bands.snap, bands.sMax)
            assertTrue(d >= bands.trueFull, "${w}x$h lands at full TRUE")
            assertTrue(d <= reach, "${w}x$h: the map can reach the landing")
            assertEquals(d, bandRules.snapD(bandRules.restTarget(d)), "${w}x$h rests at the landing")
            val zoom = handedZoom(d, dpr, density); val floor = fieldCoverZoom(w, h)
            for (level in 1..plots.maxLevel) {
                assertEquals(floor, rendererFloorZoom(plots.rule(level).claim, w, h, density), floor * 1e-5, "${w}x$h L$level: the renderer's floor")
            }
            assertTrue(zoom >= closestZoom(density) * (1 - 1e-6), "${w}x$h not closer than the base's closest")
            when {
                d < bands.snap -> assertEquals(floor, zoom, floor * 1e-9, "${w}x$h lands exactly on the floor")
                zoom <= floor * (1 + 1e-6) -> {
                    // past the snap a rest is a whole number of device px per art px: the first one inside the band
                    assertTrue(d - RealmWebPin.DEED_ART >= bands.snap && handedZoom(d - RealmWebPin.DEED_ART, dpr, density) > floor * (1 + 1e-6),
                        "${w}x$h lands on the floor's rest: the next wider rest would show past the field")
                    snapped += "${w}x$h"
                }
                else -> capped += "${w}x$h" // the floor's rest is past the map's reach: the base would clamp once
            }
            assertFalse(kits.first().drawsOverview(T, zoom, density), "${w}x$h draws the kit tiles")
        }
        assertEquals(listOf("3840x2160"), snapped)
        // D-183's claim-plus-ring floor put the two smallest claims (L1-L5) on the large tablets past the map's reach, so the
        // base clamped the handed zoom once. The field cover is reachable everywhere: no landing jumps at the seam.
        assertEquals(emptyList<String>(), capped)
    }

    @Test fun `the deed and the kingdom the map draws are the base scene's kit field and claim, to one world px, in every realm`() {
        val k = seam.worldPerArt(T)
        val classify = Classify(plots) // the MAP/TRUE ground's own plot geometry (classify.js plotGeom)
        for (kit in kits) {
            // RealmKitSurface.worldBounds: the kit field where the base scene draws its floor and props
            val field = kit.floorBounds(T)
            val g = RealmTestData.golden("grid"); var r = g.get("realms").child; var n = 0
            while (r != null) {
                val gg = r.get("grid"); val cols = gg.getInt("cols"); val rows = gg.getInt("rows")
                for (i in 0 until 20) {
                    val dx = (i * 37 + 3) % cols; val dy = (i * 53 + 5) % rows
                    // an open deed: its four edges are the kit field's
                    assertEquals(field.x, seam.baseX(dx, dy, 0, dx.toDouble()) * k, 1.0, "${kit.realmId} ($dx, $dy) west")
                    assertEquals(field.x + field.width, seam.baseX(dx, dy, 0, dx + 1.0) * k, 1.0, "${kit.realmId} ($dx, $dy) east")
                    assertEquals(field.y, seam.baseY(dx, dy, 0, dy.toDouble()) * k, 1.0, "${kit.realmId} ($dx, $dy) north")
                    assertEquals(field.y + field.height, seam.baseY(dx, dy, 0, dy + 1.0) * k, 1.0, "${kit.realmId} ($dx, $dy) south")
                    for (level in 1..plots.maxLevel) {
                        val p = classify.plotGeom(level, plots.offsetX(dx, dy, level), plots.offsetY(dx, dy, level))
                        // the base scene's claim: the server's, centred on the legacy plot (RealmKitClaim), world px
                        val lo = (rules.plotTiles - p.claim) / 2 * T; val hi = lo + p.claim * T
                        assertEquals(lo, seam.baseX(dx, dy, level, dx + p.minX / plots.tiles) * k, 1.0, "${kit.realmId} ($dx, $dy) L$level claim west")
                        assertEquals(hi, seam.baseX(dx, dy, level, dx + p.maxX / plots.tiles) * k, 1.0, "${kit.realmId} ($dx, $dy) L$level claim east")
                        assertEquals(lo, seam.baseY(dx, dy, level, dy + p.minY / plots.tiles) * k, 1.0, "${kit.realmId} ($dx, $dy) L$level claim north")
                        assertEquals(hi, seam.baseY(dx, dy, level, dy + p.maxY / plots.tiles) * k, 1.0, "${kit.realmId} ($dx, $dy) L$level claim south")
                        n++
                    }
                }
                r = r.next
            }
            assertEquals(8 * 20 * plots.maxLevel, n)
            // and the size: the handed zoom shows the kit field over as many surface px as the map shows the deed
            for (s in doubleArrayOf(550.0, 700.0, 1568.0, 3136.0)) for (density in doubleArrayOf(2.0, 2.625, 3.0)) {
                val zoom = seam.baseZoom(s, density) * k
                assertEquals(s * density, field.width / zoom, 1.0, "${kit.realmId} s $s at density $density")
            }
        }
    }
}
