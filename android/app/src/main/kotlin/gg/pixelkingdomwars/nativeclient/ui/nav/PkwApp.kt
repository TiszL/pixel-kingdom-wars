package gg.pixelkingdomwars.nativeclient.ui.nav

import android.annotation.SuppressLint
import androidx.compose.foundation.layout.*
import gg.pixelkingdomwars.nativeclient.ui.chrome.AlertDialog
import gg.pixelkingdomwars.nativeclient.ui.chrome.Button
import gg.pixelkingdomwars.nativeclient.ui.chrome.TextButton
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.zIndex
import gg.pixelkingdomwars.nativeclient.ui.goldforge.GoldForgeControlsRoute
import gg.pixelkingdomwars.nativeclient.ui.goldforge.GoldForgeLegacyControlsRoute
import gg.pixelkingdomwars.nativeclient.ui.goldforge.GoldForgeWalletControlsRoute
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import androidx.navigation.toRoute
import androidx.navigation.NavDestination.Companion.hasRoute
import gg.pixelkingdomwars.nativeclient.AppGraph
import gg.pixelkingdomwars.nativeclient.SessionGraph
import gg.pixelkingdomwars.nativeclient.data.AccountPhase
import gg.pixelkingdomwars.nativeclient.data.AccountRepository
import gg.pixelkingdomwars.nativeclient.data.AccountState
import gg.pixelkingdomwars.nativeclient.data.BaseState
import gg.pixelkingdomwars.nativeclient.data.BattleDomainState
import gg.pixelkingdomwars.nativeclient.data.RoutingEvent
import gg.pixelkingdomwars.nativeclient.network.string
import gg.pixelkingdomwars.nativeclient.ui.community.ChatScreen
import gg.pixelkingdomwars.nativeclient.ui.community.HostedChat
import gg.pixelkingdomwars.nativeclient.ui.community.hostedChatFrame
import gg.pixelkingdomwars.nativeclient.ui.community.ClanHub
import gg.pixelkingdomwars.nativeclient.ui.community.PlaytestCampaignScreen
import gg.pixelkingdomwars.nativeclient.data.ChatBounds
import gg.pixelkingdomwars.nativeclient.ui.Copy
import gg.pixelkingdomwars.nativeclient.ui.ScreenViewModel
import gg.pixelkingdomwars.nativeclient.ui.army.ArmyScreen
import gg.pixelkingdomwars.nativeclient.ui.army.ArmyViewModel
import gg.pixelkingdomwars.nativeclient.ui.army.ResearchScreen
import gg.pixelkingdomwars.nativeclient.ui.army.refreshResearchRecoveryEntry
import gg.pixelkingdomwars.nativeclient.ui.world.WorldScreen
import gg.pixelkingdomwars.nativeclient.ui.world.WorldViewModel
import gg.pixelkingdomwars.nativeclient.ui.profile.ProfileScreen
import gg.pixelkingdomwars.nativeclient.ui.profile.ProfileViewModel
import gg.pixelkingdomwars.nativeclient.ui.attack.AttackScreen
import gg.pixelkingdomwars.nativeclient.ui.attack.AttackViewModel
import gg.pixelkingdomwars.nativeclient.ui.battle.BattleViewModel
import gg.pixelkingdomwars.nativeclient.ui.battle.LiveBattleScreen
import gg.pixelkingdomwars.nativeclient.ui.battle.ReplayScreen
import gg.pixelkingdomwars.nativeclient.ui.boot.BootDestination
import gg.pixelkingdomwars.nativeclient.ui.boot.BootViewModel
import gg.pixelkingdomwars.nativeclient.ui.boot.bootDestination
import gg.pixelkingdomwars.nativeclient.ui.home.DefenceNotices
import androidx.compose.ui.platform.LocalContext
import gg.pixelkingdomwars.nativeclient.network.storageNamespace
import java.time.Instant
import kotlinx.coroutines.launch
import kotlinx.coroutines.supervisorScope
import gg.pixelkingdomwars.nativeclient.ui.home.HomeScaffold
import gg.pixelkingdomwars.nativeclient.ui.home.currentHomeWallet
import gg.pixelkingdomwars.nativeclient.ui.home.homeBuildRefusalReason
import gg.pixelkingdomwars.nativeclient.ui.home.HomeTab
import gg.pixelkingdomwars.nativeclient.ui.economy.EconomyScreen
import gg.pixelkingdomwars.nativeclient.ui.economy.EconomyViewModel
import gg.pixelkingdomwars.nativeclient.ui.economy.ForgeClaimsViewModel
import gg.pixelkingdomwars.nativeclient.ui.economy.WithdrawalUnwindViewModel
import gg.pixelkingdomwars.nativeclient.ui.economy.ReferralViewModel
import gg.pixelkingdomwars.nativeclient.ui.kingdom.KingdomScreen
import gg.pixelkingdomwars.nativeclient.ui.kingdom.KingdomViewModel
import gg.pixelkingdomwars.nativeclient.ui.kingdom.KingdomUiState
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.ui.features.BuildingGateState
import gg.pixelkingdomwars.nativeclient.ui.features.BuildingSelection
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureSelection
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureRegistry
import gg.pixelkingdomwars.nativeclient.ui.features.GateContext
import gg.pixelkingdomwars.nativeclient.ui.home.HomeRouteContext
import gg.pixelkingdomwars.nativeclient.ui.home.HomeRouteDispatcher
import gg.pixelkingdomwars.nativeclient.ui.home.HomeRouteIdentity
import gg.pixelkingdomwars.nativeclient.ui.home.LocalHomeRouteDispatcher
import gg.pixelkingdomwars.nativeclient.ui.home.LocalHomeRouteHost
import gg.pixelkingdomwars.nativeclient.ui.home.HomeSheetRouteHost
import gg.pixelkingdomwars.nativeclient.ui.home.HomeRouteReviewGate
import gg.pixelkingdomwars.nativeclient.ui.home.HomeLayerHooks
import gg.pixelkingdomwars.nativeclient.ui.home.HomeLayerContent
import gg.pixelkingdomwars.nativeclient.ui.home.HOME_LEAGUE_TABS
import gg.pixelkingdomwars.nativeclient.ui.home.HomeOwnerProjections
import gg.pixelkingdomwars.nativeclient.ui.home.HomeHarvesterSheet
import gg.pixelkingdomwars.nativeclient.ui.home.HomeWorkshopSheet
import gg.pixelkingdomwars.nativeclient.ui.home.homeMountedWorkshopBuildingType
import gg.pixelkingdomwars.nativeclient.ui.home.HomeVoyageSheet
import gg.pixelkingdomwars.nativeclient.ui.home.HomeBodyBack
import gg.pixelkingdomwars.nativeclient.ui.home.homeMountedBuildingType
import gg.pixelkingdomwars.nativeclient.ui.home.homeMountedMarketBuildingType
import gg.pixelkingdomwars.nativeclient.ui.home.HomeFeatureReadCapture
import gg.pixelkingdomwars.nativeclient.ui.home.HomeFeatureReadStatus
import gg.pixelkingdomwars.nativeclient.ui.home.HomeNavigationResult
import gg.pixelkingdomwars.nativeclient.ui.home.homeObservedFeatureFact
import gg.pixelkingdomwars.nativeclient.ui.home.homeFeatureReadResult
import gg.pixelkingdomwars.nativeclient.ui.home.homeHasCompletedHarvester
import gg.pixelkingdomwars.nativeclient.ui.home.homeHarvesterLegacyNotice
import gg.pixelkingdomwars.nativeclient.ui.home.awaitHomeReadAdmission
import gg.pixelkingdomwars.nativeclient.data.CommunityRepository
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import gg.pixelkingdomwars.nativeclient.ui.home.homeRouteSessionId
import gg.pixelkingdomwars.nativeclient.ui.home.mountedHomeSheetFrame
import gg.pixelkingdomwars.nativeclient.ui.home.mountedHomeSheetStack
import gg.pixelkingdomwars.nativeclient.ui.features.Destination
import gg.pixelkingdomwars.nativeclient.ui.sheets.SheetScope
import gg.pixelkingdomwars.nativeclient.ui.sheets.SheetHost
import gg.pixelkingdomwars.nativeclient.ui.sheets.rememberHomeSheetStacks
import gg.pixelkingdomwars.nativeclient.ui.sheets.rememberSheetHostState
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.LoadState
import gg.pixelkingdomwars.nativeclient.ui.phasee.PhaseEBuildingDispatcher
import gg.pixelkingdomwars.nativeclient.ui.phasee.PhaseEBuildingDispatcherScope
import gg.pixelkingdomwars.nativeclient.ui.layout.LayoutEditorViewModel
import gg.pixelkingdomwars.nativeclient.ui.more.*
import gg.pixelkingdomwars.nativeclient.ui.roster.CodexScreen
import gg.pixelkingdomwars.nativeclient.ui.roster.HeroesScreen
import gg.pixelkingdomwars.nativeclient.ui.roster.InventoryScreen
import gg.pixelkingdomwars.nativeclient.ui.roster.RosterViewModel
import gg.pixelkingdomwars.nativeclient.ui.preview.PreviewScreen
import gg.pixelkingdomwars.nativeclient.ui.preview.PreviewViewModel
import gg.pixelkingdomwars.nativeclient.ui.battle.ScoutScreen
import gg.pixelkingdomwars.nativeclient.ui.battle.SpectatorBattleScreen
import gg.pixelkingdomwars.nativeclient.ui.battle.BattleExits
import gg.pixelkingdomwars.nativeclient.data.EntryRecovery
import gg.pixelkingdomwars.nativeclient.ui.home.HomeRequests
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import gg.pixelkingdomwars.nativeclient.ui.home.FundsSheet
import gg.pixelkingdomwars.nativeclient.ui.home.HomeRequest
import gg.pixelkingdomwars.nativeclient.ui.land.LandGateScreen
import gg.pixelkingdomwars.nativeclient.ui.land.LandViewModel
import gg.pixelkingdomwars.nativeclient.ui.title.TitleScreen
import gg.pixelkingdomwars.nativeclient.ui.title.TitleViewModel
import gg.pixelkingdomwars.nativeclient.ui.title.TotpScreen
import gg.pixelkingdomwars.nativeclient.ui.security.SecurityDestination
import gg.pixelkingdomwars.nativeclient.wallet.WalletLogin
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

// Type-safe routes: Boot → Title → Totp → LandGate → Home; full-screen Battle/Replay; More pages.
@Serializable object BootRoute
@Serializable object TitleRoute
@Serializable object AdmissionRoute
@Serializable object TotpRoute
/** `reason` = refused (a 402 LAND_NOT_OWNED) or browse (the player asked); `kind` = entry | deed. */
@Serializable data class LandGateRoute(val reason: String = "browse", val kind: String = "entry")
@Serializable object BaseClaimRoute
@Serializable object ScoutRoute
@Serializable object HomeRoute
@Serializable object PreviewRoute
@Serializable object BattleRoute
@Serializable object ReplayRoute
@Serializable object ResearchRoute
@Serializable object BuilderPaymentRoute
@Serializable object TrainingPaymentRoute
@Serializable data class HeroesRoute(val hero: String? = null)
@Serializable object InventoryRoute
@Serializable object ShopRoute
@Serializable object ClansRoute
@Serializable object FeedbackRoute
@Serializable object TesterRoute
@Serializable object PlaytestCampaignRoute
@Serializable object ChatRoute
@Serializable object RaidLogRoute
@Serializable object MailRoute
@Serializable object LeaguesRoute
@Serializable object FaucetRoute
/** The devnet DAILY TEST SKR sheet outside Home (standalone Profile); the SOL faucet stays [FaucetRoute]. */
@Serializable object SkrFaucetRoute
@Serializable object KeepDepositRoute
@Serializable data class BasePurchaseRoute(val kind: String = "", val baseId: String = "", val buildingId: String? = null)
@Serializable data class MarketRoute(val itemId: String? = null)
@Serializable object SettingsRoute
@Serializable object AboutRoute
@Serializable object SeekerRoute
@Serializable object ForgeRoute
@Serializable object GemsRoute
@Serializable object WorkshopRoute
@Serializable object StarterFleetRoute
@Serializable object StarterExpeditionRoute
@Serializable object HarvesterRoute
@Serializable object MiningContributionRoute
@Serializable data class OrdinaryCraftingRoute(val initialTab: String = "REFINE") {
    val ownerTab: String get() = if (initialTab == "COSMETICS") "COSMETICS" else "REFINE"
}
@Serializable object GemsBuyRoute
@Serializable object EconomyRoute
@Serializable object ReferralsRoute
@Serializable object CodexRoute
@Serializable object QuestsRoute
@Serializable object AccountRoute
@Serializable object ProfileRoute
@Serializable object ProfileEditRoute
@Serializable object SecurityRoute
/** Web `screen:'bases'`; [notice] carries the authority-recovery line (web `recoverBaseAuthority` toast). */
@Serializable data class BasesRoute(val notice: String? = null, val launch: String? = null)
/** The defender's WATCH LIVE view of the selected deed's raid. */
@Serializable object WatchRoute

/** Cadences and thresholds read only from the constants catalogue, by the names `packages/shared/src/constants.ts`
 * exports (`MOBILE_BACK.exitConfirmMs`, `WORLD.mapPollSec`). No declared defaults: a pack that lacks a key
 * yields null and the feature it times fails closed with [compatibilityNotice]. */
object CatalogueTimings {
    fun exitConfirmMs(catalogue: JsonObject?): Long? = positive(constants(catalogue, "MOBILE_BACK")?.string("exitConfirmMs"))
    fun homeRefreshMs(catalogue: JsonObject?): Long? = positive(constants(catalogue, "WORLD")?.string("mapPollSec"))?.let { it * 1_000 }
    /** Names the timings a LOADED pack lacks (null while no catalogue is loaded, or when all are present). */
    fun compatibilityNotice(catalogue: JsonObject?): String? {
        if (catalogue == null) return null
        val missing = listOfNotNull("MOBILE_BACK.exitConfirmMs".takeIf { exitConfirmMs(catalogue) == null }, "WORLD.mapPollSec".takeIf { homeRefreshMs(catalogue) == null })
        return if (missing.isEmpty()) null else "GAME CONTENT UPDATE NEEDED — THIS PACK LACKS ${missing.joinToString()}. HOME AUTO-REFRESH AND BACK-TO-EXIT STAY OFF UNTIL IT IS APPLIED."
    }
    private fun positive(text: String?): Long? = text?.toLongOrNull()?.takeIf { it > 0 }
    private fun constants(catalogue: JsonObject?, key: String): JsonObject? = (catalogue?.get("constants") as? JsonObject)?.get(key) as? JsonObject
}

/** Gates driven by API routing, shown above whatever screen is current. */
sealed interface Gate {
    data class Update(val message: String) : Gate
    data class Maintenance(val message: String) : Gate
    data object Alpha : Gate
    data class Funds(val code: String, val message: String) : Gate
    /** A transient authority failure (web toast): the action can simply be retried. */
    data class Info(val message: String) : Gate
}

/** The gates' sign-out. On the web the alpha gate's 'BACK — SWITCH ACCOUNT' (apps/web/src/ui/Overlay.tsx
 * AlphaGateScreen) goes through auth/useSignOut.ts: the server session ends, then the device credentials —
 * the Privy session included — so another account can sign in. The refused wallet is captured before the
 * local sign-out clears it; it is null when the gate answered a sign-in or restore that never installed a
 * session, and the release then decides from the device's social binding. */
class GateViewModel(private val accounts: AccountRepository, private val release: suspend (WalletLogin?, String?) -> Unit) : ScreenViewModel() {
    constructor(graph: AppGraph) : this(graph.account, graph::releaseLocalCredentials)
    fun signOut(mwa: WalletLogin?) { val wallet = accounts.state.value.wallet ?: accounts.state.value.admission?.wallet; run { accounts.logout { release(mwa, wallet) } } }
    /** The land gate ends the server session itself; release the ended account's device credentials the same way. */
    fun releaseCredentials(mwa: WalletLogin?, wallet: String) = run { release(mwa, wallet) }
}

/** Scene routes (Home, battle, watch, replay, scout) switch without the NavHost's default 700 ms cross-fade: a GL SurfaceView
 *  cannot follow a Compose alpha, so the fade showed a half-faded shell over a scene (scene-transitions spec §4 step 3).
 *  Their own covers do the transition; ordinary routes keep the default fades and sheets keep the kit motion. */
internal val sceneEnter: androidx.compose.animation.AnimatedContentTransitionScope<androidx.navigation.NavBackStackEntry>.() -> androidx.compose.animation.EnterTransition? =
    { androidx.compose.animation.EnterTransition.None }
internal val sceneExit: androidx.compose.animation.AnimatedContentTransitionScope<androidx.navigation.NavBackStackEntry>.() -> androidx.compose.animation.ExitTransition? =
    { androidx.compose.animation.ExitTransition.None }

@Composable inline fun <reified T : ViewModel> graphViewModel(key: Any, crossinline create: () -> T): T =
    viewModel(key = "${T::class.java.name}:${System.identityHashCode(key)}", factory = viewModelFactory { initializer { create() } })

