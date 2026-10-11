package gg.pixelkingdomwars.nativeclient.ui.goldforge

import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.ui.economy.GemsBuyReview
import gg.pixelkingdomwars.nativeclient.ui.home.HomeRouteIdentity
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.MoneyStage
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.GemsActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.gemsFooterLook
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.gemsFooterTap
import java.io.File
import java.math.BigInteger
import org.junit.Assert.*
import org.junit.Test

/** The Home-mounted GEMS binding's tap routing and mapping. Every money step stays with GemsBuyViewModel; these rules decide
 *  only which existing owner call a tap reaches, or what the player is told instead. */
class GoldForgeGemsBindingTest {
    private val wallet = "1".repeat(31) + "2"
    private val quote = GemsBuyIntent("00000000-0000-4000-8000-000000000001", "gems_buy", wallet,
        "original-key-123", "1".repeat(31) + "3", "1".repeat(31) + "4", "1".repeat(31) + "5",
        "1".repeat(31) + "6", 6, 7, 7, "2026-10-05T12:00:00Z")
    private val cap = GemsCapability(true, listOf("wallet-keep"), quote.destination, 1, 17, 3, 91)
    private val wideCap = GemsCapability(true, listOf("wallet-keep"), quote.destination, 1, 17, 1, 5000)
    private val bounds = KeepDepositBounds(BigInteger("1000000"), 6, 1, 2, 3)
    private val funds = WalletFunds("1", mapOf("KEEP" to "23"), 1)
    private val identity = HomeRouteIdentity(Any(), "base-1", 0)
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
    private fun credited() = reviewed().copy(saved = saved().copy(attempted = true, observed = deposit("credited", receipt())),
        hydrated = true)
    private fun map(state: GemsBuyState = GemsBuyState(available = true, capability = cap), review: GemsBuyReview? = null,
        amount: String = "7", paying: Boolean = false, running: Boolean = false) =
        goldForgeGemsOwner(state, review, wallet, funds, amount, bounds, running, paying)
    private fun source(path: String) = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/$path").readText()

    @Test fun `chip labels map back to raw amounts and MAX resolves from wallet KEEP`() {
        assertEquals("1000", goldForgeGemsQuickRaw("1,000", wideCap))
        // A preset outside this server's bounds is never shown, so its label maps to nothing.
        assertNull(goldForgeGemsQuickRaw("1,000", cap))
        assertEquals("1000" to null, goldForgeGemsQuickPick("1,000", wideCap, funds))
        // MAX = min(whole wallet KEEP, server max): the wallet decides when it is lower, the server when it is higher.
        assertEquals("23" to null, goldForgeGemsQuickPick("MAX", wideCap, funds))
        assertEquals("5000" to null, goldForgeGemsQuickPick("MAX", wideCap, funds.copy(tokens = mapOf("KEEP" to "9000.75"))))
        // An unknown wallet balance is never guessed.
        assertEquals(null to "Refresh your wallet balance before choosing MAX.", goldForgeGemsQuickPick("MAX", wideCap, null))
        assertEquals(null to "Choose a whole amount from 1 to 5,000 KEEP.", goldForgeGemsQuickPick("250", wideCap, funds))
    }

    @Test fun `a pending shortfall blanks the amount so the owner prefills it at the server rate`() {
        val pending = GoldForgeGemsShortfall(identity, "80", "Workshop finish", "building-1")
        assertEquals("", goldForgeGemsAmountArg("700", pending))
        assertEquals("700", goldForgeGemsAmountArg("700", null))
        val ui = goldForgeGemsOwner(GemsBuyState(available = true, capability = cap.copy(gemsPerKeep = 3)), null, wallet, funds,
            goldForgeGemsAmountArg("", pending), bounds, shortfallGems = pending.gems, shortfallFor = pending.forWhat)
        assertEquals("27", ui.amountInput)
        assertEquals("80", ui.gems.short); assertEquals("Workshop finish", ui.gems.shortfallFor)
    }

    @Test fun `the shortfall box holds one offer until the binding uses it`() {
        val box = GoldForgeGemsShortfallBox()
        assertNull(box.pending)
        val first = GoldForgeGemsShortfall(identity, "80", "Workshop finish", "building-1")
        box.offer(first); assertEquals(first, box.pending)
        val second = first.copy(gems = "120")
        box.offer(second); assertEquals(second, box.pending)
        box.clear(); assertNull(box.pending)
    }

    @Test fun `the Seal rises only for a review the player asked for`() {
        val state = reviewed(); val review = GemsBuyReview(quote, "5000")
        // A review that merely exists (another path, a restore) must never raise consent by itself.
        assertFalse(goldForgeGemsShouldFreeze(review, null, false, state, wallet, false, false))
        assertTrue(goldForgeGemsShouldFreeze(review, null, true, state, wallet, false, false))
        // Still preparing: the arming bar must not start before the review is confirmable.
        assertFalse(goldForgeGemsShouldFreeze(review, null, true, state, wallet, false, true))
        assertFalse(goldForgeGemsShouldFreeze(review, review, true, state, wallet, false, false))
        assertFalse(goldForgeGemsShouldFreeze(null, null, true, state, wallet, false, false))
        assertFalse(goldForgeGemsShouldFreeze(review, null, true, state.copy(fresh = false), wallet, false, false))
        // A request already in the wallet shows its wallet step again; that is not a new consent.
        assertTrue(goldForgeGemsShouldFreeze(review, null, false, state, wallet, true, true))
    }

