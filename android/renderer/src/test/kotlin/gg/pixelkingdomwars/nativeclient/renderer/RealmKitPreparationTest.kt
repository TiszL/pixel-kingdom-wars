package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.utils.JsonReader
import com.badlogic.gdx.utils.JsonValue
import org.junit.Test
import javax.imageio.ImageIO
import kotlin.test.*

/** The worker-side admission path against the parity fixture's real PNG sheets: section → hash-pinned
 * manifest → validated kit → per-asset hash, decode and pixel rules (`assertRealmKitAssetPixels`). */
class RealmKitPreparationTest {
    private val reader = JsonReader()
    private fun resource(name: String) = checkNotNull(javaClass.getResourceAsStream("/realm-kit/$name")) { "missing test resource $name" }.readBytes()
    private val rules = RealmKitRules.read(reader.parse(resource("constants.json").decodeToString()))
    private val section = reader.parse(resource("layeredGroundV5.json").decodeToString())
    private val realms = setOf("crownlands", "thornwake")
    private val reads = mutableListOf<Pair<String, Int>>()
    private val read: (String, Int) -> ByteArray = { path, maximum -> reads += path to maximum; resource(path).also { assertTrue(it.size <= maximum, "$path exceeds $maximum") } }
    /** Straight RGBA from ImageIO, the same byte order `AndroidLayeredImageDecoder` produces. */
    private val decoder = LayeredImageDecoder { bytes, w, h ->
        val image = ImageIO.read(bytes.inputStream()); assertEquals(w, image.width); assertEquals(h, image.height)
        val argb = image.getRGB(0, 0, w, h, null, 0, w); val data = ByteArray(argb.size * 4)
        for (i in argb.indices) { val p = argb[i]; val at = i * 4
            data[at] = (p shr 16 and 255).toByte(); data[at + 1] = (p shr 8 and 255).toByte(); data[at + 2] = (p and 255).toByte(); data[at + 3] = (p ushr 24 and 255).toByte() }
        LayeredRgba(w, h, data)
    }
    private fun source(previewAllowed: Boolean = true, realm: String = "crownlands", mutate: (JsonValue) -> Unit = {}): RealmKitSource {
        val s = reader.parse(section.toJson(com.badlogic.gdx.utils.JsonWriter.OutputType.json)); mutate(s)
        return RealmKitSource.read(s, realm, realms, previewAllowed, rules, read)
    }
    @Test fun `section admission pins the manifest hash and path reads no more than the catalogue cap and refuses previews without a host opt-in`() {
        val s = source()
        assertTrue(s.identity(64f).startsWith("layered-r5:") && s.identity(64f).endsWith("@64.0"))
        assertEquals(rules.manifestBytes, reads.single().second); assertEquals("crownlands", s.kit.realmId)
        assertFailsWith<IllegalArgumentException> { source(previewAllowed = false) }
        assertFailsWith<IllegalArgumentException> { source(realm = "thornwake") }
        assertFailsWith<IllegalArgumentException> { source { it.get("manifests").get(0).get("sha256").set("0".repeat(64)) } }
        assertFailsWith<IllegalArgumentException> { source { it.get("manifests").get(0).get("manifestPath").set("atlas/fantasy/layered-ground/other/manifest.json") } }
        assertFailsWith<IllegalArgumentException> { source { it.get("version").set(2L, null) } }
        assertFailsWith<IllegalArgumentException> { source { it.get("manifests").get(0).get("realmId").set("thornwake") } }
        assertFailsWith<IllegalArgumentException> { source { it.get("status").set("accepted") } } // the manifest says preview-only
    }
    @Test fun `worker verifies every sheet hash decodes it and admits the fixture's binary-alpha opaque and keyed pixels`() {
        val s = source(); reads.clear()
        var checkpoints = 0
        val prepared = s.prepare(read, decoder) { checkpoints++ }
        assertEquals(listOf("tiles", "far", "overview", "oak", "oak-stump", "gull", "hare"), prepared.pages.map { it.asset.id })
        assertEquals(prepared.pages.map { it.asset.path to it.asset.size.toInt() }, reads)
        assertTrue(checkpoints > prepared.pages.size * 3, "cancellation probes between reads, decodes and pixel rows")
        val tiles = prepared.pages.first().pixels
        val bed = s.kit.cells[24]; val water = s.kit.cells[20]
        assertEquals(0, tiles.bytes[((bed.y) * tiles.width + bed.x) * 4 + 3].toInt() and 255, "the bed cell is a hole")
        for (f in 0 until water.frames) assertEquals(255, tiles.bytes[((water.y) * tiles.width + water.x + f * 32) * 4 + 3].toInt() and 255, "water frame $f is opaque")
        assertFailsWith<IllegalArgumentException>("integrity") { s.prepare({ path, max -> read(path, max).also { it[it.size - 1] = (it[it.size - 1] + 1).toByte() } }, decoder) {} }
    }
    @Test fun `worker rejects translucent texels far or overview holes dimension drift and a base texel covering open water in any frame`() {
        val s = source(); val kit = s.kit
        fun decoded(id: String): LayeredRgba { val a = kit.asset(id); return decoder.decode(resource(a.path), a.width, a.height) }
        fun rejects(id: String, message: String, mutate: (LayeredRgba) -> LayeredRgba) {
            val failure = assertFailsWith<IllegalArgumentException>(id) { RealmKitSource.validatePixels(kit, kit.asset(id), mutate(decoded(id))) }
            assertEquals(message, failure.message)
        }
        for (a in kit.assets.values) RealmKitSource.validatePixels(kit, a, decoded(a.id))
        rejects("oak", "Realm kit sheets must have binary alpha") { p -> p.also { it.bytes[3] = 128.toByte() } }
        rejects("far", "Realm kit far and overview stills must be opaque") { p -> p.also { it.bytes[3] = 0 } }
        rejects("overview", "Realm kit far and overview stills must be opaque") { p -> p.also { it.bytes[7] = 0 } }
        rejects("tiles", "Realm kit artwork dimensions changed") { p -> LayeredRgba(p.width, p.height - 1, p.bytes) }
        val bed = kit.cells[24]
        rejects("tiles", "A base cell covers open water") { p -> p.also { it.bytes[((bed.y + 5) * it.width + bed.x + 5) * 4 + 3] = 255.toByte() } }
        // The bed is keyed against every water frame: an opaque texel in the LAST water frame is still covered by the bed hole.
        rejects("tiles", "A base cell covers open water") { p -> p.also { it.bytes[((bed.y + 31) * it.width + bed.x + 31) * 4 + 3] = 255.toByte() } }
        // Only the pairs the layers actually stack are checked: an opaque texel in an unused row of the sheet is fine.
        RealmKitSource.validatePixels(kit, kit.asset("tiles"), decoded("tiles").also { it.bytes[((200) * it.width + 200) * 4 + 3] = 255.toByte() })
        var probes = 0
        assertFailsWith<IllegalStateException> { s.prepare(read, decoder) { probes++; if (probes == 4) error("superseded during pixel rows") } }
        assertEquals(4, probes)
    }
}
