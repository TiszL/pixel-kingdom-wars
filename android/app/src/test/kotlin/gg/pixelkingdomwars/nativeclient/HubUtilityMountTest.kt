package gg.pixelkingdomwars.nativeclient

import gg.pixelkingdomwars.nativeclient.data.BaseState
import gg.pixelkingdomwars.nativeclient.model.BaseSnapshot
import gg.pixelkingdomwars.nativeclient.model.Building
import gg.pixelkingdomwars.nativeclient.ui.chrome.ToastDoors
import gg.pixelkingdomwars.nativeclient.ui.chrome.ToastItem
import gg.pixelkingdomwars.nativeclient.ui.chrome.kitToastUi
import gg.pixelkingdomwars.nativeclient.ui.home.homeBuilderFinishedHeralds
import gg.pixelkingdomwars.nativeclient.model.PlayerSummary
import gg.pixelkingdomwars.nativeclient.ui.features.Destination
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureRegistry
import gg.pixelkingdomwars.nativeclient.ui.features.GateContext
import gg.pixelkingdomwars.nativeclient.ui.features.GateFact
import gg.pixelkingdomwars.nativeclient.ui.home.HomeRequest
import gg.pixelkingdomwars.nativeclient.ui.home.HomeRequests
import gg.pixelkingdomwars.nativeclient.ui.home.HomeRouteContext
import gg.pixelkingdomwars.nativeclient.ui.home.HomeRouteDispatchResult
import gg.pixelkingdomwars.nativeclient.ui.home.HomeRouteDispatcher
import gg.pixelkingdomwars.nativeclient.ui.home.HomeRouteIdentity
import gg.pixelkingdomwars.nativeclient.ui.home.HomeSheetRouteHost
import gg.pixelkingdomwars.nativeclient.ui.home.HomeTab
import gg.pixelkingdomwars.nativeclient.ui.home.homeHeraldUi
import gg.pixelkingdomwars.nativeclient.ui.home.homeHudState
import gg.pixelkingdomwars.nativeclient.ui.home.mountedHomeSheetFrame
import gg.pixelkingdomwars.nativeclient.ui.hud.HudIds
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeTone
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeUi
import gg.pixelkingdomwars.nativeclient.ui.model.EdgeButtonUi
import gg.pixelkingdomwars.nativeclient.ui.model.SheetSize
import gg.pixelkingdomwars.nativeclient.ui.more.HISTORY_REPORT_DOOR
import gg.pixelkingdomwars.nativeclient.ui.profile.profileHubBody
import gg.pixelkingdomwars.nativeclient.ui.sheets.SheetEntry
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.LoadState
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live.EVENT_DOOR_FEATURES
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live.HISTORY_RECOVERY_DOORS
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live.MAIL_KINGDOMS
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live.MAIL_QUESTS
import java.io.File
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.*
import org.junit.Test

/**
 * The hub utility mount (Settings, Feedback, History, Event, Mail, Leagues, toasts, herald, gates). WHY these pins matter:
 * the owner asked for the designed screens to replace the old ones on the player path, so every door must open the
 * designed body (never the retired screen), every link a hub card can emit must land somewhere or say why (a door never
 * does nothing), and a restored sheet must only bring back the tabs its card really has.
 */
class HubUtilityMountTest {
    private val root = "src/main/kotlin/gg/pixelkingdomwars/nativeclient"
    private val app = File("$root/ui/nav/PkwApp.kt").readText()

