package gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live

import gg.pixelkingdomwars.nativeclient.BASE_ID
import gg.pixelkingdomwars.nativeclient.data.BasePurchaseUiState
import gg.pixelkingdomwars.nativeclient.data.PAID_BUILDING
import gg.pixelkingdomwars.nativeclient.data.PAID_KEY
import gg.pixelkingdomwars.nativeclient.data.PAID_SIGNATURE
import gg.pixelkingdomwars.nativeclient.data.SavedBasePurchase
import gg.pixelkingdomwars.nativeclient.data.paidOffer
import gg.pixelkingdomwars.nativeclient.data.paidQuote
import gg.pixelkingdomwars.nativeclient.data.paidState
import gg.pixelkingdomwars.nativeclient.ui.model.*
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.*
import org.junit.Assert.*
import org.junit.Test

/** The SOL purchase in place on Home only ever echoes the existing owner's state. These cases pin the money rules the
 *  designed sheets must not bend: a price only from the owner's review of this exact purchase, one saved purchase blocks
 *  every other, the wallet step is "Check wallet", an attempted payment is never "nothing spent", SENT only after the
 *  original deed was refreshed, and a confirm reaches the owner only from an idle, available, matching review. */
class LiveSolPurchaseMapperTest {
    private val builder = paidOffer()
    private fun ready(review: gg.pixelkingdomwars.nativeclient.network.BasePurchaseOffer? = builder) =
        BasePurchaseUiState(loaded = true, supported = true, enabled = true, review = review)
    private fun saved(kind: String = "builder", status: String? = "pending", attempted: Boolean = false, signature: String? = null): SavedBasePurchase {
        val offer = paidOffer(kind); val request = offer.request(PAID_KEY)
        return SavedBasePurchase(request, offer, status?.let { paidState(paidQuote(request), it, signature) }, attempted, signature)
    }
    private fun holding(saved: SavedBasePurchase, quoteFresh: Boolean = false, hydrated: Boolean = false, busy: Boolean = false,
        unavailable: String? = null) = BasePurchaseUiState(loaded = true, supported = true, enabled = true, busy = busy,
        saved = saved, quoteFresh = quoteFresh, hydrated = hydrated, unavailable = unavailable)
    private fun view(state: BasePurchaseUiState, kind: String = "builder", buildingId: String? = null, paying: Boolean = false,
        busy: Boolean = false) = solPurchaseView(state, kind, BASE_ID, buildingId, paying, busy)

