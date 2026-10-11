package gg.pixelkingdomwars.nativeclient.ui.home

import gg.pixelkingdomwars.nativeclient.ui.layout.LayoutEditorState
import gg.pixelkingdomwars.nativeclient.ui.layout.LayoutLocal
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Test

/** The Home shell (every door, the HUD binding, the sheet hosts) recomposes only when the layout editor opens or closes.
 * The editor's own state changes on every drag step and every Home read; if those reached the shell, editing a layout
 * would recompose the whole Home on every move. */
class HomeLayoutOpenFactTest {
    private fun state(open: Boolean, slot: String) = LayoutEditorState(local = LayoutLocal(open = open, slot = slot))

    @Test fun `editor changes reach the shell only as open and close`() = runBlocking {
        val states = flowOf(state(false, "HOME"), state(false, "WAR"), state(true, "WAR"), state(true, "HOME"),
            state(true, "WAR"), state(false, "WAR"), state(false, "HOME"))
        assertEquals(listOf(false, true, false), layoutOpenFacts(states).toList().map { it.open })
    }
}
