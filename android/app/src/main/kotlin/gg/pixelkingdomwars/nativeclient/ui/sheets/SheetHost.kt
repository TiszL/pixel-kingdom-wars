package gg.pixelkingdomwars.nativeclient.ui.sheets

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.core.MutableTransitionState
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.calculateEndPadding
import androidx.compose.foundation.layout.calculateStartPadding
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.scene.sceneInputRegion
import gg.pixelkingdomwars.nativeclient.ui.kit.FullScreenSheetBackdrop
import gg.pixelkingdomwars.nativeclient.ui.kit.FullScreenSheetEffect
import gg.pixelkingdomwars.nativeclient.ui.kit.FullScreenSheetGeometry
import gg.pixelkingdomwars.nativeclient.ui.kit.ModalScrim
import gg.pixelkingdomwars.nativeclient.ui.kit.bleedOver
import gg.pixelkingdomwars.nativeclient.ui.kit.fullScreenSheetShelf
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.sheetScrimAlpha
import gg.pixelkingdomwars.nativeclient.ui.model.SheetFrameUi
import gg.pixelkingdomwars.nativeclient.ui.model.SheetSize
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import kotlin.math.min

/** [FULL_SCREEN]: owner 2026-10-06, a TALL or FULL sheet on a phone-width window is one opaque card over the whole
 *  screen (see ui/kit/FullScreenSheet.kt); the other three are the framed design geometry. */
internal enum class SheetHostPlacement { BOTTOM, END, CENTER, FULL_SCREEN }

/** Layout policy, in dp inside the finite viewport supplied by the Home mount. */
internal data class SheetHostLayout(
    val placement: SheetHostPlacement,
    val widthDp: Float,
    val maxHeightDp: Float,
    val topInsetDp: Float,
    val bottomInsetDp: Float,
    val scrimAlpha: Float,
)

// review 092decf3 (2026-10-02): FULL uses these design gaps; the kit token successor is not published yet.
// The Home mount has already consumed system insets, so the bottom gap here excludes the gesture inset.
private const val FULL_SHEET_TOP_GAP_DP = 60f
private const val FULL_SHEET_BOTTOM_GAP_DP = 14f

internal fun sheetHostLayout(size: SheetSize, viewportWidthDp: Float, viewportHeightDp: Float): SheetHostLayout {
    require(viewportWidthDp.isFinite() && viewportWidthDp >= 0f)
    require(viewportHeightDp.isFinite() && viewportHeightDp >= 0f)
    val landscape = viewportWidthDp > viewportHeightDp
    val gutter = PkwTokens.Space.sheetGutter.value
    val scrim = sheetScrimAlpha(size)
    if (size == SheetSize.FULL) {
        val top = min(FULL_SHEET_TOP_GAP_DP, viewportHeightDp)
        val belowTop = (viewportHeightDp - top).coerceAtLeast(0f)
        val bottom = min(FULL_SHEET_BOTTOM_GAP_DP, belowTop)
        val width = (viewportWidthDp - 2f * gutter).coerceAtLeast(0f)
        return SheetHostLayout(
            SheetHostPlacement.CENTER, if (landscape) min(720f, width) else width,
            (belowTop - bottom).coerceAtLeast(0f), top, bottom, scrim,
        )
    }
    if (landscape) return SheetHostLayout(
        SheetHostPlacement.END, min(480f, viewportWidthDp / 2f), viewportHeightDp, 0f, 0f, scrim,
    )
    if (size == SheetSize.HALF) return SheetHostLayout(
        SheetHostPlacement.BOTTOM, viewportWidthDp, viewportHeightDp / 2f, 0f, 0f, scrim,
    )
    val top = min(PkwTokens.Dims.tallSheetTop.value, viewportHeightDp)
    return SheetHostLayout(
        SheetHostPlacement.BOTTOM, viewportWidthDp,
        (viewportHeightDp - top).coerceAtLeast(0f), top, 0f, scrim,
    )
}

/**
 * Owner 2026-10-06 (OWNER-FEEDBACK-0450Z, "make it full screen"): a TALL or FULL sheet that fills the screen
 * ([FullScreenSheetGeometry.fillsScreen]) takes the whole safe viewport below the resource shelf ([shelfDp], 0 when
 * no pill is lifted), edge to edge, with no scrim and no world strip. The host's opaque backdrop also covers the
 * safe-drawing insets around this viewport (the camera cut-out strip). The framed [sheetHostLayout] stays for HALF and
 * for wide windows.
 */
internal fun sheetHostFullScreenLayout(viewportWidthDp: Float, viewportHeightDp: Float, shelfDp: Float): SheetHostLayout {
    require(viewportWidthDp.isFinite() && viewportWidthDp >= 0f)
    require(viewportHeightDp.isFinite() && viewportHeightDp >= 0f)
    val top = min(if (shelfDp.isFinite()) shelfDp.coerceAtLeast(0f) else 0f, viewportHeightDp)
    return SheetHostLayout(SheetHostPlacement.FULL_SCREEN, viewportWidthDp, (viewportHeightDp - top).coerceAtLeast(0f), top, 0f, 0f)
}

