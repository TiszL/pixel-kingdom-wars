package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.*
import java.io.IOException
import java.time.Instant
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Synthetic server policy tests session and original-receipt boundaries, not actual earning or device QA. */
class OrdinaryCraftingRepositoryTest {
    private val key = "00000000-0000-4000-8000-000000000002"
    private val now = "2026-09-22T12:00:00.000Z"
    private val pairs = listOf("frostglass" to "frost_quartz", "heartwood_beams" to "heartwood_logs",
        "sunstone_blocks" to "sunstone_rubble", "crownsteel" to "crown_iron_ore", "prismstone_lens" to "rough_prism",
        "stormalloy" to "storm_ore", "thornsilk" to "thorn_fibre", "embercore" to "ember_nodules")
    private val recipes = pairs.map { (output, input) -> OrdinaryCraftingRecipe(2, "refine_" + output, 1, 17,
        listOf(OrdinaryCraftingInput("raw", input, "13")), OrdinaryCraftingOutput(output, "3")) } +
        OrdinaryCraftingRecipe(2, "craft_navigation_kit", 1, 23, listOf(OrdinaryCraftingInput("crafting", "prismstone_lens", "2"),
            OrdinaryCraftingInput("crafting", "frostglass", "4")), OrdinaryCraftingOutput("navigation_kit", "1")) + listOf(
            OrdinaryCraftingRecipe(2, "craft_climate_kit", 1, 29, listOf(OrdinaryCraftingInput("crafting", "sunstone_blocks", "3"), OrdinaryCraftingInput("crafting", "embercore", "4")), OrdinaryCraftingOutput("climate_kit", "1")),
            OrdinaryCraftingRecipe(2, "craft_expedition_kit", 1, 31, listOf(OrdinaryCraftingInput("crafting", "heartwood_beams", "2"), OrdinaryCraftingInput("crafting", "thornsilk", "3"), OrdinaryCraftingInput("shards", "shards", "7")), OrdinaryCraftingOutput("expedition_kit", "1")))
    private fun view() = OrdinaryCraftingView(WALLET, BASE_ID, OrdinaryCraftingFeatures(OrdinaryCraftingFeature(1, 1)),
        true, 2, 9, recipes, pairs.map { OrdinaryRawStock(it.second, "100", "5", "105") },
        (pairs.map { it.first } + listOf("navigation_kit", "climate_kit", "expedition_kit")).map { OrdinaryProtectedStock(it, "100", "0") }, emptyList(), now, catalogueVersion = 2, shardsAvailable = "100")
    private fun legacy(v: OrdinaryCraftingView = view()) = v.copy(recipeVersion = 1, catalogueVersion = null, shardsAvailable = null,
        recipes = v.recipes.filter { it.output.itemId !in setOf("climate_kit", "expedition_kit") }.map { it.copy(recipeVersion = 1) },
        craftingStock = v.craftingStock.filter { it.itemId !in setOf("climate_kit", "expedition_kit") })
    private inner class Fixture {
        val holder = testHolder(); val session = signedIn(holder); val wire = FakeApiClient(); val memory = MemoryStore()
        val store = OrdinaryCraftingStore(memory, OrdinaryCraftingIdentity(session.origin, "devnet", WALLET))
        var selected: String? = BASE_ID; var generation = 0L; var allowed = true; var v = view()
        var dir: BaseDirectory? = BaseDirectory(true, capabilities = BaseCapabilities(true, true), bases = listOf(BaseSummary(BASE_ID, "active", slot = 0)))
        var posts = 0; var currentReads = 0; var receiptReads = 0; var hydrates = 0; var accepted = false; var completed = false
        val catalogueQueries = mutableListOf<String?>()
        var published = false; var unsupported = false; var malformed = false
        var beforeEnqueue: () -> Unit = {}; var afterView: () -> Unit = {}; var afterProof: () -> Unit = {}
        var account: suspend () -> Unit = {}; var beforeHydration: () -> Unit = {}; var onPost: suspend () -> Unit = { accepted = true }
        var afterPostProof: () -> Unit = {}
        fun proof(): JsonObject {
            val c = store.read().let { it.operation?.command ?: it.archives.single().operation.command }
            val ready = Instant.parse(now).plusSeconds(c.recipe.durationSec).toString().replace("Z", ".000Z")
            val receipt = if (accepted) OrdinaryCraftingReceipt(c.key, c.recipe, now, ready, WALLET, c.request) else null
            return Json.encodeToJsonElement(OrdinaryCraftingProof(WALLET, c.key, if (completed) ready else now,
                if (accepted) "accepted" else "unknown", receipt, if (completed) OrdinaryCraftingCompletion(ready) else null)).jsonObject
        }
        val api = object : ApiClient by wire {
            override suspend fun getOrdinaryCrafting(path: String, query: Map<String, String>, guard: () -> Unit, evidence: ((JsonObject) -> Unit)?): JsonObject {
                guard()
                if (path == "/ordinary-crafting") {
                    currentReads++; catalogueQueries += query["catalogueVersion"]; assertEquals(BASE_ID, query["baseId"]); assertNull(evidence)
                    if (unsupported) throw ApiException(404, null, "route absent")
                    val raw = if (malformed) JsonObject(emptyMap()) else Json.encodeToJsonElement(if (query["catalogueVersion"] == null) legacy(v) else v).jsonObject
                    afterView(); return raw
                }
                receiptReads++; assertTrue(query.isEmpty()); assertEquals("/ordinary-crafting/jobs/by-key/" + key, path)
                return proof().also { afterProof(); requireNotNull(evidence)(it); holder.requireCurrent(session) }
            }
            override suspend fun postOrdinaryCrafting(path: String, body: JsonObject, guard: () -> Unit, evidence: (JsonObject) -> Unit, refusal: (ApiException) -> Unit): JsonObject {
                beforeEnqueue(); guard(); assertEquals("/ordinary-crafting/jobs", path)
                val saved = store.read(); val operation = requireNotNull(saved.operation)
                assertEquals(operation.command.request.body(), body)
                assertEquals(saved.revision, operation.attemptRevision); posts++
                try { onPost() } catch (error: ApiException) { refusal(error); holder.requireCurrent(session); throw error }
                return proof().also { evidence(it); afterPostProof(); holder.requireCurrent(session) }
            }
        }
        val repository = OrdinaryCraftingRepository(session, holder, api, store, { selected }, { generation }, { dir },
            { account() }, { guard -> hydrates++; beforeHydration(); guard(); published = true }, { allowed }, { key })
        suspend fun review(): OrdinaryCraftingReview { repository.reviewStart("refine_frostglass", 2); return requireNotNull(repository.state.value.review) }
    }
    private fun rejects(block: () -> Unit) { assertThrows(Exception::class.java) { block() } }

