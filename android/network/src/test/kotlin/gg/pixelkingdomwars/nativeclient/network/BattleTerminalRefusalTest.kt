package gg.pixelkingdomwars.nativeclient.network

import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException

/** D153.333 (2026-10-02 production incident): a saved PvP create answered 404 no_other_targets on "Retry same request" stayed
 * "awaiting confirmation" forever, its status poll never stopped, and the recovery overlay trapped the screen. The server said
 * no raid can exist for that key; the client must believe it, show the server's line, and stop polling for a raid that cannot
 * appear. Outcomes the server did NOT settle (lost answer, 5xx, a 409 that is not the key mismatch) keep the exact key. */
class BattleTerminalRefusalTest {
    private class Memory : SecretStore {
        @Volatile var raw: String? = null
        override fun read() = raw
        override fun write(value: String) { raw = value }
        override fun clear() { raw = null }
    }
    private val raid = "11111111-1111-4111-8111-111111111111"
    private val store = PendingBattleStore(Memory())
    private val pages = Channel<JsonObject>(Channel.UNLIMITED)
    private var ids = 0
    private var pendingRaids: List<JsonObject> = emptyList()
    private fun makeCoordinator(store: PendingBattleStore = this.store, beforeGet: suspend (String) -> Unit = {},
                                pendingPollMs: (Int) -> Long = ::pendingRaidPollMs, post: suspend (String, JsonObject) -> JsonObject) =
        BattleCoordinator("wallet", "deed", 14, store, { path, _ -> beforeGet(path); if (path == "/native/capabilities") buildJsonObject {
            put("simVersion", 14); put("presentation", buildJsonObject { put("enabled", true) })
        } else buildJsonObject { put("raids", JsonArray(pendingRaids)) } }, post, { pages.receiveAsFlow() }, { 1_000_000_000L }, { "request-${++ids}" },
            pendingPollMs = pendingPollMs)
    /** The incident's starting point: the first answer to a create was lost, so its key is saved and marked attempted. */
    private suspend fun uncertainCreate(coordinator: BattleCoordinator, store: PendingBattleStore = this.store): PendingBattleWrite {
        assertTrue(runCatching { coordinator.createCampaign(1) }.isFailure)
        return requireNotNull(store.get("wallet", "deed")?.create).also { assertTrue("A sent create is marked attempted", it.attempted) }
    }

    @Test fun `isTerminalRaidCreateRefusal names exactly the refusals after which no raid can exist for the key`() {
        for (terminal in listOf(ApiException(403, null, "Everyone is shielded right now"), ApiException(404, "no_other_targets", "No other target available"),
            ApiException(422, "RAID_ENERGY", "Out of raid energy"), ApiException(409, "RAID_IDEMPOTENCY_MISMATCH", "Idempotency key reused")))
            assertTrue("${terminal.status} ${terminal.code}: answered after the idempotent fast path would have returned a committed raid, so none exists for this key",
                isTerminalRaidCreateRefusal(terminal))
        for (uncertain in listOf(ApiException(409, null, "Request already in progress"), ApiException(400, null, "Bad request"), ApiException(401, null, "expired"),
            ApiException(429, null, "Wait", retryAfterSeconds = 14), ApiException(500, null, "Internal error"), ApiException(503, "DEED_AUTHORITY_UNAVAILABLE", "Deed authority unavailable")))
            assertFalse("${uncertain.status} ${uncertain.code}: the server may still hold a raid under this key; only the saved key can find it",
                isTerminalRaidCreateRefusal(uncertain))
        assertFalse("A lost answer proves nothing either way", isTerminalRaidCreateRefusal(IOException("lost acknowledgement")))
    }

