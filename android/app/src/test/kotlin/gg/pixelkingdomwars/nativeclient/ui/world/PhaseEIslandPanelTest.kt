package gg.pixelkingdomwars.nativeclient.ui.world

import gg.pixelkingdomwars.nativeclient.renderer.globe2.GlobeV2Pin
import gg.pixelkingdomwars.nativeclient.renderer.globe2.PhaseEIslandLayer
import gg.pixelkingdomwars.nativeclient.renderer.world.WorldIntent
import gg.pixelkingdomwars.nativeclient.renderer.world.WorldTarget
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import org.junit.Assert.*
import org.junit.Test
import kotlin.random.Random

/**
 * Players (release too, owner 2026-09-26) tap Seeker Island, Solana Island or Divine Isle on the globe and get the island
 * panel. The World HUD no longer draws the copy panel ([PhaseEIslands.panel]) for these three islands: it draws the
 * designed sheets ([WorldIslandSheet]: seeker-panel, the Public Workshop sheet, divine-panel), whose rules are pinned in
 * `IslandPanelMappersTest`. The copy cases here still pin that function's player wording while it remains. The engine
 * selects the island itself and reports it only through `GlobeEvents.selected` (a host that maps picks it does not know
 * to "nothing" would otherwise deselect it at once), so the HUD must open the panel from that event, never echo a
 * select back, close it when the engine deselects, and leave realms and exploration islands on their own paths.
 */
class PhaseEIslandPanelTest {
    @Test fun `each island's panel is the owner's player copy with a disabled coming-soon map`() {
        // Why: from 2026-09-26 players saw this panel in the release build, and the owner chose player copy over the web
        // concept's internal wording: a "Coming soon" island with its name, lore and offer, no "Phase E" kicker, no
        // "Proposed placement" caption. PhaseEIslands.panel is no longer what the World HUD draws for these three islands
        // (the designed panels are, see IslandPanelMappersTest); while the function remains, its copy must stay this honest.
        val seeker = PhaseEIslands.panel("seeker-island")!!
        assertEquals("ISLAND · COMING SOON", seeker.kicker); assertEquals("Seeker Island", seeker.title)
        assertEquals("The copper beacon of the S-shaped isle calls Seeker holders to the open sea east of Solana Reach.", seeker.epithet)
        assertEquals("Coming soon", seeker.noteTitle)
        assertEquals("the sub without its Phase E prefix (main.js islandPanel)", "100 spots — 20 King + 80 regular · 7-day SKR auction terms", seeker.note)
        val solana = PhaseEIslands.panel("solana-island")!!
        assertEquals("Solana Island", solana.title); assertEquals("100 workshop licences for crafting", solana.note)
        assertEquals("Three crystal terraces rise off the western shore of Solana Reach: observatory, mint forest and the pale harbour.", solana.epithet)
        val divine = PhaseEIslands.panel("divine-isle")!!
        assertEquals("Divine Isle", divine.title); assertEquals("500 solo trials (west) · 50 clan citadels (east)", divine.note)
        assertEquals("Split by a turquoise rift, the sacred isle lies alone in the Central Sea.", divine.epithet)
        for (p in listOf(seeker, solana, divine)) {
            for (text in listOf(p.kicker, p.title, p.epithet, p.noteTitle, p.note, p.mapLabel)) {
                assertFalse("no internal wording reaches players: $text", Regex("phase e|proposed|placement|deed address", RegexOption.IGNORE_CASE).containsMatchIn(text))
            }
            assertEquals("ISLAND · COMING SOON", p.kicker); assertEquals("Coming soon", p.noteTitle)
            assertEquals("Coming soon", p.mapLabel)
            assertFalse("island maps come later, with Phase E (D-172.2): the button can never open anything", p.mapEnabled)
        }
        // the accents are the islands' own (the outline's colour on the globe, GlobeV2Pin.PHASE_E)
        assertEquals(listOf("#ffb066", "#5ff2c8", "#ffd97a"), PhaseEIslands.ALL.map { it.accent })
        assertNull(PhaseEIslands.panel("seeker-reach")); assertNull(PhaseEIslands.panel("north-reach/2"))
    }

    @Test fun `the engine's island selection opens the island panel without echoing a select, and its deselect closes it`() {
        val start = WorldHudUi(realmId = "sunscar", panel = GlobePanel.REALM, hint = true, panelSerial = 4)
        val open = WorldHudFlow.globeSelected(start, null, "divine-isle")
        assertEquals(GlobePanel.ISLAND, open.ui.panel); assertEquals("divine-isle", open.ui.islandId)
        assertNull("an island is not a realm: no realm panel state lingers", open.ui.realmId)
        assertTrue(open.ui.panelFresh); assertEquals(5, open.ui.panelSerial); assertFalse(open.ui.hint)
        assertEquals("the engine already selected and framed it", emptyList<WorldIntent>(), open.intents)
        // the same island again (a repeated event) changes nothing; another island reopens fresh
        assertEquals(open.ui, WorldHudFlow.globeSelected(open.ui, null, "divine-isle").ui)
        val other = WorldHudFlow.globeSelected(open.ui, null, "seeker-island")
        assertEquals("seeker-island", other.ui.islandId); assertEquals(6, other.ui.panelSerial)
        // the engine deselected (sea tap, World tool): the island panel closes, again without an intent
        val closed = WorldHudFlow.globeSelected(other.ui, null, null)
        assertEquals(GlobePanel.NONE, closed.ui.panel); assertNull(closed.ui.islandId); assertTrue(closed.intents.isEmpty())
    }

