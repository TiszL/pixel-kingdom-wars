package gg.pixelkingdomwars.nativeclient.ui.world

import org.junit.Assert.*
import org.junit.Test

/** UI3: source-owned map chrome must never invent facts or change a destination. the content pipeline executes these. */
class WorldChromeMountTest {
    @Test fun `island rail IDs round trip to their existing selection owners`() {
        val pairs = mapOf("seeker" to "seeker-island", "solana" to "solana-island", "divine" to "divine-isle")
        pairs.forEach { (rail, owner) ->
            assertEquals(owner, worldIslandDestination(rail))
            assertEquals(rail, worldIslandRailId(owner))
        }
        assertNull(worldIslandDestination("frostveil"))
        assertNull(worldIslandDestination("unknown"))
    }
    @Test fun `rail preserves catalogue order after enabled islands and marks only current home realm`() {
        val realms = listOf(realm("second"), realm("first"))
        val rail = worldChromeRail(realms, listOf("divine-isle", "seeker-island"), "first")
        assertEquals(listOf("seeker", "divine", "second", "first"), rail.map { it.id })
        assertEquals(listOf("first"), rail.filter { it.home }.map { it.id })
        assertTrue(rail.filter { it.id in setOf("seeker", "divine") }.all { it.tag == null && it.badge == null })
    }
    @Test fun `unknown feed is ellipsis and no shield waits for the authoritative bit`() {
        val chips = worldChromeFilters(emptyList(), RealmFilter(), feedReady = false, shieldFed = false)
        assertEquals(listOf("all", "mine", "lvl"), chips.map { it.id })
        assertEquals(listOf("…", "…", ""), chips.map { it.count })
    }
    @Test fun `shield unknown is never counted as unshielded and known empty is zero`() {
        val bases = listOf(base(1, true, null), base(2, false, true), base(3, false, false))
        val chips = worldChromeFilters(bases, RealmFilter(kind = "unshielded"), true, true)
        assertEquals(listOf("3", "1", "1", ""), chips.map { it.count })
        assertEquals("unshielded", chips.single { it.on }.id)
        assertEquals("0", worldChromeFilters(emptyList(), RealmFilter(), true, true).first().count)
    }
    @Test fun `only selected base snapshot can feed resource rows`() {
        assertTrue(worldChromeBaseIsCurrent("a", "a"))
        assertFalse(worldChromeBaseIsCurrent("a", "b"))
        assertFalse(worldChromeBaseIsCurrent(null, null))
        assertFalse(worldChromeBaseIsCurrent("a", null))
    }
    @Test fun `display only world readouts preserve amounts and remove the drawer affordance`() {
        val row = gg.pixelkingdomwars.nativeclient.ui.model.ResourceChipUi(
            gg.pixelkingdomwars.nativeclient.ui.features.FeatureId("resources.skr"), "currency-skr", "…", null,
            false, null, name = "SKR", drawerHandle = true)
        val output = worldChromeReadouts(listOf(row))
        assertEquals(listOf(row.copy(drawerHandle = false)), output)
        assertTrue(row.drawerHandle)
        assertEquals("…", output.single().value)
    }
    @Test fun `search row identity carries realm and tile without treating display text as destination`() {
        assertEquals("realm-a:42", worldSearchRowId("realm-a", 42))
        assertNotEquals(worldSearchRowId("realm-a", 42), worldSearchRowId("realm-b", 42))
    }
    @Test fun `designed island label reserves its full touch shell away from chrome`() {
        val island = PhaseEIslands.anchorId(0)
        val obstacle = HudRect(0f, 0f, 412f, 150f)
        val labels = worldChromeGlobeLabels(intArrayOf(island), floatArrayOf(206f, 280f), 1, 1f,
            emptyList(), HudType.of(1f, false, 880f), listOf(obstacle), 412f, 880f, null)
        val label = labels.single()
        assertEquals(112f, label.w)
        assertEquals(48f, label.h)
        assertTrue(label.y >= obstacle.bottom + 4f)
    }
    @Test fun `selected island name is not duplicated over its existing panel`() {
        val island = PhaseEIslands.anchorId(0)
        assertTrue(worldChromeGlobeLabels(intArrayOf(island), floatArrayOf(206f, 280f), 1, 1f,
            emptyList(), HudType.of(1f, false, 880f), emptyList(), 412f, 880f, island).isEmpty())
    }
    @Test fun `phone title moves below its buttons before minimum row width overflows`() {
        assertTrue(gg.pixelkingdomwars.nativeclient.ui.sheets.map.mapTopBarCompact(360f))
        assertFalse(gg.pixelkingdomwars.nativeclient.ui.sheets.map.mapTopBarCompact(412f))
    }
    // ---- MS-UI3 mount: which designed body the World tab opens for each state ----
    // Why: the old frames told players false things ("ISLAND · COMING SOON" over islands whose owners are open, "Exploration
    // locked" while the Lodge sends expeditions) or drew a second card under the designed one. Each state must open exactly
    // one body, and the old frame must never come back for a state a designed sheet now owns.

