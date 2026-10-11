package gg.pixelkingdomwars.nativeclient.seekerauction

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class SeekerAuctionRecoveryTest {
    private val p = SeekerAuctionProtocol(AuctionFixtures.policy)
    private fun attempt() = SeekerAuctionSignedAttempt(AuctionFixtures.signature, AuctionFixtures.other, AuctionFixtures.other, "11")
    private fun status(found: Boolean? = null, height: String? = null) = p.status(AuctionFixtures.status(found, height))
    @Test fun `lost POST retains signature and only offers an observation`() {
        val saved = attempt(); val result = seekerAuctionRecovery(saved, null)
        assertEquals(saved, result.attempt); assertEquals(saved.signature, result.nextCheckSignature)
        assertEquals(SeekerAuctionRecoveryPhase.PENDING, result.phase); assertFalse(result.canOfferFreshIntent)
    }
    @Test fun `found false without usable signed height is not expiry`() {
        val result = seekerAuctionRecovery(attempt().copy(lastValidBlockHeight = null), status(false, "12"))
        assertFalse(result.canOfferFreshIntent)
    }
    @Test fun `missing observation pair remains pending despite a prepared height`() {
        assertEquals(SeekerAuctionRecoveryPhase.PENDING, seekerAuctionRecovery(attempt(), status()).phase)
    }
    @Test fun `expiry requires strictly greater finalized height`() {
        for (height in listOf("10", "11")) assertFalse(seekerAuctionRecovery(attempt(), status(false, height)).canOfferFreshIntent)
        assertTrue(seekerAuctionRecovery(attempt(), status(false, "12")).canOfferFreshIntent)
    }
    @Test fun `known pending signature cannot expire from block height alone`() {
        assertFalse(seekerAuctionRecovery(attempt(), status(true, "999")).canOfferFreshIntent)
    }
    @Test fun `wallet refreshed blockhash invalidates original expiry height`() {
        val result = seekerAuctionRecovery(attempt().copy(signedBlockhash = AuctionFixtures.wallet), status(false, "999"))
        assertEquals(SeekerAuctionRecoveryPhase.PENDING, result.phase); assertFalse(result.canOfferFreshIntent)
    }
    @Test fun `opaque send never borrows the prepare validity height`() {
        assertFalse(seekerAuctionRecovery(attempt().copy(opaqueSend = true), status(false, "999")).canOfferFreshIntent)
    }
    @Test fun `unknown signed blockhash cannot use original height`() {
        assertFalse(seekerAuctionRecovery(attempt().copy(signedBlockhash = null), status(false, "999")).canOfferFreshIntent)
    }
    @Test fun `another signature cannot resolve the saved attempt`() {
        val other = p.status(AuctionFixtures.change(AuctionFixtures.status(), "signature", JsonPrimitive(AuctionFixtures.otherSignature)))
        assertThrows(Exception::class.java) { seekerAuctionRecovery(attempt(), other) }
    }
    @Test fun `finalized receipt is retained across a later missing response`() {
        val raw = AuctionFixtures.change(AuctionFixtures.change(AuctionFixtures.status(), "status", JsonPrimitive("finalized")), "slot", JsonPrimitive("13"))
        val first = seekerAuctionRecovery(attempt(), p.status(raw))
        val retained = seekerAuctionRecovery(attempt(), null, first)
        assertEquals(SeekerAuctionRecoveryPhase.FINALIZED, retained.phase); assertEquals(first.receipt, retained.receipt)
        assertFalse(retained.canOfferFreshIntent)
    }
    @Test fun `finalized error is failure not expired or a new intent`() {
        val raw = AuctionFixtures.change(AuctionFixtures.change(AuctionFixtures.change(AuctionFixtures.status(), "status", JsonPrimitive("failed")),
            "slot", JsonPrimitive("13")), "error", JsonPrimitive("CHAIN_TRANSACTION_FAILED"))
        val result = seekerAuctionRecovery(attempt(), p.status(raw))
        assertEquals(SeekerAuctionRecoveryPhase.FAILED, result.phase); assertFalse(result.canOfferFreshIntent)
    }
    @Test fun `previous recovery is bound to exact retained attempt`() {
        val previous = seekerAuctionRecovery(attempt(), status(false, "12"))
        assertThrows(Exception::class.java) { seekerAuctionRecovery(attempt().copy(signature = AuctionFixtures.otherSignature), null, previous) }
    }
    @Test fun `u64 height comparison never narrows through Double or Long`() {
        val saved = attempt().copy(lastValidBlockHeight = "18446744073709551614")
        assertTrue(seekerAuctionRecovery(saved, status(false, "18446744073709551615")).canOfferFreshIntent)
    }
    @Test fun `later not-found observation cannot replace retained finalized evidence`() {
        val raw = AuctionFixtures.change(AuctionFixtures.change(AuctionFixtures.status(), "status", JsonPrimitive("finalized")), "slot", JsonPrimitive("13"))
        val previous = seekerAuctionRecovery(attempt(), p.status(raw))
        val retained = seekerAuctionRecovery(attempt(), status(false, "999"), previous)
        assertEquals(SeekerAuctionRecoveryPhase.FINALIZED, retained.phase); assertEquals(previous.receipt, retained.receipt)
        assertFalse(retained.canOfferFreshIntent)
    }
    @Test fun `later not-found observation cannot replace retained failed evidence`() {
        val raw = AuctionFixtures.change(AuctionFixtures.change(AuctionFixtures.change(AuctionFixtures.status(), "status", JsonPrimitive("failed")),
            "slot", JsonPrimitive("13")), "error", JsonPrimitive("CHAIN_TRANSACTION_FAILED"))
        val previous = seekerAuctionRecovery(attempt(), p.status(raw))
        val retained = seekerAuctionRecovery(attempt(), status(false, "999"), previous)
        assertEquals(SeekerAuctionRecoveryPhase.FAILED, retained.phase); assertEquals(previous.receipt, retained.receipt)
        assertFalse(retained.canOfferFreshIntent)
    }

}