    @Test fun `realms, exploration islands and the realm map are untouched by the selection event`() {
        val realm = WorldHudUi(realmId = "crownlands", panel = GlobePanel.REALM)
        assertEquals("realm selections are answered by GlobePick", realm, WorldHudFlow.globeSelected(realm, "crownlands", null).ui)
        assertEquals("a deselect event does not close a realm panel (GlobePick does)", realm, WorldHudFlow.globeSelected(realm, null, null).ui)
        val explore = WorldHudUi(panel = GlobePanel.EXPLORE, chainId = "north-reach")
        assertEquals("an exploration island id is not a Phase E island", explore, WorldHudFlow.globeSelected(explore, null, "north-reach/2").ui)
        val onMap = WorldHudUi(mode = WorldHudMode.REALM, realmId = "sunscar")
        assertEquals("the globe sleeps under a realm map", onMap, WorldHudFlow.globeSelected(onMap, null, "seeker-island").ui)
        // and a globe pick of an exploration island still opens EXPLORE, never the island panel
        assertEquals(GlobePanel.EXPLORE, WorldHudFlow.globePick(WorldHudUi(), WorldTarget.Island("north-reach/2")).ui.panel)
    }

    @Test fun `closing the island panel deselects it in the engine, by the close button and by Back`() {
        val open = WorldHudFlow.globeSelected(WorldHudUi(), null, "solana-island").ui
        val x = WorldHudFlow.deselect(open)
        assertEquals(GlobePanel.NONE, x.ui.panel); assertNull(x.ui.islandId)
        assertEquals(listOf(WorldIntent.Select(null)), x.intents)
        assertTrue(BackPriority.GLOBE_LAYERS in WorldHudFlow.backLayers(open))
        val back = WorldHudFlow.back(open, BackPriority.GLOBE_LAYERS)
        assertEquals(GlobePanel.NONE, back.ui.panel); assertEquals(listOf(WorldIntent.Select(null)), back.intents)
    }

    // ---- the owner's "where is solana island, seeker island and divine?": the islands are destinations like realms ----

    private val realmNames = listOf("Frostveil", "Elderwood", "Sunscar", "Crownlands", "Solana Reach", "Stormcairn", "Thornwake", "Cinderfall")

    @Test fun `the HUD's islands are the engine's, in its order, so an anchor names the island the engine drew there`() {
        assertEquals(GlobeV2Pin.PHASE_E.map { it.id }, PhaseEIslands.ALL.map { it.id })
        assertEquals(GlobeV2Pin.PHASE_E.map { "#%06x".format(it.accent) }, PhaseEIslands.ALL.map { it.accent })
        assertEquals(GlobeV2Pin.REALMS.size, PhaseEIslandLayer.ANCHOR_BASE)
        val names = PhaseEIslands.labelNames(realmNames)
        assertEquals(realmNames + listOf("Seeker Island", "Solana Island", "Divine Isle"), names)
        for ((i, isle) in PhaseEIslands.ALL.withIndex()) {
            assertEquals(isle, PhaseEIslands.byAnchor(PhaseEIslands.anchorId(i)))
            assertEquals(isle.title, names[PhaseEIslands.anchorId(i)])
        }
        for (r in realmNames.indices) assertNull("anchor $r is a realm", PhaseEIslands.byAnchor(r))
        // a short realm list never shifts the islands onto realm ids (padded with unnamed slots)
        assertEquals("Seeker Island", PhaseEIslands.labelNames(realmNames.take(5))[PhaseEIslands.anchorId(0)])
    }