    @Test fun `server review persists exact resource totals then accepted start archives after guarded hydration`() = runBlocking<Unit> {
        val f = Fixture(); val r = f.review(); assertEquals("26", r.command.recipe.inputs.single().quantity)
        assertEquals("6", r.command.recipe.output.quantity); assertEquals(34L, r.command.recipe.durationSec)
        assertEquals(r.command, f.store.read().operation!!.command); assertEquals(0, f.posts)
        f.repository.confirm(r); assertEquals(1, f.posts); val frozen = f.store.read().operation!!.proof!!.receipt
        f.repository.finish(); assertTrue(f.published); assertEquals(1, f.hydrates); assertNull(f.store.read().operation)
        assertEquals(frozen, f.store.read().archives.single().operation.proof!!.receipt)
        assertEquals(OrdinaryCraftingHydration.CURRENT_ORIGINAL_BASE, f.repository.state.value.hydration)
    }
    @Test fun `foreground discovers only exact current ordinary view without creating or submitting an intent`() = runBlocking<Unit> {
        val f = Fixture(); f.repository.refresh(); assertTrue(f.repository.state.value.advertised)
        assertEquals(f.v, f.repository.state.value.view); assertEquals(1, f.currentReads); assertEquals(0, f.receiptReads)
        assertNull(f.store.read().operation); assertEquals(0, f.posts)
    }
    @Test fun `old malformed and foreign current views never advertise the feature or save commands`() = runBlocking<Unit> {
        val old = Fixture(); old.unsupported = true; old.repository.refresh(); assertFalse(old.repository.state.value.advertised)
        for (wrong in listOf("malformed", "wallet", "base", "version")) {
            val f = Fixture()
            when (wrong) { "malformed" -> f.malformed = true; "wallet" -> f.v = f.v.copy(wallet = "11111111111111111111111111111111")
                "base" -> f.v = f.v.copy(baseId = key); else -> f.v = f.v.copy(features = OrdinaryCraftingFeatures(OrdinaryCraftingFeature(2, 1))) }
            rejects { runBlocking { f.repository.refresh() } }; assertFalse(f.repository.state.value.advertised)
            assertNull(f.repository.state.value.view); assertNull(f.store.read().operation); assertEquals(0, f.posts)
        }
    }
    @Test fun `raw and protected availability remain authoritative before a new review`() = runBlocking<Unit> {
        val f = Fixture(); f.v = f.v.copy(rawStock = f.v.rawStock.map { it.copy(available = "0", total = it.reserved) })
        rejects { runBlocking { f.review() } }; assertNull(f.store.read().operation)
        val navigation = Fixture(); navigation.v = navigation.v.copy(craftingStock = navigation.v.craftingStock.map { it.copy(available = "0") })
        rejects { runBlocking { navigation.repository.reviewStart("craft_navigation_kit", 1) } }; assertNull(navigation.store.read().operation)
    }
    @Test fun `changed recipe stock batch or admission after review cannot silently change consent`() = runBlocking<Unit> {
        for (reason in listOf("recipe", "stock", "batch", "paused")) {
            val f = Fixture(); val review = f.review()
            f.v = when (reason) { "recipe" -> f.v.copy(recipes = f.v.recipes.map { it.copy(durationSec = it.durationSec + 1) })
                "stock" -> f.v.copy(rawStock = f.v.rawStock.map { it.copy(available = "0", total = it.reserved) })
                "batch" -> f.v.copy(maxBatch = 1); else -> f.v.copy(acceptingJobs = false) }
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
        f.onPost = { throw ApiException(422, "INSUFFICIENT_RAW_STOCK", "retry refused") }
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
        assertEquals(OrdinaryCraftingHydration.ORIGINAL_BASE_UNAVAILABLE, f.repository.state.value.hydration)
        assertNull(f.store.read().operation); assertEquals(1, f.store.read().archives.size); assertEquals(1, f.posts)
    }
    @Test fun `accepted original is recovered before changed recipes can block saved review`() = runBlocking<Unit> {
        val f = Fixture(); f.review(); f.accepted = true; f.v = f.v.copy(acceptingJobs = false); f.selected = null
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
        val f = Fixture(); val review = f.review(); f.onPost = { throw ApiException(422, "INSUFFICIENT_RAW_STOCK", "first refusal") }
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
    @Test fun `accepted archive observes automatic completion without current base and refuses regression`() = runBlocking<Unit> {
        val f = Fixture(); f.repository.confirm(f.review()); f.repository.finish()
        val frozen = f.store.read().archives.single().operation.proof!!.receipt
        f.selected = null; f.allowed = false; f.completed = true; val reads = f.currentReads
        f.repository.checkArchived(key); assertEquals(reads, f.currentReads)
        assertEquals(frozen, f.store.read().archives.single().operation.proof!!.receipt)
        assertNotNull(f.store.read().archives.single().operation.proof!!.completion)
        f.completed = false; rejects { runBlocking { f.repository.checkArchived(key) } }
        assertNotNull(f.store.read().archives.single().operation.proof!!.completion); assertEquals(1, f.posts)
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
        var opens = 0; val stores = OrdinaryCraftingStores { _, _, _ -> opens++; MemoryStore() }
        val first = stores.forIdentity("https://GAME.test:443/", "devnet", WALLET)
        assertSame(first, stores.forIdentity("https://game.test", "devnet", WALLET)); assertEquals(1, opens)
        assertNotSame(first, stores.forIdentity("https://other.test", "devnet", WALLET))
        assertNotSame(first, stores.forIdentity("https://game.test", "mainnet-beta", WALLET))
        assertNotSame(first, stores.forIdentity("https://game.test", "devnet", "11111111111111111111111111111111"))
        for (origin in listOf("http://game.test", "https://game.test/path", "https://game.test/?query=x", "https://user@game.test"))
            rejects { stores.forIdentity(origin, "devnet", WALLET) }
        val corrupt = MemoryStore("{}"); rejects { OrdinaryCraftingStores { _, _, _ -> corrupt }.forIdentity("https://game.test", "devnet", WALLET) }
        assertEquals("{}", corrupt.read())
    }
    @Test fun `saved unknown recipe one requests original catalogue and resends only exact original`() = runBlocking<Unit> {
        val f = Fixture(); val old = OrdinaryCraftingCommand.review(f.store.identity, legacy(), key, "refine_frostglass", 2)
        f.memory.write(Json.encodeToString(OrdinaryCraftingJournal.serializer(), OrdinaryCraftingJournal(1, f.store.identity, 2, OrdinaryCraftingOperation(old, 2, null, null), emptyList())))
        f.repository.reviewSaved(); val review = requireNotNull(f.repository.state.value.review)
        assertEquals(old, review.command); assertEquals(listOf<String?>(null), f.catalogueQueries)
        f.repository.confirm(review); assertEquals(listOf<String?>(null, null), f.catalogueQueries)
        assertEquals(1, f.posts); assertEquals(old, f.store.read().operation!!.command)
        f.repository.finish(); assertEquals("2", f.catalogueQueries.last())
    }
    @Test fun `new kit review consumes server SHARDS ingredient and lost acknowledgment recovers unchanged`() = runBlocking<Unit> {
        val f = Fixture(); f.repository.reviewStart("craft_expedition_kit", 2)
        val review = requireNotNull(f.repository.state.value.review); assertEquals("14", review.command.recipe.inputs.last().quantity)
        assertEquals(listOf("2"), f.catalogueQueries)
        f.onPost = { f.accepted = true; throw IOException("lost after accepted") }
        rejects { runBlocking { f.repository.confirm(review) } }
        f.allowed = false; f.selected = null; f.repository.check()
        assertEquals(1, f.posts); assertEquals(review.command, OrdinaryCraftingStore(f.memory, f.store.identity).read().operation!!.command)
        assertNotNull(f.store.read().operation!!.proof)
        val poor = Fixture(); poor.v = poor.v.copy(shardsAvailable = "6")
        rejects { runBlocking { poor.repository.reviewStart("craft_expedition_kit", 1) } }; assertNull(poor.store.read().operation)
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
