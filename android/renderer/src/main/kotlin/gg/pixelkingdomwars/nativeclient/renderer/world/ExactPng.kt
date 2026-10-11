package gg.pixelkingdomwars.nativeclient.renderer.world

import java.util.zip.DataFormatException
import java.util.zip.Inflater

/**
 * The exact PNG decoder for world data files (GLOBE-NATIVE-PLAN §9 N0, risk NR10), a 1:1 port of the web realm loader's
 * `decodePng` (`src/realm/loader.js`, "exact PNG decode").
 *
 * Why it exists: Android's `BitmapFactory` (like a 2D canvas) premultiplies alpha, so a texel with alpha 0 loses its
 * RGB. Deed masks, selection fields and other data PNGs carry values in RGB under alpha 0, and the realm map reads them
 * as numbers, not colours. This decoder returns straight RGBA8, byte for byte what the web engine sees.
 *
 * Same scope as the web: non-interlaced PNGs, bit depth 8 in every colour type, plus palette PNGs at 1, 2 or 4 bits.
 * tRNS follows the web exactly: a colour key for grey (type 0) and RGB (type 2) compares the low byte of each 16-bit
 * key sample, and palette entries past the end of tRNS are opaque. Anything else, and any malformed stream, is null:
 * the caller refuses the file rather than decoding it approximately. Chunk CRCs are not checked, as on the web; the
 * pack's sha256 is the integrity check. Pure JVM (no Android), so it runs on the decode threads and in JVM tests.
 *
 * Streaming (P0 memory, 2026-09-26: the owner's Seeker threw OutOfMemoryError here on its 256 MB Java heap after a few
 * realm visits): the IDAT slices feed the inflater straight from the file's bytes (no chunk copies, no concatenation)
 * and each scanline is inflated, unfiltered against the previous one and expanded into the RGBA output at once, so a
 * decode's Java heap peak is its output plus two scanlines (the old decoder held the compressed copy, the whole raw
 * stream and the unfiltered pixels next to the output: about 3.1× the output). Output and refusals are byte-identical
 * to that decoder (`ExactPngReference` in the tests, over every PNG of the world bundle and corrupt variants), with one
 * deliberate difference: a header whose size overflows 64-bit arithmetic (width and height near 2³¹, past the PNG
 * spec's limit) is refused here, where the old decoder threw or returned a negative-size image.
 */
object ExactPng {
    class Image(val width: Int, val height: Int, val rgba: ByteArray)

    /** Test-only: called with every decoded [Image.rgba] (the memory tests keep weak references to them). Null in
     *  production. */
    @Volatile internal var trace: ((Any) -> Unit)? = null

    private const val IHDR = 0x49484452; private const val PLTE = 0x504C5445; private const val TRNS = 0x74524E53
    private const val IDAT = 0x49444154; private const val IEND = 0x49454E44
    /** Deflate's largest expansion is 1032:1 (a 258-byte match in 2 bits): a stream shorter than raw / 1040 cannot fill
     *  it, so the old decoder refused it too (after allocating the whole raw buffer). */
    private const val MAX_INFLATE_RATIO = 1040L