    @Test fun `each hub sheet uses a full frame and restores only the tabs its card has`() {
        val cases = listOf(
            Destination.Settings() to listOf("GAME", "ACCOUNT", "HELP"),
            Destination.Feedback to listOf("NEW", "MY REPORTS"),
            Destination.WalletHistory() to listOf("ALL", "GOLDFORGE", "WORKSHOP", "LODGE", "BERTH"),
            Destination.Event() to listOf("POINTS", "RANKS", "PRIZES"),
            Destination.Mail to listOf("ALL", "REWARDS", "NEWS", "ARCHIVE"),
        )
        for ((destination, tabs) in cases) {
            for (tab in tabs) {
                val frame = requireNotNull(mountedHomeSheetFrame(SheetEntry(destination, selectedTab = tab, restored = true))) { "$destination $tab" }
                assertEquals(SheetSize.FULL, frame.size)
                assertEquals(tab, frame.selectedTab)
            }
            assertNull("$destination", mountedHomeSheetFrame(SheetEntry(destination, selectedTab = "UNKNOWN")))
        }
        // A Settings section (a deep anchor this card does not draw) is refused rather than dropped.
        assertNull(mountedHomeSheetFrame(SheetEntry(Destination.Settings("HELP", section = "codex"))))
        assertNull(mountedHomeSheetFrame(SheetEntry(Destination.Event("UNKNOWN"))))
    }

    @Test fun `a History door opened for a place starts on that place's chip`() {
        // A Workshop receipt link must not land on ALL; an unknown place falls back to ALL instead of an empty chip.
        assertEquals("WORKSHOP", mountedHomeSheetFrame(SheetEntry(Destination.WalletHistory("workshop")))?.selectedTab)
        assertEquals("LODGE", mountedHomeSheetFrame(SheetEntry(Destination.WalletHistory("lodge")))?.selectedTab)
        assertEquals("ALL", mountedHomeSheetFrame(SheetEntry(Destination.WalletHistory("market")))?.selectedTab)
    }

    @Test fun `the EVENT door opens the Founding Kingdoms sheet only while the server says the campaign is live`() {
        val identity = HomeRouteIdentity(Any(), "base-a", 4)
        val reasons = mutableListOf<String>()
        val opened = mutableListOf<Destination>()
        val host = HomeSheetRouteHost({ identity }, { false }, { reasons += it })
        host.attach(identity, {}, { false }, openBody = { opened += it }).reportBlocked(false)
        var fact: GateFact = GateFact.Allowed
        val requests = HomeRequests()
        val dispatcher = HomeRouteDispatcher(requests, FeatureRegistry.canonical(),
            { HomeRouteContext(identity, GateContext(baseId = identity.baseId, serverFeatures = mapOf("tester.campaignLive" to fact))) }, host)
        val event = FeatureId("hud.event")

        assertTrue(host.canOpen(event, HomeTab.KINGDOM))
        assertTrue(dispatcher.handleFeatureDoor(event))
        assertEquals(HomeRouteDispatchResult.DISPATCHED, dispatcher.consume(requests.pending.value as HomeRequest.Open))
        assertEquals(listOf<Destination>(Destination.Event()), opened)

        // The campaign ended between the tap and the dispatch: nothing opens.
        fact = GateFact.Denied("Founding Kingdoms is not running.")
        assertTrue(dispatcher.handleFeatureDoor(event))
        assertEquals(HomeRouteDispatchResult.HIDDEN, dispatcher.consume(requests.pending.value as HomeRequest.Open))
        assertEquals(1, opened.size)
        assertTrue(reasons.isEmpty())
    }

