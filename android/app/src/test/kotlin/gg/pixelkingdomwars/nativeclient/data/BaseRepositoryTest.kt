package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.audio.*
import kotlinx.coroutines.withContext
import gg.pixelkingdomwars.nativeclient.model.LayoutPosition
import gg.pixelkingdomwars.nativeclient.network.ApiException
import gg.pixelkingdomwars.nativeclient.network.SessionSupersededException
import gg.pixelkingdomwars.nativeclient.network.string
import gg.pixelkingdomwars.nativeclient.ops.*
import java.io.IOException
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Home reads, construction through the money op, and the session publish rule. */
class BaseRepositoryTest {
    private class Fixture(legacyConstruction: String? = null, catalogue: JsonObject? = null) {
        val api = FakeApiClient()
        val holder = testHolder()
        val session = signedIn(holder)
        val memory = MemoryStore()
        val intents = PendingIntentStore(memory, LegacyPendingStores(construction = MemoryStore(legacyConstruction)))
        val observer = ReceiptObserver(intents)
        var keys = 0
        var selectedBaseId = BASE_ID
        val repository = LiveBaseRepository(session, holder, api, intents, observer, { selectedBaseId }, newKey = { "key-${++keys}-0000" }, catalogue = { catalogue })
        init {
            api.onGet("/base") { baseJson() }; api.onGet("/balances") { balancesJson() }; api.onGet("/tutorial") { tutorialJson() }
        }
    }

