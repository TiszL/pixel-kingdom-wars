package gg.pixelkingdomwars.nativeclient.scene.probe

import gg.pixelkingdomwars.nativeclient.scene.probe.ProbeFirstDraw.Trial
import gg.pixelkingdomwars.nativeclient.scene.probe.ProbeFirstDraw.Verdict
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * GLOBE-NATIVE-PLAN §5.3 steps 3–4 and D-171: the owner's one Seeker session must answer whether a draw on the worker
 * context, or into an RGB8/RGBA8 scratch target, pre-warms the variant the world context draws with. If it does,
 * rehearsal leaves the GL thread; if not, `Gl3Core.rehearse`'s premise is wrong. The answer must come from timings a
 * noisy phone can produce, and the programs must be ones no driver cache can confuse.
 */
class ProbeFirstDrawTest {
    private fun trial(warmedFirst: Double, controlFirst: Double, second: Double = 0.2) = Trial(warmedFirst, second, controlFirst, second)

    @Test fun `a warmed program without the control's first-draw cost warms, one with it does not`() {
        assertEquals(Verdict.WARMS, ProbeFirstDraw.verdict(listOf(trial(0.3, 8.0), trial(0.25, 7.5), trial(0.4, 9.0))))
        assertEquals(Verdict.DOES_NOT_WARM, ProbeFirstDraw.verdict(listOf(trial(7.9, 8.0), trial(7.0, 7.5), trial(9.5, 9.0))))
        assertEquals("half the cost is neither answer", Verdict.INCONCLUSIVE, ProbeFirstDraw.verdict(listOf(trial(4.0, 8.0), trial(4.2, 8.0), trial(3.8, 8.0))))
    }

    @Test fun `a driver with no first-draw cost, or a missing timing, never claims an answer`() {
        assertEquals("nothing to warm", Verdict.INCONCLUSIVE, ProbeFirstDraw.verdict(listOf(trial(0.3, 0.4), trial(0.2, 0.5), trial(0.3, 0.3))))
        assertEquals(Verdict.INCONCLUSIVE, ProbeFirstDraw.verdict(emptyList()))
        assertEquals(Verdict.INCONCLUSIVE, ProbeFirstDraw.verdict(listOf(trial(Double.NaN, 8.0), trial(0.2, 8.0), trial(0.2, 8.0))))
        assertEquals(Verdict.INCONCLUSIVE, ProbeFirstDraw.verdict(listOf(trial(-1.0, 8.0))))
    }

    @Test fun `one slow frame does not decide the answer`() {
        // a GC pause or thermal step in one warmed draw: the median keeps the answer
        assertEquals(Verdict.WARMS, ProbeFirstDraw.verdict(listOf(trial(0.3, 8.0), trial(25.0, 7.5), trial(0.4, 9.0))))
        assertEquals(2.0, ProbeFirstDraw.median(listOf(3.0, 1.0, 2.0)), 0.0)
        assertEquals(2.5, ProbeFirstDraw.median(listOf(4.0, 1.0, 2.0, 3.0)), 0.0)
    }

    @Test fun `every salt is a different program in its arithmetic, with one literal-bounded loop`() {
        val loop = Regex("""for \(int i = 0; i < (\d+); i\+\+\)""")
        val sources = (0 until 3 * ProbeFirstDraw.TRIALS + 200).map { ProbeFirstDraw.fragmentShader(it) }
        assertEquals("no two salts share a source", sources.size, sources.toSet().size)
        for (fs in sources) {
            assertEquals(listOf(16), loop.findAll(fs).map { it.groupValues[1].toInt() }.toList())
            assertFalse("while" in fs)
            assertFalse("the salt is not a comment a driver could strip", "//" in fs || "/*" in fs)
        }
        assertFalse("attribute-less: the worker context has no vertex buffer to feed an input",
            Regex("""(^|\n)\s*(layout\([^)]*\)\s*)?in\s""").containsMatchIn(ProbeFirstDraw.VERTEX_SHADER))
        assertTrue("gl_VertexID" in ProbeFirstDraw.VERTEX_SHADER)
    }
}