    @Test fun `the celebration plays only for a receipt not already saved at entry`() {
        val owner = map(credited())
        val key = requireNotNull(owner.celebration).key
        assertNull(goldForgeGemsCelebrationShown(owner, goldForgeGemsReceiptAtEntry(credited(), wallet)))
        val shown = requireNotNull(goldForgeGemsCelebrationShown(owner, null))
        assertEquals(key, shown.key)
        val party = requireNotNull(goldForgeGemsCelebrationUi(shown))
        assertEquals(key, party.receiptId); assertEquals("+7 GEMS", party.ribbon); assertEquals("Added to your Gems", party.line)
        assertEquals("+7", goldForgeGemsGain(shown))
        assertEquals("+1,500", goldForgeGemsGain(GoldForgeGemsCelebration("receipt", "1500", "1500")))
        assertNull(goldForgeGemsGain(null)); assertNull(goldForgeGemsCelebrationUi(null))
    }

    @Test fun `refused edits say why instead of doing nothing`() {
        val open = GemsBuyState(available = true, capability = cap)
        assertNull(goldForgeGemsEditRefusal(open, false, false))
        assertEquals(GEMS_PAYING_BACK, goldForgeGemsEditRefusal(reviewed(), false, true))
        assertEquals("Check the original saved purchase first.", goldForgeGemsEditRefusal(reviewed(), false, false))
        assertEquals("A wallet purchase is already being checked.", goldForgeGemsEditRefusal(open, true, false))
        assertEquals("A wallet purchase is already being checked.", goldForgeGemsEditRefusal(open.copy(busy = true), false, false))
        assertEquals("Purchase availability has not been confirmed. Refresh status to try again.",
            goldForgeGemsEditRefusal(GemsBuyState(), false, false))
    }

    @Test fun `CONTINUE reaches the one owner step the saved purchase allows`() {
        val review = GemsBuyReview(quote, "5000")
        assertEquals(GoldForgeGemsContinue.RAISE_SEAL, goldForgeGemsContinue(map(reviewed(), review), reviewed(), false))
        assertEquals(GoldForgeGemsContinue.RAISE_SEAL, goldForgeGemsContinue(map(reviewed(), review, paying = true), reviewed(), true))
        assertEquals(GoldForgeGemsContinue.REVIEW_SAVED, goldForgeGemsContinue(map(reviewed()), reviewed(), false))
        val attempted = reviewed().copy(saved = saved().copy(attempted = true, signature = "2".repeat(88)))
        // Once the wallet may have paid, only a GET check is allowed: never a second review.
        assertEquals(GoldForgeGemsContinue.CHECK, goldForgeGemsContinue(map(attempted), attempted, false))
        assertEquals(GoldForgeGemsContinue.EXPLAIN, goldForgeGemsContinue(map(attempted, running = true), attempted, false))
        assertEquals(GoldForgeGemsContinue.FINISH, goldForgeGemsContinue(map(credited()), credited(), false))
        val expired = reviewed().copy(saved = saved().copy(observed = deposit("expired")))
        assertEquals(GoldForgeGemsContinue.CHECK, goldForgeGemsContinue(map(expired), expired, false))
    }

    @Test fun `an off BUY explains the owner reason and the moss SENT face finishes`() {
        val off = map(amount = "2").gems
        val look = requireNotNull(gemsFooterLook(off))
        assertEquals(CommandState.DISABLED, look.state)
        assertEquals("Choose a whole amount from 3 to 91 KEEP.", look.reason)
        val said = mutableListOf<String>(); var bought = 0; var continued = 0
        val on = GemsActions(onBuy = { bought++ }, onContinue = { continued++ }, onExplain = { said += it })
        gemsFooterTap(look, off, on)
        assertEquals(listOf("Choose a whole amount from 3 to 91 KEEP."), said); assertEquals(0, bought)
        val ready = map().gems
        gemsFooterTap(requireNotNull(gemsFooterLook(ready)), ready, on)
        assertEquals(1, bought)
        val sent = map(credited()).gems
        assertEquals(MoneyStage.SENT, sent.stage)
        gemsFooterTap(requireNotNull(gemsFooterLook(sent)), sent, on)
        assertEquals(1, continued)
    }

    @Test fun `a saved state the face cannot act on draws the recovery plate instead`() {
        val expired = reviewed().copy(saved = saved().copy(observed = deposit("expired")))
        assertNull(goldForgeGemsBindingUi(map(expired), expired, true))
        val open = GemsBuyState(available = true, capability = cap)
        assertTrue(requireNotNull(goldForgeGemsBindingUi(map(open), open, true)).toShardsAvailable)
        // No CONVERT door: the row must not show a button that cannot act.
        assertFalse(requireNotNull(goldForgeGemsBindingUi(map(open), open, false)).toShardsAvailable)
    }

    @Test fun `the old route restores the a51 one-way and fee sentences`() {
        val route = source("ui/economy/GemsBuyScreen.kt")
        assertTrue(route.contains("One-way purchase. Gems stay in the game and cannot be withdrawn or converted back to KEEP."))
        assertTrue(route.contains("signing closes earlier for network safety."))
        assertFalse(route.contains("This one-way purchase spends"))
        assertFalse(route.contains("Signing closes before the quote expiry"))
        assertTrue(route.contains("GoldForgeGemsRecovery("))
    }

    @Test fun `the binding buys in place through the existing owner only`() {
        val binding = source("ui/goldforge/GoldForgeGemsBinding.kt")
        assertFalse(binding.contains("GemsBuyRoute")); assertFalse(binding.contains("navigate("))
        assertTrue(binding.contains("model.pay(selected, sender)"))
        assertTrue(binding.contains("goldForgeGemsCanConfirm(selected, model.review.value"))
        assertFalse(binding.contains("sender.send("))
    }
}
