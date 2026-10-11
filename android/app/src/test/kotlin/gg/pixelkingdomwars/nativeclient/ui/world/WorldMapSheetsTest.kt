package gg.pixelkingdomwars.nativeclient.ui.world

import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.MAP_TOP_BAR_ONE_ROW_MIN
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.mapTopBarCompact
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.mapTopBarTight
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File

/**
 * c-gap-map (2026-10-06): the globe and realm-map panels that drew the old dark web frame are designed map half sheets now.
 * WHY these rules matter: the sheets must keep saying exactly what the server read said (an unknown count is "…", never a
 * false 0; a shield is shown only when the read carried it), every door must answer a tap, and the designed one-row top bar
 * must hold on the Seeker's 400 dp without cutting the title.
 */
class WorldMapSheetsTest {
    private fun realm(id: String, deeds: Int? = null, kingdoms: Int? = null, open: Int? = null, mine: Int = 0, genesis: Int? = null, seeker: Int? = null) =
        GlobeRealmInfo(id, id.replaceFirstChar { it.uppercase() }, "I", "FROZEN NORTH", "The sleeping north", null, null, deeds, kingdoms, open, mine, genesis, seeker)

    @Test fun `realm counts not read yet stay unknown and never show as zero`() {
        val stats = realmSheetStats(realm("frostveil"))
        assertEquals(listOf("DEEDS", "KINGDOMS", "OPEN DEEDS", "YOUR BASES"), stats.map { it.label })
        assertEquals(listOf("…", "…", "…", "0"), stats.map { it.value })
        // the server's counts with thousands separators, as the title plate and the old panel print them
        val read = realmSheetStats(realm("frostveil", deeds = 12958, kingdoms = 3150, open = 9808, mine = 1))
        assertEquals(listOf("12,958", "3,150", "9,808", "1"), read.map { it.value })
    }

    @Test fun `the reserved Solana Reach shows its allocations and no open deed`() {
        val stats = realmSheetStats(realm("seeker-reach", deeds = 4000, genesis = 1000, seeker = 3000))
        assertEquals(listOf("DEEDS", "GENESIS", "SEEKER", "OPEN DEEDS"), stats.map { it.label })
        assertEquals(listOf("4,000", "1,000", "3,000", "0"), stats.map { it.value })
    }

    @Test fun `every realm CTA answers a tap and only Enter map or Choose land may lead in gold`() {
        val faces = RealmCta.Kind.entries.flatMap { kind -> listOf(true, false).map { gold -> kind to realmCtaFace(RealmCta(kind, gold, 40), "Frostveil") } }
        for ((kind, face) in faces) {
            // DISABLED says why on a tap; BUSY is the preparing map (dots, nothing to send twice); everything else acts
            when (face.state) {
                CommandState.DISABLED -> assertNotNull("$kind explains itself", face.refusal)
                CommandState.BUSY -> assertEquals(RealmCta.Kind.PREPARING, kind)
                else -> assertEquals(CommandState.ENABLED, face.state)
            }
        }
        // My base is a place to go (blue, DESIGN-SYSTEM §2) unless the panel made it the gold lead (MY PARCEL)
        assertEquals(Verb.BLUE, realmCtaFace(RealmCta(RealmCta.Kind.MY_BASE, false), "Frostveil").verb)
        assertEquals(Verb.GOLD, realmCtaFace(RealmCta(RealmCta.Kind.MY_BASE, true), "Frostveil").verb)
        assertEquals("No map for Frostveil yet", realmCtaFace(RealmCta(RealmCta.Kind.NO_MAP, false), "Frostveil").refusal)
        assertEquals("Preparing 40%", realmCtaFace(RealmCta(RealmCta.Kind.PREPARING, true, 40), "Frostveil").label)
    }

