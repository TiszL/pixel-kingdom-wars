package gg.pixelkingdomwars.nativeclient.ui.home

import androidx.compose.foundation.border
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.layout
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.boundsInWindow
import gg.pixelkingdomwars.nativeclient.renderer.SceneInputRegion
import kotlin.math.roundToInt
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.focus.FocusManager
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import gg.pixelkingdomwars.nativeclient.data.AccountPhase
import gg.pixelkingdomwars.nativeclient.data.AccountState
import gg.pixelkingdomwars.nativeclient.data.BaseState
import gg.pixelkingdomwars.nativeclient.network.fmtN
import gg.pixelkingdomwars.nativeclient.network.fmtDur
import gg.pixelkingdomwars.nativeclient.network.string
import gg.pixelkingdomwars.nativeclient.model.WalletFunds
import gg.pixelkingdomwars.nativeclient.model.MailStatus
import gg.pixelkingdomwars.nativeclient.model.TesterProgress
import gg.pixelkingdomwars.nativeclient.ui.Copy
import gg.pixelkingdomwars.nativeclient.ui.Notice
import gg.pixelkingdomwars.nativeclient.ui.Palette
import gg.pixelkingdomwars.nativeclient.ui.chrome.blockSceneInput
import gg.pixelkingdomwars.nativeclient.ui.chrome.GameArt
import gg.pixelkingdomwars.nativeclient.ui.chrome.PixelPlate
import gg.pixelkingdomwars.nativeclient.model.DailyCache
import gg.pixelkingdomwars.nativeclient.model.ArmyStatus
import gg.pixelkingdomwars.nativeclient.model.Energy
import gg.pixelkingdomwars.nativeclient.ui.more.MoreDestination
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.features.Destination
import gg.pixelkingdomwars.nativeclient.ui.hud.HomeHud
import gg.pixelkingdomwars.nativeclient.ui.hud.HomeHudActions
import gg.pixelkingdomwars.nativeclient.ui.hud.HudGeometry
import gg.pixelkingdomwars.nativeclient.ui.hud.HudIds
import gg.pixelkingdomwars.nativeclient.ui.hud.stackHeight
import gg.pixelkingdomwars.nativeclient.ui.hud.HomeResourceStack
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.model.HomeHudUi
import androidx.compose.ui.zIndex

/** Measured parent chrome over the full-window kingdom surface. */
val LocalHomeScenePadding = staticCompositionLocalOf<PaddingValues> { PaddingValues(0.dp) }
/** Fitting hints retain the actual painted corner bounds, independent of layout padding and hit regions. */
data class HomeCameraChrome(val header: SceneInputRegion? = null, val primary: SceneInputRegion? = null)
val LocalHomeCameraChrome = staticCompositionLocalOf { HomeCameraChrome() }
internal fun androidx.compose.ui.geometry.Rect.cameraChromeRect() = SceneInputRegion(
    left.roundToInt(),top.roundToInt(),right.roundToInt(),bottom.roundToInt())
/** Width of the floating primary group, used only to keep the landscape inspector beside it. */
val LocalHomePrimaryWidth = staticCompositionLocalOf<Dp> { 232.dp }

// These identities are also used by saved recovery requests; visible navigation follows the web.
enum class HomeTab(val label: String) { KINGDOM("Kingdom"), ARMY("Army"), ATTACK("Attack"), WORLD("World"), MORE("More") }

/** The default overlay: nothing. Declared before [LegacyHomeLayerHooks], which reads it while the file initialises. */
internal val NoHomeOverlay: @Composable BoxScope.() -> Unit = {}

/**
 * MS-C3 mount contract v1 §2: what a typed Home layer host hands HomeScaffold's root for the current tab.
 * - [homeCovered]: a Full card (or other full coverage) is over Home, kept through its exit. The covered Home leaves the
 *   semantics tree without any geometry change; pointers are stopped by the host's full-viewport scrim, not here.
 * - [resourcesBlocked]: a review, Seal, gate or admission is blocking. The one resource stack stays drawn and readable but
 *   takes no touch and offers no accessibility action. Typed hosts start blocked.
 * - [overlay]: the sheet / Seal layer, above the Home scene and HUD, inside one finite viewport Box that applies the
 *   safe-drawing insets once.
 */
data class HomeLayerHooks(
    val homeCovered: Boolean = false,
    val resourcesBlocked: Boolean = true,
    val overlay: @Composable BoxScope.() -> Unit = NoHomeOverlay,
    val authoritativeResources: List<gg.pixelkingdomwars.nativeclient.ui.model.ResourceChipUi>? = null,
    val hideHudChrome: Boolean = false,
)

typealias HomeLayerContent = @Composable (HomeLayerHooks) -> Unit
typealias HomeLayerHost = @Composable (HomeTab, HomeLayerContent) -> Unit

/** The legacy mount's hooks (HomeScaffold's default host): nothing covers Home, resources are open, no overlay. */
internal val LegacyHomeLayerHooks = HomeLayerHooks(resourcesBlocked = false)

/** A host supplied an overlay (the default [NoHomeOverlay] is none). */
internal val HomeLayerHooks.hasOverlay: Boolean get() = overlay !== NoHomeOverlay

/** Whether HomeScaffold lifts the resource stack above the overlay (at `PkwTokens.Z.RESOURCE_STACK`, with `stackLifted`
 *  passed to HomeHud so exactly one stack is painted): only while the Kingdom HUD is drawn, over a real overlay, and
 *  while neither the HUD's own resource drawer nor the MENU panel (both paint over the stack's corner) is open. The
 *  legacy host has no overlay, so its stack stays inside HomeHud exactly as before. */
internal fun homeStackLifted(overlay: Boolean, hudShown: Boolean, drawerOpen: Boolean, menuOpen: Boolean): Boolean =
    hudShown && overlay && !drawerOpen && !menuOpen

/** Whether the lifted stack is painted: not while a Full card covers Home (hub SPEC §5 decision 4: a Full card shows
 *  only the currencies it pays out, in its own RewardReadouts row above its frame). Painted at y 10..120 over the card it
 *  sat on the card's header and Close and doubled its readouts (owner, Leagues, 2026-10-06). Half and tall sheets keep it. */
internal fun homeLiftedStackPainted(lifted: Boolean, fullCardOver: Boolean): Boolean = lifted && !fullCardOver

/** The pill rows a full-screen sheet's shelf leaves room for: the lifted rows only while [homeLiftedStackPainted] paints
 *  them. A Full card over Home paints none, so it gets no shelf (FullScreenSheetGeometry: "No pills, no shelf"). Counting
 *  the unpainted rows left every Full card (the Clan card among them) under an empty 38 dp band below the camera strip. */
internal fun homeShelfRows(liftedRows: Int, fullCardOver: Boolean): Int =
    if (homeLiftedStackPainted(lifted = liftedRows > 0, fullCardOver = fullCardOver)) liftedRows else 0

/** The Kingdom header spacer in dp: down to the full four-row resource stack, or down to the herald's bottom while a
 *  landless kingdom's land herald holds that band for good (hub SPEC §3.1), so notices never sit under the herald. */
internal fun homeHeaderSpacerDp(landHeraldBand: Boolean): Int =
    if (landHeraldBand) HudGeometry.HERALD_TOP + HudGeometry.HERALD_H else HudGeometry.STACK_TOP + stackHeight(4)

