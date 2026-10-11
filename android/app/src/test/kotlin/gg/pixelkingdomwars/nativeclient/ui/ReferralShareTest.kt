package gg.pixelkingdomwars.nativeclient.ui

import gg.pixelkingdomwars.nativeclient.ui.economy.referralShareUrl
import org.junit.Assert.assertEquals
import org.junit.Test

class ReferralShareTest {
    @Test fun `a shared code opens the production referral entry without a wallet or private endpoint`() {
        assertEquals("https://play.pixelkingdomwars.com/?ref=KEEP-ABCDE", referralShareUrl("KEEP-ABCDE"))
    }
    @Test fun `query delimiters cannot turn a server value into extra navigation parameters`() {
        assertEquals("https://play.pixelkingdomwars.com/?ref=KEEP-A%26screen%3Dmail%23x%20y", referralShareUrl("KEEP-A&screen=mail#x y"))
    }
}
