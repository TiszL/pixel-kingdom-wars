package gg.pixelkingdomwars.nativeclient.scene.probe

import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * GLOBE-NATIVE-PLAN §5.2 and §8.3, and RM-GPU-1: the owner runs the probe once on the Seeker. Its GPU bench must never
 * be able to hang that GPU (fixed steps, literal loop bounds, a per-draw work cap, a ramp that stops on a slow step),
 * and its report must answer every question the plan leaves to the N0 probe, or a second device session is needed.
 */
class ProbeBenchTest {
    private val loop = Regex("""for \(int i = 0; i < (\d+); i\+\+\)""")

    @Test fun `every bench draw is bounded by construction`() {
        val plan = ProbeBench.plan()
        assertTrue(plan.isNotEmpty())
        for (step in plan) {
            assertTrue("${step.id}: ${step.workPerDraw}", step.workPerDraw <= ProbeBench.MAX_WORK_PER_DRAW)
            val fs = ProbeBench.fragmentShader(step.kind, step.iterations)
            val bounds = loop.findAll(fs).map { it.groupValues[1].toInt() }.toList()
            assertEquals("${step.id}: exactly one loop, with a literal bound", listOf(step.iterations), bounds)
            assertFalse("${step.id}: no unbounded loop", "while" in fs)
            assertFalse("${step.id}: no uniform-bounded loop", Regex("""i < u_""").containsMatchIn(fs))
            assertTrue(fs.startsWith("#version 300 es\n"))
        }
        assertEquals("the step list is fixed, never derived from the device", plan, ProbeBench.plan())
        val total = plan.sumOf { it.workPerDraw * (it.draws + 1) }
        assertTrue("the whole bench is a few seconds even at 1 G fetch/s: $total", total < 3_000_000_000L)
    }

    @Test fun `steps of one kind run cheapest first, so the ramp stop spares the dearest`() {
        for (kind in BenchKind.entries) {
            val work = ProbeBench.plan().filter { it.kind == kind }.map { it.workPerDraw }
            assertEquals(kind.name, work.sorted(), work)
        }
        assertTrue(ProbeBench.allowsNext(ProbeBench.RAMP_STOP_MS - 0.01))
        assertFalse(ProbeBench.allowsNext(ProbeBench.RAMP_STOP_MS))
        assertFalse("a failed timing never lets the ramp continue", ProbeBench.allowsNext(Double.NaN))
    }

    @Test fun `ns per fetch divides by every fetch of every draw, and ALU steps have none`() {
        val step = BenchStep("x", BenchKind.FETCH_RGBA8, 512, 16, 4)
        assertEquals(1e6 * 8.0 / (512.0 * 512 * 16 * 4), ProbeBench.nsPerFetch(step, 8.0)!!, 1e-12)
        assertNull(ProbeBench.nsPerFetch(BenchStep("a", BenchKind.ALU, 512, 16, 4), 8.0))
    }

    @Test fun `pacing statistics read frame starts the way the gate reads intervals`() {
        val period = 16_666_667L
        val starts = LongArray(61) { it * period }
        starts[30] += 40_000_000L; for (i in 31 until 61) starts[i] += 40_000_000L // one 56.7 ms gap
        val stats = PacingStats.fromStarts(starts, starts.size)!!
        assertEquals(61, stats.frames)
        assertEquals(16.667, stats.p50Ms, 0.01)
        assertEquals(1, stats.over20Ms); assertEquals(1, stats.over50Ms)
        assertNull(PacingStats.fromStarts(LongArray(1), 1))
    }

    @Test fun `the report names every N0 probe question and flags every extension the plan decides on`() {
        val report = ProbeReport()
        assertEquals(ProbeReport.REQUIRED, report.missing())
        for (section in ProbeReport.REQUIRED) report.put(section, "x")
        assertEquals(emptyList<String>(), report.missing())
        for (named in listOf("GL_EXT_disjoint_timer_query", "EGL_ANDROID_presentation_time", "EGL_ANDROID_get_frame_timestamps",
                "EGL_IMG_context_priority", "EGL_EXT_create_context_robustness"))
            assertTrue(named, named in ProbeReport.EXTENSION_FLAGS)
        for (section in listOf("programBinaryFormats", "limits", "bench", "pacing", "uploadTiming", "surface", "thermal", "display",
                // N0 review defect 4: the one D-171 Seeker session must also answer these, or they go unanswered
                "workerPrewarm", "scratchPrewarm", "programStages", "touchPacing", "unanswerable", "ownerSteps"))
            assertTrue(section, section in ProbeReport.REQUIRED)
        for (named in listOf("GL_EXT_copy_image", "GL_OES_copy_image", "GL_EXT_robustness", "GL_KHR_robustness"))
            assertTrue("the copy and reset path choice is readable in the report: $named", named in ProbeReport.EXTENSION_FLAGS)
        val flags = ProbeReport.extensionFlags("GL_OES_get_program_binary GL_EXT_robustness", "EGL_ANDROID_presentation_time")
        assertTrue(flags.getValue("EGL_ANDROID_presentation_time").jsonPrimitive.boolean)
        assertTrue(flags.getValue("GL_EXT_robustness").jsonPrimitive.boolean)
        assertFalse(flags.getValue("GL_EXT_disjoint_timer_query").jsonPrimitive.boolean)
        assertEquals(JsonPrimitive(ProbeReport.SCHEMA), report.json()["schemaVersion"])
    }

    /**
     * Under D-171 there is one Seeker session. A §8.3 question the probe cannot answer must say so in the report, with the
     * reason, and every step the owner has to run by hand (the probe cannot read SurfaceFlinger) must be in it too:
     * otherwise the lead reads a silent gap as an answer.
     */
    @Test fun `what the probe cannot answer is named with its reason, next to the owner's own steps`() {
        for (question in listOf("perPassGpuMs", "vsSeatParity", "presentToPresent"))
            assertTrue(question, ProbeReport.UNANSWERABLE.getValue(question).length > 60)
        assertTrue(ProbeReport.UNANSWERABLE.getValue("perPassGpuMs").startsWith("unanswerable in the D-171 session"))
        assertTrue(ProbeReport.UNANSWERABLE.getValue("vsSeatParity").startsWith("unanswerable in the D-171 session"))
        val steps = ProbeReport.OWNER_STEPS.joinToString("\n")
        assertTrue("HWC composition is an owner step", "dumpsys SurfaceFlinger" in steps)
        assertTrue("the owner is told to drag when the screen says so", "DRAG" in steps)
        assertEquals(ProbeReport.UNANSWERABLE.keys, ProbeReport.unanswerable().keys)
        assertEquals(ProbeReport.OWNER_STEPS.size, ProbeReport.ownerSteps().size)
        assertEquals(2, ProbeReport.SCHEMA)
    }

    @Test fun `logcat chunks rejoin to the exact report`() {
        val json = ProbeReport().apply { put("gl", "x".repeat(7_000)) }.json().toString()
        val chunks = ProbeReport.chunks(json)
        assertEquals(3, chunks.size)
        val rejoined = chunks.joinToString("") { it.substringAfter(' ').substringAfter(' ') }
        assertEquals(json, rejoined)
        assertTrue(chunks.all { it.length < 4_000 })
        assertTrue(chunks[0].startsWith("${ProbeReport.PREFIX} 1/3 "))
        assertTrue(kotlinx.serialization.json.Json.parseToJsonElement(rejoined).jsonObject.containsKey("gl"))
    }
}
