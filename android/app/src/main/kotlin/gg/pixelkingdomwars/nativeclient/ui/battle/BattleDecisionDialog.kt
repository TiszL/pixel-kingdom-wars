package gg.pixelkingdomwars.nativeclient.ui.battle

import android.os.Build
import android.view.WindowManager
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.DialogWindowProvider
import gg.pixelkingdomwars.nativeclient.scene.sceneInputRegion
import gg.pixelkingdomwars.nativeclient.ui.chrome.GameArt
import gg.pixelkingdomwars.nativeclient.ui.kit.BusyDots
import gg.pixelkingdomwars.nativeclient.ui.kit.ModalScrim
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.model.Verb

/**
 * The battle path's designed decision dialog, in the grammar of the HUD's own END confirm (battle-hud.png): a charcoal
 * plate over the 55 % seal scrim, the PS title in gold-hi, VT body lines, kit buttons in one row. It replaces the old dark
 * chrome AlertDialog on the live battle and scout paths (owner 2026-10-06: no old screens). Every caller keeps its own
 * strings, enable guards and owner calls; nothing is decided here.
 *
 * It is a Dialog window, so it covers the GL scene and the measured HUD columns from wherever it is composed (some
 * callers sit inside a column), system Back is [onDismiss], and a tap on the scrim is [onDismiss] too. The window is laid
 * out under the display cutout like the chrome dialog it replaces, and the plate keeps clear of it with the safe insets.
 */
@Composable internal fun BattleDecisionDialog(title: String, onDismiss: () -> Unit,
    body: @Composable ColumnScope.() -> Unit = {}, actions: @Composable RowScope.() -> Unit) {
    Dialog(onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        val window = (LocalView.current.parent as DialogWindowProvider).window
        DisposableEffect(window) {
            val previous = window.attributes.layoutInDisplayCutoutMode
            window.attributes = window.attributes.apply {
                layoutInDisplayCutoutMode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R)
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
                else WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
            }
            onDispose { window.attributes = window.attributes.apply { layoutInDisplayCutoutMode = previous } }
        }
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            ModalScrim(PkwTokens.Scrim.SEAL, onDismiss)
            Plate(PlateKind.CHARCOAL, Modifier.windowInsetsPadding(WindowInsets.safeDrawing).padding(horizontal = 24.dp)
                .widthIn(max = 360.dp).fillMaxWidth()) {
                Column(Modifier.padding(6.dp).heightIn(max = 560.dp).verticalScroll(rememberScrollState()),
                    verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    PkwText(title, PkwTokens.Type.title, Modifier.semantics { heading() }, color = PkwTokens.Colors.gold.hi,
                        outline = 1.dp, maxLines = 3)
                    body()
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), content = actions)
                }
            }
        }
    }
}

/** One VT body line of a [BattleDecisionDialog] (light text on the charcoal plate). */
@Composable internal fun BattleDialogLine(text: String, modifier: Modifier = Modifier) =
    PkwText(text, PkwTokens.Type.body, modifier, color = PkwTokens.Colors.text, maxLines = 8)

/** A status or error line drawn straight over the battle scene: VT 18 with a 1 dp ink outline so it reads on sand and
 *  grass alike (the kit's on-world text rule). It never takes scene input. */
@Composable internal fun BattleLine(text: String, color: Color, modifier: Modifier = Modifier) =
    PkwText(text, PkwTokens.Type.small, modifier, color = color, outline = 1.dp, maxLines = 3)

/**
 * The opaque battle / scout opening shell in kit dress (c-gap-army 2026-10-06; it replaces the old ink LoadingCard with
 * Material text, a Material progress bar and a chrome button on the raid entry and the scout preview). Same contract as
 * the chrome LoadingOverlay it replaces: it fills its parent with an opaque backdrop that swallows scene input, so the
 * canvas can initialise underneath without showing a green or blank surface; [topBar] keeps the existing way out; the
 * plate scrolls in short landscape and with enlarged text. [error] replaces the busy dots with the existing recovery line,
 * and [onRetry] (shown only with an error, as before) is the existing owner call. No progress is invented: busy is dots.
 */
@Composable internal fun BattleLoadingOverlay(title: String, art: String = "raid", error: String? = null,
    onRetry: (() -> Unit)? = null, topBar: (@Composable () -> Unit)? = null) {
    Column(Modifier.fillMaxSize().background(PkwTokens.Colors.bg).sceneInputRegion()
        .windowInsetsPadding(WindowInsets.safeDrawing).padding(12.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        topBar?.invoke()
        Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
            Plate(PlateKind.CHARCOAL, Modifier.widthIn(max = 360.dp).fillMaxWidth()) {
                Column(Modifier.padding(6.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        GameArt(art, Modifier.size(36.dp))
                        PkwText(title, PkwTokens.Type.title, Modifier.weight(1f).semantics { liveRegion = LiveRegionMode.Polite },
                            color = PkwTokens.Colors.gold.hi, outline = 1.dp, maxLines = 2)
                        if (error == null) BusyDots()
                    }
                    if (error != null) {
                        PkwText(error, PkwTokens.Type.body, Modifier.semantics { liveRegion = LiveRegionMode.Assertive },
                            color = PkwTokens.Colors.text, maxLines = 6)
                        onRetry?.let { retry -> SecondaryButton("TRY AGAIN", retry, Modifier.fillMaxWidth(), verb = Verb.BLUE) }
                    }
                }
            }
        }
    }
}

/** The plate the battle shows while the server creates the match (raid.png busy state "Finding a base"): a veil chip
 *  with the existing status words and the kit's busy dots, and the existing way back. Paint and kit buttons only. */
@Composable internal fun BattleOpeningStatus(title: String, busy: Boolean, modifier: Modifier = Modifier,
    trailing: (@Composable () -> Unit)? = null) {
    Row(modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Plate(PlateKind.CHARCOAL, Modifier.weight(1f, fill = false)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                PkwText(title, PkwTokens.Type.title, Modifier.semantics { heading() }, color = PkwTokens.Colors.gold.hi, outline = 1.dp)
                if (busy) BusyDots()
            }
        }
        trailing?.invoke()
    }
}
