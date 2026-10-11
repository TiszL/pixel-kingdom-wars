package gg.pixelkingdomwars.nativeclient.ui.kingdom

import android.os.SystemClock
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.diagnostics.LoadEvent
import gg.pixelkingdomwars.nativeclient.diagnostics.SceneLoadLog
import gg.pixelkingdomwars.nativeclient.scene.Postcard
import gg.pixelkingdomwars.nativeclient.ui.LocalReducedMotion
import gg.pixelkingdomwars.nativeclient.ui.Palette
import gg.pixelkingdomwars.nativeclient.ui.boot.LoadingStrip
import gg.pixelkingdomwars.nativeclient.ui.boot.LoadingStripContent
import gg.pixelkingdomwars.nativeclient.ui.boot.LoadingStripPlan
import gg.pixelkingdomwars.nativeclient.ui.boot.StripButton
import gg.pixelkingdomwars.nativeclient.ui.boot.StripMeter
import gg.pixelkingdomwars.nativeclient.ui.boot.rememberBootTip
import gg.pixelkingdomwars.nativeclient.ui.chrome.LoadingBackdrop
import gg.pixelkingdomwars.nativeclient.ui.chrome.TextButton
import gg.pixelkingdomwars.nativeclient.ui.chrome.blockSceneInput
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Owner 2026-10-06: "black screen is low quality indication … loading indicator is like not well implemented …
 * professional solution". Spec scene-transitions §1–§3: a Home scene area always shows the best picture available — the
 * live scene, else this base's POSTCARD (its last drawn frame), else the realm loading WALLPAPER with the D-193 strip —
 * never #100E14, never a centred plate. Indicators are honest and late: nothing before 400 ms, then a slim stepped line,
 * the cause from 2 s, TRY AGAIN from 8 s or on failure, and once shown at least 300 ms.
 */
internal enum class ScenePicture { LIVE, POSTCARD, REALM_VEIL }

/** The picture rule (spec §1.1). There is no black and no plate state: a failure keeps whichever picture exists. */
internal fun scenePicture(live: Boolean, postcard: Boolean): ScenePicture = when {
    live -> ScenePicture.LIVE
    postcard -> ScenePicture.POSTCARD
    else -> ScenePicture.REALM_VEIL
}

/** The HUD stands over the live scene or a postcard only, never over the wallpaper cover (spec §1.5). */
internal fun homeHudShown(picture: ScenePicture): Boolean = picture != ScenePicture.REALM_VEIL

internal enum class IndicatorStage { HIDDEN, LINE, CAUSE, RETRY }

/** Spec §2 IndicatorClock. [elapsedMs] runs from the start of one wait. */
internal class IndicatorClock {
    private var shownAtMs: Long? = null
    private var last = IndicatorStage.HIDDEN
    fun stage(elapsedMs: Long, waiting: Boolean, failed: Boolean): IndicatorStage {
        val wanted = when {
            failed -> IndicatorStage.RETRY
            !waiting || elapsedMs < SHOW_AFTER_MS -> IndicatorStage.HIDDEN
            elapsedMs < CAUSE_AFTER_MS -> IndicatorStage.LINE
            elapsedMs < RETRY_AFTER_MS -> IndicatorStage.CAUSE
            else -> IndicatorStage.RETRY
        }
        val shownAt = shownAtMs
        // Once shown, never for less than MIN_SHOWN_MS: an indicator that blinks is worse than none.
        val next = if (wanted == IndicatorStage.HIDDEN && shownAt != null && elapsedMs - shownAt < MIN_SHOWN_MS) last else wanted
        if (next == IndicatorStage.HIDDEN) shownAtMs = null else if (shownAt == null) shownAtMs = elapsedMs
        last = next
        return next
    }
    companion object {
        const val SHOW_AFTER_MS = 400L
        const val CAUSE_AFTER_MS = 2_000L
        const val RETRY_AFTER_MS = 8_000L
        const val MIN_SHOWN_MS = 300L
    }
}