    @Test fun `plot2 placement fails closed without matching content and journals geometry before signed POST`() = runBlocking {
        val policy = Json.parseToJsonElement(gg.pixelkingdomwars.nativeclient.model.PlotGeometry::class.java.classLoader!!.getResource("plot-geometry.json")!!.readText())
        val c = buildJsonObject { put("constants",buildJsonObject { put("PLOT_GEOMETRY",policy) }) }
        val expanded = JsonObject(baseJson() + ("plotVersion" to JsonPrimitive(2)))
        for (version in listOf(2,3)) {
            val missing = Fixture(); missing.api.onGet("/base") { JsonObject(expanded + ("plotVersion" to JsonPrimitive(version))) }
            missing.repository.refresh()
            assertTrue(runCatching { missing.repository.place("mine",-10,39) }.isFailure)
            assertTrue(missing.api.posts.isEmpty()); assertNull(missing.repository.construction.pending(WALLET))
        }
        val f = Fixture(catalogue=c);f.api.onGet("/base") { expanded };f.repository.refresh()
        var posted=false
        f.api.onPost("/base/buildings") { body ->
            val saved=requireNotNull(f.repository.construction.pending(WALLET))
            assertEquals(body,saved.body)
            assertEquals(-10,body.getValue("tx").jsonPrimitive.int)
            assertEquals(gg.pixelkingdomwars.nativeclient.model.PlotGeometry.supported(2).json,saved.quote!!.getValue("plotGeometry"))
            posted=true;throw IOException("receipt delayed")
        }
        assertTrue(runCatching { f.repository.place("mine",-10,39) }.isFailure)
        assertTrue(posted)
        assertEquals("-10",ConstructionSpec.receiptRequest(requireNotNull(f.repository.construction.pending(WALLET)))!!.query["tx"])
    }
    @Test fun `refresh reads base then balances pinned to the resolved base and keeps optional guidance optional`() = runBlocking {
        val f = Fixture()
        f.api.onGet("/tutorial") { throw ApiException(404, null, "No guidance") }
        f.repository.refresh()
        assertEquals(listOf("/base" to mapOf("baseId" to BASE_ID), "/balances" to mapOf("baseId" to BASE_ID), "/tutorial" to mapOf("baseId" to BASE_ID)), f.api.gets)
        val state = f.repository.state.value
        assertEquals("3520", state.balances!!.shards); assertNull(state.tutorial); assertEquals("crownlands", state.base!!.visualContext!!.realmId)
        assertFalse("The completed read releases its loading state", state.loading)
    }
    @Test fun `a different base answering the read is refused before balances are touched`() = runBlocking {
        val f = Fixture(); f.api.onGet("/base") { baseJson(baseId = "other") }
        assertThrows(IllegalStateException::class.java) { runBlocking { f.repository.refresh() } }
        assertEquals(1, f.api.gets.size); assertNull(f.repository.state.value.base)
        assertNotNull(f.repository.state.value.error)
        assertFalse("A refused read must allow another refresh", f.repository.state.value.loading)
    }
    @Test fun `late ordinary Home responses cannot replace a newer failure or end its loading`() = runBlocking {
        withTimeout(5_000) {
            for (oldFails in listOf(false, true)) for (finishNewFirst in listOf(false, true)) {
                val f = Fixture(); f.repository.refresh()
                val oldEntered = CompletableDeferred<Unit>(); val oldRelease = CompletableDeferred<Unit>()
                val newEntered = CompletableDeferred<Unit>(); val newRelease = CompletableDeferred<Unit>(); var reads = 0
                f.api.onGet("/balances") {
                    if (++reads == 1) {
                        oldEntered.complete(Unit); oldRelease.await()
                        if (oldFails) throw IOException("old connection failed")
                        balancesJson(shards = "111")
                    } else {
                        newEntered.complete(Unit); newRelease.await(); throw IOException("current connection failed")
                    }
                }
                val old = async { runCatching { f.repository.refresh() } }; oldEntered.await()
                val current = async { runCatching { f.repository.refresh() } }; newEntered.await()
                if (finishNewFirst) {
                    newRelease.complete(Unit); assertTrue(current.await().isFailure)
                    val currentState = f.repository.state.value
                    oldRelease.complete(Unit); assertTrue(old.await().isFailure)
                    assertSame("An older response cannot replace the current refusal", currentState, f.repository.state.value)
                } else {
                    oldRelease.complete(Unit); assertTrue(old.await().isFailure)
                    // Rewritten 2026-10-06 (owner "always loading"): both reads re-read the Home already shown, so neither
                    // raises the loading flag any more. The first-read case of this rule (an older read cannot end the
                    // current loading) is pinned by `an older first Home read cannot end the loading of the current one`.
                    assertFalse("A routine re-read over the shown Home never raises loading", f.repository.state.value.loading)
                    assertNull(f.repository.state.value.error); assertEquals("3520", f.repository.state.value.balances!!.shards)
                    newRelease.complete(Unit); assertTrue(current.await().isFailure)
                }
                assertEquals("current connection failed", f.repository.state.value.error)
                assertFalse(f.repository.state.value.loading); assertEquals("3520", f.repository.state.value.balances!!.shards)
                assertTrue(f.api.posts.isEmpty())
            }
        }
    }
    @Test fun `an older first Home read cannot end the loading of the current one`() = runBlocking {
        withTimeout(5_000) {
            val f = Fixture()
            val oldEntered = CompletableDeferred<Unit>(); val oldRelease = CompletableDeferred<Unit>()
            val newEntered = CompletableDeferred<Unit>(); val newRelease = CompletableDeferred<Unit>(); var reads = 0
            f.api.onGet("/balances") {
                if (++reads == 1) { oldEntered.complete(Unit); oldRelease.await(); balancesJson(shards = "111") }
                else { newEntered.complete(Unit); newRelease.await(); balancesJson() }
            }
            val old = async { runCatching { f.repository.refresh() } }; oldEntered.await()
            assertTrue("Nothing is drawn yet: the first read of a base raises loading", f.repository.state.value.loading)
            val current = async { runCatching { f.repository.refresh() } }; newEntered.await()
            oldRelease.complete(Unit); assertTrue(old.await().isFailure)
            assertTrue("An older response cannot release the current first read", f.repository.state.value.loading)
            assertNull("A superseded first read publishes nothing", f.repository.state.value.base)
            newRelease.complete(Unit); assertTrue(current.await().isSuccess)
            assertFalse(f.repository.state.value.loading); assertEquals("3520", f.repository.state.value.balances!!.shards)
        }
    }
    /** Owner 2026-10-06 "always loading": every Home door, building fact and Army price waited on this flag, and every
     * cadence tick, Quests read and post-acceptance HUD refresh raised it over a Home that was already drawn. */
    @Test fun `a routine re-read keeps the shown Home without raising loading until its answer replaces it`() = runBlocking {
        withTimeout(5_000) {
            val f = Fixture(); f.repository.refresh()
            val shown = f.repository.state.value
            val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
            f.api.onGet("/balances") { entered.complete(Unit); release.await(); balancesJson(shards = "4000") }
            val routine = async { f.repository.refresh() }; entered.await()
            val during = f.repository.state.value
            assertFalse("A routine re-read raises no loading flag", during.loading)
            assertSame("The shown base stays drawn while the re-read runs", shown.base, during.base)
            assertEquals("The shown balances stay until the answer", "3520", during.balances!!.shards)
            release.complete(Unit); routine.await()
            assertEquals("The answer replaces the Home in place", "4000", f.repository.state.value.balances!!.shards)
            assertFalse(f.repository.state.value.loading); assertNull(f.repository.state.value.error)
        }
    }
    @Test fun `quest and mining re-reads stay silent while a base switch still raises loading`() = runBlocking {
        withTimeout(5_000) {
            val f = Fixture(); f.repository.refresh()
            val questsEntered = CompletableDeferred<Unit>(); val questsRelease = CompletableDeferred<Unit>()
            f.api.onGet("/quests") { questsEntered.complete(Unit); questsRelease.await(); json("""{"day":1,"quests":[],"allThreeBonus":25}""") }
            val quests = async { f.repository.refreshQuests() }; questsEntered.await()
            assertFalse("Opening Quests re-reads the board without putting Home into loading", f.repository.state.value.loading)
            questsRelease.complete(Unit); quests.await()
            assertNotNull(f.repository.state.value.quests); assertFalse(f.repository.state.value.loading)
            val mineEntered = CompletableDeferred<Unit>(); val mineRelease = CompletableDeferred<Unit>()
            f.api.onGet("/mine/status") { mineEntered.complete(Unit); mineRelease.await(); json("""{"cache":{"claimable":false}}""") }
            val mine = async { f.repository.refreshMine() }; mineEntered.await()
            assertFalse("The mining cadence read is routine too", f.repository.state.value.loading)
            mineRelease.complete(Unit); mine.await()
            val other = "c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1"
            val switchEntered = CompletableDeferred<Unit>(); val switchRelease = CompletableDeferred<Unit>()
            f.api.onGet("/base") { switchEntered.complete(Unit); switchRelease.await(); baseJson(baseId = other) }
            f.selectedBaseId = other
            val switched = async { f.repository.refresh() }; switchEntered.await()
            assertTrue("Another kingdom is not drawn yet: a base switch raises loading", f.repository.state.value.loading)
            switchRelease.complete(Unit); switched.await()
            assertEquals(other, f.repository.state.value.base!!.baseId); assertFalse(f.repository.state.value.loading)
        }
    }
    @Test fun `session expiry during guidance propagates instead of publishing a half Home`() = runBlocking {
        val f = Fixture(); f.api.onGet("/tutorial") { throw ApiException(401, null, "expired") }
        assertEquals(401, (runCatching { f.repository.refresh() }.exceptionOrNull() as ApiException).status)
        assertNull(f.repository.state.value.base)
    }
    @Test fun `a superseded session cannot publish its late Home read`() = runBlocking {
        val f = Fixture()
        f.api.onGet("/balances") { signedIn(f.holder, "someone-else"); balancesJson() }
        assertThrows(SessionSupersededException::class.java) { runBlocking { f.repository.refresh() } }
        assertNull(f.repository.state.value.base)
    }
    @Test fun `placement persists the exact intent before the POST and hydrates before publishing`() = runBlocking {
        val f = Fixture(); val order = mutableListOf<String>()
        f.api.onPost("/base/buildings") { body ->
            order += "post"
            val saved = PendingIntentStore(MemoryStore(f.memory.value)).get(IntentKind.CONSTRUCTION, WALLET)
            assertNotNull("The intent is on disk before the POST", saved); assertTrue(saved!!.attempted); assertEquals(body, saved.body)
            assertEquals(json("""{"type":"mine","tx":3,"ty":4,"baseId":"$BASE_ID","idempotencyKey":"key-1-0000"}"""), body)
            buildJsonObject { put("building", buildJsonObject { put("id", "new") }) }
        }
        f.api.onGet("/base") { order += "hydrate"; baseJson() }
        f.repository.place("mine", 3, 4)
        assertEquals(listOf("post", "hydrate"), order)
        assertEquals("Build mine accepted", f.repository.state.value.message)
        assertNull(f.intents.get(IntentKind.CONSTRUCTION, WALLET)); assertTrue(f.observer.interrupted.value.isEmpty())
    }
    @Test fun `a base switch cannot retire an accepted unlock by hydrating the newly selected base`() = runBlocking {
        val f = Fixture()
        val other = "00000000-0000-4000-8000-000000000099"
        f.api.onPost(LayoutUnlockSpec.PATH) {
            f.selectedBaseId = other
            json("""{"baseId":"$BASE_ID","slot":"FARM","locked":false,"chargedShards":"500","balanceShards":"3020"}""")
        }
        assertThrows(IllegalStateException::class.java) { runBlocking { f.repository.unlockFarmLayout() } }
        assertNotNull("Keep the proof until the original base is hydrated", f.intents.get(IntentKind.LAYOUT_UNLOCK, WALLET)!!.receipt)
        assertTrue(f.api.gets.isEmpty())
        assertThrows(IllegalStateException::class.java) { runBlocking { f.observer.check(IntentKind.LAYOUT_UNLOCK, WALLET) } }
        assertNotNull(f.intents.get(IntentKind.LAYOUT_UNLOCK, WALLET))
        f.selectedBaseId = BASE_ID
        assertTrue(f.observer.check(IntentKind.LAYOUT_UNLOCK, WALLET) is Receipt.Accepted)
        assertNull(f.intents.get(IntentKind.LAYOUT_UNLOCK, WALLET))
        assertEquals("Receipt recovery must never purchase again", 1, f.api.posts.size)
        assertEquals(BASE_ID, f.repository.state.value.base!!.baseId)
    }
    @Test fun `a base switch during hydration cannot publish the previous bases balance`() = runBlocking {
        val f = Fixture()
        f.api.onGet("/balances") { f.selectedBaseId = "other"; balancesJson() }
        assertThrows(IllegalStateException::class.java) { runBlocking { f.repository.refresh() } }
        assertNull(f.repository.state.value.base)
        assertNull(f.repository.state.value.balances)
    }
    @Test fun `a lost placement reply keeps the intent and surfaces it as interrupted`() = runBlocking {
        val f = Fixture(); f.api.onPost("/base/buildings") { throw IOException("lost") }
        assertThrows(IOException::class.java) { runBlocking { f.repository.place("mine", 3, 4) } }
        val saved = requireNotNull(f.intents.get(IntentKind.CONSTRUCTION, WALLET)); assertTrue(saved.attempted)
        assertEquals(listOf(IntentKind.CONSTRUCTION), f.observer.interrupted.value.map { it.kind })
        // Observation is GET-only against the receipt route with the original query.
        f.api.onGet(ConstructionSpec.RECEIPT) { query -> assertEquals("key-1-0000", query["idempotencyKey"]); buildJsonObject { put("version", 1); put("status", "unknown"); put("idempotencyKey", "key-1-0000") } }
        assertEquals(Receipt.Unknown, f.observer.check(IntentKind.CONSTRUCTION, WALLET))
        assertEquals(1, f.api.posts.size)
        assertThrows("Unknown blocks new construction", IllegalStateException::class.java) { runBlocking { f.repository.upgrade("eee0575f-6df7-4672-91ea-33f497d2e1d6") } }
        assertEquals(1, f.api.posts.size)
    }
    @Test fun `a definitive rejection clears the intent so the player can order again`() = runBlocking {
        val f = Fixture(); f.api.onPost("/base/buildings") { throw ApiException(422, "INSUFFICIENT_SHARDS", "Not enough") }
        assertThrows(ApiException::class.java) { runBlocking { f.repository.place("mine", 3, 4) } }
        assertNull(f.intents.get(IntentKind.CONSTRUCTION, WALLET)); assertTrue(f.observer.interrupted.value.isEmpty())
    }
    @Test fun `a construction intent saved by the previous build is recovered from its legacy journal`() = runBlocking {
        val legacy = buildJsonObject { put("schemaVersion", 1); put("requests", buildJsonObject { put(WALLET, buildJsonObject {
            put("path", "/base/buildings"); put("label", "Build mine"); put("body", json("""{"type":"mine","tx":1,"ty":2,"baseId":"$BASE_ID","idempotencyKey":"legacy-key-1"}"""))
        }) }) }.toString()
        val f = Fixture(legacyConstruction = legacy)
        f.observer.refresh(WALLET)
        assertEquals("legacy-key-1", f.observer.interrupted.value.single().intent.idempotencyKey)
        f.api.onGet(ConstructionSpec.RECEIPT) { query ->
            assertEquals("legacy-key-1", query["idempotencyKey"])
            buildJsonObject { put("version", 1); put("status", "accepted"); put("request", json("""{"type":"mine","tx":1,"ty":2,"baseId":"$BASE_ID","idempotencyKey":"legacy-key-1"}"""))
                put("baseId", BASE_ID); put("receiptId", "00000000-0000-4000-8000-000000000002"); put("acceptedAt", "2026-09-10T00:00:00.000Z")
                put("funding", buildJsonObject { put("currency", "SHARDS"); put("amount", "150") }) }
        }
        val accepted = f.observer.check(IntentKind.CONSTRUCTION, WALLET) as Receipt.Accepted
        assertEquals("150", (accepted.value as ConstructionAcceptance).funding!!.amount)
        assertTrue("Acceptance hydrated Home before retiring", f.api.gets.any { it.first == "/base" })
        assertTrue(f.observer.interrupted.value.isEmpty()); assertTrue(f.api.posts.isEmpty())
    }
    @Test fun `quest claims reconcile a lost reply by re-reading the board`() = runBlocking {
        val f = Fixture(); var claimed = false
        f.api.onGet("/quests") { json("""{"day":1,"quests":[{"id":"6e7259b2-65ae-4dc8-9c97-925555c2ba25","templateCode":"first_camp","completed":true,"claimed":$claimed,"rewardShards":15}],"allThreeBonus":25}""") }
        f.api.onPost("/quests/6e7259b2-65ae-4dc8-9c97-925555c2ba25/claim") { claimed = true; throw IOException("lost") }
        f.repository.claimQuest("6e7259b2-65ae-4dc8-9c97-925555c2ba25")
        assertTrue(f.repository.state.value.quests!!.quests.single().claimed); assertEquals(1, f.api.posts.size)
    }

