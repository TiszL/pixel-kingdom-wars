package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.utils.JsonReader
import org.junit.Test
import java.io.File
import kotlin.math.pow
import kotlin.test.*

/** Owner 2026-09-25, revision-5 base on his Seeker (combined code 27): "zoomed out does not look good, zoomed in all is ok".
 * His capture `seeker-1430/base-zoomout.png` (Crownlands, 1200×2670) shows full-detail props over a ground of flat
 * squares, measured there: the dock tiles are 52 dp at a 168-px pitch (52 + 4 dp), so the density is 3.0; the ground is
 * the E-8 overview still, whose texels (4 per tile, 16 world units on the 64-unit tile) repeat every 13.6 px (12 rows in
 * 163 px). That is libGDX zoom 1.18 = web zoom 1 / (1.18 · 3) = 0.283, the starter kingdom's own HOME fit and zoom
 * floor (claim 8..22 + 4 pad tiles across 400 dp = 0.284), under `REALM_KIT.overviewMaxZoom` 0.35. So the old switch
 * put a base's default view on the still, and the player could not zoom out of it, only in. Every battle scene (a
 * scouted base, a campaign preview, a live raid, a replay) opens at the same zooms. [RealmKitManifest.drawsOverview] is
 * one rule for all of them: the still only where its texel is at most 2 physical px, under E-8's zoom cap. */
class RealmKitOverviewLodTest {
    private val reader = JsonReader()
    private val root = System.getenv("PKW_COMBAT_PACK")?.let(::File) ?: File("../app/src/main/assets/native")
    /** The bundled catalogue's constants: REALM_KIT and the raid framing the battle scenes' camera comes from, not the test's. */
    private val constants by lazy { reader.parse(root.resolve("catalogue.json").readText()).get("constants") }
    private val rules by lazy { RealmKitRules.read(constants) }
    /** The SHIPPED Crownlands kit (the realm on the owner's capture), not the synthetic fixture: the fixture's still is
     * 2 px/tile, and every texel this file measures is the shipped kits' 4 px/tile one. */
    private val kit by lazy {
        val manifest = reader.parse(root.resolve("render-catalog.json").readText()).get("layeredGroundV5").get("manifests")
            .first { it.getString("realmId") == "crownlands" }
        val bytes = root.resolve(manifest.getString("manifestPath")).readBytes()
        RealmKitManifest(reader.parse(bytes.decodeToString()), rules,
            setOf("frostveil", "elderwood", "sunscar", "crownlands", "seeker-reach", "stormcairn", "thornwake", "cinderfall"), bytes.size)
    }
    private val raid by lazy {
        val c = constants.get("RAID_CAMERA")
        BattleCameraSpec(c.getFloat("minZoom"), c.getFloat("maxZoom"), c.getFloat("fitMaxZoom"), c.getFloat("fitPadTiles"),
            constants.get("RAID_RULES").getFloat("deployMarginTiles"), c.getFloat("northHeadroomWorldPx"))
    }
    /** RAID_BATTLEFIELD's current version around a claim, as `battlefieldPolicy` builds it for a revision-5 snapshot. */
    private fun battlefield(claim: RealmKitClaim): BattlefieldInputPolicy {
        val b = constants.get("RAID_BATTLEFIELD"); val current = b.getInt("currentVersion")
        val margin = b.get("marginTilesByVersion").getInt(current.toString())
        return BattlefieldInputPolicy(current, b.getInt("legacyVersion"), current, -margin, constants.get("GRID").getInt("plotTiles") + margin,
            claim.min, claim.max, emptySet(), b.getInt("snapRadiusTiles"), b.getInt("deploymentSquareTiles"))
    }
    /** A defender that fills its claim: the widest footprint the entry camera frames. */
    private fun defender(claim: RealmKitClaim) = BaseWorldBounds(claim.min.toFloat(), claim.min.toFloat(), claim.max.toFloat(), claim.max.toFloat())
    /** `presentation.tilePixels`: the native world tile, the same 64 the web BaseScene hands its realm kit. */
    private val T = 64f
    /** The camera world the renderer frames a revision-5 base in (`terrainBounds` = the kit's field). */
    private val worldPx get() = kit.floorBounds(T.toDouble()).width.toFloat()
    private fun web(zoom: Float, density: Float) = 1.0 / (zoom.toDouble() * density)
    private fun web(zoom: Double, density: Float) = 1.0 / (zoom * density)
    /** One still texel on the glass: T / pxPerTile world units over libGDX's world units per physical px. */
    private val texelWorld get() = T.toDouble() / checkNotNull(kit.overview).pxPerTile
    private fun draws(zoom: Double, density: Float) = kit.drawsOverview(T.toDouble(), zoom, density.toDouble())