/** Swap timing (spec §2): the cover starts to leave 2 vsyncs after the first real GL frame and is gone in 180 ms on
 *  the kit `out` curve; reduced motion is a 120 ms cross-fade. */
internal const val SWAP_VSYNCS = 2
internal fun swapMs(reducedMotion: Boolean): Int = if (reducedMotion) 120 else 180

@Composable internal fun rememberIndicatorStage(key: Any?, waiting: Boolean, failed: Boolean): IndicatorStage {
    val clock = remember(key) { IndicatorClock() }
    val started = remember(key) { SystemClock.elapsedRealtime() }
    var stage by remember(key) { mutableStateOf(IndicatorStage.HIDDEN) }
    LaunchedEffect(key, waiting, failed) {
        while (true) {
            val next = clock.stage(SystemClock.elapsedRealtime() - started, waiting, failed)
            stage = next
            // A failure is RETRY until it clears (a new effect); a finished wait stops once its hold ends.
            if (failed || (!waiting && next == IndicatorStage.HIDDEN)) break
            kotlinx.coroutines.delay(50)
        }
    }
    return stage
}

private val firstHomeOfProcess = AtomicBoolean(true)

/**
 * The one cover over a Home scene that is not live (spec §2, §4 step 6): a postcard (pixels only, input blocked) with the
 * in-scene line under the HUD, or the realm wallpaper with the strip. When [live] turns true the cover waits 2 vsyncs and
 * fades out; the swap alpha is read in `graphicsLayer {}` (never Compose alpha on the SurfaceView itself).
 */
@Composable internal fun ScenePresentationLayer(live: Boolean, postcard: Postcard<ImageBitmap>?, failed: Boolean, onRetry: (() -> Unit)?,
    lineTop: Dp, modifier: Modifier = Modifier, realmId: String? = null) {
    val reduced = LocalReducedMotion.current
    val activity = androidx.activity.compose.LocalActivity.current
    val cover = remember { Animatable(if (live) 0f else 1f) }
    var gone by remember { mutableStateOf(live) }
    // PKWLoad SUMMARY (spec §4 step 1): one line per opening, from mount (or process start for the first Home) to the end of
    // the swap; a later wait on the same Home (a base switch) starts its own timeline.
    var timeline by remember {
        val cold = firstHomeOfProcess.getAndSet(false)
        mutableStateOf(HomeTimeline(cold, if (cold) android.os.Process.getStartElapsedRealtime() else SystemClock.elapsedRealtime(),
            if (postcard != null) "postcard" else "veil"))
    }
    LaunchedEffect(live) {
        if (!live) {
            if (gone) timeline = HomeTimeline(false, SystemClock.elapsedRealtime(), if (postcard != null) "postcard" else "veil")
            cover.snapTo(1f); gone = false; return@LaunchedEffect
        }
        if (gone) return@LaunchedEffect
        val liveAt = SystemClock.elapsedRealtime()
        repeat(SWAP_VSYNCS) { withFrameNanos { } }
        cover.animateTo(0f, tween(swapMs(reduced), easing = PkwTokens.Motion.Out))
        gone = true
        timeline.summary(liveAt, SystemClock.elapsedRealtime())
        gg.pixelkingdomwars.nativeclient.diagnostics.FrameWindows.record(activity?.window, "home-swap")
    }
    // Field report 2026-10-06: a disk restore still running when this cover first composes gets RESTORE_WAIT_MS before the
    // cover settles on the wallpaper (it would otherwise flash the wallpaper and then the postcard). The hold draws the plain
    // wallpaper boot drew a moment ago — no strip, no indicator.
    var holding by remember { mutableStateOf(postcard == null && gg.pixelkingdomwars.nativeclient.scene.ScenePostcards.restoring) }
    val latestPostcard by rememberUpdatedState(postcard)
    LaunchedEffect(Unit) {
        if (!holding) return@LaunchedEffect
        kotlinx.coroutines.withTimeoutOrNull(gg.pixelkingdomwars.nativeclient.scene.RESTORE_WAIT_MS) {
            while (gg.pixelkingdomwars.nativeclient.scene.ScenePostcards.restoring) kotlinx.coroutines.delay(5)
        }
        holding = false
        timeline = HomeTimeline(timeline.cold, timeline.startMs, if (latestPostcard != null) "postcard" else "veil")
    }
    if (gone) return
    val picture = scenePicture(false, postcard != null)
    LaunchedEffect(picture, holding) { if (!holding) SceneLoadLog.mark(LoadEvent.VEIL_SHOWN, "kind=${if (picture == ScenePicture.POSTCARD) "postcard" else "veil"}") }
    // ModulateAlpha: the swap fade multiplies each draw instead of compositing a full-screen offscreen layer every frame
    // (field report: 6 of 6 frames over 16 ms after the swap).
    Box(modifier.fillMaxSize().graphicsLayer { alpha = cover.value; compositingStrategy = CompositingStrategy.ModulateAlpha }) {
        if (postcard == null && holding) BoxWithConstraints(Modifier.fillMaxSize().background(Palette.surface).blockSceneInput()) {
            LoadingBackdrop(maxWidth <= maxHeight, Modifier.fillMaxSize(), brightness = .9f)
        } else if (postcard != null) {
            Image(postcard.image, contentDescription = "Opening your kingdom", modifier = Modifier.fillMaxSize().blockSceneInput(),
                contentScale = ContentScale.FillBounds, filterQuality = FilterQuality.None)
            val stage = rememberIndicatorStage(postcard.key, waiting = !live, failed = failed)
            if (stage != IndicatorStage.HIDDEN) InSceneLine(stage, "Opening your kingdom", onRetry,
                Modifier.align(Alignment.TopCenter).padding(top = lineTop))
        } else RealmVeil(failed, onRetry, realmId = realmId)
    }
}