    @Test fun `a selected Phase E island opens its designed sheet and never the old coming soon frame`() {
        for (id in listOf("seeker-island", "solana-island", "divine-isle")) {
            val picked = PhaseEIslands.select(WorldHudUi(), id).ui
            assertEquals(id, WorldGlobeSheet.ISLAND, worldGlobeSheet(picked, parcelRead = false))
            assertFalse("$id: no old island frame under the sheet", worldGlobeFramePanel(picked))
            // the engine's own pick of the island (a tap on the globe) lands on the same sheet
            assertEquals(id, WorldGlobeSheet.ISLAND, worldGlobeSheet(WorldHudFlow.globeSelected(WorldHudUi(), null, id).ui, parcelRead = true))
        }
    }

    @Test fun `a globe parcel opens the designed kingdom sheet once this base's world read is in, and never the old card`() {
        val parcel = WorldHudFlow.openPanel(WorldHudUi(realmId = "sunscar"), GlobePanel.PARCEL).ui
        assertEquals(WorldGlobeSheet.PARCEL, worldGlobeSheet(parcel, parcelRead = true))
        assertEquals("another base's read never answers for this one", WorldGlobeSheet.NONE, worldGlobeSheet(parcel, parcelRead = false))
        assertFalse("the old frame and its ParcelCardBody never draw under it", worldGlobeFramePanel(parcel))
        // MY PARCEL on a realm without a map opens the same sheet
        val mine = WorldHudFlow.myParcel(WorldHudUi(), "sunscar", mapped = false).ui
        assertEquals(WorldGlobeSheet.PARCEL, worldGlobeSheet(mine, parcelRead = true))
    }

    // Rewritten by c-gap-map (2026-10-06): this case pinned the archipelago chain list on the old dark frame because the packet
    // had no frame for it. The owner then ruled that no old screen may remain ("I should not see any even 1 of old screens"),
    // so the list is a designed map half sheet now; the rule kept is that one state opens exactly one body.
    @Test fun `an archipelago island opens its designed sheet and the chain list its designed EXPLORE sheet, never the old frame`() {
        val island = WorldHudFlow.selectIsland(WorldHudUi(), "glasswake/0").ui
        assertEquals(WorldGlobeSheet.ARCHIPELAGO, worldGlobeSheet(island, parcelRead = true))
        assertFalse(worldGlobeFramePanel(island))
        val list = WorldHudFlow.openPanel(WorldHudUi(), GlobePanel.EXPLORE).ui
        assertEquals(WorldGlobeSheet.EXPLORE, worldGlobeSheet(list, parcelRead = true))
        assertFalse(worldGlobeFramePanel(list))
        // back to the list from an island ("All archipelagos" or a chain row) drops the island sheet for the list's
        val back = WorldHudFlow.openPanel(island.copy(chainId = null), GlobePanel.EXPLORE).ui
        assertEquals(WorldGlobeSheet.EXPLORE, worldGlobeSheet(back, parcelRead = true))
        assertFalse(worldGlobeFramePanel(back))
    }

