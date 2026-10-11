package gg.pixelkingdomwars.nativeclient.ui.world

import gg.pixelkingdomwars.nativeclient.data.WorldEntry
import gg.pixelkingdomwars.nativeclient.data.WorldRealmFeed
import gg.pixelkingdomwars.nativeclient.model.FantasyRect
import gg.pixelkingdomwars.nativeclient.renderer.world.WorldFilter
import gg.pixelkingdomwars.nativeclient.renderer.world.WorldFilterKind
import gg.pixelkingdomwars.nativeclient.renderer.world.WorldIntent
import gg.pixelkingdomwars.nativeclient.renderer.world.WorldTarget
import gg.pixelkingdomwars.nativeclient.ui.home.HomeRequest
import gg.pixelkingdomwars.nativeclient.ui.home.HomeRequests
import gg.pixelkingdomwars.nativeclient.ui.home.HomeTab
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import org.junit.Assert.*
import org.junit.Test

/**
 * The World tab's flow (GLOBE-NATIVE-PLAN §3.5): the HUD, never the engine, decides what is selected, when a dive starts
 * and where Back goes. A wrong transition here strands the player on an empty map or skips a layer on Back.
 */
class WorldHudFlowTest {
    private fun WorldHudUi.run(vararg f: (WorldHudUi) -> HudStep): Pair<WorldHudUi, List<WorldIntent>> {
        var u = this; val out = ArrayList<WorldIntent>()
        for (step in f) { val s = step(u); u = s.ui; out += s.intents }
        return u to out
    }

    @Test fun `a rail or globe tap selects the realm and flies to it, the sea deselects`() {
        val (u, intents) = WorldHudUi().run({ WorldHudFlow.globePick(it, WorldTarget.Realm("sunscar")) })
        assertEquals(GlobePanel.REALM, u.panel); assertEquals("sunscar", u.realmId); assertFalse(u.hint)
        assertEquals(listOf(WorldIntent.Select(WorldTarget.Realm("sunscar")), WorldIntent.FlyTo(WorldTarget.Realm("sunscar"))), intents)
        val (sea, clear) = u.run({ WorldHudFlow.globePick(it, null) })
        assertEquals(GlobePanel.NONE, sea.panel); assertEquals(listOf(WorldIntent.Select(null)), clear)
        val (isle, _) = WorldHudUi().run({ WorldHudFlow.globePick(it, WorldTarget.Island("north-reach/2")) })
        assertEquals(GlobePanel.EXPLORE, isle.panel); assertEquals("north-reach", isle.chainId)
    }

    @Test fun `enter map dives once, lands on a fresh approved HUD, and My base selects your deed at the base distance`() {
        val mine = RealmCard(5000, 200, 6)
        val start = WorldHudUi(realmId = "crownlands", panel = GlobePanel.REALM, filter = RealmFilter("mine", 3, 9), levelOpen = true)
        val (diving, dive) = start.run({ WorldHudFlow.enterMap(it, "crownlands", mine = true) })
        assertEquals(WorldHudMode.DIVING, diving.mode); assertEquals(listOf(WorldIntent.Dive("crownlands")), dive)
        assertTrue("a second tap during the flight does nothing", WorldHudFlow.enterMap(diving, "crownlands").intents.isEmpty())
        val landed = WorldHudFlow.dived(diving, "crownlands", mine)
        assertEquals(WorldHudMode.REALM, landed.ui.mode)
        assertEquals("the approved defaults: All, level 1–20, minimap open", RealmFilter(), landed.ui.filter); assertFalse(landed.ui.levelOpen); assertTrue(landed.ui.miniOpen)
        assertEquals(mine, landed.ui.card)
        val target = WorldTarget.Deed("crownlands", 200, 6)
        assertEquals(listOf(WorldIntent.Select(target), WorldIntent.FlyTo(target, HudBands.MY_BASE_D)), landed.intents)
        val searched = WorldHudFlow.dived(WorldHudFlow.enterMap(start, "crownlands", tile = RealmCard(7, 7, 0)).ui, "crownlands", mine)
        assertEquals(listOf(WorldIntent.Select(WorldTarget.Deed("crownlands", 7, 0)), WorldIntent.FlyTo(WorldTarget.Deed("crownlands", 7, 0), HudBands.SELECT_D)), searched.intents)
        val failed = WorldHudFlow.diveFailed(diving, "crownlands").ui
        assertEquals(WorldHudMode.GLOBE, failed.mode); assertEquals("the panel stays so Enter map can retry", GlobePanel.REALM, failed.panel)
    }

