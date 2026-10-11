package gg.pixelkingdomwars.nativeclient.ui.home

import androidx.compose.ui.focus.FocusDirection
import androidx.compose.ui.focus.FocusManager
import org.junit.Assert.*
import org.junit.Test

/** Pins the live action boundary, not Android/Compose detach behavior. The mapped
 * ActiveParent crash still requires the content pipeline's exact optimized-APK device check. */
class HomeMenuFocusTest {
    @Test fun `every destination releases captured focus before closing the menu or leaving Home`() {
        for (destination in homeMenuDestinations() + HOME_MENU_ACTIONABLE) {
            val events = mutableListOf<String>()
            var attached = true
            var menuOpen = true
            var opened: String? = null
            val focus = FocusBeforeDetach({ attached }, events)
            val menu = HomeMenuActions(focus) {
                assertFalse("focus must be released before menu removal", focus.focused)
                assertTrue(menuOpen)
                events += "close"
                menuOpen = false
            }

            menu.run {
                assertFalse("navigation cannot retain scene focus", focus.focused)
                assertFalse(menuOpen)
                assertNull("one navigation only", opened)
                opened = destination.name
                attached = false
                events += "navigate:${destination.name}"
            }

            assertEquals(destination.name, opened)
            assertEquals(listOf("clear:true", "close", "navigate:${destination.name}"), events)
        }
    }

    @Test fun `menu dismissal releases focus before scheduling launcher restoration`() {
        val events = mutableListOf<String>()
        var attached = true
        var restoreLauncher = false
        val focus = FocusBeforeDetach({ attached }, events)
        val menu = HomeMenuActions(focus) {
            assertFalse(focus.focused)
            attached = false
            events += "close"
        }

        menu.run {
            assertFalse(attached)
            restoreLauncher = true
            events += "restore-after-close"
        }

        assertTrue(restoreLauncher)
        assertEquals(listOf("clear:true", "close", "restore-after-close"), events)
    }

    @Test fun `a focus-release failure is not hidden and cannot close or navigate`() {
        val events = mutableListOf<String>()
        val failure = IllegalStateException("synthetic focus-release refusal")
        val focus = object : FocusManager {
            override fun clearFocus(force: Boolean) { assertTrue(force); throw failure }
            override fun moveFocus(focusDirection: FocusDirection): Boolean = error("no focus traversal")
        }
        val menu = HomeMenuActions(focus) { events += "close" }

        try {
            menu.run { events += "navigate" }
            fail("focus-release failure must propagate")
        } catch (actual: IllegalStateException) {
            assertSame(failure, actual)
        }
        assertTrue(events.isEmpty())
    }

    private class FocusBeforeDetach(
        private val attached: () -> Boolean,
        private val events: MutableList<String>,
    ) : FocusManager {
        var focused = true
            private set
        override fun clearFocus(force: Boolean) {
            assertTrue("clear while the focused child is still attached", attached())
            assertTrue("captured focus must be released too", force)
            assertTrue("release exactly once", focused)
            focused = false
            events += "clear:$force"
        }
        override fun moveFocus(focusDirection: FocusDirection): Boolean = error("no focus traversal")
    }
}