    @Test fun `island labels are placed like realm names, clear of every control, and the open island's name is left to its panel`() {
        val rnd = Random(172)
        val names = PhaseEIslands.labelNames(realmNames)
        var islandsPlaced = 0
        for (d in SeekerRows.DENSITIES) for (portrait in listOf(true, false)) {
            val (w, h) = if (portrait) SeekerRows.portrait(d) else SeekerRows.landscape(d)
            val type = HudType.of(d, !portrait, h)
            val plan = GlobeHudPlan.plan(GlobeHudPlan.Input(w, h, if (portrait) SeekerRows.PORTRAIT_INSETS else SeekerRows.LANDSCAPE_INSETS, type,
                destinations = names, mapped = setOf(0, 4)))
            val controls = plan.controls.map { it.rect } + plan.railRow
            repeat(40) {
                val count = names.size; val ids = IntArray(count) { it }
                val xy = FloatArray(count * 2) { i -> if (i % 2 == 0) rnd.nextFloat() * w * d else rnd.nextFloat() * h * d }
                val labels = WorldLabels.globe(ids, xy, count, d, names, type, plan.labelRects(w, h), w, h, hideIndex = null)
                for (l in labels) for (c in controls) assertFalse("${names[l.id]} covers $c", HudRect(l.x, l.y, l.w, l.h).intersects(c))
                islandsPlaced += labels.count { PhaseEIslands.byAnchor(it.id) != null }
                val hidden = WorldLabels.globe(ids, xy, count, d, names, type, plan.labelRects(w, h), w, h, hideIndex = PhaseEIslands.anchorId(2))
                assertTrue("the open island's panel names it", hidden.none { it.id == PhaseEIslands.anchorId(2) })
            }
        }
        assertTrue("island labels were placed: $islandsPlaced", islandsPlaced > 100)
        // an unnamed anchor (no realm name for it) is never drawn as an empty label
        assertTrue(WorldLabels.globe(intArrayOf(3), floatArrayOf(600f, 900f), 1, 3f, listOf("", "", "", ""), HudType.of(3f, false, 800f),
            emptyList(), 400f, 800f, null).isEmpty())
    }

    @Test fun `a rail chip opens the island panel and selects the island in the engine, and the engine's echo changes nothing`() {
        val start = WorldHudUi(realmId = "seeker-reach", panel = GlobePanel.REALM, hint = true, panelSerial = 2)
        val step = PhaseEIslands.select(start, "seeker-island")
        assertEquals(GlobePanel.ISLAND, step.ui.panel); assertEquals("seeker-island", step.ui.islandId); assertNull(step.ui.realmId)
        assertTrue(step.ui.panelFresh); assertEquals(3, step.ui.panelSerial); assertFalse(step.ui.hint)
        assertEquals("the engine's live Phase E layer takes the id and frames it", listOf(WorldIntent.Select(WorldTarget.Island("seeker-island"))), step.intents)
        val echo = WorldHudFlow.globeSelected(step.ui, null, "seeker-island")
        assertEquals(step.ui, echo.ui); assertTrue("no select back", echo.intents.isEmpty())
        // not under a realm map, and never for an id that is not a Phase E island
        val onMap = WorldHudUi(mode = WorldHudMode.REALM, realmId = "sunscar")
        assertEquals(HudStep(onMap), PhaseEIslands.select(onMap, "divine-isle"))
        assertEquals(HudStep(start), PhaseEIslands.select(start, "north-reach/2"))
    }

    /**
     * The critic's defect 1 on the HUD side: once the host forwards `GlobeEvents.selected`, a globe tap on an island while
     * a realm panel is open must replace that panel (the engine has already deselected the realm and outlined the
     * island), and a realm tap afterwards must bring the realm panel back, the engine's own echoes changing nothing.
     */
    @Test fun `realm panel, then island tap, then realm tap, the panel follows the engine's selection each time`() {
        val realm = WorldHudFlow.globePick(WorldHudUi(), WorldTarget.Realm("crownlands")).ui
        assertEquals(GlobePanel.REALM, realm.panel)
        val island = WorldHudFlow.globeSelected(realm, null, "solana-island")
        assertEquals(GlobePanel.ISLAND, island.ui.panel); assertEquals("solana-island", island.ui.islandId); assertNull(island.ui.realmId)
        val back = WorldHudFlow.globePick(island.ui, WorldTarget.Realm("stormcairn"))
        assertEquals(GlobePanel.REALM, back.ui.panel); assertEquals("stormcairn", back.ui.realmId)
        assertEquals(listOf(WorldIntent.Select(WorldTarget.Realm("stormcairn")), WorldIntent.FlyTo(WorldTarget.Realm("stormcairn"))), back.intents)
        // the engine's echoes of that realm selection, before or after the pick, leave the realm panel alone
        assertEquals(back.ui, WorldHudFlow.globeSelected(back.ui, "stormcairn", null).ui)
        assertEquals(back.ui, WorldHudFlow.globeSelected(back.ui, null, null).ui)
    }

    @Test fun `the rail has island chips only when this build's world bundle says so (RG-3 everywhere else)`() {
        assertEquals(PhaseEIslands.ALL, PhaseEIslands.chips("""{"schema":1,"phaseEIslands":true,"files":[]}""".toByteArray()))
        assertEquals("a release build has no world bundle", emptyList<PhaseEIslandInfo>(), PhaseEIslands.chips(null))
        for (index in listOf("""{"schema":1,"phaseEIslands":false}""", """{"schema":1,"files":[]}""", """{"phaseEIslands":"""))
            assertEquals(index, emptyList<PhaseEIslandInfo>(), PhaseEIslands.chips(index.toByteArray()))
        assertEquals("world/content.json", PhaseEIslands.WORLD_INDEX_ASSET)
    }
}
