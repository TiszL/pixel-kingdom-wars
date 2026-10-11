package gg.pixelkingdomwars.nativeclient.ui.sheets.craft

import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.model.MarketOffer
import gg.pixelkingdomwars.nativeclient.ops.MarketReserveSpec
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import java.io.File
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Authored before implementation. Cedar3 owns execution; no wallet or transport is used here. */
class MarketOwnerSealTest {
    private val review = MarketReview.Purchase("buyer", "original-kingdom",
        MarketOffer("listing", "seller", "seller-kingdom", "sword", "9007199254740993", "2026-10-05T00:00:00Z"))
    private fun solState() = MarketTradeState(supported = true, loaded = true, review = review)
    private val policy = buildJsonObject { put("decimals", 9); put("sellerBps", 9700); put("basisPoints", 10000) }
    private fun command(kind: String = "fill") = KeepEquipmentMarketRecord(kind, "review-key", buildJsonObject {
        put("idempotencyKey", "review-key")
        if (kind == "listing") {
            put("baseId", "original-kingdom"); put("itemId", "frostglass")
            put("quantity", "3"); put("unitPriceBaseUnits", "1000001")
        } else {
            put("listingId", "listing")
            if (kind == "fill") { put("buyerBaseId", "original-kingdom"); put("quantity", "3") }
        }
    }, policy, preview = buildJsonObject {
        put("itemId", "frostglass"); put("unitPriceBaseUnits", "1000001")
        put("availableQuantity", "7"); put("sellerBaseId", "seller-kingdom"); put("sellerWallet", "seller")
    })
    private fun keepState(r: KeepEquipmentMarketRecord = command()) = KeepEquipmentMarketState(
        commandReview = r, selectedKey = r.key,
        journal = KeepEquipmentMarketJournal(identity = StarterIdentity("https://example.test", "devnet", "buyer"), pending = listOf(r)))

    @Test fun `SOL fresh review is excluded during every original payment or MFA state`() {
        val state = solState()
        assertEquals(review, marketFreshPurchaseReview(state, null, false, false))
        assertNull(marketFreshPurchaseReview(state, review, false, false))
        assertNull(marketFreshPurchaseReview(state, null, true, false))
        assertNull(marketFreshPurchaseReview(state, null, false, true))
        assertNull(marketFreshPurchaseReview(state.copy(busy = true), null, false, false))
        val q = marketQuote()
        assertNull(marketFreshPurchaseReview(state.copy(saved = SavedMarketPurchase(q, marketReceipt(q))), null, false, false))
        val pending = MarketReserveSpec.intent(q.buyer, q.buyerBaseId, "00000000-0000-4000-8000-000000000088",
            MarketOffer(q.listingId, q.seller, q.sourceBaseId, q.itemId, q.priceLamports, q.createdAt))
        assertNull(marketFreshPurchaseReview(state.copy(pending = listOf(pending)), null, false, false))
    }

    @Test fun `SOL ready state requires the existing owner support and load admission`() {
        assertNull(marketFreshPurchaseReview(solState().copy(supported = false), null, false, false))
        assertNull(marketFreshPurchaseReview(solState().copy(loaded = false), null, false, false))
        assertNull(marketFreshPurchaseReview(solState().copy(review = null), null, false, false))
    }

    @Test fun `SOL Seal preserves exact decimal price seller and receiving kingdom`() {
        val seal = marketPurchaseReviewSeal(review, "Sword", "sword", 375, "5001", 123L, true)
        assertEquals("9007199.254740993", seal.pay.amount)
        assertEquals("SOL", seal.pay.caption)
        assertEquals("sword", seal.gets!!.icon)
        assertEquals("BUY SWORD", seal.title)
        assertTrue(seal.lines.any { it.contains("original-kingdom") })
        assertTrue(seal.lines.any { it.contains("seller") })
        assertTrue(seal.note!!.contains("0.000005001 SOL"))
        assertTrue(seal.finePrint!!.text.contains("3.75%"))
        assertEquals(123L, seal.armedAtMs)
    }

    @Test fun `SOL absent fee is never replaced with a catalogue guess`() {
        val seal = marketPurchaseReviewSeal(review.copy(buyerBaseId = null), "Sword", null, null, null, 0L, false)
        assertNull(seal.finePrint)
        assertTrue(seal.lines.any { it.contains("wallet custody") })
        assertFalse(seal.confirmEnabled)
        assertTrue(seal.quoteReady)
        assertEquals(MarketSealStage.READY, seal.stage)
        assertTrue(seal.message!!.contains("wallet"))
    }

    @Test fun `KEEP owner review survives busy paint but never substitutes for payment review`() {
        val state = keepState()
        assertEquals(state.commandReview, keepMarketFreshCommandReview(state))
        assertEquals(state.commandReview, keepMarketFreshCommandReview(state.copy(busy = true)))
        assertNull(keepMarketFreshCommandReview(state.copy(paymentReview = buildJsonObject {})))
        assertNull(keepMarketFreshCommandReview(state.copy(selectedKey = "another")))
    }