/** BUILD is a tall sheet: retain the current Shards row, with no second stack or balance mapping. */
internal fun homeHudForBuild(ui: HomeHudUi, buildOpen: Boolean): HomeHudUi = if (!buildOpen) ui else ui.copy(
    resources = ui.resources.filter { it.id == HudIds.SHARDS },
    deckVisible = false, toolsOpen = false, herald = null, context = null,
)

/** D-102 double-back exit from the Kingdom tab: a second Back inside `MOBILE_BACK.exitConfirmMs` exits.
 * With no catalogue window ([exitConfirmMs] null) there is nothing to arm: Back only says why. */
enum class HomeBackAction { EXIT, ARM, UNAVAILABLE }
internal fun homeBackAction(nowMs: Long, armedAtMs: Long, exitConfirmMs: Long?): HomeBackAction = when {
    exitConfirmMs == null -> HomeBackAction.UNAVAILABLE
    nowMs - armedAtMs <= exitConfirmMs -> HomeBackAction.EXIT
    else -> HomeBackAction.ARM
}

/** Clear the embedded scene's focus while its Compose ancestry is still attached.
 * Fragment removal during navigation otherwise clears View focus from onDetach,
 * after that ancestry has started leaving composition. */
internal class HomeMenuActions(private val focus: FocusManager, private val closeMenu: () -> Unit) {
    fun run(action: () -> Unit) {
        focus.clearFocus(force = true)
        closeMenu()
        action()
    }
}

/** The Kingdom resource HUD and navigation deck adapt to portrait and short landscape.
 * Only the Kingdom carries this chrome; secondary screens retain their original navigation/Back paths. */
/** Measures (and so composes) [this] always, but places it only when [placed]: an unplaced subtree is not drawn, not
 *  hit-tested and not in the semantics tree, yet it is ready to appear without a first-composition frame. */
internal fun Modifier.placedOnlyWhen(placed: Boolean): Modifier = this.layout { measurable, constraints ->
    val placeable = measurable.measure(constraints)
    layout(placeable.width, placeable.height) { if (placed) placeable.place(0, 0) }
}

