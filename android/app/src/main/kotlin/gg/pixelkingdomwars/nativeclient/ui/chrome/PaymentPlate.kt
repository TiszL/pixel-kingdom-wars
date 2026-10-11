@file:OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
package gg.pixelkingdomwars.nativeclient.ui.chrome

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import gg.pixelkingdomwars.nativeclient.ui.Palette

/* One payment plate for every SOL / KEEP surface (owner 2026-09-17: the Solana dialogs were "not quite good";
 * 2026-09-18: "flow should be simple, as in most games, but secure"). Reads top to bottom as a receipt: what is
 * being bought, the one amount, one status line, then at most ONE gold plate. Recovery runs by itself, so the manual
 * CHECK / VERIFY controls and every identifier live together under the collapsed DETAILS disclosure (tap-to-copy).
 * The rules it renders are in PaymentPresentation.kt. */

private fun PaymentTone.color(): Color = when (this) {
    PaymentTone.OPEN -> Palette.gold
    PaymentTone.SENT -> Palette.goldHi
    PaymentTone.DONE -> Palette.success
    PaymentTone.TROUBLE -> Palette.danger
    PaymentTone.CLOSED -> Palette.textFaint
}

/** Status pill: one word on an ink chip, ruled and coloured by tone. Announced as "Status …". */
@Composable fun StatusPill(pill: PaymentPill, modifier: Modifier = Modifier) {
    val tone = pill.tone.color()
    Box(modifier.background(Palette.ink).border(2.dp, tone).semantics { contentDescription = "Status ${pill.label}" }
        .padding(horizontal = 8.dp, vertical = 2.dp)) {
        Text(pill.label, color = tone, style = MaterialTheme.typography.labelSmall, letterSpacing = 1.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** The payment window line under the hero amount; blood once the window closed, gold while it is open. */
@Composable fun PaymentWindowLine(label: String, modifier: Modifier = Modifier) {
    val closed = label.endsWith("CLOSED")
    Row(modifier.semantics(mergeDescendants = true) { contentDescription = "Payment window: $label" }, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        GameArt("timer", Modifier.size(16.dp))
        Text(label, style = MaterialTheme.typography.labelMedium, color = if (closed) SurfaceInk.danger else SurfaceInk.gold, maxLines = 1)
    }
}

/** The riveted payment panel. `content` sits between the amount and the actions for status copy and notices;
 * `footnote` is the faint honesty line under everything (what hiding or leaving does NOT do). */
@Composable fun PaymentPlate(title: String, modifier: Modifier = Modifier, art: String? = null, pill: PaymentPill? = null,
    onHide: (() -> Unit)? = null, amount: String? = null, unit: String = "SOL", amountArt: String = "sol", feeLine: String? = null,
    countdown: String? = null, actions: List<PaymentAction> = emptyList(), onAction: (String) -> Unit = {},
    details: List<PaymentDetail> = emptyList(), footnote: String? = null, detailActions: List<PaymentAction> = emptyList(),
    content: @Composable ColumnScope.() -> Unit = {}) {
    PixelPanel(modifier.fillMaxWidth()) {
        Row(Modifier.fillMaxWidth().padding(start = 18.dp, end = 6.dp, top = 6.dp, bottom = 2.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            art?.let { GameArt(it, Modifier.size(22.dp)) }
            Text(title, Modifier.weight(1f), color = SurfaceInk.goldHi, style = MaterialTheme.typography.titleSmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
            pill?.let { StatusPill(it) }
            onHide?.let { hide ->
                Box(Modifier.size(36.dp).semantics { contentDescription = "Hide $title" }
                    .clickable(role = Role.Button, interactionSource = remember { MutableInteractionSource() }, indication = null, onClick = hide), contentAlignment = Alignment.Center) {
                    GameArt("close", Modifier.size(18.dp))
                }
            }
        }
        Column(Modifier.fillMaxWidth().padding(start = 10.dp, end = 10.dp, top = 4.dp, bottom = 10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            amount?.let { PaymentHero(it, unit, amountArt, feeLine) }
            countdown?.let { PaymentWindowLine(it) }
            content()
            PaymentActionsRow(actions, onAction, amountArt)
            if (details.isNotEmpty() || detailActions.isNotEmpty()) PaymentDetails(details, detailActions, onAction)
            footnote?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = SurfaceInk.faint) }
        }
    }
}

/** The one big number: glyph, amount and unit on the keep plate, the fee split as its small second line. */
@Composable private fun PaymentHero(amount: String, unit: String, art: String, feeLine: String?) {
    val described = Modifier.fillMaxWidth().semantics(mergeDescendants = true) { contentDescription = "$amount $unit${feeLine?.let { ". $it" } ?: ""}" }
    // On the designed parchment the amount sits on the kit's dark VEIL well (the Seal's token row), light text kept.
    if (onParchment()) gg.pixelkingdomwars.nativeclient.ui.kit.Plate(gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind.VEIL, described,
        contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp)) {
        CompositionLocalProvider(LocalSurfaceTone provides SurfaceTone.CHARCOAL) { PaymentHeroFigures(amount, unit, art, feeLine) }
    } else PixelPlate("keep", described, PaddingValues(horizontal = 12.dp, vertical = 8.dp)) { PaymentHeroFigures(amount, unit, art, feeLine) }
}

@Composable private fun PaymentHeroFigures(amount: String, unit: String, art: String, feeLine: String?) {
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            GameArt(art, Modifier.size(28.dp))
            Text(amount, style = MaterialTheme.typography.headlineMedium, color = Palette.gold, maxLines = 1)
            Text(unit, style = MaterialTheme.typography.titleMedium, color = Palette.gold, maxLines = 1)
        }
        feeLine?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = Palette.muted) }
    }
}

