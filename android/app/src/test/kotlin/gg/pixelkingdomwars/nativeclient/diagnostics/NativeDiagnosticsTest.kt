package gg.pixelkingdomwars.nativeclient.diagnostics

import gg.pixelkingdomwars.nativeclient.renderer.FrameDurationSummary
import gg.pixelkingdomwars.nativeclient.renderer.FrameTimeReport
import gg.pixelkingdomwars.nativeclient.telemetry.TelemetryBuild
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class NativeDiagnosticsTest {
    private val build = TelemetryBuild("dev", "0.1.0-foundation-debug:1")
    private fun report(seconds: Double = 60.0) = FrameTimeReport(1, "base", listOf("base"), seconds, 59.8, 0,
        FrameDurationSummary(0, 0, 0, null, null, null, null, null, 0),
        FrameDurationSummary(3_588, 3_588, 0, 16.6, 17.8, 24.1, 16.7, 61.0, 2),
        12.4, 18, 82.5, 85.0)

    @Test fun `opt in is required and disabling removes stale metrics and rejects delayed callbacks`() {
        val session = NativeDiagnosticsSession(build)
        session.sample(report())
        assertFalse(session.state.value.enabled); assertNull(session.state.value.report); assertNull(session.summary(report()))
        session.setEnabled(true)
        val generation = session.currentGeneration()
        session.sample(report())
        assertEquals(report(), session.state.value.report)
        session.setEnabled(false)
        session.sample(report())
        assertNull(session.state.value.report); assertNull(session.summary(report())); assertFalse(session.isActive(generation))
        session.setEnabled(true)
        assertNull("New opt-in must wait for new frames, not replay an old readout", session.state.value.report)
        assertFalse(session.isActive(generation))
    }

    @Test fun `readout cadence cannot flood telemetry and only real finite metrics are emitted`() {
        var time = 0L
        val session = NativeDiagnosticsSession(build, monotonicMs = { time }, wallMs = { 0L }, newId = { "fixture-event" })
        session.setEnabled(true)
        session.sample(report(1.0))
        assertEquals(1.0, session.state.value.report!!.activeSeconds, 0.0)
        assertNull("One-second readouts are not minute summaries", session.summary(report(1.0)))
        val batch = requireNotNull(session.summary(report()))
        assertEquals(build.context(), batch["context"])
        val event = batch.getValue("events").jsonArray.single().jsonObject
        assertEquals("perf_summary", event.getValue("event").jsonPrimitive.content)
        val props = event.getValue("props").jsonObject
        assertEquals(17.8, props.getValue("steadyP95Ms").jsonPrimitive.double, 0.0)
        assertEquals(82.5, props.getValue("textureMiB").jsonPrimitive.double, 0.0)
        assertTrue(props.size <= 32)
        assertTrue("Never send scene/account strings or raw report JSON as props", props.values.all { !it.jsonPrimitive.isString })
        assertNull(session.summary(report()))
        time = 59_999; assertNull(session.summary(report()))
        time = 60_000; assertNotNull(session.summary(report()))
        time = 120_000
        assertNull(session.summary(report().copy(averageFps = Double.NaN)))
        assertNull(session.summary(report().copy(activeScene = "private-account")))
    }

    @Test fun `missing percentile samples remain absent rather than invented zeros`() {
        val session = NativeDiagnosticsSession(build)
        session.setEnabled(true)
        val empty = report().warmup
        val event = requireNotNull(session.summary(report().copy(steady = empty))).getValue("events").jsonArray.single().jsonObject
        val props = event.getValue("props").jsonObject
        assertFalse(props.containsKey("steadyP50Ms")); assertFalse(props.containsKey("steadyP95Ms")); assertFalse(props.containsKey("steadyP99Ms"))
    }

    @Test fun `toggle cycles do not reset the process reporting cap`() {
        var time = 0L
        val session = NativeDiagnosticsSession(build, monotonicMs = { time })
        repeat(30) {
            session.setEnabled(true); assertNotNull(session.summary(report()))
            session.setEnabled(false); time += 60_000
        }
        session.setEnabled(true)
        assertNull(session.summary(report()))
        session.sample(report(1.0))
        assertNotNull("Local readout still works after the reporting cap", session.state.value.report)
    }
}