internal data class SheetHostMotion(val enterMs: Int, val exitMs: Int, val slide: Boolean)

internal fun sheetHostMotion(size: SheetSize, reducedMotion: Boolean): SheetHostMotion = when {
    reducedMotion -> SheetHostMotion(PkwTokens.Motion.REDUCED_CROSSFADE, PkwTokens.Motion.REDUCED_CROSSFADE, false)
    size == SheetSize.HALF -> SheetHostMotion(PkwTokens.Motion.HALF_SHEET_IN, PkwTokens.Motion.HALF_SHEET_OUT, true)
    else -> SheetHostMotion(PkwTokens.Motion.SHEET_IN, PkwTokens.Motion.SHEET_OUT, true)
}

/** Transient host bookkeeping referring to owner types; not a new frame/UI model or saved state. */
internal data class SheetHostContent(val scope: SheetScope, val entry: SheetEntry, val frame: SheetFrameUi)

internal fun sheetHostContent(
    scope: SheetScope,
    stack: SheetStack,
    frame: (SheetEntry) -> SheetFrameUi,
    previous: SheetHostContent? = null,
): SheetHostContent? = stack.top?.let { SheetHostContent(scope, it, frame(it)) }
    ?: previous?.takeIf { it.scope == scope }

internal fun sheetHostVisible(currentVisible: Boolean, targetVisible: Boolean, transitionRunning: Boolean = false): Boolean =
    currentVisible || targetVisible || transitionRunning

/** A FULL card covers Home, and so does a TALL sheet that [fillsScreen] (owner 2026-10-06): the covered Home then leaves
 *  the semantics tree, so a screen reader never walks the hidden HUD behind an opaque sheet. HALF never covers. */
internal fun sheetHostCoversHome(
    size: SheetSize?,
    currentVisible: Boolean,
    targetVisible: Boolean,
    transitionRunning: Boolean = false,
    fillsScreen: Boolean = false,
): Boolean = (size == SheetSize.FULL || (fillsScreen && size == SheetSize.TALL)) &&
    sheetHostVisible(currentVisible, targetVisible, transitionRunning)

/** Back, X and a dismissal gesture all consult the existing screen owner before popping history. */
internal fun dispatchSheetClose(sheetVisible: Boolean, onDismissNested: () -> Boolean, onPop: () -> Unit): Boolean {
    if (!sheetVisible) return false
    if (!onDismissNested()) onPop()
    return true
}

internal fun sheetClosesOnSceneTap(size: SheetSize?): Boolean = size == SheetSize.HALF

/**
 * Hoisted, ephemeral presentation state, replaced for every session/base/selection-generation scope.
 * HomeShell reads [fullCardVisible] directly and aggregates it with overlay coverage before rendering
 * BaseSceneBinding. There are no park/resume methods, coverage callbacks, or disposal-time clears.
 */
@Stable
class SheetHostState internal constructor(val scope: SheetScope) {
    internal var content: SheetHostContent? by mutableStateOf(null)
    internal val visibility = MutableTransitionState(false)
    /** The window width, from the configuration at each composition of [rememberSheetHostState]; unknown never fills. */
    internal var windowWidthDp: Float by mutableStateOf(Float.POSITIVE_INFINITY)

    /** The current sheet fills the screen (owner 2026-10-06): an opaque card, no scrim, the resource pills on its shelf. */
    val fillsScreen: Boolean get() = FullScreenSheetGeometry.fillsScreen(content?.frame?.size, windowWidthDp)

    /** Includes the complete exit animation, even after the stack's final entry has been popped. */
    val visible: Boolean get() = sheetHostVisible(visibility.currentState, visibility.targetState, !visibility.isIdle)
    val fullCardVisible: Boolean get() = sheetHostCoversHome(content?.frame?.size,
        currentVisible = visibility.currentState, targetVisible = visibility.targetState, transitionRunning = !visibility.isIdle,
        fillsScreen = fillsScreen)

    /** Scene input uses this to consume an outside Half-sheet tap before selecting anything. */
    val closesOnSceneTap: Boolean get() = visible && sheetClosesOnSceneTap(content?.frame?.size)

    /** Also used by the Half-sheet scene-tap seam. During exit it consumes without another callback. */
    fun close(onDismissNested: () -> Boolean, onPop: () -> Unit): Boolean {
        if (!visible) return false
        if (!visibility.targetState) return true
        return dispatchSheetClose(sheetVisible = true, onDismissNested = onDismissNested, onPop = onPop)
    }
}

