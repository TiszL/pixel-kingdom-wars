package gg.pixelkingdomwars.nativeclient.diagnostics

import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayInputStream
import java.util.concurrent.CancellationException

class LocalExitHistoryTest {
    private val oldBuild = "0.4.1:14:" + "a".repeat(40)
    private val newBuild = "0.4.2:15:" + "b".repeat(40)
    private val process = "gg.pixelkingdomwars.twa"
    private fun collect(bundle: LocalReportBundle, exits: List<LocalExitCandidate>, history: Boolean = false, raw: Boolean = false,
        active: () -> Boolean = { true }, writer: (Int, ByteArray) -> Unit = { _, _ -> }) =
        collectLocalExits(bundle, exits, process, 10_000, history, raw, active, writer)
    @Test fun `automatic read admits only recorded own process and attributes old build instead of current binary`() {
        val bundle = LocalReportBundle(markers = listOf(LocalProcessMarker(7, 1_000, oldBuild), LocalProcessMarker(8, 7_000, newBuild)))
        val result = collect(bundle, listOf(LocalExitCandidate(5_000, 7, process, "anr"),
            LocalExitCandidate(8_000, 8, "$process:sdk", "crash"), LocalExitCandidate(500, 7, process, "anr"),
            LocalExitCandidate(9_000, 99, process, "crash")))
        assertEquals(1, result.exits.size); assertEquals(oldBuild, result.exits.single().build)
    }
    @Test fun `older exits require explicit history and absent build remains unknown`() {
        val exit = LocalExitCandidate(5_000, 7, process, "low_memory")
        assertTrue(collect(LocalReportBundle(), listOf(exit)).exits.isEmpty())
        val result = collect(LocalReportBundle(), listOf(exit), history = true)
        assertEquals("originating build unknown", result.exits.single().build)
        assertEquals("low_memory", result.exits.single().reason)
        assertEquals(result, collect(result, listOf(exit), history = true))
    }
    @Test fun `intervening process marker prevents reusing an older recycled pid attribution`() {
        val bundle = LocalReportBundle(markers = listOf(LocalProcessMarker(7, 1_000, oldBuild), LocalProcessMarker(8, 4_000, newBuild)))
        val result = collect(bundle, listOf(LocalExitCandidate(5_000, 7, process, "anr")), history = true)
        assertEquals("originating build unknown", result.exits.single().build)
    }
    @Test fun `trace stream never opens without raw opt in and nullable unavailable traces preserve exit`() {
        var opened = 0
        val exit = LocalExitCandidate(5_000, 7, process, "signal", trace = { opened++; null })
        val noRaw = collect(LocalReportBundle(), listOf(exit), history = true)
        assertEquals(0, opened)
        val raw = collect(noRaw, listOf(exit), history = true, raw = true)
        assertEquals(1, opened); assertEquals("signal", raw.exits.single().reason); assertTrue(raw.traces.isEmpty())
    }
    @Test fun `bounded trace slots deduplicate and preserve non ANR reason`() {
        var opened = 0
        val slots = mutableMapOf<Int, ByteArray>()
        val exits = (1..4).map { LocalExitCandidate(1_000L * it, it, process, "user_exit", trace = {
            opened++; ByteArrayInputStream(ByteArray(TRACE_LIMIT + 30) { it.toByte() })
        }) }
        val result = collect(LocalReportBundle(), exits, history = true, raw = true, writer = { slot, bytes -> slots[slot] = bytes })
        assertEquals(2, result.traces.size); assertTrue(result.traces.all { it.truncated }); assertEquals(2, slots.size)
        assertTrue(slots.values.all { it.size == TRACE_LIMIT }); assertTrue(result.exits.all { it.reason == "user_exit" })
        val again = collect(result, exits.takeLast(2), history = true, raw = true)
        assertEquals(4, opened); assertEquals(result, again)
    }
    @Test fun `disable during trace IO discards late capture and emits no store writes`() {
        var active = true; var writes = 0
        val exit = LocalExitCandidate(1_000, 7, process, "anr", trace = {
            object : ByteArrayInputStream(ByteArray(20)) {
                override fun read(b: ByteArray, off: Int, len: Int): Int { active = false; return super.read(b, off, len) }
            }
        })
        try { collect(LocalReportBundle(), listOf(exit), history = true, raw = true, active = { active }, writer = { _, _ -> writes++ }); fail("Obsolete capture") }
        catch (_: CancellationException) { }
        assertEquals(0, writes)
    }
}
