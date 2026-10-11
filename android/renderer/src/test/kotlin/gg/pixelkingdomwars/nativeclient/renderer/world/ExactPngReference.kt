package gg.pixelkingdomwars.nativeclient.renderer.world

import java.util.zip.DataFormatException
import java.util.zip.Inflater

/**
 * Test-only oracle: [ExactPng] as it stood at 7830aee, before the streaming rewrite (P0 memory, 2026-09-26), verbatim
 * except for its name. It copies every chunk, concatenates the IDAT stream, inflates the whole raw image and unfilters
 * it into a third buffer before the RGBA output (about 3.1x the output on the heap), which is why it was replaced; its
 * bytes and its refusals are what the web loader's `decodePng` gives, so the streaming decoder is held to it.
 */
internal object ExactPngReference {
    private val SIGNATURE = byteArrayOf(137.toByte(), 80, 78, 71)

    fun decode(b: ByteArray): ExactPng.Image? {
        if (b.size < 8 || (0 until 4).any { b[it] != SIGNATURE[it] }) return null
        var p = 8; var w = 0L; var h = 0L; var depth = 0; var ct = -1; var lace = 0
        var plte: ByteArray? = null; var trns: ByteArray? = null
        val idat = ArrayList<ByteArray>(); var n = 0L
        while (p + 8 <= b.size) {
            val len = u32(b, p)
            val type = String(b, p + 4, 4, Charsets.ISO_8859_1)
            val start = p + 8
            val end = minOf(b.size.toLong(), start + len).toInt() // the web's subarray clamps a chunk that runs past the end
            val data = b.copyOfRange(start, end)
            when (type) {
                "IHDR" -> { if (data.size < 13) return null; w = u32(data, 0); h = u32(data, 4); depth = data[8].u(); ct = data[9].u(); lace = data[12].u() }
                "PLTE" -> plte = data
                "tRNS" -> trns = data
                "IDAT" -> { idat += data; n += data.size }
                "IEND" -> break
            }
            val next = p + 12L + len
            if (next > Int.MAX_VALUE) break
            p = next.toInt()
        }
        val ch = when (ct) { 0 -> 1; 2 -> 3; 3 -> 1; 4 -> 2; 6 -> 4; else -> return null }
        if (lace != 0 || w == 0L || h == 0L || !(depth == 8 || (ct == 3 && depth in intArrayOf(1, 2, 4)))) return null
        if (ct == 3 && plte == null) return null
        val stride = (w * ch * depth + 7) / 8
        val rawSize = h * (stride + 1)
        if (rawSize > Int.MAX_VALUE || w * h * 4 > Int.MAX_VALUE || n > Int.MAX_VALUE) return null
        val z = ByteArray(n.toInt()); var o = 0
        for (d in idat) { d.copyInto(z, o); o += d.size }
        val raw = ByteArray(rawSize.toInt())
        val inflater = Inflater()
        try {
            inflater.setInput(z)
            var got = 0
            while (got < raw.size) {
                val k = inflater.inflate(raw, got, raw.size - got)
                if (k == 0) break // finished, starved (a truncated stream) or wanting a dictionary: no more bytes will come
                got += k
            }
            if (got < raw.size) return null // the web's `raw.length < h * (stride + 1)`
        } catch (_: DataFormatException) { return null } finally { inflater.end() }

        val bpp = maxOf(1, (ch * depth) shr 3)
        val s = stride.toInt(); val height = h.toInt(); val width = w.toInt()
        val px = ByteArray(s * height)
        for (y in 0 until height) { // unfilter (PNG spec §9), arithmetic mod 256 like the web's Uint8Array
            val f = raw[y * (s + 1)].u(); val src = y * (s + 1) + 1; val c = y * s; val up0 = c - s
            for (i in 0 until s) {
                val x = raw[src + i].u()
                val a = if (i >= bpp) px[c + i - bpp].u() else 0
                val up = if (y > 0) px[up0 + i].u() else 0
                val ul = if (y > 0 && i >= bpp) px[up0 + i - bpp].u() else 0
                val v = when (f) {
                    0 -> x; 1 -> x + a; 2 -> x + up; 3 -> x + ((a + up) shr 1)
                    else -> { val q = a + up - ul; val pa = kotlin.math.abs(q - a); val pb = kotlin.math.abs(q - up); val pc = kotlin.math.abs(q - ul)
                        x + (if (pa <= pb && pa <= pc) a else if (pb <= pc) up else ul) }
                }
                px[c + i] = v.toByte()
            }
        }
        val out = ByteArray(width * height * 4)
        val t = trns
        val key: IntArray? = if (t != null && (ct == 0 || ct == 2)) {
            if (ct == 0) { if (t.size < 2) null else intArrayOf(t[1].u()) }
            else { if (t.size < 6) null else intArrayOf(t[1].u(), t[3].u(), t[5].u()) }
        } else null
        val pal = plte
        var k = 0
        for (y in 0 until height) {
            val r = y * s
            for (x in 0 until width) {
                when (ct) {
                    6 -> { val i = r + x * 4; out[k] = px[i]; out[k + 1] = px[i + 1]; out[k + 2] = px[i + 2]; out[k + 3] = px[i + 3] }
                    2 -> { val i = r + x * 3; out[k] = px[i]; out[k + 1] = px[i + 1]; out[k + 2] = px[i + 2]
                        out[k + 3] = if (key != null && px[i].u() == key[0] && px[i + 1].u() == key[1] && px[i + 2].u() == key[2]) 0 else -1 }
                    0 -> { val g = px[r + x]; out[k] = g; out[k + 1] = g; out[k + 2] = g; out[k + 3] = if (key != null && g.u() == key[0]) 0 else -1 }
                    4 -> { val i = r + x * 2; out[k] = px[i]; out[k + 1] = px[i]; out[k + 2] = px[i]; out[k + 3] = px[i + 1] }
                    else -> {
                        val bit = x * depth
                        val v = (px[r + (bit shr 3)].u() shr (8 - depth - (bit and 7))) and ((1 shl depth) - 1)
                        // the web reads undefined (0 in a Uint8ClampedArray) past the palette; a short palette is a malformed file here
                        if (pal == null || v * 3 + 2 >= pal.size) return null
                        out[k] = pal[v * 3]; out[k + 1] = pal[v * 3 + 1]; out[k + 2] = pal[v * 3 + 2]
                        out[k + 3] = if (t != null && v < t.size) t[v] else -1
                    }
                }
                k += 4
            }
        }
        return ExactPng.Image(width, height, out)
    }

    private fun Byte.u() = toInt() and 0xFF
    private fun u32(b: ByteArray, at: Int): Long =
        if (at + 4 > b.size) 0L else (b[at].u().toLong() shl 24) or (b[at + 1].u().toLong() shl 16) or (b[at + 2].u().toLong() shl 8) or b[at + 3].u().toLong()
}
