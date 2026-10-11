package gg.pixelkingdomwars.nativeclient.ui.kit

import gg.pixelkingdomwars.nativeclient.ui.model.SheetSize
import gg.pixelkingdomwars.nativeclient.ui.sheets.sheetHostFullScreenLayout
import gg.pixelkingdomwars.nativeclient.ui.sheets.sheetHostLayout
import org.junit.Assert.*
import org.junit.Test
import java.io.File

/**
 * K-night-A11 (owner 2026-10-06, Seeker): "hero altar and clan building sheets show cut-offs". The owner's portrait
 * captures (diag-clan.png, diag-heroes-tab.png, 17:10-17:17 UTC) render fully; the cut-offs are the LANDSCAPE layout the
 * game has followed again since e81d17d2 (the owner demos over scrcpy). A framed shell (HubCard: Clan, Profile; SheetFrame:
 * Army, Hero, Research; the BUILD tray: HEROES) stacks about 300 dp of fixed parts around its body, and a landscape slot
 * is 270-385 dp, so the body and the action row were cut. These cases pin why the compact rule exists: on the Seeker in
 * portrait nothing changes, in a 400 dp-tall window every one of those shells is compact (the header scrolls away with
 * the body, the action row stays pinned and visible). Compose does not run on the JVM, so the last cases pin the shells.
 *
 * The Seeker: 1200 x 2670 px at density 3.0, so 400 x 890 dp (ClanSheetPortraitTest); the system bars are hidden, so the
 * safe area is the 32 dp punch-hole cut-out only (FullScreenSheetTest): on the top edge in portrait, on a side in landscape.
 */
class SheetFitTest {
    private val fit = SheetFit
    private val shortDp = 400f
    private val longDp = 890f
    private val cutoutDp = 32f
    /** The fixed parts of a framed shell: everything but its body. */
    private val fixedDp = fit.HEADER_DP + fit.TABS_DP + fit.FOOTER_DP + fit.FRAME_DP

    @Test fun `the framed minimum is the shell's own fixed parts plus a body that still reads`() {
        assertEquals(fixedDp + fit.BODY_MIN_DP, fit.FRAMED_MIN_DP)
        assertEquals("the living header", PkwTokens.Dims.sheetHeaderH.value, fit.HEADER_DP.toFloat(), 0f)
        assertEquals("the footer is the 8 dp gap and the sheet primary", 8f + PkwTokens.Dims.sheetPrimaryH.value, fit.FOOTER_DP.toFloat(), 0f)
        assertTrue("the kit tab strip (48 + 8) fits inside the tab allowance", PkwTokens.Dims.tabH.value + 8f <= fit.TABS_DP)
        assertTrue("the body holds the clan's refresh row and two 56 dp member rows",
            PkwTokens.Dims.secondaryH.value + 6f + 2 * 56f <= fit.BODY_MIN_DP)
    }

    /** Portrait slots on the Seeker: every one keeps its designed tree, so portrait stays pixel-identical. */
    private val portraitSlots = mapOf(
        // ArmyLiveTallSlot / LiveTallSheetHost full-screen card: below the cut-out and a two-pill shelf.
        "hero altar, army, BUILD tray" to longDp - cutoutDp - FullScreenSheetGeometry.shelfDp(2),
        // SheetHost FULL card, full screen (a Full card leaves no shelf).
        "Home Clan / Profile card" to sheetHostFullScreenLayout(shortDp, longDp - cutoutDp, 0f).maxHeightDp,
        // ClanHub standalone (ClansRoute): the safe area and an 8 dp margin.
        "standalone Clan route" to longDp - cutoutDp - 16f,
        // The worst portrait case: bars shown (40 + 48 dp) and four pills on the shelf.
        "bars shown, four pills" to longDp - 40f - 48f - FullScreenSheetGeometry.shelfDp(4),
    )

    /** Landscape slots on the Seeker (890 x 400 dp): the framed geometry, since 890 dp is not a compact width. */
    private val landscapeSlots = mapOf(
        // ArmyLiveTallSlot framed: the safe top (0 here), 24 + 104 dp of world strip.
        "hero altar, army" to shortDp - 24f - PkwTokens.Dims.tallSheetTop.value,
        // LiveTallSheetHost framed (the BUILD tray, HEROES tab): from y 104.
        "BUILD tray" to shortDp - SheetGeometry.TALL_TOP_DP,
        // SheetHost framed FULL card (Clan, Profile): 60 dp above, 14 dp below, the cut-out on a side.
        "Home Clan / Profile card" to sheetHostLayout(SheetSize.FULL, longDp - cutoutDp, shortDp).maxHeightDp,
        // SheetHost framed TALL sheet (END placement, the whole height).
        "Home tall sheet" to sheetHostLayout(SheetSize.TALL, longDp - cutoutDp, shortDp).maxHeightDp,
        // ClanHub standalone (ClansRoute).
        "standalone Clan route" to shortDp - 16f,
    )

    @Test fun `on the Seeker in portrait every shell keeps its designed geometry`() {
        for ((name, slot) in portraitSlots) assertFalse("$name: $slot dp", fit.compact(slot))
        assertFalse("the 412 x 915 design phone", fit.compact(915f - 60f - 14f))
    }