/** A postcard drawn BENEATH a scene's GL surface. A SurfaceView punches through what is drawn below it once it has drawn,
 *  so this is invisible while the scene is up; in a frame where the surface is already gone (a route or tab leaving) but the
 *  scene's own layers are still drawn, the picture shows instead of the window's black. Pixels only, no input. */
@Composable internal fun PostcardBacking(postcard: Postcard<ImageBitmap>?) {
    if (postcard != null) Image(postcard.image, contentDescription = null, modifier = Modifier.fillMaxSize(),
        contentScale = ContentScale.FillBounds, filterQuality = FilterQuality.None)
}

private class HomeTimeline(val cold: Boolean, val startMs: Long, val firstPixels: String) {
    fun summary(liveAt: Long, goneAt: Long) = SceneLoadLog.mark(LoadEvent.SUMMARY,
        "route=home cause=${if (cold) "cold" else "warm"} first_pixels=$firstPixels live=${liveAt - startMs} " +
            "snapshot=${if (firstPixels == "postcard") "hit" else "miss"} swap=${goneAt - liveAt}")
}

/** Spec §2 in-scene line: a 3 dp row of 8 hard-edged gold blocks under the top HUD stepping at 12 fps; the cause line from
 *  2 s; an inline TRY AGAIN from 8 s or on failure. Reduced motion: static, half-lit. Frames are read in the draw phase. */
