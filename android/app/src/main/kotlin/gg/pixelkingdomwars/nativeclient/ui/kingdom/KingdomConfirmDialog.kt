package gg.pixelkingdomwars.nativeclient.ui.kingdom

import android.os.Build
import android.view.WindowManager
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.DialogWindowProvider
import gg.pixelkingdomwars.nativeclient.ui.kit.ChunkyBox
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.sealAccepts
import gg.pixelkingdomwars.nativeclient.ui.model.Verb

/**
 * One Home confirm (owner 2026-10-06: no old dark dialog on the player path) for the Kingdom's own confirms: cancel a
 * running job, place a draft whose consent is still the tile dialog, place a hero altar. The words are exactly the old
 * dialog's (the money rule: no new consent wording); only the look is the kit ConfirmDialog grammar (hub SPEC §3.3,
 * RouteConfirmDialog): a wood frame on parchment, the question in PS, every line drawn in full, a stone back door and
 * the [confirmVerb] primary with the 300 ms tap-through lock.
 */
@Immutable internal data class KingdomConfirmUi(
    val title: String,
    /** The consequence lines in order; drawn in full, never cut. */
    val lines: List<String>,
    val confirmLabel: String,
    val backLabel: String,
    val confirmVerb: Verb = Verb.GREEN,
    /** A line drawn bold in gold (the refund, the price words); null draws none. */
    val emphasis: String? = null,
    /** Off (no tap) while the old dialog disabled its confirm. */
    val confirmEnabled: Boolean = true,
)

/**
 * Drawn in its own dialog window, like the dialog it replaces, so it is above the HUD and every sheet; the camera cut-out
 * is drawn into (the scrim reaches the top edge) and the card keeps inside the safe insets. A scrim tap and Back are
 * [onBack]. [art] is an optional portrait slot above the question.
 */
@Composable internal fun KingdomConfirmDialog(ui: KingdomConfirmUi, onConfirm: () -> Unit, onBack: () -> Unit,
    art: (@Composable () -> Unit)? = null) {
    Dialog(onBack, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        val window = (LocalView.current.parent as? DialogWindowProvider)?.window
        DisposableEffect(window) {
            if (window == null) return@DisposableEffect onDispose {}
            val previous = window.attributes.layoutInDisplayCutoutMode
            window.attributes = window.attributes.apply {
                layoutInDisplayCutoutMode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R)
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
                else WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
            }
            onDispose { window.attributes = window.attributes.apply { layoutInDisplayCutoutMode = previous } }
        }
        val openedAt = remember { System.currentTimeMillis() }
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Box(Modifier.fillMaxSize().pointerInput(onBack) { detectTapGestures { onBack() } })
            Box(Modifier.windowInsetsPadding(WindowInsets.safeDrawing).padding(24.dp), contentAlignment = Alignment.Center) {
                // The card swallows its own taps, so only a tap on the scrim beside it is BACK.
                Plate(PlateKind.WOOD, Modifier.widthIn(max = 364.dp).fillMaxWidth().pointerInput(Unit) { detectTapGestures { } },
                    blocksScene = false) {
                    Plate(PlateKind.PARCHMENT, Modifier.fillMaxWidth(), blocksScene = false) {
                        // K-night-A11 (owner, hero altar cut-offs): the words scroll and the door row stays pinned under them, so a
                        // short window (a phone in landscape) never pushes CONFIRM / BACK below the card's bottom edge.
                        Column(Modifier.fillMaxWidth().padding(8.dp), horizontalAlignment = Alignment.CenterHorizontally,
                            verticalArrangement = Arrangement.spacedBy(10.dp)) {
                            Column(Modifier.fillMaxWidth().weight(1f, fill = false).verticalScroll(rememberScrollState()),
                                horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp)) {
                                art?.invoke()
                                PkwText(ui.title, PkwTokens.Type.title, Modifier.semantics { heading() }, color = PkwTokens.Colors.textOnParch,
                                    textAlign = TextAlign.Center, maxLines = 3)
                                ui.emphasis?.let { PkwText(it, PkwTokens.Type.body, color = PkwTokens.Colors.gold.lo, textAlign = TextAlign.Center, maxLines = 3) }
                                ui.lines.forEachIndexed { index, line ->
                                    PkwText(line, if (index == 0) PkwTokens.Type.body else PkwTokens.Type.small,
                                        color = if (index == 0) PkwTokens.Colors.textOnParch else PkwTokens.Colors.textOnParch2,
                                        textAlign = TextAlign.Center, maxLines = 8)
                                }
                            }
                            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                                ConfirmDoor(ui.backLabel, Verb.STONE, true, onBack, Modifier.weight(1f))
                                ConfirmDoor(ui.confirmLabel, ui.confirmVerb, ui.confirmEnabled, {
                                    if (sealAccepts(System.currentTimeMillis(), openedAt, PkwTokens.Motion.TAP_THROUGH_LOCK)) onConfirm()
                                }, Modifier.weight(1.4f))
                            }
                        }
                    }
                }
            }
        }
    }
}

/** A dialog door: the [verb] chunky face (OFF and no tap while not [enabled]) with its label in up to two PS lines. */
@Composable private fun ConfirmDoor(label: String, verb: Verb, enabled: Boolean, onClick: () -> Unit, modifier: Modifier) {
    ChunkyBox(PkwTokens.ramp(if (enabled) verb else Verb.OFF), onClick, label, modifier.heightIn(min = 56.dp), enabled = enabled) {
        PkwText(label, PkwTokens.Type.label, Modifier.padding(horizontal = 6.dp), color = PkwTokens.Colors.label, outline = 1.dp,
            textAlign = TextAlign.Center, maxLines = 2)
    }
}
