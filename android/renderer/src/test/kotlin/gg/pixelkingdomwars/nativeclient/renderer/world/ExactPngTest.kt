package gg.pixelkingdomwars.nativeclient.renderer.world

import com.badlogic.gdx.utils.JsonReader
import java.io.File
import java.lang.management.ManagementFactory
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue
import org.junit.Test

/**
 * NR10 (GLOBE-NATIVE-PLAN §10.1): world data PNGs carry numbers in RGB under alpha 0 (deed masks, selection fields).
 * Android's own decoders premultiply and lose them, so the realm map reads data files through [ExactPng], which must
 * give exactly the bytes the web loader's `decodePng` gives. The goldens (`tools/world-fixtures.mjs`) hold that RGBA.
 */
class ExactPngTest {
    private fun bytes(path: String) = checkNotNull(javaClass.getResourceAsStream("/world/fixtures/$path")) { path }.use { it.readBytes() }
    private val goldens = JsonReader().parse(String(bytes("index.json"))).get("png")
    private fun golden(name: String) = bytes("png/$name.png")

    @Test fun `every golden decodes to the web loader's straight RGBA byte for byte`() {
        val types = mutableSetOf<Int>()
        for (g in goldens) {
            val name = g.getString("name")
            val image = assertNotNull(ExactPng.decode(bytes(g.getString("png"))), "$name must decode")
            assertEquals(g.getInt("width"), image.width, name); assertEquals(g.getInt("height"), image.height, name)
            assertContentEquals(bytes(g.getString("rgba")), image.rgba, "$name: any byte off is a wrong deed, field or key texel")
            types += g.getInt("colorType")
        }
        assertEquals(setOf(0, 2, 3, 4, 6), types, "the goldens must exercise every PNG colour type the packs may use")
    }

    @Test fun `alpha-0 texels keep their RGB, which a premultiplying decoder would zero`() {
        val image = assertNotNull(ExactPng.decode(golden("rgba-alpha0")))
        assertTrue(ExactPng.alphaRgbCount(image.rgba) > 0, "the golden must hold data under alpha 0, or this test proves nothing")
        assertEquals(ExactPng.alphaRgbCount(bytes("png/rgba-alpha0.rgba")), ExactPng.alphaRgbCount(image.rgba))
    }

    @Test fun `formats the web decoder refuses are refused, never approximated`() {
        fun ihdr(name: String, offset: Int, value: Int) = golden(name).also { it[16 + offset] = value.toByte() }
        assertNull(ExactPng.decode(ihdr("rgb-filters", 12, 1)), "Adam7 interlace")
        assertNull(ExactPng.decode(ihdr("rgb-filters", 8, 16)), "16-bit samples")
        assertNull(ExactPng.decode(ihdr("gray-trns", 8, 4)), "sub-byte grey (only palettes may be under 8 bits)")
        assertNull(ExactPng.decode(ihdr("rgb-filters", 9, 5)), "an undefined colour type")
        assertNull(ExactPng.decode(golden("rgb-filters").also { it[1] = 0 }), "not a PNG signature")
        val noPalette = golden("palette4-trns").also { b -> val at = String(b, Charsets.ISO_8859_1).indexOf("PLTE"); b[at] = 'p'.code.toByte() }
        assertNull(ExactPng.decode(noPalette), "a palette image without PLTE")
    }

    @Test fun `a truncated image stream is refused`() {
        val full = golden("rgba-alpha0")
        val idat = String(full, Charsets.ISO_8859_1).indexOf("IDAT")
        assertNull(ExactPng.decode(full.copyOf(idat + 4 + 6)), "a cut-off IDAT must not decode into a partly zero image")
    }

    // ---- the streaming decoder (P0 memory, 2026-09-26) ----------------------------------------------------------------
    // The owner's Seeker ran out of its 256 MB Java heap inside this decoder after a few realm visits: the old one held
    // the chunk copies, the whole raw stream and the unfiltered pixels next to the output (about 3.1x). The rewrite must
    // give the same bytes and refuse the same files, or a deed mask or a field turns into a wrong number on the map.

    /** Every PNG the world bundle ships, plus every PNG in the test resources (fixtures, packs, globe masks). */
    private fun allPngs(): List<File> {
        fun under(dir: String) = File(dir).walkTopDown().filter { it.isFile && it.name.endsWith(".png") }.sortedBy { it.path }.toList()
        val world = under("../app/src/main/assets/world"); val res = under("src/test/resources")
        assertTrue(world.size >= 90, "the world bundle's PNGs were not found (${world.size}): the comparison would prove nothing")
        assertTrue(res.size >= 25, "the test resources' PNGs were not found (${res.size})")
        return world + res
    }

    private fun assertSameAsReference(what: String, png: ByteArray): Boolean {
        val want = ExactPngReference.decode(png); val got = ExactPng.decode(png)
        if (want == null) { assertNull(got, "$what: the old decoder refused it, the streaming one must too"); return false }
        assertNotNull(got, "$what: the old decoder read it, the streaming one refused it")
        assertEquals(want.width, got.width, what); assertEquals(want.height, got.height, what)
        assertContentEquals(want.rgba, got.rgba, "$what: a byte off is a wrong deed, field or key texel")
        return true
    }

