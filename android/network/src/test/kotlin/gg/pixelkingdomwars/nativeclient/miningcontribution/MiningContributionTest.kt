package gg.pixelkingdomwars.nativeclient.miningcontribution

import gg.pixelkingdomwars.nativeclient.network.ApiException
import gg.pixelkingdomwars.nativeclient.network.SecretStore
import java.io.IOException
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class MiningContributionTest {
    private val wallet = "11111111111111111111111111111111"
    private val base = "00000000-0000-4000-8000-000000000001"
    private val key = "00000000-0000-4000-8000-000000000002"
    private val now = "2026-09-29T12:00:00.000Z"
    private val identity = MiningContributionIdentity("https://example.test", "devnet", wallet)
    private fun view() = MiningContributionView(wallet, base, 2, now.take(10), now, true, "free", "200", "0", "200", true,
        miningContributionResourceIds.map { MiningContributionStock(it, "100", "13") }, MiningConsistencyPolicy(3, 20, 60))
    private fun command() = MiningContributionCommand.review(identity, view(), key, listOf(MiningContributionLine("frost_quartz", "2")))
    private class Memory : SecretStore { var bytes: String? = null; var fail = false
        override fun read() = bytes; override fun write(value: String) { if (fail) throw IOException("disk full"); bytes = value }; override fun clear() { bytes = null } }
    private fun proof(c: MiningContributionCommand, accepted: Boolean = false, outcome: String? = null) = MiningContributionProof(wallet, c.key, now,
        if (accepted) "accepted" else "unknown", if (accepted) MiningContributionReceipt(c.key, base, wallet, now.take(10), c.request, c.lines, c.totalValue, now) else null,
        outcome?.let { MiningContributionSettlement(it, now) })
    private inner class Fixture {
        val memory = Memory(); val store = MiningContributionStore(memory, identity); val command = command()
        var accepted = false; var posts = 0; var reads = 0; var current = view(); var failPost = false
        val transport = MiningContributionTransport(store, object : MiningContributionPort {
            override suspend fun get(path: String, guard: () -> Unit, retain: (JsonObject) -> Unit): JsonObject {
                guard(); assertEquals(command.receiptPath, path); reads++
                return contributionJson.encodeToJsonElement(proof(command, accepted)).jsonObject.also(retain)
            }
            override suspend fun post(path: String, body: JsonObject, guard: () -> Unit, retain: (JsonObject) -> Unit, refusal: (ApiException) -> Unit): JsonObject {
                guard(); assertEquals("/mining/contributions", path); assertEquals(command.request.body(), body)
                assertEquals(store.read().revision, store.read().operation!!.attemptRevision); posts++
                if (failPost) throw IOException("lost acknowledgment")
                accepted = true; return contributionJson.encodeToJsonElement(proof(command, true)).jsonObject.also(retain)
            }
        })
        suspend fun begin() = transport.begin(command, current) {}
    }
    @Test fun `server values freeze exactly without a Kotlin price table`() {
        val c = command(); assertEquals("26", c.totalValue); assertEquals("13", c.lines.single().unitValue)
        c.admit(identity, view()); assertThrows(Exception::class.java) { c.admit(identity, view().copy(resources = view().resources.map { it.copy(unitValue = "14") })) }
    }
    @Test fun `full resource set and canonical string quantities are required`() {
        val v = view(); v.validate()
        for (changed in listOf(v.copy(resources = v.resources.dropLast(1)), v.copy(resources = v.resources + v.resources.first()),
            v.copy(resources = v.resources.map { it.copy(available = "01") }), v.copy(resources = v.resources.map { it.copy(unitValue = "0") }), v.copy(remainingValue = "199")))
            assertThrows(Exception::class.java) { changed.validate() }
        for (value in listOf("0", "01", "1.2", "-1", "9223372036854775808")) assertThrows(Exception::class.java) { MiningContributionLine("shards", value).validate() }
        assertThrows(Exception::class.java) { command().request.copy(lines = command().request.lines + command().request.lines).validate() }
    }
    @Test fun `strict wire schema rejects coercion and actor or epoch injection`() {
        val c = command(); MiningContributionRequest.from(c.request.body())
        for (body in listOf(JsonObject(c.request.body() + ("actor" to JsonPrimitive(wallet))), JsonObject(c.request.body() + ("epochId" to JsonPrimitive(base))),
            JsonObject(c.request.body() + ("policyVersion" to JsonPrimitive("2"))))) assertThrows(Exception::class.java) { MiningContributionRequest.from(body) }
    }
    @Test fun `free allowance rejects whole basket and deeds have no cap while minimum development stays required`() {
        val lines = listOf(MiningContributionLine("shards", "20"))
        assertThrows(Exception::class.java) { MiningContributionCommand.review(identity, view(), key, lines) }
        val deed = view().copy(pool = "deed", dailyCapValue = null, remainingValue = null)
        MiningContributionCommand.review(identity, deed, key, lines)
        assertThrows(Exception::class.java) { command().admit(identity, view().copy(developmentReady = false)) }
        assertThrows(Exception::class.java) { command().admit(identity, view().copy(day = "2026-09-30", serverNow = "2026-09-30T00:00:00.000Z")) }
    }
    @Test fun `big resource values use exact integer multiplication`() {
        val v = view().copy(pool = "deed", dailyCapValue = null, remainingValue = null,
            resources = view().resources.map { it.copy(available = "9223372036854775807") })
        val c = MiningContributionCommand.review(identity, v, key, listOf(MiningContributionLine("shards", "9223372036854775807")))
        assertEquals("119903836479112085491", c.totalValue)
    }
    @Test fun `receipt must match original basket wallet key value day and observation time`() {
        val c = command(); val p = proof(c, true); p.validate(identity, c)
        for (changed in listOf(p.copy(wallet = "So11111111111111111111111111111111111111112"), p.copy(idempotencyKey = base),
            p.copy(receipt = p.receipt!!.copy(totalValue = "27")), p.copy(serverNow = "2026-09-29T00:00:00.000Z"),
            p.copy(receipt = p.receipt!!.copy(day = "2026-09-28")), p.copy(settlement = MiningContributionSettlement("partial", now))))
            assertThrows(Exception::class.java) { changed.validate(identity, c) }
    }
    @Test fun `timeout preserves original attempt across process reload and GET never retries or replaces it`() = runBlocking<Unit> {
        val f = Fixture(); f.begin(); f.failPost = true
        assertThrows(IOException::class.java) { runBlocking { f.transport.confirm(f.store.read(), { f.current }) {} } }
        val reloaded = MiningContributionStore(f.memory, identity).read(); assertEquals(f.command, reloaded.operation!!.command); assertNotNull(reloaded.operation!!.attemptRevision)
        f.transport.check {}; f.transport.check {}; assertEquals(1, f.posts)
        assertThrows(Exception::class.java) { runBlocking { f.transport.archiveUnsentOrRefused(f.store.read()) {} } }; assertNotNull(f.store.read().operation)
        f.accepted = true; f.current = f.current.copy(acceptingContributions = false); f.transport.check {}; assertNotNull(f.store.read().operation!!.proof)
    }
    @Test fun `failed durable intent or attempt cannot POST`() = runBlocking<Unit> {
        val f = Fixture(); f.memory.fail = true; assertThrows(IOException::class.java) { runBlocking { f.begin() } }; assertEquals(0, f.posts)
        f.memory.fail = false; f.begin(); f.memory.fail = true
        assertThrows(IOException::class.java) { runBlocking { f.transport.confirm(f.store.read(), { f.current }) {} } }; assertEquals(0, f.posts)
    }
    @Test fun `settlement is monotonic and old history cannot replace consumed with returned`() {
        val f = Fixture(); f.store.begin(f.store.read(), f.command); f.store.accept(f.command, proof(f.command, true))
        f.store.archive(f.store.read(), "accepted", null); f.store.accept(f.command, proof(f.command, true, "consumed"))
        val before = f.memory.bytes
        for (replacement in listOf(proof(f.command, true), proof(f.command, true, "returned"))) assertThrows(Exception::class.java) { f.store.accept(f.command, replacement) }
        assertEquals(before, f.memory.bytes)
    }
    @Test fun `corrupt encrypted bytes and foreign identities fail closed without clearing evidence`() {
        val f = Fixture(); f.memory.bytes = "{corrupt"; assertThrows(Exception::class.java) { f.store.read() }; assertEquals("{corrupt", f.memory.bytes)
        f.memory.bytes = null; f.store.begin(f.store.read(), f.command)
        assertThrows(Exception::class.java) { MiningContributionStore(f.memory, identity.copy(cluster = "mainnet-beta")).read() }; assertNotNull(f.memory.bytes)
    }
    @Test fun `generic infra key conflicts and wrong status never become definitive refusal`() {
        assertTrue(miningContributionRefusalDefinitive(422, "INSUFFICIENT_MINING_RESOURCES"))
        assertFalse(miningContributionRefusalDefinitive(503, "PHASE_E_DISABLED")); assertFalse(miningContributionRefusalDefinitive(409, "IDEMPOTENCY_BODY_MISMATCH"))
        assertFalse(miningContributionRefusalDefinitive(409, "INSUFFICIENT_MINING_RESOURCES"))
    }
    @Test fun `capability admits either exact policy catalogue and never widens old originals`() {
        val v3 = view().copy(policyVersion = 3, resources = miningContributionResourceIdsV3.map { MiningContributionStock(it, "100", "13") })
        v3.validate(); view().validate()
        val c = MiningContributionCommand.review(identity, v3, key, listOf(MiningContributionLine("expedition_kit", "2")))
        assertEquals("26", c.totalValue); assertEquals(3, c.request.policyVersion)
        assertThrows(Exception::class.java) { c.request.copy(policyVersion = 2).validate() }
        assertThrows(Exception::class.java) { v3.copy(policyVersion = 2).validate() }
        assertThrows(Exception::class.java) { view().copy(policyVersion = 3).validate() }
        assertThrows(Exception::class.java) { command().admit(identity, v3) }
        val memory = Memory(); val store = MiningContributionStore(memory, identity)
        val old = command(); store.begin(store.read(), old); store.accept(old, proof(old, true))
        assertEquals(old, MiningContributionStore(memory, identity).read().operation!!.command)
    }

}
