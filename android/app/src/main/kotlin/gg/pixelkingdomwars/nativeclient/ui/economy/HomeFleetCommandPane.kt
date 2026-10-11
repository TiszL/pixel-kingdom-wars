package gg.pixelkingdomwars.nativeclient.ui.economy

import androidx.compose.foundation.focusGroup
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.onConsumedWindowInsetsChanged
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.layout.layoutId
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import gg.pixelkingdomwars.nativeclient.AppGraph
import gg.pixelkingdomwars.nativeclient.SessionGraph
import gg.pixelkingdomwars.nativeclient.ui.chrome.GamePage
import gg.pixelkingdomwars.nativeclient.ui.chrome.OutlinedButton
import gg.pixelkingdomwars.nativeclient.ui.kit.FullScreenSheetBackdrop
import gg.pixelkingdomwars.nativeclient.ui.kit.FullScreenSheetEffect
import gg.pixelkingdomwars.nativeclient.ui.kit.FullScreenSheetGeometry
import gg.pixelkingdomwars.nativeclient.ui.kit.fullScreenSheetShelf
import gg.pixelkingdomwars.nativeclient.ui.model.SheetSize
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import gg.pixelkingdomwars.nativeclient.ui.nav.graphViewModel
import gg.pixelkingdomwars.nativeclient.ui.phasee.EquipmentRegistration
import gg.pixelkingdomwars.nativeclient.ui.phasee.KeepEquipmentMarketRegistration
import gg.pixelkingdomwars.nativeclient.ui.phasee.PaidStarterExpeditionRegistration
import gg.pixelkingdomwars.nativeclient.ui.phasee.PhaseEActivityScope
import gg.pixelkingdomwars.nativeclient.ui.phasee.VehicleRegistration
import gg.pixelkingdomwars.nativeclient.wallet.WalletLogin
import kotlin.math.roundToInt

/** Existing command surfaces, including the hoisted KEEP Market, shown one at a time beside the real Home. */
enum class FleetCommandDestination { STARTER, PAID_STARTER, VEHICLES, EQUIPMENT, KEEP_MARKET }

/** One existing command owner (its registration keeps the client/model/lifetime/journal); the root only shows or hides its form. */
class FleetCommandOwner(val destination: FleetCommandDestination, val available: Boolean, val isOpen: Boolean,
    val open: () -> Unit, val close: () -> Unit,
    val starter: gg.pixelkingdomwars.nativeclient.ui.home.HomeStarterOwner? = null,
    val vehicle: gg.pixelkingdomwars.nativeclient.ui.home.HomeVehicleOwner? = null,
    val openHistory: (() -> Unit)? = null,
    val openEntry: ((String) -> Unit)? = null,
    val openHistoryEntry: ((String) -> Unit)? = null,
    val form: @Composable () -> Unit) {
    /** Select only; the root invokes this through its existing guarded handoff. Missing receipt entry never opens live controls. */
    fun entryOpening(entryName: String?, historyOnly: Boolean): (() -> Unit)? {
        if (entryName == null) return if (historyOnly) openHistory else open
        val callback = (if (historyOnly) openHistoryEntry else openEntry) ?: return null
        return { callback(entryName) }
    }
}

/** The common root's view of the existing owners: which ONE form is shown, nothing else. */
class FleetCommandOwners(val owners: List<FleetCommandOwner>) {
    val starter: gg.pixelkingdomwars.nativeclient.ui.home.HomeStarterOwner?
        get() = owners.firstOrNull { it.destination == FleetCommandDestination.STARTER }?.starter
    val vehicle: gg.pixelkingdomwars.nativeclient.ui.home.HomeVehicleOwner?
        get() = owners.firstOrNull { it.destination == FleetCommandDestination.VEHICLES }?.vehicle
    fun destination(): FleetCommandDestination? = fleetCommandDestination(owners.filter { it.isOpen }.map { it.destination })
    fun form(): (@Composable () -> Unit)? = destination()?.let { d -> owners.first { it.destination == d }.form }
    fun open(destination: FleetCommandDestination) { owners.firstOrNull { it.destination == destination }?.open?.invoke() }
    fun closeAll() = owners.forEach { it.close() }
    /** Selecting another panel dismisses the prior transient presentation only; nothing is submitted or re-targeted. */
    fun closeExcept(keep: FleetCommandDestination) = owners.filter { it.destination != keep }.forEach { it.close() }
}