    // --- M-A2 base parity: cancel, obstacles, repair, wall row, layouts, daily cache -------------------

    private val JOB = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1"
    private fun jobsJson(canCancel: Boolean = true) = """[{"id":"$JOB","kind":"upgrade","buildingId":"eee0575f-6df7-4672-91ea-33f497d2e1d6","obstacleId":null,"startedAt":"2026-09-11T00:00:00.000Z","finishesAt":"2026-09-11T01:00:00.000Z","finishCostKeep":"240","canCancel":$canCancel,"refundShards":"150"}]"""

    @Test fun `cancelling a running upgrade persists the key first hydrates then reports the server refund`() = runBlocking {
        val f = Fixture(); f.api.onGet("/base") { baseJson(jobs = jobsJson()) }; f.repository.refresh()
        val order = mutableListOf<String>()
        f.api.onPost("/base/jobs/$JOB/cancel") { body ->
            order += "post"
            assertEquals(json("""{"baseId":"$BASE_ID","idempotencyKey":"key-1-0000"}"""), body)
            assertTrue("The intent is on disk before the POST", PendingIntentStore(MemoryStore(f.memory.value)).get(IntentKind.CONSTRUCTION, WALLET)!!.attempted)
            f.api.onGet("/base") { order += "hydrate"; baseJson() }
            json("""{"id":"$JOB","buildingId":"eee0575f-6df7-4672-91ea-33f497d2e1d6","refundShards":"150","cancelledAt":"2026-09-11T00:10:00.000Z","replayed":false}""")
        }
        f.repository.cancelJob(JOB)
        assertEquals(listOf("post", "hydrate"), order)
        assertEquals("UPGRADE CANCELLED · +150 SHARDS", f.repository.state.value.message); assertNull(f.intents.get(IntentKind.CONSTRUCTION, WALLET))
    }
    @Test fun `cancelling a job that already finished is a definitive refusal that retires the key without a refund`() = runBlocking {
        val f = Fixture()
        f.api.onPost("/base/jobs/$JOB/cancel") { throw ApiException(409, "JOB_NOT_ACTIVE", "upgrade already finished or was cancelled") }
        val error = runCatching { f.repository.cancelJob(JOB) }.exceptionOrNull() as ApiException
        assertEquals("JOB_NOT_ACTIVE", error.code); assertEquals("upgrade already finished or was cancelled", f.repository.state.value.error)
        assertNull(f.intents.get(IntentKind.CONSTRUCTION, WALLET)); assertEquals(1, f.api.posts.size)
    }
    @Test fun `obstacle clears and trap repairs are construction money ops recovered by explicit retry`() = runBlocking {
        val f = Fixture()
        f.api.onPost("/base/obstacles/0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b/clear") { throw IOException("lost") }
        assertThrows(IOException::class.java) { runBlocking { f.repository.clearObstacle("0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b") } }
        val saved = requireNotNull(f.intents.get(IntentKind.CONSTRUCTION, WALLET))
        assertEquals("Clear obstacle", saved.label); assertTrue(f.observer.interrupted.value.single().retryable)
        assertThrows("An interrupted clear blocks a repair of the same kind", IllegalStateException::class.java) { runBlocking { f.repository.repairTrap("eee0575f-6df7-4672-91ea-33f497d2e1d6") } }
        f.api.onPost("/base/obstacles/0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b/clear") { json("""{"job":{"id":"j","kind":"clear_obstacle"}}""") }
        assertTrue(f.observer.retry(IntentKind.CONSTRUCTION, WALLET) is Receipt.Accepted)
        f.api.onPost("/base/buildings/eee0575f-6df7-4672-91ea-33f497d2e1d6/repair") { body -> assertEquals(BASE_ID, body.string("baseId")); json("""{"job":{"id":"r"}}""") }
        f.repository.repairTrap("eee0575f-6df7-4672-91ea-33f497d2e1d6")
        assertEquals("Repair trap accepted", f.repository.state.value.message)
    }
    private val WALL = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
    private fun wallQuote(total: String = "48", canAfford: Boolean = true) = json("""{"baseId":"$BASE_ID","selectedWallId":"$WALL","quoteId":"${"cd".repeat(32)}","keepLevel":2,
        "walls":[{"id":"$WALL","tx":5,"ty":5,"level":1,"targetLevel":2,"costShards":48,"excluded":null}],"totalCostShards":$total,"balanceShards":"3520","canAfford":$canAfford}""")
    @Test fun `a wall row purchase is the frozen quote by id hydrated before it is published`() = runBlocking {
        val f = Fixture()
        f.api.onPost("/base/walls/$WALL/upgrade-quote") { body -> assertEquals(json("""{"baseId":"$BASE_ID"}"""), body); wallQuote() }
        val quote = f.repository.quoteWallRow(WALL)
        assertEquals("48", quote.totalCostShards)
        val order = mutableListOf<String>()
        f.api.onPost("/base/walls/$WALL/upgrade-row") { body ->
            order += "post"; assertEquals(json("""{"baseId":"$BASE_ID","idempotencyKey":"key-1-0000","quoteId":"${"cd".repeat(32)}"}"""), body)
            f.api.onGet("/base") { order += "hydrate"; baseJson() }
            json("""{"upgraded":[{"id":"$WALL","level":2}],"costShards":48,"duplicate":false}""")
        }
        val outcome = f.repository.upgradeWallRow(quote) as WallRowOutcome.Upgraded
        assertEquals(listOf("post", "hydrate"), order); assertEquals("48", outcome.acceptance.costShards); assertEquals("ROW UPGRADED", f.repository.state.value.message)
        assertNull(f.intents.get(IntentKind.WALL_ROW, WALLET))
    }
    @Test fun `a re-priced wall row answers with the replacement quote and no purchase and a lost reply keeps the key`() = runBlocking<Unit> {
        val f = Fixture(); f.api.onPost("/base/walls/$WALL/upgrade-quote") { wallQuote() }
        val quote = f.repository.quoteWallRow(WALL)
        f.api.onPost("/base/walls/$WALL/upgrade-row") { throw ApiException(409, "WALL_ROW_FUNDS_CHANGED", "Not enough SHARDS for the whole quoted row.", details = buildJsonObject { put("quote", wallQuote(canAfford = false)) }) }
        val repriced = f.repository.upgradeWallRow(quote) as WallRowOutcome.Repriced
        assertFalse(repriced.quote.canAfford); assertEquals("Not enough SHARDS for the whole quoted row.", repriced.message)
        assertNull("A re-priced refusal proves nothing was bought", f.intents.get(IntentKind.WALL_ROW, WALLET)); assertNull(f.repository.state.value.error)
        f.api.onPost("/base/walls/$WALL/upgrade-row") { throw IOException("lost") }
        assertThrows(IOException::class.java) { runBlocking { f.repository.upgradeWallRow(quote) } }
        assertTrue(f.observer.blocks(IntentKind.WALL_ROW)); assertTrue(f.observer.interrupted.value.single().retryable)
        assertThrows("A second purchase waits for the saved key", IllegalStateException::class.java) { runBlocking { f.repository.upgradeWallRow(quote) } }
    }
    @Test fun `layouts are read saved and unlocked against the selected base with the etags the editor read`() = runBlocking {
        val f = Fixture()
        f.api.onGet("/base/layouts") { query -> assertEquals(BASE_ID, query["baseId"]); json("""{"baseId":"$BASE_ID","geometryVersion":1,"claim":{"min":8,"max":22,"size":14},"active":{"slot":null,"etag":"sha256:a"},
            "farmUnlock":{"locked":true,"costShards":500},"slots":[{"slot":"HOME","locked":false,"etag":"sha256:h","positions":[],"compatibility":"empty","unplacedBuildingIds":[],"removedBuildingIds":[]},{"slot":"FARM","locked":true,"etag":"sha256:f","positions":[],"compatibility":"empty","unplacedBuildingIds":[],"removedBuildingIds":[]}]}""") }
        val layouts = f.repository.refreshLayouts()
        assertTrue(layouts.slot("FARM")!!.locked); assertSame(layouts, f.repository.state.value.layouts)
        f.api.onPut("/base/layouts/HOME") { body ->
            assertEquals(json("""{"baseId":"$BASE_ID","geometryVersion":1,"mode":"save_apply","expectedSlotEtag":"sha256:h","expectedActiveEtag":"sha256:a","positions":[{"buildingId":"eee0575f-6df7-4672-91ea-33f497d2e1d6","tx":12,"ty":12}]}"""), body)
            json("""{"baseId":"$BASE_ID","slot":"HOME","geometryVersion":1,"slotEtag":"sha256:n","activeEtag":"sha256:m","activeSlot":"HOME","moved":1,"unchanged":0,"replayed":false}""")
        }
        val saved = f.repository.saveLayout("HOME", "save_apply", 1, "sha256:h", "sha256:a", listOf(LayoutPosition("eee0575f-6df7-4672-91ea-33f497d2e1d6", 12, 12)))
        assertEquals(1, saved.moved); assertTrue("Home was re-read after the apply", f.api.gets.count { it.first == "/base" } >= 1)
        f.api.onPost(LayoutUnlockSpec.PATH) { body -> assertEquals(BASE_ID, body.string("baseId")); assertEquals("key-1-0000", body.string("idempotencyKey")); json("""{"baseId":"$BASE_ID","slot":"FARM","locked":false,"chargedShards":"500","balanceShards":"3020"}""") }
        assertEquals("500", f.repository.unlockFarmLayout().chargedShards); assertNull(f.intents.get(IntentKind.LAYOUT_UNLOCK, WALLET))
    }
    @Test fun `mining copy follows the server amount and the daily cache reconciles a lost reply as claimed`() = runBlocking {
        val f = Fixture(); var claimable = true
        f.api.onGet("/mine/status") { json("""{"mining":{"accrued":0,"storageCap":500,"ratePerHour":20,"mineCount":1,"maxMines":2},"cache":{"streakDays":1,"currentDay":1,"cacheShards":100,"claimable":$claimable,"nextClaimAt":"2026-09-12T00:00:00.000Z"}}""") }
        f.api.onPost("/mine/collect") { json("""{"amount":"0"}""") }
        f.repository.collectMine(); assertEquals("NOTHING TO COLLECT YET", f.repository.state.value.message)
        f.api.onPost("/mine/collect") { json("""{"amount":"1250"}""") }
        f.repository.collectMine(); assertEquals("+1,250 SHARDS", f.repository.state.value.message)
        f.repository.refreshMine()
        f.api.onPost("/mine/claim") { json("""{"amount":"100","streakDays":2,"everCompletedWeek1":false}""") }
        f.repository.claimDailyCache(); assertEquals("+100 SHARDS CLAIMED", f.repository.state.value.message)
        f.api.onPost("/mine/claim") { claimable = false; throw IOException("lost") }
        f.repository.claimDailyCache()
        assertEquals("A cache no longer claimable after a lost reply was paid", "CLAIMED", f.repository.state.value.message); assertFalse(f.repository.state.value.mine!!.cache!!.claimable)
        assertEquals("Never resent", 2, f.api.posts.count { it.first == "/mine/claim" })
    }
    @Test fun `a refusal the funds sheet explains is not repeated as a base error`() = runBlocking {
        val f = Fixture(); f.api.onPost("/base/buildings/eee0575f-6df7-4672-91ea-33f497d2e1d6/upgrade") { throw ApiException(422, "INSUFFICIENT_SHARDS", "not enough shards") }
        assertThrows(ApiException::class.java) { runBlocking { f.repository.upgrade("eee0575f-6df7-4672-91ea-33f497d2e1d6") } }
        assertNull(f.repository.state.value.error)
        f.api.onPost("/base/buildings/eee0575f-6df7-4672-91ea-33f497d2e1d6/upgrade") { throw ApiException(422, null, "all builders are busy") }
        assertThrows(ApiException::class.java) { runBlocking { f.repository.upgrade("eee0575f-6df7-4672-91ea-33f497d2e1d6") } }
        assertEquals("all builders are busy", f.repository.state.value.error)
    }
    private fun Fixture.audio(): Pair<UiAudioScope, MutableList<UiAudioSound>> {
        val calls = mutableListOf<UiAudioSound>()
        val emitter = UiAudioEmitter { cue, _ -> calls += cue }; emitter.update(session, "pack", true)
        return emitter.scope(BASE_ID) { selectedBaseId }.also { it.active(true) } to calls
    }
    @Test fun `placement sound follows durable exact acceptance before hydration and recovery stays silent`() = runBlocking {
        val f = Fixture(); val (scope, sounds) = f.audio()
        f.api.onPost("/base/buildings") { json("""{"building":{"id":"new"}}""") }
        f.api.onGet("/base") {
            assertNotNull(f.intents.get(IntentKind.CONSTRUCTION, WALLET)!!.receipt)
            assertEquals(listOf(UiAudioCue.PLACE), sounds)
            throw IOException("hydration offline")
        }
        assertTrue(runCatching { withContext(scope.capture()!!) { f.repository.place("mine", 3, 4) } }.isFailure)
        assertEquals(listOf(UiAudioCue.PLACE), sounds)
        f.api.onGet("/base") { baseJson() }
        f.observer.check(IntentKind.CONSTRUCTION, WALLET)
        assertNull(f.intents.get(IntentKind.CONSTRUCTION, WALLET))
        assertEquals(1, f.api.posts.size); assertEquals(listOf(UiAudioCue.PLACE), sounds)
    }
    @Test fun `wall accepted placement owns clink and late Back base identity or mute owns no feedback`() = runBlocking {
        for (change in listOf("none", "back", "base", "identity", "pause")) {
            val f = Fixture(); val (scope, sounds) = f.audio()
            f.api.onPost("/base/buildings") {
                when (change) {
                    "back" -> scope.invalidate()
                    "base" -> f.selectedBaseId = "other"
                    "identity" -> signedIn(f.holder, "other-wallet")
                    "pause" -> { scope.active(false); scope.active(true) }
                }
                json("""{"building":{"id":"new"}}""")
            }
            runCatching { withContext(scope.capture()!!) { f.repository.place("wall", 3, 4) } }
            assertEquals(change, if (change == "none") listOf(UiAudioCue.WALL) else emptyList<UiAudioCue>(), sounds)
        }
    }
    @Test fun `unknown placement and first definitive refusal never emit success or duplicate globally handled errors`() = runBlocking {
        for (code in listOf("unknown", "refusal", "global")) {
            val f = Fixture(); val (scope, sounds) = f.audio()
            f.api.onPost("/base/buildings") { when (code) {
                "unknown" -> throw IOException("lost reply")
                "global" -> throw ApiException(422, "INSUFFICIENT_SHARDS", "funds")
                else -> throw ApiException(422, "BUILDERS_BUSY", "busy")
            } }
            assertTrue(runCatching { withContext(scope.capture()!!) { f.repository.place("mine", 3, 4) } }.isFailure)
            assertEquals(code, if (code == "global") emptyList<UiAudioCue>() else listOf(UiAudioCue.ERROR), sounds)
            assertEquals(code == "unknown", f.intents.get(IntentKind.CONSTRUCTION, WALLET) != null)
        }
    }
    @Test fun `mining uses acknowledged amount and daily claim status reconciliation cannot create a chime`() = runBlocking {
        val f = Fixture(); val (scope, sounds) = f.audio(); var claimable = true
        f.api.onGet("/mine/status") { json("""{"cache":{"claimable":$claimable}}""") }
        f.repository.refreshMine()
        for ((amount, cue) in listOf("0" to UiAudioCue.TAP, "25" to UiAudioCue.CONFIRM)) {
            f.api.onPost("/mine/collect") { json("""{"amount":"$amount"}""") }
            withContext(scope.capture()!!) { f.repository.collectMine() }
            assertEquals(cue, sounds.last())
        }
        f.api.onPost("/mine/claim") { json("""{"amount":"100","streakDays":2,"everCompletedWeek1":false}""") }
        withContext(scope.capture()!!) { f.repository.claimDailyCache() }
        assertEquals(listOf(UiAudioCue.CLAIM, UiAudioCue.COINS), sounds.takeLast(2))
        val count = sounds.size
        f.api.onPost("/mine/claim") { claimable = false; throw IOException("lost") }
        withContext(scope.capture()!!) { f.repository.claimDailyCache() }
        assertEquals(count, sounds.size); assertEquals("CLAIMED", f.repository.state.value.message)
    }
    @Test fun `quest direct acknowledgement sounds while already claimed and lost reply board recovery stay silent`() = runBlocking {
        for (mode in listOf("direct", "already", "recovered")) {
            val f = Fixture(); val (scope, sounds) = f.audio(); var claimed = mode == "already"
            val id = "00000000-0000-4000-8000-000000000077"
            f.api.onGet("/quests") { json("""{"quests":[{"id":"$id","completed":true,"claimed":$claimed}]}""") }
            f.api.onPost("/quests/$id/claim") {
                claimed = true
                if (mode == "recovered") throw IOException("lost")
                json("""{"ok":true}""")
            }
            withContext(scope.capture()!!) { f.repository.claimQuest(id) }
            assertEquals(mode, if (mode == "direct") listOf(UiAudioCue.QUEST) else emptyList<UiAudioCue>(), sounds)
            assertEquals(if (mode == "already") 0 else 1, f.api.posts.size)
        }
    }

