package gg.pixelkingdomwars.nativeclient.ui.kit

import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.model.SheetSize
import org.junit.Assert.*
import org.junit.Test
import java.io.File

/**
 * Owner 2026-10-06 (OWNER-FEEDBACK-0450Z): "none of screens should overlay each other on interface and should be fully
 * solana mobile optimized, like dark overlap on camera place is ugly and unprofessional, make it full screen".
 * These cases pin why the full-screen sheet geometry exists: on a phone a TALL or FULL sheet is one opaque card with no
 * dimmed kingdom, the resource pills sit on their own shelf and never on a sheet header, and the camera cut-out is
 * respected. Compose does not run on the JVM; the last cases pin the hosts that paint it.
 */
class FullScreenSheetTest {
    private val g = FullScreenSheetGeometry

    @Test fun `on the Seeker a tall or full sheet fills the screen and a half sheet never does`() {
        // Seeker: 1200 px wide at about 2.91 px per dp, so about 412 dp.
        assertTrue(g.fillsScreen(SheetSize.TALL, 412f))
        assertTrue(g.fillsScreen(SheetSize.FULL, 412f))
        assertFalse("a half sheet keeps the kingdom above it live and touchable", g.fillsScreen(SheetSize.HALF, 412f))
        assertFalse(g.fillsScreen(null, 412f))
    }

    @Test fun `a wide window keeps the framed card because a 900dp parchment body is not the design`() {
        for (width in listOf(600f, 915f, 1280f)) for (size in SheetSize.entries) assertFalse("$size $width", g.fillsScreen(size, width))
        assertFalse("an unknown width never claims full screen", g.fillsScreen(SheetSize.TALL, Float.NaN))
        assertFalse(g.fillsScreen(SheetSize.TALL, Float.POSITIVE_INFINITY))
    }

    @Test fun `the shelf is one padded pill row and disappears when no pill is lifted`() {
        assertEquals(0, g.shelfDp(0))
        assertEquals(0, g.shelfDp(-1))
        for (pills in 1..4) assertEquals("$pills pills share one row", 38, g.shelfDp(pills))
        assertTrue("the pill row fits inside its shelf", g.SHELF_PAD_DP + g.PILL_H_DP <= g.shelfDp(1))
    }

    @Test fun `four pills fit one row on a 412dp phone and fewer keep the designed 108dp width`() {
        for (pills in 1..3) assertEquals(108f, g.pillWidthDp(pills, 412f), 0f)
        val four = g.pillWidthDp(4, 412f)
        assertTrue(four < 108f)
        assertTrue("four pills plus gaps and gutters fit the safe width",
            4 * four + 3 * g.PILL_GAP_DP + 2 * g.GUTTER_DP <= 412f + 0.001f)
        // A narrow 360dp phone still fits all four on the shelf, so a pill never wraps onto the sheet header.
        assertTrue(4 * g.pillWidthDp(4, 360f) + 3 * g.PILL_GAP_DP + 2 * g.GUTTER_DP <= 360f + 0.001f)
        assertEquals(0f, g.pillWidthDp(0, 412f), 0f)
        assertEquals(0f, g.pillWidthDp(4, 10f), 0f)
    }

    @Test fun `the sheet panel starts below the camera cut-out and the shelf so no pill draws over its header`() {
        val cutout = 32f // the Seeker's punch-hole top inset, in dp, with the system bars hidden
        val shelf = g.shelfDp(2).toFloat()
        val edges = g.panelEdges(cutout, 0f, 0f, 0f, shelf)
        assertEquals(cutout + shelf, edges.topDp, 0f)
        val pillBottom = cutout + g.SHELF_PAD_DP + g.PILL_H_DP
        assertTrue("pills end above the sheet header", pillBottom <= edges.topDp)
        assertEquals("without pills the sheet sits directly under the cut-out", cutout, g.panelEdges(cutout, 0f, 0f, 0f, 0f).topDp, 0f)
    }

