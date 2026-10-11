package gg.pixelkingdomwars.nativeclient.ui.boot

import gg.pixelkingdomwars.nativeclient.ui.chrome.indeterminateSegment
import org.junit.Assert.*
import org.junit.Test
import java.io.File

/**
 * Owner 2026-10-06 (Seeker, 0795e8d7): "that yellow moving line goes beyond its box". The strip's sweep was a 30 % rect at
 * `p * (w + segment) - segment` — from −30 % to 100 % of the track — on a Canvas that does not clip, so it painted past both
 * ends of its track into the plate. Every indicator is now whole blocks laid out inside its track, and every indicator
 * Canvas clips besides. These sample the animation's phases (0, ½, the last frame, the wrap) and reduced motion.
 */
class StripIndicatorBoundsTest {
    private val phases = listOf(0f, .5f, .999f, 1f, null) // null = reduced motion
    private val tracks = listOf(40f to 6f, 296.5f to 15.75f, 1470f to 15.75f, 96f * 2.625f to 3f * 2.625f) // px
    private val meters = listOf(StripMeter.Sweep, StripMeter.Still, StripMeter.Measured(0f), StripMeter.Measured(.3f), StripMeter.Measured(1f))

    @Test fun `the indicator never paints outside its track at any animation phase`() {
        for ((w, h) in tracks) for (border in listOf(0f, 2.625f)) for (meter in meters) for (phase in phases) {
            val alphas = meterBlockAlphas(meter, phase)
            assertEquals("one value per block, nothing else to draw", METER_BLOCKS, alphas.size)
            for (i in alphas.indices) if (alphas[i] > 0f) {
                val r = meterBlockRect(i, w, h, border, gap = 2.625f)
                val where = "$meter phase=$phase block=$i track=${w}x$h border=$border rect=${r.toList()}"
                assertTrue("left inside: $where", r[0] >= border - 1e-3f)
                assertTrue("right inside: $where", r[2] <= w - border + 1e-3f)
                assertTrue("top and bottom inside: $where", r[1] >= border - 1e-3f && r[3] <= h - border + 1e-3f)
                assertTrue("a real block: $where", r[2] >= r[0])
            }
        }
        // The old bar (LoadingCard and every remaining LinearProgressIndicator) samples the same phases inside [0, 1].
        for (phase in phases) indeterminateSegment(phase)?.let { (from, to) -> assertTrue("bar phase=$phase: $from..$to", from >= 0f && to <= 1f) }
    }

    @Test fun `the sweep is a stepped comet - a 3-block head and a 60 and 30 percent tail - never a soft gradient`() {
        val mid = meterBlockAlphas(StripMeter.Sweep, .5f).toList()
        val head = mid.indexOfFirst { it == 1f }
        assertEquals("three head blocks at full gold", listOf(1f, 1f, 1f), mid.subList(head, head + 3))
        assertEquals("the tail trails it at 60 % then 30 %", listOf(.3f, .6f), mid.subList(head - 2, head))
        for (phase in phases.filterNotNull()) for (a in meterBlockAlphas(StripMeter.Sweep, phase))
            assertTrue("only hard steps: $a", a in setOf(0f, .3f, .6f, 1f))
        assertTrue("reduced motion: every block half-lit and still", meterBlockAlphas(StripMeter.Sweep, null).all { it == .5f })
        val fronts = (0..100).map { meterBlockAlphas(StripMeter.Sweep, it / 100f).toList().lastIndexOf(1f) }.filter { it >= 0 }
        assertEquals("one way: the head only moves right within a cycle", fronts, fronts.sorted())
    }

    @Test fun `a measured meter lights blocks left to right and never more than it measured`() {
        var lit = 0
        for (step in 0..40) {
            val alphas = meterBlockAlphas(StripMeter.Measured(step / 40f), null)
            val full = alphas.count { it == 1f }
            assertTrue("left to right", alphas.toList().take(full).all { it == 1f })
            assertTrue("monotonic", full >= lit); lit = full
            assertTrue("never ahead of the fraction", full <= (step / 40f * METER_BLOCKS).toInt())
        }
        assertEquals("finished work fills every block", METER_BLOCKS, lit)
        assertTrue("nothing measured, nothing lit", meterBlockAlphas(StripMeter.Measured(0f), null).all { it == 0f })
        assertTrue(meterBlockAlphas(StripMeter.Still, .5f).all { it == 0f })
    }

    @Test fun `every indicator canvas clips to its track`() {
        val root = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient")
        assertTrue(File(root, "ui/boot/LoadingStrip.kt").readText().contains("Canvas(Modifier.fillMaxWidth().height(LoadingStripPlan.METER.dp).clipToBounds()"))
        assertTrue(File(root, "ui/kingdom/ScenePresentation.kt").readText().contains("Canvas(Modifier.width(LINE_WIDTH).height(LINE_HEIGHT).clipToBounds())"))
        assertTrue(File(root, "ui/chrome/Controls.kt").readText().contains("Canvas(modifier.fillMaxWidth().height(6.dp).clipToBounds()"))
        assertTrue("the in-scene line is the same comet", File(root, "ui/kingdom/ScenePresentation.kt").readText()
            .contains("meterBlockAlphas(gg.pixelkingdomwars.nativeclient.ui.boot.StripMeter.Sweep, phase?.value)"))
    }
}
