package gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.AnimationVector1D
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.LocalReducedMotion
import gg.pixelkingdomwars.nativeclient.ui.chrome.Toasts
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.kit.FullScreenSheetBackdrop
import gg.pixelkingdomwars.nativeclient.ui.kit.FullScreenSheetEffect
import gg.pixelkingdomwars.nativeclient.ui.kit.FullScreenSheetGeometry
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.fullScreenSheetShelf
import gg.pixelkingdomwars.nativeclient.ui.kit.SheetGeometry
import gg.pixelkingdomwars.nativeclient.ui.kit.SheetScrim
import gg.pixelkingdomwars.nativeclient.ui.model.SheetSize
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.BuildTray
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.BuildTrayActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.PlaceTap
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.PlacementUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.placeLook
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.CardTap
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.BuildCardUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.UPDATING_BUILD_PRICES
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.NeedMoreActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.NeedMoreSheet
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.PlacementActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.PlacementStrip
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.UpgradeActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.UpgradeSheet
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.cardTap
import gg.pixelkingdomwars.nativeclient.ui.sheets.editor.BuildingInfoActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.editor.BuildingInfoSheet

/*
 * The live BUILDINGS hosts: each takes the facts its current composable already receives (read by LiveBuildingFactsReader)
 * and the SAME callbacks that composable calls, maps them with the pure mappers, and renders the Opus sheet.
 *
 * SheetHost (Codex, `sheets/SheetHost.kt`) does not exist yet, so [LiveHalfSheetHost] / [LiveTallSheetHost] are the
 * smallest stand-ins for its geometry (KIT-API "SheetHost owns position and the slide"): HALF = bottom, 4 dp sides, no
 * scrim, slide in 180 ms; TALL = from y 104 to the bottom, 4 dp sides, the kit's 40 % `SheetScrim`, slide in 220 ms.
 * Reduced motion cross-fades in 120 ms. There is no exit animation (the caller removes the host). TODO(MS-C2): replace
 * both with SheetHost when it lands.
 *
 * Pointer rule: the host roots are plain full-size Boxes with NO clickable / pointerInput / scrim of their own; the only
 * scrim is the kit's SheetScrim under the TALL tray, composed only while the tray is. A HALF sheet has none.
 */

/** The callbacks BuildingSheet (and the command bar) use today, one per action the live INFO / UPGRADE sheets offer. */
internal class LiveBuildingRoutes(
    /** Close the sheet (KingdomScreen: `buildingSheet = null`). */
    val onClose: () -> Unit,
    /** INFO's UPGRADE TO LV n / REARM: open the review (KingdomScreen: `buildingSheet = BuildingSheetMode.FULL`). */
    val onReview: () -> Unit,
    /** The UPGRADE sheet's send: the current sheet's `onUpgrade` (`model.upgrade(building.id)`). */
    val onUpgrade: () -> Unit,
    /** FINISH: the current sheet's / bar's `onFinish` (`model.finishBuilderJob(job)`; a paid finish opens its review). */
    val onFinish: () -> Unit,
    /** CANCEL: the current sheet's cancel confirmation (`confirmation = SheetConfirmation.CancelJob(...)`). */
    val onCancelJob: () -> Unit,
    /** The wall ROW toggle (`model.toggleWallRow`). */
    val onToggleRow: () -> Unit,
    /** The builders chip / BUILDERS door (KingdomScreen: `buildersOpen = true`). */
    val onBuilders: () -> Unit,
    /** Need-more GO TO MINES: select that Mine (`model.selectBuilding(id)`). */
    val onGoToMine: (String) -> Unit,
    /** Need-more BUILD A MINE: open the BUILD tray (`model.openBuildMenu()`). */
    val onOpenBuild: () -> Unit,
    /** A SOL step's UPGRADE (INFO and the UPGRADE sheet): the designed SOL Seal (mount: `LivePaidUpgradeSeal`). It is the
     *  consent; nothing here pays. Defaults to the review until the mount wires it. */
    val onPaidUpgrade: () -> Unit = onReview,
    /** A hero building's INFO primary: the designed Heroes sheet. */
    val onHeroes: () -> Unit = onReview,
    /** A spent trap's REARM TRAP: rearm in place (`model.repairTrap(id)`, Shards), as the bar's REARM. */
    val onRearm: () -> Unit = onReview,
    /** The Keep's fifth action EXPAND (INFO stone row): the Expand sheet (`model.openExpand()`). */
    val onExpand: () -> Unit = {},
)

