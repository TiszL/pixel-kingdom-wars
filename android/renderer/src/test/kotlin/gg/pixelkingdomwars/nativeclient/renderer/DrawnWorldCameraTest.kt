package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.Gdx
import com.badlogic.gdx.Graphics
import com.badlogic.gdx.Input
import com.badlogic.gdx.files.FileHandle
import com.badlogic.gdx.utils.JsonReader
import org.junit.Test
import java.io.File
import java.lang.reflect.Proxy
import kotlin.test.*

/** Backend D-185, superseding D-183 (K-191). Owner, 0.6.0 / code 26 on his Seeker (2026-09-27): "users are not able to see new
 *  realm base themes normally, they are limited, they should be able to see full base art but they should not be able to zoom
 *  out in a way to see past it"; "player should be able to inspect full realm base". His "base" is the whole DRAWN realm-kit
 *  field (the claim plus the themed rings, forest, coast and shipyard), not the claim. D-183 stopped the zoom-out at the claim
 *  plus its one-tile ring covering the surface and hid most of that art; code 28 before it let a battle fit the whole field to
 *  the SHORT axis, about 60 tiles of edge-clamped margin above and below the field on a portrait phone ("going past base realm
 *  we made, and was ugly"). fitBaseFrame / fitExpandedBattleFrame still author the opening framing; the scene bounds both with
 *  [drawnWorldFrame] over the drawn world, home pans with [clampDrawnWorldAxis], and battle keeps panning the whole versioned
 *  field (the owner's "Keep whole field" for deployment, D-183). These tests pin the rule on the shipped REALM_KIT /
 *  BASE_CAMERA / RAID_CAMERA numbers, for the owner's 50x50 base and a fresh starter, on phones, the Seeker and a tablet, both
 *  orientations, home and battle. */
class DrawnWorldCameraTest {
    private val reader = JsonReader()
    private val root = File("../app/src/main/assets/native")
    private val constants = reader.parse(root.resolve("catalogue.json").readText()).get("constants")
    private val kit = RealmKitRules.read(constants)
    private val baseCamera = constants.get("BASE_CAMERA")
    private val raidCamera = constants.get("RAID_CAMERA")
    private val tile = 64f // presentation.tilePixels: world px per tile (32 art px x RealmSeam.worldPerArt 2)
    /** The drawn world of a realm-kit scene (RealmKitSurface.worldBounds = RealmKitManifest.floorBounds): the kit field. */
    private val field = kit.field.scaled(tile.toDouble() / kit.tilePixels)
        .let { BaseWorldBounds(it.x.toFloat(), it.y.toFloat(), (it.x + it.width).toFloat(), (it.y + it.height).toFloat()) }
    private fun spec(claimMin: Float, claimMax: Float) = BaseCameraSpec(claimMin, claimMax, baseCamera.getFloat("fitPadTiles"),
        baseCamera.getFloat("absoluteMinZoom"), baseCamera.getFloat("maxZoom"), skirtTiles = baseCamera.getFloat("skirtTiles"),
        extendedPlot = true) // SceneMappers: every revision-2+ plot, so every realm-kit base
    private val full50 = spec(kit.frameMinTile.toFloat(), kit.frameMaxTile.toFloat()) // the owner's 50x50 (expansion-12) base, -10..40
    private val starter = spec(8f, 22f) // a fresh 14-tile claim
    private data class Device(val name: String, val w: Int, val h: Int, val density: Float) { val portrait: Boolean get() = h > w }
    private val seeker = Device("Seeker 1200x2670", 1200, 2670, 3f)
    private val seekerLandscape = Device("Seeker 2670x1200", 2670, 1200, 3f)
    private val devices = listOf(Device("1080x2400", 1080, 2400, 2.625f), Device("2400x1080", 2400, 1080, 2.625f), seeker,
        seekerLandscape, Device("844x390", 844, 390, 1f), Device("tablet 1600x2560", 1600, 2560, 2f), Device("tablet 2560x1600", 2560, 1600, 2f))
    /** HOME fit insets: a 50 dp header and a 60 dp dock crossing the fitted square. */
    private fun insets(d: Device) = CameraInsets(top = (50 * d.density).toInt(), bottom = (60 * d.density).toInt())
    private fun homeBand(spec: BaseCameraSpec, d: Device) = drawnWorldFrame(
        fitBaseFrame(spec, d.w, d.h, d.density, maxOf(field.width, field.height), tile, insets(d)), field, d.w, d.h, d.density)
    private val eps = .01f // world px