    @Test fun `KEEP attempted held signed or settled originals retain original recovery presentation`() {
        val r = command()
        for (saved in listOf(r.copy(attempts = listOf("post:0")), r.copy(held = true),
            r.copy(discardedUnsent = true), r.copy(signed = buildJsonObject {}), r.copy(response = buildJsonObject {}))) {
            assertNull(saved.toString(), keepMarketFreshCommandReview(keepState(saved)))
        }
        assertNull(keepMarketFreshCommandReview(keepState(r).copy(commandReview = r.copy(request = buildJsonObject {}))))
    }

    @Test fun `KEEP reservation Seal shows original exact total and states the subsequent payment stage`() {
        val seal = keepMarketCommandSeal(command(), "different-current-kingdom", 9L, true, false)
        assertEquals("0.003000003", seal.pay.amount)
        assertEquals("KEEP", seal.pay.caption)
        assertEquals("3", seal.gets!!.amount)
        assertEquals("RESERVE", seal.confirmLabel)
        assertTrue(seal.lines.any { it.contains("original-kingdom") })
        assertTrue(seal.note!!.contains("review wallet payment next"))
        assertFalse(seal.note!!.contains("sign once"))
    }

    @Test fun `KEEP listing Seal uses the saved policy and never promises a rounded payout`() {
        val seal = keepMarketCommandSeal(command("listing"), "original-kingdom", 0L, true, false)
        assertEquals("LIST 3 FROSTGLASS", seal.title)
        assertEquals("3", seal.pay.amount)
        assertEquals("LIST", seal.confirmLabel)
        assertTrue(seal.lines.any { it.contains("0.001000001 KEEP each") })
        assertTrue(seal.finePrint!!.text.contains("97%"))
        assertTrue(seal.finePrint!!.text.contains("3%"))
        assertTrue(seal.note!!.contains("wallet"))
    }

    @Test fun `KEEP cancellation explicitly returns only unreserved stock and makes no payment claim`() {
        val seal = keepMarketCommandSeal(command("cancellation"), "seller-kingdom", 0L, true, false)
        assertEquals("RETURN UNSOLD FROSTGLASS", seal.title)
        assertEquals("RETURN", seal.confirmLabel)
        assertEquals("7", seal.pay.amount)
        assertTrue(seal.lines.any { it.contains("Existing purchases stay reserved") })
        assertNull(seal.finePrint)
        assertFalse(seal.title.contains("BUY"))
        assertFalse(seal.note!!.contains("sign"))
    }

    @Test fun `paused KEEP command is disabled rather than shown as a price check`() {
        val seal = keepMarketCommandSeal(command(), "original-kingdom", 0L, false, false)
        assertFalse(seal.confirmEnabled)
        assertTrue(seal.quoteReady)
        assertEquals(MarketSealStage.READY, seal.stage)
        assertTrue(seal.message!!.contains("paused"))
        assertEquals(MarketSealStage.BUSY, keepMarketCommandSeal(command(), "original-kingdom", 0L, true, true).stage)
    }

    @Test fun `confirmation accepts the same review once even before busy state publishes`() {
        val tap = MarketSealTap(review)
        assertTrue(tap.take(review, true))
        assertFalse(tap.take(review, true))
        assertFalse(tap.take(review.copy(buyerBaseId = "other"), true))
    }

    @Test fun `disabled stale and missing review taps do not consume the current review`() {
        val tap = MarketSealTap(review)
        assertFalse(tap.take(review, false))
        assertFalse(tap.take(null, true))
        assertFalse(tap.take(review.copy(offer = review.offer.copy(priceLamports = "1")), true))
        assertTrue(tap.take(review, true))
    }

    @Test fun `changed KEEP destination cannot confirm the previously displayed consent`() {
        val r = command(); val tap = MarketSealTap(r)
        val changed = r.copy(request = JsonObject(r.request + ("buyerBaseId" to JsonPrimitive("other-kingdom"))))
        assertFalse(tap.take(changed, true))
        assertTrue(tap.take(r, true))
        assertFalse(tap.take(r, true))
    }

    @Test fun `KEEP receipts and the original owner remain separate reachable doors`() {
        val ui = marketHomeSheetUi(solItems = false, keepMarket = KeepEquipmentMarketState(), walletAddress = "buyer",
            current = true, recoveryLabel = "RECEIPTS", originalOwnerLabel = "ORIGINAL MARKET")
        assertEquals("RECEIPTS", ui.observation!!.recoveryLabel)
        assertEquals("ORIGINAL MARKET", ui.observation!!.originalOwnerLabel)
        assertFalse(ui.base.buy!!.paymentsAvailable)
    }

