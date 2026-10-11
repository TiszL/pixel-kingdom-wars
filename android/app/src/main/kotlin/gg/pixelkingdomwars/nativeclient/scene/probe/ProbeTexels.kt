package gg.pixelkingdomwars.nativeclient.scene.probe

/**
 * What the probe writes into its test textures and checks after reading them back (N0 review defect 3: a copy that
 * is issued is not a copy that happened; on an ES 3.1 driver the `GLES32` copy was a logging stub).
 *
 * - The pipeline's layers are a checkerboard of 16-texel squares: [rgba], and [rgba] with every colour byte halved.
 *   Its fresh fill and its staged replacement use colours that differ in every texel the check reads, so a copy
 *   that never ran can never read back as a match.
 * - The upload timing's bytes are `offset * 31`.
 */
object ProbeTexels {
    /** Texels read back from row 0 of the staged layer. */
    const val CHECKED = 32
    /** The fresh fill of the pipeline's array: layer 0, layer 1. */
    const val FRESH_LAYER0 = 0x3070c0ff
    const val FRESH_LAYER1 = 0xc07030ff.toInt()
    /** What the staged copy writes into layer 1. */
    const val STAGED_LAYER1 = 0x40c060ff

    /** The RGBA (R in the high byte) of texel [index] of a [width]-wide checkerboard of [rgba]. */
    fun texel(rgba: Int, width: Int, index: Int): Int =
        if ((index / width + index % width) / 16 % 2 == 0) rgba else rgba and 0x7f7f7fff

    /** How many of the first [count] texels in [read] (RGBA8 bytes, row 0 of a [width]-wide layer) match [rgba]'s board. */
    fun matches(read: ByteArray, count: Int, rgba: Int, width: Int): Int {
        var matched = 0
        for (x in 0 until minOf(count, read.size / 4)) {
            val want = texel(rgba, width, x)
            var ok = true
            for (c in 0 until 4) if ((read[x * 4 + c].toInt() and 0xff) != (want ushr (24 - 8 * c) and 0xff)) ok = false
            if (ok) matched++
        }
        return matched
    }

    fun uploadByte(offset: Int): Byte = (offset * 31).toByte()

    /** How many of the first [count] bytes in [read], starting at byte [offset] of the upload, match [uploadByte]. */
    fun uploadMatches(read: ByteArray, count: Int, offset: Int = 0): Int =
        (0 until minOf(count, read.size)).count { read[it] == uploadByte(offset + it) }
}