    @Test fun `price comes only from the owner review of this exact purchase`() {
        // 0.5 SOL is the fixture catalogue's first builder price, re-read by the owner's review; nothing is computed here.
        val priced = view(ready())
        assertEquals(PriceUi(Currency.SOL, "0.5", PriceStatus.OK), priced.price)
        assertTrue(priced.canRaise); assertTrue(priced.canConfirm)
        // Another deed's, another kind's or another building's review never prices this one.
        for (other in listOf(builder.copy(baseId = PAID_KEY), paidOffer("expansion"))) {
            val v = view(ready(other))
            assertEquals(PriceStatus.CHECKING, v.price.status); assertNull(v.price.amount); assertFalse(v.canConfirm)
        }
        val mine = paidOffer("mine")
        assertEquals(PriceStatus.CHECKING, view(ready(mine), "mine", buildingId = "another-building").price.status)
        assertEquals(PriceStatus.OK, view(ready(mine), "mine", buildingId = PAID_BUILDING).price.status)
    }
    @Test fun `without a review the Seal can rise but only waits for the price`() {
        val v = view(ready(review = null))
        assertEquals(PriceStatus.CHECKING, v.price.status)
        assertTrue(v.canRaise); assertFalse(v.canConfirm)
        assertEquals(SolConfirm.WAIT_PRICE, solConfirmTap(v))
        val seal = requireNotNull(solSealUi(v, "HIRE BUILDER 2", listOf(SOL_SIGN_ONCE), 7L))
        assertEquals("HIRE", seal.confirmLabel); assertEquals(7L, seal.armedAtMs)
        assertEquals(listOf(SOL_SIGN_ONCE, SOL_GETTING_PRICE), seal.lines)
        // Not loaded yet is still a CHECKING price, never a refusal.
        assertTrue(view(BasePurchaseUiState()).canRaise)
    }
    @Test fun `another saved purchase blocks every base purchase with the owner reason`() {
        val v = view(holding(saved("expansion")).copy(review = builder))
        assertFalse(v.canRaise); assertFalse(v.canConfirm); assertFalse(v.canRetry); assertFalse(v.uncertain)
        assertEquals(SOL_RECOVER_FIRST, v.reason)
        assertNull(solSealUi(v, "HIRE BUILDER 2", emptyList(), 0L))
        assertEquals(SolTap.EXPLAIN, solPrimaryTap(v)); assertEquals(SolConfirm.REFUSE, solConfirmTap(v))
    }
    @Test fun `the wallet step reads Check wallet and takes no tap`() {
        for (state in listOf(ready(), holding(saved(attempted = true)))) {
            val v = view(state, paying = true)
            assertEquals(MoneyStage.CHECK_WALLET, v.stage); assertFalse(v.canConfirm); assertFalse(v.canRaise)
            assertEquals(SolTap.WAIT, solPrimaryTap(v))
        }
        // This visit's own BUY is still out (draft or quote in flight): the same look, never a second confirm.
        assertEquals(MoneyStage.CHECK_WALLET, view(ready(), busy = true).stage)
        assertEquals(MoneyStage.CHECK_WALLET, view(holding(saved(status = null)), busy = true).stage)
    }
    @Test fun `an attempted pending payment is Sending and being checked`() {
        for (signature in listOf(PAID_SIGNATURE, null)) {
            val v = view(holding(saved(attempted = true, signature = signature)))
            assertEquals(MoneyStage.SENDING, v.stage); assertTrue(v.uncertain)
            assertFalse(v.canRetry); assertFalse(v.canRaise)
            assertEquals(SolTap.CHECK, solPrimaryTap(v))
        }
    }
    @Test fun `credited is SENT only after the original deed was refreshed`() {
        val credited = saved(status = "credited", attempted = true, signature = PAID_SIGNATURE)
        val unhydrated = view(holding(credited))
        assertNotEquals(MoneyStage.SENT, unhydrated.stage); assertTrue(unhydrated.uncertain); assertFalse(unhydrated.finished)
        val done = view(holding(credited, hydrated = true))
        assertEquals(MoneyStage.SENT, done.stage); assertTrue(done.finished); assertFalse(done.uncertain)
        // A receipt for a deed that is no longer available needs its OK on the recovery screen: SENT, not finished.
        val elsewhere = view(holding(credited, hydrated = true, unavailable = "The original deed is unavailable."))
        assertEquals(MoneyStage.SENT, elsewhere.stage); assertFalse(elsewhere.finished)
        assertEquals("The original deed is unavailable.", elsewhere.reason)
    }
    @Test fun `an attempted payment the server ended never reads as nothing spent`() {
        for (ended in listOf(saved(status = "expired", attempted = true), saved(status = "failed", attempted = true, signature = PAID_SIGNATURE))) {
            val v = view(holding(ended))
            assertTrue(v.uncertain); assertEquals(MoneyStage.SENDING, v.stage)
            assertFalse(v.canRaise); assertFalse(v.canRetry)
            assertFalse((v.reason ?: "").contains("Nothing", ignoreCase = true))
        }
        // Only a never-attempted quote the server ended is the owner's to retire (it says nothing was charged itself).
        val unpaid = view(holding(saved(status = "expired")))
        assertFalse(unpaid.uncertain); assertEquals(SOL_RECOVER_FIRST, unpaid.reason)
    }
    @Test fun `a lost quote reply is being checked`() {
        val v = view(holding(saved(status = null)))
        assertTrue(v.uncertain); assertEquals(SolTap.CHECK, solPrimaryTap(v))
    }
    @Test fun `a declined wallet offers RETRY only while the owner itself can pay`() {
        val unpaid = saved()
        val payable = view(holding(unpaid, quoteFresh = true))
        assertEquals(MoneyStage.FAILED, payable.stage); assertTrue(payable.canRetry)
        assertEquals(SolTap.RETRY, solPrimaryTap(payable))
        // The owner is mid-check: RETRY stays drawn but cannot reach the owner (canPay is false while busy).
        val checking = view(holding(unpaid, quoteFresh = true, busy = true))
        assertEquals(MoneyStage.FAILED, checking.stage); assertFalse(checking.canRetry)
        assertEquals(SolTap.EXPLAIN, solPrimaryTap(checking))
        // The price window closed: no RETRY, the saved quote goes to recovery.
        val closed = view(holding(unpaid))
        assertEquals(MoneyStage.READY, closed.stage); assertFalse(closed.canRetry); assertEquals(SOL_RECOVER_FIRST, closed.reason)
    }
    @Test fun `confirm reaches the owner only from an idle available matching review`() {
        assertEquals(SolConfirm.BUY, solConfirmTap(view(ready())))
        assertFalse(view(ready(), busy = true).canConfirm)
        assertFalse(view(ready(), paying = true).canConfirm)
        assertFalse(view(ready().copy(busy = true)).canConfirm)
        assertFalse(view(ready().copy(loaded = false)).canConfirm)
        assertFalse(view(holding(saved()).copy(review = builder)).canConfirm)
        for (paused in listOf(ready().copy(supported = false), ready().copy(enabled = false))) {
            val v = view(paused)
            assertFalse(v.canConfirm); assertFalse(v.canRaise); assertEquals(SOL_NOT_AVAILABLE, v.reason)
        }
        // While the availability probe is still asking (owner busy), "not available" is not claimed yet.
        assertNull(view(ready().copy(supported = false, busy = true)).reason)
        assertFalse(solPurchaseView(ready(), "builder", null, null, paying = false, busy = false).canRaise)
    }
    @Test fun `the Seal carries the owner fee line and the land it grows to`() {
        assertEquals(SOL_NETWORK_FEE, solFeeLine(builder))
        assertNull(solFeeLine(null))
        // A Mine step also spends Shards and starts a build timer: the owner screen's own line, not a second wording.
        assertTrue(requireNotNull(solFeeLine(paidOffer("mine"))).contains("SHARDS"))
        val gets = requireNotNull(expandSealGets(16))
        assertEquals("16×16", gets.amount); assertEquals("layout", gets.icon); assertEquals("16×16 land", gets.description)
        assertNull(expandSealGets(null))
    }
    @Test fun `Builders HIRE shows the money stage or Being checked or the owner refusal`() {
        val sheet = BuildersSheetUi(2, 1, 4, emptyList(), HireBuilderUi(3, PriceUi(Currency.SOL, "10", PriceStatus.OK), null),
            loading = false, error = null)
        val priced = buildersWithPurchase(sheet, view(ready()), recovery = false)
        // The owner's review price replaces the catalogue's only when both are known.
        assertEquals("0.5", priced.hire?.price?.amount); assertEquals(HireKind.HIRE, hire(priced))
        assertEquals(HireKind.MONEY, hire(buildersWithPurchase(sheet, view(ready(), paying = true), false)))
        assertEquals(HireKind.CHECKING, hire(buildersWithPurchase(sheet, view(holding(saved(attempted = true))), true)))
        val blocked = buildersWithPurchase(sheet, view(holding(saved("expansion"))), recovery = true)
        assertEquals(HireKind.OFF, hire(blocked)); assertEquals(SOL_RECOVER_FIRST, blocked.hire?.offReason)
        assertTrue(blocked.recovery)
        // An unavailable catalogue hire (orders paused) stays off even when the owner has a price.
        val off = sheet.copy(hire = sheet.hire?.copy(price = PriceUi(Currency.SOL, "10", PriceStatus.UNAVAILABLE)))
        assertEquals(HireKind.OFF, hire(buildersWithPurchase(off, view(ready()), false)))
    }
    @Test fun `EXPAND keeps a payment in flight visible even on a paused base`() {
        val expand = ExpandUi(index = 0, max = 6, sizeNow = 14, sizeNext = 16, newTiles = null, obstaclesInRing = null, reqKeepLevel = 3,
            keepLevel = 6, price = PriceUi(Currency.SOL, "0.15", PriceStatus.OK), nextReqKeepLevel = 6, ring = RectTiles(7, 7, 16, 16),
            saved = null, readOnly = "Expansion is unavailable right now", reviewHint = "Review before payment")
        val checking = expandWithPurchase(expand, view(holding(saved("expansion", attempted = true)), "expansion"), recovery = true)
        assertEquals(ExpandPrimaryKind.CHECK, expandPrimary(checking)); assertTrue(checking.recovery)
        val wallet = expandWithPurchase(expand.copy(readOnly = null), view(ready(paidOffer("expansion")), "expansion", paying = true), false)
        assertEquals(ExpandPrimaryKind.MONEY, expandPrimary(wallet)); assertEquals(MoneyStage.CHECK_WALLET, wallet.saved?.stage)
        val open = expandWithPurchase(expand.copy(readOnly = null), view(ready(paidOffer("expansion")), "expansion"), false)
        assertEquals(ExpandPrimaryKind.EXPAND, expandPrimary(open)); assertNull(open.reviewHint)
        assertEquals("0.15", open.price.amount)
        val blocked = expandWithPurchase(expand.copy(readOnly = null), view(holding(saved()), "expansion"), true)
        assertEquals(ExpandPrimaryKind.READ_ONLY, expandPrimary(blocked)); assertEquals(SOL_RECOVER_FIRST, blocked.readOnly)
    }
    @Test fun `only the candidate free expansion keeps its review screen`() {
        assertTrue(expandInPlace(hasPurchase = true, testExpansion = false))
        assertFalse(expandInPlace(hasPurchase = true, testExpansion = true))
        assertFalse(expandInPlace(hasPurchase = false, testExpansion = false))
    }

    private fun hire(ui: BuildersSheetUi): HireKind {
        val h = requireNotNull(ui.hire)
        return hireKind(h.price, h.stage, h.checking)
    }
}
