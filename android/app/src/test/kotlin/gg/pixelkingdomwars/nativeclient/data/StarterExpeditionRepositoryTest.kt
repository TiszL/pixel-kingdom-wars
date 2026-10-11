package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.starter.*
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.OrdinaryRawStock
import java.io.IOException
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Synthetic server policy tests account, consent and original-receipt boundaries; no device or real earning claim. */
class StarterExpeditionRepositoryTest {
    private fun id(n: Int) = "00000000-0000-4000-8000-${n.toString().padStart(12, '0')}"
    private val key = id(2)
    private val now = "2026-09-22T12:00:00.000Z"
    private val ready = "2026-09-22T12:00:17.000Z"
    private val installed = StarterFleetInstallation(id(5), BASE_ID, id(3), "starter", id(4), now, now)
    private val realms = listOf("frost_quartz" to "frostveil", "heartwood_logs" to "elderwood", "sunstone_rubble" to "sunscar",
        "crown_iron_ore" to "crownlands", "rough_prism" to "seeker-reach", "storm_ore" to "stormcairn", "thorn_fibre" to "thornwake", "ember_nodules" to "cinderfall")
    private fun route(name: String, realm: String, resource: String) = StarterExpeditionRoute(2, 2, name, realm, resource, "starter", 17,
        "101", "77", "24", if (name.startsWith("common_")) StarterExpeditionAccess("starter_common", 1) else null)
    private fun view() = StarterExpeditionView(WALLET, BASE_ID, now, StarterExpeditionFeatures(StarterExpeditionFeature(1, 1)), true,
        StarterExpeditionHome("free_policy_preview", 1, "crownlands"),
        listOf("introduction", "coastal_survey", "long_survey").map { route(it, "crownlands", "crown_iron_ore") } +
            realms.map { (resource, realm) -> route("common_${realm.replace('-', '_')}", realm, resource) },
        installed, null, now, realms.map { OrdinaryRawStock(it.first, "9", "1", "10") })
    private inner class Fixture {
        val holder = testHolder(); val session = signedIn(holder); val wire = FakeApiClient(); val memory = MemoryStore()
        val store = StarterExpeditionStore(memory, StarterIdentity(session.origin, "devnet", WALLET))
        var selected: String? = BASE_ID; var generation = 0L; var allowed = true; var v = view()
        var dir: BaseDirectory? = BaseDirectory(true, capabilities = BaseCapabilities(true, true), bases = listOf(BaseSummary(BASE_ID, "active", slot = 0)))
        var posts = 0; var currentReads = 0; var receiptReads = 0; var hydrates = 0; var accepted = false; var completed = false
        var published = false; var unsupported = false; var malformed = false
        var beforeEnqueue: () -> Unit = {}; var afterView: () -> Unit = {}; var afterProof: () -> Unit = {}
        var account: suspend () -> Unit = {}; var beforeHydration: () -> Unit = {}; var onPost: suspend () -> Unit = { accepted = true }
        var afterPostProof: () -> Unit = {}
        fun proof(): JsonObject {
            val c = store.read().let { it.operation?.command ?: it.archives.single().operation.command }
            val receipt = if (accepted) StarterExpeditionReceipt(WALLET, c.request, c.key, c.installation.installationId,
                c.route, now, ready, id(6), "a".repeat(64)) else null
            return Json.encodeToJsonElement(StarterExpeditionProof(WALLET, c.key, if (completed) ready else now,
                if (accepted) "accepted" else "unknown", receipt, if (completed) StarterExpeditionReturn(id(7), ready) else null)).jsonObject
        }
        val api = object : ApiClient by wire {
            override suspend fun getStarterExpedition(path: String, query: Map<String, String>, guard: () -> Unit, evidence: ((JsonObject) -> Unit)?): JsonObject {
                guard()
                if (path == "/starter-expeditions") {
                    currentReads++; assertEquals(mapOf("baseId" to BASE_ID), query); assertNull(evidence)
                    if (unsupported) throw ApiException(404, null, "route absent")
                    val raw = if (malformed) JsonObject(emptyMap()) else Json.encodeToJsonElement(v).jsonObject
                    afterView(); return raw
                }
                receiptReads++; assertTrue(query.isEmpty()); assertEquals("/starter-expeditions/by-key/" + key, path)
                return proof().also { afterProof(); requireNotNull(evidence)(it); holder.requireCurrent(session) }
            }
            // The repository calls the departure-aware entry. Forward to THIS fake's body-only response;
            // delegation to wire bypasses its POST override. No fabricated 201/created evidence.
            override suspend fun postStarterExpeditionWithDeparture(path: String, body: JsonObject, guard: () -> Unit,
                evidence: (JsonObject) -> Unit, refusal: (ApiException) -> Unit,
                created: (gg.pixelkingdomwars.nativeclient.fleetjourney.FreshFleetDeparture) -> Unit): JsonObject =
                postStarterExpedition(path, body, guard, evidence, refusal)
            override suspend fun postStarterExpedition(path: String, body: JsonObject, guard: () -> Unit, evidence: (JsonObject) -> Unit, refusal: (ApiException) -> Unit): JsonObject {
                beforeEnqueue(); guard(); assertEquals("/starter-expeditions", path)
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
        val repository = StarterExpeditionRepository(session, holder, api, store, { selected }, { generation }, { dir },
            { account() }, { guard -> hydrates++; beforeHydration(); guard(); published = true }, { allowed }, { key })
        suspend fun review(): StarterExpeditionReview { repository.reviewDeparture("coastal_survey"); return requireNotNull(repository.state.value.review) }
    }
    private fun rejects(block: () -> Unit) { assertThrows(Exception::class.java) { block() } }

    /** Bound the fake's NonCancellable drain too: an outer test timeout alone cannot release that child. */
    private suspend fun <T> boundedWait(stage: String, block: suspend () -> T): T = try {
        withTimeout(5_000) { block() }
    } catch (error: TimeoutCancellationException) {
        throw AssertionError("Starter expedition fixture timed out waiting for $stage", error)
    }
    private suspend fun <T> Deferred<T>.awaitBounded(stage: String): T = boundedWait(stage) { await() }
    private suspend fun Job.joinBounded(stage: String) = boundedWait(stage) { join() }

    @Test fun `server review persists exact original terms then accepted proof archives after guarded hydration`() = runBlocking<Unit> {
        val f = Fixture(); val r = f.review(); assertEquals("101", r.command.route.grossQuantity); assertEquals("77", r.command.route.netQuantity)
        assertEquals("24", r.command.route.islandPoolQuantity); assertEquals(installed, r.command.installation)
        assertEquals(r.command, f.store.read().operation!!.command); assertEquals(0, f.posts)
        f.repository.confirm(r); assertEquals(1, f.posts); val frozen = f.store.read().operation!!.proof!!.receipt
        f.repository.finish(); assertTrue(f.published); assertEquals(1, f.hydrates); assertNull(f.store.read().operation)
        assertEquals(frozen, f.store.read().archives.single().operation.proof!!.receipt)
        assertEquals(StarterExpeditionHydration.CURRENT_ORIGINAL_BASE, f.repository.state.value.hydration)
    }
    @Test fun `foreground discovers exact starter view without creating or submitting an intent`() = runBlocking<Unit> {
        val f = Fixture(); f.repository.refresh(); assertTrue(f.repository.state.value.advertised)
        assertEquals(f.v, f.repository.state.value.view); assertEquals(1, f.currentReads); assertEquals(0, f.receiptReads)
        assertNull(f.store.read().operation); assertEquals(0, f.posts)
    }
    @Test fun `old malformed and foreign current views never advertise the feature or save commands`() = runBlocking<Unit> {
        val old = Fixture(); old.unsupported = true; old.repository.refresh(); assertFalse(old.repository.state.value.advertised)
        for (wrong in listOf("malformed", "wallet", "base", "version")) {
            val f = Fixture()
            when (wrong) { "malformed" -> f.malformed = true; "wallet" -> f.v = f.v.copy(wallet = "11111111111111111111111111111111")
                "base" -> f.v = f.v.copy(baseId = key); else -> f.v = f.v.copy(features = StarterExpeditionFeatures(StarterExpeditionFeature(2, 1))) }
            rejects { runBlocking { f.repository.refresh() } }; assertFalse(f.repository.state.value.advertised)
            assertNull(f.repository.state.value.view); assertNull(f.store.read().operation); assertEquals(0, f.posts)
        }
    }
    @Test fun `server home installation lodge and active flight control new departure admission`() = runBlocking<Unit> {
        for (reason in listOf("paused", "home", "installation", "lodge", "flight")) {
            val f = Fixture()
            f.v = when (reason) { "paused" -> f.v.copy(acceptingDepartures = false)
                "home" -> f.v.copy(home = null, routes = emptyList()); "installation" -> f.v.copy(installation = null)
                "lodge" -> f.v.copy(lodgeCompletedAt = null)
                else -> f.v.copy(flight = StarterExpeditionFlight(id(8), installed.installationId, f.v.routes.first(), now, ready, id(6), "a".repeat(64))) }
            rejects { runBlocking { f.review() } }; assertNull(f.store.read().operation); assertEquals(0, f.posts)
        }
    }
    @Test fun `changed full route installation or admission cannot silently change consent`() = runBlocking<Unit> {
        for (reason in listOf("duration", "quantity", "version", "installation", "paused")) {
            val f = Fixture(); val review = f.review()
            f.v = when (reason) { "duration" -> f.v.copy(routes = f.v.routes.map { it.copy(durationSec = 19) })
                "quantity" -> f.v.copy(routes = f.v.routes.map { it.copy(grossQuantity = "103", netQuantity = "79") })
                "version" -> f.v.copy(routes = f.v.routes.map { if (it.access == null) it.copy(rewardTableVersion = 3) else it })
                "installation" -> f.v.copy(installation = installed.copy(installationId = id(9))); else -> f.v.copy(acceptingDepartures = false) }
            rejects { runBlocking { f.repository.confirm(review) } }; assertEquals(0, f.posts)
            assertEquals(review.command, f.store.read().operation!!.command); assertNull(f.store.read().operation!!.attemptRevision)
        }
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
        f.onPost = { throw ApiException(503, "STARTER_EXPEDITIONS_DISABLED", "retry refused") }
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
        assertEquals(StarterExpeditionHydration.ORIGINAL_BASE_UNAVAILABLE, f.repository.state.value.hydration)
        assertNull(f.store.read().operation); assertEquals(1, f.store.read().archives.size); assertEquals(1, f.posts)
    }
    @Test fun `accepted original is recovered before changed current facilities can block saved review`() = runBlocking<Unit> {
        val f = Fixture(); f.review(); f.accepted = true; f.v = f.v.copy(acceptingDepartures = false); f.selected = null
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
        val f = Fixture(); val review = f.review(); f.onPost = { throw ApiException(503, "STARTER_EXPEDITIONS_DISABLED", "first refusal") }
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
    @Test fun `accepted archive observes automatic return without current base and refuses regression`() = runBlocking<Unit> {
        val f = Fixture(); f.repository.confirm(f.review()); f.repository.finish()
        val frozen = f.store.read().archives.single().operation.proof!!.receipt
        f.selected = null; f.allowed = false; f.completed = true; val reads = f.currentReads
        f.repository.checkArchived(key); assertEquals(reads, f.currentReads)
        assertEquals(frozen, f.store.read().archives.single().operation.proof!!.receipt)
        assertNotNull(f.store.read().archives.single().operation.proof!!.returned)
        f.completed = false; rejects { runBlocking { f.repository.checkArchived(key) } }
        assertNotNull(f.store.read().archives.single().operation.proof!!.returned); assertEquals(1, f.posts)
    }
    @Test fun `screen dismissal keeps unsent original and explicit unknown archive is the only reset`() = runBlocking<Unit> {
        val f = Fixture(); val review = f.review(); f.repository.dismiss()
        rejects { runBlocking { f.repository.confirm(review) } }; assertEquals(review.command, f.store.read().operation!!.command)
        assertNull(f.store.read().operation!!.attemptRevision); f.repository.archiveDraftOrRefusal()
        assertNull(f.store.read().operation); assertEquals("unattempted", f.store.read().archives.single().reason); assertEquals(0, f.posts)
    }
    @Test fun `concurrent confirmation cannot dispatch a second POST while the original is in flight`() = runBlocking<Unit> {
        val f = Fixture(); val review = f.review(); val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
        f.onPost = { entered.complete(Unit); release.awaitBounded("concurrent POST release"); f.accepted = true }
        coroutineScope {
            val first = async { f.repository.confirm(review) }; entered.awaitBounded("concurrent POST entry")
            rejects { runBlocking { f.repository.confirm(review) } }; release.complete(Unit); first.awaitBounded("first confirmation")
        }
        assertEquals(1, f.posts); assertNotNull(f.store.read().operation!!.proof)
    }
    @Test fun `process stores share canonical identity across reauthentication and isolate origin cluster wallet`() {
        var opens = 0; val stores = StarterExpeditionStores { _, _, _ -> opens++; MemoryStore() }
        val first = stores.forIdentity("https://GAME.test:443/", "devnet", WALLET)
        assertSame(first, stores.forIdentity("https://game.test", "devnet", WALLET)); assertEquals(1, opens)
        assertNotSame(first, stores.forIdentity("https://other.test", "devnet", WALLET))
        assertNotSame(first, stores.forIdentity("https://game.test", "mainnet-beta", WALLET))
        assertNotSame(first, stores.forIdentity("https://game.test", "devnet", "11111111111111111111111111111111"))
        for (origin in listOf("http://game.test", "https://game.test/path", "https://game.test/?query=x", "https://user@game.test"))
            rejects { stores.forIdentity(origin, "devnet", WALLET) }
        val corrupt = MemoryStore("{}"); rejects { StarterExpeditionStores { _, _, _ -> corrupt }.forIdentity("https://game.test", "devnet", WALLET) }
        assertEquals("{}", corrupt.read())
    }
    @Test fun `foreground waits for cancelled owned response drain without resubmitting`() = runBlocking<Unit> {
        val f = Fixture(); val review = f.review(); val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
        f.onPost = { withContext(NonCancellable) { entered.complete(Unit); release.awaitBounded("cancelled POST release"); f.accepted = true } }
        coroutineScope {
            val posting = launch { runCatching { f.repository.confirm(review) } }; entered.awaitBounded("cancelled POST entry")
            f.repository.dismiss(); posting.cancel()
            val idle = async { boundedWait("repository response drain") { f.repository.awaitIdle() } }; yield(); assertFalse(idle.isCompleted)
            release.complete(Unit); posting.joinBounded("cancelled POST completion"); idle.awaitBounded("foreground idle observation"); f.repository.check()
        }
        assertEquals(1, f.posts); assertNotNull(f.store.read().operation!!.proof)
    }
    @Test fun `reauthenticated repository shares the original request lock until old owned evidence is retained`() = runBlocking<Unit> {
        val f = Fixture(); val review = f.review(); val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
        f.onPost = { entered.complete(Unit); release.awaitBounded("reauthenticated POST release"); f.accepted = true }
        coroutineScope {
            val posting = launch { runCatching { f.repository.confirm(review) } }; entered.awaitBounded("reauthenticated POST entry")
            val replacement = signedIn(f.holder)
            var replacementReads = 0
            val replacementApi = object : ApiClient by f.wire {
                override suspend fun getStarterExpedition(path: String, query: Map<String, String>, guard: () -> Unit, evidence: ((JsonObject) -> Unit)?): JsonObject {
                    guard(); assertTrue(query.isEmpty()); replacementReads++
                    return f.proof().also { requireNotNull(evidence)(it); f.holder.requireCurrent(replacement) }
                }
            }
            val next = StarterExpeditionRepository(replacement, f.holder, replacementApi, f.store, { null }, { f.generation }, { null },
                {}, { error("Historical recovery must not hydrate another session's inventory") }, { false }, { key })
            val checking = async { next.check() }; yield(); assertFalse(checking.isCompleted); assertEquals(0, replacementReads)
            release.complete(Unit); posting.joinBounded("original POST completion"); checking.awaitBounded("replacement receipt check")
            assertNotNull(next.state.value.journal.operation!!.proof); assertNull(f.repository.state.value.journal.operation!!.proof)
            assertEquals(1, replacementReads); assertEquals(1, f.posts)
        }
    }
}
