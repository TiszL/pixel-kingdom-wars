package gg.pixelkingdomwars.nativeclient.wallet

import org.junit.Assert.*
import org.junit.Test

class WalletIdentityTest {
    @Test fun candidateAndProductionHaveDistinctExactWalletIdentities() {
        assertEquals(WalletIdentity.PRODUCTION, WalletIdentity.origin(WalletIdentity.PRODUCTION))
        assertEquals(WalletIdentity.CANDIDATE, WalletIdentity.origin(WalletIdentity.CANDIDATE))
        assertEquals("Pixel Kingdom Wars", WalletIdentity.name(WalletIdentity.PRODUCTION))
        assertEquals("Pixel Kingdom Wars Test", WalletIdentity.name(WalletIdentity.CANDIDATE))
        for (value in listOf("https://qa.pixelkingdomwars.com/", "https://qa.pixelkingdomwars.com:443",
            "https://qa.pixelkingdomwars.com.evil.test", "https://evil.test", "http://qa.pixelkingdomwars.com",
            "https://user@qa.pixelkingdomwars.com", "https://qa.pixelkingdomwars.com?x")) {
            assertThrows(IllegalArgumentException::class.java) { WalletIdentity.origin(value) }
        }
    }
}
