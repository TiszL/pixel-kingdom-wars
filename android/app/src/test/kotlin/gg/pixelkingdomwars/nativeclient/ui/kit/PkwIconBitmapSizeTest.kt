package gg.pixelkingdomwars.nativeclient.ui.kit

import androidx.compose.ui.unit.IntSize
import org.junit.Assert.*
import org.junit.Test

/** Physical-pixel draw geometry; this does not claim a Compose/device screenshot run. */
class PkwIconBitmapSizeTest {
    @Test fun `large KEEP art fits the price icon at each tested display density`() {
        for (density in listOf(1f, 1.5f, 2f, 2.625f, 3f, 4f)) {
            val box = 24f * density
            val expected = box.toInt()
            assertEquals(IntSize(expected, expected), iconBitmapSize(480, 480, box, box))
        }
    }

    @Test fun `large non square art fits both axes without stretching`() {
        assertEquals(IntSize(64, 32), iconBitmapSize(480, 240, 64f, 64f))
        assertEquals(IntSize(16, 32), iconBitmapSize(240, 480, 64f, 32f))
        assertEquals(IntSize(12, 48), iconBitmapSize(60, 240, 24f, 48f))
    }

    @Test fun `one oversized axis scales down both dimensions`() {
        assertEquals(IntSize(32, 8), iconBitmapSize(64, 16, 32f, 32f))
        assertEquals(IntSize(8, 32), iconBitmapSize(16, 64, 32f, 32f))
    }

    @Test fun `fitting art preserves the existing integer scaling including its rounding boundary`() {
        assertEquals(IntSize(24, 24), iconBitmapSize(24, 24, 24f, 24f))
        assertEquals(IntSize(24, 24), iconBitmapSize(24, 24, 35f, 35f))
        assertEquals(IntSize(48, 48), iconBitmapSize(24, 24, 36f, 36f))
        assertEquals(IntSize(72, 72), iconBitmapSize(24, 24, 72f, 72f))
        assertEquals(IntSize(64, 64), iconBitmapSize(64, 64, 64f, 64f))
        assertEquals(IntSize(48, 24), iconBitmapSize(24, 12, 60f, 29f))
    }

    @Test fun `downscaled dimensions never exceed a fractional physical pixel box`() {
        val size = iconBitmapSize(480, 240, 63.5f, 31.75f)
        assertEquals(IntSize(63, 31), size)
        assertTrue(size.width <= 63.5f)
        assertTrue(size.height <= 31.75f)
        assertTrue(kotlin.math.abs(size.width - 2 * size.height) <= 1)
    }

    @Test fun `empty invalid and subpixel canvases do not draw an unbounded image`() {
        for (box in listOf(0f, -1f, Float.NaN, Float.POSITIVE_INFINITY)) {
            assertEquals(IntSize.Zero, iconBitmapSize(480, 480, box, 24f))
            assertEquals(IntSize.Zero, iconBitmapSize(480, 480, 24f, box))
        }
        assertEquals(IntSize.Zero, iconBitmapSize(0, 480, 24f, 24f))
        assertEquals(IntSize.Zero, iconBitmapSize(480, 0, 24f, 24f))
        assertEquals(IntSize.Zero, iconBitmapSize(480, 480, 0.5f, 0.5f))
    }
}