@Composable fun PkwApp(graph: AppGraph, wallet: WalletLogin?, seekerWallet: gg.pixelkingdomwars.nativeclient.wallet.SeekerProofWallet? = null, links: PendingGameLinks = remember { PendingGameLinks() }, onExit: () -> Unit) {
    val navController = rememberNavController()
    val account by graph.account.state.collectAsState()
    // Scene-transitions spec §4 step 5 / §7 privacy: signing out removes that account's postcards (memory and disk).
    var postcardWallet by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(account.phase, account.wallet) {
        if (account.phase == gg.pixelkingdomwars.nativeclient.data.AccountPhase.SIGNED_IN && account.wallet != null) postcardWallet = account.wallet
        else if (account.phase == gg.pixelkingdomwars.nativeclient.data.AccountPhase.SIGNED_OUT) {
            postcardWallet?.let(gg.pixelkingdomwars.nativeclient.scene.ScenePostcards::forget); postcardWallet = null
        }
    }
    val content by graph.content.state.collectAsState()
    val session by graph.sessionGraph.collectAsState()
    val context = LocalContext.current
    val defenceNotices = remember(session, graph.origin) {
        val preferences = context.applicationContext.getSharedPreferences(storageNamespace(graph.origin, "defences-seen"), android.content.Context.MODE_PRIVATE)
        DefenceNotices({ key -> preferences.getString(key, null) }, { key, at -> check(preferences.edit().putString(key, at).commit()) })
    }
    val identity by graph.holder.session.collectAsState()
    val pendingLink by links.pending.collectAsState()
    LaunchedEffect(account, identity, pendingLink) { links.observeIdentity(graph.account.state.value, graph.holder.current) }
    val boot = graphViewModel(graph) { BootViewModel(graph) }
    val bootBusy by boot.busy.collectAsState()
    val gates = graphViewModel(graph) { GateViewModel(graph) }
    val bootCheck by graph.bootUpdates.check.collectAsState()
    val bootLater by graph.bootUpdates.later.collectAsState()
    val bootReleased by graph.bootUpdates.released.collectAsState()
    val updateState by graph.updates.state.collectAsState()
    val updateMandatory by graph.updates.isMandatoryBlocking.collectAsState()
    // Owner 2026-09-27: the launch's update gate, decided from this frame's state so the route and the gate always agree.
    val bootUpdate = graph.bootUpdates.decide(bootCheck, updateState, updateMandatory, content.error != null && !content.ready, content.simVersion, bootLater, bootReleased)
    val destination = bootDestination(graph.mode, content.ready, content.error, account.phase, account.busy, bootUpdate)
    // Optimized local test APKs are non-debuggable but must still disclose their server.
    val local = graph.origin != "https://play.pixelkingdomwars.com"
    var gate by remember { mutableStateOf<Gate?>(null) }
    val gateScope = rememberCoroutineScope()
    val entry by navController.currentBackStackEntryAsState()
    // hub SPEC §3.2: an error toast's "Report" opens the designed Feedback card prefilled with the toast's sentence. Bound
    // only while a session exists (Feedback needs one), the navigation graph has a screen to navigate from, and no fight,
    // replay or scout is on top (a toast must never leave a battle past its own exit); unbound, the layer draws no Report.
    val toastReportOpen = entry?.destination?.let { !(it.hasRoute<BattleRoute>() || it.hasRoute<ReplayRoute>() ||
        it.hasRoute<WatchRoute>() || it.hasRoute<ScoutRoute>()) } == true
    DisposableEffect(session, navController, toastReportOpen) {
        val live = session?.takeIf { toastReportOpen }
        val binding = live?.let { s -> gg.pixelkingdomwars.nativeclient.ui.chrome.ToastDoors.bindReport { message ->
            gg.pixelkingdomwars.nativeclient.ui.chrome.prefillToastReport(s.feedback.drafts, message,
                gg.pixelkingdomwars.nativeclient.data.FeedbackBounds.from(graph.content.state.value.catalogue)?.categories.orEmpty())
            navController.navigate(FeedbackRoute) { launchSingleTop = true }; true } }
        onDispose { binding?.close() }
    }
    var homeAudioScreen by remember(session) { mutableStateOf("base") }
    // Canonical audio screen keys also select deterministic ambience variants.
    val audio = gg.pixelkingdomwars.nativeclient.ui.rememberNativeAudioExperience(graph, when {
        entry?.destination?.let { it.hasRoute<BattleRoute>() || it.hasRoute<ReplayRoute>() || it.hasRoute<WatchRoute>() } == true -> "battle"
        entry?.destination?.hasRoute<ScoutRoute>() == true -> "scout"
        entry?.destination?.hasRoute<HomeRoute>() == true -> homeAudioScreen
        else -> "world"
    })
    val sensory=gg.pixelkingdomwars.nativeclient.ui.rememberNativeSensoryExperience(graph)
    val linkLifecycle = LocalLifecycleOwner.current.lifecycle
    val linkLifecycleState by linkLifecycle.currentStateFlow.collectAsState()
    DisposableEffect(graph, links, navController, linkLifecycle) {
        val probe: () -> GameLinkScreen? = {
            val top = navController.currentBackStackEntry
            val shown = graph.sessionGraph.value
            val current = graph.account.state.value
            if (linkLifecycle.currentState != Lifecycle.State.RESUMED || top?.lifecycle?.currentState != Lifecycle.State.RESUMED ||
                shown == null || shown.session !== graph.holder.current || current.session !== shown.session ||
                current.selectedBaseId == null || shown.base.state.value.base?.baseId != current.selectedBaseId) null
            else when {
                top.destination.hasRoute<RaidLogRoute>() -> GameLinkScreen.RAIDLOG
                top.destination.hasRoute<MailRoute>() -> GameLinkScreen.MAIL
                top.destination.hasRoute<BasesRoute>() -> GameLinkScreen.BASES
                else -> null
            }
        }
        links.visibleScreen = probe
        onDispose { if (links.visibleScreen === probe) links.visibleScreen = { null } }
    }
    val visibleEntryState = entry?.lifecycle?.currentStateFlow?.collectAsState()?.value
    LaunchedEffect(pendingLink, account, identity, entry, linkLifecycleState, visibleEntryState) {
        links.acknowledgeVisible(graph.account.state.value, graph.holder.current, links.visibleScreen(),
            linkLifecycle.currentState == Lifecycle.State.RESUMED)
    }
    LaunchedEffect(destination) {
        when (destination) {
            BootDestination.HOME -> if (entry?.destination?.hasRoute<HomeRoute>() != true) navController.navigate(HomeRoute) { popUpTo(0) { inclusive = true } }
            BootDestination.TITLE -> navController.navigate(TitleRoute) { popUpTo(0) { inclusive = true } }
            BootDestination.ALPHA -> { gate = null; navController.navigate(AdmissionRoute) { popUpTo(0) { inclusive = true } } }
            BootDestination.TOTP -> navController.navigate(TotpRoute) { popUpTo(0) { inclusive = true } }
            BootDestination.PREVIEW -> navController.navigate(PreviewRoute) { popUpTo(0) { inclusive = true } }
            BootDestination.LOADING, BootDestination.CONTENT_FAILED, BootDestination.UPDATE_REQUIRED, BootDestination.UPDATE_AVAILABLE ->
                if (entry?.destination?.hasRoute<BootRoute>() != true) navController.navigate(BootRoute) { popUpTo(0) { inclusive = true } }
        }
    }
    // The update gate decides this launch's entry only: the first screen past the boot route releases it, and later offers
    // use the Title/Home chrome. Each decision, or a new offer under it, is acted on once (a required update starts itself).
    LaunchedEffect(destination, bootUpdate, updateState.offer) { graph.bootUpdates.onFrame(destination, bootUpdate, updateState.offer) }
    val battleFlow = remember(session) { session?.battle?.state }
    val battle = battleFlow?.collectAsState()?.value
    LaunchedEffect(battle?.battleVisible, battle?.replay, battle?.preview, battle?.spectator, destination, entry?.destination?.route) {
        if (destination != BootDestination.HOME) return@LaunchedEffect
        val onBattle = entry?.destination?.hasRoute<BattleRoute>() == true
        val onReplay = entry?.destination?.hasRoute<ReplayRoute>() == true
        val onScout = entry?.destination?.hasRoute<ScoutRoute>() == true
        val onWatch = entry?.destination?.hasRoute<WatchRoute>() == true
        val visible = battle?.battleVisible == true
        when {
            visible && !onBattle -> navController.navigate(BattleRoute) {
                if (onScout) popUpTo<ScoutRoute> { inclusive = true }
                launchSingleTop = true
            }
            !visible && battle?.spectator != null && !onWatch -> navController.navigate(WatchRoute) { launchSingleTop = true }
            !visible && battle?.spectator == null && battle?.replay != null && !onReplay -> navController.navigate(ReplayRoute) { launchSingleTop = true }
            !visible && battle?.spectator == null && battle?.replay == null && battle?.preview != null && !onScout -> navController.navigate(ScoutRoute) { launchSingleTop = true }
            !visible && battle?.spectator == null && battle?.replay == null && battle?.preview == null && onBattle -> {
                if (graph.homeRequests.pending.value == null) graph.homeRequests.request(HomeRequest.Tab(HomeTab.KINGDOM))
                navController.navigate(HomeRoute) { popUpTo(0) { inclusive = true }; launchSingleTop = true }
            }
            !visible && battle?.spectator == null && battle?.replay == null && battle?.preview == null && (onReplay || onScout || onWatch) -> navController.popBackStack()
        }
    }
    LaunchedEffect(graph.routing) {
        graph.routing.events.collect { event ->
            when (event) {
                // Web: the 402 prompt never opens over the title or the entry screen itself.
                RoutingEvent.LandRequired -> if (session != null && entry?.destination?.hasRoute<LandGateRoute>() != true) navController.navigate(LandGateRoute(reason = "refused")) { launchSingleTop = true }
                // The server moved past this build: ask for the offer again (tolerantly), so the dialog can lead to it.
                is RoutingEvent.UpdateRequired -> { gate = Gate.Update(event.message); graph.bootUpdates.onServerMovedOn() }
                is RoutingEvent.Incompatible -> { gate = Gate.Update("The server response for ${event.route} needs a newer native app."); graph.bootUpdates.onServerMovedOn() }
                is RoutingEvent.Maintenance -> gate = Gate.Maintenance(event.message)
                RoutingEvent.AlphaGated -> if (graph.account.state.value.phase != AccountPhase.ALPHA) gate = Gate.Alpha
                is RoutingEvent.InsufficientFunds -> gate = Gate.Funds(event.code, event.message)
                // Web `recoverBaseAuthority`: a transient verification failure only asks for a retry; confirmed loss
                // leaves any battle or scout WITHOUT submitting FINISH (the saved intent stays) and goes to choose a base.
                is RoutingEvent.BaseAuthority -> if (event.transient) gate = Gate.Info(Copy.LAND_VERIFICATION_UNAVAILABLE) else {
                    session?.battle?.leaveBattleView()
                    if (entry?.destination?.hasRoute<BasesRoute>() != true) navController.navigate(BasesRoute(notice = if (event.code == RoutingEvent.BaseAuthority.BASE_CLIENT_UPGRADE_REQUIRED) Copy.EXPLICIT_SELECTION else Copy.DEED_CHANGED)) { launchSingleTop = true }
                }
                RoutingEvent.SessionExpired -> {} // The graph discards the session; the destination change routes to Title.
            }
        }
    }
    CompositionLocalProvider(LocalBackRegistry provides graph.back, gg.pixelkingdomwars.nativeclient.ui.LocalNativeAudio provides audio, gg.pixelkingdomwars.nativeclient.ui.LocalNativeSensory provides sensory,
        gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.LocalPackArt provides remember(content.assets, content.manifest) { gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.packArtSource(content.assets, content.manifest) }) {
        // N-C5 GAMEPLAY-UI-A: the four fleet command owners live above the Home/Bases split; Home's pane shows ONE at a time.
        gg.pixelkingdomwars.nativeclient.ui.home.HomePassportScope(graph, session) {
        gg.pixelkingdomwars.nativeclient.ui.economy.FleetCommandScope(graph, session, wallet,
            ordinaryRouteVisible = entry?.destination?.hasRoute<StarterExpeditionRoute>() == true,
            onOpened = {
                if (navController.currentBackStackEntry?.destination?.hasRoute<HomeRoute>() != true) navController.navigate(HomeRoute) { launchSingleTop = true; popUpTo<HomeRoute>() }
                graph.homeRequests.request(HomeRequest.Tab(HomeTab.KINGDOM))
            },
            onStarterFleet = { navController.navigate(StarterFleetRoute) { launchSingleTop = true } }) { fleet ->
        NavHost(navController, startDestination = BootRoute, modifier = Modifier.fillMaxSize()) {
            // The designed boot gate (hub loading/update frames): the D-193 strip stays the loading surface, and the update
            // decisions arrive as the designed gate card over it (BootGate.kt).
            composable<BootRoute> { gg.pixelkingdomwars.nativeclient.ui.boot.BootGateScreen(graph, destination, content.error, bootBusy) { boot.start() } }
            composable<PreviewRoute> {
                val preview = graphViewModel(graph) { PreviewViewModel(graph) }
                PreviewScreen(preview)
            }
            composable<TitleRoute> { TitleScreen(graphViewModel(graph) { TitleViewModel(graph) }, wallet, graph.origin, local, onAbout = { navController.navigate(AboutRoute) { launchSingleTop = true } },
                onClaimDeed = session?.let { { navController.navigate(BaseClaimRoute) { launchSingleTop = true } } }) }
            composable<AdmissionRoute> {
                val pending = account.admission ?: return@composable
                val repository = remember(pending) { graph.admissionSeeker(pending) }
                gg.pixelkingdomwars.nativeclient.ui.profile.AdmissionSeekerScreen(repository, seekerWallet, pending.wallet,
                    gg.pixelkingdomwars.nativeclient.data.SeekerBounds.from(content.catalogue), { gates.signOut(wallet) }, onExit)
            }
            composable<TotpRoute> { TotpScreen(graphViewModel(graph) { TitleViewModel(graph) }, wallet,
                onRecovery = { navController.navigate(SecurityRoute) { launchSingleTop = true } }) }
            composable<LandGateRoute> { backStack ->
                val current = session ?: return@composable
                val route = backStack.toRoute<LandGateRoute>()
                val pendingResearch by current.observer.interrupted.collectAsState()
                var researchRecoveryError by remember(current) { mutableStateOf<String?>(null) }
                LaunchedEffect(current) { researchRecoveryError = refreshResearchRecoveryEntry(current.observer, current.session.wallet) }
                // Only the wallet app signs; the MWA association is bound to the current account identity.
                val signer = wallet?.let { w -> remember(current, w) { graph.landWallet(current, w) } }
                LandGateScreen(graphViewModel(current) { LandViewModel(graph, current) }, route.reason, route.kind, signer, local,
                    onBack = { if (!navController.popBackStack()) navController.navigate(HomeRoute) { popUpTo(0) { inclusive = true } } },
                    onSignedOut = { gates.releaseCredentials(wallet, current.session.wallet) }, onExit = onExit,
                    researchRecoveryError = researchRecoveryError,
                    onResearchPayment = if (researchRecoveryError != null || pendingResearch.any { it.kind == gg.pixelkingdomwars.nativeclient.ops.IntentKind.RESEARCH && it.intent.wallet == current.session.wallet })
                        ({ navController.navigate(ResearchRoute) { launchSingleTop = true } }) else null,
                    onTrainingPayment = if (researchRecoveryError != null || pendingResearch.any { it.kind == gg.pixelkingdomwars.nativeclient.ops.IntentKind.TRAINING_FINISH && it.intent.wallet == current.session.wallet })
                        ({ navController.navigate(TrainingPaymentRoute) { launchSingleTop = true } }) else null,
                    onBuilderPayment = if (researchRecoveryError != null || pendingResearch.any { it.kind == gg.pixelkingdomwars.nativeclient.ops.IntentKind.CONSTRUCTION && it.intent.wallet == current.session.wallet && gg.pixelkingdomwars.nativeclient.ops.ConstructionSpec.modernBuilder(it.intent) })
                        ({ navController.navigate(BuilderPaymentRoute) { launchSingleTop = true } }) else null,
                    onClaimDeed = { navController.navigate(BaseClaimRoute) { launchSingleTop = true } },
                    onFaucet = if (graph.cluster == gg.pixelkingdomwars.nativeclient.wallet.SolanaCluster.DEVNET) ({ navController.navigate(FaucetRoute) }) else null,
                    // LAND is the single land/base entry: the base chooser hangs off it whenever there is a choice to make.
                    onBases = if (gg.pixelkingdomwars.nativeclient.ui.home.showBaseSwitch(account.directory?.bases?.size ?: 0, account.directory?.selectorAvailable == true, account.selectedBaseId))
                        ({ navController.navigate(BasesRoute()) { launchSingleTop = true } }) else null,
                    onChooseOnMap = gg.pixelkingdomwars.nativeclient.ui.world.rememberChooseOnMap(graph.homeRequests) { if (!navController.popBackStack<HomeRoute>(inclusive = false)) navController.navigate(HomeRoute) { popUpTo(0) { inclusive = true } } },
                    onSeeMap = {
                        graph.homeRequests.request(HomeRequest.World(gg.pixelkingdomwars.nativeclient.data.WorldEntry.MyDeeds))
                        if (!navController.popBackStack<HomeRoute>(inclusive = false)) navController.navigate(HomeRoute) { popUpTo(0) { inclusive = true } }
                    })
            }
            composable<BaseClaimRoute> { session?.let { current ->
                gg.pixelkingdomwars.nativeclient.ui.land.BaseClaimScreen(current.baseClaims,
                    onBack = { navController.popBackStack() },
                    onBases = { navController.navigate(BasesRoute()) { launchSingleTop = true } })
            } }
            composable<ScoutRoute>(enterTransition = sceneEnter, exitTransition = sceneExit, popEnterTransition = sceneEnter, popExitTransition = sceneExit) {
                val current = session ?: return@composable
                val model = graphViewModel(current) { BattleViewModel(graph, current) }
                val preview = battle?.preview ?: return@composable
                ScoutScreen(model, preview) { model.closePreview() }
            }
            composable<HomeRoute>(enterTransition = sceneEnter, exitTransition = sceneExit, popEnterTransition = sceneEnter, popExitTransition = sceneExit) {
                val current = session ?: return@composable
                HomeShell(graph, current, navController, local, links, gate == null, defenceNotices, onExit, fleet, wallet) { homeAudioScreen = it }
            }
            composable<RaidLogRoute> { session?.let { current ->
                val seenBase = current.base.state.collectAsState().value.base
                LaunchedEffect(current, seenBase?.baseId) { defenceNotices.markRead(seenBase?.baseId, seenBase?.raw, Instant.now()) }
                val closeHistory: () -> Unit = {
                    graph.homeRequests.request(HomeRequest.Tab(HomeTab.KINGDOM))
                    navController.navigate(HomeRoute) { popUpTo(0) { inclusive = true }; launchSingleTop = true }
                }
                BackHandlerAt(BackPriority.SCREEN, onBack = closeHistory)
                AttackScreen(graphViewModel(current) { AttackViewModel(graph, current) },
                    historyOnly = true, onBack = closeHistory)
            } }
            composable<BattleRoute>(enterTransition = sceneEnter, exitTransition = sceneExit, popEnterTransition = sceneEnter, popExitTransition = sceneExit) {
                val current = session ?: return@composable
                val coordinator = battle?.coordinator ?: return@composable
                val home = current.base.state.collectAsState().value
                LiveBattleScreen(graphViewModel(current) { BattleViewModel(graph, current) }, coordinator, home.base?.player?.keepLevel ?: 0,
                    BattleExits(onEnergy = { kind, baseId ->
                        navController.navigate(BasePurchaseRoute(kind, baseId)) { popUpTo<BattleRoute> { inclusive = true }; launchSingleTop = true }
                    }, onLand = { navController.navigate(LandGateRoute(reason = "browse")) { launchSingleTop = true } }),
                    onboarding = home.tutorial?.onboarding?.templateCode == "first_raid",
                    // Scene-transitions spec §2: the opening shows the player's own base (its postcard) dimmed, never a dark plate.
                    postcardAccount = gg.pixelkingdomwars.nativeclient.scene.ScenePostcards.accountKey(current.session.wallet))
            }
            composable<WatchRoute>(enterTransition = sceneEnter, exitTransition = sceneExit, popEnterTransition = sceneEnter, popExitTransition = sceneExit) {
                val current = session ?: return@composable
                val view = battle?.spectator ?: return@composable
                SpectatorBattleScreen(graphViewModel(current) { BattleViewModel(graph, current) }, view)
            }
            composable<BasesRoute> { backStack ->
                val current = session ?: return@composable
                val route = backStack.toRoute<BasesRoute>()
                // MS-UI3: a World door's Phase E activity (BasesRoute.launch) opens once its registration is up; kept outside
                // the registrations so an activity the player has closed never launches again on this entry.
                var pendingLaunch by androidx.compose.runtime.saveable.rememberSaveable(backStack.id) { mutableStateOf(route.launch) }
                val claimIdentity = homePresentationIdentity(account, current.session, graph.holder.current)
                val claimLifecycle = LocalLifecycleOwner.current.lifecycle
                val claimNavigationScope = rememberCoroutineScope()
                fun claimNavigation(open: () -> Unit) {
                    claimNavigationScope.launch {
                        // Let the wallet-details overlay retire its Back registration, then recheck every guard.
                        withFrameNanos { }
                        if (claimIdentity != null && graph.sessionGraph.value === current &&
                            homePresentationIdentity(graph.account.state.value, current.session, graph.holder.current) == claimIdentity &&
                            claimLifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED) &&
                            (graph.back.active()?.priority ?: BackPriority.HOME) <= BackPriority.SCREEN) open()
                        else gg.pixelkingdomwars.nativeclient.ui.chrome.Toasts.post("Close the current review before opening another destination.")
                    }
                }
                CompositionLocalProvider(gg.pixelkingdomwars.nativeclient.ui.goldforge.LocalGoldForgeClaimNavigation provides
                    gg.pixelkingdomwars.nativeclient.ui.goldforge.GoldForgeClaimNavigation(
                        onGoSmelt = { claimNavigation {
                            openGoldForgeHome(graph, current, navController, gg.pixelkingdomwars.nativeclient.ui.features.FeatureId("goldforge.smelt"))
                        } },
                        onGoSeeker = { claimNavigation {
                            graph.homeRequests.request(HomeRequest.Tab(HomeTab.WORLD))
                            if (!navController.popBackStack<HomeRoute>(inclusive = false)) navController.navigate(HomeRoute) {
                                popUpTo(0) { inclusive = true }; launchSingleTop = true
                            }
                            gg.pixelkingdomwars.nativeclient.ui.chrome.Toasts.post("Seeker Island is not available in this build.")
                        } },
                        onChangeWallet = { claimNavigation { navController.navigate(GoldForgeWalletControlsRoute) { launchSingleTop = true } } })) {
                gg.pixelkingdomwars.nativeclient.ui.phasee.PhaseERegistration(graph, current, wallet) {
                gg.pixelkingdomwars.nativeclient.ui.phasee.PhaseEPendingLaunch(gg.pixelkingdomwars.nativeclient.ui.phasee.phaseEActivityNamed(pendingLaunch)) { opened ->
                    if (!opened) gg.pixelkingdomwars.nativeclient.ui.chrome.Toasts.post(gg.pixelkingdomwars.nativeclient.ui.phasee.PHASE_E_NOT_OPEN_LINE, true)
                    pendingLaunch = null
                }
                BasesScreen(graphViewModel(current) { BasesViewModel(graph, current) }, route.notice,
                    onBack = { if (!navController.popBackStack()) navController.navigate(HomeRoute) { popUpTo(0) { inclusive = true } } },
                    onClaimDeed = { navController.navigate(BaseClaimRoute) { launchSingleTop = true } },
                    onBuyDeed = { kind -> navController.navigate(LandGateRoute(reason = "browse", kind = kind)) { launchSingleTop = true } })
                }
                }
            }
            composable<ReplayRoute>(enterTransition = sceneEnter, exitTransition = sceneExit, popEnterTransition = sceneEnter, popExitTransition = sceneExit) {
                val current = session ?: return@composable
                val model = graphViewModel(current) { BattleViewModel(graph, current) }
                val replay = battle?.replay?.raw ?: return@composable
                ReplayScreen(model, replay) { model.closeReplay() }
            }
            composable<ResearchRoute> { session?.let { s ->
                val raid by s.interlock.state.collectAsState()
                val model = graphViewModel(s) { ArmyViewModel(graph, s) }
                if (gg.pixelkingdomwars.nativeclient.ui.sheets.army.live.ArmyLive.ENABLED)
                    gg.pixelkingdomwars.nativeclient.ui.sheets.army.live.ResearchLiveHost(model, account.baseSelectionGeneration, raid.actionsAllowed,
                        onBack = { navController.popBackStack() },
                        onFocusBuilding = { id -> graph.homeRequests.request(HomeRequest.FocusBuilding(id)); navController.popBackStack() },
                        onNeedMore = { price ->
                            openGoldForgeHome(graph, s, navController, gg.pixelkingdomwars.nativeclient.ui.features.FeatureId(
                                if (price.currency == gg.pixelkingdomwars.nativeclient.ui.model.Currency.GEMS) "goldforge.gems" else "goldforge.open"))
                        },
                        legacy = { done -> ResearchScreen(model, account.baseSelectionGeneration, raid.actionsAllowed, onBack = done) })
                else ResearchScreen(model, account.baseSelectionGeneration, raid.actionsAllowed) { navController.popBackStack() }
            } }
            composable<BuilderPaymentRoute> { session?.let { s ->
                gg.pixelkingdomwars.nativeclient.ui.kingdom.BuilderPaymentScreen(graphViewModel(s) { KingdomViewModel(graph, s, recoveryOnly = true) }) { navController.popBackStack() }
            } }
            composable<TrainingPaymentRoute> { session?.let { s ->
                val raid by s.interlock.state.collectAsState()
                ArmyScreen(graphViewModel(s) { ArmyViewModel(graph, s) }, graph.keepConfirm, graph.homeRequests,
                    onBack = { navController.popBackStack() }, baseGeneration = account.baseSelectionGeneration,
                    actionsAllowed = raid.actionsAllowed, recoveryOnly = true, onOpenResearch = {})
            } }
            // Recruiting a hero = placing its altar in the build tray (web sheets.tsx BUILD ▸ HEROES): the request survives the hand-off to Kingdom.
            composable<HeroesRoute> { entry -> session?.let { s ->
                val requestedHero = entry.toRoute<HeroesRoute>().hero
                val model = graphViewModel(s) { RosterViewModel(graph, s) }
                val recruit = { graph.homeRequests.request(HomeRequest.HeroBuildMenu); navController.popBackStack(); Unit }
                if (gg.pixelkingdomwars.nativeclient.ui.sheets.army.live.ArmyLive.ENABLED)
                    gg.pixelkingdomwars.nativeclient.ui.sheets.army.live.HeroesLiveHost(model, initialHero = requestedHero,
                        onBack = { navController.popBackStack() }, onRecruit = recruit,
                        onOpenGear = { navController.navigate(InventoryRoute) { launchSingleTop = true } },
                        onNeedMore = { price ->
                            openGoldForgeHome(graph, s, navController, gg.pixelkingdomwars.nativeclient.ui.features.FeatureId(
                                if (price.currency == gg.pixelkingdomwars.nativeclient.ui.model.Currency.GEMS) "goldforge.gems" else "goldforge.open"))
                        },
                        legacy = { done -> HeroesScreen(model, graph.keepConfirm, onBack = done, onRecruit = recruit) })
                else HeroesScreen(model, graph.keepConfirm, onBack = { navController.popBackStack() }, onRecruit = recruit)
            } }
            composable<InventoryRoute> { session?.let { s -> InventoryScreen(graphViewModel(s) { RosterViewModel(graph, s) }, onBack = { navController.popBackStack() },
                onOpenShop = { navController.navigate(ShopRoute) },
                onPlaceAltar = { graph.homeRequests.request(HomeRequest.HeroBuildMenu); navController.popBackStack() },
                onSell = { navController.navigate(MarketRoute(it)) },
                onViewDeeds = { graph.homeRequests.request(HomeRequest.World(gg.pixelkingdomwars.nativeclient.data.WorldEntry.MyDeeds)); navController.popBackStack() }) } }
            composable<ShopRoute> { session?.let { s ->
                val suppliesBase = account.selectedBaseId
                val suppliesGeneration = account.baseSelectionGeneration
                fun suppliesHome(request: HomeRequest) {
                    graph.homeRequests.request(request)
                    if (!navController.popBackStack<HomeRoute>(inclusive = false)) navController.navigate(HomeRoute) { launchSingleTop = true }
                }
                gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live.LiveTallSheetHost(onScrimTap = { navController.popBackStack() }) { placed ->
                    gg.pixelkingdomwars.nativeclient.ui.sheets.account.live.SuppliesHomeBody(
                        model = graphViewModel(s) { RosterViewModel(graph, s) }, wallet = s.session.wallet, baseId = suppliesBase,
                        isCurrent = { graph.sessionGraph.value === s && graph.holder.current === s.session &&
                            graph.account.state.value.selectedBaseId == suppliesBase && graph.account.state.value.baseSelectionGeneration == suppliesGeneration },
                        onPurchase = { kind, baseId -> navController.navigate(BasePurchaseRoute(kind, baseId)) },
                        onBuilders = { suppliesHome(HomeRequest.Builders) },
                        onTab = { id -> when (id) {
                            "BUILDINGS", "DEFENCES", "TRAPS" -> suppliesHome(HomeRequest.BuildCategory(id))
                            "HEROES" -> suppliesHome(HomeRequest.HeroBuildMenu)
                            "LAYOUTS" -> suppliesHome(HomeRequest.BaseTool(gg.pixelkingdomwars.nativeclient.ui.home.HomeBaseTool.LAYOUT))
                            else -> Unit
                        } },
                        onClose = { navController.popBackStack() }, onEconomy = { navController.navigate(EconomyRoute) },
                        onCodex = { navController.navigate(CodexRoute) },
                        tabs = gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live.liveBuildTrayTabs(), modifier = placed,
                        keepConfirm = graph.keepConfirm)
                }
            } }
            composable<FaucetRoute> { session?.let { s -> gg.pixelkingdomwars.nativeclient.ui.economy.FaucetScreen(s.faucet) { navController.popBackStack() } } }
            // The SKR faucet as the designed HALF sheet (the standalone Profile's DAILY TEST SKR row; Home hosts it in place).
            composable<SkrFaucetRoute> { session?.let { s ->
                gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live.LiveHalfSheetHost(Modifier.windowInsetsPadding(WindowInsets.safeDrawing)) { placed ->
                    gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live.SkrFaucetHost(graph, s, onClose = { navController.popBackStack() },
                        onGetLand = { navController.navigate(LandGateRoute(reason = "browse", kind = "entry")) { launchSingleTop = true } },
                        onGoSeeker = { graph.homeRequests.request(HomeRequest.World(gg.pixelkingdomwars.nativeclient.data.WorldEntry.SeekerIsland)); navController.popBackStack() },
                        modifier = placed, wallet = wallet)
                }
            } }
            composable<GemsRoute> { session?.let { s ->
                gg.pixelkingdomwars.nativeclient.ui.economy.GemsScreen(graphViewModel(s) { gg.pixelkingdomwars.nativeclient.ui.economy.GemsViewModel(s.gems) },
                    s.session.wallet, account.baseSelectionGeneration, s.gemsBuy.state.collectAsState().value.saved != null,
                    onWalletPurchase = { openGoldForgeHome(graph, s, navController, gg.pixelkingdomwars.nativeclient.ui.features.FeatureId("goldforge.gems")) }) { navController.popBackStack() }
            } }
            composable<GemsBuyRoute> { session?.let { s ->
                val sender = remember(s, wallet) { graph.gemsBuyWallet(s, wallet) }
                gg.pixelkingdomwars.nativeclient.ui.economy.GemsBuyScreen(graphViewModel(s) {
                    gg.pixelkingdomwars.nativeclient.ui.economy.GemsBuyViewModel(s.gemsBuy, s.gemsBuyPayment::prepare, s.gemsBuyBalances::refresh)
                }, sender, s.gemsBuyBalances, s.session.wallet, graph.cluster.label,
                    gg.pixelkingdomwars.nativeclient.data.KeepDepositBounds.from(content.catalogue),
                    onClaim = { openGoldForgeHome(graph, s, navController, gg.pixelkingdomwars.nativeclient.ui.features.FeatureId("goldforge.claim")) },
                    onConvert = { navController.navigate(GemsRoute) { launchSingleTop = true } }) { navController.popBackStack() }
            } }
            composable<WorkshopRoute> { session?.let { s ->
                val loaded = remember(s) { runCatching { s.workshop } }
                val repository = loaded.getOrNull()
                if (repository == null) gg.pixelkingdomwars.nativeclient.ui.chrome.DesignedPage("WORKSHOP RECOVERY", { navController.popBackStack() }) {
                    Text("Saved Workshop recovery could not be opened. Keep this app's data; no request was sent or replaced.")
                    Text("Reopen after storage is available. ${loaded.exceptionOrNull()?.message ?: "Recovery storage is unavailable."}")
                } else {
                    val raid by s.interlock.state.collectAsState()
                    val workshopSelectedBase = account.selectedBaseId
                    val workshopSelectionGeneration = account.baseSelectionGeneration
                    val toolsLifecycle = LocalLifecycleOwner.current.lifecycle
                    val workshopLevel = gg.pixelkingdomwars.nativeclient.ui.home.homeWorkshopLevel(s.base.state.collectAsState().value.base, workshopSelectedBase.orEmpty())
                    androidx.compose.runtime.CompositionLocalProvider(
                        gg.pixelkingdomwars.nativeclient.ui.sheets.craft.LocalWorkshopOwnerHost provides
                            gg.pixelkingdomwars.nativeclient.ui.sheets.craft.WorkshopOwnerHost("INGOTS",
                                onTab = { selected -> if (selected == "REFINE" || selected == "COSMETICS") {
                                    if (graph.sessionGraph.value === s && graph.holder.current === s.session &&
                                        graph.account.state.value.selectedBaseId == workshopSelectedBase &&
                                        graph.account.state.value.baseSelectionGeneration == workshopSelectionGeneration &&
                                        toolsLifecycle.currentState.isAtLeast(Lifecycle.State.STARTED) &&
                                        navController.currentBackStackEntry?.destination?.hasRoute<WorkshopRoute>() == true &&
                                        repository.state.value.review == null && !repository.state.value.busy &&
                                        (graph.back.active()?.priority ?: BackPriority.HOME) <= BackPriority.SHEET)
                                        navController.navigate(OrdinaryCraftingRoute(selected)) {
                                            popUpTo<WorkshopRoute> { inclusive = true }; launchSingleTop = true }
                                    else gg.pixelkingdomwars.nativeclient.ui.chrome.Toasts.post("Finish the current review or reopen this Workshop before changing tabs.")
                                    }
                                    else if (selected == "EQUIPMENT") {
                                        if (graph.sessionGraph.value === s && graph.holder.current === s.session &&
                                            graph.account.state.value.selectedBaseId == workshopSelectedBase &&
                                            graph.account.state.value.baseSelectionGeneration == workshopSelectionGeneration &&
                                            toolsLifecycle.currentState.isAtLeast(Lifecycle.State.STARTED) &&
                                            repository.state.value.review == null && !repository.state.value.busy &&
                                            (graph.back.active()?.priority ?: BackPriority.HOME) <= BackPriority.SHEET &&
                                            fleet?.owners?.any { it.destination == gg.pixelkingdomwars.nativeclient.ui.economy.FleetCommandDestination.EQUIPMENT && it.available } == true)
                                            fleet?.open(gg.pixelkingdomwars.nativeclient.ui.economy.FleetCommandDestination.EQUIPMENT)
                                        else gg.pixelkingdomwars.nativeclient.ui.chrome.Toasts.post("Tools are waiting for the current Workshop. Try again.")
                                    } },
                                onClose = { navController.popBackStack() }, current = { graph.sessionGraph.value === s &&
                                    graph.account.state.value.selectedBaseId == workshopSelectedBase &&
                                    graph.account.state.value.baseSelectionGeneration == workshopSelectionGeneration },
                                headerTier = gg.pixelkingdomwars.nativeclient.ui.sheets.craft.live.craftBuildingArtTier(content.catalogue, workshopLevel),
                                titleTag = workshopLevel?.let { "LV $it" })) {
                    gg.pixelkingdomwars.nativeclient.ui.economy.WorkshopScreen(graphViewModel(s) { gg.pixelkingdomwars.nativeclient.ui.economy.WorkshopViewModel(repository) },
                        s.session.wallet, account.selectedBaseId, account.baseSelectionGeneration,
                        content.allowsGameOrders(graph.versionCode) && raid.actionsAllowed) { navController.popBackStack() }
                    }
                }
            } }
            composable<OrdinaryCraftingRoute> { ordinaryEntry -> session?.let { s ->
                val ordinaryTab = ordinaryEntry.toRoute<OrdinaryCraftingRoute>().ownerTab
                val materials = remember(s) { runCatching { s.ordinaryCrafting }.getOrNull() }
                val awnings = remember(s) { runCatching { s.boundCosmeticWorkshop }.getOrNull() }
                val wake = remember(s) { runCatching { s.boundCosmeticWakeWorkshop }.getOrNull() }
                val raid by s.interlock.state.collectAsState()
                val artGeneration by s.boundCosmeticArtGeneration.collectAsState()
                val selectedBase = account.selectedBaseId
                val selectionGeneration = account.baseSelectionGeneration
                val toolsLifecycle = LocalLifecycleOwner.current.lifecycle
                val workshopLevel = gg.pixelkingdomwars.nativeclient.ui.home.homeWorkshopLevel(s.base.state.collectAsState().value.base, selectedBase.orEmpty())
                androidx.compose.runtime.CompositionLocalProvider(
                    gg.pixelkingdomwars.nativeclient.ui.sheets.craft.LocalWorkshopOwnerHost provides
                        gg.pixelkingdomwars.nativeclient.ui.sheets.craft.WorkshopOwnerHost(ordinaryTab,
                            onTab = { selected -> if (selected == "INGOTS") navController.navigate(WorkshopRoute) {
                                popUpTo<OrdinaryCraftingRoute> { inclusive = true }; launchSingleTop = true }
                                else if (selected == "EQUIPMENT") {
                                    if (graph.sessionGraph.value === s && graph.holder.current === s.session &&
                                        graph.account.state.value.selectedBaseId == selectedBase &&
                                        graph.account.state.value.baseSelectionGeneration == selectionGeneration &&
                                        toolsLifecycle.currentState.isAtLeast(Lifecycle.State.STARTED) &&
                                        materials?.state?.value?.review == null && materials?.state?.value?.busy != true &&
                                        (graph.back.active()?.priority ?: BackPriority.HOME) <= BackPriority.SHEET &&
                                        fleet?.owners?.any { it.destination == gg.pixelkingdomwars.nativeclient.ui.economy.FleetCommandDestination.EQUIPMENT && it.available } == true)
                                        fleet?.open(gg.pixelkingdomwars.nativeclient.ui.economy.FleetCommandDestination.EQUIPMENT)
                                    else gg.pixelkingdomwars.nativeclient.ui.chrome.Toasts.post("Tools are waiting for the current Workshop. Try again.")
                                } },
                            onClose = { navController.popBackStack() }, current = { graph.sessionGraph.value === s &&
                                graph.account.state.value.selectedBaseId == selectedBase &&
                                graph.account.state.value.baseSelectionGeneration == selectionGeneration },
                            headerTier = gg.pixelkingdomwars.nativeclient.ui.sheets.craft.live.craftBuildingArtTier(content.catalogue, workshopLevel),
                            titleTag = workshopLevel?.let { "LV $it" })) {
                gg.pixelkingdomwars.nativeclient.ui.economy.OrdinaryWorkshopScreen(
                    materials?.let { repository -> graphViewModel(s) { gg.pixelkingdomwars.nativeclient.ui.economy.OrdinaryCraftingViewModel(repository) } },
                    awnings?.let { repository -> graphViewModel(s) { gg.pixelkingdomwars.nativeclient.ui.economy.BoundCosmeticWorkshopViewModel(repository) } },
                    wake?.let { repository -> graphViewModel(s) { gg.pixelkingdomwars.nativeclient.ui.economy.BoundCosmeticWakeWorkshopViewModel(repository) } },
                    s.session.wallet, selectedBase, selectionGeneration,
                    content.allowsGameOrders(graph.versionCode) && raid.actionsAllowed, s.boundCosmeticArt, artGeneration, {
                        graph.holder.requireCurrent(s.session)
                        check(s.boundCosmeticArtGeneration.value == artGeneration) { "The verified appearance content changed." }
                        check(graph.account.state.value.selectedBaseId == selectedBase && graph.account.state.value.baseSelectionGeneration == selectionGeneration) {
                            "The selected kingdom changed. Reopen its verified appearance."
                        }
                    }, s.boundCosmeticWakeSourcePreview) { navController.popBackStack() }
                }
            } }
            composable<MiningContributionRoute> { session?.let { s ->
                val loaded = remember(s) { runCatching { s.miningContribution } }
                val repository = loaded.getOrNull()
                if (repository == null) gg.pixelkingdomwars.nativeclient.ui.chrome.DesignedPage("MINING CONTRIBUTION RECOVERY", { navController.popBackStack() }) {
                    Text("Saved mining contribution recovery could not be opened. Keep this app's data; no request was sent or replaced.")
                    Text("Reopen after storage is available. ${loaded.exceptionOrNull()?.message ?: "Recovery storage is unavailable."}")
                } else {
                    val raid by s.interlock.state.collectAsState()
                    gg.pixelkingdomwars.nativeclient.ui.economy.MiningContributionScreen(graphViewModel(s) {
                        gg.pixelkingdomwars.nativeclient.ui.economy.MiningContributionViewModel(repository)
                    }, s.session.wallet, account.selectedBaseId, account.baseSelectionGeneration,
                        content.allowsGameOrders(graph.versionCode) && raid.actionsAllowed,
                        onFindRaid = {
                            graph.homeRequests.request(HomeRequest.RaidChooser)
                            if (!navController.popBackStack<HomeRoute>(inclusive = false)) navController.navigate(HomeRoute) {
                                popUpTo(0) { inclusive = true }; launchSingleTop = true
                            }
                        }, onGoWorkshop = { navController.navigate(WorkshopRoute) { launchSingleTop = true } },
                        onGoBuild = {
                            graph.homeRequests.request(HomeRequest.BuildMenu)
                            if (!navController.popBackStack<HomeRoute>(inclusive = false)) navController.navigate(HomeRoute) {
                                popUpTo(0) { inclusive = true }; launchSingleTop = true
                            }
                        }) { navController.popBackStack() }
                }
            } }
            composable<StarterFleetRoute> { session?.let { s ->
                val loaded = remember(s) { runCatching { s.starterFleet } }
                val repository = loaded.getOrNull()
                if (repository == null) gg.pixelkingdomwars.nativeclient.ui.chrome.DesignedPage("STARTER FLEET RECOVERY", { navController.popBackStack() }) {
                    Text("Saved starter fleet recovery could not be opened. Keep this app's data; no request was sent or replaced.")
                    Text("Reopen after storage is available. ${loaded.exceptionOrNull()?.message ?: "Recovery storage is unavailable."}")
                } else {
                    val raid by s.interlock.state.collectAsState()
                    gg.pixelkingdomwars.nativeclient.ui.economy.StarterFleetScreen(graphViewModel(s) {
                        gg.pixelkingdomwars.nativeclient.ui.economy.StarterFleetViewModel(repository)
                    }, s.session.wallet, account.selectedBaseId, account.baseSelectionGeneration,
                        content.allowsGameOrders(graph.versionCode) && raid.actionsAllowed,
                        onExpeditions = { fleet?.open(gg.pixelkingdomwars.nativeclient.ui.economy.FleetCommandDestination.STARTER) ?: navController.navigate(StarterExpeditionRoute) { launchSingleTop = true } }) { navController.popBackStack() }
                }
            } }
            composable<StarterExpeditionRoute> { session?.let { s ->
                val loaded = remember(s) { runCatching { s.starterExpedition } }
                val repository = loaded.getOrNull()
                if (repository == null) gg.pixelkingdomwars.nativeclient.ui.chrome.DesignedPage("EXPEDITION RECOVERY", { navController.popBackStack() }) {
                    Text("Saved expedition recovery could not be opened. Keep this app's data; no request was sent or replaced.")
                    Text("Reopen after storage is available. ${loaded.exceptionOrNull()?.message ?: "Recovery storage is unavailable."}")
                } else {
                    val raid by s.interlock.state.collectAsState()
                    val starterModel = graphViewModel(s) { gg.pixelkingdomwars.nativeclient.ui.economy.StarterExpeditionViewModel(repository) }
                    // UI-R2: the retained standalone route is the visible ordinary driver here; admitted content-owner replacement retires its transient review.
                    LaunchedEffect(starterModel, content.manifest) { starterModel.dismiss() }
                    gg.pixelkingdomwars.nativeclient.ui.economy.StarterExpeditionScreen(starterModel, s.session.wallet, account.selectedBaseId, account.baseSelectionGeneration,
                        content.allowsGameOrders(graph.versionCode) && raid.actionsAllowed,
                        onFleet = { navController.navigate(StarterFleetRoute) { launchSingleTop = true } }) { navController.popBackStack() }
                }
            } }
            composable<HarvesterRoute> { session?.let { s ->
                val loaded = remember(s) { runCatching { s.harvester } }
                val repository = loaded.getOrNull()
                if (repository == null) gg.pixelkingdomwars.nativeclient.ui.chrome.DesignedPage("HARVESTER RECOVERY", { navController.popBackStack() }) {
                    Text("Saved Harvester recovery could not be opened. Keep this app's data; no request was sent or replaced.")
                    Text("Reopen after storage is available. ${loaded.exceptionOrNull()?.message ?: "Recovery storage is unavailable."}")
                } else {
                    val raid by s.interlock.state.collectAsState()
                    gg.pixelkingdomwars.nativeclient.ui.economy.HarvesterScreen(graphViewModel(s) {
                        gg.pixelkingdomwars.nativeclient.ui.economy.HarvesterViewModel(repository)
                    }, s.session.wallet, account.selectedBaseId, account.baseSelectionGeneration,
                        content.allowsGameOrders(graph.versionCode) && raid.actionsAllowed) { navController.popBackStack() }
                }
            } }
            composable<EconomyRoute> { economyEntry -> session?.let { s ->
                val economyLifecycle = LocalLifecycleOwner.current.lifecycle
                val economyIdentity = homePresentationIdentity(account, s.session, graph.holder.current)
                    .takeIf { graph.sessionGraph.value === s }
                val economyIdentityCurrent = { graph.sessionGraph.value === s && economyIdentity != null &&
                    homePresentationIdentity(graph.account.state.value, s.session, graph.holder.current) == economyIdentity }
                val fleetRead = remember(s, economyIdentity) { economyIdentity?.let { gg.pixelkingdomwars.nativeclient.ui.home.HomeEconomyReadCapture<gg.pixelkingdomwars.nativeclient.data.StarterFleetState>(it) } }
                val expeditionRead = remember(s, economyIdentity) { economyIdentity?.let { gg.pixelkingdomwars.nativeclient.ui.home.HomeEconomyReadCapture<gg.pixelkingdomwars.nativeclient.data.StarterExpeditionState>(it) } }
                val harvesterRead = remember(s, economyIdentity) { economyIdentity?.let { gg.pixelkingdomwars.nativeclient.ui.home.HomeEconomyReadCapture<gg.pixelkingdomwars.nativeclient.data.HarvesterState>(it) } }
                val workshopRead = remember(s, economyIdentity) { economyIdentity?.let { gg.pixelkingdomwars.nativeclient.ui.home.HomeEconomyReadCapture<gg.pixelkingdomwars.nativeclient.data.WorkshopState>(it) } }
                val ordinary = remember(s) { runCatching { s.ordinaryCrafting } }
                val ordinaryRepository = ordinary.getOrNull()
                val ordinaryState = ordinaryRepository?.state?.collectAsState()?.value
                val ordinaryLifecycle = LocalLifecycleOwner.current.lifecycle
                LaunchedEffect(ordinaryRepository, ordinaryLifecycle, account.baseSelectionGeneration) {
                    ordinaryLifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
                        try { ordinaryRepository?.awaitIdle(); ordinaryRepository?.refresh() }
                        catch (cancelled: CancellationException) { throw cancelled }
                        catch (_: Exception) { /* Discovery stays dark; saved history remains reachable. */ }
                        kotlinx.coroutines.awaitCancellation()
                    }
                }
                val awnings = remember(s) { runCatching { s.boundCosmeticWorkshop } }
                val awningRepository = awnings.getOrNull()
                val awningState = awningRepository?.state?.collectAsState()?.value
                val awningArtGeneration by s.boundCosmeticArtGeneration.collectAsState()
                LaunchedEffect(awningRepository, ordinaryLifecycle, account.baseSelectionGeneration, awningArtGeneration) {
                    ordinaryLifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
                        try { awningRepository?.awaitIdle(); awningRepository?.refresh() }
                        catch (cancelled: CancellationException) { throw cancelled }
                        catch (_: Exception) { /* Original recovery remains reachable if current discovery fails. */ }
                        kotlinx.coroutines.awaitCancellation()
                    }
                }
                val wake = remember(s) { runCatching { s.boundCosmeticWakeWorkshop } }
                val wakeRepository = wake.getOrNull()
                val wakeState = wakeRepository?.state?.collectAsState()?.value
                LaunchedEffect(wakeRepository, ordinaryLifecycle, account.baseSelectionGeneration) {
                    ordinaryLifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
                        try { wakeRepository?.awaitIdle(); wakeRepository?.refresh() }
                        catch (cancelled: CancellationException) { throw cancelled }
                        catch (_: Exception) { /* Saved account recovery remains available independently. */ }
                        kotlinx.coroutines.awaitCancellation()
                    }
                }
                val ordinaryAvailable = gg.pixelkingdomwars.nativeclient.ui.economy.ordinaryCraftingEntryAvailable(ordinaryState, ordinary.isFailure) ||
                    gg.pixelkingdomwars.nativeclient.ui.economy.boundCosmeticWorkshopEntryAvailable(awningState, awnings.isFailure) ||
                    gg.pixelkingdomwars.nativeclient.ui.economy.wakeWorkshopEntryAvailable(wakeState, wake.isFailure)
                val starterFleet = remember(s) { runCatching { s.starterFleet } }
                val starterFleetRepository = starterFleet.getOrNull()
                val starterFleetState = starterFleetRepository?.state?.collectAsState()?.value
                val starterFleetLifecycle = LocalLifecycleOwner.current.lifecycle
                LaunchedEffect(starterFleetRepository, starterFleetLifecycle, economyIdentity) {
                    starterFleetLifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
                        try {
                            try {
                                val repository = starterFleetRepository
                                if (repository != null) {
                                    val read = suspend {
                                        repository.awaitIdle()
                                        check(repository.state.value.review == null) { "Finish the existing review first." }
                                        repository.refresh(waitForIdle = true)
                                        repository.state.value
                                    }
                                    if (fleetRead != null) fleetRead.refresh(economyIdentityCurrent, read) else read()
                                }
                            } catch (cancelled: CancellationException) { throw cancelled }
                            catch (_: Exception) { /* No fresh admission; legacy original recovery stays reachable. */ }
                            kotlinx.coroutines.awaitCancellation()
                        } finally { fleetRead?.clear() }
                    }
                }
                val starterFleetAvailable = gg.pixelkingdomwars.nativeclient.ui.economy.starterFleetEntryAvailable(starterFleetState, starterFleet.isFailure)
                val starterExpedition = remember(s) { runCatching { s.starterExpedition } }
                val starterExpeditionRepository = starterExpedition.getOrNull()
                val starterExpeditionState = starterExpeditionRepository?.state?.collectAsState()?.value
                val starterExpeditionLifecycle = LocalLifecycleOwner.current.lifecycle
                LaunchedEffect(starterExpeditionRepository, starterExpeditionLifecycle, economyIdentity) {
                    starterExpeditionLifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
                        try {
                            try {
                                val repository = starterExpeditionRepository
                                if (repository != null) {
                                    val read = suspend {
                                        repository.awaitIdle()
                                        check(repository.state.value.review == null) { "Finish the existing review first." }
                                        repository.refresh()
                                        repository.state.value
                                    }
                                    if (expeditionRead != null) expeditionRead.refresh(economyIdentityCurrent, read) else read()
                                }
                            } catch (cancelled: CancellationException) { throw cancelled }
                            catch (_: Exception) { /* No fresh admission; legacy original recovery stays reachable. */ }
                            kotlinx.coroutines.awaitCancellation()
                        } finally { expeditionRead?.clear() }
                    }
                }
                val starterExpeditionAvailable = gg.pixelkingdomwars.nativeclient.ui.economy.starterExpeditionEntryAvailable(starterExpeditionState, starterExpedition.isFailure)
                val harvester = remember(s) { runCatching { s.harvester } }
                val harvesterRepository = harvester.getOrNull()
                val harvesterState = harvesterRepository?.state?.collectAsState()?.value
                val harvesterLifecycle = LocalLifecycleOwner.current.lifecycle
                LaunchedEffect(harvesterRepository, harvesterLifecycle, economyIdentity) {
                    harvesterLifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
                        try {
                            try {
                                val repository = harvesterRepository
                                if (repository != null) {
                                    val read = suspend {
                                        repository.awaitIdle()
                                        check(repository.state.value.review == null) { "Finish the existing review first." }
                                        repository.refresh(waitForIdle = true)
                                        repository.state.value
                                    }
                                    if (harvesterRead != null) harvesterRead.refresh(economyIdentityCurrent, read) else read()
                                }
                            } catch (cancelled: CancellationException) { throw cancelled }
                            catch (_: Exception) { /* No fresh admission; legacy original recovery stays reachable. */ }
                            kotlinx.coroutines.awaitCancellation()
                        } finally { harvesterRead?.clear() }
                    }
                }
                val harvesterAvailable = gg.pixelkingdomwars.nativeclient.ui.economy.harvesterEntryAvailable(harvesterState, harvester.isFailure)
                val workshop = remember(s) { runCatching { s.workshop } }
                val workshopRepository = workshop.getOrNull()
                val workshopState = workshopRepository?.state?.collectAsState()?.value
                LaunchedEffect(workshopRepository, economyIdentity, economyLifecycle) {
                    economyLifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
                        try {
                            try {
                                val repository = workshopRepository
                                if (repository != null) {
                                    val read = suspend { repository.discover(); repository.state.value }
                                    if (workshopRead != null) workshopRead.refresh(economyIdentityCurrent, read) else read()
                                }
                            } catch (cancelled: CancellationException) { throw cancelled }
                            catch (_: Exception) { /* Current discovery stays unknown; original controls remain available. */ }
                            kotlinx.coroutines.awaitCancellation()
                        } finally { workshopRead?.clear() }
                    }
                }
                val workshopAvailable = workshop.isFailure || workshopState?.let { it.advertised || it.journal.operation != null || it.journal.archives.isNotEmpty() } == true
                // Current observations choose capture; otherwise retain the existing screen and original receipts.
                val economyRouteCurrent = {
                    graph.sessionGraph.value === s && graph.holder.current === s.session &&
                        graph.account.state.value.session === s.session && navController.currentBackStackEntry === economyEntry
                }
                val economyCanLeave = {
                    economyRouteCurrent() && !graph.account.state.value.busy && gate == null &&
                        economyLifecycle.currentState == Lifecycle.State.RESUMED &&
                        navController.currentBackStackEntry?.destination?.hasRoute<EconomyRoute>() == true &&
                        (graph.back.active()?.priority ?: BackPriority.SCREEN) <= BackPriority.SCREEN &&
                        s.interlock.state.value.activeRaid == null && !s.battle.state.value.loading && s.battle.activationAllowed() &&
                        fleet?.destination() == null && harvesterRepository?.state?.value?.review == null &&
                        starterFleetRepository?.state?.value?.review == null && starterExpeditionRepository?.state?.value?.review == null &&
                        workshopRepository?.state?.value?.review == null
                }
                val observed = { id: gg.pixelkingdomwars.nativeclient.ui.features.FeatureId ->
                    val current = economyIdentityCurrent()
                    when (id.value) {
                        "workshop.craft" -> gg.pixelkingdomwars.nativeclient.ui.home.homeWorkshopEconomyObserved(workshopRead, workshopRepository?.state?.value, current)
                        "harvester.harvest" -> harvesterRepository?.state?.value?.let {
                            harvesterRead?.observed(it, current) == true && !it.busy && it.review == null && it.advertised &&
                                it.view?.baseId == economyIdentity?.baseId && it.view?.wallet == s.session.wallet
                        } == true
                        "berth.fleet" -> starterFleetRepository?.state?.value?.let {
                            fleetRead?.observed(it, current) == true && !it.busy && it.review == null && it.advertised &&
                                it.view?.baseId == economyIdentity?.baseId && it.view?.wallet == s.session.wallet
                        } == true
                        "lodge.expedition" -> starterExpeditionRepository?.state?.value?.let {
                            expeditionRead?.observed(it, current) == true && !it.busy && it.review == null && it.advertised &&
                                it.view?.baseId == economyIdentity?.baseId && it.view?.wallet == s.session.wallet
                        } == true
                        else -> false
                    }
                }
                val economyHost = gg.pixelkingdomwars.nativeclient.ui.home.HomeEconomyRouteHost(
                    admitted = { economyCanLeave() && graph.homeRequests.pending.value == null && observed(it) }, legacy = { id ->
                        if (!economyRouteCurrent()) false else when (id.value) {
                            "workshop.craft" -> { navController.navigate(WorkshopRoute) { launchSingleTop = true }; true }
                            "harvester.harvest" -> { navController.navigate(HarvesterRoute) { launchSingleTop = true }; true }
                            "berth.fleet" -> { navController.navigate(StarterFleetRoute) { launchSingleTop = true }; true }
                            "lodge.expedition" -> { navController.navigate(StarterExpeditionRoute) { launchSingleTop = true }; true }
                            else -> false
                        }
                    }, returnHome = {
                        if (!navController.popBackStack<HomeRoute>(inclusive = false)) navController.navigate(HomeRoute) { launchSingleTop = true }
                    }, explain = { gg.pixelkingdomwars.nativeclient.ui.chrome.Toasts.post(it) })
                val economyDispatcher = HomeRouteDispatcher(graph.homeRequests, FeatureRegistry.canonical(), current = {
                    if (!economyCanLeave()) null else gg.pixelkingdomwars.nativeclient.ui.home.homeEconomyRouteContext(
                        economyIdentity.takeIf { economyIdentityCurrent() }, s.base.state.value,
                        mapOf("phaseE.harvesters" to if (observed(gg.pixelkingdomwars.nativeclient.ui.features.FeatureId("harvester.harvest")))
                            gg.pixelkingdomwars.nativeclient.ui.features.GateFact.Allowed else gg.pixelkingdomwars.nativeclient.ui.features.GateFact.Unknown))
                }, host = economyHost, entry = gg.pixelkingdomwars.nativeclient.ui.home.HomeRequestEntry.ECONOMY)
                val confirmations = remember(s, wallet) { graph.withdrawalConfirmations(wallet) }
                EconomyScreen(graphViewModel(s) { EconomyViewModel(s.economy) }, graphViewModel(s) { ReferralViewModel(s.referrals) },
                    graphViewModel(s) { ForgeClaimsViewModel(s.forgeClaims) }, graphViewModel(s) { WithdrawalUnwindViewModel(s.withdrawalUnwind) }, s.session.wallet, account.selectedBaseId, account.landOwned, graph.keepConfirm, confirmations,
                    catalogue = content.catalogue, onDeposit = { navController.navigate(KeepDepositRoute) }, onFaucet = { navController.navigate(FaucetRoute) }, onShop = { navController.navigate(ShopRoute) }, onMarket = { navController.navigate(MarketRoute()) }, onBack = { navController.popBackStack() },
                    miningContributionEntry = { gg.pixelkingdomwars.nativeclient.ui.economy.MiningContributionEntry(
                        remember(s) { runCatching { s.miningContribution } }, account.baseSelectionGeneration) { openMiningContribution(graph, s, navController) } },
                    onBuyLand = { navController.navigate(LandGateRoute(reason = "browse", kind = if (account.landOwned) "deed" else "entry")) },
                    onWorkshop = if (workshopAvailable) ({ economyDispatcher.handleFeatureDoor(gg.pixelkingdomwars.nativeclient.ui.features.FeatureId("workshop.craft")); Unit }) else null,
                    onOrdinaryCrafting = if (ordinaryAvailable) ({ navController.navigate(OrdinaryCraftingRoute()) }) else null,
                    onStarterFleet = if (starterFleetAvailable) ({ economyDispatcher.handleFeatureDoor(gg.pixelkingdomwars.nativeclient.ui.features.FeatureId("berth.fleet")); Unit }) else null,
                    onStarterExpeditions = if (starterExpeditionAvailable) ({ economyDispatcher.handleFeatureDoor(gg.pixelkingdomwars.nativeclient.ui.features.FeatureId("lodge.expedition")); Unit }) else null,
                    onHarvesters = if (harvesterAvailable) ({ economyDispatcher.handleFeatureDoor(gg.pixelkingdomwars.nativeclient.ui.features.FeatureId("harvester.harvest")); Unit }) else null,
                    onGems = { navController.navigate(GemsRoute) }, gemsPending = s.gems.state.collectAsState().value.pending.isNotEmpty() || s.gemsBuy.state.collectAsState().value.saved != null) } }
            composable<ReferralsRoute> { session?.let { s ->
                val confirmations = remember(s, wallet) { graph.withdrawalConfirmations(wallet) }
                EconomyScreen(graphViewModel(s) { EconomyViewModel(s.economy) }, graphViewModel(s) { ReferralViewModel(s.referrals) },
                    graphViewModel(s) { ForgeClaimsViewModel(s.forgeClaims) }, graphViewModel(s) { WithdrawalUnwindViewModel(s.withdrawalUnwind) }, s.session.wallet, account.selectedBaseId, account.landOwned, graph.keepConfirm, confirmations,
                    initialPage = gg.pixelkingdomwars.nativeclient.data.EconomyPage.SUPPORT, catalogue = content.catalogue, onDeposit = { navController.navigate(KeepDepositRoute) }, onFaucet = { navController.navigate(FaucetRoute) }, onShop = { navController.navigate(ShopRoute) }, onMarket = { navController.navigate(MarketRoute()) }, onBack = { navController.popBackStack() },
                    onBuyLand = { navController.navigate(LandGateRoute(reason = "browse", kind = if (account.landOwned) "deed" else "entry")) },
                    onGems = { navController.navigate(GemsRoute) }, gemsPending = s.gems.state.collectAsState().value.pending.isNotEmpty() || s.gemsBuy.state.collectAsState().value.saved != null) } }
            composable<GoldForgeControlsRoute> { session?.let { s ->
                val confirmations = remember(s, wallet) { graph.withdrawalConfirmations(wallet) }
                EconomyScreen(graphViewModel(s) { EconomyViewModel(s.economy) }, graphViewModel(s) { ReferralViewModel(s.referrals) },
                    graphViewModel(s) { ForgeClaimsViewModel(s.forgeClaims) }, graphViewModel(s) { WithdrawalUnwindViewModel(s.withdrawalUnwind) }, s.session.wallet, account.selectedBaseId, account.landOwned, graph.keepConfirm, confirmations,
                    catalogue = content.catalogue, initialPage = gg.pixelkingdomwars.nativeclient.data.EconomyPage.FORGE, onDeposit = { navController.navigate(KeepDepositRoute) }, onFaucet = { navController.navigate(FaucetRoute) }, onShop = { navController.navigate(ShopRoute) }, onMarket = { navController.navigate(MarketRoute()) }, onBack = { navController.popBackStack() },
                    miningContributionEntry = { gg.pixelkingdomwars.nativeclient.ui.economy.MiningContributionEntry(
                        remember(s) { runCatching { s.miningContribution } }, account.baseSelectionGeneration) { openMiningContribution(graph, s, navController) } },
                    onBuyLand = { navController.navigate(LandGateRoute(reason = "browse", kind = if (account.landOwned) "deed" else "entry")) },
                    onGems = { navController.navigate(GemsRoute) }, gemsPending = s.gems.state.collectAsState().value.pending.isNotEmpty() || s.gemsBuy.state.collectAsState().value.saved != null) } }
            composable<GoldForgeLegacyControlsRoute> { session?.let { s ->
                val confirmations = remember(s, wallet) { graph.withdrawalConfirmations(wallet) }
                EconomyScreen(graphViewModel(s) { EconomyViewModel(s.economy) }, graphViewModel(s) { ReferralViewModel(s.referrals) },
                    graphViewModel(s) { ForgeClaimsViewModel(s.forgeClaims) }, graphViewModel(s) { WithdrawalUnwindViewModel(s.withdrawalUnwind) }, s.session.wallet, account.selectedBaseId, account.landOwned, graph.keepConfirm, confirmations,
                    catalogue = content.catalogue, initialPage = gg.pixelkingdomwars.nativeclient.data.EconomyPage.WITHDRAWALS, onDeposit = { navController.navigate(KeepDepositRoute) }, onFaucet = { navController.navigate(FaucetRoute) }, onShop = { navController.navigate(ShopRoute) }, onMarket = { navController.navigate(MarketRoute()) }, onBack = { navController.popBackStack() },
                    miningContributionEntry = { gg.pixelkingdomwars.nativeclient.ui.economy.MiningContributionEntry(
                        remember(s) { runCatching { s.miningContribution } }, account.baseSelectionGeneration) { openMiningContribution(graph, s, navController) } },
                    onBuyLand = { navController.navigate(LandGateRoute(reason = "browse", kind = if (account.landOwned) "deed" else "entry")) },
                    onGems = { navController.navigate(GemsRoute) }, gemsPending = s.gems.state.collectAsState().value.pending.isNotEmpty() || s.gemsBuy.state.collectAsState().value.saved != null) } }
            composable<ForgeRoute> { session?.let { s ->
                val forgeIdentity = remember(s) { homePresentationIdentity(account, s.session, graph.holder.current) }
                var openingRefused by remember(s) { mutableStateOf(false) }
                LaunchedEffect(s, forgeIdentity) {
                    if (forgeIdentity == null || graph.sessionGraph.value !== s ||
                        homePresentationIdentity(graph.account.state.value, s.session, graph.holder.current) != forgeIdentity) {
                        openingRefused = true
                    } else {
                        graph.homeRequests.request(HomeRequest.Open(gg.pixelkingdomwars.nativeclient.ui.features.FeatureId("goldforge.open"),
                            forgeIdentity, gg.pixelkingdomwars.nativeclient.ui.features.FeatureSelection(),
                            entry = gg.pixelkingdomwars.nativeclient.ui.home.HomeRequestEntry.FORGE))
                        if (!navController.popBackStack<HomeRoute>(inclusive = false)) navController.navigate(HomeRoute) {
                            popUpTo(0) { inclusive = true }; launchSingleTop = true
                        }
                    }
                }
                gg.pixelkingdomwars.nativeclient.ui.chrome.DesignedPage("GOLD FORGE", { navController.popBackStack() }) {
                    Text(if (openingRefused) "The kingdom changed. Open the Gold Forge again." else "Opening the Gold Forge…")
                }
            } }
            composable<MarketRoute> { entry -> session?.let { s ->
                val route = entry.toRoute<MarketRoute>()
                val trades = graphViewModel(s) { gg.pixelkingdomwars.nativeclient.ui.economy.MarketTradeViewModel(s.marketTrades) }
                val sender = remember(s, wallet) { graph.marketWallet(s, wallet) }
                gg.pixelkingdomwars.nativeclient.ui.sheets.craft.MarketHomeBody(graphViewModel(s) { gg.pixelkingdomwars.nativeclient.ui.economy.MarketViewModel(s.market, gg.pixelkingdomwars.nativeclient.data.WorldDeedPreview(graph.origin), trades) },
                    s.session.wallet, content.catalogue, account.landOwned, route.itemId,
                    onInventory = { navController.navigate(InventoryRoute) },
                    onLand = { navController.navigate(LandGateRoute(reason = "browse", kind = if (account.landOwned) "deed" else "entry")) },
                    onBack = { navController.popBackStack() }, purchaseWallet = sender, isCurrent = { graph.sessionGraph.value === s }) } }
            composable<KeepDepositRoute> { session?.let { s ->
                val sender = remember(s, wallet) { graph.depositWallet(s, wallet) }
                gg.pixelkingdomwars.nativeclient.ui.economy.KeepDepositScreen(graphViewModel(s) { gg.pixelkingdomwars.nativeclient.ui.economy.KeepDepositViewModel(s.deposits) }, sender, s.session.wallet,
                    gg.pixelkingdomwars.nativeclient.data.KeepDepositBounds.from(content.catalogue), onBack = { navController.popBackStack() }, economy = s.economy) } }
            composable<BasePurchaseRoute> { routeEntry -> session?.let { s ->
                val route = routeEntry.toRoute<BasePurchaseRoute>()
                val energyHome: () -> Unit = {
                    graph.homeRequests.request(HomeRequest.Tab(HomeTab.KINGDOM))
                    navController.navigate(HomeRoute) { popUpTo(0) { inclusive = true }; launchSingleTop = true }
                }
                if (route.kind == "expansion" && (gg.pixelkingdomwars.nativeclient.BuildConfig.NATIVE_CANDIDATE ||
                        graph.origin == gg.pixelkingdomwars.nativeclient.model.CandidateExpansionContract.ORIGIN)) {
                    val candidate = s.candidateExpansions
                    if (candidate == null) gg.pixelkingdomwars.nativeclient.ui.chrome.DesignedPage("Test expansion", { navController.popBackStack() }) {
                        androidx.compose.material3.Text("Test expansions are unavailable in this app.")
                    } else gg.pixelkingdomwars.nativeclient.ui.kingdom.CandidateExpansionScreen(
                        graphViewModel(s) { gg.pixelkingdomwars.nativeclient.ui.kingdom.CandidateExpansionViewModel(candidate) },
                        route.baseId, onBack = { navController.popBackStack() })
                } else {
                    val sender = remember(s, wallet) { graph.basePurchaseWallet(s, wallet) }
                    gg.pixelkingdomwars.nativeclient.ui.kingdom.BasePurchaseScreen(
                        graphViewModel(s) { gg.pixelkingdomwars.nativeclient.ui.kingdom.BasePurchaseViewModel(s.basePurchases) },
                        sender, route.kind, route.baseId, route.buildingId,
                        onBack = { if (route.kind in setOf("energy", "energy_pack")) energyHome() else navController.popBackStack() }, onEnergyFinished = energyHome)
                }
            } }
            composable<CodexRoute> { session?.let { s -> CodexScreen(graphViewModel(s) { RosterViewModel(graph, s) }) { navController.popBackStack() } } }
            composable<QuestsRoute> { session?.let { s -> QuestsScreen(graphViewModel(s) { QuestsViewModel(graph, s) }, graph = graph, session = s,
                onReport = { navController.navigate(FeedbackRoute) { launchSingleTop = true } }, onBack = { navController.popBackStack() },
                // Web `onboardingChain`: BUILD opens the tray, TRAIN the barracks composer (the same HomeRequest.Training the objective strip
                // sends, never the ready-army roster), RAID the campaign; the request survives the screen hand-off.
                // A BuildMenu request implies the Kingdom tab (HomeRequest.homeTab), so one queued request lands on Kingdom with the tray open.
                onBuild = { graph.homeRequests.request(HomeRequest.BuildMenu); navController.popBackStack() },
                onTrain = { graph.homeRequests.request(HomeRequest.Training); navController.popBackStack() },
                onCampaign = { graph.homeRequests.request(HomeRequest.Campaign); navController.popBackStack() },
                onLand = { navController.navigate(LandGateRoute(reason = "browse")) { launchSingleTop = true } }) } }
            composable<ClansRoute> { session?.let { s -> ClanHub(graph, s,
                graphViewModel(s) { gg.pixelkingdomwars.nativeclient.ui.community.ClansViewModel(s.clans) },
                onBack = { navController.popBackStack() },
                onChat = { navController.navigate(ChatRoute) { launchSingleTop = true } },
                onBuyLand = { navController.navigate(LandGateRoute(reason = "browse")) { launchSingleTop = true } },
                onCharterControls = { navController.navigate(BasesRoute(notice = "Open ACTIVITIES & RECEIPTS, then CLAN CHARTERS & INVITATIONS.")) { launchSingleTop = true } },
                onTournamentControls = { navController.navigate(BasesRoute(notice = "Open ACTIVITIES & RECEIPTS, then CLAN TOURNAMENTS & PRIZES.")) { launchSingleTop = true } },
                onReport = { navController.navigate(FeedbackRoute) { launchSingleTop = true } }) } }
            // The designed Founding Kingdoms card replaces TesterScreen; the campaign screen stays its RULES / saved-request door.
            composable<TesterRoute> { session?.let { s -> gg.pixelkingdomwars.nativeclient.ui.community.EventHub(graph, s, onBack = { navController.popBackStack() },
                onFeedback = { navController.navigate(FeedbackRoute) { launchSingleTop = true } },
                onCampaign = { navController.navigate(PlaytestCampaignRoute) { launchSingleTop = true } },
                onDoor = { link -> when (link.feature.value) {
                    "hud.quests" -> navController.navigate(QuestsRoute) { launchSingleTop = true }
                    "settings.feedback" -> navController.navigate(FeedbackRoute) { launchSingleTop = true }
                    "profile.kingdoms" -> navController.navigate(BasesRoute()) { launchSingleTop = true }
                    "hud.attack" -> {
                        if (!navController.popBackStack<HomeRoute>(inclusive = false)) navController.navigate(HomeRoute) { popUpTo(0) { inclusive = true } }
                        graph.homeRequests.request(HomeRequest.RaidChooser)
                    }
                    else -> gg.pixelkingdomwars.nativeclient.ui.chrome.Toasts.post("Open this destination from your kingdom.")
                } }) } }
            composable<PlaytestCampaignRoute> { session?.let { s -> PlaytestCampaignScreen(s.playtest, gg.pixelkingdomwars.nativeclient.data.PlaytestBounds.from(content.catalogue),
                onFeedback = { navController.navigate(FeedbackRoute) { launchSingleTop = true } }, onBack = { navController.popBackStack() }) } }
            composable<FeedbackRoute> { session?.let { s -> gg.pixelkingdomwars.nativeclient.ui.community.FeedbackHub(graph, s, onBack = { navController.popBackStack() }) } }
            composable<ChatRoute> { session?.let { s -> ChatScreen(s.chat, ChatBounds.from(content.catalogue), runCatching { gg.pixelkingdomwars.nativeclient.data.ProfileBounds.from(content.catalogue) }.getOrNull(),
                onProfile = { navController.navigate(ProfileRoute) { launchSingleTop = true } }, onBack = { navController.popBackStack() },
                onLand = { navController.navigate(LandGateRoute(reason = "browse")) { launchSingleTop = true } }) } }
            // MailRoute and the MAIL deep link use the one designed Mail card; the old CommunityScreen is off the player path.
            composable<MailRoute> { session?.let { s -> gg.pixelkingdomwars.nativeclient.ui.community.MailHub(graph, s, onClose = { navController.popBackStack() },
                onFeature = { feature -> when (feature.value) {
                    "hud.quests" -> navController.navigate(QuestsRoute) { launchSingleTop = true }
                    "profile.kingdoms" -> navController.navigate(BasesRoute()) { launchSingleTop = true }
                    else -> gg.pixelkingdomwars.nativeclient.ui.chrome.Toasts.post("Open this destination from your kingdom.")
                } }, onReport = { navController.navigate(FeedbackRoute) { launchSingleTop = true } }) } }
            composable<LeaguesRoute> { session?.let { s -> gg.pixelkingdomwars.nativeclient.ui.community.LeaguesHub(graph, s, onClose = { navController.popBackStack() },
                onFindMatch = { graph.homeRequests.request(HomeRequest.RaidChooser)
                    if (!navController.popBackStack<HomeRoute>(inclusive = false)) navController.navigate(HomeRoute) { popUpTo(0) { inclusive = true } } },
                onLand = { navController.navigate(LandGateRoute(reason = "browse")) { launchSingleTop = true } },
                onReport = { navController.navigate(FeedbackRoute) { launchSingleTop = true } }) } }
            composable<SettingsRoute> { SettingsHub(graph, session, wallet, onBack = { navController.popBackStack() },
                onSecurity = { navController.navigate(SecurityRoute) { launchSingleTop = true } },
                onFeedback = { if (session != null) navController.navigate(FeedbackRoute) { launchSingleTop = true }
                    else gg.pixelkingdomwars.nativeclient.ui.chrome.Toasts.post("Open your kingdom to send feedback.") },
                onCodex = { if (session != null) navController.navigate(CodexRoute) { launchSingleTop = true }
                    else gg.pixelkingdomwars.nativeclient.ui.chrome.Toasts.post("Open your kingdom to read the Codex.") },
                onAbout = { navController.navigate(AboutRoute) { launchSingleTop = true } }) }
            composable<AboutRoute> {
                val repository = remember(graph) { graph.legal() }
                AboutScreen(repository, account.wallet ?: account.admission?.wallet ?: account.pendingWallet,
                    onBack = { navController.popBackStack() })
            }
            // One profile surface (owner): the account page is the hub's ACCOUNT tab; the old route and its menu entry land there.
            composable<AccountRoute> { session?.let { s -> ProfileHubDestination(graph, s, wallet, navController, gg.pixelkingdomwars.nativeclient.ui.profile.ProfileTab.ACCOUNT) } }
            composable<ProfileRoute> { session?.let { s -> ProfileHubDestination(graph, s, wallet, navController, gg.pixelkingdomwars.nativeclient.ui.profile.ProfileTab.PROFILE) } }
            composable<GoldForgeWalletControlsRoute> { session?.let { s -> ProfileHubDestination(graph, s, wallet, navController, gg.pixelkingdomwars.nativeclient.ui.profile.ProfileTab.WALLET) } }
            composable<ProfileEditRoute> { session?.let { s -> ProfileScreen(graphViewModel(s) { ProfileViewModel(graph, s) }) { navController.popBackStack() } } }
            composable<SeekerRoute> { session?.let { s -> gg.pixelkingdomwars.nativeclient.ui.profile.SeekerScreen(s.seeker, seekerWallet, s.session.wallet,
                gg.pixelkingdomwars.nativeclient.data.SeekerBounds.from(content.catalogue), onBack = { navController.popBackStack() }) } }
            composable<SecurityRoute> { securityEntry ->
                if (account.phase != gg.pixelkingdomwars.nativeclient.data.AccountPhase.SIGNED_IN && account.phase != gg.pixelkingdomwars.nativeclient.data.AccountPhase.TOTP) return@composable
                // A cookie transition invalidates this destination's capture; never silently rebind its
                // pending recovery/MFA action to a new cookie while logout or login is in flight.
                val security = remember(securityEntry, wallet) { graph.security(wallet) }
                if (runCatching { security.access.requireCurrent() }.isFailure) {
                    LaunchedEffect(security) { security.repository.clearSensitive(); security.walletAuthenticator.setForeground(false); navController.popBackStack() }
                    return@composable
                }
                SecurityDestination(security.repository, security.confirmations, security.access.loginRecovery, security.walletAuthenticator,
                    onBack = { navController.popBackStack() })
            }
        }
        }
        }
        // Once for every update surface (the boot gate, Title, Home): the installer's confirmation and the Settings resume.
        gg.pixelkingdomwars.nativeclient.update.NativeUpdateEffects()
        val browserRequest by links.browser.collectAsState()
        val browserBackChange by graph.back.changes.collectAsState()
        val browserBackPriority = remember(browserBackChange) { graph.back.active()?.priority ?: BackPriority.HOME }
        // Web-only links preserve referral attribution without replacing an active native ceremony.
        browserRequest?.let { request ->
            if (gate == null && linkLifecycleState == Lifecycle.State.RESUMED && !account.busy &&
                battle?.loading != true && session?.battle?.activationAllowed() != false && browserBackPriority <= BackPriority.SCREEN) {
                BrowserGameLinkPrompt(links, request)
            }
        }
        gate?.let { current ->
            if (current is Gate.Funds) FundsSheet(current, session?.base?.state?.collectAsState()?.value?.balances, onKingdom = { gate = null; graph.homeRequests.request(HomeRequest.Tab(HomeTab.KINGDOM)) },
                onQuests = { gate = null; navController.navigate(QuestsRoute) }, onLand = { gate = null; navController.navigate(LandGateRoute(reason = "browse")) { launchSingleTop = true } },
                onEconomy = { gate = null; navController.navigate(EconomyRoute) { launchSingleTop = true } },
                onGems = { gate = null; navController.navigate(GemsRoute) { launchSingleTop = true } },
                gemsPending = session?.let { it.gems.state.collectAsState().value.pending.isNotEmpty() || it.gemsBuy.state.collectAsState().value.saved != null } == true) { gate = null }
            else if (current is Gate.Update || current is Gate.Maintenance) {
                // The designed gate card (hub update/maintenance frames) replaces the old Update and Maintenance dialogs.
                val dialogUpdate = graph.bootUpdates.dialogUpdate(updateState)
                gg.pixelkingdomwars.nativeclient.update.ServerGateCard(current,
                    dialogUpdate = if (dialogUpdate != null) ({ gate = null; dialogUpdate() }) else null,
                    onDismiss = { gate = null },
                    onCheck = {
                        // One existing GET. A maintenance that persists raises a new gate during it, so the card stays;
                        // otherwise the shown gate is cleared. Without a kingdom the next request decides.
                        val shown = current
                        val base = session?.base
                        if (base == null) gate = null
                        else gateScope.launch {
                            try { base.refreshWithoutJourneys() } catch (cancelled: CancellationException) { throw cancelled } catch (_: Exception) { }
                            if (gate === shown) gate = null
                        }
                    })
            }
            else GateDialog(current, onDismiss = { gate = null }, onSignOut = { gate = null; gates.signOut(wallet) })
        }
    }
}

