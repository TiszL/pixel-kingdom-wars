package gg.pixelkingdomwars.nativeclient.ui.goldforge

import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.ui.economy.GemsBuyReview
import gg.pixelkingdomwars.nativeclient.ui.model.MoneyStage
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.GemsPhase
import org.junit.Assert.*
import org.junit.Test
import java.math.BigInteger

/** Tests authored before the a30 owner projection. Execution belongs to Cedar3. */
class GoldForgeGemsOwnerTest {
    private val wallet = "1".repeat(31) + "2"
    private val quote = GemsBuyIntent("00000000-0000-4000-8000-000000000001", "gems_buy", wallet,
        "original-key-123", "1".repeat(31) + "3", "1".repeat(31) + "4", "1".repeat(31) + "5",
        "1".repeat(31) + "6", 6, 7, 7, "2026-10-05T12:00:00Z")
    private val cap = GemsCapability(true, listOf("wallet-keep"), quote.destination, 1, 17, 3, 91)
    private val bounds = KeepDepositBounds(BigInteger("1000000"), 6, 1, 2, 3)
    private val funds = WalletFunds("1", mapOf("KEEP" to "23"), 1)
    private fun saved() = SavedGemsBuy(GemsBuyDraft(wallet, "https://example.invalid", "devnet", quote.idempotencyKey, 7), quote)
    private fun reviewed() = GemsBuyState(saved = saved().copy(observed = deposit("pending")), available = true,
        capability = cap, fresh = true)
    private fun deposit(status: String, receipt: GemsBuyReceipt? = null) = GemsBuyDeposit(quote, status,
        receipt?.txSignature, null, if (receipt != null) "7000000" else null,
        "2026-10-05T11:00:00Z", if (receipt != null) "2026-10-05T11:01:00Z" else null,
        7, 7, if (receipt != null) "0" else null, receipt?.funding?.amount, receipt?.result?.amount, receipt)
    private fun receipt() = GemsBuyReceipt(1, "00000000-0000-4000-8000-000000000002",
        "2026-10-05T11:01:00Z", wallet, quote.id, "2".repeat(88),
        GemsBuyFunding("KEEP", "7", "7000000"), GemsBuyResult("GEMS", "7", 1))
    private fun map(state: GemsBuyState = GemsBuyState(available = true, capability = cap),
        review: GemsBuyReview? = null, amount: String = "7", paying: Boolean = false,
        running: Boolean = false, balance: WalletFunds? = funds, seal: Long? = null) =
        goldForgeGemsOwner(state, review, wallet, balance, amount, bounds, running, paying, sealArmedAtMs = seal)

    @Test fun `new purchase uses server limits rate and wallet KEEP only`() {
        val ui = map(amount = "")
        assertEquals("3", ui.amountInput)
        assertEquals("3", ui.gems.pay); assertEquals("3", ui.gems.amount)
        assertEquals("20", ui.gems.walletAfter); assertTrue(ui.canReview)
        assertNull(ui.gems.seal); assertNull(ui.celebration)
    }

    @Test fun `unknown or ambiguous wallet funds never become zero or a fabricated remainder`() {
        for (balance in listOf(null, funds.copy(tokens = mapOf("KEEP" to "23", "keep" to "999")))) {
            val ui = map(balance = balance)
            assertEquals("…", ui.gems.walletKeep); assertEquals("…", ui.gems.walletAfter)
            assertFalse(ui.gems.walletShort)
        }
    }

    @Test fun `short wallet and invalid server bounded amounts never review`() {
        assertFalse(map(balance = funds.copy(tokens = mapOf("KEEP" to "2"))).canReview)
        for (amount in listOf("0", "2", "92", "-7", "1.5", "9999999999999999999999999999999999"))
            assertFalse(map(amount = amount).canReview)
        assertFalse(goldForgeGemsOwner(GemsBuyState(available = true, capability = cap), null,
            wallet, funds, "7", null).canReview)
    }

    @Test fun `only exact current review may reach the existing pay callback`() {
        val state = reviewed(); val review = GemsBuyReview(quote, "5000")
        assertTrue(map(state, review).canPay)
        assertTrue(goldForgeGemsCanConfirm(review, review, state, wallet, false, false))
        assertFalse(goldForgeGemsCanConfirm(review.copy(), review, state, wallet, false, false))
        assertFalse(goldForgeGemsCanConfirm(review, review, state.copy(fresh = false), wallet, false, false))
        assertFalse(goldForgeGemsCanConfirm(review, review, state, wallet, true, false))
        assertFalse(goldForgeGemsCanConfirm(review, review, state, wallet, false, true))
    }

