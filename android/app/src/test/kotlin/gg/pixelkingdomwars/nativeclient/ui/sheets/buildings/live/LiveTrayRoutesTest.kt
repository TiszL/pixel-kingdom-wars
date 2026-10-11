package gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live

import gg.pixelkingdomwars.nativeclient.model.Building
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.BuildCardState
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.BuildCardUi
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** b37cc131: locked/max GO only selects an existing building; it is never a placement or upgrade order. */
class LiveTrayRoutesTest {
    private val keep = Building("keep-instance", "keep", 3, 0, 0)
    private val berth = Building("berth-instance", "berth", 1, 4, 4)
    private fun card(state: BuildCardState, type: String = "berth") = BuildCardUi(
        type, "BERTH", "", "", "0/1", Verb.STONE, state, null, null, null, false, null)

    @Test fun `locked card goes to the actual Keep instance rather than the locked building`() {
        assertEquals(keep.id, LiveTrayRoutes.goTarget(card(BuildCardState.LOCKED), listOf(berth, keep)))
    }

    @Test fun `max card goes to an existing instance of that exact type`() {
        assertEquals(berth.id, LiveTrayRoutes.goTarget(card(BuildCardState.MAX), listOf(keep, berth)))
        assertNull(LiveTrayRoutes.goTarget(card(BuildCardState.MAX, "workshop"), listOf(keep, berth)))
    }

    @Test fun `zero-cap cards and missing Keep never invent a building id`() {
        assertNull(LiveTrayRoutes.goTarget(card(BuildCardState.MAX), listOf(keep)))
        assertNull(LiveTrayRoutes.goTarget(card(BuildCardState.LOCKED), listOf(berth)))
        assertNull(LiveTrayRoutes.goTarget(card(BuildCardState.MAX), emptyList()))
    }

    @Test fun `unavailable and other card states never borrow locked or max navigation`() {
        for (state in BuildCardState.entries.filter { it != BuildCardState.LOCKED && it != BuildCardState.MAX }) {
            assertNull(state.name, LiveTrayRoutes.goTarget(card(state), listOf(keep, berth)))
        }
        assertNull(LiveTrayRoutes.goTarget(null, listOf(keep, berth)))
    }

    @Test fun `blank identifiers are never selected and the next real instance can be focused`() {
        val malformed = berth.copy(id = " ")
        assertNull(LiveTrayRoutes.goTarget(card(BuildCardState.MAX), listOf(malformed)))
        assertEquals(berth.id, LiveTrayRoutes.goTarget(card(BuildCardState.MAX), listOf(malformed, berth)))
    }

    @Test fun `navigation is deterministic when several instances are already built`() {
        val next = berth.copy(id = "second-berth")
        assertEquals(berth.id, LiveTrayRoutes.goTarget(card(BuildCardState.MAX), listOf(keep, berth, next)))
    }
}
