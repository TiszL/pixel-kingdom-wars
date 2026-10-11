package gg.pixelkingdomwars.nativeclient.ui.economy

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Owner Seeker, QA, 2026-10-06 08:18 UTC (phone/v7-berth-refresh-081811.png): the history icon on the full-screen Berth
 * opened VEHICLE RECEIPTS as the lower half of a split, under a strip of the darkened kingdom with the interrupted-request
 * herald and four resource pills, and a red error line in the body. The owner's rule: every sheet is full screen (status bar
 * to navigation bar), no game camera shows above a sheet, nothing overlaps. Why these pins matter: every fleet form (vehicle
 * receipts and controls, Tools, the KEEP Market, starter expeditions, their receipts and storage notices) goes through this
 * one pane, so if it splits again or a body paints its own dark page with a gutter, the kingdom comes back above the sheet.
 * No Compose mount here (pure rule plus source pins); the device check is in notes/fix-receipts-sheet.md.
 */
class HomeFleetCommandFullScreenTest {
    private fun source(path: String) = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/$path").readText()

    @Test fun `every fleet form fills a phone screen and only a wide window keeps the split`() {
        // The Seeker is about 412 dp wide; every owner's form, receipts included, is a full-screen card there.
        for (destination in FleetCommandDestination.entries) {
            assertTrue(destination.name, fleetCommandFillsScreen(destination, 412f))
            assertTrue(destination.name, fleetCommandFillsScreen(destination, 360f))
        }
        // Landscape or a tablet keeps the side-by-side split (the same compact rule as SheetHost's full-screen sheets).
        assertFalse(fleetCommandFillsScreen(FleetCommandDestination.VEHICLES, 915f))
        assertFalse(fleetCommandFillsScreen(FleetCommandDestination.VEHICLES, 600f))
        // No form: nothing covers Home. An unknown width never fills.
        assertFalse(fleetCommandFillsScreen(null, 412f))
        assertFalse(fleetCommandFillsScreen(FleetCommandDestination.VEHICLES, Float.NaN))
        assertFalse(fleetCommandFillsScreen(FleetCommandDestination.VEHICLES, Float.POSITIVE_INFINITY))
    }

    @Test fun `the pane draws a full screen form as one opaque card over the whole Home and under no HUD`() {
        val pane = source("ui/economy/HomeFleetCommandPane.kt")
        // Registered with the Home root: HomeScaffold then hides the dock, edges, badge, herald and chat peek, and draws the
        // pills as the one-row shelf above the card instead of the four-row stack over its header.
        assertTrue(pane.contains("FullScreenSheetEffect(active = fills)"))
        // The opaque backdrop under the form (no camera anywhere) and the form below the shelf.
        assertTrue(pane.contains("if (fills) FullScreenSheetBackdrop()"))
        assertTrue(pane.contains("Box(Modifier.fillMaxSize().padding(top = if (fills) shelf else 0.dp)) { form() }"))
        // Home keeps its full size under the card (the scene is not squeezed into a strip) and the card is placed over it.
        assertTrue(pane.contains("homePlaced.place(0, 0); formPlaced.place(0, 0)"))
        // The split's keyboard recovery never replaces a full-screen form.
        assertTrue(pane.contains("if (destination == null || fills) null else fleetCommandRecovery("))
        // The covered Home leaves the semantics tree, so a screen reader does not walk the hidden kingdom.
        assertTrue(pane.contains(".then(if (fills) Modifier.clearAndSetSemantics { } else Modifier)) { home() }"))
    }

    @Test fun `receipts and the Berth crafted controls are the Berth full screen card with its header art`() {
        val frames = source("ui/phasee/PhaseEDesignedFrames.kt")
        val sheet = frames.substringAfter("@Composable internal fun PhaseEDesignedSheet(").substringBefore("/** A Phase E body as one")
        assertTrue(sheet.contains("PhaseEFullScreenCard(modifier)"))
        assertTrue("the living header art band, as on the Berth", sheet.contains("header = { PhaseESeaHeader() }"))
        assertFalse("no 4 dp gutter around the frame", sheet.contains("padding(4.dp)"))
        val card = frames.substringAfter("@Composable internal fun PhaseEFullScreenCard(").substringBefore("/** The living header")
        assertTrue(card.contains("FullScreenSheetBackdrop()"))
        assertTrue(card.contains("pageInsets()"))
        assertFalse("never the old dark page fill", frames.contains("PkwTokens.Colors.bg"))

        // VEHICLE RECEIPTS keeps its content and REFRESH RECEIPTS; the failed fleet read is the quiet notice, not a red line.
        val receipts = frames.substringAfter("@Composable internal fun PhaseEReceiptHistoryBody(")
        assertTrue(receipts.contains("SecondaryButton(\"REFRESH RECEIPTS\", onRefresh, Modifier.fillMaxWidth(), enabled = !busy)"))
        assertTrue(receipts.contains("Saved originals and server receipts. Checking a receipt does not send the request again."))
        assertTrue(receipts.contains("error?.let { PhaseEQuietNotice(it) }"))
        assertFalse(receipts.contains("shortText"))
        val notice = frames.substringAfter("@Composable internal fun PhaseEQuietNotice(").substringBefore("/** An owner that cannot")
        assertTrue(notice.contains("RowVariant.DIM"))
        assertFalse(notice.contains("RowVariant.ERROR"))

        // The Berth's crafted controls (BERTH / PUBLIC WORKSHOP) are the same card with the same header art.
        val vehicles = source("ui/phasee/VehicleDesignedSheet.kt")
        assertTrue(vehicles.contains("PhaseEFullScreenCard {"))
        assertEquals(1, Regex("header = \\{ PhaseESeaHeader\\(\\) \\}").findAll(vehicles).count())
        assertFalse(vehicles.contains("background(PkwTokens.Colors.bg)"))
        assertFalse(vehicles.contains("padding(horizontal = 4.dp, vertical = 4.dp)"))
    }
}