    @Test fun `the warzone sheet keeps the old status words and names the cooldown only when the catalogue does`() {
        fun status(mode: String, active: Boolean) = WorldWarzone(mode, active, null, null)
        assertEquals("WARZONES OFF", warzoneHeadline(status("off", false)))
        assertEquals("PURGE WARZONE ACTIVE", warzoneHeadline(status("purge", true)))
        assertEquals("WARZONE ACTIVE", warzoneHeadline(status("scheduled", true)))
        assertEquals("NO WARZONE ACTIVE", warzoneHeadline(status("purge", false)))
        assertEquals("NEXT WARZONE", warzoneHeadline(status("scheduled", false)))
        assertEquals("Purges are unannounced", warzoneNoClockLine(status("purge", false)))
        assertEquals("No active window", warzoneNoClockLine(status("off", false)))
        assertTrue(warzoneRuleLine(true, 24).endsWith("A defender can be hit again after 24H."))
        assertFalse("no invented cooldown when the catalogue has none", warzoneRuleLine(true, null).contains("after"))
        assertTrue(warzoneRuleLine(false, 24).startsWith("Ordinary shields protect normally."))
    }

    @Test fun `the explore sheet lists only chains it can open, in catalogue order`() {
        val chains = Json.parseToJsonElement("""[{"id":"aurora","name":"Aurora","islands":[{},{},{}]},{"name":"No id","islands":[{}]},
            {"id":"glasswake","islands":[]}]""").let { it as kotlinx.serialization.json.JsonArray }.map { it.jsonObject }
        assertEquals(listOf(ExploreChainUi("aurora", "Aurora", 3), ExploreChainUi("glasswake", "Islands", 0)), exploreChains(chains))
    }

    @Test fun `an EXPLORE island row names the island exactly as the sheet it opens`() {
        // Why: the row said "Aurora · Island 2" and the sheet it opened "AURORA ISLE 2"; a player must recognise the place
        // they tapped. The row and archipelagoPanelUi's header are one name, the header in capitals.
        val chains = Json.parseToJsonElement("""[{"id":"aurora","name":"Aurora","islands":[{},{}]},{"id":"glasswake","islands":[{}]}]""")
            .let { it as kotlinx.serialization.json.JsonArray }.map { it.jsonObject }
        for ((chainId, name, slot) in listOf(Triple("aurora", "Aurora", 1), Triple("glasswake", null, 0))) {
            val sheet = gg.pixelkingdomwars.nativeclient.ui.sheets.map.live.archipelagoPanelUi("$chainId/$slot", chains, emptyMap(), null, null, null)
            assertEquals(sheet.name, exploreIslandTitle(chainId, name, slot).uppercase())
        }
        assertEquals("Aurora Isle 2", exploreIslandTitle("aurora", "Aurora", 1))
    }

    @Test fun `your kingdom on the realm map wears the YOU plate and every level filter door answers`() {
        // Why (map-realm.png): your own base is marked by the gold YOU plate in place of its name tag, sized from the box the
        // label placement gave the tag so it never covers a neighbour; ALL LEVELS is never a dead door (it shows every level
        // and closes the sheet even when the range is already full).
        val screen = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/world/WorldHudScreen.kt").readText()
        assertTrue("if (label.base.mine) RealmYouPlate(label.base.shield == true," in screen)
        assertTrue("WorldHudFlow.setFilter(ui.copy(levelOpen = false)" in screen)
        val sheets = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/world/WorldMapSheets.kt").readText()
        val allLevels = sheets.lines().first { "SecondaryButton(\"ALL LEVELS\"" in it }
        assertFalse("ALL LEVELS is never disabled", "enabled" in allLevels)
    }

    @Test fun `the realm map shows one status sheet at a time and never over a card or the search drawer`() {
        assertEquals(RealmPanelSheet.NONE, realmPanelSheet(cardOpen = true, searchShown = false, warzoneOpen = true, levelOpen = false))
        assertEquals(RealmPanelSheet.NONE, realmPanelSheet(cardOpen = false, searchShown = true, warzoneOpen = false, levelOpen = true))
        assertEquals(RealmPanelSheet.WARZONE, realmPanelSheet(cardOpen = false, searchShown = false, warzoneOpen = true, levelOpen = true))
        assertEquals(RealmPanelSheet.LEVEL, realmPanelSheet(cardOpen = false, searchShown = false, warzoneOpen = false, levelOpen = true))
        assertEquals(RealmPanelSheet.NONE, realmPanelSheet(cardOpen = false, searchShown = false, warzoneOpen = false, levelOpen = false))
    }

