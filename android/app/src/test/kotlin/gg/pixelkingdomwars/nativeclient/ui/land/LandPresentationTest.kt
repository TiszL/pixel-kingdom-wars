package gg.pixelkingdomwars.nativeclient.ui.land

import gg.pixelkingdomwars.nativeclient.model.LandDeposit
import gg.pixelkingdomwars.nativeclient.model.WalletFunds
import gg.pixelkingdomwars.nativeclient.wallet.LandFundingEstimate
import org.junit.Assert.*
import org.junit.Test
import java.math.BigInteger

/** The land screen's presentation rules: what the FUNDING chip and the stage rail say, and why. */
class LandPresentationTest {
    private fun estimate(balance: Long, payment: Long = 200_000_000L, fee: Long = 5_000L, rent: Long = 0L) =
        LandFundingEstimate(BigInteger.valueOf(payment), BigInteger.valueOf(fee), BigInteger.valueOf(rent), BigInteger.valueOf(balance))
    private fun wallet(sol: String?) = WalletFunds(sol, emptyMap(), 0)
    private val reservation = LandDeposit(id = "d", amountLamports = "200000000")

    @Test fun `the address is shortened to four and four so the chip fits one row, and short text is left whole`() {
        assertEquals("AbCd…WxYz", shortWallet("AbCdEfGhIjKlMnOpQrStUvWxYz"))
        assertEquals("short", shortWallet("short"))
    }

    @Test fun `server SOL text becomes exact lamports and never a float, and unusable text is absent rather than zero`() {
        assertEquals(BigInteger.valueOf(1_500_000_000L), solToLamports("1.5"))
        assertEquals(BigInteger.ZERO, solToLamports("0.0000000001"))
        assertNull(solToLamports(null)); assertNull(solToLamports("n/a")); assertNull(solToLamports("-1"))
    }

    @Test fun `NEEDS amounts drop trailing zeros but never the integer part`() {
        assertEquals("0.2", solTextTrimmed(BigInteger.valueOf(200_000_000L)))
        assertEquals("1", solTextTrimmed(BigInteger.valueOf(1_000_000_000L)))
        assertEquals("1.234567891", solTextTrimmed(BigInteger.valueOf(1_234_567_891L)))
    }

    @Test fun `the client RPC estimate leads the funding chip because a fresh wallet must see funds arrive`() {
        val view = fundingView(estimate(balance = 300_000_000L), wallet("0.1"), reservation)
        assertEquals(FundingSource.RPC, view.source)
        assertEquals(BigInteger.valueOf(300_000_000L), view.balanceLamports)
        assertEquals("0.3000 SOL", view.balanceText)
        assertEquals(true, view.funded); assertNull(view.needText)
    }

    @Test fun `the server wallet read covers a wallet the RPC has not priced, against the frozen price plus fees`() {
        val view = fundingView(null, wallet("0.1"), reservation)
        assertEquals(FundingSource.SERVER, view.source)
        assertEquals(false, view.funded); assertFalse(view.feeKnown)
        assertEquals("NEEDS 0.2 SOL + FEES", view.needText)
    }

    @Test fun `a priced shortfall says INCLUDING FEES and counts rent and fee in the need`() {
        val view = fundingView(estimate(balance = 100_000_000L, rent = 1_000_000L), null, reservation)
        assertEquals(BigInteger.valueOf(201_005_000L), view.requiredLamports)
        assertEquals("NEEDS 0.201005 SOL INCLUDING FEES", view.needText)
    }

    @Test fun `an unknown balance is never shown as zero or as funded`() {
        val view = fundingView(null, wallet(null), reservation)
        assertEquals(FundingSource.NONE, view.source)
        assertEquals("BALANCE UNAVAILABLE", view.balanceText)
        assertNull("PAY must not trust an unknown balance as funded", view.funded)
        assertNull(view.needText)
    }

    @Test fun `with no reservation the chip shows the balance but has nothing to need yet`() {
        val view = fundingView(null, wallet("2"), null)
        assertEquals("2.0000 SOL", view.balanceText); assertNull(view.requiredLamports); assertNull(view.funded); assertNull(view.needText)
    }

    @Test fun `the stage rail reads as progress - done before, active at, next after the current stage`() {
        assertEquals(RailState.DONE, railState(LandStage.PAY, LandStage.PICK))
        assertEquals(RailState.ACTIVE, railState(LandStage.PAY, LandStage.PAY))
        assertEquals(RailState.NEXT, railState(LandStage.PAY, LandStage.DEED))
        assertEquals(6, LAND_STAGE_LABELS.size); assertEquals(LandStage.entries, LAND_STAGE_LABELS.map { it.first })
    }

    @Test fun `a refusal is a gate that names what was refused, not an error`() {
        assertEquals("LAND REQUIRED — Gold Forge needs land you do not own yet.", landGateMessage("refused", false, "Gold Forge"))
        assertEquals("LAND REQUIRED — That one needs land you do not own yet.", landGateMessage("refused", false))
        assertEquals("Found another keep on a second parcel.", landGateMessage("browse", true))
        assertEquals("YOUR LAND — Your keep stands on unclaimed ground.", landGateMessage("browse", false))
    }

    @Test fun `payment credit and the minted deed are separate facts on the parcel`() {
        assertEquals("RESERVED FOR YOU", parcelStatusLabel(paymentCredited = false, deedReady = false))
        assertEquals("PAYMENT CONFIRMED · DEED MINTING", parcelStatusLabel(paymentCredited = true, deedReady = false))
        assertEquals("LAND DEED READY", parcelStatusLabel(paymentCredited = true, deedReady = true))
    }

    @Test fun `tile glyphs come from the viewport markers or the metered inspection, never invented`() {
        assertEquals("settled", tileGlyph(true, null)); assertEquals("settled", tileGlyph(false, "occupied"))
        assertEquals("held", tileGlyph(false, "held")); assertEquals("reserved", tileGlyph(false, "reserved"))
        assertEquals("free", tileGlyph(false, "available")); assertEquals("", tileGlyph(false, null))
    }
}