/** The BUILD tray's callbacks: the current BuildMenu's, plus the builders dock and the Need-more doors. */
internal class LiveTrayRoutes(
    /** `model.audio?.tap(); model.startPlacement(type)`. */
    val onPick: (String) -> Unit,
    /** `model.openBuildMenu(true)` (the current hero recruitment menu). */
    val onHeroes: () -> Unit,
    /** `model.closeSurfaces(); layout.open()`. */
    val onLayouts: () -> Unit,
    /** `model.audio?.tap(); model.closeBuildMenu()`. */
    val onClose: () -> Unit,
    /** `buildersOpen = true`. */
    val onBuilders: () -> Unit,
    /** Need-more GO TO MINES: `model.closeBuildMenu(); model.selectBuilding(id)` (selecting does not close the tray). */
    val onGoToMine: (String) -> Unit,
    /** LOCKED / MAX: explain the card and focus the Keep / an existing instance; never sends an order. */
    val onGoToBuilding: (gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.BuildCardUi) -> Unit,
    /** A HEROES card: start placing that hero's altar (`model.startPlacement(type)`); the band's PLACE opens the review. */
    val onHeroPick: (String) -> Unit = onPick,
) {
    companion object {
        /** b37cc131: only real current-base instances are navigation targets. A zero cap need not own a building. */
        fun goTarget(card: gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.BuildCardUi?,
            buildings: List<gg.pixelkingdomwars.nativeclient.model.Building>): String? {
            val current = card ?: return null
            val type = when (cardTap(current.state)) {
                CardTap.EXPLAIN_LOCKED -> "keep"
                CardTap.EXPLAIN_MAX -> current.type
                else -> return null
            }
            return buildings.firstOrNull { it.type == type && it.id.isNotBlank() }?.id
        }
    }
}

/** The placement dialog's callbacks. */
internal class LivePlacementRoutes(
    /** The dialog's ✓ PLACE: `model.confirmPlacement()`. */
    val onPlace: () -> Unit,
    /** ✕ CANCEL: `model.cancelPlacement()`. */
    val onCancel: () -> Unit,
    /** `buildersOpen = true`. */
    val onBuilders: () -> Unit,
    /** Need-more GO TO MINES: `model.cancelPlacement(); model.selectBuilding(id)`. */
    val onGoToMine: (String) -> Unit,
    /** `model.openBuildMenu()` (leaves placement for the tray). */
    val onOpenBuild: () -> Unit,
    /** A hero offer's PLACE: open the recruitment review (`model.reviewHeroPlacement()`); HeroAltarConfirm is the consent.
     *  Decision 2026-10-06 (safer than the brief's `= onPlace`): unwired, it never falls back to [onPlace], because
     *  `confirmPlacement` would send an ordinary build order for an altar without the recruitment consent; it says so in
     *  the repository's own words instead. */
    val onReviewHero: () -> Unit = { Toasts.post("Review the altar placement again.") },
)

/** The single switch between the live BUILDINGS hosts (true) and the current composables they replace (false):
 *  BuildingSheet's INFO / review forms, BuildMenu and the "Place X" dialog. HOOKUP-buildings-live.md reads it. */
internal const val LIVE_BUILDING_SHEETS: Boolean = true

/** Where a Need-more door goes: the Mine to select, or null for "open the BUILD tray". Pure; every door only navigates. */
internal fun needMoreDoorTarget(door: FeatureId, mine: MineFact): String? =
    if (door == LiveDoors.MINES) mine.mineBuildingId else null

