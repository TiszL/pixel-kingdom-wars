package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.files.FileHandle
import com.badlogic.gdx.graphics.Pixmap
import com.badlogic.gdx.graphics.TextureData
import java.io.ByteArrayOutputStream
import java.io.DataOutputStream
import java.nio.ByteBuffer
import java.security.MessageDigest
import java.util.zip.CRC32
import java.util.zip.Deflater
import java.util.zip.Inflater

/** The VERIFIED untrimmed idle cell of one admitted Awning, cut from the leased
 *  packed `pe_cosmetics` atlas: its geometry, the cell's RGBA digest (equal to the
 *  packed table's `rgbaSha256`, or it is refused) and a fresh PNG encoding of
 *  exactly those bytes for the caller to display. [pngBytes] is owned by the
 *  receiver; every delivery is a new copy. */
class BoundCosmeticIdleCell(val outputId: String, val tier: Int, val group: String, val frame: String,
    val cellW: Int, val cellH: Int, val pivotX: Int, val pivotY: Int, val rgbaSha256: String, val bindingSha256: String,
    private val png: ByteArray) {
    val pngBytes: ByteArray get() = png.copyOf()
}

/** The VERIFIED authored first frame of the Aurora Wake (`pe_cos_wake_f1`, the clip's
 *  reduced-motion still), cut from the leased packed `pe_cosmetics` atlas under the same
 *  digest rule as [BoundCosmeticIdleCell]. Source preview only: it carries no trip,
 *  attachment, readiness or application meaning. [pngBytes] is a fresh copy per read. */
class BoundCosmeticWakeCell(val outputId: String, val group: String, val frame: String,
    val cellW: Int, val cellH: Int, val anchorX: Int, val anchorY: Int, val rgbaSha256: String, val bindingSha256: String,
    private val png: ByteArray) {
    val pngBytes: ByteArray get() = png.copyOf()
}

/** Pure-JVM (and Android) cell extraction for the Awning preview handle. It never
 *  touches GL, gdx natives or the network: the packed atlas is validated through
 *  the same [readServiceAtlas] rule the scene uses, decoded here from the leased
 *  PNG bytes, and only a cell whose digest equals the admitted table is returned. */
object BoundCosmeticPreviewArt {
    /** [directory] is a lease directory that owns the verified group files. */
    fun idleCell(art: PhaseEServiceArt, outputId: String, directory: FileHandle, checkpoint: () -> Unit = {}): BoundCosmeticIdleCell {
        val cosmetics = requireNotNull(art.cosmetics) { "This content pack carries no Awning art" }
        val binding = requireNotNull(cosmetics.bindings[outputId]) { "Unknown Awning" }
        val appearance = cosmetics.appearances.getValue(PhaseECosmeticArt.appearanceId(outputId))
        val still = appearance.states.getValue("idle") as ServiceArtState.Still
        val clip = cosmetics.clips.getValue(still.key.removeSuffix("_f1"))
        val expectedDigest = clip.frames.single { it.key == still.key }.sha256
        checkpoint()
        val packed = readServiceAtlas(art, cosmetics.group, directory) { file -> headerOnlyPixels(file) }
        try {
            checkpoint()
            val cell = packed.cells.getValue(still.key)
            val image = directory.child(cosmetics.group.imagePath).readBytes()
            checkpoint()
            val decoded = PngRgba.decode(image)
            require(decoded.width == packed.pixels.data.width && decoded.height == packed.pixels.data.height)
            val rgba = PngRgba.crop(decoded, cell.x, cell.y, cell.width, cell.height)
            val digest = sha256(rgba)
            require(digest == expectedDigest) { "Packed Awning cell differs from its admitted digest" }
            checkpoint()
            val png = PngRgba.encode(cell.width, cell.height, rgba)
            return BoundCosmeticIdleCell(outputId, requireNotNull(appearance.tier), cosmetics.group.id, still.key, cell.width, cell.height,
                clip.anchorPx.x.toInt(), clip.anchorPx.y.toInt(), digest, binding.sha256, png)
        } finally { packed.pixels.close() }
    }