    @Test fun `review does not raise a Seal until its original details were explicitly opened`() {
        val review = GemsBuyReview(quote, "5000")
        assertNull(map(reviewed(), review).gems.seal)
        val seal = requireNotNull(map(reviewed(), review, seal = 71).gems.seal)
        assertEquals(71L, seal.armedAtMs); assertEquals("7", seal.amount); assertEquals("7", seal.pay)
    }

    @Test fun `attempted original exposes check but never review pay abandon or a replacement`() {
        val state = reviewed().copy(saved = saved().copy(attempted = true, signature = "2".repeat(88)))
        val ui = map(state, GemsBuyReview(quote, "5000"), seal = 0)
        assertTrue(ui.canCheck); assertFalse(ui.canReview); assertFalse(ui.canPay)
        assertFalse(ui.canReviewSaved); assertFalse(ui.canAbandon); assertNull(ui.gems.seal)
        assertNull(ui.celebration); assertNotEquals(MoneyStage.SENT, ui.gems.stage)
    }

    @Test fun `wallet handoff blocks every extra owner action and never means success`() {
        val ui = map(reviewed(), GemsBuyReview(quote, "5000"), paying = true, seal = 1)
        assertEquals(MoneyStage.CHECK_WALLET, ui.gems.stage)
        assertFalse(ui.canPay); assertFalse(ui.canCheck); assertFalse(ui.canAbandon)
        assertNull(ui.celebration)
    }

    @Test fun `only matching validated credited receipt plus hydration produces celebration`() {
        val receipt = receipt()
        val state = reviewed().copy(saved = saved().copy(attempted = true, observed = deposit("credited", receipt)), hydrated = true)
        val ui = map(state)
        assertEquals(MoneyStage.SENT, ui.gems.stage); assertTrue(ui.canFinish)
        assertEquals(receipt.receiptId, ui.celebration?.key); assertEquals("7", ui.celebration?.amount)
        assertNull(map(state.copy(hydrated = false)).celebration)
        assertFalse(map(state.copy(hydrated = false)).canFinish)
        assertNull(map(state.copy(saved = state.saved!!.copy(observed = deposit("credited", receipt.copy(wallet = "other"))))).celebration)
    }

    @Test fun `unpaid original preserves explicit check cancel and same request review`() {
        val ui = map(reviewed())
        assertTrue(ui.canCheck); assertTrue(ui.canAbandon); assertTrue(ui.canReviewSaved)
        assertFalse(ui.canReview); assertFalse(ui.canPay); assertFalse(ui.canFinish)
    }

    @Test fun `wrong wallet original fails closed and never borrows new purchase capability`() {
        val ui = map(reviewed().copy(saved = saved().copy(draft = saved().draft.copy(wallet = "other"))))
        assertFalse(ui.canReview); assertFalse(ui.canPay); assertFalse(ui.canCheck)
        assertFalse(ui.canAbandon); assertNull(ui.gems.seal); assertNull(ui.celebration)
    }

    @Test fun `stepper uses current server minimum maximum and no overflow`() {
        assertEquals("3", goldForgeGemsStep("", -1, cap))
        assertEquals("91", goldForgeGemsStep("91", 1, cap))
        assertEquals("3", goldForgeGemsStep("3", -1, cap))
        assertEquals("8", goldForgeGemsStep("7", 1, cap))
    }

    @Test fun `invalid amount has no enabled purchase action`() {
        val ui = map(amount = "2")
        assertFalse(ui.canReview)
        assertFalse(ui.gems.actionsAllowed)
        assertNotNull(ui.explanation)
    }

    @Test fun `observed payment evidence remains recovery only even before attempted publication`() {
        val observed = deposit("finalized").copy(txSignature = "2".repeat(88), amount = "7000000", dustBaseUnits = "0")
        val state = reviewed().copy(saved = saved().copy(observed = observed))
        val ui = map(state, GemsBuyReview(quote, "5000"), seal = 1)
        assertTrue(ui.canCheck)
        assertFalse(ui.canPay); assertFalse(ui.canReviewSaved); assertFalse(ui.canAbandon)
        assertEquals("…", ui.gems.walletAfter)
        assertNull(ui.celebration); assertNull(ui.gems.seal)
    }

    @Test fun `different original quote never borrows a current review`() {
        val state = reviewed().copy(saved = saved().copy(observed = deposit("pending").copy(
            originalIntent = quote.copy(idempotencyKey = "another-original-key"))))
        val review = GemsBuyReview(quote, "5000")
        assertFalse(goldForgeGemsCanConfirm(review, review, state, wallet, false, false))
        assertNull(map(state, review, seal = 1).gems.seal)
    }