internal fun needMoreActions(mine: MineFact, onGoToMine: (String) -> Unit, onOpenBuild: () -> Unit, close: () -> Unit) =
    NeedMoreActions(onDoor = { door -> close(); needMoreDoorTarget(door, mine)?.let(onGoToMine) ?: onOpenBuild() }, onClose = close)

/** INFO's green primary, routed by [liveInfoUpgradeRoute]: the review, the SOL Seal, the Heroes sheet, an in-place REARM,
 *  or (short) the rearm Need-more. Only REARM acts in place; every other route navigates. */
internal fun dispatchInfoUpgrade(f: BuildingFacts, routes: LiveBuildingRoutes, onRearmShort: () -> Unit) {
    when (liveInfoUpgradeRoute(f)) {
        InfoUpgradeRoute.REVIEW -> routes.onReview()
        InfoUpgradeRoute.PAID -> routes.onPaidUpgrade()
        InfoUpgradeRoute.HEROES -> routes.onHeroes()
        InfoUpgradeRoute.REARM -> routes.onRearm()
        InfoUpgradeRoute.REARM_SHORT -> onRearmShort()
    }
}

/** PLACE on the band, re-read at tap time: a Shards build sends `confirmPlacement` ([onPlace]); a hero offer only opens
 *  its recruitment review ([onReviewHero]); anything else says why. */
internal fun dispatchPlace(fresh: PlacementUi?, hero: Boolean, onPlace: () -> Unit, onReviewHero: () -> Unit, explain: (String) -> Unit) {
    if (fresh != null && placeLook(fresh.state, fresh.price, fresh.reason).tap == PlaceTap.PLACE) {
        if (hero) onReviewHero() else onPlace()
    } else explain(fresh?.reason ?: "Placement changed. Check the current spot and price.")
}

/** INFO's fifth action (correction 7). */
internal fun dispatchInfoExtra(f: BuildingFacts, routes: LiveBuildingRoutes) {
    when (liveInfoExtraKind(f)) {
        InfoExtraKind.CANCEL_JOB -> routes.onCancelJob()
        InfoExtraKind.TOGGLE_ROW -> routes.onToggleRow()
        InfoExtraKind.EXPAND -> routes.onExpand()
        null -> Unit
    }
}

/** The slide / fade-in a host gives its sheet, 0..1. */
@Composable private fun rememberEnter(durationMs: Int): Animatable<Float, AnimationVector1D> {
    val reduced = LocalReducedMotion.current
    val enter = remember { Animatable(0f) }
    LaunchedEffect(Unit) {
        enter.animateTo(1f, tween(if (reduced) PkwTokens.Motion.REDUCED_CROSSFADE else durationMs, easing = PkwTokens.Motion.Out))
    }
    return enter
}

/** HALF: bottom-aligned, 4 dp sides, no scrim (the kingdom above stays live; the scene's own tap closes it). */
@Composable internal fun LiveHalfSheetHost(modifier: Modifier = Modifier, content: @Composable (Modifier) -> Unit) {
    val reduced = LocalReducedMotion.current
    val enter = rememberEnter(PkwTokens.Motion.HALF_SHEET_IN)
    Box(modifier.fillMaxSize(), contentAlignment = Alignment.BottomCenter) {
        content(Modifier.fillMaxWidth().padding(horizontal = 4.dp).graphicsLayer {
            if (reduced) alpha = enter.value else translationY = size.height * (1f - enter.value)
        })
    }
}

/** TALL. Owner 2026-10-06 ("make it full screen"): on a phone-width window it is one opaque full-screen card (kit
 *  FullScreenSheet.kt) that slides up whole: the backdrop over the whole window, the sheet edge to edge from below the
 *  resource shelf to the safe bottom, no scrim and no world strip (Back and the sheet's own X close it). Its parent is
 *  the whole window (KingdomScreen's root, a route screen). On a wide window it keeps the framed design: from y 104 to
 *  the bottom, 4 dp sides, over the kit's 40 % scrim (a scrim tap closes; never confirms), inside the safe sides and
 *  bottom (K-night-A11: in landscape the camera cut-out is on a side and the navigation bar may show). A framed slot
 *  shorter than the sheet's fixed parts is handled by the sheet's own shell (kit SheetFit.kt: the header collapses, the
 *  action row stays pinned). */
