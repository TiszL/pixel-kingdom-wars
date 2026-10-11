package gg.pixelkingdomwars.nativeclient

import gg.pixelkingdomwars.nativeclient.data.BaseState
import gg.pixelkingdomwars.nativeclient.model.BaseSnapshot
import gg.pixelkingdomwars.nativeclient.model.Building
import gg.pixelkingdomwars.nativeclient.model.DailyCache
import gg.pixelkingdomwars.nativeclient.model.MineStatus
import gg.pixelkingdomwars.nativeclient.model.PlayerSummary
import gg.pixelkingdomwars.nativeclient.model.Quest
import gg.pixelkingdomwars.nativeclient.model.QuestBoard
import gg.pixelkingdomwars.nativeclient.ui.features.Destination
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureRegistry
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureSelection
import gg.pixelkingdomwars.nativeclient.ui.features.GateContext
import gg.pixelkingdomwars.nativeclient.ui.home.HomeRequest
import gg.pixelkingdomwars.nativeclient.ui.home.HomeRequests
import gg.pixelkingdomwars.nativeclient.ui.home.HomeRouteContext
import gg.pixelkingdomwars.nativeclient.ui.home.HomeRouteDispatchResult
import gg.pixelkingdomwars.nativeclient.ui.home.HomeRouteDispatcher
import gg.pixelkingdomwars.nativeclient.ui.home.HomeRouteIdentity
import gg.pixelkingdomwars.nativeclient.ui.home.HomeSheetRouteHost
import gg.pixelkingdomwars.nativeclient.ui.home.HomeTab
import gg.pixelkingdomwars.nativeclient.ui.home.mountedHomeSheetFrame
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.model.SheetSize
import gg.pixelkingdomwars.nativeclient.ui.profile.ProfileHubScope
import gg.pixelkingdomwars.nativeclient.ui.profile.profileHubBody
import gg.pixelkingdomwars.nativeclient.ui.sheets.SheetEntry
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.LoadState
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.*
import org.junit.Test

/** Tests-first MS-UI1 contract. Authored only; Cedar3 owns all execution and result claims. */
class ProfileHubMountTest {
    private data class SessionLabel(val wallet: String)

    @Test fun `scope requires the exact session owner even when wallet values are equal`() {
        val session = SessionLabel("same-wallet")
        val replacement = SessionLabel("same-wallet")
        val scope = ProfileHubScope(session, "base-a", 4)

        assertEquals(session, replacement)
        assertTrue(scope.isCurrent(session, "base-a", 4))
        assertFalse(scope.isCurrent(replacement, "base-a", 4))
        assertFalse(scope.isCurrent(null, "base-a", 4))
    }

    @Test fun `base selection away and back cannot revive the old scope`() {
        val session = Any()
        val scope = ProfileHubScope(session, "base-a", 4)

        assertFalse(scope.isCurrent(session, "base-b", 5))
        assertFalse(scope.isCurrent(session, "base-a", 6))
        assertFalse(scope.isCurrent(session, "base-a", 5))
        assertFalse(scope.isCurrent(session, null, 4))
        val unselected = ProfileHubScope(session, null, 4)
        assertTrue(unselected.isCurrent(session, null, 4))
        assertFalse(unselected.isCurrent(session, "base-a", 4))
    }

    @Test fun `blocked or stale callbacks have no effect and a current permitted callback runs once`() {
        val session = Any()
        val scope = ProfileHubScope(session, "base-a", 4)
        var calls = 0
        val action = { calls++; Unit }

        assertFalse(scope.act(session, "base-a", 4, false, action))
        assertFalse(scope.act(Any(), "base-a", 4, true, action))
        assertFalse(scope.act(null, "base-a", 4, true, action))
        assertFalse(scope.act(session, "base-b", 5, true, action))
        assertFalse(scope.act(session, "base-a", 6, true, action))
        assertFalse(scope.act(session, null, 4, true, action))
        assertEquals(0, calls)
        assertTrue(scope.act(session, "base-a", 4, true, action))
        assertEquals(1, calls)
    }

    @Test fun `unread home preserves loading or error without inventing stats or claim cards`() {
        for (load in listOf(LoadState.Loading, LoadState.Ready, LoadState.Stale("14:02"), LoadState.Error("Refresh failed"))) {
            val ui = profileHubBody(null, load)

            assertEquals(UNKNOWN, ui.league.trophies)
            assertNull(ui.exp)
            assertNull(ui.renown)
            assertTrue(ui.rightNow.isEmpty())
            assertSame(load, ui.load)
        }
    }

