package gg.pixelkingdomwars.nativeclient

import gg.pixelkingdomwars.nativeclient.model.Building
import gg.pixelkingdomwars.nativeclient.ui.features.BuildingGateState
import gg.pixelkingdomwars.nativeclient.ui.features.BuildingSelection
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
import gg.pixelkingdomwars.nativeclient.ui.kingdom.BuildingCommandRoutes
import gg.pixelkingdomwars.nativeclient.ui.kingdom.mergePhaseEBuildingCommands
import gg.pixelkingdomwars.nativeclient.ui.kingdom.phaseEBuildingCommands
import gg.pixelkingdomwars.nativeclient.ui.kingdom.phaseEBuildingFeature
import gg.pixelkingdomwars.nativeclient.ui.kingdom.phaseEBuildingFeatures
import gg.pixelkingdomwars.nativeclient.ui.kingdom.routeBuildingCommand
import gg.pixelkingdomwars.nativeclient.ui.model.CommandBarUi
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import org.junit.Assert.*
import org.junit.Test

/**
 * The account group's doors on the player path (night 2026-10-06 mount): each door opens its designed body in place, the
 * old screens it replaces are off that path, and the doors with no backing system say so. Source pins follow the
 * HomeFourGroupMountTest style; the Clan Hall door runs the real dispatcher.
 */
class AccountGroupMountTest {
    private val app = source("ui/nav/PkwApp.kt")
    private val scaffold = source("ui/home/HomeScaffold.kt")

    private class ClanHall {
        val identity = HomeRouteIdentity(Any(), "base", 1)
        val selection = BuildingSelection("base", "hall", "clanhall")
        val opened = mutableListOf<Destination>()
        val reasons = mutableListOf<String>()
        val requests = HomeRequests()
        val host = HomeSheetRouteHost({ identity }, { false }, { reasons += it })
        val mount = host.attach(identity, {}, { false }, openBody = { opened += it }).also { it.reportBlocked(false) }
        val dispatcher = HomeRouteDispatcher(requests, FeatureRegistry.canonical(), {
            HomeRouteContext(identity, GateContext(baseId = "base", buildings = mapOf("clanhall" to BuildingGateState(1, true)),
                selection = FeatureSelection(building = selection)))
        }, host)
        val routes = BuildingCommandRoutes({}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {})
    }

    // WHY: before this mount a selected Clan Hall had no CLAN command, so the designed Clan sheet was reachable only
    // through Profile. The command is navigation only (no price) and its tap must reach the Home Clan sheet exactly once.
    @Test fun `a finished Clan Hall shows CLAN and its tap opens the Home Clan sheet once`() {
        val f = ClanHall()
        assertEquals(FeatureId("clan.open"), phaseEBuildingFeature("clanhall"))
        assertEquals(setOf(FeatureId("clan.open")), phaseEBuildingFeatures("clanhall"))
        val hall = Building("hall", "clanhall", 1, 4, 6)
        val commands = phaseEBuildingCommands(f.dispatcher)
        val bar = mergePhaseEBuildingCommands(CommandBarUi(hall.id, emptyList()), hall, f.selection, commands)
        val clan = bar.commands.single()
        assertEquals(FeatureId("clan.open"), clan.id); assertEquals("CLAN", clan.caption)
        assertEquals("itm_banner", clan.icon); assertNull(clan.price)
        assertEquals(CommandState.ENABLED, clan.state)

        routeBuildingCommand(clan.id, bar, f.routes, commands, f.selection)
        val request = requireNotNull(f.requests.pending.value as? HomeRequest.Open)
        assertEquals(HomeRouteDispatchResult.DISPATCHED, f.dispatcher.consume(request))
        assertEquals(listOf(Destination.Clan()), f.opened); assertTrue(f.reasons.isEmpty())
        assertEquals(HomeRouteDispatchResult.NOT_HEAD, f.dispatcher.consume(request))
        assertEquals(1, f.opened.size)
    }

    // WHY: completion of the type elsewhere must not unlock the selected construction's CLAN door.
    @Test fun `an unfinished Clan Hall exposes no CLAN door`() {
        val f = ClanHall()
        for (hall in listOf(Building("hall", "clanhall", 0, 4, 6), Building("hall", "clanhall", 1, 4, 6, underConstruction = true))) {
            val bar = mergePhaseEBuildingCommands(CommandBarUi(hall.id, emptyList()), hall, f.selection, phaseEBuildingCommands(f.dispatcher))
            assertTrue(bar.commands.isEmpty())
        }
    }

    // WHY: Profile's CLAN, DAILY TEST SKR and land doors now act in place; the old Clan Hall focus / ClansRoute hop is off
    // the Home Profile path, while TEST SOL keeps the SOL faucet route that LandGate's top-up also depends on.
    @Test fun `hosted Profile opens Clan and the SKR faucet in place and land through the designed gate`() {
        val profile = app.substringAfter("is Destination.Profile -> gg.pixelkingdomwars.nativeclient.ui.profile.ProfileHub(graph, session,")
            .substringBefore("is Destination.Clan -> ClanHub(")
        assertTrue(profile.contains("onClans = { openHub(Destination.Clan()) }"))
        assertFalse("The Clan Hall focus hop is retired", profile.contains("HomeRequest.FocusBuilding(hall.id)"))
        assertFalse(profile.contains("navigate(ClansRoute)"))
        assertTrue(profile.contains("onSkrFaucet = { openHub(Destination.SkrFaucet) }"))
        assertTrue(profile.contains("skrFaucet = gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live.skrFaucetLocalState("))
        assertTrue(profile.contains("navController.navigate(LandGateRoute(reason = \"browse\", kind = kind))"))
        assertTrue(profile.contains("\"profile.faucet\" -> handoff { navController.navigate(FaucetRoute)"))
        // Seeker Island (owner 2026-10-06): the door hands off to the globe with the island selected, the same World
        // request the HUD map door uses, never a "not open" refusal while bidding runs on the island panel.
        assertTrue(profile.contains("\"profile.seekerIsland\" -> handoff { graph.homeRequests.request(HomeRequest.World(gg.pixelkingdomwars.nativeclient.data.WorldEntry.SeekerIsland)) }"))
        assertFalse(app.contains("PROFILE_SEEKER_ISLAND_CLOSED"))
    }