    /** The switch is one rule in two units. The still texel is measured on the glass: T / pxPerTile world units over the
     * libGDX zoom, with the kit's 32-px art scale already inside T. E-8's `overviewMaxZoom` stays the outer cap, read as
     * the BaseScene zoom CameraFraming makes from BASE_CAMERA/RAID_CAMERA (web = 1 / (zoom · density)), with no second
     * kit scale. On the owner's capture the kit's own art pixel was 1.7 px and read as full detail beside a 13.6-px
     * still texel, so 2 px is about the coarsest a texel can be and still pass for the tiles; there nearest-sampled
     * tiles skip most art pixels anyway, so the still is the better picture and E-8's quad budget still holds. */
    @Test fun `the still replaces the tiles only where its texel is at most 2 physical px, under E-8's zoom cap`() {
        assertEquals(0.35, rules.overviewMaxZoom)
        assertEquals(2.0, RealmKitManifest.MAX_STILL_TEXEL_PX)
        assertEquals(4, checkNotNull(kit.overview).pxPerTile, "the shipped kits publish E-8's 4 px/tile still")
        for ((density, pinned, still) in listOf(
            Triple(1f, 0.12f, true),        // 1.92 px: a density-1 screen pulled far back
            Triple(1f, 0.13f, false),       // 2.08 px
            Triple(3f, 0.04f, true),        // 1.92 px
            Triple(3f, 0.05f, false),       // 2.4 px
            Triple(3f, 0.284f, false),      // 13.6 px: the owner's Seeker HOME fit, under the cap
            Triple(2.625f, 0.34f, false),   // 14.3 px, under the cap
            Triple(0.25f, 0.4f, false))) {  // 1.6 px but over E-8's cap (it binds only under density 0.36)
            // A band pinned to one web zoom: fitBaseFrame's libGDX zoom is exactly that zoom converted back.
            val frame = fitBaseFrame(BaseCameraSpec(8f, 22f, 4f, pinned, pinned), 1200, 2670, density, worldPx, T)
            assertEquals(pinned.toDouble(), web(frame.zoom, density), 1e-5)
            assertEquals(still, draws(frame.zoom.toDouble(), density),
                "web $pinned at density $density, a ${"%.2f".format(texelWorld / frame.zoom)}-px still texel")
        }
    }

    @Test fun `the owner's Seeker home view on the starter kingdom draws the tile quads, not the overview mosaic he reported`() {
        val density = 3f
        val frame = fitBaseFrame(BaseCameraSpec(8f, 22f, 4f, 0.14f, 1.6f), 1200, 2670, density, worldPx, T)
        assertEquals(RealmKitClaim(8, 22), rules.smallestKingdom, "the claim every base starts with")
        assertEquals(400.0 / ((14 + 2 * 4) * 64), web(frame.zoom, density), 1e-5, "the claim plus 4 pad tiles across 400 dp")
        assertEquals(frame.zoom, frame.maxZoom, "the HOME fit is this base's zoom floor: the player can only zoom in from it")
        // The shipped kits publish E-8's 4 px/tile still (Crownlands 3804f855: 392 px over 98 tiles), 16 world units a
        // texel; at this zoom that is the 13.6-px mosaic measured on the owner's capture (163 px / 12 rows).
        assertEquals(163.0 / 12, texelWorld / frame.zoom.toDouble(), 0.2)
        assertTrue(web(frame.zoom, density) < rules.overviewMaxZoom, "the old switch drew the still here")
        assertFalse(draws(frame.zoom.toDouble(), density), "a base draws the tile quads at its HOME fit")
    }

    /** Scouting a player's base (from the globe or the map), a campaign preview, a live raid and a replay are all battle
     * scenes (SceneMappers.battleScene), framed by fitExpandedBattleFrame. A 14-tile defender opens on the Seeker at the
     * starter base's own 0.284: the same 13.6-px mosaic, on the first frame, before any pinch. The amendment that kept
     * E-8's switch for battles left all of them on it; a battle must follow the base's rule. */
    @Test fun `a battle scene on the owner's Seeker opens on the tile quads and keeps them down to its zoom floor`() {
        val density = 3f; val claim = RealmKitClaim(8, 22)
        val frame = fitExpandedBattleFrame(battlefield(claim), raid, 1200, 2670, density, T, CameraInsets(), defender(claim))
        val ring = 14 + 2 * (constants.get("RAID_RULES").getInt("deployMarginTiles") + raid.fitPadTiles)
        assertEquals(400.0 / (ring * 64), web(frame.zoom, density), 1e-5, "the defender plus its deploy ring across 400 dp")
        assertTrue(web(frame.zoom, density) < rules.overviewMaxZoom, "the battle-only switch drew the still at this entry")
        assertEquals(163.0 / 12, texelWorld / frame.zoom.toDouble(), 0.2, "the owner's 13.6-px mosaic, at battle entry")
        assertFalse(draws(frame.zoom.toDouble(), density), "a battle opens on the tile quads")
        // Its floor fits the whole 98-tile field across 400 dp: web 0.064, still a 3.06-px texel on this phone.
        assertEquals(400.0 / (98 * 64), web(frame.maxZoom, density), 1e-5)
        assertEquals(3.06, texelWorld / frame.maxZoom.toDouble(), 0.01)
        assertFalse(draws(frame.maxZoom.toDouble(), density), "the Seeker's battle floor draws the tile quads too")
    }