    fun decode(b: ByteArray): Image? {
        if (b.size < 8 || b[0] != 137.toByte() || b[1] != 80.toByte() || b[2] != 78.toByte() || b[3] != 71.toByte()) return null
        var p = 8; var w = 0L; var h = 0L; var depth = 0; var ct = -1; var lace = 0
        var plteAt = -1; var plteEnd = -1; var trnsAt = -1; var trnsEnd = -1
        var idat = IntArray(32); var slices = 0; var n = 0L
        while (p + 8 <= b.size) { // the chunk walk of the old decoder, with offsets in place of chunk copies
            val len = u32(b, p)
            val type = (b[p + 4].u() shl 24) or (b[p + 5].u() shl 16) or (b[p + 6].u() shl 8) or b[p + 7].u()
            val start = p + 8
            val end = minOf(b.size.toLong(), start + len).toInt() // the web's subarray clamps a chunk that runs past the end
            when (type) {
                IHDR -> { if (end - start < 13) return null; w = u32(b, start); h = u32(b, start + 4); depth = b[start + 8].u(); ct = b[start + 9].u(); lace = b[start + 12].u() }
                PLTE -> { plteAt = start; plteEnd = end }
                TRNS -> { trnsAt = start; trnsEnd = end }
                IDAT -> {
                    if (2 * slices + 2 > idat.size) idat = idat.copyOf(idat.size * 2)
                    idat[2 * slices] = start; idat[2 * slices + 1] = end; slices++; n += end - start
                }
                IEND -> break
            }
            val next = p + 12L + len
            if (next > Int.MAX_VALUE) break
            p = next.toInt()
        }
        val ch = when (ct) { 0 -> 1; 2 -> 3; 3 -> 1; 4 -> 2; 6 -> 4; else -> return null }
        if (lace != 0 || w == 0L || h == 0L || !(depth == 8 || (ct == 3 && (depth == 1 || depth == 2 || depth == 4)))) return null
        if (ct == 3 && plteAt < 0) return null
        if (w > Int.MAX_VALUE || h > Int.MAX_VALUE) return null // past the PNG spec (and past what the checks below can hold in a Long)
        val stride = (w * ch * depth + 7) / 8
        // the old decoder's refusals, rawSize = h · (stride + 1) > Int.MAX_VALUE and w · h · 4 > Int.MAX_VALUE, without overflow
        if (stride + 1 > Int.MAX_VALUE / h || w * h > Int.MAX_VALUE / 4 || n > Int.MAX_VALUE) return null
        val rawSize = h * (stride + 1)
        if (rawSize > MAX_INFLATE_RATIO * n + 4096) return null // the stream cannot fill the image (see MAX_INFLATE_RATIO)

        val width = w.toInt(); val height = h.toInt(); val s = stride.toInt()
        val bpp = maxOf(1, (ch * depth) shr 3)
        val t = trnsAt
        val key0: Int; val key1: Int; val key2: Int; val keyed: Boolean
        if (t >= 0 && ct == 0 && trnsEnd - t >= 2) { keyed = true; key0 = b[t + 1].u(); key1 = 0; key2 = 0 }
        else if (t >= 0 && ct == 2 && trnsEnd - t >= 6) { keyed = true; key0 = b[t + 1].u(); key1 = b[t + 3].u(); key2 = b[t + 5].u() }
        else { keyed = false; key0 = 0; key1 = 0; key2 = 0 }
        val palN = if (plteAt >= 0) plteEnd - plteAt else 0
        val trnsN = if (t >= 0) trnsEnd - t else -1

        val out = ByteArray(width * height * 4)
        var cur = ByteArray(s + 1); var prev = ByteArray(s + 1) // [filter byte, scanline]; prev = 0 above the first row
        val inflater = Inflater()
        try {
            var slice = 0
            for (y in 0 until height) {
                var got = 0
                while (got <= s) { // inflate one scanline (filter byte + s bytes), feeding the next IDAT slice when starved
                    val k = inflater.inflate(cur, got, s + 1 - got)
                    if (k == 0) {
                        if (inflater.needsInput() && !inflater.finished() && !inflater.needsDictionary() && slice < slices) {
                            inflater.setInput(b, idat[2 * slice], idat[2 * slice + 1] - idat[2 * slice]); slice++; continue
                        }
                        return null // finished, starved (a truncated stream) or wanting a dictionary: the web's `raw.length < h * (stride + 1)`
                    }
                    got += k
                }
                unfilter(cur, prev, s, bpp)
                val k = y * width * 4
                when (ct) {
                    6 -> System.arraycopy(cur, 1, out, k, width * 4)
                    2 -> { var i = 1; var o = k
                        for (x in 0 until width) {
                            val r = cur[i]; val g = cur[i + 1]; val bl = cur[i + 2]
                            out[o] = r; out[o + 1] = g; out[o + 2] = bl
                            out[o + 3] = if (keyed && r.u() == key0 && g.u() == key1 && bl.u() == key2) 0 else -1
                            i += 3; o += 4
                        } }
                    0 -> { var o = k
                        for (x in 0 until width) { val g = cur[1 + x]; out[o] = g; out[o + 1] = g; out[o + 2] = g; out[o + 3] = if (keyed && g.u() == key0) 0 else -1; o += 4 } }
                    4 -> { var i = 1; var o = k
                        for (x in 0 until width) { val g = cur[i]; out[o] = g; out[o + 1] = g; out[o + 2] = g; out[o + 3] = cur[i + 1]; i += 2; o += 4 } }
                    else -> { var o = k; val mask = (1 shl depth) - 1
                        for (x in 0 until width) {
                            val bit = x * depth
                            val v = (cur[1 + (bit shr 3)].u() shr (8 - depth - (bit and 7))) and mask
                            // the web reads undefined (0 in a Uint8ClampedArray) past the palette; a short palette is a malformed file here
                            if (v * 3 + 2 >= palN) return null
                            val e = plteAt + v * 3
                            out[o] = b[e]; out[o + 1] = b[e + 1]; out[o + 2] = b[e + 2]
                            out[o + 3] = if (trnsN >= 0 && v < trnsN) b[t + v] else -1
                            o += 4
                        } }
                }
                val swap = prev; prev = cur; cur = swap
            }
        } catch (_: DataFormatException) { return null } finally { inflater.end() }
        trace?.invoke(out)
        return Image(width, height, out)
    }

