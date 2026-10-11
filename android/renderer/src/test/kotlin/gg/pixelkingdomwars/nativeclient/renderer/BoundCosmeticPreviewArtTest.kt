package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.files.FileHandle
import com.badlogic.gdx.utils.JsonReader
import java.io.File
import java.nio.file.Files
import org.junit.Test
import kotlin.test.*

/** The Awning preview handle against the ACTUAL exported candidate pack: the idle
 *  cell is cut from the packed atlas by the same geometry rule the scene uses, its
 *  digest must equal the admitted table, and the returned PNG re-decodes to exactly
 *  those bytes. Pure JVM: no gdx natives, no GL, no network. */
class BoundCosmeticPreviewArtTest {
    private val pack = CosmeticsCandidateFixture.root
    private fun art() = requireNotNull(RendererCatalogue.serviceArt(JsonReader().parse(CosmeticsCandidateFixture.renderCatalogueText())))

    @Test fun `codec round-trips every filter type and refuses foreign shapes`() {
        val width = 7; val height = 5; val rgba = ByteArray(width * height * 4) { ((it * 37) % 251).toByte() }
        val png = PngRgba.encode(width, height, rgba)
        val decoded = PngRgba.decode(png)
        assertEquals(width, decoded.width); assertEquals(height, decoded.height); assertContentEquals(rgba, decoded.rgba)
        assertContentEquals(rgba.copyOfRange(4 * 4 + 4, 4 * 4 + 4 + 8), PngRgba.crop(decoded, 1, 1, 2, 1).let { it.copyOfRange(0, 8) }.let { crop ->
            // row 1, columns 1..2 of the source == bytes [(1*7+1)*4, +8)
            rgba.copyOfRange((1 * width + 1) * 4, (1 * width + 1) * 4 + 8).also { assertContentEquals(it, crop) }; rgba.copyOfRange(4 * 4 + 4, 4 * 4 + 4 + 8) })
        assertFails { PngRgba.decode(png.copyOf(30)) }
        assertFails { PngRgba.decode(ByteArray(64)) }
        assertFails { PngRgba.crop(decoded, 6, 0, 2, 1) }
        assertFails { PngRgba.encode(0, 1, ByteArray(0)) }
        // The packed atlases themselves decode (all five PNG filters may appear).
        val atlas = PngRgba.decode(File(pack, "atlas/pe_cosmetics@1x.png").readBytes())
        assertEquals(atlas.width * atlas.height * 4, atlas.rgba.size)
    }

    @Test(timeout = 10_000) fun `codec refuses a zlib stream that asks for a preset dictionary instead of spinning`() {
        // With FDICT set, Inflater returns 0 while neither finished nor out of input; the loop must
        // refuse it rather than spin. Pinned pack bytes never carry FDICT, but the codec is general.
        val png = PngRgba.encode(3, 2, ByteArray(24) { it.toByte() })
        val marker = "IDAT".toByteArray(Charsets.US_ASCII)
        val idat = (0..png.size - 4).first { i -> marker.indices.all { png[i + it] == marker[it] } } + 4
        val cmf = png[idat].toInt() and 0xff
        var flg = (png[idat + 1].toInt() and 0xC0) or 0x20 // keep FLEVEL, set FDICT, clear FCHECK
        flg = flg or ((31 - (cmf * 256 + flg) % 31) % 31) // FCHECK: CMF*256+FLG must be a multiple of 31
        png[idat + 1] = flg.toByte()
        assertFails { PngRgba.decode(png) }
    }

    @Test fun `each Awning idle cell is cut from the leased candidate atlas and its digest equals the admitted table`() {
        val graph = art(); val checkpoints = mutableListOf<Int>()
        for (tier in 1..4) {
            val outputId = "artisan_market_awning_t$tier"
            val cell = BoundCosmeticPreviewArt.idleCell(graph, outputId, FileHandle(pack)) { checkpoints += tier }
            assertEquals(outputId, cell.outputId); assertEquals(tier, cell.tier); assertEquals("pe_cosmetics", cell.group)
            assertEquals("pe_cos_market_t${tier}_idle_f1", cell.frame)
            assertEquals(112, cell.cellW); assertEquals(112, cell.cellH); assertEquals(56, cell.pivotX); assertEquals(112, cell.pivotY)
            val clip = requireNotNull(graph.cosmetics).clips.getValue("pe_cos_market_t${tier}_idle")
            assertEquals(clip.frames.single().sha256, cell.rgbaSha256, "the cut cell IS the packed cell the table admitted")
            assertEquals(requireNotNull(graph.cosmetics).bindings.getValue(outputId).sha256, cell.bindingSha256)
            val png = cell.pngBytes; val again = cell.pngBytes
            assertNotSame(png, again, "every delivery is a fresh copy"); assertContentEquals(png, again)
            val decoded = PngRgba.decode(png)
            assertEquals(112, decoded.width); assertEquals(112, decoded.height)
            val digest = java.security.MessageDigest.getInstance("SHA-256").digest(decoded.rgba).joinToString("") { "%02x".format(it) }
            assertEquals(cell.rgbaSha256, digest, "the PNG carries exactly the verified bytes")
            assertTrue(decoded.rgba.indices.step(4).any { decoded.rgba[it + 3].toInt() != 0 }, "the Awning cell is not blank")
        }
        assertTrue(checkpoints.size >= 4 * 3, "guard checkpoints run before and after every IO step")
    }

