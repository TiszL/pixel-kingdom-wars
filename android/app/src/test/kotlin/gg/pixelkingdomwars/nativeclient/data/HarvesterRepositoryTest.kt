package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.harvester.*
import gg.pixelkingdomwars.nativeclient.starter.StarterExpeditionHome
import java.time.Instant
import java.time.format.DateTimeFormatterBuilder
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.OrdinaryRawStock
import java.io.IOException
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Synthetic server policy tests account, consent and original-receipt boundaries; no device or real earning claim. */
class HarvesterRepositoryTest {
    private fun id(n: Int) = "00000000-0000-4000-8000-${n.toString().padStart(12, '0')}"
    private val key = id(2)
    private val now = "2026-09-22T12:00:00.000Z"
    private val format = DateTimeFormatterBuilder().appendInstant(3).toFormatter()
    private fun after(seconds: Long) = format.format(Instant.parse(now).plusSeconds(seconds))
    private val policy = HarvesterPolicy(1, 1, "99", "7", 17, 255, 1, 100, 30)
    private val facility = HarvesterFacility(BASE_ID, id(3), id(4), after(-1))
    private val realms = listOf("frost_quartz" to "frostveil", "heartwood_logs" to "elderwood", "sunstone_rubble" to "sunscar",
        "crown_iron_ore" to "crownlands", "rough_prism" to "seeker-reach", "storm_ore" to "stormcairn", "thorn_fibre" to "thornwake", "ember_nodules" to "cinderfall")
    private fun view() = HarvesterView(WALLET, BASE_ID, now, HarvesterFeatures(HarvesterFeature(1, 1)), true,
        StarterExpeditionHome("free_policy_preview", 1, "crownlands"), listOf(facility), null, null, policy,
        realms.map { OrdinaryRawStock(it.first, "9", "1", "10") })
    private fun head() = HarvesterSummary(id(8), id(9), id(10), policy.policyVersion, "crownlands", "crown_iron_ore", after(-100), after(-1))
    private inner class Fixture {
        val holder = testHolder(); val session = signedIn(holder); val wire = FakeApiClient(); val memory = MemoryStore()
        val store = HarvesterStore(memory, HarvesterIdentity(session.origin, "devnet", WALLET))
        var selected: String? = BASE_ID; var generation = 0L; var allowed = true; var v = view()
        var dir: BaseDirectory? = BaseDirectory(true, capabilities = BaseCapabilities(true, true), bases = listOf(BaseSummary(BASE_ID, "active", slot = 0)))
        var posts = 0; var currentReads = 0; var receiptReads = 0; var hydrates = 0; var accepted = false; var completed = false
        var published = false; var unsupported = false; var malformed = false
        var beforeEnqueue: () -> Unit = {}; var afterView: () -> Unit = {}; var afterProof: () -> Unit = {}
        var account: suspend () -> Unit = {}; var beforeHydration: () -> Unit = {}; var onPost: suspend () -> Unit = { accepted = true }
        var afterPostProof: () -> Unit = {}
        fun proof(): JsonObject {
            val c = store.read().let { it.operation?.command ?: it.archives.single().operation.command }
            val receipt = if (accepted) HarvesterReceipt(WALLET, c.request,
                HarvesterSource(c.key, c.request.baseId, c.request.harvesterId, c.policy.policyVersion, c.realmId,
                    realms.single { it.second == c.realmId }.first, now, after(c.policy.maxLeaseSec), c.facility.completedBuildJobId,
                    c.facility.harvesterCompletedAt, HarvesterTerm(id(6), "a".repeat(64), after(-60), after(3_600)), c.policy)) else null
            val event = HarvesterEvent(c.key, 1, "1", "crown_iron_ore", policy.policyVersion, after(policy.cadenceSec), after(policy.cadenceSec + 1),
                "2026-09-22T00:00:00.000Z", "7", "5", "2", policy.taxPolicyVersion, policy.taxBasisPoints, policy.islandPoolBps, "0", "10")
            val settlement = if (accepted) HarvesterSettlement(if (completed) listOf(event) else emptyList(),
                if (completed) HarvesterClosure(c.key, "custody_change", after(policy.cadenceSec + 1), 1) else null,
                if (completed) HarvesterCustodyStop(c.key, after(policy.cadenceSec + 1), after(policy.cadenceSec), "b".repeat(64)) else null) else null
            return Json.encodeToJsonElement(HarvesterProof(WALLET, c.key, after(policy.maxLeaseSec + 30),
                if (accepted) "accepted" else "unknown", receipt, settlement)).jsonObject
        }
        val api = object : ApiClient by wire {
            override suspend fun getHarvester(path: String, query: Map<String, String>, guard: () -> Unit, evidence: ((JsonObject) -> Unit)?): JsonObject {
                guard()
                if (path == "/harvesters") {
                    currentReads++; assertEquals(mapOf("baseId" to BASE_ID), query); assertNull(evidence)
                    if (unsupported) throw ApiException(404, null, "route absent")
                    val raw = if (malformed) JsonObject(emptyMap()) else Json.encodeToJsonElement(v).jsonObject
                    afterView(); return raw
                }
                receiptReads++; assertTrue(query.isEmpty()); assertEquals("/harvesters/sources/by-key/" + key, path)
                return proof().also { afterProof(); requireNotNull(evidence)(it); holder.requireCurrent(session) }
            }
            override suspend fun postHarvester(path: String, body: JsonObject, guard: () -> Unit, evidence: (JsonObject) -> Unit, refusal: (ApiException) -> Unit): JsonObject {
                beforeEnqueue(); guard(); assertEquals("/harvesters/sources", path)
                val saved = store.read(); val operation = requireNotNull(saved.operation)
                assertEquals(operation.command.request.body(), body)
                assertEquals(saved.revision, operation.attemptRevision); posts++
                // Model the adapter's already-owned bounded body, including proof retention before cancellation.
                return withContext(NonCancellable) {
                    try { onPost() } catch (error: ApiException) { refusal(error); holder.requireCurrent(session); throw error }
                    proof().also { evidence(it); afterPostProof(); holder.requireCurrent(session) }
                }
            }
        }
        val repository = HarvesterRepository(session, holder, api, store, { selected }, { generation }, { dir },
            { account() }, { guard -> hydrates++; beforeHydration(); guard(); published = true }, { allowed }, { key })
        suspend fun review(): HarvesterReview { repository.reviewSelection(facility.harvesterId); return requireNotNull(repository.state.value.review) }
    }
    private fun rejects(block: () -> Unit) { assertThrows(Exception::class.java) { block() } }