    @Test fun `search rows read like the frame and claim a shield only when the read carried one`() {
        assertEquals("Spot7Raider · Lv 12", searchRowTitle("Spot7Raider", 12))
        assertEquals("Frostveil · no shield", searchRowPlace("Frostveil", false, null))
        assertEquals("Frostveil · shielded", searchRowPlace("Frostveil", true, null))
        assertEquals("an unread shield is never claimed", "Frostveil", searchRowPlace("Frostveil", null, null))
        assertEquals("Frostveil · 1,412 trophies", searchRowPlace("Frostveil", null, 1412))
    }

    @Test fun `the realm title plate says how many kingdoms are here, unknown until read`() {
        assertEquals("3,150 kingdoms here", realmChromeSubtitle(3150, null))
        assertEquals("… kingdoms here", realmChromeSubtitle(null, null))
        assertEquals("3,150 kingdoms · detail 40%", realmChromeSubtitle(3150, "detail 40%"))
    }

    @Test fun `the Seeker's 400 dp keeps the designed one-row map bar with the WORLD sub-line uncut`() {
        // The Seeker is 1200 px at density 3.0: 400 dp. Its owner screenshots (2026-10-06, 5.jpg and 6.jpg) showed the title on a
        // second row under HOME and search, which no map frame draws.
        assertFalse(mapTopBarCompact(400f))
        assertTrue(mapTopBarTight(400f))
        assertFalse("the frames' own 412 dp keeps the frame's gaps", mapTopBarTight(412f))
        assertTrue("a 360 dp phone still drops the title to its own row", mapTopBarCompact(360f))
        // the arithmetic behind the bound: 8 + HOME 56 + 4, title, 4 + search 52, 4 + stack 108 + 8, and the plate's 5 + 5 inset,
        // against "8 realms · 3 islands" in the bundled VT323 at the 18 sp floor
        val font = File("src/main/res/font/pkw_vt323.ttf").readBytes()
        fun u16(at: Int) = ((font[at].toInt() and 0xFF) shl 8) or (font[at + 1].toInt() and 0xFF)
        fun table(tag: String): Int {
            for (i in 0 until u16(4)) { val r = 12 + 16 * i; if (String(font, r, 4, Charsets.US_ASCII) == tag) return (u16(r + 8) shl 16) or u16(r + 10) }
            fail("the font has no $tag table"); return -1
        }
        val perChar = u16(table("hhea") + 10).toFloat() / u16(table("head") + 18) * gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens.Type.VT_FLOOR
        val textBox = MAP_TOP_BAR_ONE_ROW_MIN - (8f + 56f + 4f) - (4f + 52f) - (4f + 108f + 8f) - 10f
        assertTrue("${"8 realms · 3 islands".length * perChar} dp in $textBox", "8 realms · 3 islands".length * perChar <= textBox)
    }

    @Test fun `the World tab draws no old dark panel body any more`() {
        val screen = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/world/WorldHudScreen.kt").readText()
        for (old in listOf("WarzoneBody(", "ExploreBody(", "HudMeter(", "ModalScrim(.4f")) assertFalse(old, old in screen)
        for (designed in listOf("WorldRealmPlaceSheet(", "WorldWarzoneSheet(", "WorldExploreSheet(", "WorldParcelHelpSheet(", "WorldLevelSheet("))
            assertTrue(designed, designed in screen)
        // the LV range's old HudRange panel is switched off where the designed sheet draws
        assertTrue("levelPanel = false" in screen)
        // the World header (update banner, test-server tag) overlays the full-screen map instead of pushing it down
        val scaffold = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/home/HomeScaffold.kt").readText()
        assertTrue("else if (tab == HomeTab.WORLD) Box(Modifier.fillMaxSize()) {" in scaffold)
    }
}
