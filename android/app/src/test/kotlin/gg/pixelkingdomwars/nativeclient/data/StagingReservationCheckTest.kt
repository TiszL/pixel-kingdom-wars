package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.network.*
import kotlinx.coroutines.*
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.runCurrent
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class StagingReservationCheckTest {
    private class Fixture {
        var time = 0L
        var current = true
        var reads = 0
        val original = PendingBattle("wallet", "base", raidId = "raid", ordersDeadlineAt = "2026-09-16T00:02:00Z",
            writes = listOf(PendingBattleWrite("original-id", "/raids/raid/commands", buildJsonObject { put("clientCommandId", "original-id") }, attempted = true)))
        fun clock(seconds: Int = 0, started: Boolean = false, revision: Int = 0) = buildJsonObject {
            put("protocolVersion", 2); put("revision", revision); put("rate", 1)
            put("anchorWallAt", if (started) JsonPrimitive("2026-09-16T00:00:01Z") else JsonNull)
            put("anchorSimMs", 0); put("simNowMs", 0); put("durationMs", 90000)
            put("serverNow", "2026-09-16T00:00:${seconds.toString().padStart(2, '0')}Z"); put("battleEndsAt", JsonNull)
        }
        var state = LiveBattleState(phase = BattlePhase.STAGING, pending = original, connected = true,
            presentation = buildJsonObject { put("simVersion", 15) }, clock = BattleClock.read(clock(), 0))
        fun response(seconds: Int = 31, base: String = "base", started: Boolean = false, revision: Int = 0) = buildJsonObject {
            put("raid", buildJsonObject {
                put("id", "raid"); put("attackerBaseId", base); put("simVersion", 15); put("raidProtocolVersion", 2)
                put("ordersDeadlineAt", original.ordersDeadlineAt); put("live", buildJsonObject { put("clock", clock(seconds, started, revision)) })
            })
        }
        var read: suspend () -> JsonObject = { response() }
        val statuses = mutableListOf<StagingReservationStatus>()
        val check = StagingReservationCheck("raid", "base", { state }, { current }, { path ->
            assertEquals("/raids/pending/raid", path); reads++; read()
        }, statuses::add, { time })
        fun due() { time = 31_000_000_000 }
    }
    @Test fun `verified closed window pauses input and checks once without expiring or modifying original commands`() = runTest {
        val f = Fixture(); assertTrue(f.check.allowsInput()); f.due()
        assertFalse(f.check.allowsInput())
        repeat(4) { assertFalse("A held pointer cannot admit another staged order", f.check.allowsInput()) }
        repeat(3) { f.check.refreshIfDue() }
        assertEquals(1, f.reads); assertEquals(StagingReservationStatus.WINDOW_CLOSED, f.check.status)
        assertSame(f.original, f.state.pending); assertFalse(f.state.terminal)
        assertEquals("original-id", f.state.pending!!.writes.single().id)
    }
    @Test fun `fresh server clock can correct elapsed estimate and reopen only while authoritative time remains`() = runTest {
        val f = Fixture(); f.due(); f.read = { f.response(1) }
        f.check.refreshIfDue()
        assertTrue(f.check.allowsInput()); assertEquals(StagingReservationStatus.OPEN, f.check.status)
        f.time += 30_000_000_000
        assertFalse(f.check.allowsInput())
        f.read = { f.response(32) }; f.check.refreshIfDue()
        assertEquals(2, f.reads); assertEquals(StagingReservationStatus.WINDOW_CLOSED, f.check.status)
    }
    @Test fun `closed window cannot reopen from equal older or lower revision retry clocks`() = runTest {
        val f = Fixture(); f.due(); f.read = { f.response(31, revision = 2) }; f.check.refreshIfDue()
        assertTrue(f.check.status.canRetry)
        repeat(3) { f.check.refreshIfDue() }
        assertEquals(1, f.reads)
        for ((seconds, revision) in listOf(31 to 2, 1 to 2, 59 to 1, 1 to 1)) {
            f.read = { f.response(seconds, revision = revision) }; f.check.refreshIfDue(retry = true)
            assertEquals(StagingReservationStatus.WINDOW_CLOSED, f.check.status)
            assertFalse(f.check.allowsInput())
        }
        assertEquals(5, f.reads)
        assertSame(f.original, f.state.pending)
    }
    @Test fun `newer live clock wins a stale retry even when no checked clock existed`() = runTest {
        val f = Fixture(); f.due()
        f.state = f.state.copy(clock = BattleClock.read(f.clock(32, revision = 3), f.time))
        f.read = { f.response(1, revision = 2) }; f.check.refreshIfDue()
        assertEquals(StagingReservationStatus.WINDOW_CLOSED, f.check.status)
        assertFalse(f.check.allowsInput()); assertSame(f.original, f.state.pending)
    }
    @Test fun `elapsed time without a newer observed clock cannot claim the window closed`() = runTest {
        val f = Fixture(); f.due(); f.read = { f.response(0) }
        f.check.refreshIfDue()
        assertEquals(StagingReservationStatus.WAITING, f.check.status)
        assertFalse(f.check.allowsInput()); assertFalse(f.state.terminal)
        // A genuinely newer reading can correct the local elapsed estimate;
        // none of the accepted server clocks has reached the deadline.
        f.read = { f.response(1) }; f.check.refreshIfDue(retry = true)
        assertEquals(StagingReservationStatus.OPEN, f.check.status)
        assertTrue(f.check.allowsInput()); assertSame(f.original, f.state.pending)
    }
    @Test fun `observed deadline boundary confirms closure without a terminal receipt`() = runTest {
        val f = Fixture(); f.due(); f.read = { f.response(30) }
        f.check.refreshIfDue()
        assertEquals(StagingReservationStatus.WINDOW_CLOSED, f.check.status)
        assertFalse(f.check.allowsInput()); assertFalse(f.state.terminal)
        assertSame(f.original, f.state.pending)
    }
    @Test fun `unknown pending status remains unknown until an explicit matching read corrects it`() = runTest {
        val f = Fixture(); f.due(); f.read = { buildJsonObject { put("raid", JsonNull) } }
        f.check.refreshIfDue()
        assertEquals(StagingReservationStatus.WAITING, f.check.status); assertTrue(f.check.status.canRetry)
        repeat(3) { f.check.refreshIfDue() }
        assertEquals(1, f.reads); assertFalse(f.check.allowsInput())
        f.read = { f.response(1) }; f.check.refreshIfDue(retry = true)
        assertEquals(2, f.reads); assertEquals(StagingReservationStatus.OPEN, f.check.status)
        assertTrue(f.check.allowsInput()); assertSame(f.original, f.state.pending)
    }
    @Test fun `running reservation clock waits for canonical presentation rather than claiming a closed window`() = runTest {
        val f = Fixture(); f.due(); f.read = { f.response(31, started = true) }
        f.check.refreshIfDue()
        assertEquals(StagingReservationStatus.WAITING, f.check.status)
        assertFalse(f.check.allowsInput()); assertFalse(f.state.terminal)
        f.state = f.state.copy(phase = BattlePhase.RUNNING, clock = BattleClock.read(f.clock(32, true), f.time))
        assertTrue(f.check.allowsInput())
    }
    @Test fun `closed window preserves accepted pending and in-memory orders without claiming an empty battle`() = runTest {
        val f = Fixture()
        val accepted = buildJsonObject { put("kind", "hero"); put("clientCommandId", "accepted-id") }
        val preparing = PendingBattleWrite("preparing-id", "/raids/raid/commands", buildJsonObject {
            put("clientCommandId", "preparing-id"); put("command", buildJsonObject { put("kind", "deploy") })
        })
        f.state = f.state.copy(commands = listOf(accepted), preparingWrites = listOf(preparing), inFlight = setOf("original-id"))
        val before = f.state
        f.due(); f.check.refreshIfDue(); f.check.refreshIfDue(retry = true)
        assertEquals(StagingReservationStatus.WINDOW_CLOSED, f.check.status)
        assertSame(before, f.state); assertSame(f.original, f.state.pending)
        assertFalse(f.state.terminal); assertFalse(f.check.allowsInput())
    }
    @Test fun `concurrent explicit rechecks share one read and expose no input while checking`() = runTest {
        val f = Fixture(); f.due(); f.check.refreshIfDue()
        val release = CompletableDeferred<Unit>()
        f.read = { release.await(); f.response(32) }
        val retry = launch { f.check.refreshIfDue(retry = true) }; runCurrent()
        assertEquals(StagingReservationStatus.CHECKING, f.check.status)
        assertFalse(f.check.status.canRetry); assertFalse(f.check.allowsInput())
        f.check.refreshIfDue(retry = true); assertEquals(2, f.reads)
        release.complete(Unit); retry.join()
        assertEquals(StagingReservationStatus.WINDOW_CLOSED, f.check.status); assertFalse(f.check.allowsInput())
        assertSame(f.original, f.state.pending)
    }
    @Test fun `historical missing deadline remains server decided without inventing expiry`() = runTest {
        val f = Fixture(); f.due(); f.state = f.state.copy(pending = f.original.copy(ordersDeadlineAt = null))
        assertTrue(f.check.allowsInput()); f.check.refreshIfDue(); assertEquals(0, f.reads)
        assertFalse(f.state.terminal)
    }
    @Test fun `phone wall clock is not an input and monotonic server estimate controls admission`() {
        val f = Fixture()
        // Even a phone set years forward cannot expire this server-anchored reservation.
        assertTrue(f.check.allowsInput()); f.time = 29_000_000_000; assertTrue(f.check.allowsInput())
        f.time = 31_000_000_000; assertFalse(f.check.allowsInput()); assertFalse(f.state.expired)
    }
    @Test fun `a null pending row waits for complete canonical terminal evidence`() = runTest {
        val f = Fixture(); f.due(); f.read = { buildJsonObject { put("raid", JsonNull) } }
        f.check.refreshIfDue()
        assertEquals(StagingReservationStatus.WAITING, f.check.status)
        assertSame(f.original, f.state.pending); assertFalse(f.state.terminal)
        f.state = f.state.copy(expired = true, phase = BattlePhase.EXPIRED)
        assertFalse(f.check.allowsInput())
    }
    @Test fun `delayed recovery rejects base or account replacement without publishing stale state`() = runTest {
        val f = Fixture(); f.due(); val release = CompletableDeferred<Unit>()
        f.read = { release.await(); f.response(1) }
        val job = launch { f.check.refreshIfDue() }; runCurrent()
        assertEquals(StagingReservationStatus.CHECKING, f.check.status); assertFalse(f.check.allowsInput())
        f.current = false; release.complete(Unit); job.join()
        assertEquals(listOf(StagingReservationStatus.CHECKING), f.statuses)
        assertFalse(f.check.allowsInput()); assertSame(f.original, f.state.pending)
    }
    @Test fun `cancellation permits a later foreground read without losing the journal`() = runTest {
        val f = Fixture(); f.due(); f.read = { awaitCancellation() }
        val job = launch { f.check.refreshIfDue() }; runCurrent(); job.cancelAndJoin()
        assertEquals(StagingReservationStatus.OPEN, f.check.status); assertFalse(f.check.allowsInput())
        f.read = { f.response() }; f.check.refreshIfDue()
        assertEquals(2, f.reads); assertSame(f.original, f.state.pending)
    }
    @Test fun `failed read stays paused until explicit GET retry and mismatched raid never reopens`() = runTest {
        val f = Fixture(); f.due(); f.read = { error("offline") }
        f.check.refreshIfDue(); f.check.refreshIfDue()
        assertEquals(1, f.reads); assertEquals(StagingReservationStatus.FAILED, f.check.status)
        f.read = { f.response(1, "other-base") }; f.check.refreshIfDue(retry = true)
        assertEquals(2, f.reads); assertFalse(f.check.allowsInput())
        assertSame(f.original, f.state.pending)
    }
    @Test fun `accepted running presentation wins a late staging check while terminal remains closed`() = runTest {
        val f = Fixture(); f.due(); val release = CompletableDeferred<Unit>()
        f.read = { release.await(); f.response() }
        val job = launch { f.check.refreshIfDue() }; runCurrent()
        f.state = f.state.copy(phase = BattlePhase.RUNNING, clock = BattleClock.read(f.clock(32, true), f.time))
        assertTrue(f.check.allowsInput()); release.complete(Unit); job.join()
        assertTrue(f.check.allowsInput())
        f.state = f.state.copy(result = buildJsonObject {}, phase = BattlePhase.RESULT)
        assertFalse(f.check.allowsInput())
    }
}