    @Test fun `Home sheet bodies are the designed hub cards and the retired screens are off the player path`() {
        for ((branch, body) in listOf(
            "is Destination.Settings -> " to "SettingsHub(graph, session, wallet,",
            "Destination.Feedback -> " to "gg.pixelkingdomwars.nativeclient.ui.community.FeedbackHub(graph, session,",
            "is Destination.WalletHistory -> " to "HistoryHub(graph, session,",
            "is Destination.Event -> " to "gg.pixelkingdomwars.nativeclient.ui.community.EventHub(graph, session,",
            "is Destination.Leagues -> " to "gg.pixelkingdomwars.nativeclient.ui.community.LeaguesHub(graph, session,",
            "Destination.Mail -> " to "gg.pixelkingdomwars.nativeclient.ui.community.MailHub(graph, session,",
        )) assertTrue(branch + body, (branch + body) in app)
        for ((route, body) in listOf(
            "composable<SettingsRoute> { SettingsHub(" to "SettingsHub",
            "composable<FeedbackRoute> { session?.let { s -> gg.pixelkingdomwars.nativeclient.ui.community.FeedbackHub(" to "FeedbackHub",
            "composable<MailRoute> { session?.let { s -> gg.pixelkingdomwars.nativeclient.ui.community.MailHub(" to "MailHub",
            "composable<LeaguesRoute> { session?.let { s -> gg.pixelkingdomwars.nativeclient.ui.community.LeaguesHub(" to "LeaguesHub",
            "composable<TesterRoute> { session?.let { s -> gg.pixelkingdomwars.nativeclient.ui.community.EventHub(" to "EventHub",
        )) assertTrue("$body on $route", route in app)
        for (retired in listOf("SettingsScreen(", "TesterScreen(", "CommunityScreen(", "FeedbackScreen(", "HomeLeagueSheet(", "HomeMailSheet("))
            assertFalse(retired, retired in app)
        assertFalse(File("$root/ui/more/SettingsScreen.kt").exists())
        assertFalse(File("$root/ui/community/TesterScreen.kt").exists())
        // Profile's SETTINGS and Feedback now open the designed sheets instead of leaving Home.
        assertTrue("onSettings = { openHub(Destination.Settings()) }" in app)
        assertTrue("\"profile.feedback\" -> openHub(Destination.Feedback)" in app)
        assertTrue("\"profile.history\" -> openHub(Destination.WalletHistory())" in app)
    }

    @Test fun `every link a Mail History or Event card can emit lands on a sheet or an existing owner`() {
        val links = app.substringAfter("val openHubLink: (gg.pixelkingdomwars.nativeclient.ui.sheets.hub.HubLink) -> Unit = { link ->")
            .substringBefore("when (entry.destination) {")
        val emitted = EVENT_DOOR_FEATURES + HISTORY_RECOVERY_DOORS + HISTORY_REPORT_DOOR + MAIL_QUESTS.value + MAIL_KINGDOMS.value
        for (feature in emitted) assertTrue(feature, "\"$feature\"" in links)
        // Anything else is explained, never silently dropped.
        assertTrue("else -> localRouteHost.locked(" in links)
        assertTrue("onDoor = openHubLink" in app && "onOpen = openHubLink" in app)
    }

    @Test fun `refusals use the designed toast layer and the 426 and maintenance gates use the designed card`() {
        val scaffold = File("$root/ui/home/HomeScaffold.kt").readText()
        for (source in listOf(app, scaffold)) assertFalse("android.widget.Toast.makeText" in source)
        assertTrue("gg.pixelkingdomwars.nativeclient.update.ServerGateCard(current," in app)
        assertTrue("is Gate.Update, is Gate.Maintenance -> {} // Rendered by ServerGateCard." in app)
        assertTrue("gg.pixelkingdomwars.nativeclient.update.NativeUpdateGate()" in scaffold)
        assertFalse("NativeUpdateScreen()" in scaffold)
        // The defence notice is the herald, not a header bar.
        assertFalse("defenceNotice?.let { Notice(it) }" in scaffold)
        assertTrue("herald = homeHeraldUi(defenceNotice)" in scaffold)
    }

