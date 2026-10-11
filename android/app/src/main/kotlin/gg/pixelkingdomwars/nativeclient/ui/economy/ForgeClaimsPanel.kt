package gg.pixelkingdomwars.nativeclient.ui.economy

import gg.pixelkingdomwars.nativeclient.ui.chrome.SurfaceInk
import gg.pixelkingdomwars.nativeclient.ui.chrome.Button
import gg.pixelkingdomwars.nativeclient.ui.chrome.OutlinedButton
import gg.pixelkingdomwars.nativeclient.ui.chrome.TextButton
import gg.pixelkingdomwars.nativeclient.ui.chrome.PixelPlate
import gg.pixelkingdomwars.nativeclient.ui.chrome.AlertDialog
import gg.pixelkingdomwars.nativeclient.ui.chrome.LinearProgressIndicator

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.sp
import gg.pixelkingdomwars.nativeclient.ui.Palette
import gg.pixelkingdomwars.nativeclient.ui.Copy
import gg.pixelkingdomwars.nativeclient.ops.Receipt
import gg.pixelkingdomwars.nativeclient.ui.chrome.GameArt
import gg.pixelkingdomwars.nativeclient.network.fmtN
import gg.pixelkingdomwars.nativeclient.data.ForgeClaimPhase
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import gg.pixelkingdomwars.nativeclient.model.ForgeAllocations
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import kotlinx.coroutines.awaitCancellation
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonPrimitive

