package gg.pixelkingdomwars.nativeclient.ui.economy

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.wallet.ChainAddresses
import gg.pixelkingdomwars.nativeclient.ops.*
import gg.pixelkingdomwars.nativeclient.ui.chrome.PaymentTone
import gg.pixelkingdomwars.nativeclient.workshop.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Presentation must never turn an attempt, signature, or elapsed deadline into completion. */
class EconomyPresentationTest {
    private val intent = PendingIntent(IntentKind.GEMS_TO_SHARDS, DEPOSIT_SOURCE, "00000000-0000-4000-8000-000000000020",
        "gems-presentation-key", "/gems/convert", buildJsonObject { put("gems", "17") }, "Gems conversion")
    private val quote = GemsBuyIntent(DEPOSIT_ID, "gems_buy", DEPOSIT_SOURCE, "gems-presentation-key", DEPOSIT_REFERENCE,
        DEPOSIT_SOURCE, DEPOSIT_DEST, ChainAddresses.DEVNET.keepMint, 9, 17, 17, "2026-09-21T12:30:00Z")
    private val purchase = SavedGemsBuy(GemsBuyDraft(quote.wallet, "https://game.example", "devnet", quote.idempotencyKey, 17), quote)
    private fun observed(status: String, receipt: GemsBuyReceipt? = null) = GemsBuyDeposit(quote, status,
        if (receipt == null) null else DEPOSIT_SIGNATURE, null, if (receipt == null) null else "17000000000", "2026-09-21T12:00:00Z",
        null, 17, 17, if (receipt == null) null else "0", if (receipt == null) null else "17", if (receipt == null) null else "17", receipt)
    private val command = WorkshopCommand("start", "00000000-0000-4000-8000-000000000020", "workshop-presentation-key", 2, null, 1, 10, 1, 60, "free_wallet")
    private val job = WorkshopJob("00000000-0000-4000-8000-000000000021", 2, "20", 1, 1,
        "2020-01-01T00:00:00Z", "2020-01-01T00:02:00Z", false, null, "free_wallet")

    @Test fun `a saved or attempted Gems conversion never displays confirmed without its receipt`() {
        assertEquals(PaymentTone.OPEN, gemsSavedPill(intent).tone)
        assertEquals(PaymentTone.TROUBLE, gemsSavedPill(intent.copy(attempted = true)).tone)
        val retained = intent.copy(attempted = true, receipt = buildJsonObject { put("status", "accepted") })
        assertEquals("CONFIRMED", gemsSavedPill(retained).label)
    }

    @Test fun `wallet signature and quote expiry keep purchase recovery visible without claiming credit`() {
        val signed = purchase.copy(attempted = true, signature = DEPOSIT_SIGNATURE)
        assertEquals("CHECK PAYMENT", gemsBuySavedPill(signed, false).label)
        assertEquals(PaymentTone.TROUBLE, gemsBuySavedPill(signed.copy(observed = observed("expired")), false).tone)
        assertEquals("REVIEW", gemsBuySavedPill(purchase, false).label)
    }

    @Test fun `opening the wallet announces the pending handoff and not a credit`() {
        assertEquals("WALLET OPEN", gemsBuySavedPill(purchase.copy(attempted = true), true).label)
        assertNotEquals(PaymentTone.DONE, gemsBuySavedPill(purchase.copy(attempted = true), true).tone)
    }

    @Test fun `only original receipt shows credited even if wallet activity finishes late`() {
        val receipt = GemsBuyReceipt(1, "00000000-0000-4000-8000-000000000018", "2026-09-21T12:01:00Z",
            quote.wallet, quote.id, DEPOSIT_SIGNATURE, GemsBuyFunding("KEEP", "17", "17000000000"), GemsBuyResult("GEMS", "17", 1))
        val credited = purchase.copy(attempted = true, signature = DEPOSIT_SIGNATURE, observed = observed("credited", receipt))
        assertEquals("CREDITED", gemsBuySavedPill(credited, true).label)
        assertEquals(PaymentTone.DONE, gemsBuySavedPill(credited, false).tone)
    }

    @Test fun `an old refining deadline cannot replace server readiness`() {
        assertEquals("REFINING", workshopJobPill(job).label)
        assertEquals("READY", workshopJobPill(job.copy(ready = true)).label)
        assertEquals("COLLECTED", workshopJobPill(job.copy(ready = true, collectedAt = "2020-01-01T00:03:00Z")).label)
    }

    @Test fun `saved workshop draft and lost start response do not claim a completed job`() {
        val draft = WorkshopOperation(command, false, null, null)
        assertEquals("SAVED DRAFT", workshopSavedPill(draft).label)
        assertEquals("CHECK OUTCOME", workshopSavedPill(draft.copy(attempted = true)).label)
        assertEquals("DECLINED", workshopSavedPill(draft.copy(attempted = true, refusal = WorkshopRefusal(422, "HOLDING_CAP_EXCEEDED"))).label)
    }

    @Test fun `original workshop duration uses frozen quantity and seconds without overflowing`() {
        assertEquals("2m", workshopDuration(2, 60))
        assertEquals("18,446,744,073,709,551,614 seconds", workshopDuration(2, Long.MAX_VALUE))
    }
}