    @Test fun `a dive the player backed out of is a cancel, never a map that could not load`() {
        // The integration review: Back during a normal dive (the engine cancels it and answers DiveFailed, heard while
        // LEAVING) showed "This realm map could not load — tap Enter map to retry" for 8 s. Nothing failed: the player
        // asked to stay on the globe. A dive that failed while the player still waited for it keeps its notice.
        val diving = WorldHudFlow.enterMap(WorldHudFlow.selectRealm(WorldHudUi(), "sunscar").ui, "sunscar").ui
        val backed = WorldHudFlow.leave(diving)
        assertEquals(listOf(WorldIntent.Leave), backed.intents)
        val cancelled = WorldHudFlow.diveFailed(backed.ui, "sunscar").ui
        assertEquals(WorldHudMode.GLOBE, cancelled.mode); assertEquals("the realm's panel, so Enter map is one tap away", GlobePanel.REALM, cancelled.panel)
        assertNull("no error for the player's own Back", cancelled.noMap)
        assertEquals(WorldHudFlow.DIVE_FAILED, WorldHudFlow.diveFailed(diving, "sunscar").ui.noMap)
        assertEquals("the globe's hint pill says it", WorldHudFlow.DIVE_FAILED, WorldHudFlow.hint(WorldHudFlow.diveFailed(diving, "sunscar").ui, "fallback"))
        // a resume that fails ends on the new engine's clean globe, silently, as before
        val resuming = diving.copy(resume = RealmResume("sunscar", 40.0, 20.0, 96.0))
        assertNull(WorldHudFlow.diveFailed(resuming, "sunscar").ui.noMap)
    }

    @Test fun `back peels card search and level panel, then leaves the map, then drops the selection, then yields to the app`() {
        var u = WorldHudUi(mode = WorldHudMode.REALM, realmId = "frostveil", card = RealmCard(1, 1, 1), realmSearch = true, levelOpen = true)
        val trail = ArrayList<String>(); val sent = ArrayList<WorldIntent>()
        repeat(10) {
            val layers = WorldHudFlow.backLayers(u); if (layers.isEmpty()) return@repeat
            val top = layers.max()
            val s = WorldHudFlow.back(u, top); u = s.ui; sent += s.intents
            trail += when { top == BackPriority.REALM_CARD -> "card"; top == BackPriority.REALM_MAP -> "map"; top == BackPriority.GLOBE_LAYERS -> "selection"; else -> "$top" }
            if (u.mode == WorldHudMode.LEAVING) u = WorldHudFlow.left(u, "frostveil").ui
        }
        assertEquals(listOf("card", "card", "card", "map", "selection"), trail)
        assertEquals(WorldHudUi().panel, u.panel); assertTrue(WorldHudFlow.backLayers(u).isEmpty())
        assertEquals(listOf(WorldIntent.Select(null), WorldIntent.Leave, WorldIntent.Select(null)), sent)
        assertEquals("a leave in flight swallows Back", listOf(BackPriority.REALM_MAP), WorldHudFlow.backLayers(WorldHudUi(mode = WorldHudMode.LEAVING)))
        assertEquals(listOf(BackPriority.GLOBE_LIST, BackPriority.GLOBE_LAYERS), WorldHudFlow.backLayers(WorldHudUi(globeSearch = true, panel = GlobePanel.WARZONE)))
    }

    @Test fun `the HUD dive watchdog is back to 12 s and still outlasts the host's core stall bound`() {
        // D-NEXT (amends D-173): a dive waits for the core FAR set only (0.7-0.8 s on the Seeker; the owner must not wait
        // much more than a second for a realm map), so the HUD's backstop is the pre-D-173 12 s again, not D-173's 16 s
        // lane wait. It must stay above the host's own stall bound, so a stuck dive is answered by the engine (with its
        // reason in the log) and the HUD only catches an engine that stopped answering.
        val hud = java.io.File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/world/WorldHudScreen.kt").readText()
        val hudMs = Regex("""private const val DIVE_TIMEOUT_MS = ([0-9_]+)L""").find(hud)!!.groupValues[1].replace("_", "").toDouble()
        assertTrue("the watchdog ($hudMs ms) outlasts the host's bound (${gg.pixelkingdomwars.nativeclient.scene.world.WorldEngineHost.DIVE_STALL_MS} ms)",
            hudMs > gg.pixelkingdomwars.nativeclient.scene.world.WorldEngineHost.DIVE_STALL_MS)
        assertTrue("no D-173 lane wait: a dive that stops moving is given up within 12 s ($hudMs ms)", hudMs <= 12_000.0)
    }

    @Test fun `leaving returns to the globe on the realm the map showed, panel open`() {
        val u = WorldHudFlow.left(WorldHudUi(mode = WorldHudMode.LEAVING, realmId = "sunscar", card = RealmCard(1, 1, 1)), "sunscar")
        assertEquals(WorldHudMode.GLOBE, u.ui.mode); assertEquals(GlobePanel.REALM, u.ui.panel); assertNull(u.ui.card)
        assertEquals(listOf(WorldIntent.Select(WorldTarget.Realm("sunscar"))), u.intents)
    }