/** Kept outside the current-allocation gate so lost deeds cannot hide saved claims. */
@Composable fun ForgeClaimsPanel(model: ForgeClaimsViewModel, wallet: String, selectedBase: String?,
    allocationBase: String?, allocations: ForgeAllocations?, showDays: Boolean = false, nextExpiresAt: String? = null) {
    val state by model.state.collectAsState()
    val notice by model.notice.collectAsState()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    BackHandlerAt(BackPriority.CONFIRM, state.review != null, model::dismiss)
    LaunchedEffect(wallet, selectedBase, allocationBase) { model.dismiss() }
    DisposableEffect(model, lifecycle) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_PAUSE) model.dismiss() }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer); model.dismiss() }
    }
    LaunchedEffect(model, lifecycle) { lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) { model.foreground(); awaitCancellation() } }
    var details by remember(state.receipt?.idempotencyKey, state.pending?.idempotencyKey) { mutableStateOf(false) }
    val ready = allocations.takeUnless { state.refreshRequired }
    val canCollect = state.pending == null && !state.refreshRequired && state.supported && state.enabled && !state.busy
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        state.receipt?.let { receipt ->
            PixelPlate("keep", Modifier.fillMaxWidth(), PaddingValues(12.dp)) { Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    GameArt("keep", Modifier.size(24.dp)); Text("+${fmtN(receipt.result.totalKeep)} KEEP", style = MaterialTheme.typography.headlineSmall, color = SurfaceInk.goldHi) }
                Text(if (receipt.result.claimed.isEmpty()) "Nothing was ready for this collection." else "Added to your game wallet")
                state.refreshError?.let { Text(it, color = SurfaceInk.faint) }
                state.payout?.unavailable?.let { Text("Collected. Balance unavailable for the original allocation scope.", color = SurfaceInk.faint) }
            } }
        }
        if (state.busy && state.phase != ForgeClaimPhase.REVIEW) {
            Text(when (state.phase) {
                ForgeClaimPhase.COLLECTING -> "Collecting KEEP…"
                ForgeClaimPhase.UPDATING -> "Updating balance…"
                else -> "Checking outcome…"
            })
            LinearProgressIndicator(Modifier.fillMaxWidth())
        }
        notice?.let { DismissableNotice(it.message, it.error, model::dismissNotice) }
        if (ready != null) {
            if (ready.claimable.toBigDecimal().signum() > 0) {
                PixelPlate("keep", Modifier.fillMaxWidth(), PaddingValues(12.dp)) { Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("AVAILABLE KEEP", style = MaterialTheme.typography.titleMedium, color = SurfaceInk.faint)
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        GameArt("keep", Modifier.size(24.dp))
                        Text("${fmtN(ready.claimable)} KEEP", style = MaterialTheme.typography.headlineSmall, color = SurfaceInk.goldHi)
                    }
                    Button(onClick = { model.review(allocationBase, null) }, modifier = Modifier.fillMaxWidth(), enabled = canCollect) { Text("COLLECT KEEP") }
                    nextExpiresAt?.let { Text("Collect before ${it.take(10)}. Expired KEEP returns to the emission pool.", color = SurfaceInk.faint, style = MaterialTheme.typography.bodySmall) }
                } }
            } else EmptyPlate("NOTHING READY TO COLLECT")
        }
        if (!state.supported && !state.busy) Text("Collecting is unavailable right now. You can still check a saved claim.")
        else if (!state.enabled && !state.busy) Text("New collections are paused. You can still check a saved claim.")
        state.pending?.takeIf { it.receipt == null }?.let { saved ->
            Text("Checking outcome. Your original claim is saved; check it before collecting again.")
            OutlinedButton(onClick = { model.retry() }, enabled = !state.busy && state.supported && state.enabled) { Text("RETRY ORIGINAL CLAIM") }
            // Owner 2026-10-06: once the receipt route answered `unknown` for this saved key, the owner's CLOSE (one more GET,
            // then forgotten on this device; nothing is sent) is the way out, so collecting is never dead-ended.
            if (saved.idempotencyKey == state.serverUnknownKey) {
                Copy.observation(Receipt.Absent)?.let { Text(it, color = SurfaceInk.faint, style = MaterialTheme.typography.bodySmall) }
                OutlinedButton(onClick = { model.close() }, enabled = !state.busy) { Text(Copy.CLOSE_REQUEST.uppercase()) }
            }
        }
        if (showDays && canCollect) ready?.days?.filter { it.status == "claimable" }?.forEach { day ->
            OutlinedButton(onClick = { model.review(allocationBase, day.day) }, modifier = Modifier.fillMaxWidth()) { Text("COLLECT ${day.day} · ${fmtN(day.keep)} KEEP") }
        }
        if (state.pending != null || state.receipt != null || !state.supported || !state.enabled || notice != null) {
            TextButton(onClick = { model.refresh() }, enabled = !state.busy) {
                Text(if (state.receipt != null) "UPDATE BALANCE" else "CHECK OUTCOME")
            }
        }
        if (state.pending != null || state.receipt != null) {
            TextButton(onClick = { details = !details }) { Text(if (details) "HIDE CLAIM DETAILS" else "CLAIM DETAILS") }
            if (details) SelectionContainer {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    state.receipt?.let { receipt ->
                        Text("Wallet: ${receipt.actor}\nClaim: ${receipt.idempotencyKey}\nOriginal allocation scope: ${receipt.baseId ?: "wallet allocations"}")
                        receipt.result.claimed.forEach { row -> Text("${row.day}: ${fmtN(row.keep)} KEEP\nLedger entry: ${row.ledgerTransactionId}") }
                        Text("${receipt.result.remaining} allocations remained when this receipt was recorded.")
                        state.payout?.keepBalance?.let { Text("Refreshed game wallet: ${fmtN(it)} KEEP") }
                        state.payout?.unavailable?.let { Text(it) }
                    } ?: state.pending?.let { pending ->
                        Text("Original claim: ${pending.idempotencyKey}\nAllocation scope: ${pending.baseId ?: "wallet allocations"}\nDay: ${pending.body["day"]?.takeUnless { it == JsonNull }?.jsonPrimitive?.content ?: "all ready allocations"}")
                    }
                }
            }
        }
    }
    state.review?.let { review ->
        var reviewDetails by remember(wallet, review) { mutableStateOf(false) }
        AlertDialog(onDismissRequest = model::dismiss,
        title = { Text("REVIEW COLLECTION") },
        text = { Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(if (review.day == null) "Collect ready KEEP into your game wallet." else "Collect this day's ready KEEP into your game wallet.")
            Text("Up to ${review.batchMax} ready rewards per collection. The amount is confirmed when collection finishes.")
            Text("Rewards already collected won't be added again.", color = SurfaceInk.faint, style = MaterialTheme.typography.bodySmall)
            TextButton(onClick = { reviewDetails = !reviewDetails }, modifier = Modifier.heightIn(min = 48.dp)
                .semantics { stateDescription = if (reviewDetails) "Expanded" else "Collapsed" }) {
                Text(if (reviewDetails) "HIDE CLAIM DETAILS" else "CLAIM DETAILS")
            }
            if (reviewDetails) SelectionContainer {
                Text("Wallet: $wallet\nAllocation scope: ${review.baseId ?: "wallet allocations"}\nDay: ${review.day ?: "all ready allocations"}\n\nThis collection keeps the same scope and day if you need to check or retry it.",
                    style = MaterialTheme.typography.bodySmall)
            }
        } },
        confirmButton = { TextButton(onClick = { model.confirm(review) }, enabled = !state.busy && state.supported && state.enabled) { Text("COLLECT KEEP") } },
        dismissButton = { TextButton(onClick = model::dismiss) { Text("Back") } }) }
}