/** All external Gold Forge doors enqueue one typed request for the Home dispatcher to re-resolve. */
private fun openGoldForgeHome(graph: AppGraph, session: SessionGraph, navController: NavHostController,
    id: gg.pixelkingdomwars.nativeclient.ui.features.FeatureId) {
    val identity = homePresentationIdentity(graph.account.state.value, session.session, graph.holder.current)
    if (graph.sessionGraph.value !== session || identity == null) {
        gg.pixelkingdomwars.nativeclient.ui.chrome.Toasts.post("The kingdom changed. Open the Gold Forge again.")
        return
    }
    graph.homeRequests.request(HomeRequest.Open(id, identity,
        gg.pixelkingdomwars.nativeclient.ui.features.FeatureSelection(),
        entry = gg.pixelkingdomwars.nativeclient.ui.home.HomeRequestEntry.FORGE))
    if (!navController.popBackStack<HomeRoute>(inclusive = false)) navController.navigate(HomeRoute) {
        popUpTo(0) { inclusive = true }; launchSingleTop = true
    }
}

/** KEEP mining smelts in place on the Gold Forge's SMELT tab. Filed contribution receipts have no designed face yet, so
 *  while any exist (or storage cannot be read) the saved-contributions door keeps their original history owner. */
private fun openMiningContribution(graph: AppGraph, session: SessionGraph, navController: NavHostController) {
    val archived = runCatching { session.miningContribution.state.value.journal.archives.isNotEmpty() }.getOrDefault(true)
    if (archived) navController.navigate(MiningContributionRoute) { launchSingleTop = true }
    else openGoldForgeHome(graph, session, navController, gg.pixelkingdomwars.nativeclient.ui.features.FeatureId("goldforge.smelt"))
}