    @Test fun `older Home balance read cannot restore preclaim KEEP after accepted claim refresh`() = runBlocking {
        val f = Fixture(); val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>(); var reads = 0
        f.api.onGet("/balances") {
            if (++reads == 1) { entered.complete(Unit); release.await(); balancesJson(keep = "100") }
            else balancesJson(keep = "877")
        }
        val old = async { f.repository.refresh() }; entered.await()
        f.repository.invalidateForgeBalance(); f.repository.refreshAfterForgeClaim()
        assertEquals("877", f.repository.state.value.balances!!.keep)
        release.complete(Unit)
        assertThrows(CancellationException::class.java) { runBlocking { old.await() } }
        assertEquals("877", f.repository.state.value.balances!!.keep)
        assertFalse(f.repository.state.value.loading); assertNull(f.repository.state.value.error)
        assertTrue(f.api.posts.isEmpty())
    }

    @Test fun `Workshop publication rejects A B A selection during balances without changing Home state`() = runBlocking<Unit> {
        val f=Fixture();f.repository.refresh();val before=f.repository.state.value;var generation=0L
        f.api.onGet("/balances") {
            f.selectedBaseId="other";generation++;f.selectedBaseId=BASE_ID;generation++
            balancesJson(shards="777")
        }
        assertThrows(IllegalStateException::class.java) {runBlocking {
            f.repository.refreshForWorkshop {check(generation==0L)}
        }}
        assertSame("A later caller-side rejection cannot undo a stale HUD write",before,f.repository.state.value)
        assertTrue(f.api.posts.isEmpty())
    }
    @Test fun `Workshop lifecycle or session closure during balances cannot publish snapshot errors or loading`() = runBlocking<Unit> {
        for (reason in listOf("view","session")) {
            val f=Fixture();f.repository.refresh();val before=f.repository.state.value;var visible=true
            f.api.onGet("/balances") {
                if(reason=="view") visible=false else f.holder.replace(null)
                balancesJson(shards="777")
            }
            assertThrows(Exception::class.java) {runBlocking {f.repository.refreshForWorkshop {check(visible)}}}
            assertSame(reason,before,f.repository.state.value)
        }
    }
    @Test fun `Workshop refresh invalidates older ordinary Home read before loading accepted balances`() = runBlocking<Unit> {
        withTimeout(5_000) {
            val f=Fixture();val entered=CompletableDeferred<Unit>();val release=CompletableDeferred<Unit>();var reads=0
            f.api.onGet("/balances") {
                if(++reads==1){entered.complete(Unit);release.await();balancesJson(shards="100")}
                else balancesJson(shards="877")
            }
            val old=async {f.repository.refresh()};entered.await()
            f.repository.refreshForWorkshop {}
            assertEquals("877",f.repository.state.value.balances!!.shards);assertFalse(f.repository.state.value.loading)
            release.complete(Unit)
            assertTrue(runCatching {old.await()}.exceptionOrNull() is CancellationException)
            assertEquals("877",f.repository.state.value.balances!!.shards);assertNull(f.repository.state.value.error)
        }
    }
    @Test fun `newer guarded Workshop refresh wins when old snapshot returns late`() = runBlocking<Unit> {
        withTimeout(5_000) {
            val f=Fixture();val entered=CompletableDeferred<Unit>();val release=CompletableDeferred<Unit>();var reads=0
            f.api.onGet("/balances") {
                if(++reads==1){entered.complete(Unit);release.await();balancesJson(shards="100")}
                else balancesJson(shards="877")
            }
            val old=async {f.repository.refreshForWorkshop {}};entered.await()
            f.repository.refreshForWorkshop {};val current=f.repository.state.value
            release.complete(Unit)
            assertTrue(runCatching {old.await()}.exceptionOrNull() is CancellationException)
            assertSame(current,f.repository.state.value);assertEquals("877",current.balances!!.shards)
        }
    }
    @Test fun `closed Workshop publication guard cannot start Home reads or clear existing state`() = runBlocking<Unit> {
        val f=Fixture();val before=f.repository.state.value
        assertThrows(IllegalStateException::class.java) {runBlocking {f.repository.refreshForWorkshop {error("closed")}}}
        assertTrue(f.api.gets.isEmpty());assertSame(before,f.repository.state.value)
    }