    @Test fun `MY PARCEL makes My base the realm panel's gold action, any other way in keeps Enter map gold`() {
        // main.js at the pin: the MY PARCEL tool calls selectRealm(r, { mine: true }) and realmPanel swaps the gold plate
        // to "My base". A second gold button, or none, would break "gold = THE primary action" (HUD-STYLE §5).
        val mine = WorldHudFlow.selectRealm(WorldHudUi(), "crownlands", mine = true).ui
        assertTrue(mine.mineCta)
        assertFalse("a rail or globe tap is a plain open", WorldHudFlow.globePick(mine, WorldTarget.Realm("crownlands")).ui.mineCta)
        assertFalse("closing forgets it", WorldHudFlow.deselect(mine).ui.mineCta)
        assertFalse("another panel forgets it", WorldHudFlow.openPanel(mine, GlobePanel.WARZONE).ui.mineCta)
        assertFalse("back from the map the panel is the plain realm panel (main.js leaveRealm selects with hold)",
            WorldHudFlow.left(mine.copy(mode = WorldHudMode.LEAVING), "crownlands").ui.mineCta)
    }

    @Test fun `a fresh open animates its content, the panel revealed back from a map does not`() {
        // index.html: #panel.open runs pIn and main.js countUp on a fresh open; #panel.ready (after leaveRealm) slides in
        // solid with its content in place, so returning from a map never replays the entrance or recounts the stats.
        val first = WorldHudFlow.selectRealm(WorldHudUi(), "sunscar").ui
        assertTrue(first.panelFresh)
        val again = WorldHudFlow.selectRealm(first, "sunscar").ui
        assertTrue("each fresh open restarts the entrance", again.panelSerial > first.panelSerial)
        val back = WorldHudFlow.left(WorldHudFlow.leave(WorldHudFlow.dived(WorldHudFlow.enterMap(again, "sunscar").ui, "sunscar", null).ui).ui, "sunscar").ui
        assertEquals(GlobePanel.REALM, back.panel); assertFalse(back.panelFresh)
        assertFalse("a failed dive puts the same panel back", WorldHudFlow.diveFailed(WorldHudFlow.enterMap(again, "sunscar").ui, "sunscar").ui.panelFresh)
        assertTrue("a new selection after that is fresh again", WorldHudFlow.selectRealm(back, "frostveil").ui.panelFresh)
    }

    @Test fun `chips become the engine filter and the bases snapshot carries the contract flags`() {
        assertEquals(WorldFilter(WorldFilterKind.ALL), WorldHudFlow.engineFilter(RealmFilter()))
        assertEquals(WorldFilter(WorldFilterKind.LEVEL, 3..9), WorldHudFlow.engineFilter(RealmFilter(lo = 3, hi = 9)))
        assertEquals(WorldFilter(WorldFilterKind.MINE, 1..5), WorldHudFlow.engineFilter(RealmFilter("mine", 1, 5)))
        assertEquals("D-191: the Unshielded chip is the engine's UNSHIELDED", WorldFilter(WorldFilterKind.UNSHIELDED), WorldHudFlow.engineFilter(RealmFilter("unshielded")))
        val bases = listOf(RealmHudBase(10, 1, 2, "a", 4, mine = true), RealmHudBase(11, 3, 4, "b", 15, mine = false, shield = true))
        val snap = WorldHudFlow.basesSnapshot(7, "crownlands", bases, RealmFilter(lo = 10), RealmCard(11, 3, 4), null)
        assertEquals(7L, snap.epoch); assertArrayEquals(intArrayOf(1, 3), snap.deedX); assertArrayEquals(intArrayOf(4, 15), snap.level)
        assertEquals(HudFlag.OCCUPIED or HudFlag.MINE, snap.flags[0])
        assertEquals(HudFlag.OCCUPIED or HudFlag.SHIELD or HudFlag.FILTERED_IN or HudFlag.SELECTED, snap.flags[1])
        // D-191: the FLAG word cannot say "no shield bit at all", so the snapshot says which reads carried one; the
        // engine's UNSHIELDED passes only a known, clear bit (a: unknown; b: known, shielded).
        assertArrayEquals(booleanArrayOf(false, true), snap.shieldKnown)
        assertArrayEquals(booleanArrayOf(true), WorldHudFlow.basesSnapshot(8, "crownlands", listOf(bases[0].copy(shield = false)), RealmFilter(), null, null).shieldKnown)
    }