    @Test fun `stale owner cannot expose the new original market door`() {
        val ui = marketHomeSheetUi(solItems = false, walletAddress = "buyer", current = false,
            recoveryLabel = "RECEIPTS", originalOwnerLabel = "ORIGINAL MARKET")
        assertNull(ui.observation!!.originalOwnerLabel)
        assertNull(ui.observation!!.recoveryLabel)
    }

    @Test fun `SOL STALL is a reachable explicit unavailable frame without invented vehicle stock`() {
        val ui = marketHomeSheetUi(solItems = false, section = SOL_STALL_SECTION,
            walletAddress = "buyer", current = true, keepMarket = KeepEquipmentMarketState())
        assertEquals(SOL_STALL_SECTION, ui.section)
        val stall = requireNotNull(ui.solStall)
        assertFalse(stall.available)
        assertEquals("Vehicle trading is unavailable in this app.", stall.unavailableReason)
        assertTrue(stall.lots.isEmpty())
        assertNull(stall.total)
        assertNull(stall.seal)
        assertNull(solBuyPrimary(stall))
        assertFalse(ui.observation!!.canRefresh)
        assertFalse(ui.observation!!.checking)
        assertFalse(stall.unavailableReason.contains("server"))
    }

    @Test fun `SOL unavailable reason remains visible even when KEEP discovery failed`() {
        val ui = marketHomeSheetUi(solItems = false, section = SOL_STALL_SECTION,
            walletAddress = "buyer", current = true, keepMarket = KeepEquipmentMarketState(error = "offline"))
        assertNotNull(ui.solStall)
        assertNull(ui.observation!!.unavailable)
        assertNull(marketObservationBodyNotice(ui))
    }

    @Test fun `SOL frame has return filters and never maps to a KEEP book read`() {
        val ui = marketHomeSheetUi(solItems = false, section = SOL_STALL_SECTION, walletAddress = "buyer", current = true)
        assertEquals(setOf("materials", "tools", "fragments", SOL_STALL_SECTION), ui.solStall!!.filters.map { it.id }.toSet())
        assertNull(marketHomeOwnerCategory(SOL_STALL_SECTION))
        assertEquals("resources", marketHomeOwnerCategory("materials"))
        assertEquals("items", marketHomeOwnerCategory("tools"))
        assertEquals("resources", marketHomeOwnerCategory("fragments"))
    }

    @Test fun `normal KEEP buy offers a SOL STALL door without relabelling the current book`() {
        val ui = marketHomeSheetUi(solItems = false, section = "materials", walletAddress = "buyer", current = true)
        assertEquals("materials", ui.section)
        assertNull(ui.solStall)
        assertTrue(ui.base.buy!!.categories.any { it.id == SOL_STALL_SECTION && it.label == "SOL STALL" })
    }

    @Test fun `reachable KEEP Seal retains receipts and suppresses the duplicate owner confirm footer`() {
        val home = source("ui/sheets/craft/MarketHomeBody.kt")
        val sheet = source("ui/sheets/craft/MarketSheetR2.kt")
        val owner = source("ui/phasee/KeepEquipmentMarketScreen.kt")
        assertTrue(home.contains("onOriginal = { read { recovery = true } }"))
        assertTrue(home.contains("if (onHistory != null) onHistory() else recovery = true"))
        assertTrue(sheet.contains("SecondaryButton(it, on.onOriginal)"))
        assertTrue(home.contains("sol = SolStallActions(onFilter = ::chooseCategory)"))
        assertTrue(owner.contains("MarketOwnerSealDialog(keepMarketCommandSeal("))
        assertTrue(owner.contains("if(primary!=null&&sealReview==null)"))
        assertTrue(owner.contains("if(tap.take(current,admitted))model.confirm()"))
        assertTrue(owner.contains("model.approve(rentAccepted)"))
        assertTrue(owner.contains("model.send()"))
        assertTrue(owner.contains("SensitiveMfaDialog(request"))
    }

    @Test fun `SOL Seal calls the same owner while started purchases keep their existing recovery dialog`() {
        val owner = source("ui/economy/MarketTradePanel.kt")
        assertTrue(owner.contains("if (freshReview == purchase)"))
        assertTrue(owner.contains("MarketOwnerSealDialog(marketPurchaseReviewSeal("))
        assertTrue(owner.contains("model.buy(purchase, wallet)"))
        assertTrue(owner.contains("model.retryPay(wallet)"))
        assertTrue(owner.contains("PaymentConfirmDialog("))
        assertTrue(owner.contains("model.checkPayment()"))
        assertTrue(owner.contains("SensitiveMfaDialog(request"))
    }

    private fun source(path: String): String {
        val relative = "src/main/kotlin/gg/pixelkingdomwars/nativeclient/$path"
        return listOf(File(relative), File("app/$relative")).first { it.isFile }.readText()
    }
}