    @Test fun `saved receipt is already seen at entry even before balance hydration`() {
        val receipt = receipt()
        val original = reviewed().copy(saved = saved().copy(attempted = true, observed = deposit("credited", receipt)))
        assertEquals(receipt.receiptId, goldForgeGemsReceiptAtEntry(original, wallet))
        assertEquals(receipt.receiptId, goldForgeGemsReceiptAtEntry(original.copy(hydrated = true), wallet))
        assertNull(goldForgeGemsReceiptAtEntry(reviewed(), wallet))
        assertNull(goldForgeGemsReceiptAtEntry(original, "another-wallet"))
    }

    @Test fun `active handoff moves to sending only once original signature evidence exists`() {
        val state = reviewed().copy(saved = saved().copy(attempted = true, signature = "2".repeat(88)))
        val ui = map(state, GemsBuyReview(quote, "5000"), paying = true, seal = 1)
        assertEquals(MoneyStage.SENDING, ui.gems.stage)
        assertFalse(ui.canPay); assertFalse(ui.canCheck); assertFalse(ui.canReviewSaved)
        assertFalse(ui.canAbandon); assertNull(ui.celebration)
    }

    @Test fun `credit amount comes from the matching receipt rather than the requested amount`() {
        val actual = receipt().copy(funding = GemsBuyFunding("KEEP", "9", "9000000"), result = GemsBuyResult("GEMS", "9", 1))
        val observed = deposit("credited", actual).copy(amount = "9000000")
        val ui = map(reviewed().copy(saved = saved().copy(attempted = true, observed = observed), hydrated = true))
        assertTrue(ui.canFinish)
        assertEquals("9", ui.celebration?.amount); assertEquals("9", ui.celebration?.fundedKeep)
        assertEquals("9", ui.gems.amount); assertEquals("9", ui.gems.pay)
    }

    @Test fun `unhydrated credited receipt offers balance recovery rather than purchase or finish`() {
        val state = reviewed().copy(saved = saved().copy(attempted = true, observed = deposit("credited", receipt())))
        val ui = map(state)
        assertTrue(ui.needsBalanceRefresh); assertTrue(ui.canCheck)
        assertEquals(GemsPhase.LOADING, ui.gems.phase)
        assertFalse(ui.canReview); assertFalse(ui.canPay); assertFalse(ui.canReviewSaved); assertFalse(ui.canFinish)
        assertNull(ui.gems.seal); assertNull(ui.celebration)
    }

    // ---- S2: the Home-mounted GEMS face (design correction a to d). No earlier case pinned the old [min, MAX] chips.

    private val wideCap = GemsCapability(true, listOf("wallet-keep"), quote.destination, 1, 17, 1, 5000)
    private val wideFunds = WalletFunds("1", mapOf("KEEP" to "2480"), 1)
    private fun wide(amount: String, shortfall: String? = null, forWhat: String? = null) =
        goldForgeGemsOwner(GemsBuyState(available = true, capability = wideCap), null, wallet, wideFunds, amount, bounds,
            shortfallGems = shortfall, shortfallFor = forWhat)

    @Test fun `quick chips keep only the presets the server admits and always end with MAX`() {
        // The frame's 100, 500 and 1,000 are suggestions: a chip the server would refuse must never be offered.
        assertEquals(listOf("100" to "100", "500" to "500", "1,000" to "1000", "MAX" to "MAX"), goldForgeGemsQuickChips(wideCap))
        assertEquals(listOf("100" to "100", "500" to "500", "MAX" to "MAX"),
            goldForgeGemsQuickChips(wideCap.copy(maxConvertKeepPerTx = 999)))
        assertEquals(listOf("500" to "500", "1,000" to "1000", "MAX" to "MAX"),
            goldForgeGemsQuickChips(wideCap.copy(minConvertKeep = 101)))
        assertEquals(listOf("MAX" to "MAX"), goldForgeGemsQuickChips(cap))
        assertEquals(listOf("MAX"), map().gems.quick)
    }

    @Test fun `the selected chip follows the raw amount while its label stays grouped`() {
        assertEquals(listOf("100", "500", "1,000", "MAX"), wide("1000").gems.quick)
        assertEquals("1,000", wide("1000").gems.selectedQuick)
        assertNull(wide("999").gems.selectedQuick)
        // A saved purchase has a fixed amount: no chip may suggest changing it.
        assertTrue(map(reviewed()).gems.quick.isEmpty())
    }

