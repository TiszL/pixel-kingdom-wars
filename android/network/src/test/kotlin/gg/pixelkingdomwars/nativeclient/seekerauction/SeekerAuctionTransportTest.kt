package gg.pixelkingdomwars.nativeclient.seekerauction

import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import java.io.IOException
import java.util.Base64
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class SeekerAuctionTransportTest {
    private data class Request(val method: String, val path: String, val query: Map<String, String>, val body: JsonObject?)
    private class Port : SeekerAuctionAuthenticatedPort {
        override var identity = StarterIdentity("https://example.invalid", "devnet", AuctionFixtures.wallet)
        val calls = mutableListOf<Request>()
        var result: JsonObject = AuctionFixtures.round()
        var returnedResult: JsonObject? = null
        var fail = false
        var afterRetain: () -> Unit = {}
        override suspend fun request(method: String, path: String, query: Map<String, String>, body: JsonObject?,
            guard: () -> Unit, retain: suspend (JsonObject) -> Unit): JsonObject {
            guard(); calls += Request(method, path, query, body)
            if (fail) throw IOException("lost response")
            retain(result); afterRetain(); guard(); return returnedResult ?: result
        }
    }
    @Test fun `exact seven route pairs no extra actor or idempotency fields`() = runBlocking {
        val port = Port(); val t = SeekerAuctionTransport(port, AuctionFixtures.policy)
        t.current(); t.round("1")
        port.result = AuctionFixtures.refunds(); t.refunds()
        port.result = AuctionFixtures.status(); t.status(AuctionFixtures.signature)
        port.result = AuctionFixtures.prepared(); t.prepareBid(SeekerAuctionBidRequest("1", 0, "17")); t.prepareWithdrawal(SeekerAuctionWithdrawRequest("1", 0))
        port.result = AuctionFixtures.status(); t.submit(SeekerAuctionSubmission.SignedWire(AuctionFixtures.signedWire, AuctionFixtures.signature))
        assertEquals(listOf("GET /seeker/auctions/current", "GET /seeker/auctions/round/1", "GET /seeker/auctions/refunds",
            "GET /seeker/auctions/tx/${AuctionFixtures.signature}", "POST /seeker/auctions/bids/prepare",
            "POST /seeker/auctions/withdrawals/prepare", "POST /seeker/auctions/submit"), port.calls.map { "${it.method} ${it.path}" })
        assertTrue(port.calls.all { it.query.isEmpty() }); assertTrue(port.calls.take(4).all { it.body == null })
        assertEquals(setOf("round", "spot", "newTotalRaw"), port.calls[4].body!!.keys)
        assertEquals(setOf("round", "spot"), port.calls[5].body!!.keys)
        assertEquals(setOf("signedTransaction"), port.calls[6].body!!.keys)
    }
    @Test fun `refund cursor is two flattened strings not after object or limit`() = runBlocking {
        val port = Port().apply { result = AuctionFixtures.refunds() }
        SeekerAuctionTransport(port, AuctionFixtures.policy).refunds(SeekerAuctionRefundCursor("9", 2))
        assertEquals(mapOf("round" to "9", "spot" to "2"), port.calls.single().query)
    }
    @Test fun `refund response must advance requested cursor`() = runBlocking {
        val port = Port().apply { result = AuctionFixtures.refunds() }
        try { SeekerAuctionTransport(port, AuctionFixtures.policy).refunds(SeekerAuctionRefundCursor("11", 1)); fail("nonadvancing page") }
        catch (_: IllegalArgumentException) { }
    }
    @Test fun `signature only submit observes without signed bytes`() = runBlocking {
        val port = Port().apply { result = AuctionFixtures.status() }
        SeekerAuctionTransport(port, AuctionFixtures.policy).submit(SeekerAuctionSubmission.ObserveSignature(AuctionFixtures.signature))
        assertEquals(buildJsonObject { put("signature", AuctionFixtures.signature) }, port.calls.single().body)
    }
    @Test fun `port never retries lost POST`() = runBlocking {
        val port = Port().apply { fail = true }
        try { SeekerAuctionTransport(port, AuctionFixtures.policy).submit(SeekerAuctionSubmission.SignedWire(AuctionFixtures.signedWire, AuctionFixtures.signature)); fail("lost result") }
        catch (_: IOException) { }
        assertEquals(1, port.calls.size)
    }
    @Test fun `invalid path scalar refused before any authenticated call`() = runBlocking {
        val port = Port(); val t = SeekerAuctionTransport(port, AuctionFixtures.policy)
        try { t.round("../current"); fail("invalid round") } catch (_: IllegalArgumentException) { }
        try { t.status("bad/signature"); fail("invalid signature") } catch (_: IllegalArgumentException) { }
        assertTrue(port.calls.isEmpty())
    }
    @Test fun `response wallet and requested round are bound`() = runBlocking {
        val port = Port().apply { result = AuctionFixtures.change(AuctionFixtures.round(), "wallet", JsonPrimitive(AuctionFixtures.other)) }
        try { SeekerAuctionTransport(port, AuctionFixtures.policy).current(); fail("other wallet") } catch (_: IllegalArgumentException) { }
        port.result = AuctionFixtures.round()
        try { SeekerAuctionTransport(port, AuctionFixtures.policy).round("2"); fail("other round") } catch (_: IllegalArgumentException) { }
    }
    @Test fun `matching receipt drains before changed session rejects publication`() = runBlocking {
        val port = Port().apply { result = AuctionFixtures.status(false, "12") }
        val t = SeekerAuctionTransport(port, AuctionFixtures.policy); var retained: SeekerAuctionTxStatus? = null
        port.afterRetain = { port.identity = port.identity.copy(wallet = AuctionFixtures.other) }
        try { t.status(AuctionFixtures.signature, retain = { retained = it }); fail("changed identity") } catch (_: IllegalStateException) { }
        assertEquals(AuctionFixtures.signature, retained!!.signature)
    }
    @Test fun `signature mismatch is never retained as this operation receipt`() = runBlocking {
        val port = Port().apply { result = AuctionFixtures.change(AuctionFixtures.status(), "signature", JsonPrimitive(AuctionFixtures.otherSignature)) }
        var retained = false
        try { SeekerAuctionTransport(port, AuctionFixtures.policy).status(AuctionFixtures.signature, retain = { retained = true }); fail("other signature") }
        catch (_: IllegalArgumentException) { }
        assertFalse(retained)
    }
    @Test fun `refusal is propagated without empty refund fallback`() = runBlocking {
        val port = Port().apply { fail = true }
        try { SeekerAuctionTransport(port, AuctionFixtures.policy).refunds(); fail("unavailable became empty") } catch (_: IOException) { }
        assertEquals(1, port.calls.size)
    }
    @Test fun `signed identity mismatch is refused before any relay or retention`() = runBlocking {
        val port = Port().apply { result = AuctionFixtures.status() }; var retained = false
        try {
            SeekerAuctionTransport(port, AuctionFixtures.policy).submit(
                SeekerAuctionSubmission.SignedWire(AuctionFixtures.signedWire, AuctionFixtures.otherSignature),
                retain = { retained = true })
            fail("mismatched signed identity")
        } catch (_: IllegalArgumentException) { }
        assertTrue(port.calls.isEmpty()); assertFalse(retained)
    }
    @Test fun `signed wire requires one canonical signature before any relay`() = runBlocking {
        val wire = Base64.getDecoder().decode(AuctionFixtures.signedWire)
        val variants = listOf(wire.copyOf().also { it[0] = 2 }, wire.copyOf().also { it[1] = (it[1].toInt() xor 1).toByte() })
        for (bytes in variants) {
            val port = Port().apply { result = AuctionFixtures.status() }
            try {
                SeekerAuctionTransport(port, AuctionFixtures.policy).submit(SeekerAuctionSubmission.SignedWire(
                    Base64.getEncoder().encodeToString(bytes), AuctionFixtures.signature))
                fail("wrong count or signed bytes")
            } catch (_: IllegalArgumentException) { }
            assertTrue(port.calls.isEmpty())
        }
    }
    @Test fun `a returned body cannot replace the already drained receipt`() = runBlocking {
        val original = AuctionFixtures.status(true, "12")
        val port = Port().apply { result = original; returnedResult = AuctionFixtures.status(false, "999") }
        val retained = mutableListOf<SeekerAuctionTxStatus>()
        try {
            SeekerAuctionTransport(port, AuctionFixtures.policy).status(AuctionFixtures.signature, retain = { retained += it })
            fail("different return body")
        } catch (_: IllegalStateException) { }
        assertEquals(1, port.calls.size); assertEquals(1, retained.size)
        assertEquals(true, retained.single().found); assertEquals("12", retained.single().finalizedBlockHeight)
    }

}
