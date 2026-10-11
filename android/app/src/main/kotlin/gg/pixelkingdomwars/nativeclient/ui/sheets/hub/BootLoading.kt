package gg.pixelkingdomwars.nativeclient.ui.sheets.hub

import androidx.compose.animation.Crossfade
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.LocalReducedMotion
import gg.pixelkingdomwars.nativeclient.ui.chrome.LoadingBackdrop
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.ProgressBar
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import kotlinx.coroutines.delay

/**
 * Design component: the boot loading screen (design/final/hub/loading.png, SPEC §3.4 "Boot"): the only surface without
 * the world, because the world is not built yet. The approved loading wallpaper fills the screen, the approved logo sits
 * at the top on its 4 × 4 block grid, and a charcoal loading card shows the step, the percent, a gold meter and a
 * rotating tip; the version sits at the bottom. (The in-card loading of every hub card is the Skeleton in HubParts.)
 */

/** Everything the boot loading screen draws. */
@Immutable data class BootLoadingUi(
    /** VT 20 step ("Waking the builders…"). */
    val step: String,
    /** PS 12 gold-hi percent ("62%"); null hides it (never a fake 0 %). */
    val percent: String?,
    /** 0..1 for the gold meter; null draws an empty track. */
    val progress: Float?,
    /** Tips, rotating every 4 s with a 120 ms cross-fade. */
    val tips: List<String>,
    /** "0.6.5 (31)". */
    val version: String,
    /** The world's first frame is ready: the card fades 160 ms, then the wallpaper 300 ms, then [BootLoading]'s onFinished. */
    val ready: Boolean = false,
)

/**
 * The boot loading screen. When [BootLoadingUi.ready] turns true it fades out (card 160 ms, wallpaper 300 ms) and calls
 * [onFinished]; the GL surface stays alive from then on (NR lane).
 *
 * Pointer rule: no pointer handling anywhere; it sits before the world exists, so nothing below it can take a touch.
 */
@Composable fun BootLoading(ui: BootLoadingUi, onFinished: () -> Unit, modifier: Modifier = Modifier) {
    val reduced = LocalReducedMotion.current
    val inspection = LocalInspectionMode.current
    val finished by rememberUpdatedState(onFinished)
    val cardAlpha = remember { Animatable(1f) }
    val screenAlpha = remember { Animatable(1f) }
    LaunchedEffect(ui.ready) {
        if (!ui.ready) return@LaunchedEffect
        cardAlpha.animateTo(0f, tween(if (reduced) PkwTokens.Motion.REDUCED_CROSSFADE else PkwTokens.Motion.PLATE_IN, easing = PkwTokens.Motion.In))
        screenAlpha.animateTo(0f, tween(if (reduced) PkwTokens.Motion.REDUCED_CROSSFADE else HubMotion.WALLPAPER_CROSSFADE, easing = PkwTokens.Motion.In))
        finished()
    }
    val elapsed by produceState(0L, ui.tips.size, inspection) {
        if (inspection || ui.tips.size < 2) return@produceState
        val start = System.currentTimeMillis()
        while (true) { delay(HubMotion.TIP_ROTATE.toLong()); value = System.currentTimeMillis() - start }
    }
    val tip = ui.tips.getOrNull(tipIndex(elapsed, ui.tips.size))
    Box(modifier.fillMaxSize().graphicsLayer { alpha = screenAlpha.value }) {
        LoadingBackdrop(portrait = true, modifier = Modifier.fillMaxSize(), brightness = 1f)
        HubArt("logo", 316.dp, Modifier.align(Alignment.TopCenter).padding(top = 56.dp), height = 220.dp, contentDescription = "Pixel Kingdom Wars")
        Plate(PlateKind.CHARCOAL, Modifier.align(Alignment.BottomCenter).padding(start = 16.dp, end = 16.dp, bottom = 57.dp).fillMaxWidth()
            .heightIn(min = 116.dp).graphicsLayer { alpha = cardAlpha.value }) {
            Column(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Row(Modifier.fillMaxWidth().clearAndSetSemantics {
                    contentDescription = listOfNotNull(ui.step, ui.percent).joinToString(", "); liveRegion = LiveRegionMode.Polite
                }, verticalAlignment = Alignment.CenterVertically) {
                    PkwText(ui.step, PkwTokens.Type.body, Modifier.weight(1f), color = PkwTokens.Colors.text)
                    ui.percent?.let { PkwText(it, PkwTokens.Type.label, color = PkwTokens.Colors.gold.hi, outline = 1.dp) }
                }
                ProgressBar(ui.progress, listOfNotNull(ui.step, ui.percent).joinToString(", "), verb = Verb.GOLD, height = 16.dp)
                if (tip != null) Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    PkwIcon("info", 24.dp)
                    Crossfade(tip, Modifier.weight(1f), tween(PkwTokens.Motion.REDUCED_CROSSFADE), label = "tip") { shown ->
                        PkwText(shown, PkwTokens.Type.small, color = PkwTokens.Colors.text, maxLines = 2)
                    }
                }
            }
        }
        PkwText(ui.version, PkwTokens.Type.small, Modifier.align(Alignment.BottomCenter).padding(bottom = 22.dp), color = PkwTokens.Colors.label, outline = 1.dp)
    }
}

@Preview(name = "Boot loading (loading.png)", widthDp = 412, heightDp = 915)
@Composable private fun BootLoadingPreview() {
    BootLoading(BootLoadingUi("Waking the builders…", "62%", 0.62f, listOf("Tap a building twice to open it.", "GO on a quest flies you there."), "0.6.5 (31)"), onFinished = {})
}

@Preview(name = "Boot loading: progress unknown", widthDp = 412, heightDp = 915)
@Composable private fun BootLoadingUnknownPreview() {
    BootLoading(BootLoadingUi("Reaching the realm…", null, null, emptyList(), "0.6.5 (31)"), onFinished = {})
}
