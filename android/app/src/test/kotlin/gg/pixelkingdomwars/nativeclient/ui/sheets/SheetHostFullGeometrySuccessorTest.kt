package gg.pixelkingdomwars.nativeclient.ui.sheets

import gg.pixelkingdomwars.nativeclient.ui.model.SheetSize
import org.junit.Assert.*
import org.junit.Test

/**
 * Additive geometry contract for review 092decf3 (2026-10-02 19:44 UTC): FULL top 60dp, bottom 14dp plus gesture inset.
 *
 * sheetHostLayout currently accepts a viewport whose system insets the mount has already consumed. The gesture cases
 * therefore subtract that inset before calling it and restore raw-screen coordinates only in the assertions. No second
 * system inset is added by the host. These cases cover the pure policy, not an actual Compose or MS-C inset mount.
 *
 * The original SheetHostTest FULL expectations (104/0 portrait, 8/8 landscape) remain in immutable commit 810ad07b.
 * Root authorized a labelled tests-only successor for those two cases under this ruling; all other original cases are
 * unchanged. This additive file neither skips tests nor claims executed acceptance.
 */
class SheetHostFullGeometrySuccessorTest {
    @Test fun `ruling full portrait reserves 60dp above and 14dp below within the safe viewport`() {
        val layout = sheetHostLayout(SheetSize.FULL, 412f, 915f)
        assertEquals(SheetHostPlacement.CENTER, layout.placement)
        assertEquals(396f, layout.widthDp, 0f)
        assertEquals(60f, layout.topInsetDp, 0f)
        assertEquals(14f, layout.bottomInsetDp, 0f)
        assertEquals(841f, layout.maxHeightDp, 0f)
        assertEquals(0.60f, layout.scrimAlpha, 0f)
    }

    @Test fun `ruling full landscape uses the same vertical gaps and the 720dp width cap`() {
        val layout = sheetHostLayout(SheetSize.FULL, 915f, 412f)
        assertEquals(SheetHostPlacement.CENTER, layout.placement)
        assertEquals(720f, layout.widthDp, 0f)
        assertEquals(60f, layout.topInsetDp, 0f)
        assertEquals(14f, layout.bottomInsetDp, 0f)
        assertEquals(338f, layout.maxHeightDp, 0f)
        assertEquals(0.60f, layout.scrimAlpha, 0f)
    }

    @Test fun `narrow landscape full card retains horizontal gutters without old vertical gutters`() {
        val layout = sheetHostLayout(SheetSize.FULL, 600f, 360f)
        assertEquals(584f, layout.widthDp, 0f)
        assertEquals(60f, layout.topInsetDp, 0f)
        assertEquals(14f, layout.bottomInsetDp, 0f)
        assertEquals(286f, layout.maxHeightDp, 0f)
    }

    @Test fun `portrait gesture inset consumed by the mount is counted once below the full card`() {
        val rawHeight = 915f
        val gestureInset = 24f
        val safeHeight = rawHeight - gestureInset
        val layout = sheetHostLayout(SheetSize.FULL, 412f, safeHeight)
        val panelBottomInRawViewport = layout.topInsetDp + layout.maxHeightDp
        assertEquals(817f, layout.maxHeightDp, 0f)
        assertEquals(14f, layout.bottomInsetDp, 0f)
        assertEquals(14f + gestureInset, rawHeight - panelBottomInRawViewport, 0f)
    }

    @Test fun `landscape gesture inset consumed by the mount is counted once below the full card`() {
        val rawHeight = 412f
        val gestureInset = 24f
        val safeHeight = rawHeight - gestureInset
        val layout = sheetHostLayout(SheetSize.FULL, 915f, safeHeight)
        val panelBottomInRawViewport = layout.topInsetDp + layout.maxHeightDp
        assertEquals(314f, layout.maxHeightDp, 0f)
        assertEquals(14f, layout.bottomInsetDp, 0f)
        assertEquals(14f + gestureInset, rawHeight - panelBottomInRawViewport, 0f)
    }

    @Test fun `square full viewport also follows the explicit full vertical gaps`() {
        val layout = sheetHostLayout(SheetSize.FULL, 600f, 600f)
        assertEquals(584f, layout.widthDp, 0f)
        assertEquals(60f, layout.topInsetDp, 0f)
        assertEquals(14f, layout.bottomInsetDp, 0f)
        assertEquals(526f, layout.maxHeightDp, 0f)
    }

    @Test fun `ruling leaves portrait tall at 104dp with no new full-card bottom gap`() {
        val layout = sheetHostLayout(SheetSize.TALL, 412f, 915f)
        assertEquals(SheetHostPlacement.BOTTOM, layout.placement)
        assertEquals(412f, layout.widthDp, 0f)
        assertEquals(104f, layout.topInsetDp, 0f)
        assertEquals(0f, layout.bottomInsetDp, 0f)
        assertEquals(811f, layout.maxHeightDp, 0f)
        assertEquals(0.40f, layout.scrimAlpha, 0f)
    }

    @Test fun `ruling leaves landscape half and tall as end panels across the safe viewport`() {
        for (size in listOf(SheetSize.HALF, SheetSize.TALL)) {
            val layout = sheetHostLayout(size, 915f, 412f)
            assertEquals(SheetHostPlacement.END, layout.placement)
            assertEquals(457.5f, layout.widthDp, 0f)
            assertEquals(0f, layout.topInsetDp, 0f)
            assertEquals(0f, layout.bottomInsetDp, 0f)
            assertEquals(412f, layout.maxHeightDp, 0f)
        }
    }

    @Test fun `ruling leaves portrait half at half height without a scrim or full-card gaps`() {
        val layout = sheetHostLayout(SheetSize.HALF, 412f, 915f)
        assertEquals(SheetHostPlacement.BOTTOM, layout.placement)
        assertEquals(412f, layout.widthDp, 0f)
        assertEquals(457.5f, layout.maxHeightDp, 0f)
        assertEquals(0f, layout.topInsetDp, 0f)
        assertEquals(0f, layout.bottomInsetDp, 0f)
        assertEquals(0f, layout.scrimAlpha, 0f)
    }

    @Test fun `full gaps and dimensions remain bounded in a tiny or empty safe viewport`() {
        for ((width, height) in listOf(0f to 0f, 10f to 20f, 20f to 10f, 60f to 74f, 74f to 60f)) {
            val layout = sheetHostLayout(SheetSize.FULL, width, height)
            assertTrue("$width x $height width", layout.widthDp in 0f..width)
            assertTrue("$width x $height height", layout.maxHeightDp in 0f..height)
            assertTrue(layout.topInsetDp in 0f..60f)
            assertTrue(layout.bottomInsetDp in 0f..14f)
            assertTrue(layout.topInsetDp + layout.maxHeightDp + layout.bottomInsetDp <= height)
        }
    }
}