    // ---- SHARDKEEP D-191 follow-up: the filter a realm map applies is one its chips can show ----
    // The Unshielded chip waits for a parcels read that carries the shield bit (D-181), and a stopped app's next visit
    // starts without that knowledge (WorldViewModel.foreground). Before this, a player on Unshielded who locked the phone
    // came back to an engine still on UNSHIELDED (it came with the resume) under a toolbar with no chip pressed: every
    // kingdom without a clear bit hidden (before any read, all of them, their own shielded one too), and so on while
    // reads failed, with no pressed chip to release. Now the kind applies as All until its chip is back.
    private val bare = HudChips.realm(shieldFed = false)
    private val fed = HudChips.realm(shieldFed = true)
    private fun onSunscar(): WorldHudUi = WorldHudFlow.dived(WorldHudFlow.enterMap(WorldHudUi(), "sunscar").ui, "sunscar", myBase = null).ui

    @Test fun `D-191 - a kind whose chip is not shown applies as All, and the player's choice waits for the chip`() {
        val raid = RealmFilter("unshielded", 7, 20)
        assertEquals("fed: Unshielded applies as chosen", raid, WorldHudFlow.shownFilter(raid, fed))
        assertEquals("no chip: All over the same level range, never an Unshielded no one can see", RealmFilter("all", 7, 20), WorldHudFlow.shownFilter(raid, bare))
        assertEquals("so the engine gets the level range alone", WorldFilter(WorldFilterKind.LEVEL, 7..20), WorldHudFlow.engineFilter(WorldHudFlow.shownFilter(raid, bare)))
        assertEquals("the toolbar presses All, not nothing", "all", bare.single { it.filter && it.id == WorldHudFlow.shownFilter(raid, bare).kind }.id)
        assertEquals("Mine always has its chip", RealmFilter("mine", 3, 9), WorldHudFlow.shownFilter(RealmFilter("mine", 3, 9), bare))
        assertEquals(RealmFilter(), WorldHudFlow.shownFilter(RealmFilter(), bare))

        val chosen = WorldHudFlow.setFilter(onSunscar(), RealmFilter("unshielded"), fed)
        assertEquals(listOf<WorldIntent>(WorldIntent.SetFilter(WorldFilter(WorldFilterKind.UNSHIELDED))), chosen.intents)
        // a level move while the chip is gone: the choice is kept, and the engine never gets the hidden kind
        val moved = WorldHudFlow.setFilter(chosen.ui, chosen.ui.filter.withLevel(0, 7), bare)
        assertEquals(RealmFilter("unshielded", 7, 20), moved.ui.filter)
        assertEquals(listOf<WorldIntent>(WorldIntent.SetFilter(WorldFilter(WorldFilterKind.LEVEL, 7..20))), moved.intents)
        assertEquals("the default (every chip) is the filter as it is", chosen, WorldHudFlow.setFilter(onSunscar(), RealmFilter("unshielded")))
    }

    @Test fun `D-191 - the engine follows the chips on the map, and a resume lands with the filter the toolbar shows`() {
        val raiding = WorldHudFlow.setFilter(onSunscar(), RealmFilter("unshielded"), fed).ui
        assertEquals("the chip goes (a new visit, no read yet): the engine applies All",
            listOf<WorldIntent>(WorldIntent.SetFilter(WorldFilter(WorldFilterKind.ALL))), WorldHudFlow.chipsShown(raiding, bare).intents)
        assertEquals("and Unshielded again once a read carries the bit",
            listOf<WorldIntent>(WorldIntent.SetFilter(WorldFilter(WorldFilterKind.UNSHIELDED))), WorldHudFlow.chipsShown(raiding, fed).intents)
        assertEquals("the player's filter itself never changes", raiding, WorldHudFlow.chipsShown(raiding, bare).ui)
        assertTrue("off the map there is no filter to apply", WorldHudFlow.chipsShown(WorldHudFlow.leave(raiding).ui, bare).intents.isEmpty())
        assertTrue(WorldHudFlow.chipsShown(WorldHudUi(), fed).intents.isEmpty())

        // the lock screen: the new engine mounts before the new visit's first read, so the resume carries All ...
        val camera = RealmResume("sunscar", 42.5, 17.25, 96.0)
        val resuming = WorldHudFlow.engineMounted(raiding, camera, bare)
        assertEquals(WorldFilter(WorldFilterKind.ALL), resuming.resume?.filter)
        assertEquals("still the player's Unshielded", RealmFilter("unshielded"), resuming.filter)
        assertEquals(WorldFilter(WorldFilterKind.UNSHIELDED), WorldHudFlow.engineMounted(raiding, camera, fed).resume?.filter)
        // ... and its landing, like every landing, gives the engine the chips' filter as they are by then
        val landed = WorldHudFlow.dived(resuming, "sunscar", myBase = null).ui
        assertEquals(WorldHudMode.REALM, landed.mode)
        assertEquals(listOf<WorldIntent>(WorldIntent.SetFilter(WorldFilter(WorldFilterKind.UNSHIELDED))), WorldHudFlow.chipsShown(landed, fed).intents)

        // the screen: one shown filter for the list, the engine's bases, the toolbar and every chip or level change
        val hud = java.io.File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/world/WorldHudScreen.kt").readText()
        assertTrue("val shownFilter = WorldHudFlow.shownFilter(ui.filter, chips)" in hud)
        assertTrue("val filtered = remember(realmBases, shownFilter) { realmBases.filter { shownFilter.passes(it, null) } }" in hud)
        assertTrue("WorldHudFlow.basesSnapshot(++basesEpoch[0], realm, realmBases, shownFilter, ui.card, null)" in hud)
        assertTrue("LaunchedEffect(bridge, ui.mode == WorldHudMode.REALM, chips) { applyNow(WorldHudFlow.chipsShown(uiNow, chips)) }" in hud)
        assertTrue("WorldHudFlow.engineMounted(uiNow, lastRealm[0], chipsNow)" in hud)
        assertTrue("RealmMapHud(plan, ui.copy(filter = shown), " in hud)
        assertTrue("WorldHudFlow.setFilter(ui, ui.filter.copy(kind = kind), chips)" in hud)
        assertTrue("WorldHudFlow.setFilter(ui, ui.filter.withLevel(index, value), chips)" in hud)
        assertFalse("no filter reaches the engine or the list unshown", Regex("""ui\.filter\.passes|basesSnapshot\([^)]*ui\.filter|engineFilter\(ui\.filter\)""").containsMatchIn(hud))
    }