@Composable internal fun LiveTallSheetHost(onScrimTap: () -> Unit, modifier: Modifier = Modifier, content: @Composable (Modifier) -> Unit) {
    val reduced = LocalReducedMotion.current
    val enter = rememberEnter(PkwTokens.Motion.SHEET_IN)
    val fills = FullScreenSheetGeometry.fillsScreen(SheetSize.TALL, LocalConfiguration.current.screenWidthDp.toFloat())
    FullScreenSheetEffect(active = fills)
    val shelf = fullScreenSheetShelf()
    if (fills) Box(modifier.fillMaxSize().graphicsLayer { if (reduced) alpha = enter.value else translationY = size.height * (1f - enter.value) }) {
        FullScreenSheetBackdrop()
        content(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing).padding(top = shelf))
    } else Box(modifier.fillMaxSize()) {
        SheetScrim(SheetSize.TALL, onScrimTap, progress = enter.value)
        content(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Bottom + WindowInsetsSides.Horizontal))
            .padding(top = SheetGeometry.TALL_TOP_DP.dp, start = 4.dp, end = 4.dp).graphicsLayer {
                if (reduced) alpha = enter.value else translationY = size.height * (1f - enter.value)
            })
    }
}

/** INFO (registry row 30): the BuildingInfo half sheet, with Need-more in place for a SHORT cost chip or a short REARM.
 *  Its primary acts by [dispatchInfoUpgrade]; an off primary and every refusal say why (toast), never silent. */
@Composable internal fun LiveBuildingInfoHost(review: LiveBuildingSheetFacts, routes: LiveBuildingRoutes, modifier: Modifier = Modifier,
    sheetModifier: Modifier = Modifier) {
    val facts = review.facts
    var needMore by rememberSaveable(facts.buildingId) { mutableStateOf(false) }
    var rearmMore by rememberSaveable(facts.buildingId) { mutableStateOf(false) }
    val more = if (needMore) liveUpgradeNeedMore(review) else if (rearmMore) liveRearmNeedMore(facts) else null
    BackHandlerAt(BackPriority.SHEET, enabled = more != null) { needMore = false; rearmMore = false }
    LiveHalfSheetHost(modifier) { placed ->
        if (more != null) NeedMoreSheet(more, needMoreActions(facts.mine, routes.onGoToMine, routes.onOpenBuild) {
            needMore = false; rearmMore = false
        }, placed.then(sheetModifier))
        else BuildingInfoSheet(liveBuildingInfoUi(review), BuildingInfoActions(
            onClose = routes.onClose,
            onUpgrade = { dispatchInfoUpgrade(facts, routes) { rearmMore = true } },
            onFinish = routes.onFinish,
            onGetMore = { needMore = true },
            onExtra = { dispatchInfoExtra(facts, routes) },
            onExplain = { Toasts.post(it) },
        ), placed.then(sheetModifier))
    }
}

/**
 * UPGRADE (the review): the UPGRADE half sheet for a SHARDS-only upgrade (Need-more in place for SHORT) or a SOL step (its
 * primary opens the SOL Seal through `routes.onPaidUpgrade`, never the Shards order). Draws nothing when
 * [liveUpgradeSheetUi] declines; the caller checks `liveUpgradeSheetUi(facts) != null` first and otherwise keeps the
 * current BuildingSheet (KEEP / item priced, a running job).
 */