    /** C5a source preview: the wake's authored frame 1 (source index 0 = its reduced-motion
     *  frame) from the leased group, refused unless its digest equals the admitted table. */
    fun wakeCell(art: PhaseEServiceArt, directory: FileHandle, checkpoint: () -> Unit = {}): BoundCosmeticWakeCell {
        val cosmetics = requireNotNull(art.cosmetics) { "This content pack carries no Aurora Wake art" }
        val binding = cosmetics.wakeBinding
        val clip = cosmetics.clips.getValue(PhaseECosmeticArt.WAKE_CLIP)
        val still = clip.frames.single { it.key == "${PhaseECosmeticArt.WAKE_CLIP}_f1" }
        require(still.sourceIndex == 0) { "The wake preview is its authored first (reduced-motion) frame" }
        checkpoint()
        val packed = readServiceAtlas(art, cosmetics.group, directory) { file -> headerOnlyPixels(file) }
        try {
            checkpoint()
            val cell = packed.cells.getValue(still.key)
            require(cell.width == clip.cell.x.toInt() && cell.height == clip.cell.y.toInt()) { "Packed wake cell differs from its authored size" }
            val image = directory.child(cosmetics.group.imagePath).readBytes()
            checkpoint()
            val decoded = PngRgba.decode(image)
            require(decoded.width == packed.pixels.data.width && decoded.height == packed.pixels.data.height)
            val rgba = PngRgba.crop(decoded, cell.x, cell.y, cell.width, cell.height)
            val digest = sha256(rgba)
            require(digest == still.sha256) { "Packed wake cell differs from its admitted digest" }
            checkpoint()
            val png = PngRgba.encode(cell.width, cell.height, rgba)
            return BoundCosmeticWakeCell(binding.outputId, cosmetics.group.id, still.key, cell.width, cell.height,
                clip.anchorPx.x.toInt(), clip.anchorPx.y.toInt(), digest, binding.sha256, png)
        } finally { packed.pixels.close() }
    }

    private fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    /** Width/height/format from the PNG header only, so packed-geometry validation runs
     *  without decoding through gdx natives; the pixels themselves are decoded by [PngRgba]. */
    private fun headerOnlyPixels(file: FileHandle): ServiceTexturePixels {
        val header = ByteArray(29); file.read().use { input -> java.io.DataInputStream(input).readFully(header) }
        val width = ByteBuffer.wrap(header, 16, 4).int; val height = ByteBuffer.wrap(header, 20, 4).int
        return ServiceTexturePixels(object : TextureData {
            override fun getType() = TextureData.TextureDataType.Pixmap
            override fun isPrepared() = true
            override fun prepare(): Unit = error("Header-only preview pixels are never uploaded")
            override fun consumePixmap(): Pixmap = error("Header-only preview pixels are never uploaded")
            override fun disposePixmap() = false
            override fun consumeCustomData(target: Int): Unit = error("No custom upload")
            override fun getWidth() = width
            override fun getHeight() = height
            override fun getFormat() = Pixmap.Format.RGBA8888
            override fun useMipMaps() = false
            override fun isManaged() = true
        }) {}
    }
}

/** Minimal 8-bit RGBA PNG codec (non-interlaced, colour type 6), the only shape the
 *  packer emits (readServiceAtlas pins the IHDR). Bounded to 4096×4096. */
object PngRgba {
    class Image(val width: Int, val height: Int, val rgba: ByteArray)
    private val signature = byteArrayOf(-119, 80, 78, 71, 13, 10, 26, 10)