    @Test fun `the minimap toggle folds, and in portrait with a card up it pins for that card`() {
        val u = WorldHudUi()
        assertFalse(WorldHudFlow.toggleMinimap(u, shown = true, portraitCardUp = false).miniOpen)
        assertTrue(WorldHudFlow.toggleMinimap(u.copy(miniOpen = false), shown = false, portraitCardUp = false).miniOpen)
        assertTrue(WorldHudFlow.toggleMinimap(u, shown = false, portraitCardUp = true).miniPin)
        assertFalse(WorldHudFlow.toggleMinimap(u.copy(miniPin = true), shown = true, portraitCardUp = true).miniPin)
        // Closing the card drops the pin (ui.js card(null)).
        assertFalse(WorldHudFlow.selectDeed(u.copy(realmId = "x", miniPin = true, card = RealmCard(1, 1, 1)), null, fly = false).ui.miniPin)
    }

    // ---- N4 flows (GLOBE-NATIVE-PLAN §1.1 N4; GLOBE-PRODUCTION-PLAN §1.2 F-rows, §1.3) ----

    @Test fun `choose land starts on the globe with its banner, lands on a suggested open deed and walks on with Next`() {
        // F5 / §1.3: the #1 money flow. The banner must survive the first touch (a player who pans must still know why
        // they are here), the map must open with a card already up, and Next must never offer the same deed twice.
        val start = WorldHudFlow.entry(WorldHudUi(panel = GlobePanel.WARZONE), WorldEntry.ChooseLand, 0, 0, null, null, false)
        assertEquals(WorldHudIntent.CHOOSE_LAND, start.ui.intent); assertEquals(GlobePanel.NONE, start.ui.panel)
        assertEquals(listOf(WorldIntent.Select(null)), start.intents)
        val touched = start.ui.copy(hint = false)
        assertTrue("the banner stays after the first touch", WorldHudFlow.hintShown(touched))
        assertEquals("Choose a realm for your land", WorldHudFlow.hint(touched, "fallback"))
        val diving = WorldHudFlow.enterMap(WorldHudFlow.selectRealm(touched, "frostveil").ui, "frostveil")
        assertEquals(listOf(WorldIntent.Dive("frostveil")), diving.intents)
        val suggested = RealmCard(740, 20, 1)
        val landed = WorldHudFlow.dived(diving.ui, "frostveil", myBase = null, openDeed = suggested)
        assertEquals("the card is up at once", suggested, landed.ui.card); assertEquals(listOf(740), landed.ui.offered)
        val deed = WorldTarget.Deed("frostveil", 20, 1)
        assertEquals(listOf(WorldIntent.Select(deed), WorldIntent.FlyTo(deed, HudBands.SELECT_D)), landed.intents)
        val next = WorldHudFlow.nextOpenDeed(landed.ui, RealmCard(741, 21, 1))
        assertEquals(RealmCard(741, 21, 1), next.ui.card); assertEquals(listOf(740, 741), next.ui.offered)
        assertEquals("nothing in reach changes nothing", next.ui, WorldHudFlow.nextOpenDeed(next.ui, null).ui)
        assertNull("outside choose mode a dive never invents a selection",
            WorldHudFlow.dived(WorldHudFlow.enterMap(WorldHudUi(), "frostveil").ui, "frostveil", null, openDeed = suggested).ui.card)
        assertEquals("a drafted or searched tile beats the suggestion", RealmCard(9, 9, 0),
            WorldHudFlow.dived(WorldHudFlow.enterMap(touched, "frostveil", tile = RealmCard(9, 9, 0)).ui, "frostveil", null, openDeed = suggested).ui.card)
        assertEquals("back on the globe choose mode continues", WorldHudIntent.CHOOSE_LAND,
            WorldHudFlow.left(WorldHudFlow.leave(landed.ui).ui, "frostveil").ui.intent)
    }