    @Test fun `server review persists exact original terms then accepted proof archives after guarded hydration`() = runBlocking<Unit> {
        val f = Fixture(); val r = f.review(); assertEquals(policy, r.command.policy); assertEquals(facility, r.command.facility)
        assertNull(r.command.request.expectedSourceId); assertNull(r.command.replacedSource)
        assertEquals(r.command, f.store.read().operation!!.command); assertEquals(0, f.posts)
        f.repository.confirm(r); assertEquals(1, f.posts); val frozen = f.store.read().operation!!.proof!!.originalReceipt
        f.repository.finish(); assertTrue(f.published); assertEquals(1, f.hydrates); assertNull(f.store.read().operation)
        assertEquals(frozen, f.store.read().archives.single().operation.proof!!.originalReceipt)
        assertEquals(HarvesterHydration.CURRENT_ORIGINAL_BASE, f.repository.state.value.hydration)
    }
    @Test fun `foreground discovers exact Harvester view without creating or submitting an intent`() = runBlocking<Unit> {
        val f = Fixture(); f.repository.refresh(); assertTrue(f.repository.state.value.advertised)
        assertEquals(f.v, f.repository.state.value.view); assertEquals(1, f.currentReads); assertEquals(0, f.receiptReads)
        assertNull(f.store.read().operation); assertEquals(0, f.posts)
    }
    @Test fun `old malformed and foreign current views never advertise the feature or save commands`() = runBlocking<Unit> {
        val old = Fixture(); old.unsupported = true; old.repository.refresh(); assertFalse(old.repository.state.value.advertised)
        for (wrong in listOf("malformed", "wallet", "base", "version")) {
            val f = Fixture()
            when (wrong) { "malformed" -> f.malformed = true; "wallet" -> f.v = f.v.copy(wallet = "11111111111111111111111111111111")
                "base" -> f.v = f.v.copy(baseId = key); else -> f.v = f.v.copy(features = HarvesterFeatures(HarvesterFeature(2, 1))) }
            rejects { runBlocking { f.repository.refresh() } }; assertFalse(f.repository.state.value.advertised)
            assertNull(f.repository.state.value.view); assertNull(f.store.read().operation); assertEquals(0, f.posts)
        }
    }
    @Test fun `server home positive completed facility and availability control new source review`() = runBlocking<Unit> {
        for (reason in listOf("paused", "home", "facility", "completion")) {
            val f = Fixture()
            f.v = when (reason) { "paused" -> f.v.copy(acceptingSelections = false)
                "home" -> f.v.copy(home = null); "facility" -> f.v.copy(facilities = emptyList())
                else -> f.v.copy(facilities = listOf(facility.copy(harvesterCompletedAt = after(1)))) }
            rejects { runBlocking { f.review() } }; assertNull(f.store.read().operation); assertEquals(0, f.posts)
        }
    }
    @Test fun `changed full policy facility or selected source cannot silently change consent`() = runBlocking<Unit> {
        for (reason in listOf("cadence", "quantity", "version", "facility", "head", "paused")) {
            val f = Fixture(); val review = f.review()
            f.v = when (reason) { "cadence" -> f.v.copy(policy = policy.copy(cadenceSec = 19))
                "quantity" -> f.v.copy(policy = policy.copy(grossPerWalletUtcDay = "100"))
                "version" -> f.v.copy(policy = policy.copy(policyVersion = 2))
                "facility" -> f.v.copy(facilities = listOf(facility.copy(completedBuildJobId = id(9))))
                "head" -> f.v.copy(walletSource = head()); else -> f.v.copy(acceptingSelections = false) }
            rejects { runBlocking { f.repository.confirm(review) } }; assertEquals(0, f.posts)
            assertEquals(review.command, f.store.read().operation!!.command); assertNull(f.store.read().operation!!.attemptRevision)
        }
    }
    @Test fun `replacement consent freezes an expired retained head on another base until canonical closure`() = runBlocking<Unit> {
        val f = Fixture(); f.v = f.v.copy(walletSource = head()); val review = f.review()
        assertEquals(head(), review.command.replacedSource); assertEquals(head().sourceId, review.command.request.expectedSourceId)
        assertEquals(BASE_ID, review.command.request.baseId); assertEquals(0, f.posts)
        f.v = f.v.copy(walletSource = null)
        rejects { runBlocking { f.repository.confirm(review) } }; assertEquals(0, f.posts)
        assertEquals(head(), f.store.read().operation!!.command.replacedSource)
    }
    @Test fun `A B A selection during reads cannot publish a stale review`() = runBlocking<Unit> {
        val f = Fixture(); f.afterView = { f.generation += 2 }
        rejects { runBlocking { f.review() } }; assertNull(f.repository.state.value.review); assertNull(f.store.read().operation)
    }
    @Test fun `actual enqueue rechecks game gate screen session selection and current directory`() = runBlocking<Unit> {
        for (reason in listOf("gate", "screen", "session", "selection", "directory")) {
            val f = Fixture(); val review = f.review()
            f.beforeEnqueue = { when (reason) { "gate" -> f.allowed = false; "screen" -> f.repository.dismiss()
                "session" -> f.holder.replace(null); "selection" -> f.generation += 2; else -> f.dir = f.dir!!.copy(bases = emptyList()) } }
            rejects { runBlocking { f.repository.confirm(review) } }; assertEquals(0, f.posts)
            assertNotNull(f.store.read().operation!!.attemptRevision); assertNull(f.store.read().operation!!.proof)
        }
    }
    @Test fun `owned POST and GET acceptance survives session replacement without publishing into old screen`() = runBlocking<Unit> {
        for (post in listOf(true, false)) {
            val f = Fixture(); val review = f.review()
            if (post) { f.afterPostProof = { f.holder.replace(null) }; rejects { runBlocking { f.repository.confirm(review) } } }
            else { f.accepted = true; f.afterProof = { f.holder.replace(null) }; rejects { runBlocking { f.repository.check() } } }
            assertNotNull(f.store.read().operation!!.proof); assertNull(f.repository.state.value.journal.operation!!.proof)
            assertEquals(if (post) 1 else 0, f.posts)
        }
    }
    @Test fun `lost acknowledgement needs explicit same original review and later refusal cannot erase uncertainty`() = runBlocking<Unit> {
        val f = Fixture(); val review = f.review(); f.onPost = { throw IOException("lost") }
        rejects { runBlocking { f.repository.confirm(review) } }; f.repository.check(); assertEquals(1, f.posts)
        f.repository.reviewSaved(); assertEquals(review.command, f.repository.state.value.review!!.command)
        f.onPost = { throw ApiException(503, "HARVESTERS_DISABLED", "retry refused") }
        rejects { runBlocking { f.repository.confirm(requireNotNull(f.repository.state.value.review)) } }
        assertEquals(2, f.posts); assertNull(f.store.read().operation!!.refusal); assertEquals(review.command, f.store.read().operation!!.command)
        // Rewritten 2026-10-06 (dead-end audit): the uncertain original now closes after its fresh `unknown` receipt (owner:
        // no saved request may block play forever), but only as "unknown", never as a declined request, and sends nothing.
        f.repository.archiveDraftOrRefusal(); assertEquals("unknown", f.store.read().archives.single().reason); assertEquals(2, f.posts)
    }
    @Test fun `paused no-base recovery never reads current policy or another owner's inventory`() = runBlocking<Unit> {
        val f = Fixture(); val review = f.review(); f.repository.confirm(review)
        f.selected = null; f.generation++; f.dir = f.dir!!.copy(bases = emptyList()); f.allowed = false
        val currentReads = f.currentReads; f.repository.refresh(); f.repository.finish()
        assertEquals(currentReads, f.currentReads); assertEquals(0, f.hydrates); assertNull(f.repository.state.value.view)
        assertEquals(HarvesterHydration.ORIGINAL_BASE_UNAVAILABLE, f.repository.state.value.hydration)
        assertNull(f.store.read().operation); assertEquals(1, f.store.read().archives.size); assertEquals(1, f.posts)
    }
    @Test fun `accepted original is recovered before changed current facilities can block saved review`() = runBlocking<Unit> {
        val f = Fixture(); f.review(); f.accepted = true; f.v = f.v.copy(acceptingSelections = false); f.selected = null
        val reads = f.currentReads; f.repository.reviewSaved(); assertEquals(reads, f.currentReads)
        assertNull(f.repository.state.value.review); assertNotNull(f.store.read().operation!!.proof); assertEquals(0, f.posts)
    }
    @Test fun `confirm observes already accepted original before current ownership or game gate admission`() = runBlocking<Unit> {
        for (reason in listOf("gate", "owner", "selection")) {
            val f = Fixture(); val review = f.review(); f.accepted = true
            when (reason) { "gate" -> f.allowed = false; "owner" -> f.dir = f.dir!!.copy(bases = emptyList()); else -> { f.selected = null; f.generation++ } }
            val reads = f.currentReads; f.repository.confirm(review)
            assertNotNull(f.store.read().operation!!.proof); assertNull(f.repository.state.value.review)
            assertEquals(reads, f.currentReads); assertEquals(0, f.posts)
        }
    }
    @Test fun `later accepted proof takes precedence over retained refusal history during saved recovery`() = runBlocking<Unit> {
        val f = Fixture(); val review = f.review(); f.onPost = { throw ApiException(503, "HARVESTERS_DISABLED", "first refusal") }
        rejects { runBlocking { f.repository.confirm(review) } }; assertNotNull(f.store.read().operation!!.refusal)
        f.accepted = true; f.allowed = false; f.selected = null; val reads = f.currentReads
        f.repository.reviewSaved(); assertNotNull(f.store.read().operation!!.proof); assertNotNull(f.store.read().operation!!.refusal)
        assertNull(f.repository.state.value.review); assertEquals(reads, f.currentReads); assertEquals(1, f.posts)
    }
    @Test fun `unknown authority and failed hydration preserve accepted proof and its active journal`() = runBlocking<Unit> {
        for (fail in listOf("account", "hydrate", "directory")) {
            val f = Fixture(); f.repository.confirm(f.review())
            when (fail) { "account" -> f.account = { throw IOException("offline") }; "hydrate" -> f.beforeHydration = { throw IOException("snapshot unavailable") }; else -> f.dir = null }
            rejects { runBlocking { f.repository.finish() } }; assertNotNull(f.store.read().operation!!.proof)
            assertTrue(f.store.read().archives.isEmpty())
        }
    }
    @Test fun `snapshot publication checks original generation epoch session and authority before archive`() = runBlocking<Unit> {
        for (reason in listOf("base", "view", "session", "owner")) {
            val f = Fixture(); f.repository.confirm(f.review())
            f.beforeHydration = { when (reason) { "base" -> f.generation += 2; "view" -> f.repository.dismiss()
                "session" -> f.holder.replace(null); else -> f.dir = f.dir!!.copy(bases = emptyList()) } }
            rejects { runBlocking { f.repository.finish() } }; assertFalse(f.published)
            assertNotNull(f.store.read().operation!!.proof); assertTrue(f.store.read().archives.isEmpty())
        }
    }
    @Test fun `accepted archive observes earned events closure and custody stop without current base and refuses regression`() = runBlocking<Unit> {
        val f = Fixture(); f.repository.confirm(f.review()); f.repository.finish()
        val frozen = f.store.read().archives.single().operation.proof!!.originalReceipt
        f.selected = null; f.allowed = false; f.completed = true; val reads = f.currentReads
        f.repository.checkArchived(key); assertEquals(reads, f.currentReads)
        assertEquals(frozen, f.store.read().archives.single().operation.proof!!.originalReceipt)
        assertNotNull(f.store.read().archives.single().operation.proof!!.settlement!!.closure)
        f.completed = false; rejects { runBlocking { f.repository.checkArchived(key) } }
        assertNotNull(f.store.read().archives.single().operation.proof!!.settlement!!.closure); assertEquals(1, f.posts)
    }
    @Test fun `refresh saves original acceptance before a current account refresh can fail`() = runBlocking<Unit> {
        val f = Fixture(); f.review(); f.accepted = true
        f.account = { assertNotNull(f.store.read().operation!!.proof); throw IOException("Current authority unavailable") }
        val reads = f.currentReads
        rejects { runBlocking { f.repository.refresh() } }
        assertNotNull(f.store.read().operation!!.proof); assertEquals(reads, f.currentReads)
        assertNull(f.repository.state.value.view); assertEquals(0, f.posts)
    }
    @Test fun `hydrated current raw stock comes from authorized view and never cumulative earning receipts`() = runBlocking<Unit> {
        val f = Fixture(); f.repository.confirm(f.review()); f.completed = true
        f.v = f.v.copy(rawStock = f.v.rawStock.map { it.copy(available = "1", reserved = "1", total = "2") })
        f.repository.finish()
        assertTrue(f.published); assertEquals(1, f.posts)
        assertTrue(f.repository.state.value.view!!.rawStock.all { it.available == "1" && it.total == "2" })
        assertEquals("7", f.store.read().archives.single().operation.proof!!.settlement!!.events.single().grossQuantity)
    }
    @Test fun `screen dismissal keeps unsent original and explicit unknown archive is the only reset`() = runBlocking<Unit> {
        val f = Fixture(); val review = f.review(); f.repository.dismiss()
        rejects { runBlocking { f.repository.confirm(review) } }; assertEquals(review.command, f.store.read().operation!!.command)
        assertNull(f.store.read().operation!!.attemptRevision); f.repository.archiveDraftOrRefusal()
        assertNull(f.store.read().operation); assertEquals("unattempted", f.store.read().archives.single().reason); assertEquals(0, f.posts)
    }
    @Test fun `concurrent confirmation cannot dispatch a second POST while the original is in flight`() = runBlocking<Unit> {
        val f = Fixture(); val review = f.review(); val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
        f.onPost = { entered.complete(Unit); release.await(); f.accepted = true }
        coroutineScope {
            val first = async { f.repository.confirm(review) }; entered.await()
            rejects { runBlocking { f.repository.confirm(review) } }; release.complete(Unit); first.await()
        }
        assertEquals(1, f.posts); assertNotNull(f.store.read().operation!!.proof)
    }
    @Test fun `process stores share canonical identity across reauthentication and isolate origin cluster wallet`() {
        var opens = 0; val stores = HarvesterStores { _, _, _ -> opens++; MemoryStore() }
        val first = stores.forIdentity("https://GAME.test:443/", "devnet", WALLET)
        assertSame(first, stores.forIdentity("https://game.test", "devnet", WALLET)); assertEquals(1, opens)
        assertNotSame(first, stores.forIdentity("https://other.test", "devnet", WALLET))
        assertNotSame(first, stores.forIdentity("https://game.test", "mainnet-beta", WALLET))
        assertNotSame(first, stores.forIdentity("https://game.test", "devnet", "11111111111111111111111111111111"))
        for (origin in listOf("http://game.test", "https://game.test/path", "https://game.test/?query=x", "https://user@game.test"))
            rejects { stores.forIdentity(origin, "devnet", WALLET) }
        val corrupt = MemoryStore("{}"); rejects { HarvesterStores { _, _, _ -> corrupt }.forIdentity("https://game.test", "devnet", WALLET) }
        assertEquals("{}", corrupt.read())
    }
    @Test fun `foreground waits for cancelled owned response drain without resubmitting`() = runBlocking<Unit> {
        val f = Fixture(); val review = f.review(); val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
        f.onPost = { withContext(NonCancellable) { entered.complete(Unit); release.await(); f.accepted = true } }
        coroutineScope {
            val posting = launch { runCatching { f.repository.confirm(review) } }; entered.await()
            f.repository.dismiss(); posting.cancel()
            val idle = async { f.repository.awaitIdle() }; yield(); assertFalse(idle.isCompleted)
            release.complete(Unit); posting.join(); idle.await(); f.repository.check()
        }
        assertEquals(1, f.posts); assertNotNull(f.store.read().operation!!.proof)
    }
    @Test fun `reauthenticated repository shares the original request lock until old owned evidence is retained`() = runBlocking<Unit> {
        val f = Fixture(); val review = f.review(); val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
        f.onPost = { entered.complete(Unit); release.await(); f.accepted = true }
        coroutineScope {
            val posting = launch { runCatching { f.repository.confirm(review) } }; entered.await()
            val replacement = signedIn(f.holder)
            var replacementReads = 0
            val replacementApi = object : ApiClient by f.wire {
                override suspend fun getHarvester(path: String, query: Map<String, String>, guard: () -> Unit, evidence: ((JsonObject) -> Unit)?): JsonObject {
                    guard(); assertTrue(query.isEmpty()); replacementReads++
                    return f.proof().also { requireNotNull(evidence)(it); f.holder.requireCurrent(replacement) }
                }
            }
            val next = HarvesterRepository(replacement, f.holder, replacementApi, f.store, { null }, { f.generation }, { null },
                {}, { error("Historical recovery must not hydrate another session's inventory") }, { false }, { key })
            val checking = async { next.check() }; yield(); assertFalse(checking.isCompleted); assertEquals(0, replacementReads)
            release.complete(Unit); posting.join(); checking.await()
            assertNotNull(next.state.value.journal.operation!!.proof); assertNull(f.repository.state.value.journal.operation!!.proof)
            assertEquals(1, replacementReads); assertEquals(1, f.posts)
        }
    }
    @Test fun `queued foreground refresh atomically waits for admission without sending a mutation`() = runBlocking<Unit> {
        withTimeout(1_000) {
            val f = Fixture(); val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
            var firstAccountRead = true
            f.account = { if (firstAccountRead) { firstAccountRead = false; entered.complete(Unit); release.await() } }
            val first = async(start = CoroutineStart.UNDISPATCHED) { f.repository.refresh() }
            entered.await()
            val queued = async(start = CoroutineStart.UNDISPATCHED) { f.repository.refresh(waitForIdle = true) }
            assertFalse(queued.isCompleted); assertEquals(0, f.currentReads); assertEquals(0, f.posts)
            release.complete(Unit); first.await(); queued.await()
            assertEquals(2, f.currentReads); assertEquals(0, f.posts)
            assertFalse(f.repository.state.value.busy)
        }
    }

}