/** The gold primary stands alone and full width (54dp); the stone and ghost plates share one compact wrapping row. */
@Composable private fun PaymentActionsRow(actions: List<PaymentAction>, onAction: (String) -> Unit, amountArt: String) {
    actions.filter { it.role == PaymentActionRole.PRIMARY }.forEach { action ->
        Button(onClick = { onAction(action.id) }, modifier = Modifier.fillMaxWidth().heightIn(min = 54.dp), enabled = action.enabled) {
            if (action.id == PaymentActions.PAY) GameArt(amountArt, Modifier.size(20.dp))
            Text(action.label, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
    val rest = actions.filter { it.role != PaymentActionRole.PRIMARY }
    if (rest.isNotEmpty()) FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        rest.forEach { action ->
            val padding = PaddingValues(horizontal = 12.dp, vertical = 6.dp)
            if (action.role == PaymentActionRole.SECONDARY) OutlinedButton(onClick = { onAction(action.id) }, enabled = action.enabled, contentPadding = padding) {
                Text(action.label, style = MaterialTheme.typography.labelMedium, maxLines = 1)
            } else TextButton(onClick = { onAction(action.id) }, enabled = action.enabled, contentPadding = padding) {
                Text(action.label, style = MaterialTheme.typography.labelMedium, maxLines = 1)
            }
        }
    }
}

/** The one compact confirm step between a price tap and the wallet: what, how much, one gold PAY plate, a small
 * CANCEL. `progress` replaces the gold label while the tap is running (the plate stays, disabled, so a second tap
 * can never start a second payment); `failure` is the single plain sentence after a decline. */
@Composable fun PaymentConfirmDialog(title: String, amount: String, payLabel: String, payEnabled: Boolean, onPay: () -> Unit, onCancel: () -> Unit,
    art: String? = null, unit: String = "SOL", amountArt: String = "sol", feeLine: String? = null, progress: String? = null, failure: String? = null,
    cancelLabel: String = "CANCEL", showPay: Boolean = true, details: List<PaymentDetail> = emptyList(), detailActions: List<PaymentAction> = emptyList(),
    onAction: (String) -> Unit = {}, onDismiss: () -> Unit = onCancel, content: @Composable ColumnScope.() -> Unit = {}) {
    // `onDismiss` is the X, the scrim and Back: it only hides the plate. `onCancel` is the player's explicit CANCEL.
    AlertDialog(onDismissRequest = onDismiss, icon = art?.let { { GameArt(it, Modifier.size(24.dp)) } }, title = { Text(title, maxLines = 2, overflow = TextOverflow.Ellipsis) },
        text = { Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            PaymentHero(amount, unit, amountArt, feeLine)
            progress?.let { Text(it, style = MaterialTheme.typography.labelMedium, color = SurfaceInk.goldHi) }
            failure?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = SurfaceInk.danger) }
            content()
            if (details.isNotEmpty() || detailActions.isNotEmpty()) PaymentDetails(details, detailActions, onAction)
        } },
        confirmButton = { if (showPay) Button(onClick = onPay, enabled = payEnabled, modifier = Modifier.heightIn(min = 54.dp)) {
            GameArt(amountArt, Modifier.size(20.dp)); Text(payLabel, maxLines = 1, overflow = TextOverflow.Ellipsis)
        } },
        dismissButton = { TextButton(onClick = onCancel) { Text(cancelLabel) } })
}