    @Test fun `a terminal refusal of a retried create retires its key and keeps the server's line`() = runBlocking {
        val refusals = listOf(ApiException(404, "no_other_targets", "That keep can't be raided right now — pick another target"),
            ApiException(422, "RAID_ENERGY", "Out of raid energy"), ApiException(403, null, "This account cannot raid right now"),
            ApiException(409, "RAID_IDEMPOTENCY_MISMATCH", "Idempotency key reused with a different request"))
        for (refusal in refusals) {
            val store = PendingBattleStore(Memory()); var posts = 0
            val coordinator = makeCoordinator(store) { _, _ -> posts++; if (posts == 1) throw IOException("lost acknowledgement") else throw refusal }
            val create = uncertainCreate(coordinator, store)
            assertSame(refusal, runCatching { coordinator.retry(create.id) }.exceptionOrNull())
            assertNull("${refusal.status} ${refusal.code}: the server said no raid can exist for this key, so nothing is left to recover", store.get("wallet", "deed"))
            // A 403 is an auth/admission refusal: it retires the key like the others AND blocks this coordinator until the session
            // is re-established, exactly as on a first attempt (send(): blocked on 401/403). Every other terminal refusal leaves a usable, empty state.
            assertEquals("${refusal.status}: only the auth refusal blocks the coordinator; the others return to an empty state the player can raid from",
                if (refusal.status == 403) BattlePhase.UNSUPPORTED else BattlePhase.EMPTY, coordinator.state.value.phase)
            assertEquals("${refusal.status}: blocked only for the auth refusal", refusal.status == 403, coordinator.state.value.blocked)
            assertNull(coordinator.state.value.pending)
            assertEquals("The player reads the server's reason, never awaiting-confirmation copy", refusal.message, coordinator.state.value.error)
            assertFalse(coordinator.state.value.creating)
            assertEquals("A retry sends the saved request exactly once; nothing else is posted", 2, posts)
        }
    }

    @Test fun `a lost answer a 5xx or a same-key 409 keeps the retried create exactly`() = runBlocking {
        val uncertain = listOf(IOException("lost acknowledgement"), ApiException(503, "DEED_AUTHORITY_UNAVAILABLE", "Deed authority unavailable"),
            ApiException(409, null, "Request already in progress"))
        for (failure in uncertain) {
            val store = PendingBattleStore(Memory()); var posts = 0
            val coordinator = makeCoordinator(store) { _, _ -> posts++; if (posts == 1) throw IOException("lost acknowledgement") else throw failure }
            val create = uncertainCreate(coordinator, store)
            val original = requireNotNull(store.get("wallet", "deed"))
            assertSame(failure, runCatching { coordinator.retry(create.id) }.exceptionOrNull())
            assertEquals("${failure.javaClass.simpleName}: the outcome is unknown, so the exact key stays for the next retry", original, store.get("wallet", "deed"))
            assertEquals(BattlePhase.RECOVERY, coordinator.state.value.phase)
            assertEquals("The uncertain state still tells the player what happened", battleFailureMessage(failure), coordinator.state.value.error)
            assertEquals(2, posts)
        }
    }

    @Test fun `pending poll schedule is 5 10 20 30 then holds the cap`() {
        assertEquals("Status reads for an unconfirmed create back off so a stuck key cannot hammer the server, and never beyond 30 s so a late 201 is still seen",
            listOf(5_000L, 10_000L, 20_000L, 30_000L, 30_000L, 30_000L), (0..5).map(::pendingRaidPollMs))
        assertEquals("The cap holds for any poll count", PENDING_RAID_POLL_MAX_MS, pendingRaidPollMs(Int.MAX_VALUE))
    }