/** Pure: at most one form is current; when owners disagree the earliest destination wins deterministically. */
fun fleetCommandDestination(open: List<FleetCommandDestination>): FleetCommandDestination? = open.minOrNull()

/** What an opening callback captures when it is composed: the exact session, selected-base generation and admitted content identity. */
data class FleetCommandScopeIdentity(val session: Any?, val baseGeneration: Long, val contentIdentity: Any?, val presentationRevision: Long = 0L)

/** Pure: a captured callback is admitted only for the SAME session/base generation/content identity while its presentation lifetime
 *  is still active. Presentation freshness only — never art readiness or spending admission. */
fun fleetCommandOpeningAdmitted(captured: FleetCommandScopeIdentity, current: FleetCommandScopeIdentity, lifetimeActive: Boolean): Boolean =
    lifetimeActive && captured.session != null && captured.session === current.session &&
        captured.baseGeneration == current.baseGeneration && captured.contentIdentity === current.contentIdentity &&
        captured.presentationRevision == current.presentationRevision

/** One presentation lifetime (one FleetCommandScope composition for one session): retired on disposal; holds ITS OWN owners only. */
class FleetPresentationLifetime {
    var active = true
        private set
    var owners: FleetCommandOwners? = null
    /** UI-R2: advanced by the REAL transitions (lifecycle stop/start, battle visibility change); every callback captured before
     *  a transition is stale afterwards, even once eligibility returns. Observable state so the root recaptures. */
    var revision by mutableStateOf(0L)
        private set
    fun advance() { revision += 1 }
    fun retire() { active = false; owners = null }
}

/** The production opening seam every owner's open/entry goes through. [attempt] validates the captured identity against the current
 *  one BEFORE touching any owner or navigation; a stale attempt is a complete no-op (it cannot close the replacement lifetime's owners),
 *  an admitted one dismisses only the OTHER owners of its own lifetime and then runs the navigation hook. */
class FleetCommandOpening(private val captured: FleetCommandScopeIdentity, private val lifetime: FleetPresentationLifetime,
    private val current: () -> FleetCommandScopeIdentity, private val canOpenNow: () -> Boolean = { true }, private val onAdmitted: () -> Unit) {
    /** UI-R3: [canOpenNow] is read LIVE at invocation (actual lifecycle currentState + current battle/replay/spectator state), never a
     *  Boolean captured at recomposition — a stopped activity or an active battle refuses even with a fresh matching revision, and a
     *  battle change refuses before the asynchronous revision effect has run. Checked before any owner mutation or navigation. */
    fun attempt(destination: FleetCommandDestination): Boolean {
        if (!canOpenNow() || !fleetCommandOpeningAdmitted(captured, current(), lifetime.active)) return false
        lifetime.owners?.closeExcept(destination); onAdmitted(); return true
    }
}

/** Pure: an opening is eligible now only in the foreground (lifecycle at least STARTED) with no battle/replay/spectator presentation. */
fun fleetCommandOpeningEligible(lifecycleStarted: Boolean, battleActive: Boolean): Boolean = lifecycleStarted && !battleActive

/** ONE visible starter driver for the shared starter repository: the ordinary form or the retained standalone route when visible,
 *  else the paid form when shown, else none (discovery housekeeping may run). */
enum class StarterDriver { ORDINARY, PAID, NONE }
fun starterDriver(ordinaryVisible: Boolean, paidFormVisible: Boolean): StarterDriver = when {
    ordinaryVisible -> StarterDriver.ORDINARY
    paidFormVisible -> StarterDriver.PAID
    else -> StarterDriver.NONE
}
/** The paid owner may refresh/dismiss the shared repository only while the ordinary driver is NOT visible. */
fun paidStarterHousekeeps(driver: StarterDriver): Boolean = driver != StarterDriver.ORDINARY

/** Pure: pane close is a SHEET-priority Back; the screens' own CONFIRM handlers (review open) dispatch first. */
fun fleetCommandBackPriority(reviewOpen: Boolean): Int = if (reviewOpen) BackPriority.CONFIRM else BackPriority.SHEET

