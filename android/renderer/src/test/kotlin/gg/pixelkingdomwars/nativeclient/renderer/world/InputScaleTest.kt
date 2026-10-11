package gg.pixelkingdomwars.nativeclient.renderer.world

import kotlin.test.*
import org.junit.Test

class InputScaleTest {
    @Test fun `the fixed dpr-2 buffer on the three Seeker rows matches the plan table`() {
        assertEquals(listOf(914 to 2034, 873 to 1942, 800 to 1780), SeekerRows.ALL.map { it.bufferW to it.bufferH })
        assertTrue(SeekerRows.ALL.all { it.dpr == 2.0 })
        assertEquals(1080, InputScale.fixedBufferSide(1080, 1.5), "below the cap the buffer is the panel, never upscaled")
    }

    @Test fun `a touch at a non-1 ratio lands on the buffer pixel under the finger and anchors map back`() {
        val scale = InputScale().apply { set(1050, 2310, 800, 1760) } // view/buffer = 1.3125
        assertEquals(400f, scale.viewToBufferX(525f), 1e-3f)
        assertEquals(880f, scale.viewToBufferY(1155f), 1e-3f)
        assertEquals(525f, scale.bufferToViewX(scale.viewToBufferX(525f)), 1e-3f)
        val rects = floatArrayOf(105f, 210f, 52.5f, 105f); val out = FloatArray(4)
        scale.viewRectsToBuffer(rects, 1, out)
        floatArrayOf(80f, 160f, 40f, 80f).forEachIndexed { i, v -> assertEquals(v, out[i], 1e-3f, "rect slot $i") }
        val anchors = floatArrayOf(80f, 160f); val view = FloatArray(2)
        scale.bufferPointsToView(anchors, 1, view)
        assertEquals(105f, view[0], 1e-3f); assertEquals(210f, view[1], 1e-3f)
        assertEquals(6f / 1.3125f, scale.viewToBufferLength(6f), 1e-3f)
    }
}