    fun decode(bytes: ByteArray): Image {
        require(bytes.size > 33 && bytes.copyOfRange(0, 8).contentEquals(signature)) { "Not a PNG" }
        var offset = 8; var width = 0; var height = 0; var seenHeader = false
        val idat = ByteArrayOutputStream()
        while (offset + 8 <= bytes.size) {
            val length = ByteBuffer.wrap(bytes, offset, 4).int; val type = String(bytes, offset + 4, 4, Charsets.US_ASCII)
            require(length >= 0 && offset + 12 + length <= bytes.size) { "Truncated PNG chunk" }
            val data = offset + 8
            when (type) {
                "IHDR" -> {
                    require(length == 13 && !seenHeader); seenHeader = true
                    width = ByteBuffer.wrap(bytes, data, 4).int; height = ByteBuffer.wrap(bytes, data + 4, 4).int
                    require(width in 1..4096 && height in 1..4096) { "Unsupported PNG size" }
                    require(bytes[data + 8].toInt() == 8 && bytes[data + 9].toInt() == 6 && bytes[data + 10].toInt() == 0
                        && bytes[data + 11].toInt() == 0 && bytes[data + 12].toInt() == 0) { "Only 8-bit non-interlaced RGBA is packed" }
                }
                "IDAT" -> { require(seenHeader); idat.write(bytes, data, length) }
                "IEND" -> break
                else -> {}
            }
            offset = data + length + 4
        }
        require(seenHeader && idat.size() > 0) { "PNG without image data" }
        val stride = width * 4; val raw = ByteArray(height * (stride + 1))
        val inflater = Inflater()
        try {
            inflater.setInput(idat.toByteArray())
            var filled = 0
            while (filled < raw.size) {
                val n = inflater.inflate(raw, filled, raw.size - filled)
                if (n == 0) { require(!inflater.finished() && !inflater.needsInput() && !inflater.needsDictionary()) { "PNG image data is short or asks for a preset dictionary" } }
                filled += n
            }
            require(inflater.finished() || inflater.inflate(ByteArray(1)) == 0) { "PNG image data is long" }
        } finally { inflater.end() }
        val out = ByteArray(height * stride)
        for (row in 0 until height) {
            val filter = raw[row * (stride + 1)].toInt(); val src = row * (stride + 1) + 1; val dst = row * stride; val prev = dst - stride
            for (i in 0 until stride) {
                val x = raw[src + i].toInt() and 0xff
                val a = if (i >= 4) out[dst + i - 4].toInt() and 0xff else 0
                val b = if (row > 0) out[prev + i].toInt() and 0xff else 0
                val c = if (row > 0 && i >= 4) out[prev + i - 4].toInt() and 0xff else 0
                val value = when (filter) {
                    0 -> x
                    1 -> x + a
                    2 -> x + b
                    3 -> x + ((a + b) ushr 1)
                    4 -> { val p = a + b - c; val pa = Math.abs(p - a); val pb = Math.abs(p - b); val pc = Math.abs(p - c)
                        x + if (pa <= pb && pa <= pc) a else if (pb <= pc) b else c }
                    else -> throw IllegalArgumentException("Unknown PNG filter $filter")
                }
                out[dst + i] = value.toByte()
            }
        }
        return Image(width, height, out)
    }

    fun crop(image: Image, x: Int, y: Int, width: Int, height: Int): ByteArray {
        require(x >= 0 && y >= 0 && width > 0 && height > 0 && x + width <= image.width && y + height <= image.height)
        val out = ByteArray(width * height * 4)
        for (row in 0 until height) System.arraycopy(image.rgba, ((y + row) * image.width + x) * 4, out, row * width * 4, width * 4)
        return out
    }

    fun encode(width: Int, height: Int, rgba: ByteArray): ByteArray {
        require(width in 1..4096 && height in 1..4096 && rgba.size == width * height * 4)
        val stride = width * 4; val raw = ByteArray(height * (stride + 1))
        for (row in 0 until height) { raw[row * (stride + 1)] = 0; System.arraycopy(rgba, row * stride, raw, row * (stride + 1) + 1, stride) }
        val deflater = Deflater(Deflater.BEST_COMPRESSION); val compressed = ByteArrayOutputStream()
        try {
            deflater.setInput(raw); deflater.finish(); val buffer = ByteArray(64 * 1024)
            while (!deflater.finished()) compressed.write(buffer, 0, deflater.deflate(buffer))
        } finally { deflater.end() }
        val out = ByteArrayOutputStream(); out.write(signature)
        fun chunk(type: String, data: ByteArray) {
            val stream = DataOutputStream(out); stream.writeInt(data.size)
            val typeBytes = type.toByteArray(Charsets.US_ASCII); stream.write(typeBytes); stream.write(data)
            val crc = CRC32(); crc.update(typeBytes); crc.update(data); stream.writeInt(crc.value.toInt()); stream.flush()
        }
        val header = ByteBuffer.allocate(13).putInt(width).putInt(height).put(8).put(6).put(0).put(0).put(0).array()
        chunk("IHDR", header); chunk("IDAT", compressed.toByteArray()); chunk("IEND", ByteArray(0))
        return out.toByteArray()
    }
}