@Composable fun HomeScaffold(
    account: AccountState, home: BaseState, local: Boolean, exitConfirmMs: Long?, requests: HomeRequests,
    onOpenLand: () -> Unit, onExit: () -> Unit, onOpen: (MoreDestination) -> Unit,
    onProfile: () -> Unit, onRaidLog: () -> Unit, onCache: () -> Unit, onPurchases: () -> Unit, onForge: (FeatureId) -> Unit,
    wallet: WalletFunds? = null, mail: MailStatus? = null, tester: TesterProgress? = null, unreadRaids: Int = 0, defenceNotice: String? = null,
    buildOpen: Boolean = false, buildEnabled: Boolean = true, buildReadOnly: Boolean = false, actionsEnabled: Boolean = true, showTasks: Boolean = true,
    /** Copy from the same BUILD gates in the owner; refusal remains tappable and is announced. */
    buildRefusalReason: String? = null,
    /** A saved construction is the refusal: BUILD also brings its recovery card into view (HomeRequest.ShowRecovery). */
    buildSavedConstruction: Boolean = false,
    immersive: Boolean = false,
    /** The Army group retains Kingdom; hide ordinary HUD chrome and lift its one truthful resource stack. */
    armySheetOpen: Boolean = false,
    /** MS-C3 mount contract §2: called ONCE inside the SceneInputScope with the actual tab, around the Home root. The
     *  default keeps the legacy mount ([LegacyHomeLayerHooks]); C3's typed host owns histories, scope and SheetHost. */
    homeLayerHost: HomeLayerHost = { _, layer -> layer(LegacyHomeLayerHooks) },
    /** The deck tools' rules (KingdomScreen's former dock row): the deed allows base actions / an order is in flight. */
    toolsAllowed: Boolean = true, toolsBusy: Boolean = false,
    chatEnabled: Boolean = false, chatUnread: Int = 0, chatMentions: Int = 0, chatOpen: Boolean = false, obscuredByChat: Boolean = false,
    /** Typed hooks return false for an unmounted body; that door keeps its existing owner. */
    openFeature: ((FeatureId) -> Boolean)? = null,
    openResources: ((FeatureId, Destination.Resources) -> Boolean)? = null,
    faucet: @Composable () -> Unit = {},
    /** The right-edge EVENT button while Founding Kingdoms is live (null otherwise). */
    eventButton: gg.pixelkingdomwars.nativeclient.ui.model.EdgeButtonUi? = null,
    /** The chat peek layer, drawn over the Kingdom HUD; only its plate takes touches. */
    chatPeek: @Composable BoxScope.() -> Unit = {},
    /** Building types unlocked at this Keep level and not built yet: BUILD's gold NEW badge (newlyUnlockedBuildTypes). */
    buildNewTypes: Set<String> = emptySet(),
    /** The drawer's HARVESTERS / WORKSHOP strips for this wallet and base (drawerMaterialGroups); empty draws none. */
    drawerMaterials: List<gg.pixelkingdomwars.nativeclient.ui.model.ResourceGroupUi> = emptyList(),
    /** The first-run objective as the context chip's top candidate (homeGuideObjective); null when there is none. */
    objective: gg.pixelkingdomwars.nativeclient.ui.model.ContextChipUi? = null,
    /** Scene-transitions spec §1.5: false while the Kingdom shows the wallpaper cover (no live scene, no postcard). The HUD
     *  then steps aside and fades in over 160 ms once a picture of the kingdom is there; door admission is unchanged. */
    hudShown: Boolean = true,
    /** Kingdom tab content: (tab, select, chatLayer over the scene, the persistent CHAT dock control beside LAYOUT · EXPAND · FIT). */
    content: @Composable (HomeTab, (HomeTab) -> Unit, @Composable BoxScope.() -> Unit, @Composable RowScope.() -> Unit) -> Unit,
) {
    var tab by rememberSaveable { mutableStateOf(HomeTab.KINGDOM) }
    // The former overflow is only a secondary MORE utility; Home opens the Profile sheet.
    var overflow by remember { mutableStateOf(false) }
    val focusManager = LocalFocusManager.current
    val menuActions = remember(focusManager) { HomeMenuActions(focusManager) { overflow = false } }
    fun selectTab(next: HomeTab) { menuActions.run { requests.selectHomeTab(next) { tab = it } } }
    // HomeHud's resource drawer: open flag and the row its info card shows (saved across rotation).
    var drawerOpen by rememberSaveable { mutableStateOf(false) }
    var drawerFocus by rememberSaveable { mutableStateOf<String?>(null) }
    // The deck's transient tools shelf (long-press BUILD). Closed by Back, a tool, a selection or any surface change.
    var toolsOpen by rememberSaveable { mutableStateOf(false) }
    BackHandlerAt(BackPriority.SHEET, enabled = toolsOpen) { toolsOpen = false }
    LaunchedEffect(showTasks) { if (!showTasks) toolsOpen = false }
    val menuFocus = remember { FocusRequester() }
    var restoreMenuFocus by remember { mutableStateOf(false) }
    fun closeMenu() { menuActions.run { restoreMenuFocus = true } }
    LaunchedEffect(overflow, restoreMenuFocus, chatOpen) {
        // Only MORE still draws a MENU control carrying menuFocus; requesting focus with nothing attached throws.
        if (!overflow && restoreMenuFocus) { withFrameNanos { }; if (tab == HomeTab.MORE) menuFocus.requestFocus(); restoreMenuFocus = false }
    }
    var wasChatOpen by remember { mutableStateOf(false) }
    LaunchedEffect(chatOpen) { if (wasChatOpen && !chatOpen) restoreMenuFocus = true; wasChatOpen = chatOpen }
    LaunchedEffect(home.base?.baseId, tab, immersive, armySheetOpen) { overflow = false; drawerOpen = false; toolsOpen = false }
    val request by requests.pending.collectAsState()
    // Screen-specific requests still survive mounting and are consumed only by their original screen.
    LaunchedEffect(request) { request?.let { overflow = false; tab = it.homeTab; if (it is HomeRequest.Tab) requests.consume(it) } }
    var exitArmedAt by remember { mutableLongStateOf(0L) }
    var exitHint by remember { mutableStateOf<String?>(null) }
    BackHandlerAt(BackPriority.HOME) {
        val now = System.currentTimeMillis()
        if (tab != HomeTab.KINGDOM) { selectTab(HomeTab.KINGDOM); return@BackHandlerAt }
        when (homeBackAction(now, exitArmedAt, exitConfirmMs)) {
            HomeBackAction.EXIT -> onExit()
            // home-budget.png: the exit hint is a kit toast, not a header notice.
            HomeBackAction.ARM -> { exitArmedAt = now; exitHint = Copy.BACK_AGAIN; gg.pixelkingdomwars.nativeclient.ui.chrome.Toasts.post(Copy.BACK_AGAIN) }
            HomeBackAction.UNAVAILABLE -> { exitHint = Copy.BACK_EXIT_UNAVAILABLE; gg.pixelkingdomwars.nativeclient.ui.chrome.Toasts.post(Copy.BACK_EXIT_UNAVAILABLE) }
        }
    }
    LaunchedEffect(exitHint) { if (exitHint == Copy.BACK_AGAIN && exitConfirmMs != null) { kotlinx.coroutines.delay(exitConfirmMs); exitHint = null } }
    val open: (MoreDestination) -> Unit = { destination -> menuActions.run { onOpen(destination) } }
    // Owner 2026-10-06 (full-screen sheets): which full-screen sheets show over Home, and the shelf they leave for the pills.
    val fullScreenSheets = remember { gg.pixelkingdomwars.nativeclient.ui.kit.FullScreenSheets() }
    CompositionLocalProvider(gg.pixelkingdomwars.nativeclient.ui.kit.LocalFullScreenSheets provides fullScreenSheets) {
    gg.pixelkingdomwars.nativeclient.scene.SceneInputScope {
    // MS-C3 mount contract §2: the layer host is called ONCE, here, with the actual tab, around the one Home root.
    homeLayerHost(tab) { hooks ->
    BoxWithConstraints(Modifier.fillMaxSize().background(Palette.backdrop)
        .then(if (obscuredByChat) Modifier.clearAndSetSemantics {} else Modifier)) {
        val safe = WindowInsets.safeDrawing.asPaddingValues()
        val viewportHeight = maxHeight - safe.calculateTopPadding() - safe.calculateBottomPadding()
        val landscape = maxWidth > viewportHeight * 1.1f && viewportHeight < 500.dp
        val world = tab == HomeTab.KINGDOM && !immersive
        val density = LocalDensity.current
        var headerPixels by remember { mutableIntStateOf(0) }
        var primaryPixels by remember { mutableIntStateOf(0) }
        var primaryWidthPixels by remember { mutableIntStateOf(0) }
        var cameraChrome by remember { mutableStateOf(HomeCameraChrome()) }
        val parentPadding = if (world) PaddingValues(top = with(density) { headerPixels.toDp() },
            bottom = if (landscape) 0.dp else with(density) { primaryPixels.toDp() }) else PaddingValues(0.dp)
        // hub SPEC §3.1: the herald sits under the resource stack (y 128..172). A kingdom the server says has no land always
        // carries one (the land line), so its notices and camera fit start under the herald; a landed kingdom's heralds are
        // transient (4 s) and leave the fit where it was, so the camera never jumps for them.
        val landHeraldBand = gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live.landOwnedLive(account).takeIf { account.phase == AccountPhase.SIGNED_IN } == false
        val header: @Composable () -> Unit = {
            // HomeHud draws the top bar; this spacer keeps the notices under its resource stack and headerPixels honest.
            if (world) Spacer(Modifier.height(homeHeaderSpacerDp(landHeraldBand).dp))
            else if (tab == HomeTab.MORE) PixelPlate("bar", Modifier.fillMaxWidth().windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal)), PaddingValues(8.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    ForgedControl("BASE", "map", Modifier.size(64.dp, 56.dp), onClick = { selectTab(HomeTab.KINGDOM) })
                    Text(tab.label.uppercase(), Modifier.weight(1f).padding(horizontal = 12.dp), style = MaterialTheme.typography.titleLarge)
                    ForgedControl("MENU", "overflow", Modifier.size(64.dp, 56.dp).focusRequester(menuFocus), onClick = { if (overflow) closeMenu() else overflow = true })
                }
            }
            gg.pixelkingdomwars.nativeclient.update.NativeUpdateBanner()
            // DESIGN-SYSTEM state tags: test data wears the stone tag (was a Material text on the old surface colour).
            // Not on the WORLD tab (owner's Seeker 2026-10-06 16:00): there the header column is composed above the World
            // screen's own sheets, so the tag sat over the Seeker spot list and covered Spot 1's GO. The Kingdom tab keeps it.
            if (local && tab != HomeTab.WORLD) gg.pixelkingdomwars.nativeclient.ui.kit.Tag(Copy.LOCAL_SERVER, gg.pixelkingdomwars.nativeclient.ui.model.Verb.STONE,
                Modifier.homeChromeHidden(world && !showTasks))
        }
        val pane: @Composable BoxScope.() -> Unit = {
            // Owner: "there is no chatbox on screen" — the CHAT control lives in the base dock, not only in the menu grid.
            // On KINGDOM, HomeHud's CHAT edge tab is the one CHAT door.
            content(tab, ::selectTab, {}) { if (chatEnabled && !world) ChatDockControl(chatUnread, chatMentions, chatOpen) { open(MoreDestination.CHAT) } }
            // Only the first-run cards still stand on Home (HomeGuideCard). The old dark "NO LAND YET" plate that stood here
            // (bottom-left, over the MAIL / CHAT tabs and any sheet, owner screenshot 2026-10-06) is gone: the land door on
            // Home is the designed land herald ("Buy land to join the world map", account/onboard-first-home.png;
            // homeLandHeraldUi -> LAND_HERALD_TARGET -> onOpenLand), which reaches only a player the server says has no land.
        }
        // MS-C3 §2, the Home group, in layer order: the existing scene and HUD, then the host's sheet / Seal overlay, then
        // only the lifted resource stack. Its zIndex stays inside this plain Box, so the required update screen drawn
        // after the group stays above all of it. Neither Box has pointer handling (the pointer rule).
        var liftedHud: Pair<HomeHudUi, HomeHudActions>? = null
        Box(Modifier.fillMaxSize()) {
        // While a Full card covers Home (through its exit) the covered layers leave the semantics tree; the host's
        // full-viewport scrim stops their pointers, and their geometry (scene padding, camera chrome) does not change.
        Box(Modifier.fillMaxSize().then(if (hooks.homeCovered) Modifier.clearAndSetSemantics {} else Modifier)) {
        if (world) {
            CompositionLocalProvider(LocalHomeScenePadding provides parentPadding, LocalHomeCameraChrome provides cameraChrome,
                LocalHomePrimaryWidth provides if (primaryWidthPixels > 0) with(density) { primaryWidthPixels.toDp() } else 232.dp) { Box(Modifier.fillMaxSize(), content = pane) }
            if (!buildOpen && !hooks.hideHudChrome && !armySheetOpen && !fullScreenSheets.active) Column(Modifier.align(Alignment.TopStart).onGloballyPositioned { cameraChrome = cameraChrome.copy(header = it.boundsInWindow().cameraChromeRect()) }
                .widthIn(max = if (landscape) 540.dp else 520.dp)
                .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal))
                .padding(8.dp).onSizeChanged { headerPixels = it.height + with(density) { safe.calculateTopPadding().roundToPx() + 16.dp.roundToPx() } }) { header() }
        } else if (tab == HomeTab.WORLD) Box(Modifier.fillMaxSize()) {
            // c-gap-map: the map is full screen under the camera cutout (map/SPEC §1.1, its own bar sits in the safe area); the
            // update banner and the test-server tag stand under its resource stack instead of pushing the globe down behind a
            // dark band (owner 2026-10-06, screenshots 5 and 6: "TEST KINGDOM" over a dark strip at the camera).
            Box(Modifier.fillMaxSize(), content = pane)
            Column(Modifier.align(Alignment.TopEnd).windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal))
                .padding(top = 132.dp, end = 8.dp), horizontalAlignment = Alignment.End) { header() }
        } else Column(Modifier.fillMaxSize()) {
            header()
            Box(Modifier.weight(1f).fillMaxWidth(), content = pane)
        }
        if (world) {
            // The deck's height is fixed by the design (HudGeometry); keep the scene's bottom fit padding equal to it.
            SideEffect { primaryPixels = with(density) { (HudGeometry.DECK_BOTTOM + HudGeometry.DECK_PRIMARY + 8).dp.roundToPx() + safe.calculateBottomPadding().roundToPx() } }
            // The existing local camera/layout tools retain their owner. Other doors use the typed
            // dispatcher when mounted; the original callbacks remain the unmounted-host fallback.
            fun openHudFeature(id: FeatureId) {
                drawerOpen = false
                toolsOpen = false
                // The folded LAYOUT · EXPAND · FIT dock row: KingdomScreen runs each with the row's own callbacks.
                homeBaseTool(id)?.let { tool -> requests.request(HomeRequest.BaseTool(tool)); return }
                if (openFeature?.invoke(id) == true) return
                when (id.value) {
                    "hud.profile" -> menuActions.run(onProfile)
                    "hud.leagues" -> open(MoreDestination.LEAGUES)
                    // The builders segment owns the builder overview (it replaced KingdomScreen's BUILDERS button); its
                    // HIRE still opens the builder purchase.
                    "hud.builders" -> requests.request(HomeRequest.Builders)
                    "hud.shield" -> menuActions.run(onRaidLog)
                    "hud.quests" -> open(MoreDestination.QUESTS)
                    "hud.dailyCache" -> onCache()
                    "hud.mail" -> open(MoreDestination.MAIL)
                    "hud.chat" -> open(MoreDestination.CHAT)
                    "hud.event" -> open(MoreDestination.TESTER)
                    "hud.attack" -> if (actionsEnabled) requests.request(HomeRequest.RaidChooser)
                    "hud.army" -> requests.request(HomeRequest.Army)
                    "hud.map" -> selectTab(HomeTab.WORLD)
                    "hud.build" -> dispatchHomeBuildDoor(buildEnabled, buildReadOnly, buildRefusalReason,
                        open = { requests.request(HomeRequest.BuildMenu) },
                        explain = { gg.pixelkingdomwars.nativeclient.ui.chrome.Toasts.post(it) },
                        savedConstruction = buildSavedConstruction, showRecovery = { requests.request(HomeRequest.ShowRecovery) })
                    "mine.collect" -> home.base?.buildings?.firstOrNull { it.type == "mine" }?.let { requests.request(HomeRequest.FocusBuilding(it.id)) }
                        ?: gg.pixelkingdomwars.nativeclient.ui.chrome.Toasts.post("Build a Mine first.")
                    // The land herald (FirstHomeLand.kt) opens the designed land gate.
                    LAND_HERALD_TARGET.value -> onOpenLand()
                    // Voyage SPEC §2: the "Ready · Lodge ▸" context chip flies the camera to the finished Lodge.
                    "lodge.focus" -> home.base?.buildings?.firstOrNull { it.type == "lodge" && !it.underConstruction }?.let { requests.request(HomeRequest.FocusBuilding(it.id)) }
                    else -> if (id.value.startsWith("goldforge.")) menuActions.run { onForge(id) }
                }
            }
            fun openHudResources(id: FeatureId?) {
                toolsOpen = false
                val focus = hudDrawerRow(id)
                if (openResources?.invoke(HudIds.RESOURCES, Destination.Resources(focus)) == true) {
                    drawerOpen = false
                    return
                }
                drawerFocus = focus
                drawerOpen = true
            }
            // Voyage SPEC §2: a returned trip's herald and context chip. A defence notice keeps the herald first.
            val voyageSignals = rememberHomeVoyageSignals(home.base?.buildings, home.base?.baseId)
            // hub SPEC §3.1: "Builder finished: <building> Lv <n>" from two server reads of the same base, queued 4 s each.
            val builderHerald = rememberHomeBuilderHerald(home.base?.buildings, home.base?.baseId)
            // home.png context chip: the one transient opportunity (6 s on arrival or when it changes), objective first.
            val transientOpportunity = rememberTransientContext(homeContextCandidate(home, objective))
            // The voyage chip keeps its place; the transient opportunity only fills an empty gap.
            val transientContext = voyageSignals.context ?: transientOpportunity
            // MS-C3 §2: the lifted stack (below) gets these identical ui/actions, so it is the same stack, drawn once.
            // Land as the server said it, only for a signed-in account; unknown (null) raises no land herald or free camp.
            val homeLandOwned = gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live.landOwnedLive(account).takeIf { account.phase == AccountPhase.SIGNED_IN }
            val ordinaryHudUi = homeHudWithBuildRefusal(homeHudForBuild(homeFreeCampHud(homeHudState(home, mail, unreadRaids, chatEnabled, chatUnread, chatMentions, selectionOpen = !showTasks,
                    tools = homeDeckTools(baseLoaded = home.base != null, deedActionsAllowed = toolsAllowed, busy = toolsBusy),
                    toolsOpen = toolsOpen, wallet = wallet, walletLinked = account.session != null,
                    // A defence notice outranks a returned voyage, then a finished builder, then the land line (homeLandHeraldUi's own order).
                    herald = homeHeraldUi(defenceNotice) ?: voyageSignals.herald ?: builderHerald ?: homeLandHeraldUi(homeLandOwned, null), eventButton = eventButton), homeLandOwned), buildOpen), homeBuildDoorReason(buildEnabled, buildReadOnly, buildRefusalReason)).let { ui ->
                        gg.pixelkingdomwars.nativeclient.ui.goldforge.goldForgeHomeHud(ui.copy(context = ui.context ?: voyageSignals.context),
                            hooks.authoritativeResources, hooks.hideHudChrome)
                    }.let { ui -> homeHudWithContext(homeHudWithBuildNew(ui, buildNewTypes), transientContext) }
            val hudUi = homeHudUnderFullScreenSheet(gg.pixelkingdomwars.nativeclient.ui.sheets.army.live.armyHomeHud(ordinaryHudUi, armySheetOpen),
                fullScreenSheets.active)
            val hudOn = HomeHudActions(
                    openFeature = ::openHudFeature,
                    openDrawer = ::openHudResources,
                    focusResource = { drawerFocus = it },
                    closeDrawer = { drawerOpen = false },
                    toggleTools = { toolsOpen = it },
                )
            val lifted = homeStackLifted(hooks.hasOverlay || buildOpen || armySheetOpen, hudShown = true, drawerOpen = drawerOpen, menuOpen = overflow)
            val hudAlpha by androidx.compose.animation.core.animateFloatAsState(if (hudShown) 1f else 0f,
                androidx.compose.animation.core.tween(if (hudShown) gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens.Motion.PLATE_IN else 0,
                    easing = gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens.Motion.Out), label = "hud")
            // Field report 2026-10-06 (every frame after the swap over 16 ms): the HUD is composed and measured while the wallpaper
            // covers Home, but not placed (so not drawn, not tappable, not in semantics), so its first composition is never
            // paid in the swap frames; showing it only places it and fades it in.
            Box(Modifier.fillMaxSize().placedOnlyWhen(hudShown || hudAlpha > 0f)
                .graphicsLayer { alpha = hudAlpha; compositingStrategy = androidx.compose.ui.graphics.CompositingStrategy.ModulateAlpha }) {
            HomeHud(hudUi, hudOn,
                drawer = if (drawerOpen) homeResourceDrawer(home, drawerFocus, wallet = wallet, walletLinked = account.session != null,
                    materials = drawerMaterials) else null,
                sealShown = hooks.resourcesBlocked || armySheetOpen, stackLifted = lifted,
            ) }
            // The peek points at the CHAT edge tab, which BUILD hides.
            if (!buildOpen && !fullScreenSheets.active) chatPeek()
            if (lifted) liftedHud = hudUi to hudOn
        }
        if (overflow) {
            BackHandlerAt(BackPriority.SHEET) { closeMenu() }
            Box(Modifier.fillMaxSize().blockSceneInput().clickable(indication = null, interactionSource = remember { MutableInteractionSource() }) { closeMenu() })
            // Web HudOverflowPanel: sheet in portrait, popover in landscape — the same grid either way, because
            // width decides the column count. It scrolls internally rather than growing past the viewport.
            BoxWithConstraints(Modifier.align(Alignment.TopStart).windowInsetsPadding(WindowInsets.safeDrawing).padding(8.dp)
                .widthIn(max = if (landscape) 640.dp else 480.dp).fillMaxWidth()) {
                val columns = menuColumns(maxWidth.value.roundToInt())
                val snapshot = home.base
                val go: (MoreDestination) -> Unit = { open(it) }
                val readouts = listOf(
                    MenuCellSpec("trophy", "TROPHIES", snapshot?.player?.trophies?.let(::fmtN) ?: "…", description = "Trophies, ranked leagues") { go(MoreDestination.LEAGUES) },
                    MenuCellSpec("energy", "ENERGY", homeEnergyValue(snapshot?.energy), description = "Energy ${homeEnergyValue(snapshot?.energy)}"),
                    MenuCellSpec("shield", "RAID LOG", hudShield(home, unreadRaids), hot = unreadRaids > 0, description = "${hudShield(home, unreadRaids)} · Raid log") { menuActions.run(onRaidLog) },
                    MenuCellSpec("quests", "QUESTS", homeMenuValue(MoreDestination.QUESTS, home, mail, tester, chatUnread, chatMentions),
                        description = homeMenuLabel(MoreDestination.QUESTS, home, mail, tester, chatUnread, chatMentions)) { go(MoreDestination.QUESTS) },
                    MenuCellSpec("streak", "DAILY CACHE", homeCacheValue(home.mine?.cache), hot = home.mine?.cache?.claimable == true, enabled = snapshot != null,
                        description = "Daily cache ${homeCacheValue(home.mine?.cache)}") { menuActions.run(onCache) },
                    MenuCellSpec("mail", "MAIL", homeMenuValue(MoreDestination.MAIL, home, mail, tester, chatUnread, chatMentions), hot = (mail?.pendingRewards ?: 0) > 0,
                        description = homeMenuLabel(MoreDestination.MAIL, home, mail, tester, chatUnread, chatMentions)) { go(MoreDestination.MAIL) },
                )
                // A base still to choose is surfaced on the single LAND entry (web BASES · SELECT), whose page carries SWITCH BASE.
                val needsSelect = account.directory?.selectorAvailable == true && account.selectedBaseId == null
                val destinations = listOf(
                    MenuCellSpec("profile", "PROFILE", description = "Profile") { menuActions.run(onProfile) },
                    MenuCellSpec("army", "ARMY", homeArmyValue(snapshot?.armyStatus), description = "Army · ${homeArmyValue(snapshot?.armyStatus)}") { menuActions.run { requests.request(HomeRequest.Army) } },
                    MenuCellSpec("builder", "SHIELDS · BUILDERS · EXPANSION", description = "Shields, builders and expansion purchases") { menuActions.run(onPurchases) },
                ) + homeMenuDestinations().map { destination ->
                    MenuCellSpec(menuArt(destination), menuLabel(destination) + if (destination == MoreDestination.LAND && needsSelect) " · SELECT" else "",
                        homeMenuValue(destination, home, mail, tester, chatUnread, chatMentions),
                        hot = (destination == MoreDestination.LAND && needsSelect) || (destination == MoreDestination.CHAT && chatMentions > 0),
                        description = homeMenuLabel(destination, home, mail, tester, chatUnread, chatMentions)) { go(destination) }
                }
                PixelPlate("bar", Modifier.fillMaxWidth().heightIn(max = (viewportHeight - 16.dp).coerceAtLeast(48.dp)), PaddingValues(10.dp)) {
                    Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text(account.identity?.displayName?.takeIf { it.isNotBlank() } ?: "YOUR KINGDOM", Modifier.weight(1f), color = Palette.gold,
                                style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text("KEEP ${snapshot?.player?.keepLevel ?: "—"}", color = Palette.muted, style = MaterialTheme.typography.labelMedium)
                            ForgedControl("CLOSE", "close", Modifier.size(48.dp), onClick = ::closeMenu)
                        }
                        // The currencies every build and train action debits, plus the wallet: always here, whether or
                        // not the bar had room for SOL, so a phone never has to hunt for its balance.
                        Row(Modifier.fillMaxWidth().heightIn(min = 48.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            ResourceChip("SHARDS", "shards", home.balances?.shards?.let(::fmtN) ?: "…", "shard", Modifier.weight(1f), hudMineFraction(home)) { menuActions.run { onForge(FeatureId("goldforge.open")) } }
                            GameCurrencyChip(home.balances, Modifier.weight(1f)) { go(MoreDestination.ECONOMY) }
                            ResourceChip("SOL", "sol", hudSol(wallet?.sol), "shard", Modifier.weight(1f)) { go(MoreDestination.ECONOMY) }
                        }
                        MenuGrid(readouts, columns)
                        // The devnet faucet keeps its own slot between the actionable group and the destinations; six
                        // cells precede it so the boundary is a whole row in both column counts.
                        faucet()
                        MenuGrid(destinations, columns)
                    }
                }
            }
        }
        }
        // The overlay root: layout only and finite, the one place the safe-drawing insets are applied (and consumed). The
        // host's SheetHost owns its panel gaps and any scrim; nothing here takes a pointer.
        Box(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing), content = hooks.overlay)
        // Readable over the sheet and Seal scrims; no touch and no accessibility action while the host blocks resources.
        liftedHud?.takeIf { homeLiftedStackPainted(lifted = true, fullCardOver = hooks.homeCovered) }
            ?.let { (ui, on) -> if (fullScreenSheets.active) gg.pixelkingdomwars.nativeclient.ui.kit.FullScreenResourceShelf(
                gg.pixelkingdomwars.nativeclient.ui.hud.homeHudPlan(ui.copy(deckVisible = true)).resources, Modifier.zIndex(PkwTokens.Z.RESOURCE_STACK))
            else HomeResourceStack(ui, on, Modifier.zIndex(PkwTokens.Z.RESOURCE_STACK), sealShown = hooks.resourcesBlocked || armySheetOpen) }
        // Owner 2026-10-06: the shelf a full-screen sheet leaves under the safe top for the lifted pills (none without pills).
        val shelfRows = homeShelfRows(liftedHud?.first?.let { gg.pixelkingdomwars.nativeclient.ui.hud.homeHudPlan(it.copy(deckVisible = true)).resources.size } ?: 0,
            fullCardOver = hooks.homeCovered)
        SideEffect { fullScreenSheets.shelf = gg.pixelkingdomwars.nativeclient.ui.kit.FullScreenSheetGeometry.shelfDp(shelfRows).dp }
        }
        // A required update covers the kingdom until it installs (owner 2026-09-25); an optional one stays in the header.
        gg.pixelkingdomwars.nativeclient.update.NativeUpdateGate()
    }
    }
    }
    }
}