/** Collapsed by default. Each row is a button that copies its full value; the row it copied says COPIED. The manual
 * recovery controls sit at the top of the opened block: nobody needs them unless something went wrong. */
@Composable private fun PaymentDetails(details: List<PaymentDetail>, detailActions: List<PaymentAction> = emptyList(), onAction: (String) -> Unit = {}) {
    var open by rememberSaveable { mutableStateOf(false) }
    val clipboard = LocalClipboardManager.current
    var copied by remember { mutableStateOf<Pair<String, Boolean>?>(null) }
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        PixelPlate(if (open) "tab" else "tab-sunk", Modifier.fillMaxWidth().heightIn(min = 44.dp)
            .semantics { stateDescription = if (open) "Expanded" else "Collapsed" }
            .clickable(role = Role.Button, interactionSource = remember { MutableInteractionSource() }, indication = null) { open = !open }, PaddingValues(horizontal = 12.dp, vertical = 8.dp)) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text("DETAILS", Modifier.weight(1f), color = SurfaceInk.goldHi, style = MaterialTheme.typography.labelMedium)
                Text(if (open) "▾" else "▸", color = if (open) SurfaceInk.gold else SurfaceInk.faint, style = MaterialTheme.typography.bodyMedium)
            }
        }
        if (open && detailActions.isNotEmpty()) FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            detailActions.forEach { action ->
                OutlinedButton(onClick = { onAction(action.id) }, enabled = action.enabled, contentPadding = PaddingValues(horizontal = 12.dp, vertical = 6.dp)) {
                    Text(action.label, style = MaterialTheme.typography.labelMedium, maxLines = 1)
                }
            }
        }
        if (open) details.forEach { detail ->
            val state = copied?.takeIf { it.first == detail.label }
            Column(Modifier.fillMaxWidth().border(2.dp, SurfaceInk.rule)
                .semantics(mergeDescendants = true) { contentDescription = "${detail.label} ${detail.value} — tap to copy" }
                .clickable(role = Role.Button, interactionSource = remember { MutableInteractionSource() }, indication = null) {
                    copied = detail.label to runCatching { clipboard.setText(AnnotatedString(detail.value)) }.isSuccess
                }.padding(horizontal = 8.dp, vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text(detail.label.uppercase(), Modifier.weight(1f), style = MaterialTheme.typography.labelSmall, fontSize = 12.sp, letterSpacing = 1.sp, color = SurfaceInk.faint)
                    Text(when (state?.second) { null -> "TAP TO COPY"; true -> "COPIED"; false -> "COPY FAILED" }, style = MaterialTheme.typography.labelSmall, fontSize = 12.sp,
                        color = when (state?.second) { null -> SurfaceInk.faint; true -> SurfaceInk.gold; false -> SurfaceInk.danger })
                }
                Text(detail.value, style = MaterialTheme.typography.labelSmall, fontSize = 13.sp, letterSpacing = 0.sp, color = SurfaceInk.text)
            }
        }
    }
}
