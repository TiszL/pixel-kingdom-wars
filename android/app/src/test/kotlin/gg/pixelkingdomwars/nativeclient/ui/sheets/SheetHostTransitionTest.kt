package gg.pixelkingdomwars.nativeclient.ui.sheets

import gg.pixelkingdomwars.nativeclient.ui.model.SheetSize
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import gg.pixelkingdomwars.nativeclient.ui.nav.BackRegistry
import org.junit.Assert.*
import org.junit.Test

/** Interrupted entry can paint an exit while MutableTransitionState's current and target are false. */
class SheetHostTransitionTest {
    @Test fun `full card still covers home when its entrance is interrupted by close`() {
        assertTrue(sheetHostCoversHome(SheetSize.FULL,
            currentVisible = false, targetVisible = false, transitionRunning = true))
    }

    @Test fun `coverage releases only after the interrupted exit has finished`() {
        assertFalse(sheetHostCoversHome(SheetSize.FULL,
            currentVisible = false, targetVisible = false, transitionRunning = false))
        assertFalse(sheetHostVisible(currentVisible = false, targetVisible = false, transitionRunning = false))
    }

    @Test fun `running half tall or absent content cannot claim full card coverage`() {
        for (size in listOf(null, SheetSize.HALF, SheetSize.TALL)) {
            assertFalse(sheetHostCoversHome(size,
                currentVisible = false, targetVisible = false, transitionRunning = true))
        }
    }

    @Test fun `sheet visibility includes the running interrupted exit for Back ownership`() {
        assertTrue(sheetHostVisible(currentVisible = false, targetVisible = false, transitionRunning = true))
        assertTrue(sheetHostVisible(currentVisible = true, targetVisible = false, transitionRunning = false))
        assertTrue(sheetHostVisible(currentVisible = false, targetVisible = true, transitionRunning = false))
    }

    @Test fun `interrupted sheet exit still owns Back ahead of home navigation`() {
        val registry = BackRegistry()
        val calls = mutableListOf<String>()
        registry.register(BackPriority.HOME) { calls += "home" }
        registry.register(BackPriority.SHEET,
            enabled = sheetHostVisible(currentVisible = false, targetVisible = false, transitionRunning = true)) {
            calls += "sheet exit"
        }
        assertTrue(registry.dispatch())
        assertEquals(listOf("sheet exit"), calls)
    }
}
