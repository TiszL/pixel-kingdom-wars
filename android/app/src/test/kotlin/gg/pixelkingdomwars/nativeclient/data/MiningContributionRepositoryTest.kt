package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.miningcontribution.*
import java.io.IOException
import java.time.Instant
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Synthetic server policy tests session and original-receipt boundaries, not actual earning or device QA. */
class MiningContributionRepositoryTest {
    private val key = "00000000-0000-4000-8000-000000000002"
    private val now = "2026-09-22T12:00:00.000Z"
    private fun view() = MiningContributionView(WALLET, BASE_ID, 2, now.take(10), now, true, "free", "200", "0", "200", true,
        miningContributionResourceIds.map { MiningContributionStock(it, "100", "13") }, MiningConsistencyPolicy(3, 20, 60))
    private inner class Fixture {
        val holder = testHolder(); val session = signedIn(holder); val wire = FakeApiClient(); val memory = MemoryStore()
        val store = MiningContributionStore(memory, MiningContributionIdentity(session.origin, "devnet", WALLET))
        var selected: String? = BASE_ID; var generation = 0L; var allowed = true; var v = view()
        var dir: BaseDirectory? = BaseDirectory(true, capabilities = BaseCapabilities(true, true), bases = listOf(BaseSummary(BASE_ID, "active", slot = 0)))
        var posts = 0; var currentReads = 0; var receiptReads = 0; var hydrates = 0; var accepted = false; var completed = false
        var published = false; var unsupported = false; var malformed = false
        var beforeEnqueue: () -> Unit = {}; var afterView: () -> Unit = {}; var afterProof: () -> Unit = {}
        var account: suspend () -> Unit = {}; var beforeHydration: () -> Unit = {}; var onPost: suspend () -> Unit = { accepted = true }
        var afterPostProof: () -> Unit = {}
        fun proof(): JsonObject {
            val c = store.read().let { it.operation?.command ?: it.archives.single().operation.command }
            val receipt = if (accepted) MiningContributionReceipt(c.key, BASE_ID, WALLET, now.take(10), c.request, c.lines, c.totalValue, now) else null
            return Json.encodeToJsonElement(MiningContributionProof(WALLET, c.key, now,
                if (accepted) "accepted" else "unknown", receipt, if (completed) MiningContributionSettlement("consumed", now) else null)).jsonObject
        }

        val api = object : ApiClient by wire {
            override suspend fun getMiningContribution(path: String, query: Map<String, String>, guard: () -> Unit, evidence: ((JsonObject) -> Unit)?): JsonObject {
                guard()
                if (path == "/mining/contributions") {
                    currentReads++; assertEquals(mapOf("baseId" to BASE_ID, "catalogueVersion" to "3"), query); assertNull(evidence)
                    if (unsupported) throw ApiException(404, null, "route absent")
                    val raw = if (malformed) JsonObject(emptyMap()) else Json.encodeToJsonElement(v).jsonObject
                    afterView(); return raw
                }
                receiptReads++; assertTrue(query.isEmpty()); assertEquals("/mining/contributions/by-key/" + key, path)
                return proof().also { afterProof(); requireNotNull(evidence)(it); holder.requireCurrent(session) }
            }
            override suspend fun postMiningContribution(path: String, body: JsonObject, guard: () -> Unit, evidence: (JsonObject) -> Unit, refusal: (ApiException) -> Unit): JsonObject {
                beforeEnqueue(); guard(); assertEquals("/mining/contributions", path)
                val saved = store.read(); val operation = requireNotNull(saved.operation)
                assertEquals(operation.command.request.body(), body)
                assertEquals(saved.revision, operation.attemptRevision); posts++
                try { onPost() } catch (error: ApiException) { refusal(error); holder.requireCurrent(session); throw error }
                return proof().also { evidence(it); afterPostProof(); holder.requireCurrent(session) }
            }
        }
        val repository = MiningContributionRepository(session, holder, api, store, { selected }, { generation }, { dir },
            { account() }, { guard -> hydrates++; beforeHydration(); guard(); published = true }, { allowed }, { key })
        suspend fun review(): MiningContributionReview { repository.reviewStart(listOf(MiningContributionLine("frost_quartz", "2"))); return requireNotNull(repository.state.value.review) }
    }
    private fun rejects(block: () -> Unit) { assertThrows(Exception::class.java) { block() } }