    /** One scanline in place (PNG spec §9): [cur] = [filter byte, s filtered bytes], [prev] the unfiltered row above
     *  (zeros above the first row). Arithmetic mod 256 like the web's Uint8Array; an unknown filter type is Paeth, as the
     *  web's `else` branch has it. */
    private fun unfilter(cur: ByteArray, prev: ByteArray, s: Int, bpp: Int) {
        when (cur[0].u()) {
            0 -> {}
            1 -> for (i in 1 + bpp..s) cur[i] = (cur[i] + cur[i - bpp]).toByte()
            2 -> for (i in 1..s) cur[i] = (cur[i] + prev[i]).toByte()
            3 -> for (i in 1..s) { val a = if (i > bpp) cur[i - bpp].u() else 0; cur[i] = (cur[i].u() + ((a + prev[i].u()) shr 1)).toByte() }
            else -> for (i in 1..s) {
                val a = if (i > bpp) cur[i - bpp].u() else 0; val up = prev[i].u(); val ul = if (i > bpp) prev[i - bpp].u() else 0
                val q = a + up - ul; val pa = kotlin.math.abs(q - a); val pb = kotlin.math.abs(q - up); val pc = kotlin.math.abs(q - ul)
                cur[i] = (cur[i].u() + (if (pa <= pb && pa <= pc) a else if (pb <= pc) up else ul)).toByte()
            }
        }
    }

    /** Alpha-0 texels whose RGB is not 0: what a premultiplying decoder would lose (the web's `alphaRgbCount`). */
    fun alphaRgbCount(rgba: ByteArray): Int {
        var count = 0
        var i = 3
        while (i < rgba.size) { if (rgba[i].toInt() == 0 && (rgba[i - 3].toInt() or rgba[i - 2].toInt() or rgba[i - 1].toInt()) != 0) count++; i += 4 }
        return count
    }

    private fun Byte.u() = toInt() and 0xFF
    private fun u32(b: ByteArray, at: Int): Long =
        if (at + 4 > b.size) 0L else (b[at].u().toLong() shl 24) or (b[at + 1].u().toLong() shl 16) or (b[at + 2].u().toLong() shl 8) or b[at + 3].u().toLong()
}