/** Focus handoff: exactly when a shown form closes (header close or Back), focus returns to the live retained Home target. */
class FleetCommandFocusHandoff {
    private var previous: FleetCommandDestination? = null
    fun transition(current: FleetCommandDestination?): Boolean { val restore = previous != null && current == null; previous = current; return restore }
}

const val FLEET_COMMAND_CONTROL_DP = 48
const val FLEET_COMMAND_HOME_MIN_DP = 160
const val FLEET_COMMAND_HOME_STRIP_DP = 48          // constrained windows: Home stays a visible strip, never zero
const val FLEET_COMMAND_FORM_MIN_DP = 220           // header + three 48dp controls + padding, in USABLE (non-keyboard) space
const val FLEET_COMMAND_FORM_SIDE_MIN_DP = 320
/** The fixed chrome GamePage spends inside the form region: header row (48dp close target + 2×4dp) + divider, and body padding 2×14dp. */
const val FLEET_COMMAND_PAGE_HEADER_DP = 57
const val FLEET_COMMAND_PAGE_BODY_PADDING_DP = 28

/** [homeDp] + [formDp] == the split axis; both nonzero. [usableFormDp] = the form minus the bottom inset it alone carries (IME or
 *  nav bar, whichever remains unconsumed) — the pane never applies an inset itself. [bodyViewportDp] = the scrolling body actually
 *  left after the unconsumed TOP inset, the fixed header/divider and the body padding, in BOTH orientations; [controlsFit] says
 *  honestly whether one 48dp control row fits in that viewport. */
data class FleetCommandLayout(val sideBySide: Boolean, val homeDp: Int, val formDp: Int, val usableFormDp: Int, val bodyViewportDp: Int, val controlsFit: Boolean)

/** Pure. Inputs are the UNCONSUMED insets at the pane (ancestors' consumption already removed): [topInsetDp] the safe top the
 *  form's GamePage will still pad, [bottomInsetDp] = max(safe bottom, IME) it will still pad. Preferred: form usable ≥ 220dp·fontScale
 *  (+ top inset) and Home ≥ 160dp. Constrained: Home a nonzero strip, the form keeps header + one row when the window allows; when it
 *  physically cannot, [controlsFit] is false and nothing pretends otherwise. */
fun fleetCommandLayout(widthDp: Int, heightDp: Int, fontScale: Float, bottomInsetDp: Int, topInsetDp: Int = 0): FleetCommandLayout {
    val scale = fontScale.coerceAtLeast(1f)
    val top = topInsetDp.coerceAtLeast(0); val chrome = top + FLEET_COMMAND_PAGE_HEADER_DP + FLEET_COMMAND_PAGE_BODY_PADDING_DP
    val formMin = (FLEET_COMMAND_FORM_MIN_DP * scale).roundToInt() + top; val usableMin = chrome + FLEET_COMMAND_CONTROL_DP
    fun body(usable: Int) = (usable - chrome).coerceAtLeast(0)
    val sideBySide = widthDp >= 600 && widthDp > heightDp
    if (sideBySide) {
        val total = widthDp.coerceAtLeast(0)
        var form = maxOf(FLEET_COMMAND_FORM_SIDE_MIN_DP, widthDp * 45 / 100).coerceIn(0, total)
        var home = total - form
        if (home < FLEET_COMMAND_HOME_MIN_DP) { home = (total / 3).coerceAtLeast(if (total > 0) 1 else 0); form = total - home }
        val usableHeight = (heightDp - bottomInsetDp.coerceAtLeast(0)).coerceAtLeast(0) // the keyboard reduces HEIGHT, not the split
        val viewport = body(usableHeight)
        return FleetCommandLayout(true, home, form, form, viewport, viewport >= FLEET_COMMAND_CONTROL_DP)
    }
    val total = heightDp.coerceAtLeast(0); val bottom = bottomInsetDp.coerceAtLeast(0).coerceAtMost(total); val free = total - bottom
    var usable = maxOf(formMin, free * 55 / 100).coerceAtMost(free); var home = free - usable
    if (home < FLEET_COMMAND_HOME_MIN_DP) {
        home = (free - formMin).coerceIn(FLEET_COMMAND_HOME_STRIP_DP.coerceAtMost(free), FLEET_COMMAND_HOME_MIN_DP.coerceAtMost(free))
        usable = free - home
        if (usable < usableMin) { home = (free - usableMin).coerceAtLeast(if (free > 1) 1 else 0); usable = free - home }
    }
    val viewport = body(usable)
    return FleetCommandLayout(false, home, usable + bottom, usable, viewport, viewport >= FLEET_COMMAND_CONTROL_DP)
}