    // WHY: the SKR faucet body is the designed half sheet; no claim owner, signer or repository may be constructed at the
    // mount (only SkrFaucetHost builds one, and only in a pinned devnet test build), and its GET LAND reaches the land gate.
    @Test fun `the SKR faucet door draws SkrFaucetHost on Home and on its standalone route`() {
        val hosted = app.substringAfter("Destination.SkrFaucet -> ").substringBefore("else -> Unit")
        assertTrue(hosted.contains("SkrFaucetHost(graph, session, onClose = close,"))
        assertTrue(hosted.contains("modifier = panel"))
        assertTrue(hosted.contains("LandGateRoute(reason = \"browse\", kind = \"entry\")"))
        val standalone = app.substringAfter("composable<SkrFaucetRoute>").substringBefore("composable<GemsRoute>")
        assertTrue(standalone.contains("SkrFaucetHost(graph, s, onClose = { navController.popBackStack() },"))
        for (body in listOf(hosted, standalone)) {
            assertFalse(body.contains("SkrFaucetRepository")); assertFalse(body.contains("skrFaucetClient"))
        }
        // The SOL faucet stays exactly where it was.
        assertTrue(app.substringAfter("composable<FaucetRoute>").substringBefore("composable<SkrFaucetRoute>")
            .contains("FaucetScreen(s.faucet)"))
        val profileRoute = app.substringAfter("@Composable private fun ProfileHubDestination(").substringBefore("/** A failed pending-march read")
        assertTrue(profileRoute.contains("onSkrFaucet = { navController.navigate(SkrFaucetRoute) { launchSingleTop = true } }"))
        assertTrue(profileRoute.contains("onLand = { kind -> navController.navigate(LandGateRoute(reason = \"browse\", kind = kind))"))
        assertTrue(profileRoute.contains("\"profile.seekerIsland\" -> { graph.homeRequests.request(HomeRequest.World(gg.pixelkingdomwars.nativeclient.data.WorldEntry.SeekerIsland)); navController.popBackStack() }"))
        // Both SKR faucet hosts' Seeker door is the same World request (the sheet's GO SEEKER lands on the island panel).
        assertTrue(hosted.contains("onGoSeeker = { handoff { graph.homeRequests.request(HomeRequest.World(gg.pixelkingdomwars.nativeclient.data.WorldEntry.SeekerIsland)) } }"))
        assertTrue(standalone.contains("onGoSeeker = { graph.homeRequests.request(HomeRequest.World(gg.pixelkingdomwars.nativeclient.data.WorldEntry.SeekerIsland)); navController.popBackStack() }"))
    }

    // WHY: the Clan sheet's CHAT is the HUD's own chat door (the docked chat over the base), not a second full-screen route.
    @Test fun `hosted Clan chat uses the HUD chat door`() {
        val clan = app.substringAfter("is Destination.Clan -> ClanHub(").substringBefore("is Destination.Quests ->")
        assertTrue(clan.contains("onChat = { handoff { openMore(MoreDestination.CHAT) } }"))
        assertFalse(clan.contains("navigate(ChatRoute)"))
    }

    // WHY: every KEEP supply buy asks first unless the player turned that off in Settings; both Supplies mounts must pass
    // the player's own preference (null would always ask and ignore the opt-out).
    @Test fun `both Supplies mounts pass the player KEEP confirmation preference`() {
        assertEquals(2, Regex("SuppliesHomeBody\\(").findAll(app).count())
        val shop = app.substringAfter("composable<ShopRoute>").substringBefore("composable<FaucetRoute>")
        val home = app.substringAfter("supplies = { tabs, onTab, onBuilders, onClose, placed ->").substringBefore("onReviewBlockedChanged = reportReview")
        for (mount in listOf(shop, home)) {
            assertTrue(mount.contains("SuppliesHomeBody(")); assertTrue(mount.contains("keepConfirm = graph.keepConfirm)"))
        }
    }

    // WHY: a landless signed-in player sees the land herald and the free camp segment, and the herald's tap must open the
    // designed land gate (not fall through to nothing); unknown land raises neither.
    @Test fun `the Kingdom HUD carries the land herald and free camp and routes the herald to the land gate`() {
        assertTrue(scaffold.contains("LAND_HERALD_TARGET.value -> onOpenLand()"))
        assertTrue(scaffold.contains("homeFreeCampHud(homeHudState("))
        // Rewritten 2026-10-06 (hub group): the returned-voyage and builder-finished heralds now sit between the defence
        // notice and the land line. The rule kept: a defence notice comes first and the land herald still fills the end.
        assertTrue(scaffold.contains("herald = homeHeraldUi(defenceNotice) ?: voyageSignals.herald ?: builderHerald ?: homeLandHeraldUi(homeLandOwned, null)"))
        assertTrue(scaffold.contains("landOwnedLive(account).takeIf { account.phase == AccountPhase.SIGNED_IN }"))
    }

    private fun source(path: String) = java.io.File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/$path").readText()
}
