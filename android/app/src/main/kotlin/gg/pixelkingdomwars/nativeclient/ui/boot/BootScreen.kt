package gg.pixelkingdomwars.nativeclient.ui.boot

import gg.pixelkingdomwars.nativeclient.ui.chrome.LoadingBackdrop
import gg.pixelkingdomwars.nativeclient.ui.Palette
import androidx.compose.foundation.background
import androidx.compose.ui.graphics.Brush
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.delay

import androidx.compose.foundation.layout.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewModelScope
import gg.pixelkingdomwars.nativeclient.AppGraph
import gg.pixelkingdomwars.nativeclient.data.AccountPhase
import gg.pixelkingdomwars.nativeclient.data.LaunchMode
import gg.pixelkingdomwars.nativeclient.ui.ScreenViewModel
import gg.pixelkingdomwars.nativeclient.update.BootUpdate
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import gg.pixelkingdomwars.nativeclient.BuildConfig

/** Where the shell sends a launch once content and account restoration have both concluded.
 * Interactive sign-in stays on Title: its ViewModel owns wallet/provider approval and inline busy UI.
 * [bootScreen] destinations are drawn by the boot route; reaching any other one ends the launch's update gate. */
enum class BootDestination(val bootScreen: Boolean) {
    LOADING(true), PREVIEW(false), TITLE(false), TOTP(false), ALPHA(false), HOME(false), CONTENT_FAILED(true),
    /** Owner 2026-09-27: a required update found at launch; no way into the game until it installs. */
    UPDATE_REQUIRED(true),
    /** An optional update found at launch: the boot strip until the player picks UPDATE NOW or LATER. */
    UPDATE_AVAILABLE(true),
}

/** [update] is the launch's update gate ([gg.pixelkingdomwars.nativeclient.update.bootUpdateDecision]); it outranks
 * every other route, and a content failure is only shown once the gate knows there is no update to offer instead. */
fun bootDestination(mode: LaunchMode, contentReady: Boolean, contentError: String?, phase: AccountPhase, accountBusy: Boolean,
                    update: BootUpdate = BootUpdate.NONE): BootDestination = when {
    update == BootUpdate.REQUIRED -> BootDestination.UPDATE_REQUIRED
    update == BootUpdate.CHECKING -> BootDestination.LOADING
    update == BootUpdate.OPTIONAL -> BootDestination.UPDATE_AVAILABLE
    contentError != null && !contentReady -> BootDestination.CONTENT_FAILED
    !contentReady -> BootDestination.LOADING
    mode.offline -> BootDestination.PREVIEW
    phase == AccountPhase.RESTORING -> BootDestination.LOADING
    phase == AccountPhase.TOTP -> BootDestination.TOTP
    phase == AccountPhase.ALPHA -> BootDestination.ALPHA
    phase == AccountPhase.SIGNED_IN -> BootDestination.HOME
    else -> BootDestination.TITLE
}

/** One launch, in order (owner 2026-09-27: the update is found on the loading screen, before the game opens): the
 * session-less update check starts first, on the app scope, so no content failure can skip or cancel it; content
 * preparation and session restoration then run beside it. Returns once both have concluded (a content failure rethrows);
 * the route waits for the check through the boot decision, bounded by its own budget. */
internal suspend fun launchBoot(offline: Boolean, checkForUpdate: () -> Unit, restore: suspend () -> Unit, initialize: suspend () -> Unit) {
    if (!offline) checkForUpdate()
    coroutineScope {
        val restoration = if (offline) null else async { runCatching { restore() } }
        initialize()
        restoration?.await()
    }
}

/** Content preparation and session restoration are independent I/O and run concurrently; a
 * content failure fails the launch, an account failure surfaces once content has concluded. One BootViewModel per
 * Activity launch: it begins the update gate's launch before anything else, so a relaunch into a cached process meets the
 * gate again (retries call [start] only). */
class BootViewModel(private val graph: AppGraph) : ScreenViewModel() {
    // PKWLoad BOOT_* lines time each launch from here (the first launch of a process from process start).
    init { gg.pixelkingdomwars.nativeclient.diagnostics.BootTimeline.beginLaunch() }
    init { graph.bootUpdates.beginLaunch(); start() }
    fun start() {
        run {
            launchBoot(graph.mode.offline, { graph.bootUpdates.start() }, { graph.account.restore() }, { graph.content.initialize() })
            if (!graph.mode.offline) viewModelScope.launch { graph.content.checkUpdates(graph.account.state.value.session?.let { graph.sessionGraph.value?.api } ?: return@launch, force = false) }
        }
    }
}