@Composable private fun ProfileHubDestination(graph: AppGraph, s: SessionGraph, wallet: WalletLogin?, navController: NavHostController, tab: gg.pixelkingdomwars.nativeclient.ui.profile.ProfileTab) {
    val account by graph.account.state.collectAsState()
    gg.pixelkingdomwars.nativeclient.ui.profile.ProfileHub(graph, s,
        graphViewModel(s) { ProfileViewModel(graph, s) }, graphViewModel(s) { AccountViewModel(graph, s) }, wallet,
        onBack = { navController.popBackStack() }, onEditProfile = { navController.navigate(ProfileEditRoute) { launchSingleTop = true } },
        onSecurity = { navController.navigate(SecurityRoute) { launchSingleTop = true } }, onSeeker = { navController.navigate(SeekerRoute) { launchSingleTop = true } },
        onRaidLog = { navController.navigate(RaidLogRoute) { launchSingleTop = true } }, onClans = { navController.navigate(ClansRoute) { launchSingleTop = true } },
        onReferrals = { navController.navigate(ReferralsRoute) { launchSingleTop = true } }, onBases = { navController.navigate(BasesRoute()) { launchSingleTop = true } }, initialTab = tab,
        onSettings = { navController.navigate(SettingsRoute) { launchSingleTop = true } },
        onDeedClaim = { navController.navigate(BaseClaimRoute) { launchSingleTop = true } },
        onFeature = { link -> when (link.feature.value) {
            "hud.leagues" -> navController.navigate(LeaguesRoute) { launchSingleTop = true }
            "hud.quests" -> navController.navigate(QuestsRoute) { launchSingleTop = true }
            "profile.feedback" -> navController.navigate(FeedbackRoute) { launchSingleTop = true }
            "profile.about" -> navController.navigate(AboutRoute) { launchSingleTop = true }
            "profile.faucet" -> navController.navigate(FaucetRoute) { launchSingleTop = true }
            "goldforge.open" -> openGoldForgeHome(graph, s, navController, link.feature)
            "hud.map" -> { graph.homeRequests.request(HomeRequest.World(gg.pixelkingdomwars.nativeclient.data.WorldEntry.MyDeeds)); navController.popBackStack() }
            "hud.builders" -> { graph.homeRequests.request(HomeRequest.Builders); navController.popBackStack() }
            "profile.more" -> { graph.homeRequests.request(HomeRequest.Tab(HomeTab.MORE)); navController.popBackStack() }
            "profile.seekerIsland" -> { graph.homeRequests.request(HomeRequest.World(gg.pixelkingdomwars.nativeclient.data.WorldEntry.SeekerIsland)); navController.popBackStack() }
            else -> gg.pixelkingdomwars.nativeclient.ui.chrome.Toasts.post("Open this destination from your kingdom.")
        } },
        onLand = { kind -> navController.navigate(LandGateRoute(reason = "browse", kind = kind)) { launchSingleTop = true } },
        skrFaucet = gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live.skrFaucetLocalState(
            graph.cluster == gg.pixelkingdomwars.nativeclient.wallet.SolanaCluster.DEVNET,
            gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live.landOwnedLive(account),
            gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live.skrFaucetClaimOpen(graph)) ?: gg.pixelkingdomwars.nativeclient.ui.sheets.account.FaucetUi.Hidden,
        onSkrFaucet = { navController.navigate(SkrFaucetRoute) { launchSingleTop = true } })
}

/** A failed pending-march read is unknown, never proof that entry recovery is complete. */
internal class EntryRecoveryState {
    private var recoveredBaseId: String? = null
    var recovered by mutableStateOf(false)
        private set
    var error by mutableStateOf<String?>(null)
        private set
    var checking by mutableStateOf(false)
        private set

    fun completedFor(baseId: String?): Boolean = baseId != null && recovered && recoveredBaseId == baseId && !checking && error == null