    @Test fun `Mail stays on the edge with an empty inbox and the herald and event button reach the HUD`() {
        val loaded = BaseState(base = BaseSnapshot(baseId = "base-a", visualContext = null, player = PlayerSummary(keepLevel = 3),
            energy = null, armyStatus = null, claim = null, buildings = emptyList(), obstacles = emptyList(), jobs = emptyList(),
            freeBuilders = 0, raw = JsonObject(emptyMap())))
        val event = EdgeButtonUi(HudIds.EVENT, "ui_banner_event", "EVENT", BadgeUi("!", BadgeTone.READY, "Founding Kingdoms is live"), true)
        val herald = homeHeraldUi("Your kingdom was raided.")
        val ui = homeHudState(loaded, null, 0, false, 0, 0, false, herald = herald, eventButton = event)

        val mail = ui.leftEdge.single { it.id == HudIds.MAIL }
        assertNull("zero unread draws no badge, but the door stays", mail.badge)
        assertEquals(event, ui.rightEdge.last())
        assertEquals(HudIds.SHIELD, ui.herald?.target)
        // Before the base is read there is nothing to open yet, so no Mail door and no herald.
        val unread = homeHudState(BaseState(), null, 0, false, 0, 0, false)
        assertTrue(unread.leftEdge.none { it.id == HudIds.MAIL })
        assertNull(unread.herald)
        assertNull(homeHeraldUi(null)); assertNull(homeHeraldUi(" "))
    }

    @Test fun `Profile HISTORY opens the History sheet once the kingdom is known`() {
        val loaded = BaseState(base = BaseSnapshot(baseId = "base-a", visualContext = null, player = PlayerSummary(keepLevel = 3),
            energy = null, armyStatus = null, claim = null, buildings = emptyList(), obstacles = emptyList(), jobs = emptyList(),
            freeBuilders = 0, raw = JsonObject(emptyMap())))
        val door = requireNotNull(profileHubBody(loaded, LoadState.Ready).historyDoor)
        assertNull(door.lockedReason)
        assertEquals("profile.history", requireNotNull(door.link).feature.value)
    }

    @Test fun `a toast Report opens the designed Feedback card prefilled and only while a session exists`() {
        // hub SPEC §3.2 "Report → Feedback, prefilled": the app root binds it for as long as a session can hold the draft,
        // stores the toast's sentence first and lands on FeedbackRoute (whose body is FeedbackHub, pinned above). It is not
        // bound while a fight, replay or scout is on top, so a toast can never take a player out of a battle past its exit.
        val root = app.substringAfter("@Composable fun PkwApp(").substringBefore("@Composable private fun HomeShell(")
        assertTrue("ToastDoors.bindReport { message ->" in root)
        assertEquals("one Report binding, so two screens never fight over it", 1, app.split("ToastDoors.bindReport").size - 1)
        val handler = root.substringAfter("ToastDoors.bindReport { message ->").substringBefore("onDispose { binding?.close() }")
        assertTrue("val binding = live?.let { s ->" in root)
        assertTrue("val live = session?.takeIf { toastReportOpen }" in root)
        val closedOn = root.substringAfter("val toastReportOpen = ").substringBefore("DisposableEffect(session, navController, toastReportOpen)")
        for (route in listOf("BattleRoute", "ReplayRoute", "WatchRoute", "ScoutRoute")) assertTrue(route, "hasRoute<$route>()" in closedOn)
        assertTrue("prefillToastReport(s.feedback.drafts, message," in handler)
        assertTrue("navController.navigate(FeedbackRoute) { launchSingleTop = true }; true" in handler)
        // Bound, an error toast draws Report and the tap reaches the handler; closed, the same toast draws no dead Report.
        val failure = ToastItem(2, "Could not reach the server.", true, 0)
        val reported = mutableListOf<String>()
        val binding = ToastDoors.bindReport { reported += it; true }
        try {
            assertTrue(kitToastUi(failure, reportBound = ToastDoors.reportBound.value).report)
            assertTrue(ToastDoors.report(failure.message))
            assertEquals(listOf("Could not reach the server."), reported)
        } finally { binding.close() }
        assertFalse(kitToastUi(failure, reportBound = ToastDoors.reportBound.value).report)
    }