    @Test fun `display amounts are grouped while the owner input stays raw`() {
        val ui = wide("1500")
        assertEquals("1500", ui.amountInput)
        assertEquals("1,500", ui.gems.amount); assertEquals("1,500", ui.gems.pay)
        assertEquals("2,480", ui.gems.walletKeep); assertEquals("980", ui.gems.walletAfter)
        assertEquals("1", ui.gems.min); assertEquals("5,000", ui.gems.max)
        assertEquals("1 KEEP = 1 GEM", ui.gems.rate)
        assertTrue(ui.canReview)
    }

    @Test fun `a shortfall prefills the whole KEEP that covers it inside the server bounds`() {
        // Ceil at the server rate: 80 Gems at 3 Gems per KEEP needs 27 KEEP, never 26.
        assertEquals("27", goldForgeGemsPrefill("80", wideCap.copy(gemsPerKeep = 3)))
        assertEquals("80", goldForgeGemsPrefill("80", wideCap))
        assertEquals("3", goldForgeGemsPrefill("1", cap))
        assertEquals("91", goldForgeGemsPrefill("500", cap))
        assertNull(goldForgeGemsPrefill("1,200", cap)); assertNull(goldForgeGemsPrefill(null, cap))
    }

    @Test fun `a shortfall line names the need and its subject only for a new purchase`() {
        val ui = wide("", shortfall = "1200", forWhat = "Workshop finish")
        assertEquals("1200", ui.amountInput)
        assertEquals("1,200", ui.gems.short); assertEquals("Workshop finish", ui.gems.shortfallFor)
        // An explicit amount wins; the binding passes a blank amount only while the shortfall is still pending.
        assertEquals("700", wide("700", shortfall = "1200").amountInput)
        // Without a pending shortfall the default stays the server minimum, never a hardcoded 500.
        assertEquals("1", wide("").amountInput); assertNull(wide("").gems.short)
        val saved = goldForgeGemsOwner(reviewed(), null, wallet, funds, "", bounds, shortfallGems = "80", shortfallFor = "Workshop finish")
        assertNull(saved.gems.short); assertNull(saved.gems.shortfallFor)
    }

    @Test fun `the Seal fee line comes only from the reviewed estimate`() {
        // The pay owner refuses a changed fee, so consent must show exactly the reviewed one.
        val review = GemsBuyReview(quote, "5000")
        assertEquals("Estimated network fee: 0.000005 SOL. Your wallet shows its final fee.",
            requireNotNull(map(reviewed(), review, seal = 71).gems.seal).feeLine)
        assertNull(goldForgeGemsFeeLine(null))
        assertNull(goldForgeGemsFeeLine(GemsBuyReview(quote, "5,000")))
        assertNull(map(reviewed(), review).gems.seal)
    }

    @Test fun `an owner refusal reaches the off primary as its reason`() {
        val ui = map(amount = "2")
        assertEquals("Choose a whole amount from 3 to 91 KEEP.", ui.explanation)
        assertEquals(ui.explanation, ui.gems.primaryReason)
    }

    @Test fun `a running owner check reads Checking while the wallet handoff keeps its stage face`() {
        // A gated "read-only" primary during the owner's own check would tell the player something false.
        assertEquals(GemsPhase.LOADING, map(reviewed(), running = true).gems.phase)
        val handoff = map(reviewed(), GemsBuyReview(quote, "5000"), paying = true, seal = 1)
        assertEquals(GemsPhase.READY, handoff.gems.phase); assertEquals(MoneyStage.CHECK_WALLET, handoff.gems.stage)
        assertTrue(handoff.gems.actionsAllowed)
    }

    @Test fun `only saved states the face cannot act on hand over to the recovery plate`() {
        assertFalse(map().recoveryOnly)
        // CONTINUE reviews the same request, so the designed face keeps it.
        assertFalse(map(reviewed()).recoveryOnly)
        // An expired unpaid original can only be cancelled, which only the recovery plate offers.
        val expired = reviewed().copy(saved = saved().copy(observed = deposit("expired")))
        assertTrue(map(expired).recoveryOnly); assertTrue(map(expired).canAbandon)
        assertTrue(map(reviewed().copy(saved = saved().copy(draft = saved().draft.copy(wallet = "other")))).recoveryOnly)
        val unhydrated = reviewed().copy(saved = saved().copy(attempted = true, observed = deposit("credited", receipt())))
        assertTrue(map(unhydrated).recoveryOnly)
        assertFalse(map(unhydrated, running = true).recoveryOnly)
        // An uncertain payment keeps the face: its primary checks the original.
        assertFalse(map(reviewed().copy(saved = saved().copy(attempted = true, signature = "2".repeat(88)))).recoveryOnly)
    }
}