    @Test fun `in a 400dp-tall window every shell is compact and its action row stays visible`() {
        assertEquals(326f, landscapeSlots.getValue("Home Clan / Profile card"), 0f)
        assertTrue("the owner's FULL Clan card had 26 dp of body", landscapeSlots.getValue("Home Clan / Profile card") - fixedDp < 56f)
        assertTrue("the hero altar slot cannot even hold the fixed parts", landscapeSlots.getValue("hero altar, army") < fixedDp)
        for ((name, slot) in landscapeSlots) {
            assertTrue("$name: a $slot dp slot is shorter than the 400 dp window", slot <= shortDp)
            assertTrue("$name: $slot dp is compact", fit.compact(slot))
            // Designed geometry here is what cut the owner's sheets: the fixed parts leave no readable body.
            assertTrue("$name: the designed body (${slot - fixedDp} dp) would be under a readable body", slot - fixedDp < fit.BODY_MIN_DP)
            // Compact: the frame and the pinned action row are always on screen, and once the header has scrolled away
            // the body page shows at least two rows.
            val page = slot - fit.FRAME_DP - fit.FOOTER_DP
            assertTrue("$name: the pinned footer fits", fit.FRAME_DP + fit.FOOTER_DP < slot)
            assertTrue("$name: a $page dp body page holds two rows", page >= 2 * 56f)
        }
    }

    @Test fun `compact is decided by the shell's own height only`() {
        assertTrue(fit.compact(fit.FRAMED_MIN_DP - 0.5f))
        assertFalse("the minimum itself keeps the design", fit.compact(fit.FRAMED_MIN_DP.toFloat()))
        assertTrue("no room at all is compact", fit.compact(0f))
        assertFalse("an unbounded shell keeps the design", fit.compact(Float.POSITIVE_INFINITY))
        assertFalse(fit.compact(Float.NaN))
    }

    @Test fun `an upward drag collapses the header before the body scrolls and a downward drag never does`() {
        // Finger up 30 px with 100 px of header showing: the header takes all of it.
        assertEquals(30f, fit.collapseFirstPx(-30f, 100f), 0f)
        // Only what is left of the header; the rest reaches the body.
        assertEquals(12f, fit.collapseFirstPx(-30f, 12f), 0f)
        assertEquals("a collapsed header leaves the drag to the body", 0f, fit.collapseFirstPx(-30f, 0f), 0f)
        // Finger down: the body returns to its own top first; the header comes back from what the body leaves.
        assertEquals(0f, fit.collapseFirstPx(40f, 100f), 0f)
        assertEquals(0f, fit.collapseFirstPx(0f, 100f), 0f)
        assertEquals(0f, fit.collapseFirstPx(Float.NaN, 100f), 0f)
        assertEquals(0f, fit.collapseFirstPx(-30f, Float.NaN), 0f)
        assertEquals(0f, fit.collapseFirstPx(-30f, -5f), 0f)
    }

    @Test fun `the compact column pins the footer outside the scroll and gives the body a full page`() {
        val kit = source("ui/kit/SheetFit.kt")
        val box = kit.indexOf("BoxWithConstraints(Modifier.fillMaxWidth().weight(1f)) {")
        val scroll = kit.indexOf("Column(Modifier.fillMaxSize().nestedScroll(collapseFirst).verticalScroll(outer)) {")
        val page = kit.indexOf("page(Modifier.fillMaxWidth().height(visible))")
        val footer = kit.indexOf("footer?.invoke(this)")
        assertTrue("header and page scroll inside the weighted box", box in 0 until scroll && scroll < page)
        assertTrue("the footer follows the box", page < footer)
        fun indent(start: String) = Regex("\\n( *)" + Regex.escape(start)).find(kit)?.groupValues?.get(1)?.length
        assertEquals("the footer is the box's sibling, outside the scroll, so the action row never scrolls away",
            indent("BoxWithConstraints(Modifier.fillMaxWidth().weight(1f)) {"), indent("footer?.invoke(this)"))
    }