@Composable private fun ResourceBar(home: BaseState, wallet: WalletFunds?, unreadRaids: Int, landscape: Boolean,
    overflow: Boolean, attention: Int, menuFocus: FocusRequester, onMenu: () -> Unit,
    onOpen: (MoreDestination) -> Unit, onForge: () -> Unit, onRaidLog: () -> Unit) {
    val rowHeight = maxOf(48.dp, (34 * LocalDensity.current.fontScale + 10).dp)
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val plan = hudBarPlan(maxWidth.value.roundToInt())
        // One row always (web hudBarPlan): a chip that does not fit is REMOVED to the menu's currencies row,
        // never wrapped into a second row over the play field.
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.Top) {
            PixelPlate("shard", Modifier.size(56.dp, rowHeight).focusRequester(menuFocus)
                .then(if (overflow) Modifier.border(2.dp, Palette.gold) else Modifier)
                .semantics { contentDescription = "Player menu, Keep ${home.base?.player?.keepLevel ?: "—"}, $attention notifications" }
                .clickable(role = Role.Button, onClick = onMenu)) {
                Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                        GameArt("profile", Modifier.size(20.dp))
                        Text(home.base?.player?.keepLevel?.toString() ?: "—", style = MaterialTheme.typography.labelSmall, color = Palette.goldHi)
                    }
                    Text("MENU", style = MaterialTheme.typography.labelMedium, color = Palette.text)
                }
                if (attention > 0) Text(attention.toString(), Modifier.align(Alignment.TopEnd).background(Palette.gold).padding(horizontal = 3.dp), color = Palette.ink, style = MaterialTheme.typography.labelSmall)
            }
            Row(Modifier.weight(1f).heightIn(min = rowHeight), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                ResourceChip("SHARDS", "shards", home.balances?.shards?.let(::fmtN) ?: "…", "shard", Modifier.weight(1f), hudMineFraction(home), onForge)
                GameCurrencyChip(home.balances, Modifier.weight(1f)) { onOpen(MoreDestination.ECONOMY) }
                if (plan.sol) ResourceChip("SOL", "sol", hudSol(wallet?.sol), "shard", Modifier.weight(1f)) { onOpen(MoreDestination.ECONOMY) }
                if (plan.shield) ResourceChip("SHIELD", "shield", hudShield(home, unreadRaids), "shard", Modifier.weight(1f), onClick = onRaidLog)
            }
        }
    }
}

