package gg.pixelkingdomwars.nativeclient.ui.chrome

import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Toast
import gg.pixelkingdomwars.nativeclient.ui.model.ToastKind
import gg.pixelkingdomwars.nativeclient.ui.model.ToastUi
import kotlinx.coroutines.delay

/** The queued items the layer draws: at most the kit's budget (DESIGN-SYSTEM §6: 3), oldest first, so the newest sits at
 *  the bottom of the stack, nearest the thumb (hub SPEC §3.2). */
internal fun kitToastLayerItems(items: List<ToastItem>): List<ToastItem> = items.takeLast(PkwTokens.Budget.MAX_TOASTS)

/** One queued line as the designed toast (hub SPEC §3.2). The layer has no navigation of its own, so each door is drawn
 *  only while the app has bound one ([ToastDoors]): "Report" only on an error and only while [reportBound]; GO only when
 *  the line names a place and only while [goBound]. A door that could not open would be a dead control. */
internal fun kitToastUi(item: ToastItem, reportBound: Boolean = false, goBound: Boolean = false): ToastUi {
    val go = item.go?.takeIf { goBound }
    return ToastUi(key = "toast:${item.id}", message = item.message, icon = null,
        kind = if (item.error) ToastKind.ERROR else ToastKind.INFO, go = go, goLabel = if (go != null) "GO" else null,
        report = item.error && reportBound, postedAtMs = item.postedAt, revision = item.revision)
}

/** Above the home deck, as the old chrome host kept it, so a toast never covers the tab a player is about to tap. */
private val KIT_TOAST_DOCK_CLEARANCE = 92.dp
/** SPEC §3.2: the stack runs x 52..404, clear of the MAIL and CHAT edge tabs on the left. */
private val KIT_TOAST_START = 52.dp
private val KIT_TOAST_END = 8.dp
private val KIT_TOAST_MAX_WIDTH = 396.dp

/**
 * The app-wide toast layer (hub SPEC §3.2, toasts.png bottom): the designed kit [Toast] for every line posted to
 * [Toasts]. The queue keeps its own clock exactly as the old chrome host ran it: each toast retires after the queue's
 * lifetime, a tap retires it early, and a burst keeps only the newest few. Bottom-centre inside the safe-drawing insets.
 *
 * Doors: an error toast carries the gold "Report" link while the app root has bound [ToastDoors.bindReport] (Feedback,
 * prefilled with the toast's sentence), and a line posted with a place carries the blue GO while a GO door is bound
 * ([ToastDoors.bindGo]). Either tap opens its door and retires the toast; with no door bound neither is drawn.
 *
 * Pointer rule: the root and the column have no pointer handling, so empty space reaches the layers below; only the
 * painted plates take touches.
 */
@Composable fun KitToastLayer(queue: ToastQueue = Toasts.queue, modifier: Modifier = Modifier) {
    val items by queue.items.collectAsState()
    val reportBound by ToastDoors.reportBound.collectAsState()
    val goBound by ToastDoors.goBound.collectAsState()
    LaunchedEffect(items) {
        while (true) { delay(queue.expire(System.currentTimeMillis()) ?: return@LaunchedEffect) }
    }
    if (items.isEmpty()) return
    Box(modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing)
        .padding(start = KIT_TOAST_START, end = KIT_TOAST_END, bottom = KIT_TOAST_DOCK_CLEARANCE), contentAlignment = Alignment.BottomCenter) {
        Column(Modifier.widthIn(max = KIT_TOAST_MAX_WIDTH), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            kitToastLayerItems(items).forEach { item ->
                val ui = kitToastUi(item, reportBound, goBound)
                key(ui.key) {
                    Toast(ui, onGo = { it.go?.let(ToastDoors::go); queue.dismiss(item.id) },
                        onReport = { ToastDoors.report(it.message); queue.dismiss(item.id) },
                        modifier = Modifier.clickable(interactionSource = remember { MutableInteractionSource() },
                        indication = null, onClickLabel = "Dismiss", role = Role.Button) { queue.dismiss(item.id) })
                }
            }
        }
    }
}