    @Test fun `the clan, profile, army, hero and BUILD shells use the compact column and keep their designed tree`() {
        // HubCard: Clan (member and finder), Profile and every hub card.
        val hub = source("ui/sheets/hub/HubFrame.kt")
        assertTrue(hub.contains("SheetFitBox(Modifier.fillMaxWidth()) { compact ->"))
        assertTrue(hub.contains("else CollapsingSheetColumn(Modifier.fillMaxSize(), collapsing = headerAndTabs, footer = foot, page = parchment)"))
        assertTrue("portrait: header, parchment and footer as designed", hub.contains("parchment(Modifier.fillMaxWidth().weight(1f))\n                    foot?.invoke(this)"))
        // SheetFrame: Army (ATTACK), Hero (UPGRADE), Research and every kit tall / full sheet. HALF never changes.
        val frame = source("ui/kit/SheetFrame.kt")
        assertTrue(frame.contains("if (ui.size == SheetSize.HALF) designed()"))
        assertTrue(frame.contains("else SheetFitBox(Modifier.fillMaxWidth()) { compact ->"))
        assertTrue(frame.contains("else CollapsingSheetColumn(Modifier.fillMaxSize(), collapsing = headerAndTabs,"))
        assertTrue("the compact footer keeps its parchment, so its dark text stays readable",
            frame.contains("Plate(PlateKind.PARCHMENT, Modifier.fillMaxWidth().then(inner).padding(top = 6.dp), blocksScene = false) {"))
        assertTrue("portrait: the designed footer inside the parchment",
            frame.contains("if (footer != null) Column(Modifier.fillMaxWidth().padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(6.dp), content = footer)"))
        // The BUILD tray (HEROES: the altar offers; a card's tap opens the PLACE band).
        val tray = source("ui/sheets/buildings/BuildTray.kt")
        assertTrue(tray.contains("SheetFitBox(Modifier.fillMaxWidth()) { compact ->"))
        assertTrue(tray.contains("} else CollapsingSheetColumn(Modifier.fillMaxSize(), collapsing = headerAndTabs, page = parchment)"))
        assertTrue(tray.contains("parchment(Modifier.fillMaxWidth().weight(1f))"))
        // The framed BUILD tray keeps the safe sides and bottom (in landscape the camera cut-out is on a side).
        assertTrue(source("ui/sheets/buildings/live/LiveSheetHosts.kt")
            .contains("windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Bottom + WindowInsetsSides.Horizontal))"))
    }

    @Test fun `the standalone Clan route keeps the safe area like Profile and Event`() {
        val clan = source("ui/community/ClanHub.kt")
        assertTrue(clan.contains("val frame = modifier.then(if (hosted) Modifier else Modifier.background(PkwTokens.Colors.charcoal)"))
        assertTrue(clan.contains(".windowInsetsPadding(WindowInsets.safeDrawing).imePadding().padding(8.dp))"))
        assertEquals("the finder and the clan card both draw inside it", 2, Regex("\\), frame[,)]").findAll(clan).count())
        assertFalse("no body draws on the raw edge-to-edge window", Regex("\\), modifier[,)]").containsMatchIn(clan))
        for (sibling in listOf("ui/profile/ProfileHub.kt", "ui/community/EventHub.kt"))
            assertTrue(sibling, source(sibling).contains("Modifier.background(PkwTokens.Colors.charcoal)"))
    }

    @Test fun `the altar confirm keeps its doors pinned below the scrolling words`() {
        // In a 400 dp window the dialog card is at most 352 dp (24 dp margins); its words are longer than that with the art.
        val dialog = source("ui/kingdom/KingdomConfirmDialog.kt")
        val scroll = dialog.indexOf("Column(Modifier.fillMaxWidth().weight(1f, fill = false).verticalScroll(rememberScrollState())")
        val words = dialog.indexOf("ui.lines.forEachIndexed")
        val doors = dialog.indexOf("ConfirmDoor(ui.backLabel")
        assertTrue("the words scroll in a bounded column", scroll in 0 until words)
        assertTrue(words < doors)
        fun indent(start: String) = Regex("\\n( *)" + Regex.escape(start)).find(dialog)?.groupValues?.get(1)?.length
        val scrollIndent = indent("Column(Modifier.fillMaxWidth().weight(1f, fill = false).verticalScroll(")
        assertNotNull(scrollIndent)
        assertEquals("the door row is the scroll column's sibling", scrollIndent, indent("Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)"))
        assertEquals("one scroll in the dialog", 1, Regex("verticalScroll\\(").findAll(dialog).count())
    }

    @Test fun `the building info half sheet wraps as designed and pins its primary when the window is short`() {
        // The INFO sheet (the Hero Altar's INFO included) is about 480 dp of wrapped content; the window is 400 dp tall.
        val info = source("ui/sheets/editor/BuildingInfoSheet.kt")
        assertTrue("the parchment takes only what is left under the header, never more than its content",
            info.contains("Plate(PlateKind.PARCHMENT, Modifier.fillMaxWidth().weight(1f, fill = false),"))
        fun indent(start: String) = Regex("\\n( *)" + Regex.escape(start)).find(info)?.groupValues?.get(1)?.length
        val scrollIndent = indent("Column(Modifier.fillMaxWidth().weight(1f, fill = false).verticalScroll(rememberScrollState()),")
        assertNotNull("the stats, extra row and cost row scroll", scrollIndent)
        assertEquals("the primary is the scroll column's sibling, pinned below it", scrollIndent, indent("InfoPrimary(ui, on)"))
        assertTrue(info.indexOf("CostRow(ui, on)") < info.indexOf("InfoPrimary(ui, on)"))
        // Its only live host bounds it to the window (a bottom-aligned fillMaxSize box), so the weights have a finite height.
        assertTrue(source("ui/sheets/buildings/live/LiveSheetHosts.kt").contains("Box(modifier.fillMaxSize(), contentAlignment = Alignment.BottomCenter)"))
    }

    private fun source(relative: String): String {
        val path = "src/main/kotlin/gg/pixelkingdomwars/nativeclient/$relative"
        return listOf(File(path), File("app/$path")).first { it.isFile }.readText()
    }
}
