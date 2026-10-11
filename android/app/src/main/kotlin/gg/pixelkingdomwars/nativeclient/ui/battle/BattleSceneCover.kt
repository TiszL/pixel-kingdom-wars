package gg.pixelkingdomwars.nativeclient.ui.battle

import android.os.SystemClock
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.GameContentCache
import gg.pixelkingdomwars.nativeclient.diagnostics.FrameWindows
import gg.pixelkingdomwars.nativeclient.diagnostics.LoadEvent
import gg.pixelkingdomwars.nativeclient.diagnostics.SceneLoadLog
import gg.pixelkingdomwars.nativeclient.renderer.RealmVisual
import gg.pixelkingdomwars.nativeclient.renderer.realmGroundColor
import gg.pixelkingdomwars.nativeclient.scene.Postcard
import gg.pixelkingdomwars.nativeclient.ui.LocalReducedMotion
import gg.pixelkingdomwars.nativeclient.ui.chrome.blockSceneInput
import gg.pixelkingdomwars.nativeclient.ui.kingdom.IndicatorStage
import gg.pixelkingdomwars.nativeclient.ui.kingdom.InSceneLine
import gg.pixelkingdomwars.nativeclient.ui.kingdom.RealmVeil
import gg.pixelkingdomwars.nativeclient.ui.kingdom.SWAP_VSYNCS
import gg.pixelkingdomwars.nativeclient.ui.kingdom.rememberIndicatorStage
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

/**
 * Owner 2026-10-06 ("black screen is low quality … professional solution"; the design default for battles is the 220 ms
 * fade through the scene colour). Scene-transitions spec §2 BATTLE_FADE / §3 "Battle entry/exit": the dark kit plate
 * (BattleLoadingOverlay, #100E14) and the "Entering battle…" shell are gone from the battle, watch, scout and replay
 * openings. While the field is not drawn yet the player sees their own base dimmed to 60 % (its postcard) or the loading
 * wallpaper with the strip, plus the same honest indicator as Home (nothing before 400 ms, the line, the cause at 2 s, TRY
 * AGAIN at 8 s or on failure) and the existing way out. When the field has drawn its first frame the cover waits 2 vsyncs,
 * washes to the target realm's ground colour in 110 ms and lifts in 110 ms (reduced motion: one 120 ms cross-fade).
 */
internal const val BATTLE_FADE_HALF_MS = 110
internal const val BATTLE_DIM = .4f // the picture at 60 %
internal const val BATTLE_DIM_MS = 160

/** (wash-in, lift) durations: the 220 ms fade through the ground colour, or a 120 ms cross-fade under reduced motion. */
internal fun battleFadeMs(reducedMotion: Boolean): Pair<Int, Int> = if (reducedMotion) 0 to 120 else BATTLE_FADE_HALF_MS to BATTLE_FADE_HALF_MS

/** How a battle cover ends: through the ground colour when the field was presented; at once when the opening ended some
 *  other way (a create failure panel, an expired march, a result) so no colour flashes over that panel. */
internal fun battleCoverFades(fieldPresented: Boolean): Boolean = fieldPresented

/** The target realm's ground colour, read off Main from the cached render catalogue; null until known. */
@Composable internal fun rememberRealmGround(assets: File?, visual: RealmVisual?): Color? {
    val argb by produceState<Int?>(null, assets, visual) {
        value = if (assets == null || visual == null) null
            else withContext(Dispatchers.Default) { runCatching { realmGroundColor(GameContentCache.rendererCatalogue(assets), visual) }.getOrNull() }
    }
    return argb?.let { Color(0xFF000000.toInt() or it) }
}

@Composable internal fun BattleSceneCover(live: Boolean, fieldPresented: Boolean, ground: Color?, postcard: Postcard<ImageBitmap>?,
    cause: String, failed: Boolean, onRetry: (() -> Unit)?, route: String, topBar: (@Composable () -> Unit)?) {
    val reduced = LocalReducedMotion.current
    val activity = androidx.activity.compose.LocalActivity.current
    val cover = remember { Animatable(if (live) 0f else 1f) }
    val wash = remember { Animatable(0f) }
    val dim = remember { Animatable(0f) }
    var gone by remember { mutableStateOf(live) }
    val startedAt = remember { SystemClock.elapsedRealtime() }
    val firstPixels = remember { if (postcard != null) "postcard" else "veil" }
    val fades by rememberUpdatedState(battleCoverFades(fieldPresented))
    val groundNow by rememberUpdatedState(ground)
    LaunchedEffect(postcard != null) {
        if (postcard == null) dim.snapTo(0f)
        else if (reduced) dim.snapTo(BATTLE_DIM) else dim.animateTo(BATTLE_DIM, tween(BATTLE_DIM_MS, easing = PkwTokens.Motion.In))
    }
    LaunchedEffect(live) {
        if (!live) { cover.snapTo(1f); wash.snapTo(0f); gone = false; return@LaunchedEffect }
        if (gone) return@LaunchedEffect
        if (!fades) { gone = true; return@LaunchedEffect }
        val liveAt = SystemClock.elapsedRealtime()
        repeat(SWAP_VSYNCS) { withFrameNanos { } }
        val (washIn, lift) = battleFadeMs(reduced)
        if (washIn > 0 && groundNow != null) wash.animateTo(1f, tween(washIn, easing = PkwTokens.Motion.In))
        cover.animateTo(0f, tween(lift, easing = PkwTokens.Motion.Out))
        gone = true
        SceneLoadLog.mark(LoadEvent.SUMMARY, "route=$route first_pixels=$firstPixels live=${liveAt - startedAt} swap=${SystemClock.elapsedRealtime() - liveAt}")
        FrameWindows.record(activity?.window, "$route-swap")
    }
    if (gone) return
    LaunchedEffect(Unit) { SceneLoadLog.mark(LoadEvent.VEIL_SHOWN, "route=$route kind=$firstPixels") }
    Box(Modifier.fillMaxSize().graphicsLayer { alpha = cover.value }.blockSceneInput()) {
        if (postcard != null) {
            Image(postcard.image, contentDescription = cause, modifier = Modifier.fillMaxSize(),
                contentScale = ContentScale.FillBounds, filterQuality = FilterQuality.None)
            Box(Modifier.fillMaxSize().graphicsLayer { alpha = dim.value }.background(Color.Black))
        } else RealmVeil(failed, onRetry, title = cause, failedTitle = cause)
        ground?.let { colour -> Box(Modifier.fillMaxSize().graphicsLayer { alpha = wash.value }.background(colour)) }
        Column(Modifier.align(Alignment.TopStart).fillMaxWidth().windowInsetsPadding(WindowInsets.safeDrawing).padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)) {
            topBar?.invoke()
            if (postcard != null) {
                val stage = rememberIndicatorStage(route, waiting = !live, failed = failed)
                if (stage != IndicatorStage.HIDDEN) InSceneLine(stage, cause, onRetry, Modifier.align(Alignment.CenterHorizontally))
            }
        }
    }
}
