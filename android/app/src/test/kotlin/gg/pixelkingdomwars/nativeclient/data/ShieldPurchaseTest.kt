package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.ui.kingdom.basePurchaseAccepted
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class ShieldPurchaseTest {
    @Test fun `rejected unquoted purchase can be cancelled while purchases are dark and original land is lost`() = runTest {
        val f = PaidFixture(); f.quoteRejected = true; val r = f.ready("shield")
        val saved = f.store.read()!!; assertNull(saved.purchase); assertNotNull(r.state.value.error)
        f.enabled = false; f.base = null; f.directory = null
        r.cancelUnquoted()
        assertTrue(f.cancelled); assertNull(f.store.read()); assertEquals(0, f.prepared)
        assertEquals(BasePurchaseRepository.PATH + "/${saved.request.key}/cancel-unquoted", f.posts.last().first)
        // Clearing is authorized by a retained server fence, so another request can now be saved.
        f.store.draft(paidOffer().request(PAID_OTHER), paidOffer())
        assertEquals(PAID_OTHER, f.store.read()!!.request.key)
    }

    @Test fun `lost cancellation response retains the original key until the same cancellation is confirmed`() = runTest {
        val f = PaidFixture(); f.quoteRejected = true; val r = f.ready("shield"); val saved = f.store.read()!!
        f.cancelReplyLost = true; r.cancelUnquoted()
        assertTrue(f.cancelled); assertEquals(saved, f.store.read())
        f.cancelReplyLost = false; val restarted = f.repository(); restarted.open("shield"); restarted.cancelUnquoted()
        assertNull(f.store.read()); assertEquals(2, f.posts.count { it.first.endsWith("/${saved.request.key}/cancel-unquoted") })
        assertEquals(0, f.prepared)
    }

    @Test fun `cancellation losing to a late quote restores that quote and cannot discard its payment intent`() = runTest {
        val f = PaidFixture(); f.quoteRejected = true; val r = f.ready("shield"); val saved = f.store.read()!!
        f.row = paidState(paidQuote(saved.request))
        r.cancelUnquoted()
        assertFalse(f.cancelled); assertEquals(f.row, f.store.read()!!.purchase)
        assertEquals(saved.request, f.store.read()!!.request); assertEquals(0, f.prepared)
        val count = f.posts.size; r.cancelUnquoted()
        assertEquals(count, f.posts.size); assertNotNull(r.state.value.error)
    }

    @Test fun `another wallet or request cancellation cannot clear the saved intent`() = runTest {
        for (change in listOf(mapOf("wallet" to JsonPrimitive(PAID_REFERENCE)), mapOf("idempotencyKey" to JsonPrimitive(PAID_OTHER)))) {
            val f = PaidFixture(); f.quoteRejected = true; val r = f.ready("shield"); val saved = f.store.read()!!
            f.cancelChange = { JsonObject(it + change) }; r.cancelUnquoted()
            assertEquals(saved, f.store.read()); assertNotNull(r.state.value.error); assertEquals(0, f.prepared)
        }
    }

    @Test fun `cancellation proof cannot clear any locally quoted or attempted purchase`() = runTest {
        val f = PaidFixture(); val r = f.ready("shield"); val saved = f.store.read()!!
        val receipt = BasePurchaseCancellation.from(buildJsonObject {
            put("version", 1); put("wallet", WALLET); put("idempotencyKey", saved.request.key)
            put("cancelled", true); put("purchase", JsonNull)
        })
        assertThrows(IllegalArgumentException::class.java) { f.store.cancelUnquoted(receipt) }
        assertEquals(saved, f.store.read()); val count = f.posts.size; r.cancelUnquoted()
        assertEquals(count, f.posts.size)
        r.pay(f.sender { throw java.io.IOException("wallet disconnected") })
        val attempted = f.store.read()!!; assertTrue(attempted.attempted)
        assertThrows(IllegalArgumentException::class.java) { f.store.cancelUnquoted(receipt) }
        assertEquals(attempted, f.store.read())
    }

    @Test fun `shield costs durations and fractional Warzone split come only from catalogue`() {
        val ordinary = paidOffer("shield"); val warzone = paidOffer("warzone_shield")
        assertEquals("300000001", ordinary.amountLamports); assertEquals("25200", ordinary.seconds)
        assertEquals("1027", warzone.amountLamports); assertEquals("39600", warzone.seconds)
        assertEquals("342", warzone.directLamports); assertEquals("685", warzone.splitLamports)
        assertEquals(setOf("idempotencyKey", "baseId", "kind"), ordinary.request(PAID_KEY).raw.keys)
        val hiddenOrdinary = BaseSnapshot.from(JsonObject(paidBase() + ("shield" to json("""{"active":true,"source":"warzone"}"""))))
        assertNotNull("The server may find an eligible ordinary row behind effective Warzone protection", basePurchaseOffer(paidCatalogue(), hiddenOrdinary, "shield"))
    }

    @Test fun `wrong rail kinds and partial split payments cannot be accepted as shield quotes`() {
        val ordinary = paidQuote(paidOffer("shield").request(PAID_KEY))
        val warzone = paidQuote(paidOffer("warzone_shield").request(PAID_KEY))
        for ((q, change) in listOf(ordinary to mapOf("sinkKind" to JsonPrimitive(8)),
            warzone to mapOf("directLamports" to JsonPrimitive("0")), warzone to mapOf("splitLamports" to JsonPrimitive("686")),
            warzone to mapOf("destination" to JsonPrimitive(warzone.rail.treasuryDev)))) {
            assertThrows(IllegalArgumentException::class.java) { BasePurchaseQuote.from(JsonObject(q.raw + ("rail" to JsonObject(q.rail.raw + change)))) }
        }
    }

    @Test fun `same total cannot silently change the originally reviewed two leg split`() {
        val offer = paidOffer("warzone_shield"); val q = paidQuote(offer.request(PAID_KEY))
        val store = BasePurchaseStore(MemoryStore(), WALLET, "https://local.example", "devnet"); store.draft(q.request, offer)
        val changed = BasePurchaseQuote.from(JsonObject(q.raw + ("rail" to JsonObject(q.rail.raw + mapOf(
            "directLamports" to JsonPrimitive("343"), "splitLamports" to JsonPrimitive("684"))))))
        assertThrows(IllegalArgumentException::class.java) { store.adopt(paidState(changed)) }
        assertNull(store.read()!!.purchase)
    }

    @Test fun `shield capability is requested explicitly before any mutation`() = runTest {
        val f = PaidFixture(); val r = f.repository(); r.open("shield")
        assertTrue(f.posts.isEmpty()); assertEquals(mapOf("kind" to "shield"), f.gets.single().second)
        f.enabled = false; r.review("shield", BASE_ID)
        assertNull(r.state.value.review); assertTrue(f.posts.isEmpty()); assertEquals(0, f.prepared)
    }

    @Test fun `older paid base server cannot falsely advertise shield support by ignoring the kind query`() = runTest {
        val f = PaidFixture(); f.beforeGet = { path ->
            if (path.startsWith(BasePurchaseRepository.PATH + "/shields/")) throw ApiException(404, null, "Shield contract absent")
        }
        val r = f.repository(); r.open("shield"); r.review("shield", BASE_ID)
        assertFalse(r.state.value.supported); assertNull(r.state.value.review); assertNull(f.store.read())
        assertTrue(f.posts.isEmpty()); assertEquals(0, f.prepared)
        r.review("builder", BASE_ID)
        assertNotNull("The original supported builder flow stays available", r.state.value.review)
    }

    @Test fun `lost shield quote restores original key through GET only`() = runTest {
        val f = PaidFixture(); f.quoteReplyLost = true; f.ready("shield"); val saved = f.store.read()!!
        val posts = f.posts.toList(); val restored = f.repository(); restored.open("shield")
        assertEquals(posts, f.posts); assertEquals(saved.request.key, restored.state.value.saved!!.request.key)
        assertEquals(mapOf("kind" to "shield"), f.gets.last().second); assertEquals(0, f.prepared)
    }

    @Test fun `paid ordinary no op is immutable and never presented as protection or refund`() = runTest {
        val f = PaidFixture(); val r = f.ready("shield")
        f.onVerify = { f.row = paidState(f.row!!.quote, "credited", PAID_SIGNATURE, shieldGranted = false) }
        r.pay(f.sender()); val receipt = r.state.value.saved!!.purchase!!.receipt!!
        assertEquals(false, receipt.shieldGranted); assertNull(receipt.shieldExpiresAt); assertTrue(r.state.value.hydrated)
        assertTrue(basePurchaseAccepted("shield", false).contains("No additional protection or refund is confirmed"))
        val changed = paidState(f.row!!.quote, "credited", PAID_SIGNATURE, shieldGranted = true)
        assertThrows(IllegalArgumentException::class.java) { f.store.adopt(changed) }
        r.finish(); assertNull(f.store.read())
    }

    @Test fun `Warzone closing after quote prevents a new wallet handoff but preserves recovery`() = runTest {
        val f = PaidFixture(); f.baseRaw = JsonObject(f.baseRaw + ("warzone" to json("""{"active":true}""")))
        val r = f.ready("warzone_shield"); val saved = f.store.read()!!
        f.baseRaw = JsonObject(f.baseRaw + ("warzone" to json("""{"active":false}""")))
        var sends = 0; r.pay(f.sender { sends++ })
        assertEquals(0, sends); assertEquals(0, f.prepared); assertEquals(saved, f.store.read())
        assertNotNull(r.state.value.error)
    }

    @Test fun `Warzone receipt cannot invent paid no op and legacy receipt cannot carry shield result`() {
        val warzone = paidQuote(paidOffer("warzone_shield").request(PAID_KEY))
        assertThrows(IllegalArgumentException::class.java) { paidState(warzone, "credited", PAID_SIGNATURE, shieldGranted = false) }
        val builder = paidState(paidQuote(), "credited", PAID_SIGNATURE)
        val badReceipt = JsonObject(builder.receipt!!.raw + ("shield" to json("""{"granted":false,"expiresAt":null}""")))
        assertThrows(IllegalArgumentException::class.java) { BasePurchaseState.from(JsonObject(builder.raw + ("receipt" to badReceipt))) }
    }

    @Test fun `ordinary no op may record an existing expiry without claiming a new grant`() {
        val noOp = paidState(paidQuote(paidOffer("shield").request(PAID_KEY)), "credited", PAID_SIGNATURE, shieldGranted = false)
        val raw = JsonObject(noOp.receipt!!.raw + ("shield" to json("""{"granted":false,"expiresAt":"2026-09-16T00:00:00.000Z"}""")))
        val parsed = BasePurchaseState.from(JsonObject(noOp.raw + ("receipt" to raw))).receipt!!
        assertEquals(false, parsed.shieldGranted); assertNotNull(parsed.shieldExpiresAt)
        assertTrue(basePurchaseAccepted("shield", parsed.shieldGranted).contains("No additional protection"))
    }
}
