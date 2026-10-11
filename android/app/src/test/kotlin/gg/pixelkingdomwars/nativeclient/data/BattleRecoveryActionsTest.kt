package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.network.*
import java.io.IOException
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.*
import org.junit.Test

/** D153.333 (a)(b)(d): what the recovery overlay's exits and "Details" actions do to an unconfirmed create. On 2026-10-02 a
 * player's retried POST /raids was refused 404, yet the saved request kept reopening the battle screen on every Home entry
 * and the overlay kept saying the march was awaiting confirmation. Every path here must end on a screen the player can leave. */
class BattleRecoveryActionsTest {
    private class Fixture(val store: PendingBattleStore = PendingBattleStore(MemoryStore())) {
        val api = FakeApiClient()
        val holder = testHolder()
        val session = signedIn(holder)
        val gameApi = GameApi("https://localhost:18443", SessionCookieJar("https://localhost:18443".toHttpUrl(), MemoryStore()), "battle-test")
        var hydrations = 0
        val repository = LiveBattleRepository(session, holder, requireNotNull(holder.scopeOf(session)), api, gameApi, store, { BASE_ID }, { 14 },
            { true }, { hydrations++ }, {}, {}, stableSelector = { true }, campaignStages = { 2 }, scoutPreviewSec = { 30 }, now = { 1_000L },
            // The coordinator's own reads and the create POST go through the same scripted transport as the repository.
            coordinatorFactory = { base, sim -> BattleCoordinator.withTransport(WALLET, base, sim, store, { path, query -> api.get(path, query) }, { path, body -> api.post(path, body) }) { kotlinx.coroutines.flow.emptyFlow() } },
            spectatorFactory = { raid, sim -> BattleSpectator.withTransport(raid, sim) { kotlinx.coroutines.flow.emptyFlow() } })
        init {
            api.onGet("/native/capabilities") { json("""{"simVersion":14,"presentation":{"enabled":true}}""") }
            api.onGet("/raids/pending") { json("""{"raids":[]}""") }
        }
        /** FIND ME A TARGET whose answer was lost: the create is saved and attempted, and nothing is confirmed. */
        suspend fun unconfirmedCreate(): BattleCoordinator {
            api.onPost("/raids") { throw IOException("connection reset") }
            repository.pvpBattle(RaidCreateTarget.Pvp())
            kotlinx.coroutines.withTimeout(5_000) { repository.state.first { it.error != null } }
            val coordinator = requireNotNull(repository.state.value.coordinator)
            kotlinx.coroutines.withTimeout(5_000) { coordinator.state.first { !it.creating } }
            assertNotNull("A lost answer keeps the saved request: the server may have committed it", store.get(WALLET, BASE_ID)?.create)
            assertTrue(repository.state.value.battleVisible)
            return coordinator
        }
    }

    @Test fun `BACK TO BASE from an unconfirmed create reaches Home and the next Home entry does not reopen it`() = runBlocking {
        val f = Fixture()
        f.unconfirmedCreate()
        f.repository.returnHome()
        assertFalse("BACK TO BASE always navigates; the recovery overlay never traps the screen", f.repository.state.value.battleVisible)
        assertEquals(1, f.hydrations)
        assertEquals("The Home screen the player just reached must not send them straight back to the create they left", EntryRecovery.NONE, f.repository.recoverOnEntry())
        assertFalse(f.repository.state.value.battleVisible)
        assertNotNull("Leaving is navigation only: the saved request stays recoverable", f.store.get(WALLET, BASE_ID)?.create)
        assertEquals("resumeRaid refuses while a create is saved, so entry must not read the server's pending list for it", 1, f.api.gets.count { it.first == "/raids/pending" })
        assertEquals(1, f.api.posts.size)
    }

    @Test fun `a relaunch still reopens an unconfirmed create for its recovery`() = runBlocking {
        val store = PendingBattleStore(MemoryStore())
        val f = Fixture(store)
        f.unconfirmedCreate(); f.repository.returnHome()
        assertEquals(EntryRecovery.NONE, f.repository.recoverOnEntry())
        val relaunch = Fixture(store)
        assertEquals("A cold start knows nothing of BACK TO BASE: the journal alone says a create is unconfirmed", EntryRecovery.BATTLE, relaunch.repository.recoverOnEntry())
        assertTrue(relaunch.repository.state.value.battleVisible)
        assertTrue("Reopening the recovery sends nothing", relaunch.api.posts.isEmpty())
    }