    @Test fun `the Aurora Wake authored first frame is cut from the leased atlas and its digest equals the admitted table`() {
        val graph = art(); val checkpoints = intArrayOf(0)
        val cell = BoundCosmeticPreviewArt.wakeCell(graph, FileHandle(pack)) { checkpoints[0]++ }
        assertEquals("aurora_wake", cell.outputId); assertEquals("pe_cosmetics", cell.group); assertEquals("pe_cos_wake_f1", cell.frame)
        assertEquals(64, cell.cellW); assertEquals(64, cell.cellH); assertEquals(32, cell.anchorX); assertEquals(32, cell.anchorY)
        val cosmetics = requireNotNull(graph.cosmetics)
        assertEquals(cosmetics.clips.getValue("pe_cos_wake").frames.single { it.key == "pe_cos_wake_f1" }.sha256, cell.rgbaSha256, "the cut cell IS the packed cell the table admitted")
        assertEquals(cosmetics.wakeBinding.sha256, cell.bindingSha256)
        val png = cell.pngBytes; val again = cell.pngBytes
        assertNotSame(png, again, "every delivery is a fresh copy"); assertContentEquals(png, again)
        val decoded = PngRgba.decode(png)
        assertEquals(64, decoded.width); assertEquals(64, decoded.height)
        val digest = java.security.MessageDigest.getInstance("SHA-256").digest(decoded.rgba).joinToString("") { "%02x".format(it) }
        assertEquals(cell.rgbaSha256, digest, "the PNG carries exactly the verified bytes")
        assertTrue(decoded.rgba.indices.step(4).any { decoded.rgba[it + 3].toInt() != 0 }, "the wake cell is not blank")
        assertTrue(checkpoints[0] >= 3, "guard checkpoints run before and after every IO step")
        // A renderer15 graph carries no wake art; a tampered wake pixel is refused by the digest rule.
        val root = JsonReader().parse(CosmeticsCandidateFixture.renderCatalogueText())
        root.get("rendererContractVersion").set(15L, null); root.remove("boundCosmetics")
        assertFails { BoundCosmeticPreviewArt.wakeCell(requireNotNull(RendererCatalogue.serviceArt(root)), FileHandle(pack)) }
        val tampered = Files.createTempDirectory("wake-tamper").toFile()
        File(tampered, "atlas").mkdirs()
        File(pack, "atlas/pe_cosmetics@1x.json").copyTo(File(tampered, "atlas/pe_cosmetics@1x.json"))
        val image = PngRgba.decode(File(pack, "atlas/pe_cosmetics@1x.png").readBytes())
        val json = JsonReader().parse(File(pack, "atlas/pe_cosmetics@1x.json").readText())
        val frame = json.get("textures").get(0).get("frames").first { it.getString("filename") == cell.frame }.get("frame")
        val x = frame.getInt("x"); val y = frame.getInt("y")
        image.rgba[((y + 3) * image.width + x + 3) * 4] = (image.rgba[((y + 3) * image.width + x + 3) * 4] + 1).toByte()
        File(tampered, "atlas/pe_cosmetics@1x.png").writeBytes(PngRgba.encode(image.width, image.height, image.rgba))
        assertFails { BoundCosmeticPreviewArt.wakeCell(graph, FileHandle(tampered)) }
    }

    @Test fun `a foreign output an unknown pack or a tampered cell is refused`() {
        val graph = art()
        assertFails { BoundCosmeticPreviewArt.idleCell(graph, "aurora_wake", FileHandle(pack)) }
        assertFails { BoundCosmeticPreviewArt.idleCell(graph, "artisan_market_awning_t9", FileHandle(pack)) }
        // A renderer15 graph carries no Awning art at all.
        val root = JsonReader().parse(CosmeticsCandidateFixture.renderCatalogueText())
        root.get("rendererContractVersion").set(15L, null); root.remove("boundCosmetics")
        assertFails { BoundCosmeticPreviewArt.idleCell(requireNotNull(RendererCatalogue.serviceArt(root)), "artisan_market_awning_t1", FileHandle(pack)) }
        // A lease whose PNG bytes were altered after pinning: the digest check refuses the preview.
        val tampered = Files.createTempDirectory("awning-tamper").toFile()
        File(tampered, "atlas").mkdirs()
        File(pack, "atlas/pe_cosmetics@1x.json").copyTo(File(tampered, "atlas/pe_cosmetics@1x.json"))
        val image = PngRgba.decode(File(pack, "atlas/pe_cosmetics@1x.png").readBytes())
        val cell = BoundCosmeticPreviewArt.idleCell(graph, "artisan_market_awning_t1", FileHandle(pack))
        val json = JsonReader().parse(File(pack, "atlas/pe_cosmetics@1x.json").readText())
        val frame = json.get("textures").get(0).get("frames").first { it.getString("filename") == cell.frame }.get("frame")
        val x = frame.getInt("x"); val y = frame.getInt("y")
        image.rgba[((y + 3) * image.width + x + 3) * 4] = (image.rgba[((y + 3) * image.width + x + 3) * 4] + 1).toByte()
        val altered = PngRgba.encode(image.width, image.height, image.rgba)
        // Keep the pinned size so only the digest can tell (pad/trim via a store-friendly re-encode is not possible; sizes differ, so the
        // packed-geometry rule refuses first — either way the preview is refused, never a wrong cell).
        File(tampered, "atlas/pe_cosmetics@1x.png").writeBytes(altered)
        assertFails { BoundCosmeticPreviewArt.idleCell(graph, "artisan_market_awning_t1", FileHandle(tampered)) }
    }
}