    /** Every scene the renderer draws the realm kit in, over every zoom its pinch band allows: never a still texel wider
     * than 2 physical px, and the still wherever it is finer (E-8's quad budget, kept where nobody can see the switch).
     * Base floors are the claim fit, 16 · short side px / padded claim world units (extended plots skip
     * BASE_CAMERA.absoluteMinZoom); battle floors are the field fit. */
    @Test fun `no scene draws a still texel wider than 2 physical px at any zoom it allows, and the still stays where it is finer`() {
        val devices = listOf(Triple(1200, 2670, 3f), Triple(2670, 1200, 3f), Triple(1080, 2400, 2.625f), Triple(720, 1280, 2f),
            Triple(1600, 2560, 2f), Triple(800, 1280, 1f))
        val claims = listOf(RealmKitClaim(8, 22), RealmKitClaim(2, 28), RealmKitClaim(-10, 40))
        var coarse = 0; var formerStill = 0; var fine = 0
        fun sweep(label: String, frame: CameraFrame, density: Float) {
            // Closest to farthest (libGDX zoom grows as the camera pulls back).
            for (i in 0..48) {
                val zoom = frame.minZoom.toDouble() * (frame.maxZoom.toDouble() / frame.minZoom).pow(i / 48.0)
                val texelPx = texelWorld / zoom; val drew = draws(zoom, density)
                if (texelPx > RealmKitManifest.MAX_STILL_TEXEL_PX) {
                    coarse++
                    if (web(zoom, density) < rules.overviewMaxZoom) formerStill++
                    assertFalse(drew, "$label web ${web(zoom, density)}: drew a ${"%.1f".format(texelPx)}-px still texel")
                } else if (web(zoom, density) < rules.overviewMaxZoom) {
                    fine++
                    assertTrue(drew, "$label web ${web(zoom, density)}: a ${"%.2f".format(texelPx)}-px texel keeps E-8's still")
                }
            }
        }
        for ((width, height, density) in devices) for (claim in claims) {
            val at = "${width}x$height@$density claim ${claim.min}..${claim.max}"
            for (extended in listOf(false, true)) sweep("$at base extended=$extended",
                fitBaseFrame(BaseCameraSpec(claim.min.toFloat(), claim.max.toFloat(), 4f, 0.14f, 1.6f, extendedPlot = extended),
                    width, height, density, worldPx, T), density)
            sweep("$at battle", fitExpandedBattleFrame(battlefield(claim), raid, width, height, density, T, CameraInsets(), defender(claim)), density)
        }
        assertTrue(formerStill > 0, "the sweep reaches the band the old switches put on the still ($formerStill of $coarse)")
        assertTrue(fine > 0, "the sweep reaches a band fine enough for the still (a 720-px short side at the battle floor)")
    }

    /** The tests above call [RealmKitManifest.drawsOverview] themselves; the device draws what RealmKitSurface asks. That
     * one call takes this frame's camera and no scene flag (a battle flag is what left every scouted base, preview, raid
     * and replay on the mosaic), and drawFloor counts the still and the chunk batches it really drew into the scene
     * snapshot, which the GL harness reports as measured instead of re-deriving the rule. */
    @Test fun `the renderer asks the rule with its own camera in every scene and reports what it drew`() {
        val source = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/renderer/NativeGameRenderer.kt").readText()
        val askAt = source.indexOf("private fun overviewZoom("); assertTrue(askAt >= 0, "missing RealmKitSurface.overviewZoom")
        val ask = source.substring(askAt, source.indexOf('\n', askAt))
        assertTrue("= kit.drawsOverview(tilePixels, camera.zoom.toDouble(), Gdx.graphics.density.toDouble())" in ask,
            "overviewZoom must pass this frame's tile, camera zoom and density, and nothing about the scene: $ask")
        val floorAt = source.indexOf("fun drawFloor(tilePixels: Float, sceneClaim: RealmKitClaim)"); assertTrue(floorAt >= 0, "missing RealmKitSurface.drawFloor")
        val floor = source.substring(floorAt, source.indexOf("\n        }\n", floorAt))
        val stillAt = floor.indexOf("if (overviewZoom(T))"); assertTrue(stillAt >= 0, "drawFloor branches on overviewZoom(T)")
        val still = floor.substring(stillAt, floor.indexOf("return\n", stillAt)); val tiles = floor.substring(floor.indexOf("return\n", stillAt))
        assertTrue("realmKitStillDraws++" in still, "the still branch counts the still it draws")
        assertTrue("realmKitChunkDraws++" in tiles && "realmKitTileQuads += chunk.quads" in tiles, "the tile branch counts chunk batches and quads")
        val emitAt = source.indexOf("localDiagnostics?.state(LocalSceneSnapshot("); assertTrue(emitAt >= 0, "missing the scene snapshot")
        val emit = source.substring(emitAt, source.indexOf("if (disposed) return", emitAt))
        assertTrue("realmKitStillDraws,realmKitChunkDraws,realmKitTileQuads))" in emit, "the snapshot carries last frame's counts")
        assertTrue("realmKitStillDraws = 0; realmKitChunkDraws = 0; realmKitTileQuads = 0" in emit,
            "the counts reset after each snapshot, so a frame that drew no realm kit reports 0")
    }
}