/** Web hudBarPlan's progressive disclosure, in dp of the bar's own width (MENU plate included): SHARDS,
 * KEEP and MENU are the floor and never optional; SOL joins once three chips have room beside the plate
 * (a 412dp phone qualifies, a 360dp one does not); the shield readout only on a wide bar. Anything the
 * bar drops is in the menu's currencies row or grid — union, never intersection. */
data class HudBarPlan(val sol: Boolean, val shield: Boolean)
internal fun hudBarPlan(barWidthDp: Int): HudBarPlan = HudBarPlan(sol = barWidthDp >= 380, shield = barWidthDp >= 560)

internal fun hudAttention(home: BaseState, mail: MailStatus?, raids: Int, chat: Int): Int =
    (mail?.unread ?: 0).coerceAtLeast(0) + (mail?.pendingRewards ?: 0).coerceAtLeast(0) + raids.coerceAtLeast(0) + chat.coerceAtLeast(0) + (home.quests?.quests?.count { it.completed && !it.claimed } ?: 0) + if (home.mine?.cache?.claimable == true) 1 else 0

/** The full spoken sentence for a menu cell (TalkBack); the visible cell splits it into [homeMenuValue] + [menuLabel]. */
internal fun homeMenuLabel(destination: MoreDestination, home: BaseState, mail: MailStatus?, tester: TesterProgress?, chat: Int, mentions: Int): String = when (destination) {
    MoreDestination.MAIL -> "MAIL · ${mail?.unread ?: "…"} UNREAD · ${mail?.pendingRewards ?: "…"} REWARDS"
    MoreDestination.CHAT -> "CHAT · $chat UNREAD" + if (mentions > 0) " · $mentions MENTIONS" else ""
    MoreDestination.QUESTS -> home.quests?.quests?.filter { it.scope == "daily" }?.let { "QUESTS · ${it.count { quest -> quest.completed }}/${it.size} DAILY" } ?: "QUESTS"
    MoreDestination.TESTER -> tester?.daily?.let { "FOUNDING KINGDOMS · ${it.todayPoints} POINTS · ${it.streakDays} DAY STREAK" } ?: "FOUNDING KINGDOMS"
    else -> menuLabel(destination)
}