    suspend fun check(baseId: String, read: suspend () -> EntryRecovery): EntryRecovery? {
        if ((recovered && recoveredBaseId == baseId) || checking) return null
        recovered = false
        checking = true
        error = null
        return try {
            read().also { recoveredBaseId = baseId; recovered = true }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (failure: Exception) {
            error = failure.message ?: "Connection interrupted. Please retry."
            null
        } finally { checking = false }
    }
}

/** Presentation lifetime follows the account/base owner, not transient model/selection readiness.
 * A changed account/base/generation still drops the old presentation immediately. */
internal fun homePresentationIdentity(account: AccountState, expectedSession: AccountSession,
    currentSession: AccountSession?): HomeRouteIdentity? {
    if (account.session !== expectedSession || currentSession !== expectedSession || account.baseSelectionGeneration < 0) return null
    val base = account.selectedBaseId?.takeIf { it.isNotBlank() } ?: return null
    return HomeRouteIdentity(expectedSession, base, account.baseSelectionGeneration)
}

/** One stable call site for the entire Home root, outside identity/tab-dependent hook composition. */
@Composable internal fun StableHomeLayer(identity: HomeRouteIdentity?,
    hooks: @Composable (HomeRouteIdentity) -> HomeLayerHooks, layer: HomeLayerContent) {
    val observed = if (identity == null) HomeLayerHooks(resourcesBlocked = true) else hooks(identity)
    layer(observed)
}

/** Detached routing observations only; unavailable owner/server facts remain unknown. */
internal fun homeRouteContext(
    account: AccountState,
    expectedSession: AccountSession,
    currentSession: AccountSession?,
    home: BaseState,
    kingdom: KingdomUiState,
): HomeRouteContext? {
    if (account.session !== expectedSession || currentSession !== expectedSession) return null
    val selectedBase = account.selectedBaseId?.takeIf { it.isNotBlank() } ?: return null
    val base = home.base ?: return null
    val modelBase = kingdom.base ?: return null
    if (account.baseSelectionGeneration < 0 || base.baseId != selectedBase || modelBase.baseId != selectedBase ||
        kingdom.selectedBaseId != selectedBase || kingdom.baseGeneration != account.baseSelectionGeneration) return null

    val selection = kingdom.selectedBuildingId?.let { id ->
        // A transient model/base mismatch must never redirect a retained command to another building.
        val selected = modelBase.buildings.singleOrNull { it.id == id } ?: return null
        val live = base.buildings.singleOrNull { it.id == id } ?: return null
        if (id.isBlank() || selected.type.isBlank() || live.type != selected.type || selected.level < 0 || live.level < 0) return null
        BuildingSelection(selectedBase, live.id, live.type)
    }
    val buildings = base.buildings.filter { it.id.isNotBlank() && it.type.isNotBlank() && it.level >= 0 }
        .groupBy { it.type }.mapValues { (_, instances) ->
            // A higher unfinished copy cannot hide an already completed instance of the same type.
            val completed = instances.filter { !it.underConstruction && it.level > 0 }
            val level = (completed.ifEmpty { instances }).maxOf { it.level }
            BuildingGateState(level, completed.isNotEmpty())
        }
    return HomeRouteContext(
        HomeRouteIdentity(expectedSession, selectedBase, account.baseSelectionGeneration),
        GateContext(baseId = selectedBase, keepLevel = base.player.keepLevel.takeIf { it >= 0 },
            buildings = buildings, selection = FeatureSelection(building = selection),
            ownerFacts = selection?.takeIf { it.type == "lodge" }?.let { selected -> mapOf("building.jobRunning" to
                if (modelBase.jobs.any { it.buildingId == selected.buildingId }) gg.pixelkingdomwars.nativeclient.ui.features.GateFact.Allowed
                else gg.pixelkingdomwars.nativeclient.ui.features.GateFact.Denied("No building job")) }.orEmpty()),
    )
}

@Composable private fun HomeShell(graph: AppGraph, session: SessionGraph, navController: NavHostController, local: Boolean, links: PendingGameLinks, gatesClear: Boolean, defenceNotices: DefenceNotices, onExit: () -> Unit,
    fleet: gg.pixelkingdomwars.nativeclient.ui.economy.FleetCommandOwners? = null, wallet: WalletLogin? = null, onAudioScreen: (String) -> Unit) {
    val account by graph.account.state.collectAsState()
    val home by session.base.state.collectAsState()
    val content by graph.content.state.collectAsState()
    val economyHud by session.economy.state.collectAsState()
    val mailHud by session.community.state.collectAsState()
    val communityReads = remember(session.community) { HomeCommunityReads(session.community) }
    val testerHud by session.tester.state.collectAsState()
    val playtestHud by session.playtest.state.collectAsState()
    val chatLauncher by session.chat.launcher.collectAsState()
    var chatEligible by remember(session) { mutableStateOf(true) }
    var hostedChat by remember(session) { mutableStateOf(false) }
    // The message a chat peek tap opens the drawer at; cleared when the drawer closes.
    var peekFocus by remember(session) { mutableStateOf<String?>(null) }
    var defenceNotice by remember(session, home.base?.baseId) { mutableStateOf<String?>(null) }
    LaunchedEffect(session, home.base) { defenceNotice = defenceNotices.announce(home.base?.baseId, home.base?.raw, Instant.now()) ?: defenceNotice }
    LaunchedEffect(defenceNotice) { if (defenceNotice != null) { kotlinx.coroutines.delay(1_600); defenceNotice = null } }
    val unreadRaids = defenceNotices.unread(home.base?.baseId, home.base?.raw)
    val kingdom = graphViewModel(session) { KingdomViewModel(graph, session) }
    val layout = graphViewModel(session) { LayoutEditorViewModel(graph, session) }
    val kingdomAudio by kingdom.state.collectAsState()
    // Scene-transitions spec §1.5: the HUD stands over the live kingdom or its postcard, never over the wallpaper cover.
    val kingdomPicture by kingdom.homePicture.collectAsState()
    val layoutAudio by gg.pixelkingdomwars.nativeclient.ui.home.rememberLayoutOpenFact(layout) // open/closed only (no per-edit shell recomposition)
    DisposableEffect(session) { onDispose { if (!session.chat.launcher.value.open) session.chat.clearLauncher() } }
    val army = graphViewModel(session) { ArmyViewModel(graph, session) }
    val armyLiveRoster = graphViewModel(session) { gg.pixelkingdomwars.nativeclient.ui.roster.RosterViewModel(graph, session) }
    // One Army-group presentation owner; selected-base changes retire the surface and any retained hero selection.
    var armyLiveSheet by androidx.compose.runtime.saveable.rememberSaveable(session, account.selectedBaseId, account.baseSelectionGeneration) { mutableStateOf<String?>(null) }
    var armyLiveHero by androidx.compose.runtime.saveable.rememberSaveable(session, account.selectedBaseId, account.baseSelectionGeneration) { mutableStateOf<String?>(null) }
    val attack = graphViewModel(session) { AttackViewModel(graph, session) }
    val openLand = { navController.navigate(LandGateRoute(reason = "browse")) { launchSingleTop = true } }
    // Selected-deed defender interlock (web useActiveBaseRaid): observed while Home is STARTED; the lock modal covers
    // every deed surface except the history, which stays reachable exactly as the web's raidlog does.
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(session, lifecycle) { lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) { session.interlock.foreground() } }
    val chatBounds = remember(content.catalogue) { gg.pixelkingdomwars.nativeclient.data.ChatBounds.from(content.catalogue) }
    LaunchedEffect(session, lifecycle, chatEligible, chatBounds, chatLauncher.open) {
        if (!chatEligible || chatBounds == null) { session.chat.clearLauncher(); return@LaunchedEffect }
        if (chatLauncher.open) return@LaunchedEffect
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            while (true) {
                try {
                    val enabled = session.chat.launcher.value.enabled
                    session.chat.pollLauncher()
                    if (!enabled && session.chat.launcher.value.enabled) session.chat.pollLauncher()
                } catch (cancelled: CancellationException) { throw cancelled } catch (_: Exception) { /* Retain the previous capability/count until the next bounded read. */ }
                val delayMs = session.chat.launcher.value.status?.pollClosedMs?.toLong()?.takeIf { it > 0 } ?: chatBounds.pollClosedMs
                kotlinx.coroutines.delay(delayMs)
            }
        }
    }
    // Hydrate the same existing reads as the web HUD on entry/resume. Each repository keeps its
    // identity/cache guards; a failed optional read cannot cancel the other indicators or retry a command.
    LaunchedEffect(session, lifecycle) { lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
        supervisorScope {
            suspend fun optionalRead(block: suspend () -> Unit) { try { block() } catch(error: CancellationException) { throw error } catch(_: Exception) { /* Existing repository error/retry state is retained. */ } }
            launch { optionalRead { session.economy.refresh(gg.pixelkingdomwars.nativeclient.data.EconomyPage.WALLET) } }
            // The SHARDS/KEEP chips read the base repository, not the economy one: a return to Home re-reads it at once
            // instead of waiting for the Kingdom tick. The first entry is hydrated by the Kingdom screen itself.
            launch { optionalRead { if (session.base.state.value.base != null) session.base.refreshWithoutJourneys() } } // container entry/resume hydration: no journey publication (N-C5)
            launch { optionalRead { communityReads.refreshMail() } }
            launch { optionalRead { session.tester.refreshProgress() } }
        }
    } }
    LaunchedEffect(session, home.base?.baseId, account.selectedBaseId, lifecycle) {
        if (home.base != null && home.base?.baseId == account.selectedBaseId)
            lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) { session.faucet.foreground(true) }
    }
    val interlock by session.interlock.state.collectAsState()
    // Web `raidRecoveryDestination`: once the selected base is hydrated, an active march wins over the base screen.
    val recovery = remember(session) { EntryRecoveryState() }
    var recoveryAttempt by remember(session) { mutableIntStateOf(0) }
    LaunchedEffect(session, account.selectedBaseId, home.base?.baseId, recoveryAttempt) {
        val selected = account.selectedBaseId ?: return@LaunchedEffect
        if (home.base?.baseId != selected) return@LaunchedEffect
        when (recovery.check(selected) { session.battle.recoverOnEntry() }) {
            EntryRecovery.HISTORY -> navController.navigate(RaidLogRoute) { launchSingleTop = true }
            else -> {}
        }
    }
    val pendingLink by links.pending.collectAsState()
    val backChange by graph.back.changes.collectAsState()
    val lifecycleState by lifecycle.currentStateFlow.collectAsState()
    val battle by session.battle.state.collectAsState()
    val coordinatorState = battle.coordinator?.state?.collectAsState()?.value
    val attackBusy by attack.busy.collectAsState()
    val kingdomBusy by kingdom.busy.collectAsState()
    val armyBusy by army.busy.collectAsState()
    val armyHomeState by army.state.collectAsState()
    val homeRequest by graph.homeRequests.pending.collectAsState()
    val chooser by attack.chooser.collectAsState()
    val route by navController.currentBackStackEntryAsState()
    val presentationIdentity = homePresentationIdentity(account, session.session, graph.holder.current)
        .takeIf { graph.sessionGraph.value === session }
    val reviewGate = remember(presentationIdentity) { HomeRouteReviewGate(setOf("kingdom")) }
    DisposableEffect(reviewGate) { onDispose { reviewGate.close() } }
    val reviewBlocked by reviewGate.blocked.collectAsState()
    val starterReviewPresence = remember(session, presentationIdentity) { gg.pixelkingdomwars.nativeclient.ui.home.HomeStarterReviewPresence() }
    val voyageOverlays = remember(session, presentationIdentity) { gg.pixelkingdomwars.nativeclient.ui.home.HomeVoyageOverlays() }
    val harvesterReviewPresence = remember(session, presentationIdentity) { gg.pixelkingdomwars.nativeclient.ui.home.HomeHarvesterReviewPresence() }
    val currentPresentationIdentity = rememberUpdatedState<() -> HomeRouteIdentity?> {
        if (graph.sessionGraph.value !== session) null else
            homePresentationIdentity(graph.account.state.value, session.session, graph.holder.current)
    }
    val currentRouteIdentity = rememberUpdatedState<() -> HomeRouteIdentity?> {
        if (graph.sessionGraph.value !== session) null else homeRouteContext(
            graph.account.state.value, session.session, graph.holder.current,
            session.base.state.value, kingdom.state.value,
        )?.identity
    }
    // Re-read the owners at event time, not just the last frame that enabled a control.
    val routeAdmissionBlocked = rememberUpdatedState<() -> Boolean> {
        val liveBase = session.base.state.value
        currentRouteIdentity.value() == null || lifecycle.currentState != Lifecycle.State.RESUMED ||
            !gatesClear || navController.currentBackStackEntry?.destination?.hasRoute<HomeRoute>() != true ||
            layout.state.value.open || !recovery.completedFor(graph.account.state.value.selectedBaseId) ||
            recovery.checking || recovery.error != null || liveBase.loading || liveBase.error != null ||
            session.battle.state.value.loading || attack.busy.value || kingdom.busy.value || army.busy.value ||
            attack.chooser.value || session.interlock.state.value.activeRaid != null ||
            !session.battle.activationAllowed() || hostedChat || armyLiveSheet != null || fleet?.destination() != null ||
            liveBase.builderFinishReview != null || kingdom.state.value.local.wallRowQuote != null ||
            kingdom.state.value.local.sheet != null || reviewGate.blocked.value ||
            ((graph.back.active()?.priority ?: BackPriority.HOME) > BackPriority.SHEET &&
                !starterReviewPresence.ownsBack(graph.back.active()) && !harvesterReviewPresence.ownsBack(graph.back.active()) &&
                !voyageOverlays.presence.ownsBack(graph.back.active()))
    }
    // Borrow the existing session repositories and registration projections. Creating a projection
    // starts no read/driver and never invents a controller when a registration is absent.
    val harvesterOwnerRepository = remember(session) { runCatching { session.harvester }.getOrNull() }
    val workshopOwnerRepository = remember(session) { runCatching { session.workshop }.getOrNull() }
    val starterFleetOwnerRepository = remember(session) { runCatching { session.starterFleet }.getOrNull() }
    // The base identity is also a key: immutable projections captured for the old generation must retire.
    val ownerProjections = remember(session, harvesterOwnerRepository, starterFleetOwnerRepository,
        fleet?.vehicle, fleet?.starter, presentationIdentity) {
        HomeOwnerProjections(vehicle = fleet?.vehicle, starter = fleet?.starter,
            starterFleet = starterFleetOwnerRepository?.let { repository ->
                gg.pixelkingdomwars.nativeclient.ui.home.projectHomeStarterFleet(graph, session, repository) { !routeAdmissionBlocked.value() }
            },
            harvester = harvesterOwnerRepository?.let { repository ->
                gg.pixelkingdomwars.nativeclient.ui.home.projectHomeHarvester(graph, session, repository) { !routeAdmissionBlocked.value() }
            })
    }
    val currentOwners = rememberUpdatedState(ownerProjections)
    val passportOwner = gg.pixelkingdomwars.nativeclient.ui.home.LocalHomePassportOwner.current?.takeIf { it.session === session }
    val passportOwnerState = passportOwner?.model?.state?.collectAsState()?.value
    val currentPassportOwner = rememberUpdatedState(passportOwner)
    gg.pixelkingdomwars.nativeclient.ui.home.HomePassportWarmRead(passportOwner, presentationIdentity) {
        !routeAdmissionBlocked.value() && currentRouteIdentity.value() == presentationIdentity &&
            currentOwners.value.let { owners -> owners.harvester?.projection?.reviewBlocked != true &&
                owners.vehicle?.projection?.reviewBlocked != true && owners.starter?.projection?.reviewBlocked != true &&
                owners.starterFleet?.projection?.reviewBlocked != true } && workshopOwnerRepository?.state?.value?.review == null &&
            !starterReviewPresence.painted && !voyageOverlays.presence.painted && !harvesterReviewPresence.painted &&
            session.base.state.value.base?.buildings?.any { it.type == "lodge" && it.level > 0 && !it.underConstruction } == true
    }
    val harvesterRead = remember(presentationIdentity) { presentationIdentity?.let(::HomeFeatureReadCapture) }
    val starterFleetRead = remember(presentationIdentity) { presentationIdentity?.let(::HomeFeatureReadCapture) }
    val featureReadRevision = listOf(harvesterRead?.status, starterFleetRead?.status)
    // Observe every borrowed flow so a warming owner or a closing review can retry a deferred head.
    val harvesterOwnerState = ownerProjections.harvester?.projection?.state?.collectAsState()?.value
    val vehicleOwnerState = ownerProjections.vehicle?.projection?.state?.collectAsState()?.value
    val starterOwnerState = ownerProjections.starter?.projection?.state?.collectAsState()?.value
    val starterFleetOwnerState = ownerProjections.starterFleet?.projection?.state?.collectAsState()?.value
    val workshopOwnerState = workshopOwnerRepository?.state?.collectAsState()?.value
    val harvesterReviewController = remember(session, presentationIdentity, harvesterOwnerRepository) {
        presentationIdentity?.let { identity -> harvesterOwnerRepository?.let { repository ->
            gg.pixelkingdomwars.nativeclient.ui.home.HomeHarvesterReviewController(identity,
                { gg.pixelkingdomwars.nativeclient.ui.home.homeOwnerProjectionIdentity(graph, session) },
                { !routeAdmissionBlocked.value() && kingdom.state.value.ordersAllowed && kingdom.state.value.deedActionsAllowed &&
                    currentOwners.value.let { owners -> owners.vehicle?.projection?.reviewBlocked != true &&
                        owners.starter?.projection?.reviewBlocked != true && owners.starterFleet?.projection?.reviewBlocked != true } &&
                    workshopOwnerRepository?.state?.value?.review == null && !starterReviewPresence.painted },
                { repository.state.value }, { kingdom.state.value.selectedBuilding?.takeIf { it.type == "harvester" }?.id },
                repository::reviewSelection, repository::reviewSaved, { repository.confirm(it) }, repository::dismiss)
        } }
    }
    // Gold Forge in place: a Gem-spend shortfall waiting for the GEMS tab, and whether its Smelt or Gems Seal (or a
    // payment) is up. While it is, the sheet refuses close (scrim tap, Back) and the dispatcher defers every other door.
    val gemsShortfall = remember(session) { gg.pixelkingdomwars.nativeclient.ui.goldforge.GoldForgeGemsShortfallBox() }
    val goldForgeReviewOpen = remember(session) { mutableStateOf(false) }
    // Owner report 2026-10-11 (Seeker, code 34): each term is named, so a deferred door's PKWHome line says which one held.
    val bodyReviewTerms = rememberUpdatedState(listOf<Pair<String, () -> Boolean>>(
        "harvester.review" to { currentOwners.value.harvester?.projection?.reviewBlocked == true },
        "vehicle.review" to { currentOwners.value.vehicle?.projection?.reviewBlocked == true },
        "starter.review" to { currentOwners.value.starter?.projection?.reviewBlocked == true },
        "starterFleet.review" to { currentOwners.value.starterFleet?.projection?.reviewBlocked == true },
        "workshop.review" to { workshopOwnerRepository?.state?.value?.review != null },
        "starter.painted" to { starterReviewPresence.painted },
        "voyage.painted" to { voyageOverlays.presence.painted },
        "harvester.holding" to { harvesterReviewController?.holding == true },
        "harvester.painted" to { harvesterReviewPresence.painted },
        "goldForge.review" to { goldForgeReviewOpen.value }))
    val bodyReviewBlocked = rememberUpdatedState<() -> Boolean> { bodyReviewTerms.value.any { (_, held) -> held() } }
    val starterReviewController = remember(session, presentationIdentity, starterFleetOwnerRepository) {
        presentationIdentity?.let { identity -> starterFleetOwnerRepository?.let { repository ->
            gg.pixelkingdomwars.nativeclient.ui.home.HomeStarterFleetReviewController(identity,
                { gg.pixelkingdomwars.nativeclient.ui.home.homeOwnerProjectionIdentity(graph, session) },
                { !routeAdmissionBlocked.value() && currentOwners.value.let { owners ->
                    owners.harvester?.projection?.reviewBlocked != true && owners.vehicle?.projection?.reviewBlocked != true &&
                        owners.starter?.projection?.reviewBlocked != true && workshopOwnerRepository?.state?.value?.review == null
                } }, { repository.state.value }, { kingdom.state.value.selectedBuilding?.takeIf { it.type == "berth" }?.id },
                repository::reviewInstall, repository::reviewSaved, { repository.confirm(it) }, repository::dismiss, { repository.finish() },
                { repository.archiveDraftOrRefusal() })
        } }
    }
    val legacyFeatureOpen = rememberUpdatedState<(gg.pixelkingdomwars.nativeclient.ui.features.FeatureId) -> Boolean> { id ->
        // The Menu stays reachable in every state (review bc22f635): a deferred badge request opens the standalone Profile,
        // exactly as HomeScaffold's fallback does at the tap (owner report 2026-10-11).
        if (id.value == "hud.profile") { navController.navigate(ProfileRoute) { launchSingleTop = true }; true }
        else if (routeAdmissionBlocked.value() || bodyReviewBlocked.value() || currentRouteIdentity.value() == null) false
        else when (id.value) {
            "harvester.harvest" -> {
                homeHarvesterLegacyNotice(harvesterRead?.status)?.let {
                    gg.pixelkingdomwars.nativeclient.ui.chrome.Toasts.post(it)
                }
                kingdom.clearSelection(); navController.navigate(HarvesterRoute) { launchSingleTop = true }; true
            }
            // Voyage gap audit: EXPLORE opens only the designed Lodge sheet; when Home cannot open it now, the dispatcher
            // says why instead of falling back to the old starter expedition screen.
            "lodge.expedition" -> false
            "market.trade" -> {
                val selection = kingdom.state.value.selectedBuilding
                val owner = fleet?.owners?.firstOrNull { it.destination == gg.pixelkingdomwars.nativeclient.ui.economy.FleetCommandDestination.KEEP_MARKET && it.available }
                if (owner != null && selection?.type == "market" &&
                    session.base.state.value.base?.buildings?.singleOrNull { it.id == selection.id }?.let {
                        it.type == "market" && it.level > 0 && !it.underConstruction
                    } == true) { owner.open(); true } else false
            }
            "berth.fleet" -> false
            else -> false
        }
    }
    val localRouteHost = remember(session, reviewGate) {
        HomeSheetRouteHost({ currentRouteIdentity.value() }, { routeAdmissionBlocked.value() },
            { reason -> gg.pixelkingdomwars.nativeclient.ui.chrome.Toasts.post(reason) },
            { reviewGate.blocked.value }, { currentPresentationIdentity.value() },
            bodyReady = { destination ->
                val owners = currentOwners.value
                when (destination) {
                    is Destination.Harvester -> owners.harvester?.projection?.currentState() != null
                    is Destination.Lodge -> if (destination.tab == "PASSPORT") currentPassportOwner.value?.current() == true
                        else owners.starterFleet?.projection?.currentState() != null
                    is Destination.Berth -> owners.starterFleet?.projection?.currentState() != null
                    else -> true
                }
            }, bodyReviewBlocked = { bodyReviewBlocked.value() }, featureRead = { id ->
                val proof = when (id.value) {
                    "harvester.harvest" -> harvesterRead
                    "berth.starter" -> starterFleetRead
                    else -> null
                }
                if ((id.value == "harvester.harvest" && harvesterOwnerRepository == null) ||
                    (id.value == "berth.starter" && starterFleetOwnerRepository == null)) HomeNavigationResult.REFUSED
                else if (id.value !in setOf("harvester.harvest", "berth.starter")) HomeNavigationResult.DISPATCHED
                else homeFeatureReadResult(proof, graph.homeRequests.pending.value as? HomeRequest.Open,
                    if (id.value == "harvester.harvest") currentOwners.value.harvester?.projection?.currentState()?.busy
                    else currentOwners.value.starterFleet?.projection?.currentState()?.busy)
            }, legacyFeature = { legacyFeatureOpen.value(it) },
            deferralDetail = { gg.pixelkingdomwars.nativeclient.ui.home.homeHeldTerms(bodyReviewTerms.value) },
            debugLog = { line ->
                if (gg.pixelkingdomwars.nativeclient.BuildConfig.DEBUG || gg.pixelkingdomwars.nativeclient.BuildConfig.NATIVE_CANDIDATE)
                    gg.pixelkingdomwars.nativeclient.diagnostics.DeviceLog.debug("PKWHome", line)
            }, bodyUnavailable = { destination -> when {
                destination is Destination.Harvester && harvesterOwnerRepository == null -> "Saved Harvester storage is unavailable. Open Harvester controls to recover it."
                destination is Destination.Lodge && destination.tab == "PASSPORT" && currentPassportOwner.value?.current() != true -> "Passport records are unavailable for this session."
                destination is Destination.Lodge && destination.tab != "PASSPORT" && starterFleetOwnerRepository == null -> "Saved fleet storage is unavailable. Open the existing fleet controls to recover it."
                destination is Destination.Berth && starterFleetOwnerRepository == null -> "Saved fleet storage is unavailable. Open the existing fleet controls to recover it."
                else -> null
            } })
    }
    val suppliedRouteHost = LocalHomeRouteHost.current
    val routeHost = suppliedRouteHost ?: localRouteHost
    val routeDispatchBlocked = routeHost?.dispatchBlocked?.collectAsState()?.value ?: true
    val routeDispatcher = remember(graph, session, kingdom, routeHost) {
        routeHost?.let { host ->
            HomeRouteDispatcher(graph.homeRequests, FeatureRegistry.canonical(), current = {
                val fresh = if (graph.sessionGraph.value !== session) null else homeRouteContext(
                    graph.account.state.value, session.session, graph.holder.current,
                    session.base.state.value, kingdom.state.value,
                )
                fresh?.let {
                    val owners = currentOwners.value
                    val harvester = owners.harvester?.projection?.currentState()
                    val starterFleet = owners.starterFleet?.projection?.currentState()
                    val forgeFacts = gg.pixelkingdomwars.nativeclient.ui.goldforge.goldForgeGateFacts(
                        wallet = session.session.wallet, baseId = it.identity.baseId, current = true,
                        gemsSupported = session.base.state.value.balances?.features?.gems?.supported,
                        gemsBuy = session.gemsBuy.state.value,
                        contribution = runCatching { session.miningContribution.state.value }.getOrNull(),
                        economy = session.economy.state.value)
                    val observedFeatures = mapOf(
                        "phaseE.passport" to gg.pixelkingdomwars.nativeclient.ui.home.homePassportFeatureFact(
                            currentPassportOwner.value?.takeIf { owner -> owner.current() }?.model?.state?.value),
                        "gems" to if (session.base.state.value.balances?.features?.gems?.supported == true)
                            gg.pixelkingdomwars.nativeclient.ui.features.GateFact.Allowed
                            else gg.pixelkingdomwars.nativeclient.ui.features.GateFact.Unknown,
                        "phaseE.harvesters" to homeObservedFeatureFact(harvesterRead?.status == HomeFeatureReadStatus.READY,
                            owners.harvester?.projection?.identity == it.identity && harvester != null,
                            harvester?.advertised == true && harvester.view?.baseId == it.identity.baseId && harvester.view?.wallet == session.session.wallet),
                        "phaseE.starterFleet" to homeObservedFeatureFact(starterFleetRead?.status == HomeFeatureReadStatus.READY,
                            owners.starterFleet?.projection?.identity == it.identity && starterFleet != null,
                            starterFleet?.advertised == true && starterFleet.view?.baseId == it.identity.baseId && starterFleet.view?.wallet == session.session.wallet),
                        "tester.campaignLive" to gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live.homeEventFeatureFact(session.tester.state.value, session.playtest.state.value))
                    val gates = it.gates
                    HomeRouteContext(it.identity, GateContext(baseId = gates.baseId, walletLinked = gates.walletLinked,
                        keepLevel = gates.keepLevel, buildings = gates.buildings, serverFeatures = gates.serverFeatures + observedFeatures + forgeFacts.serverFeatures,
                        ownerFacts = gates.ownerFacts, history = gates.history + forgeFacts.history, selection = gates.selection))
                }
            }, host = host)
        }
    }
    // hub SPEC §3.2: a toast's GO opens its feature through the same typed Home door (gates, refusals) as a HUD tap.
    DisposableEffect(routeDispatcher) {
        val binding = routeDispatcher?.let { d -> gg.pixelkingdomwars.nativeclient.ui.chrome.ToastDoors.bindGo { feature -> d.handleFeatureDoor(feature) } }
        onDispose { binding?.close() }
    }
    // One optional Harvester GET per Home presentation. It never races ahead of a queued explicit preparation.
    LaunchedEffect(harvesterRead, ownerProjections, lifecycle) {
        val proof = harvesterRead ?: return@LaunchedEffect
        if (harvesterOwnerRepository == null || ownerProjections.harvester == null) return@LaunchedEffect
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            val signals = listOf<kotlinx.coroutines.flow.Flow<*>>(
                snapshotFlow { routeAdmissionBlocked.value() || bodyReviewBlocked.value() },
                graph.account.state, session.base.state, kingdom.state, kingdom.busy, army.busy, attack.busy,
                attack.chooser, session.battle.state, session.interlock.state, layout.state, graph.back.changes,
                lifecycle.currentStateFlow, reviewGate.blocked, graph.homeRequests.pending) + listOfNotNull(
                ownerProjections.harvester?.projection?.state, ownerProjections.starterFleet?.projection?.state,
                ownerProjections.starter?.projection?.state, ownerProjections.vehicle?.projection?.state, workshopOwnerRepository?.state)
            awaitHomeReadAdmission(signals) {
                !routeAdmissionBlocked.value() && !bodyReviewBlocked.value() &&
                    currentRouteIdentity.value() == proof.identity && homeHasCompletedHarvester(session.base.state.value, proof.identity)
            }
            val pending = graph.homeRequests.pending.value as? HomeRequest.Open
            if (proof.claimWarmRead(requestPending = pending?.featureId?.value == "harvester.harvest"))
                proof.refresh(read = { ownerProjections.harvester?.refresh?.invoke(Unit) == true }) {
                    currentRouteIdentity.value() == proof.identity
                }
            kotlinx.coroutines.awaitCancellation()
        }
    }
    // A request-specific GET supplies the canonical registry fact. It never runs a starter departure driver.
    // This effect deliberately is not keyed to busy/data emissions from the read it is awaiting.
    LaunchedEffect(homeRequest, ownerProjections, lifecycle) {
        val request = homeRequest as? HomeRequest.Open ?: return@LaunchedEffect
        val proof = when (request.featureId.value) {
            "harvester.harvest" -> harvesterRead
            "berth.starter" -> starterFleetRead
            else -> null
        } ?: return@LaunchedEffect
        if (request.identity != proof.identity) return@LaunchedEffect
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            val signals = listOf<kotlinx.coroutines.flow.Flow<*>>(
                snapshotFlow { routeAdmissionBlocked.value() || bodyReviewBlocked.value() },
                graph.account.state, session.base.state, kingdom.state, kingdom.busy, army.busy, attack.busy,
                attack.chooser, session.battle.state, session.interlock.state, layout.state, graph.back.changes,
                lifecycle.currentStateFlow, reviewGate.blocked) + listOfNotNull(
                ownerProjections.harvester?.projection?.state, ownerProjections.starterFleet?.projection?.state,
                ownerProjections.starter?.projection?.state, ownerProjections.vehicle?.projection?.state, workshopOwnerRepository?.state)
            awaitHomeReadAdmission(signals) { !routeAdmissionBlocked.value() && !bodyReviewBlocked.value() }
            val current = { graph.homeRequests.pending.value === request && currentRouteIdentity.value() == request.identity }
            if (current()) proof.refreshFor(request, read = {
                when (request.featureId.value) {
                    "harvester.harvest" -> ownerProjections.harvester?.refresh?.invoke(Unit) == true
                    "berth.starter" -> ownerProjections.starterFleet?.refresh?.invoke(Unit) == true
                    else -> false
                }
            }, current = current)
            kotlinx.coroutines.awaitCancellation()
        }
    }
    val buildingDispatcher = remember(routeDispatcher, suppliedRouteHost, kingdomAudio.selectedBuilding?.type) {
        routeDispatcher?.takeIf { suppliedRouteHost != null || (homeMountedBuildingType(kingdomAudio.selectedBuilding?.type) || homeMountedWorkshopBuildingType(kingdomAudio.selectedBuilding?.type) || homeMountedMarketBuildingType(kingdomAudio.selectedBuilding?.type)) }?.let { dispatcher ->
            PhaseEBuildingDispatcher(
                openFeature = { id -> dispatcher.openFeature(id) },
                openResources = { id, resources -> dispatcher.openResources(id, resources) },
                currentSelection = dispatcher::currentSelection,
            )
        }
    }
    LaunchedEffect(route?.destination?.id) {
        if (route?.destination?.hasRoute<HomeRoute>() == false) { armyLiveSheet = null; attack.closeChooser() }
    }
    LaunchedEffect(kingdom, route?.destination?.id) {
        if (route?.destination?.hasRoute<HomeRoute>() == false) kingdom.clearSelection()
    }
    LaunchedEffect(session, chatEligible, route) {
        if (!chatEligible || route?.destination?.hasRoute<HomeRoute>() != true) hostedChat = false
    }
    recovery.error?.let { failure ->
        AlertDialog(onDismissRequest = {}, title = { Text("MARCH RECOVERY INTERRUPTED") },
            text = { Text("Your kingdom may have a pending march. Check again before starting another.\n$failure") },
            confirmButton = { TextButton(onClick = { recoveryAttempt++ }, enabled = !recovery.checking) { Text("CHECK AGAIN") } },
            dismissButton = { TextButton(onClick = onExit) { Text("EXIT") } })
    }
    BoxWithConstraints(Modifier.fillMaxSize()) {
    val hostedFrame = hostedChatFrame(maxWidth, maxHeight)
    val chatFrame = hostedFrame.dock
    val openMore: (MoreDestination) -> Unit = { destination -> when (destination) {
        // Over the base the chat is an overlay (community/ChatDock.kt: portrait sheet, landscape side panel) so the
        // scene stays visible; elsewhere (MORE tab, a disabled launcher) it is still the full ChatRoute.
        MoreDestination.CHAT -> if (chatEligible && chatLauncher.enabled && chatFrame.docked) {
            session.chat.setLauncherOpen(true); hostedChat = true
        } else navController.navigate(ChatRoute) { launchSingleTop = true }
        MoreDestination.LAND -> openLand()
        MoreDestination.BASES -> navController.navigate(BasesRoute()) { launchSingleTop = true }
        else -> navController.navigate(when (destination) {
            MoreDestination.RESEARCH -> ResearchRoute; MoreDestination.HEROES -> HeroesRoute(); MoreDestination.INVENTORY -> InventoryRoute
            MoreDestination.TESTER -> TesterRoute; MoreDestination.FEEDBACK -> FeedbackRoute; MoreDestination.CLANS -> ClansRoute; MoreDestination.CHAT -> ChatRoute; MoreDestination.MAIL -> MailRoute; MoreDestination.LEAGUES -> LeaguesRoute
            MoreDestination.SHOP -> ShopRoute; MoreDestination.ECONOMY -> EconomyRoute; MoreDestination.MARKET -> MarketRoute(); MoreDestination.CODEX -> CodexRoute
            MoreDestination.QUESTS -> QuestsRoute; MoreDestination.ABOUT -> AboutRoute; MoreDestination.SETTINGS -> SettingsRoute; else -> AccountRoute
        })
    } }
    val voyageReturnAction = gg.pixelkingdomwars.nativeclient.ui.home.rememberHomeVoyageReturnAction(graph, session,
        presentationIdentity, ownerProjections, voyageOverlays,
        admitted = { !routeAdmissionBlocked.value() && !bodyReviewBlocked.value() },
        openFeature = { if (routeDispatcher?.openFeature(gg.pixelkingdomwars.nativeclient.ui.features.FeatureId(it)) != true)
            localRouteHost.locked("This feature is not available in the current Home view.") },
        explain = localRouteHost::locked)
    // Home's SOL base purchases in place (HIRE BUILDER, Keep EXPAND, a SOL-step upgrade): the SAME owner and wallet sender
    // BasePurchaseRoute builds. A session that is no longer current gets no sender, so Home keeps the old purchase screen.
    val homePurchaseModel = graphViewModel(session) { gg.pixelkingdomwars.nativeclient.ui.kingdom.BasePurchaseViewModel(session.basePurchases) }
    val homePurchaseSender = remember(session, wallet) { runCatching { graph.basePurchaseWallet(session, wallet) }.getOrNull() }
    val homeSolPurchase = remember(homePurchaseModel, homePurchaseSender) {
        homePurchaseSender?.let { gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live.HomeSolPurchase(homePurchaseModel, it) }
    }
    // S-F: the live Seeker Island auction for the World tab's island sheet; null (no devnet TEST pins) keeps the designed panel.
    val seekerAuctionSlot = gg.pixelkingdomwars.nativeclient.ui.world.rememberSeekerAuctionSlot(graph, session, wallet)
    // The ordinary-crafting owner's view for the drawer's material strips, the Workshop bar fact and Keep STORES; a refresh
    // clears its view while it reads, so the last view is held (rememberDrawerCrafting) and nothing already shown blanks.
    val homeCrafting = remember(session) { runCatching { session.ordinaryCrafting }.getOrNull() }
    val homeCraftingState = homeCrafting?.state?.collectAsState()?.value
    val drawerCrafting = gg.pixelkingdomwars.nativeclient.ui.hud.rememberDrawerCrafting(homeCraftingState)
    val homeBuildNewTypes = remember(kingdomAudio) {
        gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live.newlyUnlockedBuildTypes(
            gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live.readTrayFacts(kingdomAudio, busy = false))
    }
    // Keep STORES is a TALL sheet like the BUILD tray: while it is drawn the HUD takes its BUILD form (KingdomScreen reports it).
    var keepStoresShown by remember(session) { mutableStateOf(false) }
    CompositionLocalProvider(LocalHomeRouteDispatcher provides routeDispatcher,
        gg.pixelkingdomwars.nativeclient.ui.home.LocalHomeVoyageReturnAction provides voyageReturnAction,
        gg.pixelkingdomwars.nativeclient.ui.home.LocalHomeOwnerProjections provides ownerProjections) {
    PhaseEBuildingDispatcherScope(buildingDispatcher) {
    @SuppressLint("StateFlowValueCalledInComposition") // Deliberate: HUD wallet sessionCurrent guard (MS-UI1 173d9672): the freshest session fails closed in a lagging frame; this scope reads the collected `account`, so it recomposes.
    val walletSessionCurrent = graph.sessionGraph.value === session && graph.account.state.value.session === session.session && graph.holder.current === session.session
    HomeScaffold(account, home, local, CatalogueTimings.exitConfirmMs(content.catalogue), graph.homeRequests, openLand, onExit,
        onOpen = openMore,
        onForge = { id -> routeDispatcher?.handleFeatureDoor(id) },
        wallet = currentHomeWallet(economyHud.wallet,
            sessionCurrent = walletSessionCurrent,
            loading = economyHud.loading, readErrors = economyHud.errors), mail = mailHud.status, tester = testerHud.progress, unreadRaids = unreadRaids, defenceNotice = defenceNotice,
        chatEnabled = chatEligible && chatLauncher.enabled, chatUnread = chatLauncher.unread, chatMentions = chatLauncher.mentions, chatOpen = chatLauncher.open,
        obscuredByChat = hostedChat && chatEligible && !chatFrame.docked,
        onProfile = { navController.navigate(ProfileRoute) { launchSingleTop = true } },
        onRaidLog = { defenceNotice = null; navController.navigate(RaidLogRoute) { launchSingleTop = true } },
        onCache = kingdom::openDailyCache,
        onPurchases = { navController.navigate(BasePurchaseRoute()) { launchSingleTop = true } },
        buildOpen = kingdomAudio.local.buildMenu && !kingdomAudio.local.heroesOnly || keepStoresShown, // HEROES is priced in KEEP: its HUD stays whole
        buildEnabled = !kingdomBusy && kingdomAudio.base != null && !kingdomAudio.constructionBlocked && kingdomAudio.deedActionsAllowed,
        buildReadOnly = !kingdomAudio.ordersAllowed || !kingdomAudio.deedActionsAllowed,
        buildRefusalReason = homeBuildRefusalReason(
            savedConstruction = kingdomAudio.constructionBlocked, busy = kingdomBusy, baseLoaded = kingdomAudio.base != null,
            deedActionsAllowed = kingdomAudio.deedActionsAllowed, raidKnown = interlock.known,
            raidActive = kingdomAudio.activeRaid != null, ordersAllowed = kingdomAudio.ordersAllowed,
            savedClosable = kingdomAudio.constructionClosable),
        buildSavedConstruction = kingdomAudio.constructionBlocked,
        actionsEnabled = kingdomAudio.ordersAllowed && kingdomAudio.deedActionsAllowed && !kingdomBusy,
        immersive = layoutAudio.open,
        armySheetOpen = armyLiveSheet != null,
        toolsAllowed = kingdomAudio.deedActionsAllowed, toolsBusy = kingdomBusy,
        showTasks = armyLiveSheet == null && !layoutAudio.open && kingdomAudio.local.let {
            !it.buildMenu && it.placement == null && it.sheet == null && it.selectedBuildingId == null && it.selectedObstacleId == null
        } && fleet?.destination() == null, // an open fleet form (VEHICLES & EXPEDITIONS…) sits under the HUD: the deck and tabs step aside
        openFeature = routeDispatcher?.let { dispatcher -> { id -> dispatcher.handleFeatureDoor(id) } },
        openResources = routeDispatcher?.let { dispatcher -> { id, resources -> dispatcher.openResources(id, resources) } },
        homeLayerHost = { tab, layer ->
            StableHomeLayer(presentationIdentity, hooks = { identity ->
                val scope = SheetScope(homeRouteSessionId(session.session), identity.baseId, identity.baseSelectionGeneration)
                // Histories survive a transient routing/model lag; account/base changes get a new scope.
                val histories = rememberHomeSheetStacks(scope)
                key(tab) {
                    if (tab != HomeTab.KINGDOM || suppliedRouteHost != null) {
                        HomeLayerHooks(resourcesBlocked = routeAdmissionBlocked.value())
                    } else {
                        val stack = mountedHomeSheetStack(histories.value.forScope(scope).selectTab(tab).active)
                        val sheet = rememberSheetHostState(scope, stack) { requireNotNull(mountedHomeSheetFrame(it)) }
                        val lease = remember(localRouteHost, identity, tab) { Any() }
                        val nestedBack = remember(localRouteHost, identity, tab) { HomeBodyBack() }
                        var goldForgeStack by remember(identity) { mutableStateOf<List<gg.pixelkingdomwars.nativeclient.ui.model.ResourceChipUi>?>(null) }
                        // The Lodge SEND tab's chosen-trip supplies (voyage SPEC §0.2 item 4); null hands the HUD its own rows.
                        var voyageStack by remember(identity) { mutableStateOf<List<gg.pixelkingdomwars.nativeclient.ui.model.ResourceChipUi>?>(null) }
                        var goldForgeNotice by remember(identity) { mutableStateOf<String?>(null) }
                        var goldForgeDoor by remember(identity) { mutableStateOf<gg.pixelkingdomwars.nativeclient.ui.goldforge.GoldForgeHomeDoor?>(null) }
                        // On the first mounted frame, show unknown wallet rows before the read observer reports.
                        val goldForgeRows = goldForgeStack ?: if (stack.top?.destination is Destination.GoldForge)
                            gg.pixelkingdomwars.nativeclient.ui.goldforge.goldForgeHomeUi(
                                gg.pixelkingdomwars.nativeclient.ui.goldforge.GoldForgeHomeData(identity, session.session.wallet), identity).sheet.stack
                            else null
                        val handoff: (() -> Unit) -> Unit = { open ->
                            localRouteHost.handoffOwnedSheet(lease, clearSelection = kingdom::clearSelection, pop = {
                                val current = histories.value.forScope(scope).selectTab(tab)
                                histories.value = current.copy(kingdom = mountedHomeSheetStack(current.kingdom).pop())
                            }, open = open)
                        }
                        val pop: () -> Unit = {
                            localRouteHost.closeOwnedSheet(lease, clearSelection = kingdom::clearSelection) {
                                val current = histories.value.forScope(scope).selectTab(tab)
                                histories.value = current.copy(kingdom = mountedHomeSheetStack(current.kingdom).pop())
                            }
                        }
                        // Gold Forge in place: SMELT and GEMS act on the designed sheet through bindings over the existing view
                        // models, created only while the forge is the top sheet. Their Seals compose in the overlay after SheetHost.
                        // The old owner routes stay reachable only from the notice door while a binding is missing.
                        var goldForgeAlert by remember(identity) { mutableStateOf<String?>(null) }
                        var goldForgeAlertClosed by remember(identity) { mutableStateOf(false) }
                        var goldForgeExplained by remember(identity) { mutableStateOf<String?>(null) }
                        val forgeOpen = stack.top?.destination is Destination.GoldForge
                        val forgeOnTop = { histories.value.forScope(scope).selectTab(tab).active.top?.destination is Destination.GoldForge }
                        val forgeCurrent = {
                            graph.sessionGraph.value === session && graph.holder.current === session.session &&
                                currentPresentationIdentity.value() == identity && lifecycle.currentState == Lifecycle.State.RESUMED && forgeOnTop()
                        }
                        val forgeOrders = content.allowsGameOrders(graph.versionCode) && interlock.actionsAllowed
                        val toForgeTab: (String) -> Unit = { selected ->
                            if (localRouteHost.canUseReadControl(lease) && forgeOnTop()) {
                                val current = histories.value.forScope(scope).selectTab(tab)
                                histories.value = current.copy(kingdom = mountedHomeSheetStack(current.kingdom).updateTop(selectedTab = selected))
                            } else localRouteHost.explainReadRefusal(lease)
                        }
                        val forgeScope = rememberCoroutineScope()
                        val forgeContribution = remember(session) { runCatching { session.miningContribution }.getOrNull() }
                        val forgeSmelt = if (!forgeOpen) null else forgeContribution?.let { repository ->
                            gg.pixelkingdomwars.nativeclient.ui.goldforge.rememberGoldForgeSmeltBinding(
                                graphViewModel(session) { gg.pixelkingdomwars.nativeclient.ui.economy.MiningContributionViewModel(repository) },
                                session.session.wallet, identity.baseId, identity.baseSelectionGeneration, forgeOrders, forgeCurrent,
                                onFindRaid = { handoff { graph.homeRequests.request(HomeRequest.RaidChooser) } },
                                onGoWorkshop = { handoff { routeDispatcher?.handleFeatureDoor(gg.pixelkingdomwars.nativeclient.ui.features.FeatureId("workshop.craft")) } },
                                onGoBuild = { handoff { graph.homeRequests.request(HomeRequest.BuildMenu) } },
                                onGoClaim = { toForgeTab("CLAIM") },
                                onExplain = { goldForgeExplained = it })
                        }
                        // GEMS › CONVERT: Gems into SHARDS as its own Seal over the existing Gems owner (no hop to the old page).
                        val forgeConvert = if (!forgeOpen) null else gg.pixelkingdomwars.nativeclient.ui.goldforge.rememberGoldForgeConvert(
                            graphViewModel(session) { gg.pixelkingdomwars.nativeclient.ui.economy.GemsViewModel(session.gems) },
                            identity.baseSelectionGeneration, forgeOrders, forgeCurrent, onExplain = { goldForgeExplained = it })
                        val forgeSender = remember(session, wallet) { runCatching { graph.gemsBuyWallet(session, wallet) }.getOrNull() }
                        val forgeGems = if (!forgeOpen || forgeSender == null) null else
                            gg.pixelkingdomwars.nativeclient.ui.goldforge.rememberGoldForgeGemsBinding(
                                graphViewModel(session) { gg.pixelkingdomwars.nativeclient.ui.economy.GemsBuyViewModel(session.gemsBuy, session.gemsBuyPayment::prepare, session.gemsBuyBalances::refresh) },
                                forgeSender, session.gemsBuyBalances, session.session.wallet,
                                gg.pixelkingdomwars.nativeclient.data.KeepDepositBounds.from(content.catalogue), forgeCurrent,
                                shortfall = gemsShortfall.pending?.takeIf { it.identity == identity },
                                onShortfallUsed = gemsShortfall::clear,
                                onConvert = forgeConvert?.open,
                                onGoClaim = { toForgeTab("CLAIM") },
                                onReturn = { id -> forgeScope.launch {
                                    // The purchase was just finished: wait for its Seal hold to clear, then leave for the building.
                                    snapshotFlow { goldForgeReviewOpen.value }.first { open -> !open }
                                    handoff { graph.homeRequests.request(HomeRequest.FocusBuilding(id)) }
                                } },
                                onExplain = { goldForgeExplained = it })
                        SideEffect { goldForgeReviewOpen.value = forgeSmelt?.reviewOpen == true || forgeGems?.reviewOpen == true }
                        SideEffect { if (forgeConvert?.reviewOpen == true) goldForgeReviewOpen.value = true }
                        DisposableEffect(localRouteHost, identity, tab) {
                            val mount = localRouteHost.attach(identity,
                                openLeague = { destination ->
                                    if (currentRouteIdentity.value() == identity) {
                                        val saved = histories.value.forScope(scope).selectTab(tab)
                                        val current = saved.copy(kingdom = mountedHomeSheetStack(saved.kingdom))
                                        histories.value = if (current.active.top?.destination is Destination.Leagues)
                                            current.replace(destination) else current.push(destination)
                                    }
                                },
                                closeSceneSheet = { sheet.closesOnSceneTap && sheet.close({ false }, pop) },
                                owner = lease, sceneCovered = { sheet.visible },
                                openBody = { destination ->
                                    if (currentRouteIdentity.value() == identity) {
                                        val saved = histories.value.forScope(scope).selectTab(tab)
                                        val current = saved.copy(kingdom = mountedHomeSheetStack(saved.kingdom))
                                        histories.value = if (current.active.top?.destination?.javaClass == destination.javaClass)
                                            current.replace(destination) else current.push(destination)
                                    }
                                })
                            onDispose { mount.close() }
                        }
                        val blocked = routeAdmissionBlocked.value() || reviewBlocked || bodyReviewBlocked.value()
                        SideEffect { localRouteHost.reportBlocked(lease, blocked) }
                        val reducedMotion = gg.pixelkingdomwars.nativeclient.ui.LocalReducedMotion.current
                        HomeLayerHooks(
                            homeCovered = sheet.fullCardVisible,
                            // This read-only stack contains wallet KEEP; the Home drawer describes custodial funds.
                            resourcesBlocked = blocked || goldForgeRows != null,
                            authoritativeResources = goldForgeRows ?: voyageStack?.takeIf { stack.top?.destination is Destination.Lodge },
                            // An open fleet command form (Vehicles, Tools, Market, starter) is a tall sheet over Home too: the
                            // dock, edge buttons and land ticker step aside instead of drawing over its controls.
                            hideHudChrome = goldForgeRows != null || fleet?.destination() != null,
                            overlay = {
                                // error.png: the error toast takes the notice zone until the player closes it or a read recovers.
                                val forgeAlert = goldForgeAlert?.takeIf { !goldForgeAlertClosed && stack.top?.destination is Destination.GoldForge }
                                if (forgeAlert != null) gg.pixelkingdomwars.nativeclient.ui.goldforge.GoldForgeHomeAlert(forgeAlert,
                                    onReport = {
                                        if (localRouteHost.navigateResult(Destination.Feedback, HomeTab.KINGDOM) != HomeNavigationResult.DISPATCHED)
                                            localRouteHost.locked("This sheet is waiting for its current owner. Try again.")
                                    }, onClose = { goldForgeAlertClosed = true },
                                    modifier = Modifier.align(androidx.compose.ui.Alignment.TopStart).zIndex(1f))
                                else gg.pixelkingdomwars.nativeclient.ui.goldforge.GoldForgeHomeNotice(goldForgeNotice,
                                    Modifier.align(androidx.compose.ui.Alignment.TopStart).zIndex(1f),
                                    door = goldForgeDoor.takeIf { stack.top?.destination is Destination.GoldForge },
                                    onOpenControls = { selected ->
                                        val currentTop = histories.value.forScope(scope).selectTab(tab).active.top
                                        if (!gg.pixelkingdomwars.nativeclient.ui.goldforge.goldForgeHomeDoorCurrent(stack.top,
                                                currentTop, goldForgeDoor, selected)) localRouteHost.locked("Open controls from the current Gold Forge tab.")
                                        else when (selected) {
                                        "SMELT" -> handoff { navController.navigate(MiningContributionRoute) { launchSingleTop = true } }
                                        "GEMS" -> handoff { navController.navigate(GemsBuyRoute) { launchSingleTop = true } }
                                        "LEGACY" -> handoff { navController.navigate(GoldForgeLegacyControlsRoute) { launchSingleTop = true } }
                                        "CLAIM" -> handoff { navController.navigate(BasesRoute(notice =
                                            if (goldForgeDoor?.claimEntryAvailable == true)
                                                "Open ACTIVITIES & RECEIPTS, then KEEP MINING & CLAIM RECEIPTS."
                                            else "Claim controls are unavailable or not yet checked. Existing activities and saved receipts remain in Bases.")) { launchSingleTop = true } }
                                        else -> localRouteHost.locked("These controls are unavailable from this tab.")
                                    } })
                                SheetHost(sheet, onPop = pop, onDismissNested = {
                                    if (bodyReviewBlocked.value()) { localRouteHost.explainReadRefusal(lease); true }
                                    else nestedBack.consume()
                                }, reducedMotion = reducedMotion) { entry, _, close, panel ->
                                    val changeTab: (String) -> Unit = { selected ->
                                        if (localRouteHost.canUseReadControl(lease)) {
                                            if (entry.destination is Destination.Workshop && selected == "EQUIPMENT") {
                                                if (!routeAdmissionBlocked.value() && fleet?.owners?.any {
                                                        it.destination == gg.pixelkingdomwars.nativeclient.ui.economy.FleetCommandDestination.EQUIPMENT && it.available
                                                    } == true)
                                                    handoff { fleet?.open(gg.pixelkingdomwars.nativeclient.ui.economy.FleetCommandDestination.EQUIPMENT) }
                                                else localRouteHost.locked("Tools are waiting for the current Workshop. Try again.")
                                            } else if (selected == "PASSPORT" && gg.pixelkingdomwars.nativeclient.ui.home.homePassportFeatureFact(
                                                currentPassportOwner.value?.takeIf { it.current() }?.model?.state?.value) != gg.pixelkingdomwars.nativeclient.ui.features.GateFact.Allowed) {
                                                localRouteHost.locked("Passport records are unavailable.")
                                            } else if (mountedHomeSheetFrame(entry.copy(selectedTab = selected)) != null) {
                                                val current = histories.value.forScope(scope).selectTab(tab)
                                                histories.value = current.copy(kingdom = mountedHomeSheetStack(current.kingdom).updateTop(selectedTab = selected))
                                            } else localRouteHost.locked("This tab is not available.")
                                        } else localRouteHost.explainReadRefusal(lease)
                                    }
                                    val legacy: (Destination) -> Unit = { destination ->
                                        if (localRouteHost.canUseReadControl(lease) && !routeAdmissionBlocked.value()) {
                                            when (destination) {
                                                is Destination.Harvester -> handoff { navController.navigate(HarvesterRoute) { launchSingleTop = true } }
                                                is Destination.Lodge -> handoff {
                                                    fleet?.open(gg.pixelkingdomwars.nativeclient.ui.economy.FleetCommandDestination.STARTER)
                                                        ?: navController.navigate(StarterExpeditionRoute) { launchSingleTop = true }
                                                }
                                                is Destination.Berth -> handoff { navController.navigate(StarterFleetRoute) { launchSingleTop = true } }
                                                else -> localRouteHost.locked("These controls are not available from this sheet.")
                                            }
                                        } else localRouteHost.explainReadRefusal(lease)
                                    }
                                    // A designed hub card opens another one in this sheet; a waiting owner says so instead.
                                    val openHub: (Destination) -> Unit = { destination ->
                                        if (localRouteHost.navigateResult(destination, HomeTab.KINGDOM) != HomeNavigationResult.DISPATCHED)
                                            localRouteHost.locked("This sheet is waiting for its current owner. Try again.")
                                    }
                                    // Craft doors (Workshop, Harvester GO rows): a designed sheet opens in this sheet; the KEEP Market opens
                                    // its existing owner on the requested tab. Every refusal says why.
                                    val craftDoor: (Destination) -> Unit = { destination ->
                                        when (destination) {
                                            is Destination.Market -> {
                                                val owner = fleet?.owners?.firstOrNull {
                                                    it.destination == gg.pixelkingdomwars.nativeclient.ui.economy.FleetCommandDestination.KEEP_MARKET && it.available
                                                }
                                                val opening = owner?.openEntry?.let { enter -> { enter(if (destination.tab == "SELL") "SELL" else "BUY") } } ?: owner?.open
                                                if (opening != null) handoff { opening() }
                                                else localRouteHost.locked("Market controls are unavailable for this kingdom.")
                                            }
                                            else -> openHub(destination)
                                        }
                                    }
                                    // A Workshop hub link opens the designed Workshop sheet on its tab; only a sheet Home cannot admit keeps
                                    // the original Workshop route.
                                    val openWorkshopTab: (String, () -> Unit) -> Unit = { selected, original ->
                                        if (localRouteHost.navigateResult(Destination.Workshop(selected), HomeTab.KINGDOM) != HomeNavigationResult.DISPATCHED)
                                            handoff(original)
                                    }
                                    // Every hub door (Mail, History, Event) lands on a sheet or an existing owner, or says why not.
                                    val openHubLink: (gg.pixelkingdomwars.nativeclient.ui.sheets.hub.HubLink) -> Unit = { link ->
                                        when (link.feature.value) {
                                            "hud.quests" -> openHub(Destination.Quests())
                                            "hud.mail" -> openHub(Destination.Mail)
                                            "settings.feedback", "profile.feedback" -> openHub(Destination.Feedback)
                                            "profile.kingdoms" -> openHub(Destination.Profile(tab = "KINGDOMS"))
                                            "profile.history" -> openHub(Destination.WalletHistory())
                                            "hud.attack" -> handoff { graph.homeRequests.request(HomeRequest.RaidChooser) }
                                            "workshop.craft" -> openWorkshopTab("INGOTS") { navController.navigate(WorkshopRoute) { launchSingleTop = true } }
                                            "refining.open" -> openWorkshopTab("REFINE") { navController.navigate(OrdinaryCraftingRoute()) { launchSingleTop = true } }
                                            "harvester.harvest" -> openHub(Destination.Harvester())
                                            // Voyage gap audit: these hub links open the designed Berth / Lodge sheets in place,
                                            // never the old starter fleet or expedition screens.
                                            "berth.fleet" -> openHub(Destination.Berth())
                                            "lodge.expedition" -> openHub(Destination.Lodge())
                                            // A wallet purchase recovers in place on the GEMS tab; a saved Gems request (from KEEP, to
                                            // Shards, a task reward) still belongs to its original Gems owner screen.
                                            "goldforge.gems" -> if (session.gems.state.value.pending.isNotEmpty())
                                                handoff { navController.navigate(GemsRoute) { launchSingleTop = true } }
                                                else openHub(Destination.GoldForge(tab = "GEMS"))
                                            else -> localRouteHost.locked("This destination is not available from this sheet yet.")
                                        }
                                    }
                                    when (entry.destination) {
                                    is Destination.Profile -> gg.pixelkingdomwars.nativeclient.ui.profile.ProfileHub(graph, session,
                                        graphViewModel(session) { ProfileViewModel(graph, session) }, graphViewModel(session) { AccountViewModel(graph, session) }, wallet,
                                        onBack = close, onEditProfile = { handoff { navController.navigate(ProfileEditRoute) { launchSingleTop = true } } },
                                        onSecurity = { handoff { navController.navigate(SecurityRoute) { launchSingleTop = true } } },
                                        onSeeker = { handoff { navController.navigate(SeekerRoute) { launchSingleTop = true } } },
                                        onRaidLog = { handoff { navController.navigate(RaidLogRoute) { launchSingleTop = true } } },
                                        // The designed Clan sheet opens in place (ProfileHub itself refuses without a finished Clan Hall).
                                        onClans = { openHub(Destination.Clan()) },
                                        onReferrals = { handoff { navController.navigate(ReferralsRoute) { launchSingleTop = true } } },
                                        onBases = { handoff { navController.navigate(BasesRoute()) { launchSingleTop = true } } },
                                        modifier = panel, hosted = true, selectedTab = entry.selectedTab ?: entry.destination.tab,
                                        onTab = changeTab, canRead = { localRouteHost.canUseReadControl(lease) },
                                        onSettings = { openHub(Destination.Settings()) },
                                        onDeedClaim = { handoff { navController.navigate(BaseClaimRoute) { launchSingleTop = true } } },
                                        onFeature = { link ->
                                            when (link.feature.value) {
                                                "hud.leagues" -> {
                                                    if (localRouteHost.navigateResult(Destination.Leagues(), HomeTab.KINGDOM) != HomeNavigationResult.DISPATCHED)
                                                        localRouteHost.locked("Leagues is waiting for its current owner. Try again.")
                                                }
                                                "hud.quests" -> openHub(Destination.Quests())
                                                "profile.feedback" -> openHub(Destination.Feedback)
                                                "profile.about" -> handoff { navController.navigate(AboutRoute) { launchSingleTop = true } }
                                                "profile.faucet" -> handoff { navController.navigate(FaucetRoute) { launchSingleTop = true } }
                                                "hud.dailyCache" -> handoff { kingdom.openDailyCache() }
                                                "hud.builders" -> handoff { graph.homeRequests.request(HomeRequest.Builders) }
                                                "profile.more" -> handoff { graph.homeRequests.request(HomeRequest.Tab(HomeTab.MORE)) }
                                                "hud.map" -> handoff { graph.homeRequests.request(HomeRequest.World(gg.pixelkingdomwars.nativeclient.data.WorldEntry.MyDeeds)) }
                                                "goldforge.open" -> handoff { routeDispatcher?.handleFeatureDoor(link.feature) }
                                                "profile.history" -> openHub(Destination.WalletHistory())
                                                "profile.seekerIsland" -> handoff { graph.homeRequests.request(HomeRequest.World(gg.pixelkingdomwars.nativeclient.data.WorldEntry.SeekerIsland)) }
                                                else -> localRouteHost.locked("This destination is not available from Profile yet.")
                                            }
                                        },
                                        // DAILY TEST SKR (devnet only; Hidden on mainnet) opens the SKR faucet half sheet in place; the
                                        // land doors open the designed land gate with the kind ProfileHub picks.
                                        skrFaucet = gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live.skrFaucetLocalState(
                                            graph.cluster == gg.pixelkingdomwars.nativeclient.wallet.SolanaCluster.DEVNET,
                                            gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live.landOwnedLive(account),
                                            gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live.skrFaucetClaimOpen(graph)) ?: gg.pixelkingdomwars.nativeclient.ui.sheets.account.FaucetUi.Hidden,
                                        onSkrFaucet = { openHub(Destination.SkrFaucet) },
                                        onLand = { kind -> handoff { navController.navigate(LandGateRoute(reason = "browse", kind = kind)) { launchSingleTop = true } } })
                                    is Destination.Clan -> ClanHub(graph, session,
                                        graphViewModel(session) { gg.pixelkingdomwars.nativeclient.ui.community.ClansViewModel(session.clans) },
                                        onBack = close,
                                        // The HUD's own CHAT door: the docked chat over the base, else the full ChatRoute.
                                        onChat = { handoff { openMore(MoreDestination.CHAT) } },
                                        onBuyLand = { handoff { navController.navigate(LandGateRoute(reason = "browse")) { launchSingleTop = true } } },
                                        onCharterControls = { handoff { navController.navigate(BasesRoute(notice = "Open ACTIVITIES & RECEIPTS, then CLAN CHARTERS & INVITATIONS.")) { launchSingleTop = true } } },
                                        onTournamentControls = { handoff { navController.navigate(BasesRoute(notice = "Open ACTIVITIES & RECEIPTS, then CLAN TOURNAMENTS & PRIZES.")) { launchSingleTop = true } } },
                                        modifier = panel, hosted = true, selectedTab = entry.selectedTab ?: entry.destination.tab,
                                        onTab = { selected ->
                                            if (localRouteHost.canUseReadControl(lease)) changeTab(selected)
                                            else localRouteHost.explainReadRefusal(lease)
                                        },
                                        canRead = { localRouteHost.canUseReadControl(lease) },
                                        // Feedback is a Home sheet since the hub screens (a51); the saved packet's route hop is replaced to match its siblings.
                                        onReport = { openHub(Destination.Feedback) })
                                    is Destination.Quests -> QuestsHub(graph, session,
                                        graphViewModel(session) { QuestsViewModel(graph, session) },
                                        onBack = close,
                                        onBuild = { handoff { graph.homeRequests.request(HomeRequest.BuildMenu) } },
                                        onTrain = { handoff { graph.homeRequests.request(HomeRequest.Training) } },
                                        onCampaign = { handoff { graph.homeRequests.request(HomeRequest.Campaign) } },
                                        onLand = { handoff { navController.navigate(LandGateRoute(reason = "browse")) { launchSingleTop = true } } },
                                        modifier = panel, hosted = true, selectedTab = entry.selectedTab ?: entry.destination.tab,
                                        onTab = { selected ->
                                            if (localRouteHost.canUseReadControl(lease)) changeTab(selected)
                                            else localRouteHost.explainReadRefusal(lease)
                                        },
                                        canRead = { localRouteHost.canUseReadControl(lease) },
                                        onReport = { openHub(Destination.Feedback) },
                                        onRaid = { handoff { graph.homeRequests.request(HomeRequest.RaidChooser) } })
                                    is Destination.GoldForge -> gg.pixelkingdomwars.nativeclient.ui.goldforge.GoldForgeHomeMount(
                                        graph, session, identity, { currentPresentationIdentity.value() },
                                        canRead = { localRouteHost.canUseReadControl(lease) }, onClose = close,
                                        canStartRead = { localRouteHost.canUseReadControl(lease) && !routeAdmissionBlocked.value() },
                                        modifier = panel, requestedTab = entry.destination.tab, selectedTab = entry.selectedTab,
                                        onTab = changeTab, onStack = { goldForgeStack = it }, onNotice = { goldForgeNotice = it },
                                        onDoor = { goldForgeDoor = it }, onOpenOwner = { owner ->
                                            val currentTop = histories.value.forScope(scope).selectTab(tab).active.top
                                            if (currentTop !== entry || !localRouteHost.canUseReadControl(lease))
                                                localRouteHost.explainReadRefusal(lease)
                                            else when (owner) {
                                                "LEGACY" -> handoff { navController.navigate(GoldForgeLegacyControlsRoute) { launchSingleTop = true } }
                                                // SPEC §1: History opens the designed history sheet filtered to the forge.
                                                "HISTORY" -> openHub(Destination.WalletHistory(home = "goldforge"))
                                                // The CLAIM DestinationRow: wallet details live on Profile's WALLET tab.
                                                "WALLET" -> openHub(Destination.Profile(tab = "WALLET"))
                                                else -> localRouteHost.locked("These controls are unavailable.")
                                            }
                                        },
                                        smeltBinding = forgeSmelt, gemsBinding = forgeGems,
                                        onAlert = { alert -> if (alert == null) goldForgeAlertClosed = false; goldForgeAlert = alert },
                                        explained = goldForgeExplained, onExplained = { goldForgeExplained = null })
                                    is Destination.Leagues -> gg.pixelkingdomwars.nativeclient.ui.community.LeaguesHub(graph, session, onClose = close,
                                        onFindMatch = { handoff { graph.homeRequests.request(HomeRequest.RaidChooser) } },
                                        onLand = { handoff { navController.navigate(LandGateRoute(reason = "browse")) { launchSingleTop = true } } },
                                        onReport = { openHub(Destination.Feedback) },
                                        modifier = panel, selectedTab = entry.selectedTab ?: entry.destination.tab,
                                        onTab = { selected ->
                                            if (localRouteHost.canUseReadControl(lease) && selected in HOME_LEAGUE_TABS) changeTab(selected)
                                            else localRouteHost.explainReadRefusal(lease)
                                        },
                                        hosted = true, canRead = { localRouteHost.canUseReadControl(lease) },
                                        reads = communityReads, explain = localRouteHost::locked)
                                    Destination.Mail -> gg.pixelkingdomwars.nativeclient.ui.community.MailHub(graph, session, onClose = close,
                                        onFeature = { feature -> openHubLink(gg.pixelkingdomwars.nativeclient.ui.sheets.hub.HubLink(feature)) },
                                        modifier = panel, hosted = true, selectedFilter = entry.selectedTab ?: "ALL", onFilter = changeTab,
                                        canRead = { localRouteHost.canUseReadControl(lease) },
                                        onReport = { openHub(Destination.Feedback) },
                                        reads = communityReads, explain = localRouteHost::locked)
                                    is Destination.Settings -> SettingsHub(graph, session, wallet, onBack = close,
                                        onSecurity = { handoff { navController.navigate(SecurityRoute) { launchSingleTop = true } } },
                                        onFeedback = { openHub(Destination.Feedback) },
                                        onCodex = { handoff { navController.navigate(CodexRoute) { launchSingleTop = true } } },
                                        onAbout = { handoff { navController.navigate(AboutRoute) { launchSingleTop = true } } },
                                        onFit = { handoff { graph.homeRequests.request(HomeRequest.BaseTool(gg.pixelkingdomwars.nativeclient.ui.home.HomeBaseTool.FIT)) } },
                                        modifier = panel, hosted = true, selectedTab = entry.selectedTab ?: entry.destination.tab,
                                        onTab = changeTab, canRead = { localRouteHost.canUseReadControl(lease) })
                                    Destination.Feedback -> gg.pixelkingdomwars.nativeclient.ui.community.FeedbackHub(graph, session, onBack = close,
                                        modifier = panel, hosted = true, selectedTab = entry.selectedTab ?: "NEW", onTab = changeTab,
                                        canRead = { localRouteHost.canUseReadControl(lease) })
                                    is Destination.WalletHistory -> HistoryHub(graph, session, onBack = close, onOpen = openHubLink,
                                        modifier = panel, hosted = true,
                                        selectedFilter = entry.selectedTab ?: gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live.historyFilterFor(entry.destination.home),
                                        onFilter = changeTab, canRead = { localRouteHost.canUseReadControl(lease) })
                                    is Destination.Event -> gg.pixelkingdomwars.nativeclient.ui.community.EventHub(graph, session, onBack = close,
                                        onFeedback = { openHub(Destination.Feedback) },
                                        onCampaign = { handoff { navController.navigate(PlaytestCampaignRoute) { launchSingleTop = true } } },
                                        onDoor = openHubLink, modifier = panel, hosted = true,
                                        selectedTab = entry.selectedTab ?: entry.destination.tab, onTab = changeTab,
                                        canRead = { localRouteHost.canUseReadControl(lease) })
                                    // CAST, COLLECT, START and STYLE act in place on the designed sheet (craft SPEC §2); TOOLS opens the
                                    // Equipment owner. The old OPEN REFINING / OPEN INGOTS route hop is off this path.
                                    is Destination.Workshop -> gg.pixelkingdomwars.nativeclient.ui.home.HomeWorkshopOwnerSheet(graph, session, identity, entry, panel,
                                        canRead = { localRouteHost.canUseReadControl(lease) }, explain = localRouteHost::locked,
                                        onTab = changeTab, onClose = close, onOpenTools = { changeTab("EQUIPMENT") }, onOpenDestination = craftDoor)
                                    is Destination.Harvester -> gg.pixelkingdomwars.nativeclient.ui.home.HomeHarvesterOwnerSheet(graph, session, identity, entry, ownerProjections,
                                        kingdomAudio, panel, changeTab, close, { legacy(entry.destination) },
                                        { localRouteHost.canUseReadControl(lease) }, localRouteHost::locked,
                                        reviewController = harvesterReviewController,
                                        artKey = gg.pixelkingdomwars.nativeclient.ui.sheets.craft.live.harvesterHeaderArtKey(
                                            home.base?.takeIf { it.baseId == identity.baseId }?.raw),
                                        artTier = { level -> gg.pixelkingdomwars.nativeclient.ui.sheets.craft.live.craftBuildingArtTier(content.catalogue, level) },
                                        onFocusBuilding = { id -> handoff { graph.homeRequests.request(HomeRequest.FocusBuilding(id)) } },
                                        onOpenDestination = craftDoor)
                                    is Destination.Lodge, is Destination.Berth -> HomeVoyageSheet(graph, session, identity, entry,
                                        ownerProjections, panel, changeTab, close, { legacy(entry.destination) },
                                        openVehicles = { vehicleEntry, historyOnly ->
                                            if (localRouteHost.canUseReadControl(lease) && !routeAdmissionBlocked.value()) {
                                                val owner = fleet?.owners?.firstOrNull {
                                                    it.destination == gg.pixelkingdomwars.nativeclient.ui.economy.FleetCommandDestination.VEHICLES && it.available
                                                }
                                                val opening = owner?.entryOpening(vehicleEntry?.name, historyOnly)
                                                if (opening != null) handoff { opening() }
                                                else localRouteHost.locked(if (historyOnly) "Vehicle receipts are unavailable for this session."
                                                    else "Vehicle controls are unavailable for this session.")
                                            }
                                        }, openFeature = { feature ->
                                            localRouteHost.openMountedLink(lease, feature)
                                        },
                                        // The craft-vehicle GO ("Public Workshop, Solana Island", owner 2026-10-06): the globe on
                                        // Solana Island's Public Workshop sheet, like the faucet sheet's Seeker door.
                                        openSolanaIsland = { handoff { graph.homeRequests.request(HomeRequest.World(gg.pixelkingdomwars.nativeclient.data.WorldEntry.SolanaIsland)) } },
                                        canRead = { localRouteHost.canUseReadControl(lease) }, explain = localRouteHost::locked,
                                        nestedBack = nestedBack, starterReview = starterReviewController,
                                        voyageOverlays = voyageOverlays, voyageCanAct = {
                                            !routeAdmissionBlocked.value() && !starterReviewPresence.painted &&
                                                currentOwners.value.let { borrowed -> borrowed.harvester?.projection?.reviewBlocked != true &&
                                                    borrowed.vehicle?.projection?.reviewBlocked != true && borrowed.starterFleet?.projection?.reviewBlocked != true } &&
                                                workshopOwnerRepository?.state?.value?.review == null
                                        }, onStack = { voyageStack = it },
                                        // send-locked BUILD BERTH: the build tray's BUILDINGS tab (no request focuses the Berth card).
                                        onBuildBerth = { handoff { graph.homeRequests.request(HomeRequest.BuildCategory(
                                            gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live.LiveTrayTabs.BUILDINGS)) } },
                                        // Free vehicle placement (owner 2026-10-06): INSTALL with no vacant Berth places a new one.
                                        berthPlacement = gg.pixelkingdomwars.nativeclient.ui.home.homeBerthPlacementDoor(kingdom, handoff))
                                    // The devnet SKR faucet half sheet: local states, or the claim owner in a pinned test build (the host decides).
                                    Destination.SkrFaucet -> gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live.SkrFaucetHost(graph, session, onClose = close,
                                        onGetLand = { handoff { navController.navigate(LandGateRoute(reason = "browse", kind = "entry")) { launchSingleTop = true } } },
                                        onGoSeeker = { handoff { graph.homeRequests.request(HomeRequest.World(gg.pixelkingdomwars.nativeclient.data.WorldEntry.SeekerIsland)) } },
                                        modifier = panel, wallet = wallet)
                                    else -> Unit // Restoration and host admission already decline every other body.
                                    }
                                }
                                gg.pixelkingdomwars.nativeclient.ui.home.HomeStarterFleetReviewOverlay(starterReviewController,
                                    starterFleetOwnerState, starterReviewPresence, Modifier.fillMaxSize(), localRouteHost::locked)
                                // The collect card's island cutout (voyage S5); no art lease is held while no card is shown.
                                CompositionLocalProvider(gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.LocalVoyageArt provides
                                    gg.pixelkingdomwars.nativeclient.ui.home.rememberHomeVoyageArt(graph, session) {
                                        currentOwners.value.vehicle?.policy?.invoke()?.ordinaryRoutes }) {
                                gg.pixelkingdomwars.nativeclient.ui.home.HomeVoyageOverlayHost(voyageOverlays,
                                    starterOwnerState, Modifier.fillMaxSize(), localRouteHost::locked)
                                }
                                gg.pixelkingdomwars.nativeclient.ui.home.HomeHarvesterReviewOverlay(harvesterReviewController,
                                    harvesterOwnerState, harvesterReviewPresence, Modifier.fillMaxSize(), localRouteHost::locked)
                                // The Gold Forge Seals, celebration and wallet help cover the whole viewport above the sheet; the
                                // '+n' rises beside the lifted GEMS row (this overlay Box shares the HUD stack's inset frame).
                                forgeSmelt?.overlay?.invoke()
                                forgeGems?.overlay?.invoke()
                                forgeConvert?.overlay?.invoke()
                                gg.pixelkingdomwars.nativeclient.ui.goldforge.GoldForgeStackGain(forgeGems?.gain, 0,
                                    Modifier.align(androidx.compose.ui.Alignment.TopEnd))
                            },
                        )
                    }
                }
            }, layer = layer)
        },
        eventButton = gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live.homeEventEdgeButton(testerHud, playtestHud),
        chatPeek = {
            gg.pixelkingdomwars.nativeclient.ui.home.HomeChatPeekLayer(session, enabled = chatEligible && chatLauncher.enabled && !chatLauncher.open,
                onOpen = { id -> peekFocus = id; openMore(MoreDestination.CHAT) })
        },
        faucet = { gg.pixelkingdomwars.nativeclient.ui.economy.FaucetBanner(session.faucet) { navController.navigate(FaucetRoute) } },
        // home.png: BUILD's NEW badge, the drawer's HARVESTERS / WORKSHOP strips and the first-run objective for the chip.
        buildNewTypes = homeBuildNewTypes,
        drawerMaterials = gg.pixelkingdomwars.nativeclient.ui.hud.drawerMaterialGroups(drawerCrafting, session.session.wallet, account.selectedBaseId) +
            listOfNotNull(gg.pixelkingdomwars.nativeclient.ui.hud.drawerLodgeGroup(passportOwnerState?.current)),
        objective = gg.pixelkingdomwars.nativeclient.ui.home.homeGuideObjective(home.tutorial, content.catalogue),
        hudShown = kingdomPicture) { tab, select, chatLayer, chatDock ->
        val homeScreen = when (tab) {
            HomeTab.KINGDOM -> when {
                layoutAudio.open -> "layout"
                kingdomAudio.local.sheet == gg.pixelkingdomwars.nativeclient.ui.kingdom.KingdomSheet.EXPAND -> "expand"
                kingdomAudio.local.sheet == gg.pixelkingdomwars.nativeclient.ui.kingdom.KingdomSheet.DAILY_CACHE -> "claim"
                kingdomAudio.local.buildMenu || kingdomAudio.local.placement != null -> "build"
                else -> "base"
            }
            HomeTab.WORLD -> "map"
            else -> "world"
        }
        SideEffect { chatEligible = homeScreen == "base" || homeScreen == "build"; onAudioScreen(homeScreen) }
        LaunchedEffect(routeDispatcher, routeDispatchBlocked, homeRequest, tab, account, home, kingdomAudio, layoutAudio.open,
            lifecycleState, gatesClear, route, recovery.recovered, recovery.checking, recovery.error,
            battle, coordinatorState, attackBusy, kingdomBusy, armyBusy, chooser, interlock, backChange,
            harvesterOwnerState, vehicleOwnerState, starterOwnerState, starterFleetOwnerState, workshopOwnerState, passportOwnerState, featureReadRevision) {
            val dispatcher = routeDispatcher ?: return@LaunchedEffect
            val request = graph.homeRequests.pending.value as? HomeRequest.Open ?: return@LaunchedEffect
            graph.homeRequests.deferOpen(request)
            if (tab != request.hostTab || lifecycle.currentState != Lifecycle.State.RESUMED || !gatesClear ||
                navController.currentBackStackEntry?.destination?.hasRoute<HomeRoute>() != true) return@LaunchedEffect
            // Wait behind existing reviews/recovery. A building sheet may enqueue without closing
            // selection; its actual host decides whether a successful dispatch releases that surface.
            val liveBase = session.base.state.value
            if (layout.state.value.open || !recovery.completedFor(graph.account.state.value.selectedBaseId) ||
                liveBase.builderFinishReview != null || kingdom.state.value.local.wallRowQuote != null ||
                liveBase.loading || liveBase.error != null || session.battle.state.value.loading ||
                attack.busy.value || kingdom.busy.value || army.busy.value || attack.chooser.value ||
                session.interlock.state.value.activeRaid != null || !session.battle.activationAllowed() ||
                (graph.back.active()?.priority ?: BackPriority.HOME) > BackPriority.SHEET) return@LaunchedEffect
            dispatcher.consume(request)
        }
        LaunchedEffect(pendingLink, account, home, recovery.recovered, recovery.checking, recovery.error,
            lifecycleState, backChange, battle, coordinatorState, attackBusy, kingdomBusy, armyBusy, homeRequest, chooser, gatesClear, route, interlock, tab) {
            // Do not pop a wallet, money, editor or recovery screen. This Home entry owns the authoritative recovery check.
            val currentAccount = graph.account.state.value
            val base = session.base.state.value
            val onHome = navController.currentBackStackEntry?.destination?.hasRoute<HomeRoute>() == true
            val safe = GameLinkEntry(resumed = lifecycle.currentState == Lifecycle.State.RESUMED, onHome = onHome,
                admitted = !graph.mode.offline && graph.origin == GameLinkContract.ORIGIN && gatesClear &&
                    graph.holder.current === session.session && currentAccount.session === session.session,
                selectedBaseId = currentAccount.selectedBaseId, hydratedBaseId = base.base?.baseId,
                recoveryComplete = recovery.completedFor(currentAccount.selectedBaseId),
                blocked = base.loading || base.error != null || battle.loading || attackBusy || kingdomBusy || armyBusy || homeRequest != null || chooser ||
                    (interlock.activeRaid != null && tab != HomeTab.ATTACK) || !session.battle.activationAllowed() || (graph.back.active()?.priority ?: BackPriority.HOME) > BackPriority.HOME)
            when (links.take(currentAccount, graph.holder.current, safe)) {
                GameLinkScreen.BASE -> select(HomeTab.KINGDOM)
                GameLinkScreen.RAIDLOG -> navController.navigate(RaidLogRoute) { launchSingleTop = true }
                GameLinkScreen.MAIL -> navController.navigate(MailRoute) { launchSingleTop = true }
                GameLinkScreen.BASES -> navController.navigate(BasesRoute()) { launchSingleTop = true }
                null -> {}
            }
        }
        LaunchedEffect(homeRequest, tab, presentationIdentity, lifecycleState, gatesClear, route,
            recovery.recovered, recovery.checking, recovery.error, reviewBlocked, backChange,
            armyHomeState, armyBusy, attackBusy, kingdomBusy, layoutAudio.open, home, kingdomAudio, battle) {
            if (tab != HomeTab.KINGDOM || presentationIdentity == null) return@LaunchedEffect
            val request = graph.homeRequests.pending.value ?: return@LaunchedEffect
            val target = gg.pixelkingdomwars.nativeclient.ui.sheets.army.live.armyHomeRequest(request)
            if (target == null && armyLiveSheet == null) return@LaunchedEffect
            // The already mounted composer owns TRAIN, including its existing paid-review handoff.
            if (request == HomeRequest.Training && armyLiveSheet == "army") return@LaunchedEffect
            val liveArmy = army.state.value
            val domain = liveArmy.domain
            val replacingArmyOwner = armyLiveSheet != null && target?.sheet != armyLiveSheet
            if (currentRouteIdentity.value() != presentationIdentity || lifecycle.currentState != Lifecycle.State.RESUMED ||
                !gatesClear || navController.currentBackStackEntry?.destination?.hasRoute<HomeRoute>() != true ||
                !recovery.completedFor(graph.account.state.value.selectedBaseId) || recovery.checking || recovery.error != null ||
                layout.state.value.open || hostedChat || fleet?.destination() != null || reviewGate.blocked.value ||
                army.busy.value || attack.busy.value || kingdom.busy.value || !session.battle.activationAllowed() ||
                (replacingArmyOwner && (domain.reviewed != null || domain.trainingFinishReview != null ||
                    domain.researchReview != null || domain.heroReview != null || liveArmy.presetDraft != null)) ||
                (graph.back.active()?.priority ?: BackPriority.HOME) > BackPriority.SHEET) return@LaunchedEffect
            if (target == null) { armyLiveSheet = null; attack.closeChooser(); return@LaunchedEffect }
            kingdom.clearSelection()
            if (target.sheet == "raid" || target.sheet == "campaign") attack.openChooser() else attack.closeChooser()
            armyLiveSheet = target.sheet
            // TRAIN is consumed by ArmyLiveHost (or its retained paid-review ArmyScreen), never here.
            if (target.consumeAtMount) graph.homeRequests.consume(request)
        }
        LaunchedEffect(tab) {
            if (tab != HomeTab.KINGDOM) { armyLiveSheet = null; attack.closeChooser() }
        }
        // Workshop TOOLS -> REFINE / INGOTS / STYLE: the Equipment pane has closed, and the designed Workshop sheet opens on that
        // tab once Home admits it again (Home sees the pane's close only after it recomposes). The original Workshop route
        // opens only when Home refuses the sheet or has still not admitted it, as it did before.
        var workshopReturn by remember(session) { mutableStateOf<String?>(null) }
        LaunchedEffect(workshopReturn) {
            val selected = workshopReturn ?: return@LaunchedEffect
            val result = kotlinx.coroutines.withTimeoutOrNull(2_000) {
                var attempt = HomeNavigationResult.DEFERRED
                while (attempt == HomeNavigationResult.DEFERRED) {
                    androidx.compose.runtime.withFrameNanos { }
                    attempt = localRouteHost.navigateResult(Destination.Workshop(selected), HomeTab.KINGDOM)
                }
                attempt
            }
            if (result != HomeNavigationResult.DISPATCHED && lifecycle.currentState == Lifecycle.State.RESUMED &&
                navController.currentBackStackEntry?.destination?.hasRoute<HomeRoute>() == true) when (selected) {
                "INGOTS" -> navController.navigate(WorkshopRoute) { launchSingleTop = true }
                "COSMETICS" -> navController.navigate(OrdinaryCraftingRoute("COSMETICS")) { launchSingleTop = true }
                else -> navController.navigate(OrdinaryCraftingRoute()) { launchSingleTop = true }
            }
            workshopReturn = null
        }
        when (tab) {
            // N-C5 GAMEPLAY-UI-A: the real Kingdom stays in its ONE slot; the bounded command pane shows the selected form beside it.
            HomeTab.KINGDOM -> gg.pixelkingdomwars.nativeclient.ui.economy.HomeFleetCommandPane(fleet?.destination(), onClose = { fleet?.closeAll() },
                form = {
                    // Workshop TOOLS borrows the existing Equipment form and registration.
                    if (fleet?.destination() == gg.pixelkingdomwars.nativeclient.ui.economy.FleetCommandDestination.EQUIPMENT) {
                        val equipmentIdentity = presentationIdentity
                        val equipmentCurrent = {
                            equipmentIdentity != null && currentPresentationIdentity.value() == equipmentIdentity &&
                                lifecycle.currentState == Lifecycle.State.RESUMED &&
                                navController.currentBackStackEntry?.destination?.hasRoute<HomeRoute>() == true &&
                                fleet?.destination() == gg.pixelkingdomwars.nativeclient.ui.economy.FleetCommandDestination.EQUIPMENT &&
                                (graph.back.active()?.priority ?: BackPriority.HOME) <= BackPriority.SHEET
                        }
                        val equipmentLevel = equipmentIdentity?.let { gg.pixelkingdomwars.nativeclient.ui.home.homeWorkshopLevel(home.base, it.baseId) }
                        androidx.compose.runtime.CompositionLocalProvider(
                            gg.pixelkingdomwars.nativeclient.ui.sheets.craft.LocalWorkshopOwnerHost provides
                                gg.pixelkingdomwars.nativeclient.ui.sheets.craft.WorkshopOwnerHost("EQUIPMENT",
                                    onTab = { selected ->
                                        if (!equipmentCurrent()) localRouteHost.locked("Finish the current review or return to this Workshop before changing tabs.")
                                        else when (selected) {
                                            // The other tabs act in place on the designed Home Workshop sheet (opened by workshopReturn).
                                            "REFINE", "INGOTS", "COSMETICS" -> { workshopReturn = selected; fleet?.closeAll() }
                                            "EQUIPMENT" -> Unit
                                            else -> localRouteHost.locked("This Workshop tab is unavailable.")
                                        }
                                    },
                                    onClose = { if (equipmentCurrent()) fleet?.closeAll()
                                        else localRouteHost.locked("Finish the current review before closing Tools.") },
                                    current = equipmentCurrent,
                                    headerTier = gg.pixelkingdomwars.nativeclient.ui.sheets.craft.live.craftBuildingArtTier(content.catalogue, equipmentLevel),
                                    titleTag = equipmentLevel?.let { "LV $it" })) { fleet?.form()?.invoke() }
                    } else fleet?.form()?.invoke()
                }) {
                Box(Modifier.fillMaxSize()) {
                val reviewRegistration = remember(reviewGate) { reviewGate.register("kingdom") }
                DisposableEffect(reviewRegistration) { onDispose { reviewRegistration.close() } }
                val reportReview = remember(reviewRegistration) { { blocked: Boolean -> reviewRegistration.report(blocked) } }
                val suppliesBase = account.selectedBaseId
                val suppliesGeneration = account.baseSelectionGeneration
                KingdomScreen(kingdom, layout, account.landOwned, graph.homeRequests, onOpenQuests = { if (routeDispatcher?.handleFeatureDoor(gg.pixelkingdomwars.nativeclient.ui.features.FeatureId("hud.quests")) != true) navController.navigate(QuestsRoute) }, onOpenArmy = { graph.homeRequests.request(HomeRequest.Army) },
                onOpenAttack = { graph.homeRequests.request(HomeRequest.Campaign) }, onOpenLand = openLand,
                onOpenResearch = { if (gg.pixelkingdomwars.nativeclient.ui.sheets.army.live.ArmyLive.ENABLED) { kingdom.clearSelection(); armyLiveSheet = "research" }
                    else navController.navigate(ResearchRoute) { launchSingleTop = true } },
                onOpenForge = { routeDispatcher?.handleFeatureDoor(gg.pixelkingdomwars.nativeclient.ui.features.FeatureId("goldforge.open")) },
                onGetGems = { short ->
                    // The finish Seal is already closed; the GEMS tab opens prefilled with what it still needs (speedup-short.png).
                    presentationIdentity?.let { id ->
                        val state = kingdom.state.value
                        val building = state.selectedBuilding?.takeIf { selected -> state.base?.jobs?.any { it.buildingId == selected.id } == true }
                        gemsShortfall.offer(gg.pixelkingdomwars.nativeclient.ui.goldforge.GoldForgeGemsShortfall(id, short,
                            building?.type?.let { gg.pixelkingdomwars.nativeclient.network.trayLabel(it).lowercase().replaceFirstChar { c -> c.titlecase() } + " finish" },
                            building?.id))
                    }
                    routeDispatcher?.handleFeatureDoor(gg.pixelkingdomwars.nativeclient.ui.features.FeatureId("goldforge.gems"))
                },
                onOpenHeroes = { if (gg.pixelkingdomwars.nativeclient.ui.sheets.army.live.ArmyLive.ENABLED) { armyLiveHero = if (kingdom.state.value.selectedBuilding?.type == "siegestool") "theodor" else "vex"; kingdom.clearSelection(); armyLiveSheet = "heroes" }
                    else navController.navigate(HeroesRoute()) { launchSingleTop = true } },
                onBasePurchase = { kind, baseId, buildingId -> kingdom.closeSurfaces(); navController.navigate(BasePurchaseRoute(kind, baseId, buildingId)) { launchSingleTop = true } },
                walletSol = economyHud.wallet?.sol, chatLayer = chatLayer,
                supplies = { tabs, onTab, onBuilders, onClose, placed ->
                    gg.pixelkingdomwars.nativeclient.ui.sheets.account.live.SuppliesHomeBody(
                        model = armyLiveRoster, wallet = session.session.wallet, baseId = suppliesBase,
                        isCurrent = { graph.sessionGraph.value === session && graph.holder.current === session.session &&
                            graph.account.state.value.selectedBaseId == suppliesBase && graph.account.state.value.baseSelectionGeneration == suppliesGeneration &&
                            lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED) &&
                            navController.currentBackStackEntry?.destination?.hasRoute<HomeRoute>() == true },
                        onPurchase = { kind, baseId -> kingdom.closeSurfaces(); navController.navigate(BasePurchaseRoute(kind, baseId)) { launchSingleTop = true } },
                        onBuilders = onBuilders, onTab = onTab, onClose = onClose,
                        onEconomy = { kingdom.closeSurfaces(); navController.navigate(EconomyRoute) },
                        onCodex = { kingdom.closeSurfaces(); navController.navigate(CodexRoute) }, tabs = tabs, modifier = placed,
                        solPurchase = homeSolPurchase, // account gap pass: SOL supplies raise the Seal in place
                        keepConfirm = graph.keepConfirm)
                },
                onReviewBlockedChanged = reportReview,
                onBeforeSceneTap = localRouteHost::beforeSceneTap, dock = chatDock,
                // The designed buildings group in place (night UI mount 2026-10-06): SOL purchases, Keep STORES, bar facts, CLAN.
                solPurchase = homeSolPurchase,
                keepStores = { close, go, placed ->
                    gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live.LiveKeepStoresHost(armyLiveRoster, homeCrafting, equipment = null,
                        keepLevel = kingdomAudio.base?.player?.keepLevel, baseId = account.selectedBaseId, onGo = go, onClose = close, modifier = placed)
                },
                barExtras = { now -> gg.pixelkingdomwars.nativeclient.ui.kingdom.BuildingBarExtras(
                    research = gg.pixelkingdomwars.nativeclient.ui.kingdom.researchBarFact(armyHomeState.domain, content.catalogue, now, account.selectedBaseId),
                    gearNew = gg.pixelkingdomwars.nativeclient.ui.kingdom.gearNewFact(armyLiveRoster.state.value.domain.inventory),
                    workshop = gg.pixelkingdomwars.nativeclient.ui.kingdom.workshopBarFact(drawerCrafting, account.selectedBaseId, now)) },
                onOpenClan = { if (routeDispatcher?.handleFeatureDoor(gg.pixelkingdomwars.nativeclient.ui.features.FeatureId("clan.open")) != true)
                    navController.navigate(ClansRoute) { launchSingleTop = true } },
                onKeepStoresShown = { keepStoresShown = it })
                gg.pixelkingdomwars.nativeclient.ui.sheets.army.live.ArmyHomeFrame { key(armyLiveSheet) { when (armyLiveSheet) {
                    "army" -> gg.pixelkingdomwars.nativeclient.ui.sheets.army.live.ArmyLiveHost(army, graph.homeRequests, account.baseSelectionGeneration,
                        interlock.actionsAllowed, onBack = { armyLiveSheet = null },
                        onOpenHero = { hero -> armyLiveHero = hero; armyLiveSheet = "heroes" },
                        onOpenBuildTray = { armyLiveSheet = null; graph.homeRequests.request(HomeRequest.HeroBuildMenu) },
                        onAttack = { armyLiveSheet = null; graph.homeRequests.request(HomeRequest.RaidChooser) },
                        onNeedMore = { price ->
                            armyLiveSheet = null
                            routeDispatcher?.handleFeatureDoor(gg.pixelkingdomwars.nativeclient.ui.features.FeatureId(
                                if (price.currency == gg.pixelkingdomwars.nativeclient.ui.model.Currency.GEMS) "goldforge.gems" else "goldforge.open"))
                        },
                        legacy = { done -> gg.pixelkingdomwars.nativeclient.ui.sheets.army.live.ArmyHomeLegacyFrame { ArmyScreen(army, graph.keepConfirm, graph.homeRequests, onBack = done,
                            baseGeneration = account.baseSelectionGeneration, actionsAllowed = interlock.actionsAllowed) { armyLiveSheet = "research" } } },
                        // c-gap-army: the header history icon opens the designed Battle log, never the old ArmyScreen.
                        onHistoryDoor = { armyLiveSheet = null; defenceNotice = null; navController.navigate(RaidLogRoute) { launchSingleTop = true } })
                    "raid", "campaign" -> gg.pixelkingdomwars.nativeclient.ui.sheets.army.live.ArmyHomeRaidMount(
                        attack, home, account.landOwned, home.tutorial?.onboarding?.templateCode == "first_raid",
                        content.catalogue?.get("constants") as? kotlinx.serialization.json.JsonObject, interlock.actionsAllowed,
                        campaign = armyLiveSheet == "campaign", onClose = { armyLiveSheet = null },
                        onOpenWorld = { graph.homeRequests.request(HomeRequest.World(gg.pixelkingdomwars.nativeclient.data.WorldEntry.Rivals)) },
                        onOpenArmy = { graph.homeRequests.request(HomeRequest.Army) },
                        onTrain = { graph.homeRequests.request(HomeRequest.Training) },
                        onRaidLog = { defenceNotice = null; navController.navigate(RaidLogRoute) { launchSingleTop = true } },
                        // SHORT Shards pill: the Gold Forge (the HUD Shards door). The chooser closes first, or Home holds the
                        // queued Forge request behind it. Energy opens the Supplies sheet route (below); off Home it says why.
                        onNeedMore = { price ->
                            val forge = price.icon != "energy"
                            if (forge) { armyLiveSheet = null; attack.closeChooser() }
                            // c-gap-army: SPEC §6 energy SHORT → Need-more → SUPPLIES. The designed Supplies sheet (ShopRoute,
                            // SuppliesHomeBody) sells raid energy through its existing purchase owner; it opens only from Home.
                            val supplies = !forge && navController.currentBackStackEntry?.destination?.hasRoute<HomeRoute>() == true
                            if (supplies) { armyLiveSheet = null; attack.closeChooser(); navController.navigate(ShopRoute) { launchSingleTop = true } }
                            else if (!forge || routeDispatcher?.handleFeatureDoor(gg.pixelkingdomwars.nativeclient.ui.features.FeatureId("goldforge.open")) != true)
                                gg.pixelkingdomwars.nativeclient.ui.chrome.Toasts.post(if (forge) "Not enough Shards for this raid." else "No raid energy left right now.")
                        },
                        armyState = armyHomeState)
                    "research" -> gg.pixelkingdomwars.nativeclient.ui.sheets.army.live.ResearchLiveHost(army, account.baseSelectionGeneration,
                        interlock.actionsAllowed, onBack = { armyLiveSheet = null },
                        onFocusBuilding = { id -> armyLiveSheet = null; graph.homeRequests.request(HomeRequest.FocusBuilding(id)) },
                        onNeedMore = { price ->
                            armyLiveSheet = null
                            routeDispatcher?.handleFeatureDoor(gg.pixelkingdomwars.nativeclient.ui.features.FeatureId(
                                if (price.currency == gg.pixelkingdomwars.nativeclient.ui.model.Currency.GEMS) "goldforge.gems" else "goldforge.open"))
                        },
                        legacy = { done -> gg.pixelkingdomwars.nativeclient.ui.sheets.army.live.ArmyHomeLegacyFrame { ResearchScreen(army, account.baseSelectionGeneration, interlock.actionsAllowed, onBack = done) } },
                        // c-gap-army: history opens the designed History sheet, never the old ResearchScreen.
                        onHistoryDoor = {
                            if (localRouteHost.navigateResult(Destination.WalletHistory(), HomeTab.KINGDOM) == HomeNavigationResult.DISPATCHED) armyLiveSheet = null
                            else localRouteHost.locked("History is not available right now. Try again.")
                        })
                    "heroes" -> gg.pixelkingdomwars.nativeclient.ui.sheets.army.live.HeroesLiveHost(armyLiveRoster, initialHero = armyLiveHero,
                        onBack = { armyLiveSheet = null },
                        onRecruit = { armyLiveSheet = null; graph.homeRequests.request(HomeRequest.HeroBuildMenu) },
                        onOpenGear = { navController.navigate(InventoryRoute) { launchSingleTop = true } },
                        onNeedMore = { price ->
                            armyLiveSheet = null
                            routeDispatcher?.handleFeatureDoor(gg.pixelkingdomwars.nativeclient.ui.features.FeatureId(
                                if (price.currency == gg.pixelkingdomwars.nativeclient.ui.model.Currency.GEMS) "goldforge.gems" else "goldforge.open"))
                        },
                        legacy = { done -> gg.pixelkingdomwars.nativeclient.ui.sheets.army.live.ArmyHomeLegacyFrame { HeroesScreen(armyLiveRoster, graph.keepConfirm, onBack = done,
                            onRecruit = { armyLiveSheet = null; graph.homeRequests.request(HomeRequest.HeroBuildMenu) }) } },
                        // c-gap-army: history (HERO, SKILLS and GEAR) opens the designed History sheet, never HeroesScreen / Inventory.
                        onHistoryDoor = {
                            if (localRouteHost.navigateResult(Destination.WalletHistory(), HomeTab.KINGDOM) == HomeNavigationResult.DISPATCHED) armyLiveSheet = null
                            else localRouteHost.locked("History is not available right now. Try again.")
                        })
                } } }
                }
            }
            // Saved old tab identities remain readable, but never repaint the retired Army/attack hub bodies.
            HomeTab.ARMY -> LaunchedEffect(Unit) { select(HomeTab.KINGDOM); graph.homeRequests.request(HomeRequest.Army) }
            HomeTab.ATTACK -> LaunchedEffect(Unit) {
                select(HomeTab.KINGDOM); defenceNotice = null
                navController.navigate(RaidLogRoute) { launchSingleTop = true }
            }
            HomeTab.WORLD -> { val worldModel = graphViewModel(session) { WorldViewModel(graph, session) }
                WorldScreen(worldModel, account.selectedBaseId,
                onOpenLand = { navController.navigate(LandGateRoute(reason = "browse", kind = if (account.landOwned) "deed" else "entry")) },
                onOpenBases = { navController.navigate(BasesRoute()) }, onOpenShop = { navController.navigate(ShopRoute) },
                onBack = { select(HomeTab.KINGDOM) }, onOpenCampaign = { graph.homeRequests.request(HomeRequest.Campaign) },
                ownedBaseCount = account.directory?.bases?.size, activeBaseCount = account.directory?.activeBases?.size,
                // N1–N4 (D-171, N5): the GL30 globe + realm maps on the bundle every APK carries; null = the legacy globe
                worldEngine = gg.pixelkingdomwars.nativeclient.scene.world.rememberWorldEngine(worldModel) { graph.content.state.value.catalogue }, requests = graph.homeRequests,
                onOpenPhaseE = { a -> navController.navigate(BasesRoute(launch = a.name)) { launchSingleTop = true } },
                onOpenClanHall = { navController.navigate(ClansRoute) { launchSingleTop = true } }, seekerAuction = seekerAuctionSlot,
                // Solana Island › Public Workshop › CRAFT VEHICLE opens the one vehicle owner's craft page (owner 2026-10-06:
                // it selected the Berth and dropped the player on the base screen).
                onCraftVehicle = gg.pixelkingdomwars.nativeclient.ui.world.publicWorkshopCraftOpening(fleet)) }
            HomeTab.MORE -> MoreScreen(openMore)
        }
        val raid = interlock.activeRaid; val selected = account.selectedBaseId
        if (raid != null && selected != null && tab != HomeTab.ATTACK) BaseRaidInterlockDialog(raid.state,
            onWatch = { attack.watchLive(raid.raidId, selected) }, onHistory = { defenceNotice = null; navController.navigate(RaidLogRoute) { launchSingleTop = true } },
            onSwitchBase = { navController.navigate(BasesRoute()) { launchSingleTop = true } })
    }
    }
    }
    // One composition survives IME/resize threshold changes; the scene remains attached and playable
    // beside the sheet/panel. The X in the chat header and Back (CHAT_DOCK_BACK_PRIORITY) both dismiss it.
    if (hostedChat && chatEligible && route?.destination?.hasRoute<HomeRoute>() == true) {
        HostedChat(hostedFrame, session.chat, chatBounds, runCatching { gg.pixelkingdomwars.nativeclient.data.ProfileBounds.from(content.catalogue) }.getOrNull(),
            onProfile = { navController.navigate(ProfileRoute) { launchSingleTop = true } }, onLand = openLand, onBack = { hostedChat = false; peekFocus = null },
            onReleased = {
                // Disposal closes the reader before eligibility clears its cursor, preventing a late
                // close callback from republishing old capability after leaving base/build.
                if (!chatEligible || navController.currentBackStackEntry?.destination?.hasRoute<HomeRoute>() != true) session.chat.clearLauncher()
            }, focusMessageId = peekFocus)
    }
    }
}

