package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.fleetjourney.FleetJourneyEvent
import gg.pixelkingdomwars.nativeclient.ops.PendingIntentStore
import gg.pixelkingdomwars.nativeclient.ops.ReceiptObserver
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class BaseRepositoryFleetJourneyTest {
    private class Fixture {
        val holder = testHolder(); val session = signedIn(holder)
        val api = FakeApiClient(); val store = PendingIntentStore(MemoryStore())
        val publisher = FleetJourneyPublication(session, holder)
        val delivered = mutableListOf<FleetJourneyEvent>()
        var generation = 0L; var selected = BASE_ID
        var raw = journeyBase("away"); var shards = "3520"
        val repository = LiveBaseRepository(session, holder, api, store, ReceiptObserver(store), { selected },
            baseGeneration = { generation }, fleetJourneys = publisher)
        init {
            api.onGet("/base") { raw }; api.onGet("/balances") { balancesJson(shards) }; api.onGet("/tutorial") { tutorialJson() }
        }
        fun mount(consume: (FleetJourneyEvent) -> Unit = { delivered += it }) = publisher.attach(Any(), BASE_ID, Any(), { true }, consume)
        fun returned(revision: Int = 2, receipt: Int = 4) { raw = journeyBase(revision = revision, events = journeyBatch(journeyEvent(receipt = receipt))) }
    }

    @Test fun `readHome separates malformed optional callbacks from every clean cached snapshot`() = runBlocking {
        val f = Fixture(); f.raw = journeyBase(events = JsonPrimitive("malformed"))
        val home = readHome(f.api, BASE_ID)
        assertEquals(JsonPrimitive("malformed"), home.fleetJourneyEvents)
        assertFalse(home.base.raw.containsKey("fleetJourneyEvents"))
        assertEquals("3520", home.balances.shards)
    }

    @Test fun `cold callbacks drop and warm settled callbacks follow the winning balance publication exactly once`() = runBlocking {
        val f = Fixture(); f.mount {
            assertFalse(f.repository.state.value.base!!.raw.containsKey("fleetJourneyEvents"))
            assertEquals("4000", f.repository.state.value.balances!!.shards)
            f.delivered += it
        }
        f.returned(); f.repository.refresh(); assertTrue(f.delivered.isEmpty())
        f.shards = "4000"; f.returned(revision = 3); f.repository.refresh()
        assertEquals(1, f.delivered.size)
        f.returned(revision = 4); f.repository.refresh(); assertEquals(1, f.delivered.size)
        assertNull(f.repository.state.value.error); assertTrue(f.api.posts.isEmpty())
    }

    @Test fun `unmounted malformed and throwing presentation preserve authoritative Home success`() = runBlocking {
        val f = Fixture(); f.returned(); f.repository.refresh()
        assertTrue(f.delivered.isEmpty()); assertFalse(f.repository.state.value.base!!.raw.containsKey("fleetJourneyEvents"))
        f.mount { error("art lease lost") }; f.repository.refresh()
        f.raw = journeyBase(revision = 3, events = JsonPrimitive("bad")); f.shards = "4100"; f.repository.refresh()
        f.returned(revision = 4); f.shards = "4200"; f.repository.refresh()
        assertEquals("4200", f.repository.state.value.balances!!.shards)
        assertNull(f.repository.state.value.error); assertFalse(f.repository.state.value.loading)
    }

    @Test fun `receipt hydration cannot warm or publish original history as a live return`() = runBlocking {
        val f = Fixture(); f.mount(); f.returned(); f.repository.refreshForWorkshop {}
        f.returned(revision = 3); f.repository.refresh(); assertTrue(f.delivered.isEmpty())
        f.returned(revision = 4, receipt = 5); f.repository.refreshForWorkshop {}; assertTrue(f.delivered.isEmpty())
        f.returned(revision = 5, receipt = 6); f.repository.refresh(); assertEquals(1, f.delivered.size)
        assertEquals("00000000-0000-4000-8000-000000000006", f.delivered.single().returnId)
    }

    @Test fun `accepted domain hydration publishes balances without warming a cold journey consumer`() = runBlocking {
        val f = Fixture(); f.mount(); f.returned(); f.shards = "4100"
        val base: BaseRepository = f.repository
        base.refreshWithoutJourneys()
        assertTrue(f.delivered.isEmpty()); assertEquals("4100", base.state.value.balances!!.shards)
        assertFalse(base.state.value.base!!.raw.containsKey("fleetJourneyEvents"))
        assertFalse(base.state.value.loading); assertNull(base.state.value.error)
        f.returned(revision = 3, receipt = 5); base.refresh(); assertTrue(f.delivered.isEmpty())
        f.returned(revision = 4, receipt = 6); base.refresh()
        assertEquals("00000000-0000-4000-8000-000000000006", f.delivered.single().returnId)
    }

    @Test fun `history hydration preserves a warm consumer and its session dedup for the next live return`() = runBlocking {
        val f = Fixture(); f.mount(); f.repository.refresh()
        f.returned(); f.repository.refresh(); assertEquals(1, f.delivered.size)
        f.shards = "4200"; f.returned(revision = 3, receipt = 5); f.repository.refreshWithoutJourneys()
        assertEquals(1, f.delivered.size); assertEquals("4200", f.repository.state.value.balances!!.shards)
        f.returned(revision = 4, receipt = 6); f.repository.refresh()
        assertEquals(listOf("00000000-0000-4000-8000-000000000004", "00000000-0000-4000-8000-000000000006"),
            f.delivered.map { it.returnId })
        f.returned(revision = 5); f.repository.refresh()
        assertEquals(2, f.delivered.size)
    }

    @Test fun `hydration and live reads retain newest Home ownership in either arrival order`() = runBlocking {
        withTimeout(5_000) {
            for (olderIsLive in listOf(false, true)) {
                val f = Fixture(); f.mount(); f.repository.refresh(); f.returned()
                val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>(); var calls = 0
                f.api.onGet("/balances") {
                    if (++calls == 1) { entered.complete(Unit); release.await(); balancesJson("111") }
                    else balancesJson("999")
                }
                val older = async { runCatching {
                    if (olderIsLive) f.repository.refresh() else f.repository.refreshWithoutJourneys()
                } }
                // Rewritten 2026-10-06 (owner "always loading"): this older read re-reads the Home already shown, so it no
                // longer raises the loading flag; ownership of the newest read below is what this case pins.
                entered.await(); assertFalse(f.repository.state.value.loading)
                f.returned(revision = 3, receipt = 5)
                if (olderIsLive) f.repository.refreshWithoutJourneys() else f.repository.refresh()
                val winning = f.repository.state.value
                assertEquals("999", winning.balances!!.shards); assertFalse(winning.loading); assertNull(winning.error)
                val deliveredByWinner = if (olderIsLive) 0 else 1
                assertEquals(deliveredByWinner, f.delivered.size)
                release.complete(Unit)
                assertTrue(older.await().exceptionOrNull() is CancellationException)
                assertEquals(winning, f.repository.state.value); assertEquals(deliveredByWinner, f.delivered.size)
                f.returned(revision = 4, receipt = 6); f.repository.refresh()
                assertEquals(deliveredByWinner + 1, f.delivered.size)
                assertEquals("00000000-0000-4000-8000-000000000006", f.delivered.last().returnId)
            }
        }
    }

    @Test fun `failed history hydration retains Home and cleans up error and loading without cooling the consumer`() = runBlocking {
        val f = Fixture(); f.mount(); f.repository.refresh(); val initial = f.repository.state.value.base
        f.returned(); f.api.onGet("/balances") { error("Home unavailable") }
        assertTrue(runCatching { f.repository.refreshWithoutJourneys() }.isFailure)
        assertSame(initial, f.repository.state.value.base); assertEquals("3520", f.repository.state.value.balances!!.shards)
        assertEquals("Home unavailable", f.repository.state.value.error); assertFalse(f.repository.state.value.loading)
        assertTrue(f.delivered.isEmpty())
        f.api.onGet("/balances") { balancesJson("4500") }; f.returned(revision = 3, receipt = 5)
        f.repository.refresh()
        assertEquals("4500", f.repository.state.value.balances!!.shards); assertNull(f.repository.state.value.error)
        assertFalse(f.repository.state.value.loading)
        assertEquals("00000000-0000-4000-8000-000000000005", f.delivered.single().returnId)
    }

    @Test fun `history hydration cannot publish after its account is replaced`() = runBlocking {
        val f = Fixture(); f.mount(); f.repository.refresh(); val initial = f.repository.state.value.base
        f.returned(); f.api.onGet("/balances") { signedIn(f.holder, "another-wallet"); balancesJson("999") }
        assertTrue(runCatching { f.repository.refreshWithoutJourneys() }.isFailure)
        assertSame(initial, f.repository.state.value.base); assertEquals("3520", f.repository.state.value.balances!!.shards)
        assertTrue(f.delivered.isEmpty()); assertNull(f.repository.state.value.error)
    }

    @Test fun `switch away and back during HTTP drops only the optional return`() = runBlocking {
        val f = Fixture(); f.mount(); f.repository.refresh(); f.returned()
        f.api.onGet("/balances") { f.generation += 2; balancesJson("4500") }
        f.repository.refresh()
        assertTrue(f.delivered.isEmpty()); assertEquals("4500", f.repository.state.value.balances!!.shards)
        assertNull(f.repository.state.value.error)
    }

    @Test fun `resume during HTTP makes that response ineligible and the next scene starts cold`() = runBlocking {
        val f = Fixture(); f.mount(); f.repository.refresh(); f.returned()
        f.api.onGet("/balances") { f.publisher.invalidate(); f.mount(); balancesJson() }
        f.repository.refresh(); assertTrue(f.delivered.isEmpty())
        f.api.onGet("/balances") { balancesJson() }
        f.returned(revision = 3); f.repository.refresh(); assertTrue(f.delivered.isEmpty())
        f.returned(revision = 4); f.repository.refresh(); assertEquals(1, f.delivered.size)
    }

    @Test fun `a late superseded return cannot animate or replace the newer Home`() = runBlocking {
        withTimeout(5_000) {
            val f = Fixture(); f.mount(); f.repository.refresh(); f.returned()
            val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>(); var calls = 0
            f.api.onGet("/balances") {
                if (++calls == 1) { entered.complete(Unit); release.await(); balancesJson("111") }
                else balancesJson("999")
            }
            val older = async { runCatching { f.repository.refresh() } }; entered.await()
            f.raw = journeyBase(revision = 3)
            f.repository.refresh(); release.complete(Unit)
            assertTrue(older.await().isFailure)
            assertTrue(f.delivered.isEmpty()); assertEquals("999", f.repository.state.value.balances!!.shards)
        }
    }

    @Test fun `an accepted return response cannot publish after its account is replaced`() = runBlocking {
        val f = Fixture(); f.mount(); f.repository.refresh(); f.returned()
        f.api.onGet("/balances") { signedIn(f.holder, "another-wallet"); balancesJson("999") }
        assertTrue(runCatching { f.repository.refresh() }.isFailure)
        assertTrue(f.delivered.isEmpty()); assertEquals("3520", f.repository.state.value.balances!!.shards)
    }
}