/** UI-R3: the production recovery branch consumed when the normal layout cannot place a usable form. */
enum class FleetCommandRecoveryKind { HIDE_KEYBOARD, ENLARGE_OR_CLOSE }
enum class FleetCommandPlacement { FORM, RECOVERY, HOME_ONLY }
const val FLEET_COMMAND_RECOVERY_WIDTH_DP = 160
/** Dp rectangles from the pane origin: Home keeps [homeWidthDp]×[homeHeightDp]; ONE 48dp recovery control sits in the remaining safe area. */
data class FleetCommandRecovery(val kind: FleetCommandRecoveryKind, val beside: Boolean, val homeWidthDp: Int, val homeHeightDp: Int,
    val controlXDp: Int, val controlYDp: Int, val controlWidthDp: Int, val controlHeightDp: Int)

/** Pure: null while the normal layout is usable. Otherwise the keyboard-recovery (IME shown) or enlarge/close (no IME) branch: Home stays
 *  nonzero, the control takes the last 48dp of the safe area below Home (stacked) or a 160dp column beside Home (wide), and when no 48dp
 *  target physically fits the control is zero-sized so nothing clipped is ever exposed. */
fun fleetCommandRecovery(layout: FleetCommandLayout, widthDp: Int, heightDp: Int, topInsetDp: Int, bottomInsetDp: Int, keyboardShown: Boolean): FleetCommandRecovery? {
    if (layout.controlsFit) return null
    val kind = if (keyboardShown) FleetCommandRecoveryKind.HIDE_KEYBOARD else FleetCommandRecoveryKind.ENLARGE_OR_CLOSE
    val top = topInsetDp.coerceAtLeast(0); val bottom = bottomInsetDp.coerceAtLeast(0); val safeHeight = heightDp - top - bottom
    if (safeHeight < FLEET_COMMAND_CONTROL_DP || widthDp < FLEET_COMMAND_CONTROL_DP) return FleetCommandRecovery(kind, false, widthDp, heightDp, 0, 0, 0, 0)
    if (layout.sideBySide && widthDp - FLEET_COMMAND_RECOVERY_WIDTH_DP >= FLEET_COMMAND_CONTROL_DP)
        return FleetCommandRecovery(kind, true, widthDp - FLEET_COMMAND_RECOVERY_WIDTH_DP, heightDp, widthDp - FLEET_COMMAND_RECOVERY_WIDTH_DP, top, FLEET_COMMAND_RECOVERY_WIDTH_DP, FLEET_COMMAND_CONTROL_DP)
    val controlY = heightDp - bottom - FLEET_COMMAND_CONTROL_DP
    return FleetCommandRecovery(kind, false, widthDp, controlY.coerceAtLeast(1), 0, controlY, widthDp, FLEET_COMMAND_CONTROL_DP)
}
/** Pure: what the pane places — the form, the recovery control (form measured but UNPLACED: not drawn, not hit-tested, outside
 *  semantics), or Home only when no target fits. */
fun fleetCommandPlacement(recovery: FleetCommandRecovery?): FleetCommandPlacement = when {
    recovery == null -> FleetCommandPlacement.FORM
    recovery.controlWidthDp <= 0 || recovery.controlHeightDp <= 0 -> FleetCommandPlacement.HOME_ONLY
    else -> FleetCommandPlacement.RECOVERY
}

private const val HOME_SLOT = "fleet-home"
private const val FORM_SLOT = "fleet-form"
private const val RECOVERY_SLOT = "fleet-recovery"

/**
 * Owner 2026-10-06 ("every sheet is full screen, status bar to navigation bar; no darkened game camera above a sheet; nothing
 * overlapping", phone/v7-berth-refresh-081811.png): on a phone-width window an open fleet form (VEHICLE RECEIPTS, the Berth's
 * crafted controls, Tools, the KEEP Market, starter expeditions, every receipts page and storage notice of these owners) is
 * one opaque full-screen card over Home, like the Berth that opens it (ui/kit/FullScreenSheet.kt), instead of the lower part
 * of a split under a strip of the live kingdom. A wide window keeps the side-by-side split, as SheetHost keeps its framed
 * sheets there. Pure: JVM-tested in HomeFleetCommandFullScreenTest.
 */