    @Test fun `Retry same request answered with a terminal refusal becomes the refusal panel with the server line`() = runBlocking {
        val f = Fixture()
        val coordinator = f.unconfirmedCreate()
        val id = requireNotNull(coordinator.state.value.pending?.create?.id)
        val line = "That keep can't be raided right now — pick another target"
        f.api.onPost("/raids") { throw ApiException(404, null, line) }
        assertThrows(ApiException::class.java) { runBlocking { f.repository.retrySavedRequest(coordinator, id) } }
        val failure = requireNotNull(f.repository.state.value.createFailure) { "The refusal panel needs its cause" }
        assertEquals("The server's own line, never awaiting-confirmation copy", line, failure.message)
        assertEquals(404, failure.status); assertEquals(RaidCreateTarget.Pvp(), failure.target)
        assertNull("No raid can exist for this key after a 404: the journal is retired", f.store.get(WALLET, BASE_ID))
        assertNull(coordinator.state.value.pending)
        assertTrue("The panel shows on the battle screen, with BACK TO BASE", f.repository.state.value.battleVisible)
        assertEquals("Retry same request resends the saved key, not a fresh one", id, f.api.posts.last().second.string("idempotencyKey"))
        assertEquals(2, f.api.posts.size)
        f.repository.returnHome()
        assertFalse(f.repository.state.value.battleVisible); assertNull(f.repository.state.value.createFailure)
        assertEquals("Nothing saved: the next Home entry trusts the server's pending list", EntryRecovery.NONE, f.repository.recoverOnEntry())
    }

    @Test fun `a lost answer or 503 to Retry same request keeps the create and shows no refusal panel`() = runBlocking {
        val f = Fixture()
        val coordinator = f.unconfirmedCreate()
        val id = requireNotNull(coordinator.state.value.pending?.create?.id)
        val journal = f.store.get(WALLET, BASE_ID)
        f.api.onPost("/raids") { throw IOException("connection reset") }
        assertThrows(IOException::class.java) { runBlocking { f.repository.retrySavedRequest(coordinator, id) } }
        assertNull("The outcome is unknown: the server may still commit this key, so no refusal panel", f.repository.state.value.createFailure)
        assertEquals("The journal is byte-identical: the exact request stays retryable", journal, f.store.get(WALLET, BASE_ID))
        f.api.onPost("/raids") { throw ApiException(503, "DEED_AUTHORITY_UNAVAILABLE", "deed ownership unavailable or changed") }
        assertThrows(ApiException::class.java) { runBlocking { f.repository.retrySavedRequest(coordinator, id) } }
        assertNull("A 5xx says nothing about this key: the same request may succeed on the next retry", f.repository.state.value.createFailure)
        assertEquals(journal, f.store.get(WALLET, BASE_ID))
        assertNotNull(coordinator.state.value.pending?.create)
        assertEquals(3, f.api.posts.size)
    }

    @Test fun `Discard saved request forgets the key, leaves for Home and sends nothing`() = runBlocking {
        val f = Fixture()
        val coordinator = f.unconfirmedCreate()
        val id = requireNotNull(coordinator.state.value.pending?.create?.id)
        f.repository.discardSavedCreate(coordinator, id)
        assertNull("The player's confirmed choice forgets the unconfirmed create on this device", f.store.get(WALLET, BASE_ID))
        assertNull(coordinator.state.value.pending)
        assertFalse("Discard ends on Home, not on the recovery overlay", f.repository.state.value.battleVisible)
        assertEquals("Nothing is sent: the server's pending list stays the ground truth for a raid it did commit", 1, f.api.posts.size)
        assertEquals(1, f.hydrations)
        assertEquals(EntryRecovery.NONE, f.repository.recoverOnEntry())
    }
}
