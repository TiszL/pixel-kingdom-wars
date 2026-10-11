package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.model.FantasyParcel
import gg.pixelkingdomwars.nativeclient.model.FantasyTile
import gg.pixelkingdomwars.nativeclient.network.ApiException
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

/**
 * The base card's dwell rule (GLOBE-PRODUCTION-PLAN §2.6.4). `GET /globe/fantasy/parcels/:tileId` is metered at 24/min per
 * wallet and per IP and fails closed, and the realm map invites next/previous browsing: without the dwell a player
 * flicking through kingdoms would hit 429 within seconds and lose the card for everyone on that IP. The plan's own test:
 * browsing 30 bases in 10 seconds issues at most 3 detail reads.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class WorldParcelReadsTest {
    private val cacheMs = 20_000L   // the catalogue's WORLD.mapPollSec (20 s) at the pin
    private val pollMs = 60_000L    // WARZONE.currentPhasePollSec (60 s)
    private fun parcel(tile: Int) = FantasyParcel("fantasy-v1", FantasyTile(tileId = tile, realmId = "crownlands"), "occupied")

    private class Probe { val reads = ArrayList<Pair<Int, Long>>(); val shown = ArrayList<Int>(); val failures = ArrayList<WorldParcelFailure>() }

    /** One card following [tile] the way `WorldViewModel.select` runs it. */
    private fun TestScope.follow(reads: WorldParcelReads, probe: Probe, tile: Int, dwellMs: Long, fresh: Boolean = false,
        read: suspend (Int) -> FantasyParcel = { parcel(it) }): Job = launch {
        reads.follow(tile, dwellMs, cacheMs, pollMs, fresh, { testScheduler.currentTime }, { testScheduler.currentTime * 1_000_000L },
            read = { probe.reads += it to testScheduler.currentTime; read(it) },
            publish = { p, _ -> probe.shown += p.tile.tileId }, fail = { probe.failures += it },
            nextDelayMs = { _, _, poll -> poll })
    }

    /** Next/previous through [count] bases, one every [stepMs]: each new card cancels the last one's follow. */
    private fun TestScope.browse(reads: WorldParcelReads, probe: Probe, count: Int, stepMs: Long, dwellMs: Long): Job? {
        var job: Job? = null
        repeat(count) { i -> job?.cancel(); job = follow(reads, probe, 1_000 + i, dwellMs); advanceTimeBy(stepMs); runCurrent() }
        return job
    }

    @Test fun `browsing 30 bases in 10 seconds issues at most 3 detail reads, and resting on one reads it once`() = runTest {
        val probe = Probe(); val reads = WorldParcelReads()
        val last = browse(reads, probe, 30, 333, WorldParcelReads.CARD_DWELL_MS)
        assertTrue("the plan's bound: ${probe.reads}", probe.reads.size <= 3)
        advanceTimeBy(WorldParcelReads.CARD_DWELL_MS); runCurrent()
        assertEquals("the card the player stopped on is read once its dwell ends", listOf(1_029), probe.reads.map { it.first }.takeLast(1))
        assertEquals(listOf(1_029), probe.shown)
        last?.cancel()
    }

    @Test fun `without the dwell the same browse would spend the whole budget (the rule has teeth)`() = runTest {
        val probe = Probe(); val reads = WorldParcelReads()
        browse(reads, probe, 30, 333, dwellMs = 0L)?.cancel()
        assertEquals("every card read at once: 30 metered reads in 10 s, over the 24/min limit", 30, probe.reads.size)
    }

    @Test fun `a rested card polls at the phase period, and returning inside mapPollSec spends nothing`() = runTest {
        val probe = Probe(); val reads = WorldParcelReads()
        var job = follow(reads, probe, 7, WorldParcelReads.CARD_DWELL_MS)
        advanceTimeBy(WorldParcelReads.CARD_DWELL_MS + 1); runCurrent()
        assertEquals(1, probe.reads.size)
        advanceTimeBy(pollMs); runCurrent()
        assertEquals("the poll re-reads the selected parcel once per period", 2, probe.reads.size)
        job.cancel()
        // Away for 5 s, then back: the 5-second-old read shows at once and nothing is spent until its poll is due.
        advanceTimeBy(5_000); runCurrent()
        job = follow(reads, probe, 7, WorldParcelReads.CARD_DWELL_MS); runCurrent()
        assertEquals("the cached read is shown with no dwell", listOf(7, 7, 7), probe.shown)
        advanceTimeBy(WorldParcelReads.CARD_DWELL_MS + 1_000); runCurrent()
        assertEquals("no read inside the cache window", 2, probe.reads.size)
        advanceTimeBy(pollMs); runCurrent()
        assertEquals("the poll resumes on the read's own schedule", 3, probe.reads.size)
        job.cancel()
        // Past mapPollSec the cache is stale: the dwell applies again and a fresh read follows.
        advanceTimeBy(cacheMs + 1); runCurrent()
        job = follow(reads, probe, 7, WorldParcelReads.CARD_DWELL_MS); runCurrent()
        assertEquals(3, probe.reads.size)
        advanceTimeBy(WorldParcelReads.CARD_DWELL_MS + 1); runCurrent()
        assertEquals(4, probe.reads.size)
        job.cancel()
    }

    @Test fun `RETRY reads now whatever the cache holds`() = runTest {
        val probe = Probe(); val reads = WorldParcelReads()
        var job = follow(reads, probe, 3, 0L); runCurrent(); job.cancel()
        job = follow(reads, probe, 3, 0L); runCurrent(); job.cancel()
        assertEquals("a second look inside mapPollSec is the cached read", 1, probe.reads.size)
        job = follow(reads, probe, 3, 0L, fresh = true); runCurrent()
        assertEquals("RETRY (fresh) reads the server again", listOf(3, 3), probe.reads.map { it.first })
        job.cancel()
    }

    @Test fun `a 429 or a land gate stops the follow with the card's words, other failures retry at the poll`() = runTest {
        val probe = Probe(); val reads = WorldParcelReads()
        follow(reads, probe, 5, 0L, read = { throw ApiException(429, null, "parcel inspection limit reached; try again in 40s") })
        advanceTimeBy(10 * pollMs); runCurrent()
        assertEquals("a refused metered read is never retried on its own", 1, probe.reads.size)
        assertEquals(WorldParcelFailureKind.BUSY, probe.failures.single().kind)
        assertEquals("Details are busy, try again in a moment", probe.failures.single().message)

        val gate = Probe()
        follow(reads, gate, 6, 0L, read = { throw ApiException(402, "LAND_NOT_OWNED", "buy your land to unlock this") })
        advanceTimeBy(10 * pollMs); runCurrent()
        assertEquals(1, gate.reads.size)
        assertEquals(WorldParcelFailureKind.LAND_GATE, gate.failures.single().kind)
        assertEquals("Acquire a Land Deed to inspect occupied bases.", gate.failures.single().message)
        assertEquals("the server's own words stay available to the legacy globe", "buy your land to unlock this", gate.failures.single().raw)
        assertEquals(WorldParcelFailureKind.LAND_GATE, WorldParcelFailure.of(1, ApiException(403, null, "no")).kind)

        val flaky = Probe(); var calls = 0
        val job = follow(reads, flaky, 8, 0L, read = { if (++calls == 1) throw java.io.IOException("offline") else parcel(it) })
        runCurrent()
        assertEquals(WorldParcelFailureKind.OTHER, flaky.failures.single().kind)
        advanceTimeBy(pollMs); runCurrent()
        assertEquals("a transient failure retries at the poll, as the old loop did", listOf(8), flaky.shown)
        job.cancel()
    }
}