    /** The widest view in tiles, W x H, and the checks every scene shares: never past the field on either axis, and the whole
     *  field on the constraining axis (a portrait phone sees every row of the art, landscape every column). */
    private fun assertCoversField(d: Device, widest: Float, label: String): Pair<Float, Float> {
        val viewW = d.w * widest; val viewH = d.h * widest
        assertTrue(viewW <= field.width * (1 + 1e-5f) && viewH <= field.height * (1 + 1e-5f), "$label ${d.name}: the widest view shows past the field")
        if (d.portrait) assertEquals(field.height, viewH, field.height * 1e-5f, "$label ${d.name}: every row of the art")
        else assertEquals(field.width, viewW, field.width * 1e-5f, "$label ${d.name}: every column of the art")
        return viewW / tile to viewH / tile
    }

    @Test fun `the widest home view is the whole drawn field covering the surface, for a 50x50 base and a fresh starter`() {
        for (d in devices) {
            val widest = listOf(full50, starter).map { homeBand(it, d).maxZoom }
            assertEquals(widest[0], widest[1], "${d.name}: the drawn art, not the claim, bounds the zoom-out")
            assertCoversField(d, widest[0], "home")
        }
        // The owner's Seeker: the field's full 98-tile height and about 44 of its tiles across; turned, its full width.
        for (spec in listOf(starter, full50)) {
            val (pw, ph) = assertCoversField(seeker, homeBand(spec, seeker).maxZoom, "home")
            assertEquals(44.04f, pw, .01f); assertEquals(98f, ph, .01f)
            val (lw, lh) = assertCoversField(seekerLandscape, homeBand(spec, seekerLandscape).maxZoom, "home")
            assertEquals(98f, lw, .01f); assertEquals(44.04f, lh, .01f)
        }
    }

    @Test fun `the authored entry and close-up are kept inside the band, and no authored floor overrides the drawn world`() {
        for (spec in listOf(full50, starter)) for (d in devices) {
            val authored = fitBaseFrame(spec, d.w, d.h, d.density, maxOf(field.width, field.height), tile, insets(d))
            val band = drawnWorldFrame(authored, field, d.w, d.h, d.density)
            assertEquals(1 / (baseCamera.getFloat("maxZoom") * d.density), band.minZoom, 1e-6f, "${d.name}: the authored close-up ceiling")
            assertTrue(band.zoom in band.minZoom..band.maxZoom, "${d.name}: the entry is inside the band")
            if (authored.zoom <= band.maxZoom) assertEquals(authored.zoom, band.zoom, "${d.name}: an authored entry inside the band is kept")
            else assertEquals(band.maxZoom, band.zoom, "${d.name}: an authored entry past the drawn world opens at the widest allowed view")
            assertEquals((spec.claimMin + spec.claimMax) / 2 * tile, band.center, "${d.name}: centred on the claim for the pan clamp to settle")
        }
        // On the Seeker the starter opens at its authored claim fit, closer than the floor; the 50x50's claim fit (58 tiles
        // across the short side) was taller than the whole field, so it now opens at the floor.
        val starterFit = fitBaseFrame(starter, seeker.w, seeker.h, seeker.density, field.width, tile, insets(seeker))
        assertTrue(starterFit.zoom < homeBand(starter, seeker).maxZoom); assertEquals(starterFit.zoom, homeBand(starter, seeker).zoom)
        val fullFit = fitBaseFrame(full50, seeker.w, seeker.h, seeker.density, field.width, tile, insets(seeker))
        assertTrue(seeker.h * fullFit.zoom > field.height, "precondition: the authored 50x50 entry went past the field")
        assertEquals(homeBand(full50, seeker).maxZoom, homeBand(full50, seeker).zoom)
        // An authored floor that stops SHORT of the field opens up to it: on a small landscape phone a non-extended spec's floor
        // is held at BASE_CAMERA.absoluteMinZoom, some tiles short of the field's width; the drawn world wins.
        val small = devices.single { it.name == "844x390" }; val legacy = full50.copy(extendedPlot = false)
        val held = fitBaseFrame(legacy, small.w, small.h, small.density, field.width, tile, insets(small))
        assertEquals(1 / (baseCamera.getFloat("absoluteMinZoom") * small.density), held.maxZoom, 1e-5f, "precondition: absoluteMinZoom holds the floor")
        assertTrue(small.w * held.maxZoom < field.width - tile, "precondition: that floor stops more than a tile short of the field")
        assertCoversField(small, drawnWorldFrame(held, field, small.w, small.h, small.density).maxZoom, "absoluteMinZoom")
        // A world too small to fill the surface at the authored close-up raises the ceiling to its cover (no zoom range) rather
        // than ever show past it (never a 98-tile field).
        val tiny = BaseWorldBounds(14 * tile, 14 * tile, 18 * tile, 18 * tile)
        val tinyBand = drawnWorldFrame(fitBaseFrame(starter, 1080, 2400, 2.625f, field.width, tile), tiny, 1080, 2400, 2.625f)
        assertEquals(tinyBand.minZoom, tinyBand.maxZoom)
        assertTrue(1 / (tinyBand.maxZoom * 2.625f) > baseCamera.getFloat("maxZoom"))
    }