    @Test fun `the panel keeps every safe inset and ignores nonsense values`() {
        val edges = g.panelEdges(30f, 24f, 12f, 16f, 38f)
        assertEquals(FullScreenSheetEdges(68f, 24f, 12f, 16f), edges)
        assertEquals(FullScreenSheetEdges(0f, 0f, 0f, 0f), g.panelEdges(-5f, Float.NaN, Float.NEGATIVE_INFINITY, -1f, Float.NaN))
    }

    @Test fun `the Home registry stays active while any full-screen sheet shows and adds a host notice to the shelf`() {
        val sheets = FullScreenSheets()
        val tray = Any(); val sheet = Any()
        assertFalse(sheets.active)
        sheets.register(tray); sheets.register(tray)
        sheets.register(sheet)
        sheets.unregister(tray)
        assertTrue("the second sheet is still showing", sheets.active)
        sheets.unregister(sheet)
        assertFalse(sheets.active)
        sheets.shelf = 38.dp; sheets.notice = 50.dp
        assertEquals(88.dp, sheets.shelf + sheets.notice)
    }

    @Test fun `the forge notice on a full-screen sheet spans the safe width and leaves most of the screen to the sheet`() {
        // It had the world strip above the sheet; on the shelf it sits under the pills and the sheet starts below it.
        val bounds = gg.pixelkingdomwars.nativeclient.ui.goldforge.goldForgeShelfNoticeBounds(412f, 885f)
        assertEquals(396f, bounds.width, 0f)
        assertEquals(94f, bounds.height, 0f)
        assertTrue(gg.pixelkingdomwars.nativeclient.ui.goldforge.goldForgeShelfNoticeBounds(412f, 200f).height <= 50f)
        assertEquals(0f, gg.pixelkingdomwars.nativeclient.ui.goldforge.goldForgeShelfNoticeBounds(0f, 0f).width, 0f)
        val mount = source("ui/goldforge/GoldForgeHomeMount.kt")
        assertEquals("notice and error toast both report their height to the shelf", 2,
            Regex("sheets\\?\\.notice = with\\(density\\)").findAll(mount).count())
    }

    @Test fun `every phone tall host paints the opaque backdrop and registers instead of the dimming scrim`() {
        for (path in listOf("ui/sheets/SheetHost.kt", "ui/sheets/army/live/ArmyLiveHosts.kt", "ui/sheets/buildings/live/LiveSheetHosts.kt")) {
            val host = source(path)
            assertTrue(path, host.contains("FullScreenSheetBackdrop()"))
            assertTrue(path, host.contains("FullScreenSheetEffect(active ="))
            assertTrue("$path leaves the shelf for the pills", host.contains("fullScreenSheetShelf()"))
        }
        val sheetHost = source("ui/sheets/SheetHost.kt")
        assertTrue("the Home overlay applied the safe insets once; the card reaches the screen edges",
            sheetHost.contains("bleedOver(WindowInsets.safeDrawing)"))
        assertTrue("a full-screen card never fades the kingdom", sheetHost.contains("val fade = layout.placement != SheetHostPlacement.FULL_SCREEN || !motion.slide"))
    }

    @Test fun `Home draws the pills on the shelf and hides the rest of its HUD under a full-screen sheet`() {
        val scaffold = source("ui/home/HomeScaffold.kt")
        assertTrue(scaffold.contains("CompositionLocalProvider(gg.pixelkingdomwars.nativeclient.ui.kit.LocalFullScreenSheets provides fullScreenSheets) {"))
        assertTrue(scaffold.contains("if (fullScreenSheets.active) gg.pixelkingdomwars.nativeclient.ui.kit.FullScreenResourceShelf("))
        assertTrue(scaffold.contains("fullScreenSheets.shelf = gg.pixelkingdomwars.nativeclient.ui.kit.FullScreenSheetGeometry.shelfDp(shelfRows).dp"))
        assertTrue(scaffold.contains("homeHudUnderFullScreenSheet("))
        assertTrue(scaffold.contains("if (!buildOpen && !fullScreenSheets.active) chatPeek()"))
    }

    private fun source(relative: String): String {
        val path = "src/main/kotlin/gg/pixelkingdomwars/nativeclient/$relative"
        return listOf(File(path), File("app/$path")).first { it.isFile }.readText()
    }
}
