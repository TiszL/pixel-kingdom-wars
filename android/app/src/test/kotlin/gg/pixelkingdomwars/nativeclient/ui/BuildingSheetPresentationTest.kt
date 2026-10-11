package gg.pixelkingdomwars.nativeclient.ui

import gg.pixelkingdomwars.nativeclient.ui.kingdom.StatDelta
import gg.pixelkingdomwars.nativeclient.ui.kingdom.sheetPinsActions
import gg.pixelkingdomwars.nativeclient.ui.kingdom.statDelta
import org.junit.Assert.*
import org.junit.Test

/** The building sheet's stat chips quote what an upgrade buys; that quote must be derived only from a pair of
 * plain decimals the server's own tables produced, and the sheet's primary action must stay reachable on the
 * Seeker's short landscape viewport. */
class BuildingSheetPresentationTest {
    @Test fun `a stat gain is the plain difference of the two levels with the web's thousands grouping`() {
        assertEquals(StatDelta("+312", true), statDelta("1,250", "1,562"))
        assertEquals(StatDelta("+1,500", true), statDelta("12,000", "13,500"))
        assertEquals(StatDelta("+600", true), statDelta("600", "1200"))
        assertEquals("A percentage keeps its unit", StatDelta("+5%", true), statDelta("25%", "30%"))
        assertEquals("A fractional gain is printed exactly, never rounded", StatDelta("+0.5%", true), statDelta("7.5%", "8%"))
    }
    @Test fun `no delta is shown for a stat that does not move or that the arithmetic does not understand`() {
        assertNull("RNG carries no next value", statDelta("6", null))
        assertNull("At max the next equals the current: no arrow pointing at itself", statDelta("600", "600"))
        assertNull("A ×1.7 mine multiplier is quoted verbatim, never subtracted", statDelta("×1.7", "×2"))
        assertNull("A unit mismatch is not a number", statDelta("25%", "30"))
        assertNull(statDelta("", "5")); assertNull(statDelta("abc", "5"))
    }
    @Test fun `a table that shrinks is shown as a loss rather than hidden`() {
        assertEquals(StatDelta("−25", false), statDelta("120", "95"))
    }
    @Test fun `the seeker landscape sheet keeps its heading and gold plate pinned while a tiny or enlarged sheet scrolls whole`() {
        assertTrue("Seeker landscape hands the sheet ~246dp", sheetPinsActions(246f, 1f))
        assertTrue(sheetPinsActions(200f, 1.3f))
        assertFalse("Too short to hold a heading, a body line and the plate", sheetPinsActions(180f, 1f))
        assertFalse("Large text must be able to scroll the action into view", sheetPinsActions(300f, 1.5f))
    }
}