    @Test fun `known trophies come from home while unsupported progress stays absent`() {
        val load = LoadState.Error("Refresh failed", asOf = "14:02")
        val ui = profileHubBody(BaseState(base = base(trophies = "42")), load)

        assertEquals("42", ui.league.trophies)
        assertNull(ui.exp)
        assertNull(ui.renown)
        assertSame(load, ui.load)
        assertEquals(UNKNOWN, profileHubBody(BaseState(base = base()), LoadState.Ready).league.trophies)
    }

    @Test fun `right now prioritizes a ready cache then explicit idle builders then daily quest rewards`() {
        val home = BaseState(
            base = base(freeBuilders = 2, explicitBuilders = true),
            mine = MineStatus(cache = DailyCache(claimable = true, cacheShards = "25")),
            quests = QuestBoard(quests = (1..5).map { Quest(id = "daily-$it", scope = "daily", completed = true) }),
        )
        val cards = profileHubBody(home, LoadState.Ready).rightNow

        assertEquals(listOf("hud.dailyCache", "hud.builders", "hud.quests"), cards.map { it.destination.feature.value })
        assertEquals(3, cards.size)
        assertTrue(cards.first().ready)
    }

    @Test fun `idle builder card requires an explicitly supplied positive count`() {
        fun builderCards(free: Int, explicit: Boolean) = profileHubBody(
            BaseState(base = base(freeBuilders = free, explicitBuilders = explicit)), LoadState.Ready,
        ).rightNow.filter { it.destination.feature.value == "hud.builders" }

        assertTrue(builderCards(2, false).isEmpty())
        assertTrue(builderCards(0, true).isEmpty())
        assertTrue(builderCards(-1, true).isEmpty())
        assertEquals(1, builderCards(2, true).size)
    }

    @Test fun `a surface without daily cache support suppresses only the cache card`() {
        val home = BaseState(
            base = base(freeBuilders = 2, explicitBuilders = true),
            mine = MineStatus(cache = DailyCache(claimable = true, cacheShards = "25")),
            quests = QuestBoard(quests = listOf(Quest(id = "ready", scope = "daily", completed = true))),
        )
        val load = LoadState.Ready
        val ui = profileHubBody(home, load, allowDailyCache = false)

        assertEquals(listOf("hud.builders", "hud.quests"), ui.rightNow.map { it.destination.feature.value })
        assertSame(load, ui.load)
        assertEquals(listOf("hud.dailyCache", "hud.builders", "hud.quests"),
            profileHubBody(home, load).rightNow.map { it.destination.feature.value })
    }

    @Test fun `settled cache and claimed unfinished or nondaily quests do not advertise rewards`() {
        val home = BaseState(
            base = base(),
            mine = MineStatus(cache = DailyCache(claimable = false)),
            quests = QuestBoard(quests = listOf(
                Quest(id = "claimed", scope = "daily", completed = true, claimed = true),
                Quest(id = "unfinished", scope = "daily", completed = false),
                Quest(id = "weekly", scope = "weekly", completed = true),
                Quest(id = "unknown-scope", completed = true),
            )),
        )

        assertTrue(profileHubBody(home, LoadState.Ready).rightNow.isEmpty())
        val ready = home.copy(quests = QuestBoard(quests = listOf(Quest(id = "ready", scope = "daily", completed = true))))
        assertEquals(listOf("hud.quests"), profileHubBody(ready, LoadState.Ready).rightNow.map { it.destination.feature.value })
    }

    @Test fun `unread home locks Clan and History and does not advertise Invite`() {
        val ui = profileHubBody(null, LoadState.Loading)

        assertNotNull(ui.clanDoor.lockedReason)
        assertNull(ui.clanDoor.link)
        val history = requireNotNull(ui.historyDoor)
        assertNotNull(history.lockedReason)
        assertNull(history.link)
        assertNull(ui.inviteDoor)
    }

    @Test fun `missing unfinished or zero level Clan Hall keeps the Clan door locked`() {
        val hall = Building("clan-hall", "clanhall", 1, 4, 6)
        for (buildings in listOf(
            emptyList(),
            listOf(hall.copy(underConstruction = true)),
            listOf(hall.copy(level = 0)),
            listOf(hall.copy(type = "keep")),
        )) {
            val door = profileHubBody(BaseState(base = base(buildings = buildings)), LoadState.Ready).clanDoor
            assertNotNull(door.lockedReason)
            assertNull(door.link)
        }
    }

    @Test fun `a completed Clan Hall in the actual base snapshot unlocks the Clan door`() {
        val hall = Building("clan-hall", "clanhall", 1, 4, 6, underConstruction = false)
        val door = profileHubBody(BaseState(base = base(buildings = listOf(hall))), LoadState.Ready).clanDoor

        assertNull(door.lockedReason)
        assertEquals("clan.open", requireNotNull(door.link).feature.value)
    }