    @Test fun `a toast GO opens its place through the typed Home door and draws only while Home has bound it`() {
        // A GO is a shortcut to a HUD door, so it must pass the same gates as the HUD tap. Only the Home route scope binds it;
        // off Home there is no typed host, so the layer draws no GO rather than one that cannot open.
        val shell = app.substringAfter("@Composable private fun HomeShell(")
        assertTrue("ToastDoors.bindGo { feature -> d.handleFeatureDoor(feature) }" in shell)
        assertEquals(1, app.split("ToastDoors.bindGo").size - 1)
        val identity = HomeRouteIdentity(Any(), "base-a", 4)
        val opened = mutableListOf<Destination>()
        val host = HomeSheetRouteHost({ identity }, { false }, {})
        host.attach(identity, {}, { false }, openBody = { opened += it }).reportBlocked(false)
        val requests = HomeRequests()
        val dispatcher = HomeRouteDispatcher(requests, FeatureRegistry.canonical(),
            { HomeRouteContext(identity, GateContext(baseId = identity.baseId, serverFeatures = mapOf("tester.campaignLive" to GateFact.Allowed))) }, host)
        val event = FeatureId("hud.event")
        val line = ToastItem(1, "Founding Kingdoms is live.", false, 0, go = event)
        val binding = ToastDoors.bindGo { feature -> dispatcher.handleFeatureDoor(feature) }
        try {
            assertEquals(event, kitToastUi(line, goBound = ToastDoors.goBound.value).go)
            assertTrue(ToastDoors.go(event))
            assertEquals(HomeRouteDispatchResult.DISPATCHED, dispatcher.consume(requests.pending.value as HomeRequest.Open))
            assertEquals(listOf<Destination>(Destination.Event()), opened)
        } finally { binding.close() }
        assertNull(kitToastUi(line, goBound = ToastDoors.goBound.value).go)
        assertFalse(ToastDoors.go(event))
    }

    @Test fun `a finished builder raises the herald below defence and voyage and its tap opens the builders`() {
        // hub SPEC §3.1 "Builder finished: Workshop Lv 3". A defence notice and a returned voyage keep the banner first; the
        // land line only fills an otherwise empty herald. The target must be a door the HUD already handles, or the tap is dead.
        val scaffold = File("$root/ui/home/HomeScaffold.kt").readText()
        assertTrue("val builderHerald = rememberHomeBuilderHerald(home.base?.buildings, home.base?.baseId)" in scaffold)
        assertTrue("herald = homeHeraldUi(defenceNotice) ?: voyageSignals.herald ?: builderHerald ?: homeLandHeraldUi(homeLandOwned, null)" in scaffold)
        val herald = homeBuilderFinishedHeralds("base-a", listOf(Building("b1", "workshop", 2, 0, 0)),
            "base-a", listOf(Building("b1", "workshop", 3, 0, 0))).single()
        assertEquals(HudIds.BUILDERS, herald.target)
        assertTrue("\"${HudIds.BUILDERS.value}\" -> requests.request(HomeRequest.Builders)" in scaffold)
    }

    @Test fun `Event rules open in place and the notification opt-in is the Settings GAME toggle`() {
        // event.png: the header INFO opens the rules over the card, never a hop to the old campaign page, and says why when
        // the catalogue has no rules. The campaign page stays only for a saved request and submissions (onCampaign).
        val event = File("$root/ui/community/EventHub.kt").readText()
        assertTrue("onRules = ::openRules," in event)
        assertFalse("onRules = { act(onCampaign) }" in event)
        assertTrue("EventRulesPanel(rules, onClose = { rulesOpen = false }," in event)
        assertTrue("explain(\"Event rules are unavailable. Update game content.\")" in event)
        assertTrue("onCampaign = " in app.substringAfter("is Destination.Event -> "))
        // settings.png: the ACCOUNT TURN ON / TURN OFF buttons became the GAME toggle, which runs the same owner calls.
        val settings = File("$root/ui/more/SettingsHub.kt").readText()
        assertTrue("else if (notify != null) rowAction(notify)" in settings)
    }
}
