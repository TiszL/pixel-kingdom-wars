package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.utils.JsonReader
import org.junit.Test
import java.io.File
import javax.imageio.ImageIO
import kotlin.test.*

/** The SHIPPED revision-5 kits, not the synthetic fixture. Every one of the eight realms must have a kit under `layeredGroundV5` that
 * goes through the admission a base or battle in its realm runs before its first frame on a device:
 * `RendererCatalogue.validate` (GameContent's render admission), `RealmKitRules.read` over the pack's own `catalogue.json`
 * constants (`NativeGameRenderer.realmKitRules`), `RealmKitSource.read` with the ground contract's realms and NO preview
 * host (what every device build passes: `layeredGroundPreview` is never set), `prepare` (sheet size and sha256, decode,
 * binary alpha, opaque stills, the water-hole rule), then the draw-time plans `RealmKitSurface` evaluates on the GL
 * thread (far repeat, overview, every chunk of the extent, the ground band of props and creatures, every obstacle twin)
 * over every centred claim from the smallest kingdom to the whole frame.
 *
 * Why this exists: the accepted section is core-tier and has no fallback. A kit that fails any of these steps leaves
 * every base and battle in its realm unable to open, and before this test the first Kotlin admission of a released kit
 * was the owner's phone (Solana Reach at `a65cede0` never went through it). RealmKitGroundTest and
 * RealmKitPreparationTest pin the rules on a fixture; this pins the bytes the APK carries, so a pack re-pin that
 * brings a kit the renderer cannot open fails the build instead. */
class BundledRealmKitAdmissionTest {
    private val reader = JsonReader()
    private val realms = setOf("frostveil", "elderwood", "sunscar", "crownlands", "seeker-reach", "stormcairn", "thornwake", "cinderfall")
    private val root = System.getenv("PKW_COMBAT_PACK")?.let(::File) ?: File("../app/src/main/assets/native")

    /** `NativeGameRenderer.safeFile` + `readLayeredBytes`: a relative path inside the pack, present, 1..maximum bytes. */
    private fun read(path: String, maximum: Int): ByteArray {
        require(path.split('/').all { it.isNotEmpty() && it != "." && it != ".." && !it.contains('\\') && !it.contains(':') })
        val file = root.resolve(path)
        require(file.isFile && file.length() in 1..maximum.toLong()) { "Layered preview content is unavailable" }
        return file.readBytes().also { require(it.size <= maximum) { "Layered preview content exceeds its manifest" } }
    }
    /** Straight RGBA from ImageIO, the byte order `AndroidLayeredImageDecoder` produces (as RealmKitPreparationTest). */
    private val decoder = LayeredImageDecoder { bytes, w, h ->
        val image = requireNotNull(ImageIO.read(bytes.inputStream())) { "Realm kit sheet is not a decodable image" }
        require(image.width == w && image.height == h) { "Realm kit artwork dimensions changed" }
        val argb = image.getRGB(0, 0, w, h, null, 0, w); val data = ByteArray(argb.size * 4)
        for (i in argb.indices) { val p = argb[i]; val at = i * 4
            data[at] = (p shr 16 and 255).toByte(); data[at + 1] = (p shr 8 and 255).toByte(); data[at + 2] = (p and 255).toByte(); data[at + 3] = (p ushr 24 and 255).toByte() }
        LayeredRgba(w, h, data)
    }