fun fleetCommandFillsScreen(destination: FleetCommandDestination?, windowWidthDp: Float): Boolean =
    destination != null && FullScreenSheetGeometry.fillsScreen(SheetSize.TALL, windowWidthDp)

/** The bounded, non-modal pane. [home] is composed at ONE slot whether or not a form is open (the Kingdom slot key never changes). */
@OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable fun HomeFleetCommandPane(destination: FleetCommandDestination?, onClose: () -> Unit, form: @Composable () -> Unit, home: @Composable () -> Unit) {
    val density = LocalDensity.current
    val fontScale = density.fontScale
    // Full screen on a phone: the Home root hides its HUD and draws the resource pills on the shelf above the card (the
    // registry HomeScaffold provides), and the card starts below that shelf, so no pill or herald ever draws over it.
    val fills = fleetCommandFillsScreen(destination, LocalConfiguration.current.screenWidthDp.toFloat())
    FullScreenSheetEffect(active = fills)
    val shelf = fullScreenSheetShelf()
    // UI-R2: size from the insets that are still UNCONSUMED at this pane (ancestors' padding/consumption subtracted); the form's
    // GamePage alone pads them (safeDrawing then ime, the pair never pads twice) — the pane and Home apply none.
    var consumed by remember { mutableStateOf<WindowInsets?>(null) }
    val safe = WindowInsets.safeDrawing; val keyboard = WindowInsets.ime
    val topInsetDp = with(density) { (safe.getTop(this) - (consumed?.getTop(this) ?: 0)).coerceAtLeast(0).toDp().value.roundToInt() }
    val bottomInsetDp = with(density) { (maxOf(safe.getBottom(this), keyboard.getBottom(this)) - (consumed?.getBottom(this) ?: 0)).coerceAtLeast(0).toDp().value.roundToInt() }
    BackHandlerAt(fleetCommandBackPriority(reviewOpen = false), destination != null, onClose)
    // UI-R1: presentation is bound to THIS Home/Kingdom slot — when the slot leaves composition (another Home tab, another route),
    // every transient form closes (dismiss only; originals and authoritative work are preserved by the owners).
    val latestClose = rememberUpdatedState(onClose)
    DisposableEffect(Unit) { onDispose { latestClose.value() } }
    // UI-R1: focus returns to the live retained Home target exactly when a shown form has closed (header close or Back).
    val homeFocus = remember { FocusRequester() }
    val handoff = remember { FleetCommandFocusHandoff() }
    LaunchedEffect(destination) { if (handoff.transition(destination)) runCatching { homeFocus.requestFocus() } }
    val keyboardController = LocalSoftwareKeyboardController.current; val focusManager = LocalFocusManager.current
    val keyboardShown = with(density) { keyboard.getBottom(this) > 0 }
    BoxWithConstraints(Modifier.fillMaxSize().onConsumedWindowInsetsChanged { consumed = it }) {
        val widthDp = maxWidth.value.roundToInt(); val heightDp = maxHeight.value.roundToInt()
        val plan = fleetCommandLayout(widthDp, heightDp, fontScale, bottomInsetDp, topInsetDp)
        // A full-screen form has the whole window and pads the keyboard itself: no split to recover from.
        val recovery = if (destination == null || fills) null else fleetCommandRecovery(plan, widthDp, heightDp, topInsetDp, bottomInsetDp, keyboardShown)
        val placement = fleetCommandPlacement(recovery)
        // UI-R3 recovery: the SAME form composition/model/review stays alive but is not placed; its keyboard focus is cleared so the
        // hidden form receives no IME or confirmation input. When the inset shrinks the same form is placed again — nothing dismissed.
        LaunchedEffect(placement) { if (placement != FleetCommandPlacement.FORM) runCatching { focusManager.clearFocus(force = true) } }
        Layout(content = {
            // Under a full-screen form the covered Home leaves the semantics tree (as SheetHost does for a covering card).
            Box(Modifier.layoutId(HOME_SLOT).focusRequester(homeFocus).focusGroup()
                .then(if (fills) Modifier.clearAndSetSemantics { } else Modifier)) { home() }
            if (destination != null) Box(Modifier.layoutId(FORM_SLOT)) {
                // The opaque card: the backdrop to every screen edge (taps never reach the kingdom), the form below the shelf;
                // the form pads the safe-drawing and keyboard insets itself, as it did in the split.
                if (fills) FullScreenSheetBackdrop()
                Box(Modifier.fillMaxSize().padding(top = if (fills) shelf else 0.dp)) { form() }
            }
            if (placement == FleetCommandPlacement.RECOVERY && recovery != null) Box(Modifier.layoutId(RECOVERY_SLOT)) {
                OutlinedButton(onClick = {
                    if (recovery.kind == FleetCommandRecoveryKind.HIDE_KEYBOARD) { keyboardController?.hide(); runCatching { focusManager.clearFocus(force = true) } } else onClose()
                }, Modifier.fillMaxSize().heightIn(min = FLEET_COMMAND_CONTROL_DP.dp)) {
                    Text(if (recovery.kind == FleetCommandRecoveryKind.HIDE_KEYBOARD) "HIDE KEYBOARD" else "CLOSE · ENLARGE TO REVIEW")
                }
            }
        }, modifier = Modifier.fillMaxSize()) { measurables, constraints ->
            val width = constraints.maxWidth; val height = constraints.maxHeight
            val homeMeasurable = measurables.first { it.layoutId == HOME_SLOT }
            val formMeasurable = measurables.firstOrNull { it.layoutId == FORM_SLOT }
            val recoveryMeasurable = measurables.firstOrNull { it.layoutId == RECOVERY_SLOT }
            if (formMeasurable == null) {
                val placed = homeMeasurable.measure(Constraints.fixed(width, height))
                return@Layout layout(width, height) { placed.place(0, 0) }
            }
            if (fills) {
                // Home keeps its full size (the scene is not resized under the card); the card is placed over it.
                val homePlaced = homeMeasurable.measure(Constraints.fixed(width, height))
                val formPlaced = formMeasurable.measure(Constraints.fixed(width, height))
                return@Layout layout(width, height) { homePlaced.place(0, 0); formPlaced.place(0, 0) }
            }
            if (recovery != null) {
                // Keep the form composed (measured with the layout it would have had) but UNPLACED; place Home and, if it fits, the control.
                val formPx = if (plan.sideBySide) Constraints.fixed((width - plan.homeDp.dp.roundToPx()).coerceAtLeast(0), height)
                    else Constraints.fixed(width, (height - plan.homeDp.dp.roundToPx()).coerceAtLeast(0))
                formMeasurable.measure(formPx)
                val homeW = recovery.homeWidthDp.dp.roundToPx().coerceIn(1, width); val homeH = recovery.homeHeightDp.dp.roundToPx().coerceIn(1, height)
                val homePlaced = homeMeasurable.measure(Constraints.fixed(homeW, homeH))
                val controlPlaced = recoveryMeasurable?.takeIf { placement == FleetCommandPlacement.RECOVERY }?.measure(
                    Constraints.fixed(recovery.controlWidthDp.dp.roundToPx().coerceIn(0, width), recovery.controlHeightDp.dp.roundToPx().coerceIn(0, height)))
                return@Layout layout(width, height) {
                    homePlaced.place(0, 0)
                    controlPlaced?.place(recovery.controlXDp.dp.roundToPx().coerceIn(0, width), recovery.controlYDp.dp.roundToPx().coerceIn(0, height))
                }
            }
            if (plan.sideBySide) {
                val homePx = plan.homeDp.dp.roundToPx().coerceIn(0, width)
                val homePlaced = homeMeasurable.measure(Constraints.fixed(homePx, height))
                val formPlaced = formMeasurable.measure(Constraints.fixed(width - homePx, height))
                layout(width, height) { homePlaced.place(0, 0); formPlaced.place(homePx, 0) }
            } else {
                val homePx = plan.homeDp.dp.roundToPx().coerceIn(0, height)
                val homePlaced = homeMeasurable.measure(Constraints.fixed(width, homePx))
                val formPlaced = formMeasurable.measure(Constraints.fixed(width, height - homePx))
                layout(width, height) { homePlaced.place(0, 0); formPlaced.place(0, homePx) }
            }
        }
    }
}