/** The gold VALUE half of a menu cell, web PillVal: terse, because it sits above its label. Null for a plain
 * destination. Unknown counts read as "…" — an unloaded inbox must never claim to be empty. */
internal fun homeMenuValue(destination: MoreDestination, home: BaseState, mail: MailStatus?, tester: TesterProgress?, chat: Int, mentions: Int): String? = when (destination) {
    MoreDestination.MAIL -> mail?.let { "${it.unread} UNREAD" + if (it.pendingRewards > 0) " ◆${it.pendingRewards}" else "" } ?: "…"
    MoreDestination.CHAT -> "$chat UNREAD" + if (mentions > 0) " · @$mentions" else ""
    MoreDestination.QUESTS -> home.quests?.quests?.filter { it.scope == "daily" }?.let { "${it.count { quest -> quest.completed }}/${it.size}" }
    MoreDestination.TESTER -> tester?.daily?.let { "+${it.todayPoints} TODAY" + if (it.streakDays > 0) " · 🔥${it.streakDays}" else "" }
    else -> null
}
/** Web claim row: a claimable cache EXPIRES, so it is the one value that must be found without being read. */
internal fun homeCacheValue(cache: DailyCache?): String = when { cache == null -> "…"; cache.claimable -> "CLAIM!"; else -> "D${cache.currentDay}" }
internal fun homeArmyValue(status: ArmyStatus?): String = status?.let { "${it.readyTroopCount} READY · ${it.trainingTroopCount} TRAINING" } ?: "…"
internal fun homeEnergyValue(energy: Energy?): String = energy?.let { "${it.free ?: "—"}/${it.max}" } ?: "…"
/** Web `selectorEnabled` + BASES · SELECT: the SWITCH BASE entry (LAND page, profile ACCOUNT tab) earns its
 * place only when there is a choice to make. It is no longer a menu cell (owner: "double YOUR BASES and YOUR LAND"). */
