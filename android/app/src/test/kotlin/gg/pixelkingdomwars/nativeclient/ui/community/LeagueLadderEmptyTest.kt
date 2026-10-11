package gg.pixelkingdomwars.nativeclient.ui.community

import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.LEAGUE_TABS_WITH_LABELS
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.leaguesTabs
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Owner screenshot 8 (2026-10-06): Leagues LADDER for a kingdom without land showed "No ranked kingdoms yet" with a
 * sentence about the server and no way on, and the four tabs truncated to "REWAR…". WHY these pins matter: the server
 * ranks only kingdoms with land, so a landless player must be shown the one door that puts them on the ladder (SPEC
 * §3.5: one blue button to the place that produces the content), and a landed one must not get a second primary beside
 * FIND A MATCH.
 */
class LeagueLadderEmptyTest {
    @Test fun `a kingdom without land gets the GET LAND door on the empty ladder`() {
        val empty = leagueLadderEmpty(landOwned = false)
        assertEquals("GET LAND", empty.goLabel)
        assertEquals(LEAGUE_LADDER_LAND_DOOR, empty.go?.value)
        assertTrue(empty.reason.contains("land"))
    }

    @Test fun `a landed kingdom is told how to climb and gets no second button`() {
        val empty = leagueLadderEmpty(landOwned = true)
        assertNull(empty.goLabel)
        assertNull(empty.go)
    }

    @Test fun `four league tabs use the compact strip so no label is cut`() {
        assertTrue("LEAGUE, LADDER, REWARDS and PRIZE exceed the labelled budget", leaguesTabs().size > LEAGUE_TABS_WITH_LABELS)
    }
}