    @Test fun `server review freezes value and explicit confirmation saves before POST then archive refreshes current stock`() = runBlocking<Unit> {
        val f = Fixture(); val r = f.review(); assertEquals("26", r.command.totalValue); assertEquals(0, f.posts)
        f.repository.confirm(r); assertEquals(1, f.posts); assertNotNull(f.store.read().operation!!.proof)
        f.repository.finish(); assertTrue(f.published); assertEquals(1, f.hydrates); assertNull(f.store.read().operation)
        assertEquals(MiningContributionHydration.CURRENT_ORIGINAL_BASE, f.repository.state.value.hydration)
    }
    @Test fun `foreground reads only and old server never advertises a contribution feature`() = runBlocking<Unit> {
        val f = Fixture(); f.repository.refresh(); assertTrue(f.repository.state.value.advertised); assertEquals(0, f.posts); assertNull(f.store.read().operation)
        val old = Fixture(); old.unsupported = true; old.repository.refresh(); assertFalse(old.repository.state.value.advertised); assertNull(old.repository.state.value.view)
    }
    @Test fun `lost acceptance recovers with GET under paused actions and a different selected kingdom`() = runBlocking<Unit> {
        val f = Fixture(); val r = f.review(); f.onPost = { f.accepted = true; throw IOException("lost acknowledgement") }
        rejects { runBlocking { f.repository.confirm(r) } }; assertNotNull(f.store.read().operation!!.attemptRevision)
        f.allowed = false; f.selected = key; f.generation++; f.repository.check(); assertNotNull(f.store.read().operation!!.proof); assertEquals(1, f.posts)
    }
    @Test fun `each changed consent input fails before POST and keeps the saved basket`() = runBlocking<Unit> {
        for (reason in listOf("price", "stock", "day", "pool", "cap", "consistency", "development", "paused")) {
            val f = Fixture(); val r = f.review()
            f.v = when (reason) {
                "price" -> f.v.copy(resources = f.v.resources.map { it.copy(unitValue = "14") })
                "stock" -> f.v.copy(resources = f.v.resources.map { it.copy(available = "0") })
                "day" -> f.v.copy(day = "2026-09-23", serverNow = "2026-09-23T00:00:00.000Z")
                "pool" -> f.v.copy(pool = "deed", dailyCapValue = null, remainingValue = null)
                "cap" -> f.v.copy(committedValue = "200", remainingValue = "0")
                "consistency" -> f.v.copy(consistency = MiningConsistencyPolicy(4, 20, 80))
                "development" -> f.v.copy(developmentReady = false)
                else -> f.v.copy(acceptingContributions = false)
            }
            rejects { runBlocking { f.repository.confirm(r) } }; assertEquals(reason, 0, f.posts)
            assertEquals(r.command, f.store.read().operation!!.command); assertNull(f.store.read().operation!!.attemptRevision)
        }
    }
    @Test fun `base generation pause and session are checked at actual enqueue after waits`() = runBlocking<Unit> {
        for (kind in listOf("base", "generation", "pause", "dismiss", "session")) {
            val f = Fixture(); val r = f.review(); f.beforeEnqueue = { when (kind) {
                "base" -> f.selected = key; "generation" -> f.generation++; "pause" -> f.allowed = false
                "dismiss" -> f.repository.dismiss(); else -> f.holder.replace(null)
            } }
            rejects { runBlocking { f.repository.confirm(r) } }; assertEquals(0, f.posts); assertNotNull(f.store.read().operation!!.attemptRevision)
        }
    }
    @Test fun `obsolete response acceptance persists without publishing replacement account stock`() = runBlocking<Unit> {
        val f = Fixture(); val r = f.review(); f.afterPostProof = { f.repository.dismiss(); f.selected = key; f.generation++ }
        rejects { runBlocking { f.repository.confirm(r) } }; assertNotNull(f.store.read().operation!!.proof); assertFalse(f.published); assertEquals(1, f.posts)
    }
    @Test fun `failed hydrate preserves accepted original for another explicit archive`() = runBlocking<Unit> {
        val f = Fixture(); f.repository.confirm(f.review()); f.beforeHydration = { throw IOException("stock refresh failed") }
        rejects { runBlocking { f.repository.finish() } }; assertNotNull(f.store.read().operation!!.proof); assertTrue(f.store.read().archives.isEmpty())
        f.beforeHydration = {}; f.repository.finish(); assertEquals(1, f.store.read().archives.size)
    }
    @Test fun `transferred original archives as history without hydrating substitute kingdom`() = runBlocking<Unit> {
        val f = Fixture(); f.repository.confirm(f.review()); f.selected = key; f.generation++
        f.repository.finish(); assertEquals(MiningContributionHydration.ORIGINAL_BASE_UNAVAILABLE, f.repository.state.value.hydration); assertFalse(f.published)
    }
    @Test fun `unknown first attempt cannot be replaced or silently retried and later refusal cannot erase ambiguity`() = runBlocking<Unit> {
        val f = Fixture(); f.onPost = { throw IOException("timeout") }; rejects { runBlocking { f.repository.confirm(f.review()) } }
        f.repository.check(); f.repository.refresh(); assertEquals(1, f.posts)
        rejects { runBlocking { f.repository.reviewStart(listOf(MiningContributionLine("shards", "1"))) } }
        rejects { runBlocking { f.repository.archiveDraftOrRefusal() } }
        f.repository.reviewSaved(); f.onPost = { throw ApiException(422, "INSUFFICIENT_MINING_RESOURCES", "No stock") }
        rejects { runBlocking { f.repository.confirm(requireNotNull(f.repository.state.value.review)) } }
        assertEquals(2, f.posts); assertNull(f.store.read().operation!!.refusal)
    }
    @Test fun `minimum facilities and unavailable stock reject new admission before saving an intent`() = runBlocking<Unit> {
        for (ready in listOf(false, true)) {
            val f = Fixture(); f.v = if (!ready) f.v.copy(developmentReady = false) else f.v.copy(resources = f.v.resources.map { it.copy(available = "0") })
            rejects { runBlocking { f.review() } }; assertNull(f.store.read().operation); assertEquals(0, f.posts)
        }
    }
    @Test fun `prospective policy transition preserves original receipt and cannot resubmit an old basket`() = runBlocking<Unit> {
        val f = Fixture(); val old = f.review()
        f.v = f.v.copy(policyVersion = 3, resources = miningContributionResourceIdsV3.map { MiningContributionStock(it, "100", "13") })
        rejects { runBlocking { f.repository.confirm(old) } }; assertEquals(0, f.posts)
        assertEquals(old.command, f.store.read().operation!!.command)
        f.accepted = true; f.allowed = false; f.selected = null; f.repository.check()
        assertEquals(2, f.store.read().operation!!.proof!!.receipt!!.request.policyVersion); assertEquals(0, f.posts)
        val fresh = Fixture(); fresh.v = f.v; fresh.repository.reviewStart(listOf(MiningContributionLine("climate_kit", "2")))
        val next = requireNotNull(fresh.repository.state.value.review); assertEquals(3, next.command.request.policyVersion)
        assertEquals("26", next.command.totalValue); fresh.repository.confirm(next); assertEquals(1, fresh.posts)
    }

}
