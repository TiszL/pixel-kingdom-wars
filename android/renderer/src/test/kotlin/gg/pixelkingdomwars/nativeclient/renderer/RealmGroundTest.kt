package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.utils.JsonReader
import java.io.File
import java.security.MessageDigest
import javax.imageio.ImageIO
import org.junit.Test
import kotlin.test.*

/** The realm ground crop must match the canonical row writer (`renderGroundPixels`) byte-for-byte:
 * the pack carries historical and current-revision goldens. Paintings are bundled and also
 * read from the locked source pack so byte identity is verified before cropping. */
class RealmGroundTest {
    private val root = System.getenv("PKW_COMBAT_PACK")?.let(::File) ?: File("../app/src/main/assets/native")
    private val pack: File = System.getenv("PKW_COMBAT_PACK")?.let(::File) ?: run {
        val lock = JsonReader().parse(File("../client-pack.lock.json").readText())
        File("..", lock.getString("sourcePack"))
    }
    private val render = JsonReader().parse(root.resolve("render-catalog.json").readText())
    private val section = assertNotNull(render.get("ground"), "contract 13 pack carries the ground section")
    private val presentation = GroundPresentation(section)
    private fun sha256(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    private val paintings = mutableMapOf<String, GroundPixels>()
    private fun painting(source: GroundSource): GroundPixels = paintings.getOrPut(source.path) {
        val file = pack.resolve(source.path)
        assertTrue(file.isFile, "optional-tier painting ${source.path} is missing from the locked pack ${pack.path}; sync the pack before running the renderer gate")
        val bytes = file.readBytes()
        assertEquals(source.sha256, sha256(bytes), "${source.path} must be the accepted painting before it is decoded")
        val image = ImageIO.read(bytes.inputStream())
        val argb = image.getRGB(0, 0, image.width, image.height, null, 0, image.width)
        val data = ByteArray(argb.size * 4)
        for (i in argb.indices) {
            val p = argb[i]; val at = i * 4
            data[at] = (p shr 16 and 255).toByte(); data[at + 1] = (p shr 8 and 255).toByte(); data[at + 2] = (p and 255).toByte(); data[at + 3] = (p ushr 24 and 255).toByte()
        }
        GroundPixels(data, image.width, image.height)
    }

    @Test fun `all historical and current revision crop goldens match the canonical row writer byte for byte`() {
        val vectors = section.get("vectors").toList()
        val historicalSources = presentation.art.values.sumOf { it.sources.size }
        assertEquals(historicalSources * 3 + presentation.revisions.size * 4, vectors.size,
            "every frozen generation and revision needs origin, edge and changed-patch crop proof")
        val failures = mutableListOf<String>()
        for (vector in vectors) {
            val realm = vector.getString("realm")
            val visual = RealmVisual(realm, vector.getInt("artVersion"), vector.get("groundRevision")?.asInt())
            val art = presentation.artFor(visual)
            val source = painting(presentation.sourceFor(visual))
            val data = GroundRaster.render(source, art, realm, vector.getInt("width"), vector.getInt("height"), vector.getInt("originX"), vector.getInt("originY"))
            val hash = sha256(data)
            if (hash != vector.getString("rgbaSha256")) failures += "$realm@v${art.artVersion} origin ${vector.getInt("originX")},${vector.getInt("originY")}: $hash"
        }
        assertTrue(failures.isEmpty(), "ground crop goldens diverged:\n" + failures.joinToString("\n"))
        assertFailsWith<IllegalArgumentException> { GroundRaster.render(painting(presentation.art.getValue(1).sources.getValue("crownlands")), presentation.art.getValue(2), "crownlands", 8, 8) }
    }

    @Test fun `current Crownlands revision selects its own painting and cache identity while frozen replays retain their generation`() {
        val current = RealmVisual("crownlands", 2, 1)
        val previous = current.copy(groundRevision = null)
        val oldest = RealmVisual("crownlands", 1)
        val newest = RealmVisual("crownlands", 2, 2)
        val layered = render.get("layeredGround")?.takeIf { it.getString("status") == "accepted" }
        if (layered != null) {
            val descriptor = layered.get("manifests").single { it.getString("realmId") == "crownlands" }
            val bytes = pack.resolve(descriptor.getString("manifestPath")).readBytes()
            assertEquals(descriptor.getString("sha256"), sha256(bytes), "Current layered terrain must resolve to its verified manifest")
            val admitted = LayeredRealmGround(JsonReader().parse(bytes.toString(Charsets.UTF_8)))
            assertEquals("accepted", admitted.status)
            assertEquals("crownlands", admitted.realmId)
            // The current scenery is the newest accepted layered revision the pack carries for the
            // realm: revision 5 once the accepted layeredGroundV5 realm-kit section lists it (the bundled r12
            // pack after realm-kit content admission A v1.1; the ground retirement v2.1 gate requires current
            // crownlands/artVersion 2/revision 5), else revision 4 once the layeredGroundV4 section lists it
            // (D-138, all eight realms), else revision 3. Revisions 3 and 4 stay published for frozen replay contexts.
            val layeredV4 = render.get("layeredGroundV4")?.takeIf { it.getString("status") == "accepted" }
            val v4 = layeredV4?.get("manifests")?.firstOrNull { it.getString("realmId") == "crownlands" }
            val layeredV5 = render.get("layeredGroundV5")?.takeIf { it.getString("status") == "accepted" }
            val v5 = layeredV5?.get("manifests")?.firstOrNull { it.getString("realmId") == "crownlands" }
            if (v4 != null) {
                val v4Bytes = pack.resolve(v4.getString("manifestPath")).readBytes()
                assertEquals(v4.getString("sha256"), sha256(v4Bytes), "Current revision 4 terrain must resolve to its verified manifest")
            }
            if (v5 != null) {
                val v5Bytes = pack.resolve(v5.getString("manifestPath")).readBytes()
                assertEquals(v5.getString("sha256"), sha256(v5Bytes), "Current revision 5 realm kit must resolve to its verified manifest")
            }
            assertEquals(RealmVisual("crownlands", 2, if (v5 != null) 5 else if (v4 != null) 4 else 3), presentation.currentVisual)
        } else assertEquals(if (newest in presentation.revisions) newest else current, presentation.currentVisual)
        assertEquals("atlas/fantasy/ground-v3/crownlands.png", presentation.sourceFor(current).path)
        assertEquals("atlas/fantasy/ground-v2/crownlands.png", presentation.sourceFor(previous).path)
        assertEquals("atlas/fantasy/ground/crownlands.png", presentation.sourceFor(oldest).path)
        assertEquals(oldest, presentation.resolve(null), "missing replay context is historical v1, never current terrain")
        assertEquals(previous, presentation.resolve(current.copy(groundRevision = 99)), "unknown additive revisions retain the known v2 realm")
        assertEquals(RealmVisual("frostveil", 2), presentation.resolve(RealmVisual("frostveil", 2, 1)), "a Crownlands-only revision cannot change another realm")
        fun plan(v: RealmVisual) = GroundPlan(v, presentation.artFor(v), presentation.sourceFor(v), 30, 5)
        assertNotEquals(plan(current).identity, plan(previous).identity)
        assertNotEquals(plan(previous).identity, plan(oldest).identity)
        assertNotEquals(plan(current).source.sha256, plan(previous).source.sha256)
        val oldSection = JsonReader().parse(section.toJson(com.badlogic.gdx.utils.JsonWriter.OutputType.json))
        oldSection.remove("version"); oldSection.addChild("version", com.badlogic.gdx.utils.JsonValue(1L))
        oldSection.remove("revisions"); oldSection.get("currentVisual").remove("groundRevision")
        val legacy = GroundPresentation(oldSection)
        assertEquals(previous, legacy.resolve(current), "contract13 still renders its known v2 source")
        assertNull(legacy.motionVisibility)
    }

    @Test fun `phone zoom preserves ambient screen size stroke and drift while terrain accents stay attached`() {
        val visibility = assertNotNull(presentation.motionVisibility)
        val motion = GroundMotion(presentation, 64f)
        for (zoom in listOf(0.05f, 0.2f, 1f, 2f)) {
            val ambient = GroundMote(100.0, 200.0, 0)
            val out = mutableListOf<GroundGlyph>()
            motion.glyphs(ambient, 0.0, "crownlands", out, zoom)
            val atZero = out.single() as GroundGlyph.FillEllipse
            assertTrue(atZero.height * zoom >= visibility.minAmbientScreenPx - 0.0001f)
            out.clear(); motion.glyphs(ambient, Math.PI / 2, "crownlands", out, zoom)
            val shifted = out.single() as GroundGlyph.FillEllipse
            assertTrue((shifted.cx - atZero.cx) * zoom >= visibility.minDriftScreenPx - 0.0001f)
            val feature = GroundMote(100.0, 200.0, 0, "ice")
            out.clear(); motion.glyphs(feature, 0.0, "frostveil", out, zoom)
            val line = out.first() as GroundGlyph.Line
            assertEquals(100f, (line.x1 + line.x2) / 2, "ice remains seated over its sampled source feature")
            assertTrue(line.width * zoom >= visibility.minStrokeScreenPx - 0.0001f)
            assertTrue(line.x2 - line.x1 <= 6 * (64f / 32f) * visibility.maxFeatureScale + 0.0001f)
        }
    }

    @Test fun `visual context resolves like the web and skirt tints follow the catalogue table`() {
        assertEquals(presentation.defaultVisual, presentation.resolve(null))
        assertEquals(presentation.defaultVisual, presentation.resolve(RealmVisual("atlantis", 2)), "unknown realms depict the default, never a guess")
        assertEquals(presentation.defaultVisual, presentation.resolve(RealmVisual("frostveil", 3)))
        assertEquals(RealmVisual("frostveil", 2), presentation.resolve(RealmVisual("frostveil", 2)))
        assertEquals("atlas/fantasy/ground-v2/frostveil.png", presentation.sourceFor(RealmVisual("frostveil", 2)).path)
        assertEquals("atlas/fantasy/ground/frostveil.png", presentation.sourceFor(RealmVisual("frostveil", 1)).path)
        for (realm in presentation.realms) {
            val tints = section.get("skirtTints").get(realm)
            assertEquals(tints.getInt("stone"), presentation.skirtTint("dec_rock_s", RealmVisual(realm, 2)))
            assertEquals(tints.getInt("stone"), presentation.skirtTint("dec_boulder", RealmVisual(realm, 2)))
            assertEquals(tints.getInt("other"), presentation.skirtTint("dec_pine_1", RealmVisual(realm, 2)))
            assertEquals(0xffffff, presentation.skirtTint("dec_rock_s", RealmVisual(realm, 1)), "art version 1 stays untinted")
        }
        assertEquals(presentation.campaignRealmByAct, section.get("campaignRealmByAct").map { it.asString() })
    }

    @Test fun `the ground plan draws v2 over the authored world and rasterises v1 over the plot plus the camera skirt`() {
        val plot = section.get("geometry").getInt("plotTiles")
        // The window beyond the plot is BASE_CAMERA.skirtTiles, which BaseScene.drawUnderlay hands to
        // FantasyGround (`-SKIRT / T, (WORLD + SKIRT * 2) / T`) and the scene carries as camera.skirtTiles.
        // It is a catalogue number, never a renderer constant (underlay.ts's ten-tile decor ring is not it).
        val skirt = JsonReader().parse(root.resolve("catalogue.json").readText()).get("constants").get("BASE_CAMERA").getInt("skirtTiles")
        assertTrue(skirt > 0)
        val art2 = presentation.art.getValue(2)
        val frost = presentation.sourceFor(RealmVisual("frostveil", 2))
        val v2 = GroundPlan(RealmVisual("frostveil", 2), art2, frost, plot, skirt)
        assertFalse(v2.rasterised)
        val world = GroundCoverage(art2.start, art2.start, art2.span, art2.span)
        assertEquals(world, v2.paint, "v2 pixels span exactly the authored world the crop rule samples")
        assertEquals(world.union(v2.window), v2.coverage, "v2 is drawn over the world and any window beyond it")
        assertEquals(GroundCoverage(-skirt * art2.tilePx, -skirt * art2.tilePx, (plot + 2 * skirt) * art2.tilePx, (plot + 2 * skirt) * art2.tilePx), v2.window)
        val signed = GroundPlan(RealmVisual("frostveil", 2), art2, frost, 50, skirt, -10)
        assertEquals((-10-skirt)*art2.tilePx,signed.window.originX)
        assertEquals((50+2*skirt)*art2.tilePx,signed.window.width)
        assertEquals(v2.paint,signed.paint,"expanding the plot never translates authored world pixels")
        val narrow = GroundPlan(RealmVisual("frostveil", 2), art2, frost, plot, 0)
        assertEquals(world, narrow.coverage, "a fixture without a camera, or a battlefield whose deploy ring lies past the plot, still shows the painted world around the plot")
        val wide = GroundPlan(RealmVisual("frostveil", 2), art2, frost, plot, 2 * skirt)
        assertEquals(world, wide.paint); assertEquals(wide.window, wide.coverage, "beyond the painting the surface repeats its edge pixels like groundPaintLayout's extensions")
        val painted=v2.worldBounds(64f)
        assertEquals(art2.worldTiles*64f,painted.width,"Fit uses the entire admitted painting, not only the smaller plot skirt")
        val view=BaseWorldBounds(painted.left-200f,painted.top-50f,painted.right+100f,painted.bottom+300f)
        assertEquals(view,v2.drawBounds(64f,view),"Panning or a wide surface cannot reveal the clear color beyond a fixed quad")
        assertEquals(painted,v2.drawBounds(64f,BaseWorldBounds(0f,0f,100f,100f)))
        assertEquals(2f, v2.worldScale(64f))
        val window = v2.textureWindow(64f, art2.start * 2f, art2.start * 2f, (art2.start + art2.span) * 2f, (art2.start + art2.span) * 2f)
        assertContentEquals(floatArrayOf(0f, 0f, 1f, 1f), window, "the world rectangle maps onto the whole painting")
        val beyond = wide.textureWindow(64f, (art2.start - art2.span) * 2f, art2.start * 2f, (art2.start + 2 * art2.span) * 2f, (art2.start + art2.span) * 2f)
        assertEquals(-1f, beyond[0]); assertEquals(2f, beyond[2], "outside the world the texture clamps to its edge pixels, like the sampler")
        val art1 = presentation.art.getValue(1)
        val crown = presentation.sourceFor(RealmVisual("crownlands", 1))
        val v1 = GroundPlan(RealmVisual("crownlands", 1), art1, crown, plot, skirt)
        assertTrue(v1.rasterised)
        val skirtPx = skirt * art1.tilePx; val size = (plot + 2 * skirt) * art1.tilePx
        assertEquals(GroundCoverage(-skirtPx, -skirtPx, size, size), v1.coverage, "v1 is rasterised over plot + BASE_CAMERA.skirtTiles: the fade and grit reach as far as the web's FantasyGround")
        assertEquals(v1.worldBounds(64f),v1.drawBounds(64f,view),"Historical raster extent remains unchanged")
        assertEquals(v1.coverage, v1.paint); assertEquals(v1.coverage, v1.window)
        assertTrue(size <= 4096, "the v1 raster stays within the row writer's bounds")
        assertEquals(GroundCoverage(0, 0, plot * art1.tilePx, plot * art1.tilePx), GroundPlan(RealmVisual("crownlands", 1), art1, crown, plot, 0).coverage, "without a camera the v1 raster covers the plot only")
        assertFailsWith<IllegalArgumentException> { GroundPlan(RealmVisual("crownlands", 1), art1, crown, plot, -1) }
        assertNotEquals(v1.identity, v2.identity); assertNotEquals(v2.identity, wide.identity, "a wider window is a different surface")
        assertEquals(v2.identity, GroundPlan(RealmVisual("frostveil", 2), art2, v2.source, plot, skirt).identity)
        val motes = listOf(GroundMote(10.0, 10.0, 1), GroundMote(500.0, 10.0, 2), GroundMote(20.0, 30.0, 3), GroundMote(-60.0, 10.0, 4), GroundMote(-70.0, 10.0, 5))
        assertEquals(listOf(1L, 3L), visibleGroundMotes(motes, 0f, 0f, 100f, 100f, 64f, 2).map { it.seed }, "seed order, capped")
        assertEquals(listOf(1L, 3L, 4L), visibleGroundMotes(motes, 0f, 0f, 100f, 100f, 64f, 10).map { it.seed }, "one tile of margin, no more")
        assertTrue(visibleGroundMotes(motes, 0f, 0f, 100f, 100f, 64f, 0).isEmpty())
    }

    @Test fun `motion motes are world stable bounded and registered to real terrain features`() {
        val art = presentation.art.getValue(2)
        val motion = GroundMotion(presentation, 64f)
        val points = motion.motes(art.worldOriginTiles, art.worldTiles)
        val again = motion.motes(art.worldOriginTiles, art.worldTiles)
        assertEquals(points.map { Triple(it.x, it.y, it.seed) }, again.map { Triple(it.x, it.y, it.seed) }, "the same world hashes to the same motes")
        assertTrue(points.zipWithNext().all { (a, b) -> a.seed <= b.seed }, "seed order lets the visible cap cover the whole map fairly")
        val lo = art.worldOriginTiles * 64.0; val hi = (art.worldOriginTiles + art.worldTiles) * 64.0
        assertTrue(points.all { it.x >= lo && it.y >= lo && it.x < hi && it.y < hi })
        assertTrue(points.size in 1..(art.worldTiles / presentation.motionCellTiles + 2).let { it * it })
        val frost = painting(art.sources.getValue("frostveil"))
        motion.attachTerrainFeatures(points, frost, art, "frostveil")
        val features = points.mapNotNull { it.feature }
        assertTrue(features.all { it in setOf("water", "ice") }, "Frostveil evidence is meltwater or ice only")
        assertTrue(features.isNotEmpty(), "the accepted Frostveil painting carries pools the overlay must find")
        val glyphs = mutableListOf<GroundGlyph>()
        for (point in points.take(40)) motion.glyphs(point, 1.25, "frostveil", glyphs)
        assertTrue(glyphs.isNotEmpty())
        assertTrue(glyphs.all { glyph -> when (glyph) {
            is GroundGlyph.Line -> glyph.alpha in 0f..1f; is GroundGlyph.StrokeEllipse -> glyph.alpha in 0f..1f
            is GroundGlyph.FillEllipse -> glyph.alpha in 0f..1f; is GroundGlyph.FillRect -> glyph.alpha in 0f..1f
            is GroundGlyph.FillTriangle -> glyph.alpha in 0f..1f; is GroundGlyph.FillCircle -> glyph.alpha in 0f..1f } })
        assertNull(GroundMotion(presentation, 64f).terrainFeature(120, 120, 120, "crownlands"), "grey soil is never water")
        assertEquals("water", motion.terrainFeature(60, 120, 170, "crownlands"))
    }

    private fun authoredArt(features: String): GroundArt {
        val original = JsonReader().parse(section.get("art").get("2").toJson(com.badlogic.gdx.utils.JsonWriter.OutputType.json))
        val rows = JsonReader().parse(features)
        for (seat in rows) {
            if (seat.get("width") == null) seat.addChild("width", com.badlogic.gdx.utils.JsonValue(24L))
            if (seat.get("height") == null) seat.addChild("height", com.badlogic.gdx.utils.JsonValue(30L))
        }
        original.addChild("features", rows)
        return GroundArt(2, original)
    }

    @Test fun `authored revision seats replace RGB guessing and protect the entire building frame`() {
        val art = authoredArt("""[{"kind":"waterfall","x":1430,"y":155,"seed":1},{"kind":"foliage","x":150,"y":540,"seed":2}]""")
        for (tile in listOf(32f, 64f)) {
            val motion = GroundMotion(presentation, tile)
            val points = mutableListOf(GroundMote(100.0, 100.0, 900), GroundMote(-100.0, 50.0, 901))
            // Empty pixels deliberately cannot be sampled: authored seats have independent authority.
            motion.attachTerrainFeatures(points, GroundPixels(ByteArray(0), 0, 0), art, "thornwake")
            assertEquals(3, points.size)
            assertEquals(listOf("waterfall", "foliage", null), points.map { it.feature })
            assertEquals(-100.0, points.last().x)
            assertEquals((art.worldOriginTiles + 1430.0 / art.sourceSize * art.worldTiles) * tile, points[0].x, 0.000001)
            assertEquals((art.worldOriginTiles + 155.0 / art.sourceSize * art.worldTiles) * tile, points[0].y, 0.000001)
            assertEquals(24.0 / art.sourceSize * art.worldTiles * tile, points[0].width, 0.000001)
            assertTrue(visibleGroundMotes(points, 500f, 500f, 700f, 700f, tile, presentation.motionMaxVisiblePoints).isEmpty())
        }
    }

    @Test fun `authored feature admission rejects unknown kinds fractional off-image and duplicate seats`() {
        for (features in listOf(
            """[{"kind":"collision","x":1,"y":2,"seed":1}]""",
            """[{"kind":"water","x":1.5,"y":2,"seed":1}]""",
            """[{"kind":"water","x":-1,"y":2,"seed":1}]""",
            """[{"kind":"water","x":1536,"y":2,"seed":1}]""",
            """[{"kind":"water","x":768,"y":768,"seed":1}]""",
            """[{"kind":"water","x":1,"y":2,"seed":1,"width":0}]""",
            """[{"kind":"water","x":1,"y":2,"seed":1,"height":1537}]""",
            """[{"kind":"water","x":4294967297,"y":2,"seed":1}]""",
            """[{"kind":"water","x":1,"y":2,"seed":1,"width":4294967320}]""",
            """[{"kind":"water","x":1,"y":2,"seed":1},{"kind":"ice","x":1,"y":2,"seed":2}]""",
            """[{"kind":"water","x":1,"y":2,"seed":1},{"kind":"ice","x":2,"y":2,"seed":1}]""",
        )) assertFailsWith<IllegalArgumentException> { authoredArt(features) }
    }

    @Test fun `scenery glyphs advance locally with no unbounded emitters or center displacement`() {
        val motion = GroundMotion(presentation, 64f)
        for (kind in listOf("water", "ice", "crystal", "vent", "foliage", "waterfall", "dust", "mist")) {
            val point = GroundMote(100.0, 200.0, 1, kind, 100.0, 150.0)
            val first = mutableListOf<GroundGlyph>(); val next = mutableListOf<GroundGlyph>()
            motion.glyphs(point, 0.0, "thornwake", first, 0.18f)
            motion.glyphs(point, 1.0, "thornwake", next, 0.18f)
            assertTrue(first.size in 1..4, "$kind retains bounded shape work")
            assertNotEquals(first, next, "$kind must visibly change phase")
            assertEquals(100.0, point.x); assertEquals(200.0, point.y)
            assertEquals(listOf(point), visibleGroundMotes(listOf(point), 220f, 220f, 250f, 250f, 1f, 1), "a large wisp remains visible when its seat is just outside the view")
        }
    }
}