/** The ordinary starter owner: the SAME repository/model setup as the StarterExpeditionRoute (graphViewModel keyed by session). */
@Composable private fun StarterExpeditionOwner(graph: AppGraph, session: SessionGraph, admit: () -> Boolean, onStarterFleet: () -> Unit): FleetCommandOwner {
    val account by graph.account.state.collectAsState(); val content by graph.content.state.collectAsState()
    val raid by session.interlock.state.collectAsState()
    val loaded = remember(session) { runCatching { session.starterExpedition } }
    val repository = loaded.getOrNull()
    val model = repository?.let { graphViewModel(session) { StarterExpeditionViewModel(it) } }
    var show by rememberSaveable(session.session.wallet) { mutableStateOf(false) }
    val homeVisibility = remember(model) { gg.pixelkingdomwars.nativeclient.ui.home.HomeVoyageVisibility() }
    val homeVisible = !show && homeVisibility.isCurrent(gg.pixelkingdomwars.nativeclient.ui.home.homeOwnerProjectionIdentity(graph, session))
    gg.pixelkingdomwars.nativeclient.ui.home.HomeStarterDepartureDriver(model, homeVisible, account.baseSelectionGeneration,
        content.manifest, content.allowsGameOrders(graph.versionCode) && raid.actionsAllowed)
    // UI-R2: base-generation change AND admitted content-owner replacement retire an open transient review through THIS driver
    // when it is the visible one (the paid owner has the same rule while it drives); originals/recovery untouched.
    LaunchedEffect(model, account.baseSelectionGeneration, content.manifest, show) { if (show) model?.dismiss() }
    val close = { model?.dismiss(); show = false }
    val lifecycle = androidx.lifecycle.compose.LocalLifecycleOwner.current.lifecycle
    val owner = gg.pixelkingdomwars.nativeclient.ui.home.rememberHomeProjection(session, model,
        gg.pixelkingdomwars.nativeclient.ui.home.homeOwnerProjectionIdentity(graph, session)) {
        model?.let { existing -> gg.pixelkingdomwars.nativeclient.ui.home.projectHomeOwner(graph, session, existing.state,
            admitted = { (show || homeVisibility.isCurrent(gg.pixelkingdomwars.nativeclient.ui.home.homeOwnerProjectionIdentity(graph, session))) &&
                lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.STARTED) && !existing.state.value.busy && !existing.busy.value },
            reviewBlocked = { existing.state.value.review != null }) }?.let { p ->
            fun homeCurrent(): Boolean {
                val battle = session.battle.state.value
                return p.currentState() != null && homeVisibility.isCurrent(p.identity) && !show &&
                    lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.RESUMED) &&
                    graph.content.state.value.allowsGameOrders(graph.versionCode) && session.interlock.state.value.actionsAllowed &&
                    !battle.battleVisible && battle.replay == null && battle.spectator == null &&
                    model?.state?.value?.busy == false && model.busy.value == false
            }
            gg.pixelkingdomwars.nativeclient.ui.home.HomeStarterOwner(p,
                p.readAction { _: Unit -> model?.refresh() }, p.readAction { _: Unit -> model?.check() },
                voyage = gg.pixelkingdomwars.nativeclient.ui.home.HomeStarterCommands(homeVisibility, ::homeCurrent,
                    reviewRoute = { route -> check(homeCurrent()); requireNotNull(model?.start(route)).join() },
                    reviewSaved = { check(homeCurrent()); requireNotNull(model?.reviewSaved()).join() },
                    confirm = { review -> check(homeCurrent()); requireNotNull(model?.confirm(review)).join() },
                    dismiss = { model?.dismiss() },
                    finishAccepted = { check(homeCurrent()); requireNotNull(model?.finish()).join() },
                    archiveUnused = { check(homeCurrent()); requireNotNull(model?.archiveUnusedOrRefused()).join() }))
        }
    }
    return FleetCommandOwner(FleetCommandDestination.STARTER, available = true, isOpen = show, open = { if (admit()) show = true }, close = close, starter = owner) {
        if (model == null) gg.pixelkingdomwars.nativeclient.ui.phasee.PhaseEDesignedNotice("EXPEDITION RECOVERY", "Expeditions",
            "Saved expedition recovery could not be opened. Keep this app's data; no request was sent or replaced. " +
                "Reopen after storage is available. ${loaded.exceptionOrNull()?.message ?: "Recovery storage is unavailable."}", close)
        else StarterExpeditionScreen(model, session.session.wallet, account.selectedBaseId, account.baseSelectionGeneration,
            content.allowsGameOrders(graph.versionCode) && raid.actionsAllowed, onFleet = { model.dismiss(); onStarterFleet() }, onBack = close)
    }
}

