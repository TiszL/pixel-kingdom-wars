package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.wallet.SignatureLanding
import org.junit.Assert.*
import org.junit.Test

/** The shared rule behind every store's `retireUnpaidAttempt`. Retiring too early is a double payment, so each leg is
 * pinned here with the reason it exists. */
class UnpaidAttemptTest {
    private val margin = UnpaidAttempt.MARGIN_MS

    /** clientlib 2.0.7 allows ~30 s to associate + 90 s to authorize + 90 s for sign_and_send, and sign_and_send lets
     * the wallet name a FRESH blockhash: broadcast at attempt + ~210 s, able to land until ~attempt + 330 s. The first
     * cut's five minutes (300 s) sat below that. */
    @Test fun `the margin is above the latest moment a protocol-following wallet's payment can still land`() {
        val associate = 30_000L; val authorize = 90_000L; val signAndSend = 90_000L; val freshBlockhashLands = 120_000L
        assertTrue(margin > associate + authorize + signAndSend + freshBlockhashLands)
        assertEquals(10 * 60_000L, margin)
    }
    @Test fun `the margin runs from the latest stamp, and older journals keep their own fallbacks`() {
        // Start only (a journal of the previous version, or a process killed under the wallet sheet).
        assertFalse(UnpaidAttempt.oldEnough(1_000L, null, null, 1_000L + margin - 1)); assertTrue(UnpaidAttempt.oldEnough(1_000L, null, null, 1_000L + margin))
        // The wallet step ended 210 s after the start: the wallet could broadcast until then.
        assertFalse(UnpaidAttempt.oldEnough(1_000L, 211_000L, null, 1_000L + margin)); assertFalse(UnpaidAttempt.oldEnough(1_000L, 211_000L, null, 211_000L + margin - 1))
        assertTrue(UnpaidAttempt.oldEnough(1_000L, 211_000L, null, 211_000L + margin))
        // A device clock set back during the wallet step cannot put the end before the start.
        assertFalse(UnpaidAttempt.oldEnough(300_000L, 100_000L, null, 300_000L + margin - 1)); assertTrue(UnpaidAttempt.oldEnough(300_000L, 100_000L, null, 300_000L + margin))
        // A stamp always wins over the quote deadline, however old that deadline is.
        assertFalse(UnpaidAttempt.oldEnough(1_000L, null, 0L, 1_000L + margin - 1))
        // No stamp at all (before either existed): the quote's own deadline, strictly MORE than the new margin past.
        assertFalse(UnpaidAttempt.oldEnough(null, null, 5_000L, 5_000L + margin)); assertTrue(UnpaidAttempt.oldEnough(null, null, 5_000L, 5_000L + margin + 1))
        assertFalse("Unknown age retires nothing", UnpaidAttempt.oldEnough(null, null, null, Long.MAX_VALUE))
    }
    @Test fun `a recorded signature is cleared only by a finalized error or a null proven final against a saved height`() {
        assertTrue(UnpaidAttempt.cleared(null, null, null)); assertTrue(UnpaidAttempt.cleared(null, null, 500L))
        for (verdict in SignatureLanding.entries) assertFalse("A verdict with no signature recorded", UnpaidAttempt.cleared(null, verdict, 500L))
        assertFalse("RPC unavailable", UnpaidAttempt.cleared("sig", null, 500L))
        assertFalse(UnpaidAttempt.cleared("sig", SignatureLanding.PRESENT, 500L)); assertFalse(UnpaidAttempt.cleared("sig", SignatureLanding.UNPROVEN, 500L))
        assertTrue(UnpaidAttempt.cleared("sig", SignatureLanding.NOT_FOUND, 500L))
        assertFalse("No saved height: a null status can never be proven final", UnpaidAttempt.cleared("sig", SignatureLanding.NOT_FOUND, null))
        assertTrue(UnpaidAttempt.cleared("sig", SignatureLanding.FAILED_FINALIZED, 500L)); assertTrue(UnpaidAttempt.cleared("sig", SignatureLanding.FAILED_FINALIZED, null))
    }
    /** With no signature the device knows only that the server ended the payment unpaid and the margin passed. It
     * must not state as chain fact that nothing was charged: the wallet is the only witness of what it sent. */
    @Test fun `without a signature the notice claims nothing about the chain and points a charged player to support`() {
        for (deposit in listOf(false, true)) {
            val soft = UnpaidAttempt.notice(null, deposit)
            assertFalse(soft, soft.contains("NOTHING WAS")); assertFalse(soft, soft.contains("NEVER")); assertFalse(soft, soft.contains("YOU CAN"))
            assertTrue(soft, soft.contains("ON OUR SIDE") && soft.contains("WALLET") && soft.contains("CONTACT SUPPORT BEFORE")); assertEquals(soft, soft.uppercase())
            // The cluster answered for these, so they stay factual.
            assertTrue(UnpaidAttempt.notice(SignatureLanding.NOT_FOUND, deposit).contains("NOTHING WAS"))
            assertTrue(UnpaidAttempt.notice(SignatureLanding.FAILED_FINALIZED, deposit).contains("NETWORK FEE"))
        }
    }
}