    @Test fun `MY PARCEL flies to TRUE where the realm has detail and falls back to MAP with the deed selected`() {
        // F7: asking for TRUE on a realm without a ready detailed pack would hold the zoom at a band gate that never opens.
        val mine = RealmCard(5000, 200, 6); val target = WorldTarget.Deed("crownlands", 200, 6)
        val diving = WorldHudFlow.enterMap(WorldHudUi(), "crownlands", mine = true).ui
        assertEquals(WorldIntent.FlyTo(target, HudBands.MY_BASE_D), WorldHudFlow.dived(diving, "crownlands", mine).intents.last())
        val map = WorldHudFlow.dived(diving, "crownlands", mine, myBaseD = HudBands.SELECT_D)
        assertEquals(mine, map.ui.card); assertEquals(WorldIntent.FlyTo(target, HudBands.SELECT_D), map.intents.last())
        val mapped = WorldHudFlow.myParcel(WorldHudUi(), "crownlands", mapped = true).ui
        assertEquals(GlobePanel.REALM, mapped.panel); assertTrue("My base is the gold CTA", mapped.mineCta)
        val unmapped = WorldHudFlow.myParcel(WorldHudUi(), "thornwake", mapped = false)
        assertEquals("a realm without a map shows the deed's parcel panel", GlobePanel.PARCEL, unmapped.ui.panel)
        assertEquals(listOf(WorldIntent.Select(WorldTarget.Realm("thornwake")), WorldIntent.FlyTo(WorldTarget.Realm("thornwake"))), unmapped.intents)
    }

    @Test fun `view deeds opens one deed like MY PARCEL, marks several realms, and explains having none`() {
        // F14: "View deeds" used to open WORLD and nothing else.
        val card = RealmCard(5000, 200, 6)
        assertEquals(GlobePanel.PARCEL_HELP, WorldHudFlow.entry(WorldHudUi(), WorldEntry.MyDeeds, 0, 0, null, null, false).ui.panel)
        val one = WorldHudFlow.entry(WorldHudUi(), WorldEntry.MyDeeds, 1, 1, card, "crownlands", mapped = true).ui
        assertEquals(GlobePanel.REALM, one.panel); assertEquals("crownlands", one.realmId); assertTrue(one.mineCta)
        assertEquals("two deeds in one realm are still that realm", GlobePanel.REALM, WorldHudFlow.entry(WorldHudUi(), WorldEntry.MyDeeds, 2, 1, card, "crownlands", true).ui.panel)
        val many = WorldHudFlow.entry(WorldHudUi(), WorldEntry.MyDeeds, 3, 2, card, "crownlands", true).ui
        assertEquals(WorldHudIntent.MY_DEEDS, many.intent); assertEquals(GlobePanel.NONE, many.panel)
        assertEquals("Your realms are marked · tap one for your bases", WorldHudFlow.hint(many, "fallback"))
    }

    @Test fun `the Seeker Island entry opens the island panel with the engine selection, like the rail chip`() {
        // Owner 2026-10-06: Profile › WALLET's SEEKER ISLAND and the faucet sheet's Seeker door used to say "not open yet"
        // while the bidding demo ran on the globe's island panel. The entry is the chip's own step, nothing invented.
        val step = WorldHudFlow.entry(WorldHudUi(intent = WorldHudIntent.RIVALS, hint = true), WorldEntry.SeekerIsland, 0, 0, null, null, false)
        assertEquals(GlobePanel.ISLAND, step.ui.panel); assertEquals(PhaseEIslands.SEEKER_ISLAND_ID, step.ui.islandId)
        assertEquals("the entry drops any pending intent", WorldHudIntent.NONE, step.ui.intent); assertFalse(step.ui.hint)
        assertEquals(listOf<WorldIntent>(WorldIntent.Select(WorldTarget.Island(PhaseEIslands.SEEKER_ISLAND_ID))), step.intents)
        assertEquals(step, PhaseEIslands.select(WorldHudUi(), PhaseEIslands.SEEKER_ISLAND_ID).let { it.copy(ui = it.ui.copy(panelSerial = step.ui.panelSerial)) })
        // On a realm map the chip is not there; the entry changes nothing either.
        val onMap = WorldHudUi(mode = WorldHudMode.REALM, realmId = "crownlands")
        assertEquals(onMap.copy(intent = WorldHudIntent.NONE), WorldHudFlow.entry(onMap, WorldEntry.SeekerIsland, 0, 0, null, null, false).ui)
    }