    @Test fun `Menu falls back to standalone Profile without identity or admission and mounts once admitted`() {
        val identity = HomeRouteIdentity(Any(), "base-a", 4)
        var current: HomeRouteIdentity? = identity
        var blocked = false
        var standalone = 0
        val reasons = mutableListOf<String>()
        val opened = mutableListOf<Destination>()
        val host = HomeSheetRouteHost({ current }, { blocked }, { reasons += it })
        val mount = host.attach(identity, {}, { false }, openBody = { opened += it })
        mount.reportBlocked(false)
        val requests = HomeRequests()
        val dispatcher = HomeRouteDispatcher(requests, FeatureRegistry.canonical(),
            { current?.let { HomeRouteContext(it, GateContext(baseId = it.baseId)) } }, host)
        val feature = FeatureId("hud.profile")
        // review bc22f635: Menu must keep Settings, sign-out and base selection reachable
        // in every state the old Menu opened in. False preserves HomeScaffold's ProfileRoute fallback.
        fun tapMenu() { if (!dispatcher.handleFeatureDoor(feature)) standalone++ }

        assertTrue(host.canOpen(feature, HomeTab.KINGDOM))
        assertFalse(host.canOpen(feature, HomeTab.WORLD))
        current = null
        assertFalse(host.canOpen(feature, HomeTab.KINGDOM))
        tapMenu()
        assertEquals(1, standalone)
        assertNull(requests.pending.value)
        val stale = HomeRequest.Open(feature, identity, FeatureSelection())
        requests.request(stale)
        assertEquals(HomeRouteDispatchResult.STALE, dispatcher.consume(stale))
        assertNull(requests.pending.value)
        assertTrue(reasons.isEmpty())

        current = identity
        blocked = true
        mount.reportBlocked(true)
        assertFalse(host.canOpen(feature, HomeTab.KINGDOM))
        tapMenu()
        assertEquals(2, standalone)
        assertNull(requests.pending.value)
        assertTrue(opened.isEmpty())
        assertTrue(reasons.isEmpty())

        blocked = false
        mount.reportBlocked(false)
        assertTrue(host.canOpen(feature, HomeTab.KINGDOM))
        tapMenu()
        val pending = requests.pending.value as HomeRequest.Open
        assertEquals(HomeRouteDispatchResult.DISPATCHED, dispatcher.consume(pending))
        assertNull(requests.pending.value)
        assertEquals(listOf(Destination.Profile()), opened)
        assertEquals(2, standalone)
        assertTrue(reasons.isEmpty())
    }

    @Test fun `all four Profile tabs use a full frame and restore only the selected tab`() {
        for (tab in listOf("PROFILE", "KINGDOMS", "WALLET", "ACCOUNT")) {
            val initial = requireNotNull(mountedHomeSheetFrame(SheetEntry(Destination.Profile(tab))))
            assertEquals(SheetSize.FULL, initial.size)
            assertEquals(tab, initial.selectedTab)
            val restored = requireNotNull(mountedHomeSheetFrame(SheetEntry(Destination.Profile(), selectedTab = tab, restored = true)))
            assertEquals(SheetSize.FULL, restored.size)
            assertEquals(tab, restored.selectedTab)
        }
    }

    @Test fun `Profile restoration refuses unsupported tabs and sections rather than dropping their meaning`() {
        assertNull(mountedHomeSheetFrame(SheetEntry(Destination.Profile("UNKNOWN"))))
        assertNull(mountedHomeSheetFrame(SheetEntry(Destination.Profile(), selectedTab = "UNKNOWN")))
        assertNull(mountedHomeSheetFrame(SheetEntry(Destination.Profile("UNKNOWN"), selectedTab = "PROFILE")))
        for (section in listOf("unknown", "addFree", "seeker")) {
            assertNull(mountedHomeSheetFrame(SheetEntry(Destination.Profile(section = section))))
        }
    }

    private fun base(trophies: String? = null, freeBuilders: Int = 0, explicitBuilders: Boolean = false,
        buildings: List<Building> = emptyList()): BaseSnapshot = BaseSnapshot(
        baseId = "base-a", visualContext = null, player = PlayerSummary(keepLevel = 7, trophies = trophies),
        energy = null, armyStatus = null, claim = null, buildings = buildings, obstacles = emptyList(), jobs = emptyList(),
        freeBuilders = freeBuilders,
        raw = if (explicitBuilders) JsonObject(mapOf("freeBuilders" to JsonPrimitive(freeBuilders))) else JsonObject(emptyMap()),
    )
}
