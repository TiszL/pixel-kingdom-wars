package gg.pixelkingdomwars.nativeclient.ui.economy

import gg.pixelkingdomwars.nativeclient.ui.chrome.SurfaceInk
import gg.pixelkingdomwars.nativeclient.ui.chrome.OutlinedButton
import gg.pixelkingdomwars.nativeclient.ui.chrome.TextButton
import gg.pixelkingdomwars.nativeclient.ui.Palette
import gg.pixelkingdomwars.nativeclient.ui.Copy
import gg.pixelkingdomwars.nativeclient.ops.Receipt
import gg.pixelkingdomwars.nativeclient.ui.chrome.AlertDialog
import gg.pixelkingdomwars.nativeclient.ui.chrome.LinearProgressIndicator

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import gg.pixelkingdomwars.nativeclient.ops.WithdrawalUnwindSpec
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import kotlinx.coroutines.awaitCancellation

/** Custody recovery remains available after a player sells their last deed. */
@Composable fun WithdrawalUnwindPanel(model: WithdrawalUnwindViewModel, wallet: String, selectedBase: String?, onResolved: () -> Unit) {
    val state by model.state.collectAsState(); val notice by model.notice.collectAsState()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val resolved by rememberUpdatedState(onResolved)
    LaunchedEffect(state.outcome) { if (state.outcome != null) resolved() }
    BackHandlerAt(BackPriority.CONFIRM, state.review != null, model::dismiss)
    LaunchedEffect(wallet, selectedBase) { model.dismiss() }
    DisposableEffect(model, lifecycle) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_PAUSE) model.dismiss() }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer); model.dismiss() }
    }
    LaunchedEffect(model, lifecycle) { lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) { model.foreground(); awaitCancellation() } }
    TitledPlate("MANAGE WITHDRAWALS", art = "shield") {
        Text("Cancel an unbonding withdrawal or request a refund when the server confirms it is safe. Returned KEEP goes to your in-game wallet.", style = MaterialTheme.typography.bodySmall, color = SurfaceInk.muted)
        if (state.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
        notice?.let { DismissableNotice(it.message, it.error, model::dismissNotice) }
        if (!state.supported) Text("Refresh the available withdrawal recovery service before continuing. Saved requests stay held.", style = MaterialTheme.typography.bodySmall, color = SurfaceInk.muted)
        state.pending?.let { saved ->
            val details = runCatching { WithdrawalUnwindSpec.consent(saved) }.getOrNull()
            if (details != null) { val (action, target) = details
                SelectionContainer { Text("${action.title}: ${target.id}\nOriginal amount: ${target.gross} KEEP\nDestination: ${target.destination}", style = MaterialTheme.typography.bodySmall) }
            } else Text("The saved withdrawal details could not be validated. Keep the request saved and contact support.", style = MaterialTheme.typography.bodySmall)
            Text(if (saved.receipt != null) "The terminal status is saved. Refresh its original wallet balance to finish recovery."
                else "This request is unresolved. Missing history does not prove failure; automatic checks never send it again.", style = MaterialTheme.typography.bodySmall, color = SurfaceInk.muted)
            if (saved.receipt == null) OutlinedButton(onClick = { model.retry() }, enabled = details != null && !state.busy && state.supported, modifier = Modifier.fillMaxWidth()) { Text("RETRY ORIGINAL REQUEST") }
            // Owner 2026-10-06: once the history answered `unknown` for this saved key, the owner's CLOSE (one more GET, then
            // forgotten on this device; nothing is sent) is the way out, so withdrawal recovery is never dead-ended.
            if (saved.receipt == null && saved.idempotencyKey == state.serverUnknownKey) {
                Copy.observation(Receipt.Absent)?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = SurfaceInk.muted) }
                OutlinedButton(onClick = { model.close() }, enabled = !state.busy, modifier = Modifier.fillMaxWidth()) { Text(Copy.CLOSE_REQUEST.uppercase()) }
            }
        }
        state.outcome?.let { proof ->
            SelectionContainer { Text("Original withdrawal: ${proof.target.id}\nStatus: ${proof.status.uppercase()}\nCompleted: ${proof.completedAt}", style = MaterialTheme.typography.bodySmall) }
            Text(if (proof.returnedToWallet) "${proof.target.gross} KEEP returned to your in-game wallet."
                else "This withdrawal was sent. It was not returned to your in-game balance.", style = MaterialTheme.typography.bodySmall, color = SurfaceInk.success)
            proof.signature?.let { SelectionContainer { Text("Transaction: $it", style = MaterialTheme.typography.labelSmall, color = SurfaceInk.faint) } }
            state.keepBalance?.let { HudChip("keep", "REFRESHED WALLET BALANCE", "$it KEEP", kind = "keep") }
            if (state.balanceUnavailable) Text("The original balance scope is unavailable. Its terminal withdrawal status is confirmed; another deed or on-chain balance does not substitute.", style = MaterialTheme.typography.bodySmall, color = SurfaceInk.muted)
        }
        if (state.pending == null && state.supported) {
            if (state.choices.isEmpty()) EmptyPlate("NO WITHDRAWALS CURRENTLY OFFER CANCELLATION OR A SAFE REFUND.")
            state.choices.forEach { choice ->
                PlateRow("${choice.action.title.uppercase()} · ${choice.target.gross} KEEP", "keep", note = choice.target.id.take(8), enabled = !state.busy && state.review == null) { model.review(choice.target.id, choice.action) }
            }
        }
        TextButton(onClick = { model.refresh() }, enabled = !state.busy) { Text("CHECK ORIGINAL WITHDRAWAL") }
    }
    state.review?.let { review -> AlertDialog(onDismissRequest = model::dismiss,
        title = { Text("${review.action.title}?") },
        text = { Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            SelectionContainer { Text("Withdrawal: ${review.target.id}\nAmount to return: ${review.target.gross} KEEP\nOriginal destination: ${review.target.destination}\nIn-game wallet receiving KEEP: $wallet") }
            Text("The server checks this exact withdrawal again before returning escrow. If its payout has progressed, the request may be refused. No wallet signature or on-chain transfer is requested.")
        } },
        confirmButton = { TextButton(onClick = { model.confirm(review) }, enabled = !state.busy && state.supported) { Text("Confirm") } },
        dismissButton = { TextButton(onClick = model::dismiss) { Text("Back") } }) }
}