    @Test fun `home pan reaches every edge of the drawn field and never leaves it, under measured chrome at every zoom`() {
        for (spec in listOf(full50, starter)) for (d in devices) {
            val band = homeBand(spec, d)
            // Measured chrome as on the Seeker: resource header in the top third, dock in the bottom third (panCameraInsets).
            val chrome = SceneInputGeometry(d.w, d.h, listOf(SceneInputRegion(0, 0, d.w, (70 * d.density).toInt()),
                SceneInputRegion(0, d.h - (90 * d.density).toInt(), d.w, d.h)))
            val pan = requireNotNull(panCameraInsets(insets(d), d.w, d.h, chrome).visible(d.w, d.h))
            for (zoom in listOf(band.maxZoom, (band.minZoom + band.maxZoom) / 2, band.minZoom)) {
                val vw = pan.width * zoom; val vh = pan.height * zoom
                for (want in listOf(-1e7f, 0f, 1e7f)) {
                    val x = clampDrawnWorldAxis(want, vw, field.left, field.right)
                    val y = clampDrawnWorldAxis(want, vh, field.top, field.bottom)
                    assertTrue(x - vw / 2 >= field.left - eps && x + vw / 2 <= field.right + eps, "${d.name} zoom $zoom x left the field")
                    assertTrue(y - vh / 2 >= field.top - eps && y + vh / 2 <= field.bottom + eps, "${d.name} zoom $zoom y left the field")
                }
                // Every edge of the art is reachable, so the shipyard or coast along it can be brought out from under the HUD.
                assertEquals(field.left, clampDrawnWorldAxis(-1e7f, vw, field.left, field.right) - vw / 2, eps, "${d.name} west")
                assertEquals(field.right, clampDrawnWorldAxis(1e7f, vw, field.left, field.right) + vw / 2, eps, "${d.name} east")
                assertEquals(field.top, clampDrawnWorldAxis(-1e7f, vh, field.top, field.bottom) - vh / 2, eps, "${d.name} north")
                assertEquals(field.bottom, clampDrawnWorldAxis(1e7f, vh, field.top, field.bottom) + vh / 2, eps, "${d.name} south")
            }
        }
        // An axis on which the world fits inside the pan rectangle is centred, never pinned to one edge.
        assertEquals(50f, clampDrawnWorldAxis(-1e7f, 200f, 0f, 100f))
    }