/** Non-numeric sentences copied verbatim from web loadingTipData.ts. The APK artwork is decorative;
 * no guessed downloaded percentage, game cost or stat is needed before content initialization finishes. */
internal val BOOT_TIPS = listOf(
    BootTip("TROOPS", "Let tougher troops open the path in front of them.", "ui_portrait_bowman_t1"),
    BootTip("HEROES", "Use the sapper to hold the dangerous lane.", "hero_theo_idle_f1"),
    BootTip("RAID", "Find the Mortar dead zone before deploying.", "ui_portrait_mortar_t1"),
)

/** The rotating tip, remembered by the boot route so it continues across the loading, failed and update destinations
 * (D-193: nothing on the strip changes at a hand-off but the state's own words). Source LoadingTips rotates every
 * 6 seconds; the native lifecycle pauses hidden-screen work. */
@Composable fun rememberBootTip(): BootTip {
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var tipIndex by remember { mutableIntStateOf(0) }
    LaunchedEffect(lifecycle) { lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
        while (true) { delay(6_000); tipIndex = (tipIndex + 1) % BOOT_TIPS.size }
    } }
    return BOOT_TIPS[tipIndex]
}

/** The dark plate under the strip and the version label: the title's `WallpaperPlate`, one plate for the wallpaper. */
internal val BootPlate = Palette.backdrop.copy(alpha = .8f)

/** SHARDKEEP D-192: the one product version, in the one label format both clients print. */
internal const val VERSION_LABEL_PREFIX = "PIXEL KINGDOM WARS v"

/** What one boot destination puts on the strip: the words and the meter, and its buttons (null while it has none). */
class BootStrip(val content: LoadingStripContent, val actions: (@Composable () -> Unit)? = null)

/** The boot screen (SHARDKEEP D-193): the bright wallpaper with one slim strip at the bottom and the version label at
 * the bottom-left, nothing else. The boot route calls it ONCE and only [strip] changes with the destination, so the
 * wallpaper, the plan, the sweep and the tip survive a hand-off (LOADING → UPDATE_AVAILABLE on every launch that finds
 * an offer; review 2026-09-28: a BootScreen per destination re-decoded the wallpaper and blinked the gradient between
 * them). The strip sits in the same box for every destination, is simply there on the first frame (no fade, no scroll
 * column, no centring) and never moves. Reduced motion stops the sweep and the tip crossfade. */
@Composable fun BootScreen(strip: BootStrip, tip: BootTip) {
    BoxWithConstraints(Modifier.fillMaxSize().background(Brush.verticalGradient(listOf(Palette.surface, Palette.backdrop)))) {
        // Owner 2026-09-25: the bright cinematic loading wallpaper replaces the dimmed title painting; its background
        // decode never holds the first frame.
        LoadingBackdrop(maxWidth <= maxHeight, Modifier.fillMaxSize(), brightness = .9f)
        // Owner 2026-10-06: a slight vignette behind the strip so it never fights the art, and the strip above the gesture area.
        StripVignette()
        val versionLabel = VERSION_LABEL_PREFIX + BuildConfig.VERSION_NAME
        val plan = LoadingStripPlan.of(maxWidth.value, maxHeight.value, stripInsets(), versionLabel, LocalDensity.current.fontScale)
        LoadingStrip(plan, strip.content, tip, strip.actions)
        BootVersionLabel(plan, versionLabel, BuildConfig.VERSION_NAME)
    }
}

/** The loading and content-failed destinations: TRY AGAIN (disabled and "TRYING AGAIN…" while a retry runs) is the
 * only button. */
fun bootLoadingStrip(error: String?, retrying: Boolean, onRetry: () -> Unit): BootStrip =
    BootStrip(bootStripContent(error, retrying), actions = if (error == null) null else {
        { StripButton(if (retrying) "TRYING AGAIN…" else "TRY AGAIN", onRetry, enabled = !retrying) }
    })