/** The two Home resume reads use one queue into the existing repository. Other repository owners
 * retain admission; waiting on its busy state neither submits a command nor retries a failed command. */
internal class HomeCommunityReads(internal val repository: CommunityRepository) {
    private val admission = Mutex()
    suspend fun read(block: suspend (CommunityRepository) -> Unit) = admission.withLock {
        repository.state.first { !it.busy }
        block(repository)
    }
    suspend fun refreshMail() = read { it.refreshMail(false) }
}

/** Immutable requested scope is captured before GET, and published only after both currentness checks.
 * Reload retains the previous completed capture; a new owner creates a fresh instance. */
internal class HomeLeagueReadCapture(private val identity: HomeRouteIdentity) {
    var captured: HomeRouteIdentity? by mutableStateOf(null)
        private set
    var load: LoadState by mutableStateOf(LoadState.Loading)
        private set
    suspend fun refresh(reads: HomeCommunityReads, current: () -> Boolean) {
        load = LoadState.Loading
        val requested = identity
        try {
            reads.read { repository ->
                if (!current()) return@read
                repository.refreshLeagues()
                val observed = repository.state.value
                if (current() && observed.leagueBaseId == requested.baseId &&
                    observed.leagueSelectionGeneration == requested.baseSelectionGeneration) {
                    captured = requested
                    load = LoadState.Ready
                }
            }
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) {
            if (current()) load = LoadState.Error("League data could not be refreshed. Try again.")
        }
    }
}