/**
 * Call above the Home-covered provider, with the already scope-checked active [stack]. [frame] is a
 * pure mapper over the existing entry. A changed top replaces the prior presentation immediately;
 * an empty stack retains its same-scope final frame only for the close animation. A scope change
 * creates a fresh transition, so a previous account/base cannot remain painted while fading away.
 * The mount MUST also wrap state creation, the coverage provider and SheetHost in
 * key(homeStacks.selectedTab): tab identity is not part of SheetScope, and an old tab's exit must
 * not paint over the newly selected tab. The two saved histories stay outside that key.
 */
@Composable
fun rememberSheetHostState(
    scope: SheetScope,
    stack: SheetStack,
    frame: (SheetEntry) -> SheetFrameUi,
): SheetHostState {
    val state = remember(scope) { SheetHostState(scope) }
    state.windowWidthDp = LocalConfiguration.current.screenWidthDp.toFloat()
    state.content = sheetHostContent(scope, stack, frame, state.content)
    state.visibility.targetState = !stack.isEmpty
    return state
}

/**
 * Geometry/motion/Back host for one active Home sheet. [render] must attach its supplied modifier to
 * the painted frame and pass the supplied close callback to X. It receives the original entry so tab,
 * scroll and restore metadata remain available; this host adds no scroll container. Opus17c184db's
 * SheetFrame accepts an owner ScrollState, or null for a self-scrolling body. The actual body owner
 * must restore and write back its own state against the current scope, tab and entry; private sheet
 * wrappers still need to expose that state. Forwarding SheetEntry is not scroll-restoration proof.
 *
 * REQUIRED MOUNT: HomeShell owns lifetime and reads state.fullCardVisible. This host, the scene and
 * overlays share the same SceneInputScope. Tall/Full ModalScrim paints and blocks the FULL available
 * viewport, including the area above each panel's reserved top gap. Resource controls paint in a root
 * slot ABOVE this host and Seal scrims. Their input is disabled during Seal/gate (Beacon092); visibility
 * never bypasses consent. The inset is panel geometry, not a hole in the scrim. Empty placement
 * ancestors have no pointer nodes.
 *
 * Half has no scrim or outside pointer node. On a scene tap the owner checks state.closesOnSceneTap,
 * calls state.close with the same nested/pop callbacks, and consumes that event without selecting a
 * building or terrain. Scene and non-sheet commands must be resolved before reaching this host.
 *
 * The mount supplies a finite viewport with WindowInsets.safeDrawing applied exactly once (HomeScaffold's
 * overlay root). Owner 2026-10-06 ("make it full screen"): the host lays its root back out over those
 * insets (ui/kit bleedOver) and pads every panel by the same raw insets itself, so the render slot sees
 * the same safe viewport as before while a full-screen card's opaque backdrop reaches the screen edges
 * (the camera cut-out strip included). A TALL or FULL sheet on a phone-width window is that card:
 * backdrop + panel slide together, no scrim, no world strip, the panel below the resource shelf
 * (LocalFullScreenSheets). HALF, and TALL / FULL on a wide window, keep the framed geometry above.
 * The parent must consume its applied insets for descendants too, so legacy bodies that call
 * navigationBarsPadding do not add them again. Do not add another system inset to the render slot.
 * Keep this host and rememberSheetHostState inside the same key(homeStacks.selectedTab) boundary.
 */