    // Rewritten by c-gap-map (2026-10-06): this case pinned the realm, warzone and parcel-help panels on the old dark frame.
    // They are designed map half sheets now (owner: no old screen may remain); one body per state is still the rule, and the
    // old frame draws for nothing at all.
    @Test fun `the realm, warzone and parcel help panels open their designed sheets and the old frame draws for nothing`() {
        val expected = mapOf(WorldHudFlow.selectRealm(WorldHudUi(), "sunscar").ui to WorldGlobeSheet.REALM,
            WorldHudFlow.openPanel(WorldHudUi(), GlobePanel.WARZONE).ui to WorldGlobeSheet.WARZONE,
            WorldHudFlow.openPanel(WorldHudUi(), GlobePanel.PARCEL_HELP).ui to WorldGlobeSheet.PARCEL_HELP)
        expected.forEach { (ui, sheet) ->
            assertEquals(ui.panel.name, sheet, worldGlobeSheet(ui, parcelRead = true))
            assertFalse(ui.panel.name, worldGlobeFramePanel(ui))
        }
        // every panel the globe can show: never the old frame, on the globe or in a dive
        for (panel in GlobePanel.entries) for (mode in WorldHudMode.entries)
            assertFalse("$panel/$mode", worldGlobeFramePanel(WorldHudUi(mode = mode, panel = panel, realmId = "sunscar", islandId = "seeker-island")))
        assertFalse("nothing open, nothing drawn", worldGlobeFramePanel(WorldHudUi()))
        assertEquals(WorldGlobeSheet.NONE, worldGlobeSheet(WorldHudUi(), parcelRead = true))
    }

    @Test fun `no globe sheet or frame is drawn while a dive is in flight`() {
        // a sheet left over the dive's clouds would take taps meant for a map that is not on screen yet
        val island = PhaseEIslands.select(WorldHudUi(), "divine-isle").ui.copy(mode = WorldHudMode.DIVING)
        val parcel = WorldHudFlow.openPanel(WorldHudUi(), GlobePanel.PARCEL).ui.copy(mode = WorldHudMode.DIVING)
        assertEquals(WorldGlobeSheet.NONE, worldGlobeSheet(island, parcelRead = true))
        assertEquals(WorldGlobeSheet.NONE, worldGlobeSheet(parcel, parcelRead = true))
        assertFalse(worldGlobeFramePanel(parcel))
    }

    @Test fun `a realm card opens the Reach sheet only for a reserved Seeker tile and the kingdom sheet otherwise`() {
        assertEquals(WorldRealmSheet.REACH, worldRealmSheet(cardOpen = true, parcelRead = true, parcel = parcel("seeker", "reserved")))
        // a Genesis reserve or an open deed is the kingdom sheet (its own land notes), never the Seeker OFF sheet
        assertEquals(WorldRealmSheet.KINGDOM, worldRealmSheet(true, true, parcel("genesis", "reserved")))
        assertEquals(WorldRealmSheet.KINGDOM, worldRealmSheet(true, true, parcel("public", "available")))
        // the read still in flight shows the kingdom sheet's silhouette, as the old card did
        assertEquals(WorldRealmSheet.KINGDOM, worldRealmSheet(true, true, null))
        assertEquals(WorldRealmSheet.NONE, worldRealmSheet(cardOpen = false, parcelRead = true, parcel = parcel("seeker", "reserved")))
        assertEquals("another base's read never answers for this one", WorldRealmSheet.NONE, worldRealmSheet(true, false, null))
    }