    @Test fun `the Solana Island entry opens the Public Workshop island panel, like the rail chip`() {
        // Owner 2026-10-06: the craft-vehicle GO ("Public Workshop, Solana Island") left the player on the base screen. Why
        // this rule: the entry is the chip's own step onto Solana Island's sheet (the Public Workshop, whose CRAFT VEHICLE
        // opens the craft page), with the engine framing that island; no spot list is invented, none exists for Solana.
        val step = WorldHudFlow.entry(WorldHudUi(intent = WorldHudIntent.CHOOSE_LAND, hint = true), WorldEntry.SolanaIsland, 0, 0, null, null, false)
        assertEquals(GlobePanel.ISLAND, step.ui.panel); assertEquals(PhaseEIslands.SOLANA_ISLAND_ID, step.ui.islandId)
        assertEquals("the island the panel draws is Solana Island's", "Solana Island", PhaseEIslands.byId(step.ui.islandId)?.title)
        assertEquals("the entry drops any pending intent", WorldHudIntent.NONE, step.ui.intent); assertFalse(step.ui.hint)
        assertEquals(listOf<WorldIntent>(WorldIntent.Select(WorldTarget.Island(PhaseEIslands.SOLANA_ISLAND_ID))), step.intents)
        assertEquals(step, PhaseEIslands.select(WorldHudUi(), PhaseEIslands.SOLANA_ISLAND_ID).let { it.copy(ui = it.ui.copy(panelSerial = step.ui.panelSerial)) })
        assertEquals("the designed Public Workshop sheet is what the globe draws for it", WorldGlobeSheet.ISLAND, worldGlobeSheet(step.ui, parcelRead = false))
        // A different island's entry never lands here (each door names its own island).
        assertNotEquals(step.ui.islandId, WorldHudFlow.entry(WorldHudUi(), WorldEntry.SeekerIsland, 0, 0, null, null, false).ui.islandId)
        // On a realm map the chip is not there; the entry changes nothing either, exactly as the Seeker entry.
        val onMap = WorldHudUi(mode = WorldHudMode.REALM, realmId = "crownlands")
        assertEquals(onMap.copy(intent = WorldHudIntent.NONE), WorldHudFlow.entry(onMap, WorldEntry.SolanaIsland, 0, 0, null, null, false).ui)
        // The request rides the World tab, so the scaffold switches there before the World screen consumes it.
        assertEquals(HomeTab.WORLD, HomeRequest.World(WorldEntry.SolanaIsland).homeTab)
    }

    @Test fun `rivals start on the globe with their instruction and keep the server-gated card`() {
        // F13: the raid chooser's WORLD and a battle's WORLD MAP. No client reach or attackability is computed (D-169).
        val u = WorldHudFlow.entry(WorldHudUi(), WorldEntry.Rivals, 0, 0, null, null, false).ui
        assertEquals(WorldHudIntent.RIVALS, u.intent); assertEquals("Choose a realm to find a rival", WorldHudFlow.hint(u, "fallback"))
        assertEquals("a no-map notice outranks the instruction", "No map for Thornwake yet", WorldHudFlow.hint(u.copy(noMap = "No map for Thornwake yet"), "fallback"))
        assertEquals("without an intent the plain hint", "fallback", WorldHudFlow.hint(WorldHudUi(), "fallback"))
        assertFalse(WorldHudFlow.hintShown(WorldHudUi(hint = false)))
    }

    @Test fun `a drafted tile reopens straight into its realm map with the deed selected`() {
        // F6: coming back to the World tab mid-purchase lands on the drafted deed, not on the home frame.
        val drafted = RealmCard(12345, 105, 17)
        val step = WorldHudFlow.reopenDraft(WorldHudUi(), "sunscar", drafted, mapped = true)
        assertEquals(listOf(WorldIntent.Dive("sunscar")), step.intents); assertEquals(WorldHudIntent.CHOOSE_LAND, step.ui.intent)
        val landed = WorldHudFlow.dived(step.ui, "sunscar", null, openDeed = RealmCard(1, 1, 1))
        assertEquals("the drafted deed, not a new suggestion", drafted, landed.ui.card)
        val noMap = WorldHudFlow.reopenDraft(WorldHudUi(), "thornwake", drafted, mapped = false).ui
        assertEquals(GlobePanel.PARCEL, noMap.panel); assertEquals(WorldHudMode.GLOBE, noMap.mode)
    }