@Composable internal fun InSceneLine(stage: IndicatorStage, cause: String, onRetry: (() -> Unit)?, modifier: Modifier = Modifier) {
    val reduced = LocalReducedMotion.current
    // The same comet as the strip's meter (owner 2026-10-06): a 3-block head and a 60 % / 30 % tail, one way, stepping
    // at 12 fps (one block position per LINE_STEP_MS); reduced motion: every block half-lit, still.
    val phase = if (reduced) null else rememberInfiniteTransition(label = "scene-line")
        .animateFloat(0f, 1f, infiniteRepeatable(tween(LINE_POSITIONS * LINE_STEP_MS, easing = LinearEasing), RepeatMode.Restart), label = "scene-line")
    Column(modifier.blockSceneInput().semantics { liveRegion = LiveRegionMode.Polite; contentDescription = cause },
        horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Canvas(Modifier.width(LINE_WIDTH).height(LINE_HEIGHT).clipToBounds()) {
            val gap = 2.dp.toPx()
            val alphas = gg.pixelkingdomwars.nativeclient.ui.boot.meterBlockAlphas(gg.pixelkingdomwars.nativeclient.ui.boot.StripMeter.Sweep, phase?.value)
            for (i in 0 until LINE_BLOCKS) {
                val r = gg.pixelkingdomwars.nativeclient.ui.boot.meterBlockRect(i, size.width, size.height, 0f, gap)
                drawRect(PkwTokens.Colors.track, Offset(r[0], r[1]), Size(r[2] - r[0], r[3] - r[1]))
                if (alphas[i] > 0f) drawRect(PkwTokens.Colors.gold.face.copy(alpha = alphas[i]), Offset(r[0], r[1]), Size(r[2] - r[0], r[3] - r[1]))
            }
        }
        if (stage == IndicatorStage.CAUSE || stage == IndicatorStage.RETRY)
            Text(cause, color = Palette.text, style = MaterialTheme.typography.labelSmall,
                modifier = Modifier.background(PkwTokens.Colors.veil).padding(horizontal = 8.dp, vertical = 2.dp))
        if (stage == IndicatorStage.RETRY && onRetry != null) TextButton(onClick = onRetry) { Text("TRY AGAIN") }
    }
}
internal const val LINE_BLOCKS = 8
/** Comet positions per cycle: the 8 blocks plus its 5 cells, so it enters whole and leaves whole. */
internal const val LINE_POSITIONS = LINE_BLOCKS + 5
internal const val LINE_STEP_MS = 83 // 12 fps
private val LINE_WIDTH = 96.dp
private val LINE_HEIGHT = 3.dp

/** Spec §3 "scene entry, no picture": the owner-approved loading wallpaper and the D-193 strip — the same surface as boot,
 *  not a dark card. A failure stays on it with the reason and TRY AGAIN. */
@Composable internal fun RealmVeil(failed: Boolean, onRetry: (() -> Unit)?, modifier: Modifier = Modifier,
    title: String = "Opening your kingdom…", failedTitle: String = "Couldn't open your kingdom", realmId: String? = null) {
    BoxWithConstraints(modifier.fillMaxSize().background(Palette.surface).blockSceneInput()) {
        LoadingBackdrop(maxWidth <= maxHeight, Modifier.fillMaxSize(), brightness = .9f)
        // A slight vignette behind the strip so it never fights the art (owner 2026-10-06).
        gg.pixelkingdomwars.nativeclient.ui.boot.StripVignette()
        val content = if (failed) LoadingStripContent(failedTitle, StripMeter.Still, "Please try again in a moment.", reason = true)
            else LoadingStripContent(title, StripMeter.Sweep)
        // The title wears the realm's light when the kingdom's realm is known (HudRealms), else the kit's gold.
        androidx.compose.runtime.CompositionLocalProvider(gg.pixelkingdomwars.nativeclient.ui.boot.LocalStripAccent provides
            if (realmId != null) gg.pixelkingdomwars.nativeclient.ui.world.HudRealms.accent(realmId) else PkwTokens.Colors.gold.hi) {
            SceneStrip(content, actions = if (failed && onRetry != null) { { StripButton("TRY AGAIN", onRetry) } } else null)
        }
    }
}

/** The D-193 strip alone, placed exactly as on boot (bottom, above the safe area), for a cover that draws its own picture
 *  or colour behind it (the realm wallpaper, the world's sky). Never a centred plate. */
@Composable internal fun SceneStrip(content: LoadingStripContent, actions: (@Composable () -> Unit)?, modifier: Modifier = Modifier) {
    BoxWithConstraints(modifier.fillMaxSize()) {
        val plan = LoadingStripPlan.of(maxWidth.value, maxHeight.value, gg.pixelkingdomwars.nativeclient.ui.boot.stripInsets(),
            "", LocalDensity.current.fontScale)
        LoadingStrip(plan, content, rememberBootTip(), actions)
    }
}