/** Web `BaseRaidInterlockView`: the server owns the lock; only the three read/navigation exits remain. */
@Composable private fun BaseRaidInterlockDialog(state: String, onWatch: () -> Unit, onHistory: () -> Unit, onSwitchBase: () -> Unit) {
    AlertDialog(onDismissRequest = {}, title = { Text(Copy.BASE_UNDER_RAID, color = MaterialTheme.colorScheme.error) },
        text = { androidx.compose.foundation.layout.Column { Text(Copy.ACTIVE_RAID_MESSAGE); Text(Copy.raidLockState(state), style = MaterialTheme.typography.labelSmall) } },
        confirmButton = { Button(onClick = onWatch) { Text(Copy.WATCH_LIVE) } },
        dismissButton = { androidx.compose.foundation.layout.Row { TextButton(onClick = onHistory) { Text(Copy.BATTLE_HISTORY) }; TextButton(onClick = onSwitchBase) { Text(Copy.SWITCH_DEED) } } })
}

/** The gates still drawn as dialogs; Update and Maintenance are the designed [gg.pixelkingdomwars.nativeclient.update.ServerGateCard]. */
@Composable private fun GateDialog(gate: Gate, onDismiss: () -> Unit, onSignOut: () -> Unit) {
    when (gate) {
        is Gate.Update, is Gate.Maintenance -> {} // Rendered by ServerGateCard.
        Gate.Alpha -> AlertDialog(onDismissRequest = {}, title = { Text(Copy.ALPHA_GATED) }, text = { Text("This wallet is not admitted to the playtest. Sign out and use an admitted wallet.") },
            confirmButton = { TextButton(onClick = onSignOut) { Text(Copy.SIGN_OUT) } }, dismissButton = { TextButton(onClick = onDismiss) { Text("Close") } })
        is Gate.Info -> AlertDialog(onDismissRequest = onDismiss, title = { Text(gate.message) }, text = {}, confirmButton = { TextButton(onClick = onDismiss) { Text("OK") } })
        is Gate.Funds -> {} // Rendered by FundsSheet.
    }
}
