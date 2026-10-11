package gg.pixelkingdomwars.nativeclient.ui

import gg.pixelkingdomwars.nativeclient.ui.nav.GameLinkContract
import gg.pixelkingdomwars.nativeclient.ui.nav.GameLinkScreen
import org.junit.Assert.*
import org.junit.Test

class CandidateGameLinksTest {
    @Test fun candidateLinksCannotCrossIntoProductionAndProductionCannotConsumeCandidateLinks() {
        val candidate = GameLinkContract.CANDIDATE_ORIGIN
        val production = GameLinkContract.ORIGIN
        val action = GameLinkContract.VIEW_ACTION
        assertEquals(GameLinkScreen.BASE, GameLinkContract.parse(action, "$candidate/?screen=base", candidate))
        assertNull(GameLinkContract.parse(action, "$candidate/?screen=base"))
        assertNull(GameLinkContract.parse(action, "$production/?screen=base", candidate))
        assertNull(GameLinkContract.browserUrl(action, "$production/?other=1", candidate))
        assertEquals("$candidate/?other=1", GameLinkContract.browserUrl(action, "$candidate/?other=1", candidate))
        for (origin in listOf("https://evil.test", "$candidate/", "$candidate:443", "https://user@qa.pixelkingdomwars.com")) {
            assertNull(GameLinkContract.parse(action, "$origin/?screen=base", origin))
            assertNull(GameLinkContract.browserUrl(action, "$origin/", origin))
        }
    }
}