    @Test fun `a search result in another realm leaves this map and dives on with it selected`() {
        // F9 "Go to ‹realm›": one continuous flight, never a stop on the globe that needs another tap.
        val onMap = WorldHudUi(mode = WorldHudMode.REALM, realmId = "crownlands", card = RealmCard(1, 1, 1), realmSearch = true)
        val target = RealmCard(80_000, 80, 111)
        val leaving = WorldHudFlow.jump(onMap, "sunscar", target)
        assertEquals(WorldHudMode.LEAVING, leaving.ui.mode); assertEquals(listOf(WorldIntent.Leave), leaving.intents)
        val on = WorldHudFlow.left(leaving.ui, "crownlands")
        assertEquals(WorldHudMode.DIVING, on.ui.mode); assertEquals("sunscar", on.ui.realmId); assertEquals(listOf(WorldIntent.Dive("sunscar")), on.intents)
        assertNull(on.ui.pendingJump)
        assertEquals(target, WorldHudFlow.dived(on.ui, "sunscar", null).ui.card)
        val same = WorldHudFlow.jump(onMap, "crownlands", target)
        assertEquals("the same realm just selects and flies", WorldHudMode.REALM, same.ui.mode); assertEquals(target, same.ui.card)
    }

    @Test fun `a World entry opens the World tab and is consumed there before any later Home request surfaces`() {
        // LandGate, the raid chooser, a battle and the inventory queue their entry on the Home requests; the queue shows only
        // its head, so an entry the World screen failed to consume would block every later request (the build tray, ...).
        val requests = HomeRequests()
        requests.request(HomeRequest.World(WorldEntry.ChooseLand)); requests.request(HomeRequest.BuildMenu)
        assertEquals(HomeTab.WORLD, requests.pending.value!!.homeTab)
        requests.consume(HomeRequest.World(WorldEntry.ChooseLand))
        assertEquals(HomeRequest.BuildMenu, requests.pending.value)
        requests.consume(HomeRequest.BuildMenu)
        requests.request(HomeRequest.World(WorldEntry.Rivals)); requests.request(HomeRequest.World(WorldEntry.Rivals))
        requests.consume(HomeRequest.World(WorldEntry.Rivals))
        assertNull("a double tap queues one entry", requests.pending.value)
    }

    @Test fun `the realm warzone panel closes on Back before the card, and closes the level panel when it opens`() {
        // F16 + the back chain (BackRegistry REALM_CARD layer): ui.js escape order, with the native panel after the level panel.
        val u = WorldHudFlow.toggleWarzone(WorldHudUi(mode = WorldHudMode.REALM, realmId = "sunscar", card = RealmCard(1, 1, 1), levelOpen = true))
        assertTrue(u.warzoneOpen); assertFalse(u.levelOpen)
        assertEquals(BackPriority.REALM_CARD, WorldHudFlow.backLayers(u).max())
        val first = WorldHudFlow.back(u, BackPriority.REALM_CARD).ui
        assertFalse(first.warzoneOpen); assertEquals("the card is still up", RealmCard(1, 1, 1), first.card)
        assertNull(WorldHudFlow.back(first, BackPriority.REALM_CARD).ui.card)
        assertEquals("the panel alone keeps the card layer", listOf(BackPriority.REALM_CARD, BackPriority.REALM_MAP),
            WorldHudFlow.backLayers(WorldHudUi(mode = WorldHudMode.REALM, realmId = "x", warzoneOpen = true)))
        assertFalse("a dive lands with it closed", WorldHudFlow.dived(u.copy(mode = WorldHudMode.DIVING), "sunscar", null).ui.warzoneOpen)
    }

    @Test fun `the realm read is the globe's bounded parcel viewport - quantised, split at the dateline, nearest first`() {
        val scope = WorldRealmFeed.scope(WorldRealmFeed.Window(100.2, 50.5, 140.8, 90.1), 720, 360, 8, 4096, 256, 4)
        assertFalse(scope.truncated)
        assertTrue(scope.rects.all { (it.x1 - it.x0 + 1) * (it.y1 - it.y0 + 1) <= 4096 && it.x0 % 8 == 0 && it.y0 % 8 == 0 })
        assertEquals("the window grows 2–3 deeds and snaps to the server's 8-deed quantum", listOf(FantasyRect(96, 48, 143, 95)), scope.rects)
        // Cinderfall: a window across the dateline is read on both sides, never as one impossible rect.
        val wrap = WorldRealmFeed.scope(WorldRealmFeed.Window(-12.0, 300.0, 9.0, 330.0), 720, 360, 8, 4096, 256, 4)
        assertEquals(setOf(FantasyRect(0, 296, 15, 335), FantasyRect(704, 296, 719, 335)), wrap.rects.toSet())
        // A FAR view of a whole realm needs more than four reads: the four nearest the centre, disclosed as truncated.
        val far = WorldRealmFeed.scope(WorldRealmFeed.Window(0.0, 0.0, 300.0, 200.0), 720, 360, 8, 4096, 256, 4)
        assertTrue(far.truncated); assertEquals(4, far.rects.size)
        assertEquals("nearest the centre first", FantasyRect(128, 64, 191, 127), far.rects.first())
    }
}