@Composable
fun SheetHost(
    state: SheetHostState,
    onPop: () -> Unit,
    onDismissNested: () -> Boolean,
    reducedMotion: Boolean,
    modifier: Modifier = Modifier,
    render: @Composable (entry: SheetEntry, frame: SheetFrameUi, onClose: () -> Unit, modifier: Modifier) -> Unit,
) {
    // Re-key the animated subtree too, so its remembered outgoing content never crosses a scope.
    key(state.scope) {
        val content = state.content
        if (content != null) {
            val currentPop by rememberUpdatedState(onPop)
            val currentDismissNested by rememberUpdatedState(onDismissNested)
            val close: () -> Unit = { state.close(currentDismissNested, currentPop); Unit }
            BackHandlerAt(BackPriority.SHEET, enabled = state.visible, onBack = close)
            // Owner 2026-10-06: a sheet that fills the screen tells the Home root while it shows (exit included), so the
            // root draws the resource pills on the shelf and hides the rest of its HUD.
            val fills = state.fillsScreen
            FullScreenSheetEffect(active = fills && state.visible)
            val shelf = fullScreenSheetShelf()
            val safe = WindowInsets.safeDrawing.asPaddingValues()
            // The mount applied the safe-drawing insets once; the host re-expands over them (bleedOver) so a full-screen
            // card reaches every screen edge, and pads its panels by the same insets itself.
            BoxWithConstraints(modifier.fillMaxSize().bleedOver(WindowInsets.safeDrawing).clipToBounds()) {
                val direction = LocalLayoutDirection.current
                val safeStart = safe.calculateStartPadding(direction)
                val safeEnd = safe.calculateEndPadding(direction)
                val safeTop = safe.calculateTopPadding()
                val safeBottom = safe.calculateBottomPadding()
                val viewportWidth = (maxWidth - safeStart - safeEnd).value.coerceAtLeast(0f)
                val viewportHeight = (maxHeight - safeTop - safeBottom).value.coerceAtLeast(0f)
                val layout = if (fills) sheetHostFullScreenLayout(viewportWidth, viewportHeight, shelf.value)
                    else sheetHostLayout(content.frame.size, viewportWidth, viewportHeight)
                val motion = sheetHostMotion(content.frame.size, reducedMotion)
                // A full-screen sheet is one opaque card that slides in and out; the kingdom is never faded or dimmed.
                // Framed sheets and reduced motion keep their fade (DESIGN-SYSTEM §7).
                val fade = layout.placement != SheetHostPlacement.FULL_SCREEN || !motion.slide
                AnimatedVisibility(
                    visibleState = state.visibility,
                    modifier = Modifier.fillMaxSize(),
                    enter = if (fade) fadeIn(tween(motion.enterMs, easing = PkwTokens.Motion.Out)) else EnterTransition.None,
                    exit = if (fade) fadeOut(tween(motion.exitMs, easing = PkwTokens.Motion.In)) else ExitTransition.None,
                    label = "Home sheet",
                ) {
                    val enter = when {
                        !motion.slide -> EnterTransition.None
                        layout.placement == SheetHostPlacement.END -> slideInHorizontally(
                            tween(motion.enterMs, easing = PkwTokens.Motion.Out),
                        ) { if (direction == LayoutDirection.Rtl) -it else it }
                        else -> slideInVertically(tween(motion.enterMs, easing = PkwTokens.Motion.Out)) { it }
                    }
                    val exit = when {
                        !motion.slide -> ExitTransition.None
                        layout.placement == SheetHostPlacement.END -> slideOutHorizontally(
                            tween(motion.exitMs, easing = PkwTokens.Motion.In),
                        ) { if (direction == LayoutDirection.Rtl) -it else it }
                        else -> slideOutVertically(tween(motion.exitMs, easing = PkwTokens.Motion.In)) { it }
                    }
                    if (layout.placement == SheetHostPlacement.FULL_SCREEN) {
                        // One card: the opaque backdrop (camera cut-out strip and shelf) and the panel move together.
                        Box(Modifier.fillMaxSize().animateEnterExit(enter = enter, exit = exit, label = "Sheet card")) {
                            FullScreenSheetBackdrop()
                            Box(Modifier.fillMaxSize().padding(start = safeStart, top = safeTop + layout.topInsetDp.dp, end = safeEnd,
                                bottom = safeBottom + layout.bottomInsetDp.dp)) {
                                val panel = Modifier.align(Alignment.TopCenter).width(layout.widthDp.dp).fillMaxHeight()
                                    .sceneInputRegion()
                                    .blockSheetExitInput(!state.visibility.targetState)
                                key(content.entry.destination) { render(content.entry, content.frame, close, panel) }
                            }
                        }
                    } else Box(Modifier.fillMaxSize()) {
                        if (layout.scrimAlpha > 0f) ModalScrim(layout.scrimAlpha, onTap = close)
                        Box(Modifier.fillMaxSize().padding(safe).padding(top = layout.topInsetDp.dp, bottom = layout.bottomInsetDp.dp)) {
                            val placement = when (layout.placement) {
                                SheetHostPlacement.BOTTOM -> Alignment.BottomCenter
                                SheetHostPlacement.END -> Alignment.CenterEnd
                                SheetHostPlacement.CENTER, SheetHostPlacement.FULL_SCREEN -> Alignment.Center
                            }
                            val panel = Modifier.align(placement).width(layout.widthDp.dp).heightIn(max = layout.maxHeightDp.dp)
                                .animateEnterExit(enter = enter, exit = exit, label = "Sheet panel")
                                .sceneInputRegion()
                                .blockSheetExitInput(!state.visibility.targetState)
                            // Preserve a sheet's local composition on tab/scroll updates, but do not
                            // carry another destination's remembered body state into its replacement.
                            key(content.entry.destination) { render(content.entry, content.frame, close, panel) }
                        }
                    }
                }
            }
        }
    }
}

/** The exiting painted frame remains an input shield, but none of its old controls may act. */
private fun Modifier.blockSheetExitInput(blocked: Boolean): Modifier = if (!blocked) this else
    clearAndSetSemantics { }.pointerInput(Unit) {
        awaitPointerEventScope {
            while (true) awaitPointerEvent(PointerEventPass.Initial).changes.forEach { it.consume() }
        }
    }
