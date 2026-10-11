package gg.pixelkingdomwars.nativeclient.ui.economy

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import gg.pixelkingdomwars.nativeclient.network.fmtN
import gg.pixelkingdomwars.nativeclient.ops.IntentKind
import gg.pixelkingdomwars.nativeclient.ops.PendingIntent
import gg.pixelkingdomwars.nativeclient.ui.Palette
import gg.pixelkingdomwars.nativeclient.ui.chrome.*
import gg.pixelkingdomwars.nativeclient.ui.chrome.Button
import gg.pixelkingdomwars.nativeclient.ui.chrome.OutlinedButton
import gg.pixelkingdomwars.nativeclient.ui.chrome.TextButton
import gg.pixelkingdomwars.nativeclient.ui.chrome.AlertDialog
import gg.pixelkingdomwars.nativeclient.ui.chrome.LinearProgressIndicator
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import kotlinx.coroutines.awaitCancellation
import kotlinx.serialization.json.jsonPrimitive

private enum class GemsPage(val label: String) { GET("Get Gems"), CONVERT("Convert"), RECEIPTS("Receipts") }
internal fun gemsSavedPill(saved: PendingIntent) = when {
    saved.receipt != null -> PaymentPill("CONFIRMED", PaymentTone.DONE)
    saved.attempted -> PaymentPill("CHECK OUTCOME", PaymentTone.TROUBLE)
    else -> PaymentPill("SAVED REQUEST", PaymentTone.OPEN)
}