    /** The battle pan ("Keep whole field") is not re-derived here: WallStrokeRendererTest drives the renderer's own battle clamp
     *  to every corner of the versioned field at this floor. */
    @Test fun `battle, scout and replay zoom out to the drawn field covering the surface and enter on the defender`() {
        val camera = BattleCameraSpec(raidCamera.getFloat("minZoom"), raidCamera.getFloat("maxZoom"), raidCamera.getFloat("fitMaxZoom"),
            raidCamera.getFloat("fitPadTiles"), constants.get("RAID_RULES").getFloat("deployMarginTiles"), raidCamera.getFloat("northHeadroomWorldPx"))
        for ((claimMin, claimMax) in listOf(kit.frameMinTile to kit.frameMaxTile, 8 to 22)) for (d in devices) {
            val policy = BattlefieldInputPolicy(3, 1, 3, kit.fieldOriginTiles, kit.fieldEndTile, claimMin, claimMax, emptySet(), 1, deploymentSquareTiles = 1)
            val hud = CameraInsets(top = (raidCamera.getFloat("hudTopPx") * d.density).toInt(), bottom = (raidCamera.getFloat("hudBottomPx") * d.density).toInt())
            val authored = fitExpandedBattleFrame(policy, camera, d.w, d.h, d.density, tile, hud)
            val band = drawnWorldFrame(authored, field, d.w, d.h, d.density)
            val label = "battle claim $claimMin..$claimMax"
            val (w, h) = assertCoversField(d, band.maxZoom, label)
            assertTrue(band.maxZoom < authored.maxZoom, "$label ${d.name}: the authored whole-field fit on the short axis showed past the field")
            if (d == seeker || d == seekerLandscape) { assertEquals(if (d.portrait) 44.04f else 98f, w, .01f); assertEquals(if (d.portrait) 98f else 44.04f, h, .01f) }
            // The defender stays the entry: its centre, and its authored zoom when that is inside the band.
            assertEquals(authored.center, band.center); assertEquals(authored.centerY, band.centerY)
            assertTrue(band.zoom in band.minZoom..band.maxZoom)
            assertEquals(minOf(authored.zoom, band.maxZoom), band.zoom, "$label ${d.name}: entry kept, or clamped to the floor")
            assertEquals(authored.minZoom, band.minZoom, "$label ${d.name}: the authored close-up")
        }
        // Code 28's portrait battle on the Seeker, the owner's "whole desert with the base as a small square": the authored band
        // alone put 60 tiles of edge-clamped margin above and below the field.
        val policy = BattlefieldInputPolicy(3, 1, 3, kit.fieldOriginTiles, kit.fieldEndTile, 8, 22, emptySet(), 1, deploymentSquareTiles = 1)
        val hud = CameraInsets(top = (raidCamera.getFloat("hudTopPx") * 3).toInt(), bottom = (raidCamera.getFloat("hudBottomPx") * 3).toInt())
        val authored = fitExpandedBattleFrame(policy, camera, seeker.w, seeker.h, seeker.density, tile, hud)
        assertEquals(60f, (seeker.h * authored.maxZoom / tile - kit.fieldTiles) / 2, .05f)
    }

    @Test fun `the pan rectangle widens to the measured chrome so edges of the drawn world can leave the HUD`() {
        // Portrait HOME (measured on the owner's Seeker class): resource header + builder in the top third, dock + deck in the
        // bottom third; the fit insets saw none of them (they miss the centred square).
        val fit = CameraInsets(top = 40, bottom = 30)
        val portrait = SceneInputGeometry(1200, 2670, listOf(SceneInputRegion(24, 40, 1176, 210), SceneInputRegion(24, 240, 240, 380),
            SceneInputRegion(24, 2300, 1176, 2640), SceneInputRegion(900, 2150, 1176, 2290)))
        assertEquals(CameraInsets(0, 380, 0, 520), panCameraInsets(fit, 1200, 2670, portrait))
        // A tall side panel (layout editor, landscape) pushes its side in; a third of the surface is the cap on every side.
        val side = SceneInputGeometry(2670, 1200, listOf(SceneInputRegion(1900, 450, 2670, 800), SceneInputRegion(0, 0, 2670, 700)))
        assertEquals(CameraInsets(0, 400, 770, 0), panCameraInsets(CameraInsets(), 2670, 1200, side), "panel -> right 770; 700 px header capped at 400")
        // A stale measurement (rotation in flight) or none leaves the fit insets alone.
        assertEquals(fit, panCameraInsets(fit, 2670, 1200, portrait))
        assertEquals(fit, panCameraInsets(fit, 1200, 2670, null))
    }

    /** Scene activation (GL-bound, never run on the JVM) chooses the drawn world with [drawnWorldBounds]; this pins the choice
     *  and the call site that feeds it the drawn surfaces' own bounds. */
    @Test fun `a scene's drawn world is its realm kit's field, else its layered painting, else none`() {
        val kitField = surfaceWorldBounds(shipped.take(1)).single() // what a drawn realm kit hands scene activation
        val painting = BaseWorldBounds(-30 * tile, -30 * tile, 60 * tile, 60 * tile) // distinct from the field, to see which one won
        assertEquals(BaseWorldBounds(-34 * tile, -34 * tile, 64 * tile, 64 * tile), drawnWorldBounds(kitField, null), "a realm kit: exactly its 98-tile field")
        assertEquals(kitField, drawnWorldBounds(kitField, painting), "a realm kit wins over a painting")
        assertEquals(painting, drawnWorldBounds(null, painting), "a layered painting: its own bounds")
        assertNull(drawnWorldBounds(null, null), "a legacy ground only, or nothing loaded: no drawn world, the pre-D-183 framing")
        val source = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/renderer/NativeGameRenderer.kt").readText()
        assertEquals(1, source.lines().count { it.trimStart().startsWith("drawnWorld=") || it.trimStart().startsWith("drawnWorld =") },
            "one place sets the drawn world")
        assertTrue("drawnWorld=drawnWorldBounds(realmKit?.worldBounds(active.tilePixels),layeredGround?.worldBounds(active.tilePixels))" in source,
            "scene activation passes the drawn realm kit's and layered painting's own worldBounds, never the terrain fallback")
    }