    /** 16 corrupt variants: 6 truncations and 10 bit flips aimed at the header, the chunk walk and the zlib stream. The
     *  header flips only touch the low byte of width and height, so no variant declares an image the test heap cannot hold. */
    private fun corrupt(b: ByteArray): List<Pair<String, ByteArray>> {
        fun u32(at: Int) = ((b[at].toLong() and 0xff) shl 24) or ((b[at + 1].toLong() and 0xff) shl 16) or ((b[at + 2].toLong() and 0xff) shl 8) or (b[at + 3].toLong() and 0xff)
        val idat = ArrayList<IntArray>() // [chunk offset, data start, data end]
        var p = 8
        while (p + 8 <= b.size) {
            val len = u32(p); val end = minOf(b.size.toLong(), p + 8 + len).toInt()
            if (String(b, p + 4, 4, Charsets.ISO_8859_1) == "IDAT") idat += intArrayOf(p, p + 8, end)
            val next = p + 12L + len; if (next > Int.MAX_VALUE) break; p = next.toInt()
        }
        val d0 = idat.firstOrNull()?.get(1) ?: minOf(33, b.size - 1); val d1 = idat.lastOrNull()?.get(2) ?: b.size
        val lenAt = idat.firstOrNull()?.get(0) ?: 8
        fun cut(n: Int) = b.copyOf(n.coerceIn(0, b.size))
        fun flip(at: Int, mask: Int) = b.copyOf().also { val i = at.coerceIn(0, b.size - 1); it[i] = (it[i].toInt() xor mask).toByte() }
        return listOf(
            "cut in the IHDR" to cut(20), "cut before the image stream" to cut(d0 - 8), "cut in the zlib header" to cut(d0 + 1),
            "cut mid-stream" to cut((d0 + d1) / 2), "cut before the last stream byte" to cut(d1 - 1), "no IEND" to cut(d1 + 4),
            "width +-1" to flip(19, 1), "height +-2" to flip(23, 2), "bit depth" to flip(24, 8), "colour type" to flip(25, 4),
            "first IDAT length" to flip(lenAt + 3, 1), "zlib header" to flip(d0, 0x20), "first deflate block header" to flip(d0 + 2, 1),
            "a third into the stream" to flip(d0 + (d1 - d0) / 3, 0x10), "two thirds into the stream" to flip(d0 + 2 * (d1 - d0) / 3, 0x04),
            "adler32 trailer" to flip(d1 - 1, 0x80),
        )
    }

    @Test fun `the streaming decoder gives the old decoder's bytes for every PNG of the world bundle and the test resources`() {
        var decoded = 0
        val files = allPngs()
        for (f in files) if (assertSameAsReference(f.path, f.readBytes())) decoded++
        assertTrue(decoded >= files.size * 9 / 10, "most of them must decode, or the byte comparison covers little: $decoded of ${files.size}")
    }

    @Test fun `sixteen corrupt variants of every PNG are refused or read exactly as the old decoder did`() {
        var refused = 0; var read = 0
        for (f in allPngs()) {
            val variants = corrupt(f.readBytes())
            assertEquals(16, variants.size)
            for ((what, bytes) in variants) if (assertSameAsReference("${f.path}: $what", bytes)) read++ else refused++
        }
        assertTrue(refused > 0 && read > 0, "the variants must exercise both outcomes: $refused refused, $read read")
    }

    @Test fun `a decode allocates its output once, not three times over`() {
        val bean = ManagementFactory.getThreadMXBean() as com.sun.management.ThreadMXBean
        assertTrue(bean.isThreadAllocatedMemorySupported, "this JVM cannot count allocations: the gate would prove nothing")
        bean.isThreadAllocatedMemoryEnabled = true
        val png = File("../app/src/main/assets/world/realm/crownlands/spr.png").readBytes() // 2048 x 1392 RGBA, 11.4 MB decoded
        ExactPng.decode(png) // warm-up (class init, JIT)
        val tid = Thread.currentThread().id
        val before = bean.getThreadAllocatedBytes(tid)
        val image = assertNotNull(ExactPng.decode(png))
        val allocated = bean.getThreadAllocatedBytes(tid) - before
        val output = image.rgba.size.toLong()
        assertTrue(allocated <= output + output / 20 + (256 shl 10),
            "one crownlands sprite atlas decode allocated $allocated B for a $output B image: the heap peak must stay near 1x (the old decoder: ~3.1x)")
    }

    @Test fun `the test hook sees every decoded array and production leaves it unset`() {
        assertNull(ExactPng.trace, "the trace hook is test-only")
        val seen = ArrayList<Any>()
        ExactPng.trace = { seen += it }
        try {
            val image = assertNotNull(ExactPng.decode(golden("rgba-alpha0")))
            assertEquals(1, seen.size); assertSame(image.rgba, seen[0])
            assertNull(ExactPng.decode(golden("rgba-alpha0").copyOf(40)))
            assertEquals(1, seen.size, "a refused file reports nothing")
        } finally { ExactPng.trace = null }
    }

    @Test fun `a header past the PNG size limit is refused`() {
        val png = golden("rgba-alpha0")
        for (at in 16..23) png[at] = (if (at % 4 == 0) 0x7f else 0xff).toByte() // width = height = 2^31 - 1
        assertNull(ExactPng.decode(png), "a 2^31 x 2^31 image: its size overflows 64-bit arithmetic in the old checks")
    }
}