    @Test fun `a saved create re-reads on the schedule and a CHECK restarts it while nothing saved reads once then waits for a wake`() = runBlocking {
        var reads = 0; val seen = mutableListOf<Int>(); var posts = 0
        // The real cadence is pinned by the pure schedule above; here the fourth wait parks so a wake's restart is unambiguous.
        val coordinator = makeCoordinator(beforeGet = { if (it == "/raids/pending") reads++ },
            pendingPollMs = { polls -> seen += polls; if (polls >= 3) 10_000L else 20L }) { _, _ -> posts++; throw IOException("lost acknowledgement") }
        val observing = launch { coordinator.runForeground() }
        try {
            delay(150)
            assertEquals("With nothing saved there is nothing to poll for: one read, then wait for a wake", 1, reads)
            coordinator.refreshEntry()
            withTimeout(1_000) { while (reads < 2) delay(5) }; delay(100)
            assertEquals("A CHECK reads once; it does not start a cadence", 2, reads)
            assertTrue("No schedule is consulted while nothing is saved", seen.isEmpty())
            uncertainCreate(coordinator)
            withTimeout(2_000) { while (seen.size < 4) delay(5) }
            assertEquals("A saved create re-reads on the back-off schedule from its first step", listOf(0, 1, 2, 3), seen)
            delay(100); assertEquals("The capped wait holds until the schedule or a wake ends it", 4, seen.size)
            coordinator.refreshEntry()
            withTimeout(1_000) { while (seen.size < 5) delay(5) }
            assertEquals("A CHECK reads at once and restarts the schedule from its first step", 0, seen[4])
            assertEquals("Status reads never resend the create", 1, posts)
        } finally { observing.cancelAndJoin() }
    }

    @Test fun `a terminal refusal stops the pending poll`() = runBlocking {
        var reads = 0; var posts = 0
        val refusal = ApiException(404, "no_other_targets", "That keep can't be raided right now — pick another target")
        val coordinator = makeCoordinator(beforeGet = { if (it == "/raids/pending") reads++ }, pendingPollMs = { 20L }) { _, _ ->
            posts++; if (posts == 1) throw IOException("lost acknowledgement") else throw refusal
        }
        val create = uncertainCreate(coordinator)
        reads = 0
        val observing = launch { coordinator.runForeground() }
        try {
            withTimeout(2_000) { while (reads < 3) delay(5) }
            val before = reads
            assertSame(refusal, runCatching { coordinator.retry(create.id) }.exceptionOrNull())
            assertNull(store.get("wallet", "deed"))
            delay(100)
            val settled = reads
            assertTrue("Only a cadence read already due and the retry's own wake may follow the refusal, got ${settled - before}", settled - before <= 2)
            delay(300)
            assertEquals("Nothing is saved, so there is nothing to poll for: the reader waits for a wake instead of re-reading", settled, reads)
            assertEquals(BattlePhase.EMPTY, coordinator.state.value.phase)
            assertEquals(2, posts)
        } finally { observing.cancelAndJoin() }
    }

    @Test fun `discard forgets only the exact unconfirmed create and never sends`() = runBlocking {
        val release = CompletableDeferred<Unit>(); var posts = 0
        val coordinator = makeCoordinator { _, _ -> posts++; if (posts > 1) release.await(); throw IOException("lost acknowledgement") }
        val id = uncertainCreate(coordinator).id
        val original = requireNotNull(store.get("wallet", "deed"))
        assertTrue("Only the exact saved key can be discarded", runCatching { coordinator.discardCreate("request-99") }.isFailure)
        assertEquals(original, store.get("wallet", "deed"))
        val retrying = launch { runCatching { coordinator.retry(id) } }
        withTimeout(2_000) { coordinator.state.first { id in it.inFlight } }
        assertTrue("A request on the wire may still be acknowledged; its key cannot be forgotten mid-flight", runCatching { coordinator.discardCreate(id) }.isFailure)
        assertEquals(original, store.get("wallet", "deed"))
        release.complete(Unit); retrying.join()
        assertEquals(2, posts)
        coordinator.discardCreate(id)
        assertNull("The player's confirmed choice forgets the key on this device", store.get("wallet", "deed"))
        assertEquals(BattlePhase.EMPTY, coordinator.state.value.phase); assertNull(coordinator.state.value.pending)
        assertEquals("Discarding sends nothing: the server's pending list stays the ground truth", 2, posts)
        store.put(PendingBattle("wallet", "deed", raidId = raid, stage = 1))
        val acknowledged = makeCoordinator { _, _ -> error("no post") }
        assertTrue("An acknowledged raid is resumed from the server, never discarded", runCatching { acknowledged.discardCreate(id) }.isFailure)
        assertEquals(raid, store.get("wallet", "deed")?.raidId)
    }
}
