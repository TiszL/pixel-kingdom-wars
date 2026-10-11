package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.seekerresources.*
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.ui.phasee.*
import org.junit.Assert.*
import org.junit.Test

class SeekerResourceClaimsUiTest {
    private val wallet = "11111111111111111111111111111111"
    private val journal = SeekerResourceClaimJournal(1, StarterIdentity("https://game.test", "devnet", wallet), 0, null, emptyList())
    private val page = SeekerResourceEntitlementView(1, wallet, false, false, "available", null, null, "00000000-0000-4000-8000-000000000001", emptyList())
    @Test fun `paused paginated history stays reachable before the wallet first matching term`() {
        assertTrue(seekerResourceEntryAvailable(SeekerResourceClaimsState(journal, page)))
        assertFalse(seekerResourceCanReview(SeekerResourceClaimsState(journal, page), "base", true))
    }
    @Test fun `paused unavailable history remains visible without a local journal`() {
        assertTrue(seekerResourceEntryAvailable(SeekerResourceClaimsState(journal, page.copy(status = "unavailable", reason = "SOURCE_INTEGRITY", rows = emptyList(), nextCursor = null))))
    }
    @Test fun `storage errors stay visible while absent support creates no false action`() {
        assertTrue(seekerResourceEntryAvailable(null, true)); assertFalse(seekerResourceEntryAvailable(null))
        assertFalse(seekerResourceCanReview(SeekerResourceClaimsState(journal, page.copy(claimsEnabled = true)), null, true))
        assertFalse(seekerResourceCanReview(SeekerResourceClaimsState(journal, page.copy(claimsEnabled = true)), "base", false))
    }
}