    @Test fun `balance refresh revision changes before the first Home GET can publish`() = runBlocking {
        val f = Fixture(); f.repository.refresh()
        val before = requireNotNull(f.repository.balanceRevision)
        val oldBalance = f.repository.state.value.balances
        var atRead: Long? = null
        f.api.onGet("/base") {
            atRead = requireNotNull(f.repository.balanceRevision)
            assertTrue("Invalidate the old review before starting IO", atRead!! > before)
            assertSame("New balances have not arrived", oldBalance, f.repository.state.value.balances)
            baseJson()
        }
        f.repository.refreshWithoutJourneys()
        assertNotNull(atRead)
        assertTrue(requireNotNull(f.repository.balanceRevision) >= atRead!!)
        assertTrue(f.api.posts.isEmpty()); assertEquals(0, f.keys)
    }

    @Test fun `failed and equal-value Home refreshes never restore the old balance revision`() = runBlocking {
        val f = Fixture(); f.repository.refresh()
        val initial = requireNotNull(f.repository.balanceRevision)
        val old = f.repository.state.value.balances
        f.api.onGet("/base") {
            assertTrue(requireNotNull(f.repository.balanceRevision) > initial)
            throw IOException("synthetic read failure")
        }
        assertTrue(runCatching { f.repository.refresh() }.isFailure)
        val failed = requireNotNull(f.repository.balanceRevision)
        assertTrue(failed > initial); assertSame(old, f.repository.state.value.balances)
        f.api.onGet("/base") {
            assertTrue(requireNotNull(f.repository.balanceRevision) > failed)
            baseJson()
        }
        f.repository.refresh()
        assertEquals(old, f.repository.state.value.balances)
        assertTrue(requireNotNull(f.repository.balanceRevision) > failed)
        assertTrue(f.api.posts.isEmpty()); assertEquals(0, f.keys)
    }