internal fun showBaseSwitch(baseCount: Int, selectorAvailable: Boolean, selectedBaseId: String?): Boolean =
    baseCount > 1 || (selectorAvailable && selectedBaseId == null)
/** Grid order of the destination group (web panel order, then the native-only screens). QUESTS and MAIL
 * live in the actionable group above, so they are deliberately absent here. */
private val HOME_MENU_DESTINATIONS = listOf(MoreDestination.TESTER, MoreDestination.INVENTORY, MoreDestination.SHOP, MoreDestination.ECONOMY,
    MoreDestination.MARKET, MoreDestination.LAND, MoreDestination.HEROES, MoreDestination.RESEARCH, MoreDestination.CLANS,
    MoreDestination.CHAT, MoreDestination.LEAGUES, MoreDestination.CODEX, MoreDestination.FEEDBACK, MoreDestination.ABOUT, MoreDestination.SETTINGS)
internal val HOME_MENU_ACTIONABLE = setOf(MoreDestination.QUESTS, MoreDestination.MAIL)
/** Folded, not lost: BASES is a SWITCH BASE row on the LAND page and the profile ACCOUNT tab; ACCOUNT is the
 * profile hub's ACCOUNT tab (web 'Settings and profile' is one row). Neither takes a grid cell. */
internal val HOME_MENU_FOLDED = setOf(MoreDestination.BASES, MoreDestination.ACCOUNT)
internal fun homeMenuDestinations(): List<MoreDestination> = HOME_MENU_DESTINATIONS

internal data class HudCurrency(val label: String, val art: String, val value: String, val plate: String)
internal fun homeGameCurrency(balances: gg.pixelkingdomwars.nativeclient.model.Balances?): HudCurrency =
    if (balances?.features?.gems?.supported == true) HudCurrency("GEMS", "gem", balances.gems?.let(::fmtN) ?: "…", "shard")
    else HudCurrency("KEEP", "keep", balances?.keep?.let(::fmtN) ?: "…", "keep")

@Composable private fun GameCurrencyChip(balances: gg.pixelkingdomwars.nativeclient.model.Balances?, modifier: Modifier, onClick: () -> Unit) {
    val currency = homeGameCurrency(balances)
    ResourceChip(currency.label, currency.art, currency.value, currency.plate, modifier, onClick = onClick)
}

@Composable private fun ResourceChip(label: String, art: String, value: String, plate: String, modifier: Modifier, mine: Float? = null, onClick: () -> Unit) {
    PixelPlate(plate, modifier.heightIn(min = 48.dp).semantics { contentDescription = "$label $value" }.clickable(role = Role.Button, onClick = onClick), PaddingValues(horizontal = 7.dp, vertical = 3.dp)) {
        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.Center) {
            Text(label, color = Palette.muted, style = MaterialTheme.typography.labelSmall.copy(fontSize = 12.sp, lineHeight = 12.sp), maxLines = 1, softWrap = false)
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
                GameArt(art, Modifier.size(if (art == "gem") 24.dp else 18.dp))
                FitValue(value, Modifier.weight(1f), if (plate == "keep") Palette.goldHi else Palette.text)
            }
        }
        if (mine != null) Box(Modifier.align(Alignment.BottomCenter).fillMaxWidth().height(2.dp).background(Palette.ink)
            .semantics { contentDescription = "Mine storage ${(mine * 100).toInt()} percent" }) {
            Box(Modifier.fillMaxHeight().fillMaxWidth(mine).background(if (mine >= 1f) Palette.gold else Color(0xFF8CB36E)))
        }
    }
}

/** A HUD readout is one line, always: a seven-digit KEEP balance beside two other chips on a 412dp phone
 * shrinks its numerals (18→12sp) rather than wrapping "12,405,85 / 5" over two rows. */
@Composable private fun FitValue(text: String, modifier: Modifier, color: Color) {
    val measurer = rememberTextMeasurer()
    val base = MaterialTheme.typography.bodyMedium
    BoxWithConstraints(modifier) {
        val maxPx = with(LocalDensity.current) { maxWidth.toPx() }
        val size = remember(text, maxPx, base) { fitValueSize(HUD_VALUE_SIZES) { sp -> measurer.measure(text, base.copy(fontSize = sp.sp), softWrap = false).size.width <= maxPx } }
        Text(text, style = base.copy(fontSize = size.sp, lineHeight = (size + 2).sp), color = color, maxLines = 1, softWrap = false)
    }
}
internal val HUD_VALUE_SIZES = listOf(18, 17, 16, 15, 14, 13, 12)
/** The largest candidate size whose measured width fits; the smallest when none does (never wrap). */
internal fun fitValueSize(sizes: List<Int>, fits: (Int) -> Boolean): Int = sizes.firstOrNull(fits) ?: sizes.last()

internal fun hudSol(sol: String?): String = sol?.toBigDecimalOrNull()?.takeIf { it.signum() >= 0 }?.let {
    it.setScale(if (it >= java.math.BigDecimal(100)) 1 else 3, java.math.RoundingMode.HALF_UP).toPlainString()
} ?: "…"

internal fun hudMineFraction(home: BaseState): Float? {
    val mining = home.mine?.mining ?: return null
    val capacity = mining.storageCap.toBigDecimalOrNull()?.takeIf { it.signum() > 0 } ?: return null
    val accrued = mining.accrued.toBigDecimalOrNull()?.takeIf { it.signum() >= 0 } ?: return null
    return accrued.divide(capacity, 6, java.math.RoundingMode.HALF_UP).toFloat().coerceIn(0f, 1f)
}