    /** Every shipped revision-5 kit, admitted as a device admits it: the accepted section, no preview host. */
    private val shipped by lazy {
        val section = reader.parse(root.resolve("render-catalog.json").readText()).get("layeredGroundV5")
        val realms = section.get("manifests").map { it.getString("realmId") }
        realms.map { realm -> RealmKitSource.read(section, realm, realms.toSet(), false, kit) { path, _ -> root.resolve(path).readBytes() } }
    }
    @Suppress("UNCHECKED_CAST") private fun <T> stub(type: Class<T>): T = Proxy.newProxyInstance(type.classLoader, arrayOf(type)) { _, method, _ ->
        when (method.returnType) { java.lang.Integer.TYPE -> 120; java.lang.Boolean.TYPE -> false; java.lang.Float.TYPE -> 1f; else -> null }
    } as T
    /** The renderer's own `RealmKitSurface(PreparedRealmKitSurface(source, ...)).worldBounds(tile)`: what scene activation hands
     *  [drawnWorldBounds] while that kit is drawn. No page is uploaded; worldBounds reads the admitted manifest only. */
    private fun surfaceWorldBounds(sources: List<RealmKitSource>): List<BaseWorldBounds> {
        val oldGraphics = Gdx.graphics; val oldInput = Gdx.input
        Gdx.graphics = stub(Graphics::class.java); Gdx.input = stub(Input::class.java)
        val renderer = NativeGameRenderer(FileHandle("unused-headless-assets"), {})
        try {
            val prepared = Class.forName("${NativeGameRenderer::class.java.name}\$PreparedRealmKitSurface")
                .getDeclaredConstructor(RealmKitSource::class.java, String::class.java, Map::class.java).apply { isAccessible = true }
            val surface = Class.forName("${NativeGameRenderer::class.java.name}\$RealmKitSurface")
            val create = surface.getDeclaredConstructor(NativeGameRenderer::class.java, prepared.declaringClass).apply { isAccessible = true }
            val worldBounds = surface.getDeclaredMethod("worldBounds", java.lang.Float.TYPE).apply { isAccessible = true }
            return sources.map { worldBounds.invoke(create.newInstance(renderer, prepared.newInstance(it, it.identity(tile), emptyMap<String, Any>())), tile) as BaseWorldBounds }
        } finally { renderer.dispose(); Gdx.graphics = oldGraphics; Gdx.input = oldInput }
    }

    @Test fun `the drawn world is every shipped kit's 98-tile field, never its edge-extended margin, and corrupt input is refused`() {
        // The renderer's RealmKitSurface.worldBounds (RealmKitManifest.floorBounds) for each shipped revision-5 kit: the field
        // -34..64, not the REALM_KIT.edgeExtendTiles margin the renderer edge-clamps beyond it for a panned view under the HUD.
        assertEquals(8, shipped.map { it.kit.realmId }.toSet().size)
        for ((source, bounds) in shipped.zip(surfaceWorldBounds(shipped))) assertEquals(field, bounds, source.kit.realmId)
        assertEquals(BaseWorldBounds(-34 * tile, -34 * tile, 64 * tile, 64 * tile), field)
        assertTrue(kit.edgeExtendTiles > 0, "the margin exists and is drawn; the camera floor must not count it")
        // The square field covers a surface along its long axis.
        assertEquals(2670 / 3f / field.height, drawnWorldCoverScale(field, 1200, 2670, 3f), 1e-9f)
        assertFailsWith<IllegalArgumentException> { drawnWorldCoverScale(field, 0, 100, 3f) }
        assertFailsWith<IllegalArgumentException> { drawnWorldCoverScale(field, 100, 100, Float.NaN) }
        assertFailsWith<IllegalArgumentException> { drawnWorldCoverScale(BaseWorldBounds(0f, 0f, 0f, 10f), 100, 100, 3f) }
        assertFailsWith<IllegalArgumentException> { clampDrawnWorldAxis(Float.NaN, 10f, 0f, 100f) }
        assertFailsWith<IllegalArgumentException> { clampDrawnWorldAxis(0f, 10f, 100f, 0f) }
    }
}