    @Test fun `all guarded Home refresh entry points invalidate cost reviews at read start`() = runBlocking {
        val f = Fixture(); f.repository.refresh()
        val reads: List<Pair<String, suspend () -> Unit>> = listOf(
            "workshop" to { f.repository.refreshForWorkshop {} },
            "research" to { f.repository.refreshForResearch {} },
            "forge claim" to { f.repository.refreshAfterForgeClaim() },
        )
        for ((name, refresh) in reads) {
            val before = requireNotNull(f.repository.balanceRevision)
            var observed = false
            f.api.onGet("/base") {
                assertTrue(name, requireNotNull(f.repository.balanceRevision) > before)
                observed = true; baseJson()
            }
            refresh(); assertTrue(name, observed)
        }
        assertTrue(f.api.posts.isEmpty()); assertEquals(0, f.keys)
        assertNull(f.repository.construction.pending(WALLET))
    }

    @Test fun `explicit balance invalidation advances revision and unsupported repositories stay unknown`() = runBlocking {
        val f = Fixture(); f.repository.refresh()
        val before = requireNotNull(f.repository.balanceRevision)
        f.repository.invalidateForgeBalance()
        assertTrue(requireNotNull(f.repository.balanceRevision) > before)
        assertNull(f.repository.state.value.balances)
        assertTrue("An unsupported owner cannot provide a valid revision", FakeBaseRepository().balanceRevision < 0L)
        assertTrue(f.api.posts.isEmpty()); assertEquals(0, f.keys)
    }

    @Test fun `publishing equal balances advances revision again inside the Home publication`() = runBlocking {
        val f = Fixture(); f.repository.refresh()
        val before = f.repository.balanceRevision
        var started = before
        f.api.onGet("/balances") { started = f.repository.balanceRevision; assertTrue(started > before); balancesJson() }
        f.repository.refresh()
        assertTrue("Publication must fence even equal-value StateFlow suppression", f.repository.balanceRevision > started)
        assertTrue(f.api.posts.isEmpty()); assertEquals(0, f.keys)
    }
}