@Composable internal fun LiveUpgradeHost(review: LiveBuildingSheetFacts, routes: LiveBuildingRoutes, modifier: Modifier = Modifier,
    sheetModifier: Modifier = Modifier) {
    val facts = review.facts
    // Only this sheet's own press makes it BUSY "Starting…"; cleared when the model is idle again.
    var sent by remember(facts.buildingId) { mutableStateOf(false) }
    LaunchedEffect(facts.busy) { if (!facts.busy) sent = false }
    var needMore by rememberSaveable(facts.buildingId) { mutableStateOf(false) }
    val ui = liveUpgradeSheetUi(review, sent) ?: return
    val more = if (needMore) liveUpgradeNeedMore(review) else null
    BackHandlerAt(BackPriority.SHEET, enabled = more != null) { needMore = false }
    LiveHalfSheetHost(modifier) { placed ->
        if (more != null) NeedMoreSheet(more, needMoreActions(facts.mine, routes.onGoToMine, routes.onOpenBuild) { needMore = false }, placed.then(sheetModifier))
        else UpgradeSheet(ui, UpgradeActions(
            // UpgradeSheet calls this only when `upgradePrimaryLook(...).sends` (a payable READY price). A SOL step opens
            // the Seal instead of sending.
            onUpgrade = { dispatchUpgradeSheetPrimary(ui, { sent = true; routes.onUpgrade() }, routes.onPaidUpgrade) },
            onGetMore = { needMore = true },
            onBuilders = routes.onBuilders,
            onClose = routes.onClose,
        ), placed.then(sheetModifier))
    }
}

/** One tap rechecks the strict owner. Held digits are never a route to placement or a stale shortfall. */
internal fun dispatchLiveBuildCard(card: BuildCardUi?, costs: LiveBuildingCosts, busy: Boolean,
    onPick: (String) -> Unit, onNeedMore: (String) -> Unit, onGoToBuilding: (BuildCardUi) -> Unit,
    explain: (String) -> Unit) {
    if (card == null) return
    val tap = cardTap(card.state)
    val needsCurrent = tap == CardTap.PLACE || tap == CardTap.NEED_MORE ||
        tap == CardTap.EXPLAIN_LOCKED || tap == CardTap.EXPLAIN_MAX
    if (card.priceHeld || (needsCurrent && (busy || !costs.reviewCurrent()))) {
        explain(UPDATING_BUILD_PRICES)
        return
    }
    when (tap) {
        CardTap.PLACE -> {
            val price = costs.build(card.type)
            if (price != null && (!price.current || price.held || price.price.status == gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus.UNAVAILABLE))
                explain(UPDATING_BUILD_PRICES)
            else onPick(card.type)
        }
        CardTap.NEED_MORE -> onNeedMore(card.type)
        CardTap.EXPLAIN_LOCKED, CardTap.EXPLAIN_MAX -> onGoToBuilding(card)
        CardTap.EXPLAIN_UNAVAILABLE -> card.reason?.let { explain(it) }
        // REQUIRES stays in the tray; BuildTray owns its scroll and pulse.
        else -> Unit
    }
}

/**
 * BUILD (hud.build): the TALL BUILD tray, Need-more over it for a SHORT card. With [heroes] (the hero recruitment state)
 * the HEROES tab draws the altar offers in place; a pick starts placement (`routes.onHeroPick`) and entering the tab asks
 * [onHeroRefresh] for fresh offers. Without it HEROES stays the old recruitment door (`routes.onHeroes`).
 */
