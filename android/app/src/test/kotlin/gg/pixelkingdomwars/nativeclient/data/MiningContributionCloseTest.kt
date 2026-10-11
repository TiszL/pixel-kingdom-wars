package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.miningcontribution.*
import java.io.IOException
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Owner rule 2026-10-06 (dead-end audit): an attempted Gold Forge basket whose reply was lost, which the server has
 *  no record of, could never be re-admitted once the mining day rolled over and could not be discarded, so smelting
 *  stayed shut forever. CLOSE re-reads the by-key receipt and archives it as "server-unknown" only on `unknown`. */
class MiningContributionCloseTest {
    private val now = "2026-09-22T12:00:00.000Z"
    private fun id(n: Int) = "00000000-0000-4000-8000-${n.toString().padStart(12, '0')}"
    private inner class Fixture {
        val holder = testHolder(); val session = signedIn(holder)
        val store = MiningContributionStore(MemoryStore(), MiningContributionIdentity(session.origin, "devnet", WALLET))
        var serverNow = now; var posts = 0; var receiptReads = 0; var accepted = false; var nextKey = 2
        fun view() = MiningContributionView(WALLET, BASE_ID, 2, serverNow.take(10), serverNow, true, "free", "200", "0", "200", true,
            miningContributionResourceIds.map { MiningContributionStock(it, "100", "13") }, MiningConsistencyPolicy(3, 20, 60))
        fun proof(key: String): JsonObject {
            val journal = store.read(); val c = (listOfNotNull(journal.operation) + journal.archives.map { it.operation }).single { it.command.key == key }.command
            val receipt = if (accepted) MiningContributionReceipt(c.key, BASE_ID, WALLET, now.take(10), c.request, c.lines, c.totalValue, now) else null
            return Json.encodeToJsonElement(MiningContributionProof(WALLET, c.key, now, if (accepted) "accepted" else "unknown", receipt, null)).jsonObject
        }
        val api = object : ApiClient by FakeApiClient() {
            override suspend fun getMiningContribution(path: String, query: Map<String, String>, guard: () -> Unit, evidence: ((JsonObject) -> Unit)?): JsonObject {
                guard(); if (path == "/mining/contributions") return Json.encodeToJsonElement(view()).jsonObject
                assertTrue(path.startsWith("/mining/contributions/by-key/")); receiptReads++
                return proof(path.removePrefix("/mining/contributions/by-key/")).also { requireNotNull(evidence)(it) }
            }
            override suspend fun postMiningContribution(path: String, body: JsonObject, guard: () -> Unit, evidence: (JsonObject) -> Unit, refusal: (ApiException) -> Unit): JsonObject {
                guard(); posts++; throw IOException("connection lost after the basket was sent")
            }
        }
        val repository = MiningContributionRepository(session, holder, api, store, { BASE_ID }, { 0L },
            { BaseDirectory(true, capabilities = BaseCapabilities(true, true), bases = listOf(BaseSummary(BASE_ID, "active", slot = 0))) },
            {}, { guard -> guard() }, { true }, { id(nextKey++) })
        suspend fun start() = repository.reviewStart(listOf(MiningContributionLine("frost_quartz", "2")))
        suspend fun sentAndLost() {
            start(); assertTrue(runCatching { repository.confirm(requireNotNull(repository.state.value.review)) }.isFailure)
            val op = store.read().operation!!; assertNotNull(op.attemptRevision); assertNull(op.proof); assertNull(op.refusal); assertEquals(1, posts)
        }
    }

    @Test fun `an attempted smelt basket the server does not know cannot block smelting forever`() = runBlocking<Unit> {
        val f = Fixture(); f.sentAndLost(); f.serverNow = "2026-09-23T00:05:00.000Z"
        assertTrue("the next mining day refuses the same basket", runCatching { f.repository.reviewSaved() }.isFailure)
        assertTrue("a new basket is refused while the request is saved", runCatching { f.start() }.isFailure)
        assertTrue("an attempted basket is not an unsent draft", runCatching { f.repository.archiveDraftOrRefusal() }.isFailure)
        val reads = f.receiptReads
        f.repository.archiveUnknown()
        assertTrue("CLOSE made its own fresh by-key read", f.receiptReads > reads)
        val archive = f.store.read().archives.single(); assertNull(f.store.read().operation)
        assertEquals("server-unknown", archive.reason); assertEquals("unknown", archive.evidence!!.status)
        assertEquals("CLOSE never sends a basket", 1, f.posts)
        f.start(); assertNotNull(f.repository.state.value.review); assertEquals(1, f.posts)
    }

    @Test fun `close is refused when the server shows the smelt basket receipt`() = runBlocking<Unit> {
        val f = Fixture(); f.sentAndLost(); f.accepted = true
        f.repository.archiveUnknown()
        assertNotNull(f.store.read().operation!!.proof); assertTrue(f.store.read().archives.isEmpty()); assertEquals(1, f.posts)
        assertTrue(runCatching { f.repository.archiveUnknown() }.isFailure)
    }
}
