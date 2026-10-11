package gg.pixelkingdomwars.nativeclient.ui.economy

import gg.pixelkingdomwars.nativeclient.model.WalletFunds
import org.junit.Assert.*
import org.junit.Test
import java.math.BigInteger

/** The pure presentation rules behind the market, wallet and deposit plates. Each pins a player-facing promise. */
class EconomyChromeTest {
    @Test fun `a listing at or under the server floor is the cheapest unit, so it reads AT FLOOR`() {
        // Web ItemMarketTab: the floor comes from the whole open book, never the visible slice.
        assertEquals(FloorTag("AT FLOOR", true), marketFloorTag("1000000000", "1000000000", mine = false))
        assertEquals(FloorTag("AT FLOOR", true), marketFloorTag("900000000", "1000000000", mine = false))
        assertEquals("With no floor on the book this unit sets it", FloorTag("AT FLOOR", true), marketFloorTag("900000000", null, mine = false))
    }

    @Test fun `a dearer listing shows how far over the floor it is, rounded to whole percent`() {
        assertEquals(FloorTag("+50% OVER", false), marketFloorTag("1500000000", "1000000000", mine = false))
        assertEquals(FloorTag("+33% OVER", false), marketFloorTag("4000000000", "3000000000", mine = false))
    }

    @Test fun `your own listing is never labelled as a purchase opportunity`() {
        assertEquals(FloorTag("YOUR LISTING", false), marketFloorTag("1000000000", "1000000000", mine = true))
    }

    @Test fun `the deposit page's on-chain KEEP is the wallet page's server read, and a failed read is never an empty wallet`() {
        assertNull("No read yet stays a placeholder", onChainKeep(null))
        assertEquals("12345", onChainKeep(WalletFunds("1.5", mapOf("KEEP" to "12345", "SKR" to null), 1)))
        assertEquals("A null KEEP row is a failed cluster read (walletBalances.ts), shown as unavailable rather than 0",
            "UNAVAILABLE", onChainKeep(WalletFunds("1.5", mapOf("KEEP" to null), 1)))
        assertEquals("A server without a KEEP row cannot claim a balance", "UNAVAILABLE", onChainKeep(WalletFunds(null, emptyMap(), 1)))
    }

    @Test fun `deposit shortcuts add whole KEEP and refuse to cross the catalogue maximum`() {
        val max = BigInteger("5000")
        assertEquals("100", keepDepositShortcut("", 100, max))
        assertEquals("1100", keepDepositShortcut("1,000", 100, max))
        assertEquals("5000", keepDepositShortcut("4000", 1_000, max))
        assertNull("Beyond the bound the field is left untouched", keepDepositShortcut("4001", 1_000, max))
        assertNull("A non-numeric draft is not silently rewritten", keepDepositShortcut("12a", 100, max))
    }
}
