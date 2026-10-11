package gg.pixelkingdomwars.nativeclient.ui.sheets

import gg.pixelkingdomwars.nativeclient.ui.features.Destination
import gg.pixelkingdomwars.nativeclient.ui.model.SheetFrameUi
import gg.pixelkingdomwars.nativeclient.ui.model.SheetSize
import org.junit.Assert.*
import org.junit.Test

/**
 * Owner 2026-10-06 ("dark overlap on camera place is ugly and unprofessional, make it full screen"): additive cases for
 * the SheetHost's full-screen path. The framed geometry in SheetHostTest and SheetHostFullGeometrySuccessorTest stays
 * the policy for HALF and for wide windows; on a phone-width window TALL and FULL use [sheetHostFullScreenLayout].
 */
class SheetHostFullScreenTest {
    private val scope = SheetScope("session-generation-1", "base-1", 3)

    @Test fun `a full-screen sheet spans the whole safe width below the shelf with no scrim`() {
        // Seeker safe viewport with the system bars hidden: 412 x (917 - 32 cut-out) dp.
        val layout = sheetHostFullScreenLayout(412f, 885f, 38f)
        assertEquals(SheetHostPlacement.FULL_SCREEN, layout.placement)
        assertEquals("edge to edge, no side gutters", 412f, layout.widthDp, 0f)
        assertEquals("the panel starts under the pill shelf, never under the pills", 38f, layout.topInsetDp, 0f)
        assertEquals(0f, layout.bottomInsetDp, 0f)
        assertEquals(847f, layout.maxHeightDp, 0f)
        assertEquals("no dimmed kingdom anywhere", 0f, layout.scrimAlpha, 0f)
    }

    @Test fun `without lifted pills the sheet takes the whole safe viewport`() {
        val layout = sheetHostFullScreenLayout(412f, 885f, 0f)
        assertEquals(0f, layout.topInsetDp, 0f)
        assertEquals(885f, layout.maxHeightDp, 0f)
        assertEquals(0f, sheetHostFullScreenLayout(412f, 885f, Float.NaN).topInsetDp, 0f)
        assertEquals(0f, sheetHostFullScreenLayout(412f, 885f, -10f).topInsetDp, 0f)
    }

    @Test fun `a full-screen layout clips to a tiny viewport and refuses invalid numbers`() {
        for ((width, height) in listOf(0f to 0f, 10f to 20f, 60f to 30f)) {
            val layout = sheetHostFullScreenLayout(width, height, 38f)
            assertTrue(layout.topInsetDp + layout.maxHeightDp + layout.bottomInsetDp <= height)
            assertTrue(layout.widthDp <= width)
        }
        for (invalid in listOf(-1f, Float.NaN, Float.POSITIVE_INFINITY)) {
            assertThrows(IllegalArgumentException::class.java) { sheetHostFullScreenLayout(invalid, 885f, 0f) }
            assertThrows(IllegalArgumentException::class.java) { sheetHostFullScreenLayout(412f, invalid, 0f) }
        }
    }

    @Test fun `a tall sheet that fills the screen covers Home so the hidden HUD leaves the semantics tree`() {
        assertTrue(sheetHostCoversHome(SheetSize.TALL, currentVisible = true, targetVisible = true, fillsScreen = true))
        assertTrue("still covered while it slides out", sheetHostCoversHome(SheetSize.TALL, currentVisible = true, targetVisible = false, fillsScreen = true))
        assertFalse(sheetHostCoversHome(SheetSize.TALL, currentVisible = false, targetVisible = false, fillsScreen = true))
        assertFalse("a framed tall sheet on a wide window keeps Home readable", sheetHostCoversHome(SheetSize.TALL, true, true, fillsScreen = false))
        assertFalse("a half sheet never covers Home", sheetHostCoversHome(SheetSize.HALF, true, true, fillsScreen = true))
        assertTrue(sheetHostCoversHome(SheetSize.FULL, true, true, fillsScreen = false))
    }

    @Test fun `the host state fills the screen only for tall and full sheets on a phone-width window`() {
        val state = SheetHostState(scope)
        assertFalse("nothing shown, nothing filled", state.fillsScreen)
        state.content = SheetHostContent(scope, SheetEntry(Destination.Leagues()), frame(SheetSize.FULL))
        assertFalse("an unknown window width never fills", state.fillsScreen)
        state.windowWidthDp = 412f
        assertTrue(state.fillsScreen)
        state.visibility.targetState = true
        assertTrue("entering, the opaque card already covers Home", state.fullCardVisible)
        state.content = SheetHostContent(scope, SheetEntry(Destination.Leagues()), frame(SheetSize.TALL))
        assertTrue(state.fullCardVisible)
        state.content = SheetHostContent(scope, SheetEntry(Destination.Leagues()), frame(SheetSize.HALF))
        assertFalse(state.fillsScreen)
        assertFalse(state.fullCardVisible)
        state.content = SheetHostContent(scope, SheetEntry(Destination.Leagues()), frame(SheetSize.TALL))
        state.windowWidthDp = 915f
        assertFalse("landscape and tablets keep the framed card", state.fillsScreen)
        assertFalse(state.fullCardVisible)
    }

    private fun frame(size: SheetSize) = SheetFrameUi("LEAGUES", null, size, emptyList(), null)
}