/** Ledger actions and entry to the separately journaled wallet purchase rail. */
@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable fun GemsScreen(model: GemsViewModel, wallet: String, selectionGeneration: Long,
    walletPurchasePending: Boolean = false, onWalletPurchase: () -> Unit = {}, onBack: () -> Unit) {
    val state by model.state.collectAsState(); val notice by model.notice.collectAsState()
    var keep by rememberSaveable(wallet) { mutableStateOf("") }; var gems by rememberSaveable(wallet) { mutableStateOf("") }
    var page by rememberSaveable(wallet) { mutableStateOf(GemsPage.GET) }
    val noticeLocation = remember { BringIntoViewRequester() }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(model, lifecycle) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_STOP) model.dismiss() }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer); model.dismiss() }
    }
    LaunchedEffect(model, lifecycle, selectionGeneration) {
        model.dismiss()
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) { model.foreground(); awaitCancellation() }
    }
    LaunchedEffect(notice) { if (notice?.error == true) noticeLocation.bringIntoView() }
    val enabled = state.enabled && !state.busy && state.pending.isEmpty() && state.review == null
    val back = { model.dismiss(); onBack() }
    BackHandlerAt(BackPriority.SCREEN) { back() }
    BackHandlerAt(BackPriority.CONFIRM, state.review != null, model::dismiss)
    DesignedPage("GEMS WALLET", back) {
        PixelPanel(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    GameArt("gem-32", Modifier.size(40.dp))
                    Column(Modifier.weight(1f)) {
                        Text("Your Gems", style = MaterialTheme.typography.titleSmall, color = SurfaceInk.muted)
                        Text((state.balances?.gems ?: state.overview?.gems)?.let(::fmtN) ?: "…", style = MaterialTheme.typography.headlineMedium, color = SurfaceInk.goldHi)
                    }
                }
                Text("Gems stay in the game. They cannot be withdrawn or converted back to KEEP.", color = SurfaceInk.muted)
                HorizontalDivider()
                Text("In-game KEEP: ${state.balances?.keep?.let(::fmtN) ?: "…"}", style = MaterialTheme.typography.titleSmall)
                Text("Your connected wallet's KEEP is a separate balance.", style = MaterialTheme.typography.bodySmall, color = SurfaceInk.muted)
            }
        }
        if (state.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
        notice?.let { Text(it.message, Modifier.bringIntoViewRequester(noticeLocation).semantics { liveRegion = LiveRegionMode.Polite }, color = if (it.error) SurfaceInk.danger else SurfaceInk.text) }
        if (!state.enabled && !state.busy) Text("New Gems actions are unavailable. Saved requests remain recoverable.", color = SurfaceInk.muted)
        if (state.pending.isNotEmpty() && page != GemsPage.RECEIPTS) PaymentPlate("Saved request", pill = PaymentPill("CHECK NEEDED", PaymentTone.TROUBLE)) {
            Text("Check your original request before starting another conversion.")
            OutlinedButton(onClick = { page = GemsPage.RECEIPTS }, modifier = Modifier.fillMaxWidth()) { Text("VIEW SAVED RECEIPTS") }
        }
        if (page != GemsPage.RECEIPTS) state.receipt?.let { Text("Original receipt confirmed: +${fmtN(it.amount)} ${it.currency}", color = SurfaceInk.goldHi) }
        if (walletPurchasePending) OutlinedButton(onClick = onWalletPurchase, enabled = !state.busy, modifier = Modifier.fillMaxWidth()) { Text("RECOVER WALLET GEMS PURCHASE") }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            GemsPage.entries.forEach { tab -> OutlinedButton(onClick = { page = tab }, modifier = Modifier.weight(1f).semantics { selected = page == tab }, contentPadding = PaddingValues(horizontal = 4.dp, vertical = 10.dp)) { Text(tab.label) } }
        }
        val overview = state.overview
        when (page) {
            GemsPage.GET -> {
                if (!walletPurchasePending && state.enabled && "wallet-keep" in overview?.sources.orEmpty()) PaymentPlate("From your wallet", art = "keep") {
                    Text("Pay with the KEEP in your connected wallet. Review the original quote and network fee before opening your wallet.", color = SurfaceInk.muted)
                    OutlinedButton(onClick = onWalletPurchase, enabled = !state.busy, modifier = Modifier.fillMaxWidth()) { Text("GET GEMS WITH WALLET KEEP") }
                }
                if (overview != null && "ledger-keep" in overview.sources) PaymentPlate("From in-game KEEP", art = "keep") {
                    Text("${fmtN(overview.gemsPerKeep)} Gems per KEEP", style = MaterialTheme.typography.titleMedium, color = SurfaceInk.goldHi)
                    Text("${fmtN(overview.minConvertKeep)}–${fmtN(overview.maxConvertKeepPerTx)} KEEP per request. Uses your in-game balance.", color = SurfaceInk.muted)
                    OutlinedTextField(keep, { keep = it.filter(Char::isDigit).take(32) }, label = { Text("In-game KEEP to spend") }, enabled = enabled, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), modifier = Modifier.fillMaxWidth())
                    Button(onClick = { model.review(IntentKind.GEMS_FROM_KEEP, keep) }, enabled = enabled && positiveGemsInput(keep), modifier = Modifier.fillMaxWidth()) { Text("REVIEW GET GEMS") }
                }
                overview?.tasks?.forEach { task -> PaymentPlate(task.title ?: "Gems reward", art = "gem-32", pill = if (task.claimed) PaymentPill("CLAIMED", PaymentTone.DONE) else null, details = listOf(PaymentDetail("Task", task.id))) {
                    Text("${fmtN(task.gems)} Gems", style = MaterialTheme.typography.titleMedium, color = SurfaceInk.goldHi)
                    OutlinedButton(onClick = { model.review(IntentKind.GEMS_TASK_CLAIM, taskId = task.id) }, enabled = enabled && !task.claimed, modifier = Modifier.fillMaxWidth()) { Text(if (task.claimed) "CLAIMED" else "REVIEW CLAIM") }
                } }
            }
            GemsPage.CONVERT -> PaymentPlate("Gems → SHARDS", art = "shard") {
                overview?.let { Text("${fmtN(it.shardsPerGem)} SHARDS per Gem", style = MaterialTheme.typography.titleMedium, color = SurfaceInk.goldHi) }
                Text("Credits the selected kingdom. This conversion is final and cannot be reversed.", color = SurfaceInk.muted)
                OutlinedTextField(gems, { gems = it.filter(Char::isDigit).take(32) }, label = { Text("Gems to spend") }, enabled = enabled, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), modifier = Modifier.fillMaxWidth())
                Button(onClick = { model.review(IntentKind.GEMS_TO_SHARDS, gems) }, enabled = enabled && positiveGemsInput(gems), modifier = Modifier.fillMaxWidth()) { Text("REVIEW CONVERSION") }
            }
            GemsPage.RECEIPTS -> {
                if (state.pending.isEmpty() && state.receipt == null) Text("No saved Gems requests need checking.", color = SurfaceInk.muted)
                state.pending.forEach { saved -> PaymentPlate(saved.label, pill = gemsSavedPill(saved), details = listOfNotNull(PaymentDetail("Original request", saved.idempotencyKey), saved.baseId?.let { PaymentDetail("Original kingdom", it) })) {
                    Text(if (saved.receipt != null) "Your receipt is saved. Refresh to load the credited balance." else "Keep this original request until its outcome is confirmed.", color = SurfaceInk.muted)
                    OutlinedButton(onClick = { model.check(saved.kind) }, enabled = !state.busy, modifier = Modifier.fillMaxWidth()) { Text("CHECK ORIGINAL RECEIPT") }
                    if (saved.receipt == null) OutlinedButton(onClick = { model.retry(saved.kind) }, enabled = !state.busy, modifier = Modifier.fillMaxWidth()) { Text("RETRY SAME REQUEST") }
                    // Owner 2026-10-06 dead-end audit: the same CLOSE as the Gold Forge seal, once the server answered `unknown` for this key.
                    if (saved.receipt == null && state.serverUnknownKeys[saved.kind] == saved.idempotencyKey)
                        OutlinedButton(onClick = { model.close(saved.kind) }, enabled = !state.busy, modifier = Modifier.fillMaxWidth()) { Text(gg.pixelkingdomwars.nativeclient.ui.Copy.CLOSE_REQUEST.uppercase()) }
                } }
                state.receipt?.let { PaymentPlate("Original receipt", pill = PaymentPill("CONFIRMED", PaymentTone.DONE)) { Text("+${fmtN(it.amount)} ${it.currency}", style = MaterialTheme.typography.titleMedium, color = SurfaceInk.goldHi) } }
            }
        }
        state.unavailable?.let { Text(it, color = SurfaceInk.muted) }
        OutlinedButton(onClick = model::refresh, enabled = !state.busy, modifier = Modifier.fillMaxWidth()) { Text("REFRESH GEMS") }
    }
    state.review?.let { review ->
        val intent = review.intent
        val debit = when (intent.kind) {
            IntentKind.GEMS_FROM_KEEP -> "${fmtN(intent.body.getValue("keep").jsonPrimitive.content)} in-game KEEP"
            IntentKind.GEMS_TO_SHARDS -> "${fmtN(intent.body.getValue("gems").jsonPrimitive.content)} Gems"
            else -> "Task reward"
        }
        AlertDialog(onDismissRequest = model::dismiss, title = { Text(if (intent.kind == IntentKind.GEMS_TASK_CLAIM) "REVIEW REWARD" else "REVIEW CONVERSION") }, text = {
            PaymentPlate("Original terms", art = if (intent.kind == IntentKind.GEMS_TO_SHARDS) "shard" else "gem-32", details = listOfNotNull(PaymentDetail("Wallet", intent.wallet), PaymentDetail("Original request", intent.idempotencyKey), intent.baseId?.let { PaymentDetail("Original destination kingdom", it) })) {
                Text(debit, style = MaterialTheme.typography.titleMedium)
                Text("Receive ${fmtN(review.output)} ${if (intent.kind == IntentKind.GEMS_TO_SHARDS) "SHARDS" else "GEMS"}", style = MaterialTheme.typography.titleLarge, color = SurfaceInk.goldHi)
                Text(if (intent.kind == IntentKind.GEMS_TO_SHARDS) "Destination: ${if (intent.baseId == null) "legacy wallet pool" else "the kingdom saved in this review"}. This cannot be reversed."
                    else if (intent.kind == IntentKind.GEMS_FROM_KEEP) "Spends in-game KEEP. Gems never convert back to KEEP." else "This task reward can be claimed once per account.")
            }
        }, confirmButton = { Button(onClick = { model.confirm(review) }, enabled = !state.busy) { Text("CONFIRM") } },
            dismissButton = { TextButton(onClick = model::dismiss, enabled = !state.busy) { Text("CANCEL") } })
    }
}
private fun positiveGemsInput(value: String) = value.matches(Regex("[1-9][0-9]{0,31}"))