    @Test fun `the World tab mounts the designed bodies and no longer draws the old card, island panel or locked note`() {
        val screen = java.io.File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/world/WorldHudScreen.kt").readText()
        val globe = java.io.File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/world/GlobeHud.kt").readText()
        for (body in listOf("WorldIslandSheet(", "WorldParcelSheet(", "WorldArchipelagoSheet(", "WorldReachTileSheet(")) assertTrue(body, body in screen)
        assertFalse("the old base card is off the user path", "ParcelCardBody(" in screen)
        assertTrue("RealmMapHud draws no old card frame", "card = null, elsewhere = elsewhere" in screen)
        assertFalse("Exploration is not locked: the Lodge sends expeditions", "Exploration locked" in screen)
        assertFalse("the ISLAND · COMING SOON panel is gone", "IslandPanelBody" in globe || "PhaseEIslands::panel" in globe)
        assertTrue("the frame opens only where no designed sheet exists", "panelOpen = worldGlobeFramePanel(ui)" in screen)
        // the island doors reach Bases' Phase E owners and the Clan Hall; Bases launches the activity once, then forgets it
        val app = java.io.File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/nav/PkwApp.kt").readText()
        assertTrue("onOpenPhaseE = { a -> navController.navigate(BasesRoute(launch = a.name)) { launchSingleTop = true } }" in app)
        assertTrue("onOpenClanHall = { navController.navigate(ClansRoute) { launchSingleTop = true } }" in app)
        val bases = app.substring(app.indexOf("composable<BasesRoute>"), app.indexOf("BasesScreen(graphViewModel"))
        assertTrue("the pending launch outlives the registrations", bases.indexOf("rememberSaveable(backStack.id)") < bases.indexOf("PhaseERegistration("))
        assertTrue("a launch that cannot open says why", "if (!opened)" in bases && "PHASE_E_NOT_OPEN_LINE" in bases && "pendingLaunch = null" in bases)
    }

    @Test fun `the island place labels carry the designed names and fit their chip without an ellipsis`() {
        // Why: the chip is 104 dp, of which the icon takes 28 and the end pad 4 (PlaceLabel, map SPEC §1.5), so the name has
        // 72 dp less the 1 dp outline each side; the full titles ran past it ("Solana I…", owner 2026-10-06 screenshot 6).
        // The bound is the bundled VT323's widest advance at the small style, so a font or size change that stops a name
        // fitting fails here.
        val font = java.io.File("src/main/res/font/pkw_vt323.ttf").readBytes()
        fun u16(at: Int) = ((font[at].toInt() and 0xFF) shl 8) or (font[at + 1].toInt() and 0xFF)
        fun table(tag: String): Int {
            for (i in 0 until u16(4)) {
                val r = 12 + 16 * i
                if (String(font, r, 4, Charsets.US_ASCII) == tag) return (u16(r + 8) shl 16) or u16(r + 10)
            }
            fail("the font has no $tag table"); return -1
        }
        val perChar = u16(table("hhea") + 10).toFloat() / u16(table("head") + 18) * gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens.Type.VT_FLOOR
        val box = 104f - 28f - 4f - 2f
        val names = listOf("seeker-island", "solana-island", "divine-isle").map { worldIslandPlaceName(it) }
        assertEquals(listOf("SEEKER", "SOLANA", "DIVINE"), names)
        for (name in names.map { it!! }) assertTrue("$name: ${name.length * perChar} dp in $box", name.length * perChar <= box)
        assertTrue("the full title is what overflowed", PhaseEIslands.byId("solana-island")!!.title.length * perChar > box)
        assertNull(worldIslandPlaceName("frostveil"))
        val screen = java.io.File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/world/WorldHudScreen.kt").readText()
        assertTrue("the globe's island chip shows the designed name", "worldIslandPlaceName(isle.id) ?: isle.title" in screen)
    }

    private fun parcel(allocation: String, availability: String) = gg.pixelkingdomwars.nativeclient.model.FantasyParcel.from(gg.pixelkingdomwars.nativeclient.json(
        """{"worldId":"fantasy-v1","tile":{"worldId":"fantasy-v1","tileId":7,"realmId":"seeker-reach","allocation":"$allocation"},"availability":"$availability"}"""))
    private fun realm(id: String) = GlobeRealmInfo(id, id, null, null, null, null, null, null, null, null, 0)
    private fun base(id: Int, mine: Boolean, shield: Boolean?) = RealmHudBase(id, id, 0, "Kingdom $id", 1, mine, shield)
}