@Composable internal fun LiveBuildTrayHost(review: LiveBuildTrayFacts, mine: MineFact, routes: LiveTrayRoutes, modifier: Modifier = Modifier,
    focusType: String? = null, initialTab: String = LiveTrayTabs.BUILDINGS,
    supplies: (@Composable (List<gg.pixelkingdomwars.nativeclient.ui.model.TabUi>, (String) -> Unit, () -> Unit, () -> Unit, Modifier) -> Unit)? = null,
    heroes: gg.pixelkingdomwars.nativeclient.data.HeroRecruitmentState? = null, onHeroRefresh: () -> Unit = {}) {
    val facts = review.facts
    var tab by rememberSaveable(initialTab) { mutableStateOf(initialTab) }
    var focus by remember { mutableStateOf(focusType) }
    var needMoreFor by rememberSaveable { mutableStateOf<String?>(null) }
    val heroTray = heroes?.let(::liveHeroTray)
    val ui = liveBuildTrayUi(review, tab, focus, heroTray, newlyUnlockedBuildTypes(facts))
    val more = needMoreFor?.let { liveTrayNeedMore(review, it, mine) }
    BackHandlerAt(BackPriority.SHEET, enabled = more != null) { needMoreFor = null }
    Box(modifier.fillMaxSize()) {
        LiveTallSheetHost(onScrimTap = routes.onClose) { placed ->
            val changeTab: (String) -> Unit = { id ->
                // With the recruitment state HEROES renders in place. Entering it refreshes the offers once (the old menu's
                // REFRESH HERO CONTRACTS); an initial HEROES tab is refreshed by the screen's own heroesOnly effect.
                if (id == LiveTrayTabs.HEROES && heroes != null) { if (tab != id) onHeroRefresh(); tab = id }
                else when (id) {
                    LiveTrayTabs.HEROES -> routes.onHeroes()
                    LiveTrayTabs.LAYOUTS -> routes.onLayouts()
                    LiveTrayTabs.SUPPLIES -> if (supplies != null) tab = id else Toasts.post("Supplies are unavailable right now.")
                    LiveTrayTabs.BUILDINGS, LiveTrayTabs.DEFENCES, LiveTrayTabs.TRAPS -> tab = id
                    else -> Toasts.post("Not available right now")
                }
            }
            if (tab == LiveTrayTabs.SUPPLIES && supplies != null)
                supplies(ui.tabs, changeTab, { routes.onClose(); routes.onBuilders() }, routes.onClose, placed)
            else BuildTray(ui, BuildTrayActions(
                onTab = changeTab,
                onCard = { type ->
                    val card = ui.sections.flatMap { it.cards }.firstOrNull { it.type == type }
                    if (ui.selectedTab == LiveTrayTabs.HEROES)
                        dispatchHeroCard(card, facts.busy || heroes?.busy == true, routes.onHeroPick, routes.onGoToBuilding) { Toasts.post(it) }
                    else dispatchLiveBuildCard(card, review.costs, facts.busy, routes.onPick,
                        { needMoreFor = it }, routes.onGoToBuilding, { Toasts.post(it) })
                },
                onClose = routes.onClose,
                onBuilders = routes.onBuilders,
            ), placed)
        }
        if (more != null) LiveHalfSheetHost { placed ->
            NeedMoreSheet(more, needMoreActions(mine, routes.onGoToMine, onOpenBuild = { tab = LiveTrayTabs.BUILDINGS; focus = "mine" }) { needMoreFor = null }, placed)
        }
    }
}

/** Placement (a single SHARDS building, or a hero offer): the PLACE band, Need-more over it for SHORT. A hero's PLACE
 *  opens the recruitment review (`routes.onReviewHero`); HeroAltarConfirm stays the consent. Draws nothing when
 *  [livePlacementUi] declines (walls, KEEP-priced builds); the caller then keeps the current panel or dialog. */
@Composable internal fun LivePlacementHost(review: LivePlacementSheetFacts, mine: MineFact, routes: LivePlacementRoutes, modifier: Modifier = Modifier) {
    val facts = review.facts
    var needMore by remember(facts.type) { mutableStateOf(false) }
    val ui = livePlacementUi(review) ?: return
    val more = if (needMore) livePlacementNeedMore(review, mine) else null
    BackHandlerAt(BackPriority.SHEET, enabled = more != null) { needMore = false }
    Box(modifier.fillMaxSize()) {
        PlacementStrip(ui, PlacementActions(
            onMove = {}, // The scene-sized LivePlacementWorldLayer owns dragging; ground taps remain in SceneSurface.
            onPlace = { dispatchPlace(livePlacementUi(review), facts.heroOffer, routes.onPlace, routes.onReviewHero) { Toasts.post(it) } },
            onCancel = routes.onCancel,
            onNeedMore = { needMore = true },
            onBuilders = routes.onBuilders,
        ))
        if (more != null) LiveHalfSheetHost { placed ->
            NeedMoreSheet(more, needMoreActions(mine, routes.onGoToMine, routes.onOpenBuild) { needMore = false }, placed)
        }
    }
}
