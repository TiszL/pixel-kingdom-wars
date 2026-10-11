package gg.pixelkingdomwars.nativeclient.scene.probe

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

/**
 * N0 review defect 3 (2026-09-25): the probe counted a staged copy that was ISSUED as one that happened, and on an ES 3.1
 * driver the `GLES32` copy is a logging stub. So the probe reads the copied texels back, and a copy that never ran must
 * never read back as a match.
 */
class ProbeTexelsTest {
    private fun row(rgba: Int, width: Int, count: Int) = ByteArray(count * 4).also { out ->
        for (x in 0 until count) {
            val t = ProbeTexels.texel(rgba, width, x)
            for (c in 0 until 4) out[x * 4 + c] = (t ushr (24 - 8 * c)).toByte()
        }
    }

    @Test fun `the staged layer reads back as a full match`() {
        val read = row(ProbeTexels.STAGED_LAYER1, 256, ProbeTexels.CHECKED)
        assertEquals(ProbeTexels.CHECKED, ProbeTexels.matches(read, ProbeTexels.CHECKED, ProbeTexels.STAGED_LAYER1, 256))
    }

    @Test fun `a copy that never ran leaves the fresh fill, which matches in no checked texel`() {
        val fresh = row(ProbeTexels.FRESH_LAYER1, 256, ProbeTexels.CHECKED)
        assertEquals(0, ProbeTexels.matches(fresh, ProbeTexels.CHECKED, ProbeTexels.STAGED_LAYER1, 256))
        val black = ByteArray(ProbeTexels.CHECKED * 4)
        assertEquals(0, ProbeTexels.matches(black, ProbeTexels.CHECKED, ProbeTexels.STAGED_LAYER1, 256))
    }

    @Test fun `the checked row crosses both kinds of checkerboard square`() {
        val kinds = (0 until ProbeTexels.CHECKED).map { ProbeTexels.texel(ProbeTexels.STAGED_LAYER1, 256, it) }.toSet()
        assertEquals(2, kinds.size)
        assertNotEquals(ProbeTexels.texel(ProbeTexels.STAGED_LAYER1, 256, 0), ProbeTexels.texel(ProbeTexels.STAGED_LAYER1, 256, 16))
    }

    @Test fun `the upload copy source differs from what texSubImage wrote in every byte`() {
        val written = ByteArray(32) { ProbeTexels.uploadByte(it) }
        val copied = ByteArray(32) { ProbeTexels.uploadByte(it + 1) }
        assertEquals(32, ProbeTexels.uploadMatches(copied, 32, offset = 1))
        assertEquals("a copy that never ran reads back what texSubImage wrote: no match", 0, ProbeTexels.uploadMatches(written, 32, offset = 1))
    }
}