internal fun hudShield(home: BaseState, unreadRaids: Int = 0): String {
    if(unreadRaids > 0) return "RAIDED ×$unreadRaids"
    val raw = home.base?.raw ?: return "…"
    if (!raw.containsKey("shield")) return "…"
    val shield = raw["shield"] as? kotlinx.serialization.json.JsonObject ?: return "—"
    val ms = shield.string("remainingMs")?.toBigDecimalOrNull()
        ?: shield.string("hoursLeft")?.toBigDecimalOrNull()?.multiply(java.math.BigDecimal(3_600_000))
        ?: return "…"
    val seconds = runCatching { ms.divide(java.math.BigDecimal(1_000), 0, java.math.RoundingMode.CEILING).longValueExact() }.getOrNull() ?: return "…"
    val left = fmtDur(seconds).uppercase()
    return if (shield.string("suppressedByWarzone") == "true") "SUPP · $left" else left
}

@Composable private fun HomeDeck(buildOpen: Boolean, buildEnabled: Boolean, buildReadOnly: Boolean, enabled: Boolean,
    modifier: Modifier, onBuild: () -> Unit, onMap: () -> Unit, onRaid: () -> Unit) {
    val measurer = rememberTextMeasurer()
    val density = LocalDensity.current
    val labelStyle = MaterialTheme.typography.labelLarge.copy(fontSize = 16.sp, lineHeight = 17.sp)
    val labels = listOf("BUILD", "MAP", "RAID")
    val sizes = labels.map { measurer.measure(it, labelStyle).size }
    val controlWidth = with(density) { maxOf(64.dp, sizes.maxOf { it.width }.toDp() + 16.dp) }
    val controlHeight = with(density) { maxOf(56.dp, sizes.maxOf { it.height }.toDp() + 36.dp) }
    Column(modifier, horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(4.dp)) {
        if (buildReadOnly) Text("READ-ONLY BASE", Modifier.background(Palette.ink).padding(4.dp), color = Palette.muted, style = MaterialTheme.typography.bodySmall)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            ForgedControl("BUILD", "plus", Modifier.size(controlWidth, controlHeight), selected = buildOpen, enabled = buildEnabled && !buildReadOnly, labelSize = 16, onClick = onBuild)
            ForgedControl("MAP", "map", Modifier.size(controlWidth, controlHeight), labelSize = 16, onClick = onMap)
            ForgedControl("RAID", "raid", Modifier.size(controlWidth, controlHeight), gold = true, enabled = enabled, labelSize = 16, onClick = onRaid)
        }
    }
}

/** The persistent CHAT dock tile (web ChatLauncher): a `dock` plate like LAYOUT · EXPAND · FIT, the drawn
 * speech bubble, and an unread badge (gold, mentions first). Hidden by the caller when chat is disabled. */
@Composable internal fun ChatDockControl(unread: Int, mentions: Int, open: Boolean, onClick: () -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val badge = if (mentions > 0) "@$mentions" else if (unread > 0) unread.toString() else null
    PixelPlate(if (pressed || open) "dock-sunk" else "dock", Modifier.size(52.dp, 48.dp)
        .semantics { contentDescription = "Global chat" + (badge?.let { ", $unread unread" + if (mentions > 0) ", $mentions mentions" else "" } ?: "") }
        .clickable(role = Role.Button, interactionSource = interaction, indication = null, onClick = onClick)) {
        Column(Modifier.fillMaxSize().offset(y = if (pressed || open) 1.dp else 0.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
            ChatGlyph(Modifier.size(18.dp))
            Text("CHAT", style = MaterialTheme.typography.labelMedium.copy(fontSize = 11.sp, lineHeight = 11.sp, letterSpacing = .5.sp), maxLines = 1, softWrap = false, color = Palette.textFaint)
        }
        badge?.let { Text(it, Modifier.align(Alignment.TopEnd).background(Palette.gold).padding(horizontal = 3.dp), color = Palette.ink, style = MaterialTheme.typography.labelSmall, maxLines = 1, softWrap = false) }
    }
}

@Composable private fun ForgedControl(label: String, art: String, modifier: Modifier, gold: Boolean = false, selected: Boolean = false, enabled: Boolean = true, labelSize: Int = 11, onClick: () -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val plate = if (gold && enabled) "gold" else "tab"
    PixelPlate(if (pressed || selected) "$plate-sunk" else plate,
        modifier.clickable(enabled = enabled, role = Role.Button, interactionSource = interaction, indication = null, onClick = onClick), PaddingValues(4.dp)) {
        Column(Modifier.fillMaxSize().offset(y = if (pressed || selected) 1.dp else 0.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
            if (art == "chat") ChatGlyph(Modifier.size(24.dp))
            else GameArt(art, Modifier.size(if (label == "SHOP" || label == "BUILD" || label == "MAP" || label == "MARKET" || label == "RAID") 24.dp else 20.dp))
            Text(label, style = MaterialTheme.typography.labelLarge.copy(fontSize = labelSize.sp, lineHeight = (labelSize + 1).sp), maxLines = 1, overflow = TextOverflow.Clip, color = if (!enabled) Palette.muted else if (gold) Color(0xFF1A171E) else Color(0xFFC4BBA4))
        }
    }
}

/** Web wording: the `exchange` route's screen is titled KEEP WALLET (menu.tsx ExchangeScreen). */
internal fun menuLabel(destination: MoreDestination): String = when (destination) {
    MoreDestination.ECONOMY -> "KEEP WALLET"
    MoreDestination.TESTER -> "FOUNDING KINGDOMS"
    MoreDestination.ABOUT -> "ABOUT / SUPPORT"
    else -> destination.label.uppercase()
}
internal fun menuArt(destination: MoreDestination): String = when (destination) {
    MoreDestination.LAND, MoreDestination.BASES -> "map"
    MoreDestination.RESEARCH -> "energy"
    MoreDestination.HEROES -> "army"
    MoreDestination.INVENTORY -> "backpack"
    MoreDestination.SHOP, MoreDestination.ECONOMY -> "keep"
    MoreDestination.MARKET -> "shards"
    MoreDestination.TESTER -> "keep"
    MoreDestination.CLANS -> "shield"
    MoreDestination.CHAT -> "chat"
    MoreDestination.MAIL, MoreDestination.FEEDBACK, MoreDestination.ABOUT -> "info"
    MoreDestination.LEAGUES -> "trophy"
    MoreDestination.CODEX, MoreDestination.QUESTS -> "quests"
    MoreDestination.SETTINGS -> "settings"
    MoreDestination.ACCOUNT -> "profile"
}

/** Owner 2026-10-06 (full-screen sheets): while a full-screen sheet shows, the Home HUD under it draws nothing that could
 *  peek over or beside the sheet: no deck, tools shelf, herald or context chip, and (deckVisible false) no player badge,
 *  status chip or edge buttons. Only the resource pills stay, lifted onto the sheet's shelf by the scaffold. */
internal fun homeHudUnderFullScreenSheet(ui: HomeHudUi, fullScreenSheet: Boolean): HomeHudUi = if (!fullScreenSheet) ui else
    ui.copy(deckVisible = false, toolsOpen = false, herald = null, context = null)

/** The NO LAND ticker starts right of the left MAIL / CHAT edge-tab column (owner screenshot 1: the CHAT tab covered its
 *  first words); it already sits above the deck through the scene's bottom padding. */
internal fun homeLandTickerStartDp(): Int = HudGeometry.TAB_W
