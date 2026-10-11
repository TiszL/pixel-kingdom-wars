package gg.pixelkingdomwars.nativeclient.network

import gg.pixelkingdomwars.nativeclient.model.ActiveBaseRaid
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.receiveAsFlow
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException

/** The defender interlock degrades exactly as production does (web BaseRaidInterlock.tsx): SSE while healthy,
 * a 2 s canonical poll while not, bounded reconnects, a watchdog heartbeats may only re-arm after a snapshot —
 * and losing transport never unlocks a deed. Time is virtual so every cadence is asserted, not slept. */
class RaidInterlockTest {
    private class VirtualTime {
        var now = 0L
        private val waiters = mutableListOf<Pair<Long, CompletableDeferred<Unit>>>()
        suspend fun pause(ms: Long) { val d = CompletableDeferred<Unit>(); synchronized(this) { waiters += (now + ms) to d }; d.await() }
        /** Fires every waiter due up to the target in order, letting each resumed coroutine register its next pause. */
        suspend fun advance(ms: Long) {
            val target = now + ms
            while (true) {
                val next = synchronized(this) { waiters.filter { it.first <= target }.minByOrNull { it.first } } ?: break
                synchronized(this) { waiters.remove(next) }
                now = maxOf(now, next.first); next.second.complete(Unit)
                repeat(30) { yield() }
            }
            now = target
        }
    }
    private class Harness(scope: CoroutineScope) {
        val time = VirtualTime()
        val connections = mutableListOf<Channel<RaidEventFrame>>()
        var polls = 0
        var pollAnswer: suspend () -> ActiveBaseRaid? = { null }
        val interlock = RaidInterlock("deed", { Channel<RaidEventFrame>(Channel.UNLIMITED).also { connections += it }.receiveAsFlow() }, { polls++; pollAnswer() }, time::pause, Dispatchers.Unconfined)
        val job = scope.launch { interlock.run() }
        val state get() = interlock.state.value
    }
    private suspend fun settle() = repeat(30) { yield() }
    private suspend fun Harness.advance(ms: Long) { time.advance(ms); settle() }
    private val lock = ActiveBaseRaid("11111111-1111-4111-8111-111111111111", "live")

    @Test fun `a snapshot unlocks the deed only when it says no raid and a lock keeps every action off`() = runBlocking {
        val h = Harness(this); settle()
        assertFalse("Nothing is known before the first canonical read", h.state.actionsAllowed)
        h.connections.single().send(RaidEventFrame.Snapshot(null)); settle()
        assertTrue(h.state.known); assertTrue(h.state.actionsAllowed)
        h.connections.single().send(RaidEventFrame.Snapshot(lock)); settle()
        assertEquals(lock, h.state.activeRaid); assertFalse(h.state.actionsAllowed)
        h.advance(10_000); assertEquals("A healthy stream never polls", 0, h.polls)
        h.job.cancelAndJoin()
    }
    @Test fun `losing the stream makes an unlocked deed unknown keeps a known lock and polls until the stream recovers`() = runBlocking {
        val h = Harness(this); settle()
        h.connections[0].send(RaidEventFrame.Snapshot(null)); settle()
        h.connections[0].close(IOException("reset")); settle()
        assertEquals("The canonical GET runs at once after the stream drops", 1, h.polls)
        assertTrue("A poll that says no raid re-unlocks", h.state.actionsAllowed)
        h.pollAnswer = { lock }
        h.advance(2_000); assertEquals(2, h.polls); assertEquals(lock, h.state.activeRaid); assertFalse(h.state.actionsAllowed)
        assertEquals("First reconnect after one second", 2, h.connections.size)
        h.connections[1].close(IOException("reset again")); settle()
        assertEquals("A known lock survives lost transport", lock, h.state.activeRaid); assertTrue(h.state.known)
        h.pollAnswer = { null }
        h.advance(2_000)
        assertEquals("Reconnect two waits two seconds", 3, h.connections.size)
        h.connections[2].send(RaidEventFrame.Snapshot(null)); settle()
        val polled = h.polls
        h.advance(6_000); assertEquals("A healthy stream stops the poll", polled, h.polls); assertTrue(h.state.actionsAllowed)
        h.job.cancelAndJoin()
    }
    @Test fun `an unlocked deed whose stream drops is not usable until a canonical answer`() = runBlocking {
        val h = Harness(this); settle()
        h.connections[0].send(RaidEventFrame.Snapshot(null)); settle()
        val gate = CompletableDeferred<ActiveBaseRaid?>()
        h.pollAnswer = { gate.await() }
        h.connections[0].close(IOException("reset")); settle()
        assertFalse("Unknown until the poll answers", h.state.known); assertFalse(h.state.actionsAllowed)
        gate.complete(null); settle()
        assertTrue(h.state.actionsAllowed)
        h.job.cancelAndJoin()
    }
    @Test fun `a disabled server retries the stream a minute later while the poll carries the lock`() = runBlocking {
        val h = Harness(this); settle()
        h.connections[0].close(ApiException(404, RAID_EVENTS_DISABLED, "raid streaming is unavailable")); settle()
        assertEquals(1, h.polls)
        h.advance(59_000); assertEquals(1, h.connections.size)
        assertTrue("Polling keeps going every two seconds meanwhile", h.polls >= 25)
        h.advance(1_000); assertEquals(2, h.connections.size)
        h.job.cancelAndJoin()
    }
    @Test fun `the watchdog reconnects a silent stream and heartbeats re-arm it only after the first snapshot`() = runBlocking {
        val h = Harness(this); settle()
        h.connections[0].send(RaidEventFrame.Heartbeat); settle()
        h.advance(29_000); assertEquals(1, h.connections.size)
        h.advance(1_000); h.advance(1_000)
        assertEquals("No snapshot inside the watchdog: reconnect", 2, h.connections.size)
        h.connections[1].send(RaidEventFrame.Snapshot(null)); settle()
        h.advance(25_000); h.connections[1].send(RaidEventFrame.Heartbeat); settle()
        h.advance(25_000); assertEquals("A heartbeat after a snapshot re-armed the watchdog", 2, h.connections.size)
        h.advance(6_000); h.advance(2_000)
        assertEquals(3, h.connections.size)
        h.job.cancelAndJoin()
    }
    @Test fun `a slow poll cannot overwrite a newer stream snapshot and reconnects back off to thirty seconds`() = runBlocking {
        val h = Harness(this); settle()
        val gate = CompletableDeferred<ActiveBaseRaid?>()
        h.pollAnswer = { gate.await() }
        h.connections[0].close(IOException("reset")); settle()
        h.advance(1_000)
        assertEquals(2, h.connections.size)
        h.connections[1].send(RaidEventFrame.Snapshot(lock)); settle()
        gate.complete(null); settle()
        assertEquals("The stream's lock stands; the stale poll is discarded", lock, h.state.activeRaid)
        h.pollAnswer = { null }
        // The snapshot on connection two reset the backoff (web `reconnects = 0` on every snapshot).
        var expected = 2
        for (gap in listOf(1_000L, 2_000L, 4_000L, 8_000L, 16_000L, 30_000L, 30_000L)) {
            h.connections.last().close(IOException("reset")); settle()
            h.advance(gap - 1); assertEquals("No reconnect before $gap ms", expected, h.connections.size)
            h.advance(1); expected++; assertEquals(expected, h.connections.size)
        }
        h.job.cancelAndJoin()
    }
}