    @Test fun `every bundled revision-5 kit passes the device admission and draw-time plans over every claim`() {
        val catalogueRoot = reader.parse(root.resolve("render-catalog.json").readText())
        RendererCatalogue.validate(catalogueRoot)
        val section = assertNotNull(catalogueRoot.get("layeredGroundV5"),
            "the pinned pack carries no revision-5 kits: a base the server serves at revision 5 cannot open. If a pack without them is intended, rewrite this test to say why")
        val descriptors = assertNotNull(section.get("manifests"), "the bundled section lists its kits").toList()
        assertTrue(descriptors.isNotEmpty(), "an empty kit list admits nothing")
        assertEquals(realms, descriptors.map { it.getString("realmId") }.toSet(), "the bundled section must cover all eight realms")
        val catalogue = reader.parse(root.resolve("catalogue.json").readText())
        val rules = RealmKitRules.read(assertNotNull(catalogue.get("constants"), "The content pack has no constants"))
        val groundRealms = assertNotNull(RendererCatalogue.ground(catalogueRoot), "the ground contract names the realms").realms.toSet()
        assertEquals(realms, groundRealms, "the ground contract must name all eight realms")
        val T = catalogue.get("presentation").getString("tilePixels").toDouble()
        val extent = LayeredGroundRect(rules.extentOriginTile * T, rules.extentOriginTile * T, rules.extentTiles * T, rules.extentTiles * T)
        val centre = rules.plotTiles / 2
        val claims = (rules.claimTiles..(rules.frameMaxTile - rules.frameMinTile) step 2).map { RealmKitClaim(centre - it / 2, centre - it / 2 + it) }
        assertEquals(rules.smallestKingdom, claims.first(), "the sweep starts at the claim every base starts with")
        assertEquals(RealmKitClaim(rules.frameMinTile, rules.frameMaxTile), claims.last(), "and ends at the whole protected frame")
        // A fresh scene, one frame in, sub-second and multi-second clip phases, and an hour-long session.
        val clocks = listOf(0L, 1L, 250L, 1_000L, 7_777L, 3_600_000L)
        /** One kit through the device path; a failure names its realm. */
        fun admit(realm: String) {
            val source = RealmKitSource.read(section, realm, groundRealms, false, rules, ::read)
            val kit = source.kit
            assertEquals(realm, kit.realmId); assertEquals("accepted", kit.status, "$realm: a device build admits accepted kits only")
            val prepared = source.prepare(::read, decoder) {}
            assertEquals(kit.assets.keys, prepared.pages.map { it.asset.id }.toSet(), "$realm: every sheet is verified and decoded")
            kit.floorBounds(T)
            val chunks = RealmKitChunkCache(kit, T)
            val visible = chunks.visibleChunks(extent)
            assertEquals(chunks.chunksPerAxis * chunks.chunksPerAxis, visible.size, "$realm: the zoom floor sees every chunk of the extent")
            for (claim in claims) {
                kit.farDraw(T, extent)
                if (kit.overview != null) kit.overviewPlan(T, extent, claim)
                val quadClocks = if (claim == claims.first() || claim == claims.last()) clocks else listOf(0L)
                for (elapsed in quadClocks) for (reduced in listOf(false, true)) {
                    val quads = visible.sumOf { (cx, cy) -> chunks.vertices(cx, cy, claim, elapsed, reduced).quads }
                    assertTrue(quads > 0, "$realm claim ${claim.min}..${claim.max} @ $elapsed: the floor draws")
                }
                for (elapsed in clocks) for (reduced in listOf(false, true)) kit.groundBandPlan(T, extent, claim, elapsed, reduced)
            }
            // Server obstacle rows (E-11 expansion obstacles) stand on whole tiles anywhere in the frame.
            for (key in rules.obstacleSpriteKeys) {
                val size = kit.obstacleSize(key)
                for (state in RealmKitObstacleState.entries) for (ty in rules.frameMinTile..rules.frameMaxTile - size) for (tx in rules.frameMinTile..rules.frameMaxTile - size)
                    assertNotNull(kit.obstacleDraw(key, state, T, tx.toDouble(), ty.toDouble(), size.toDouble(), size.toDouble()),
                        "$realm: obstacle $key/$state at $tx,$ty has no kit draw; frozen dec_ artwork is not kit coverage")
            }
        }
        for (realm in realms) {
            try { admit(realm) } catch (failure: Exception) { throw AssertionError("$realm: this kit would not open on a device: ${failure.message}", failure) }
        }
    }
}
