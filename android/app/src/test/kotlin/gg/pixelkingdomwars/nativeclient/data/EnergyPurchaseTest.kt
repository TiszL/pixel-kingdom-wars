package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.ui.kingdom.BasePurchaseViewModel
import gg.pixelkingdomwars.nativeclient.ui.kingdom.basePurchaseAccepted
import gg.pixelkingdomwars.nativeclient.ui.kingdom.basePurchaseTitle
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.*
import kotlinx.serialization.json.*
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class EnergyPurchaseTest {
    @Before fun main() { Dispatchers.setMain(UnconfinedTestDispatcher()) }
    @After fun reset() { Dispatchers.resetMain() }

    @Test fun `single and pack quantities and lamports come from admitted content and missing pack data fails closed`() {
        assertEquals("31", paidOffer("energy").amountLamports); assertEquals(1, paidOffer("energy").energyQuantity)
        assertEquals("97", paidOffer("energy_pack").amountLamports); assertEquals(5, paidOffer("energy_pack").energyQuantity)
        val constants = paidCatalogue()["constants"]!!.jsonObject
        for (raw in listOf(JsonObject(constants - "RAID_ENERGY"), JsonObject(constants + ("RAID_ENERGY" to json("""{"packLamports":97}"""))))) {
            assertNull(energyPurchaseOffer(raw, BASE_ID, "energy_pack"))
        }
        assertNull(energyPurchaseOffer(constants, "not-a-base", "energy")); assertNull(energyPurchaseOffer(constants, BASE_ID, "builder"))
    }

    @Test fun `energy wire requires positive integer quantity matching its receipt and exact ABI`() {
        for (kind in listOf("energy", "energy_pack")) {
            val q = paidQuote(paidOffer(kind).request(PAID_KEY))
            assertEquals(if (kind == "energy") 3 else 7, q.rail.sinkKind)
            for (bad in listOf(JsonNull, JsonPrimitive(0), JsonPrimitive(-1), JsonPrimitive(1.5), JsonPrimitive("5"), JsonPrimitive(2147483648L))) {
                assertThrows(Exception::class.java) { BasePurchaseQuote.from(JsonObject(q.raw + ("energyQuantity" to bad))) }
            }
            assertThrows(Exception::class.java) { BasePurchaseQuote.from(JsonObject(q.raw - "energyQuantity")) }
            assertThrows(Exception::class.java) { BasePurchaseQuote.from(JsonObject(q.raw + ("rail" to JsonObject(q.rail.raw + ("sinkKind" to JsonPrimitive(8)))))) }
            val paid = paidState(q, "credited", PAID_SIGNATURE)
            val receipt = requireNotNull(paid.receipt)
            assertEquals(q.energyQuantity, receipt.energyQuantity)
            val wrong = JsonObject(receipt.raw + ("energy" to json("""{"quantity":999}""")))
            assertThrows(Exception::class.java) { BasePurchaseState.from(JsonObject(paid.raw + ("receipt" to wrong))) }
        }
        assertThrows(Exception::class.java) { BasePurchaseQuote.from(JsonObject(paidQuote().raw + ("energyQuantity" to JsonPrimitive(1)))) }
    }

    @Test fun `same price cannot change originally reviewed energy quantity and journal remains intact`() {
        val f = PaidFixture(); val offer = paidOffer("energy_pack"); val q = paidQuote(offer.request(PAID_KEY))
        f.store.draft(q.request, offer)
        val changed = BasePurchaseQuote.from(JsonObject(q.raw + ("energyQuantity" to JsonPrimitive(offer.energyQuantity!! + 1))))
        assertThrows(IllegalArgumentException::class.java) { f.store.adopt(paidState(changed)) }
        assertNull(f.store.read()!!.purchase)
        f.store.adopt(paidState(q))
        val original = f.store.read()!!
        assertEquals(original, BasePurchaseStore(f.disk, WALLET, f.session.origin, "devnet").read())
    }

    @Test fun `older general v1 support cannot authorize an energy draft or payment`() = runTest {
        for (kind in listOf("energy", "energy_pack")) {
            val f = PaidFixture(); f.beforeGet = { path -> if (path.contains("/energy/")) throw ApiException(404, null, "older server") }
            val r = f.repository(); r.open(kind); r.review(kind, BASE_ID)
            assertFalse(r.state.value.supported); assertNull(f.store.read()); assertTrue(f.posts.isEmpty()); assertEquals(0, f.prepared)
            assertTrue(f.gets.filter { it.first.startsWith(BasePurchaseRepository.PATH) }.all { it.first.contains("/energy/") && it.second == mapOf("kind" to kind) })
        }
    }

    @Test fun `lost energy quote restores only original key through read-only capability after process restart`() = runTest {
        val f = PaidFixture(); f.quoteReplyLost = true; f.ready("energy_pack")
        val original = f.store.read()!!; assertNull(original.purchase); assertEquals(1, f.posts.size)
        f.base = null; f.directory = null
        val cold = f.repository(); cold.open(); cold.check()
        assertEquals(original.request, f.store.read()!!.request); assertNotNull(f.store.read()!!.purchase)
        assertEquals(1, f.posts.size); assertEquals(0, f.prepared)
        assertTrue(f.gets.takeLast(2).all { it.first.endsWith("/energy/${original.request.key}") && it.second == mapOf("kind" to "energy_pack") })
    }

    @Test fun `changed catalogue quantity refuses wallet approval while keeping original receipt recoverable`() = runTest {
        val f = PaidFixture(); val r = f.ready("energy_pack"); val original = f.store.read()!!
        val constants = f.catalogue["constants"]!!.jsonObject
        val energy = constants["RAID_ENERGY"]!!.jsonObject
        f.catalogue = JsonObject(f.catalogue + ("constants" to JsonObject(constants + ("RAID_ENERGY" to JsonObject(energy + ("packSize" to JsonPrimitive(6)))))))
        r.pay(f.sender()); assertEquals(0, f.prepared); assertEquals(original, f.store.read()); assertNotNull(r.state.value.error)
    }

    @Test fun `confirmed and recovered energy refreshes original deed then finishes Home without creating a raid`() = runTest {
        for (kind in listOf("energy", "energy_pack")) {
            val f = PaidFixture(); val r = f.ready(kind)
            f.onVerify = { f.row = paidState(f.row!!.quote, "credited", PAID_SIGNATURE) }
            r.pay(f.sender()); assertTrue(r.state.value.hydrated); assertTrue(f.hydrated > 0)
            // Rewritten 2026-09-18: a credited purchase now finishes by itself on mount (no FINISH tap) and reports its kind
            // once, which is what routes energy Home. Unchanged rule: it finishes only after the original deed was refreshed.
            val model = BasePurchaseViewModel(f.repository())
            val screen = launch { model.foreground(kind, BASE_ID, null) }; runCurrent(); screen.cancelAndJoin()
            assertEquals(kind, model.finished.value); assertNull(f.store.read())
            assertTrue(f.posts.none { it.first.startsWith("/raids") || it.first.contains("/start") })
            assertEquals(1, f.posts.count { it.first.endsWith("/quote") }); assertEquals(1, f.prepared)
        }
    }

    @Test fun `uncertain energy payment never navigates as complete or resends wallet approval`() = runTest {
        val f = PaidFixture(); val r = f.ready("energy"); f.verifyFail = true
        r.pay(f.sender()); val saved = f.store.read()!!; assertTrue(saved.attempted); assertEquals(PAID_SIGNATURE, saved.signature)
        val model = BasePurchaseViewModel(r); val routes = mutableListOf<String>()
        model.finish { routes += it }?.join(); assertTrue(routes.isEmpty()); assertEquals(saved, f.store.read())
        r.pay(f.sender()); assertEquals(1, f.prepared); assertTrue(f.posts.none { it.first.startsWith("/raids") })
    }

    @Test fun `energy receipt copy states actual quantity and a separate next attack`() {
        assertEquals("Raid energy", basePurchaseTitle("energy")); assertEquals("Raid energy pack", basePurchaseTitle("energy_pack"))
        // Rewritten 2026-09-18 to the short game copy. Unchanged rules: the line states the quantity the receipt granted,
        // the next attack is the player's own separate choice (a refill never starts a raid), and without a receipt
        // quantity nothing is claimed as granted. The deed identity now lives under the plate's DETAILS.
        val text = basePurchaseAccepted("energy_pack", energyQuantity = 5)
        assertTrue(text.contains("+5 RAID ENERGY")); assertTrue(text.contains("ATTACK WHEN READY"))
        assertFalse(basePurchaseAccepted("energy_pack").contains("+")); assertFalse(basePurchaseAccepted("energy_pack").contains("ATTACK"))
    }
}