/** Hoists the EXISTING registration owners (plus the ordinary starter) above the Home/Bases split, inside the one
 *  PhaseEActivityScope the Bases ActivityHost reads. [content] is composed at ONE site; owners are null without a session.
 *  UI-R1: every opening goes through ONE [FleetCommandOpening] capturing session/base generation/content identity and this
 *  composition's [FleetPresentationLifetime]; [ordinaryRouteVisible] folds the retained standalone route into the one-driver rule. */
@Composable fun FleetCommandScope(graph: AppGraph, session: SessionGraph?, wallet: WalletLogin?, ordinaryRouteVisible: Boolean,
    onOpened: () -> Unit, onStarterFleet: () -> Unit, content: @Composable (FleetCommandOwners?) -> Unit) {
    PhaseEActivityScope(session ?: graph) {
        val account by graph.account.state.collectAsState(); val admitted by graph.content.state.collectAsState()
        val lifetime = remember(session) { FleetPresentationLifetime() }
        DisposableEffect(lifetime) { onDispose { lifetime.retire() } }
        // UI-R2: the REAL transitions — lifecycle stop/start and any battle visibility change — advance the presentation revision,
        // so every opening callback captured before them is stale afterwards (also once eligibility returns).
        val lifecycle = LocalLifecycleOwner.current.lifecycle
        DisposableEffect(lifetime, lifecycle) {
            val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_STOP || event == Lifecycle.Event.ON_START) lifetime.advance() }
            lifecycle.addObserver(observer); onDispose { lifecycle.removeObserver(observer) }
        }
        val battle = session?.battle?.state?.collectAsState()?.value
        val battleActive = battle != null && (battle.battleVisible || battle.replay != null || battle.spectator != null)
        LaunchedEffect(lifetime, battleActive) { lifetime.advance() }
        val latestOpened = rememberUpdatedState(onOpened)
        val captured = FleetCommandScopeIdentity(session, account.baseSelectionGeneration, admitted.manifest, lifetime.revision)
        val opening = remember(lifetime, captured) {
            FleetCommandOpening(captured, lifetime, { FleetCommandScopeIdentity(graph.sessionGraph.value, graph.account.state.value.baseSelectionGeneration, graph.content.state.value.manifest, lifetime.revision) },
                canOpenNow = { // read LIVE at invocation: actual lifecycle state + the session's current battle/replay/spectator state
                    val now = session?.battle?.state?.value
                    fleetCommandOpeningEligible(lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED), now != null && (now.battleVisible || now.replay != null || now.spectator != null))
                }) { latestOpened.value() }
        }
        val owners = if (session == null) null else {
            val starter = StarterExpeditionOwner(graph, session, { opening.attempt(FleetCommandDestination.STARTER) }, onStarterFleet)
            FleetCommandOwners(listOf(starter,
                PaidStarterExpeditionRegistration(graph, session, ordinaryVisible = starter.isOpen || ordinaryRouteVisible ||
                    starter.starter?.voyage?.visibility?.isCurrent(gg.pixelkingdomwars.nativeclient.ui.home.homeOwnerProjectionIdentity(graph, session)) == true) { opening.attempt(FleetCommandDestination.PAID_STARTER) },
                VehicleRegistration(graph, session, wallet) { opening.attempt(FleetCommandDestination.VEHICLES) },
                EquipmentRegistration(graph, session) { opening.attempt(FleetCommandDestination.EQUIPMENT) },
                KeepEquipmentMarketRegistration(graph, session, wallet) { opening.attempt(FleetCommandDestination.KEEP_MARKET) }))
        }
        lifetime.owners = owners
        content(owners)
    }
}
