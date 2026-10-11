package gg.pixelkingdomwars.nativeclient.ui.economy

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.material3.Checkbox
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.*
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import gg.pixelkingdomwars.nativeclient.boundcosmetics.*
import gg.pixelkingdomwars.nativeclient.network.fmtDur
import gg.pixelkingdomwars.nativeclient.network.fmtN
import gg.pixelkingdomwars.nativeclient.ui.Palette
import gg.pixelkingdomwars.nativeclient.ui.chrome.*
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import kotlinx.coroutines.awaitCancellation

/** One source-aware account page. A delivered preview is not fleet application admission. */
@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable fun BoundCosmeticWakeWorkshopScreen(model: BoundCosmeticWakeWorkshopViewModel, wallet: String,
    selectedBase: String?, generation: Long, mutationsAllowed: Boolean, nativeApplicationReady: Boolean = false,
    manageLifecycle: Boolean = true,
    sourcePreview: @Composable (BoundCosmeticAppearance, Modifier) -> Unit = { _, modifier ->
        Text("Aurora source preview is unavailable in this client.", modifier, color = Palette.muted)
    }) {
    val state by model.state.collectAsState(); val notice by model.notice.collectAsState(); val running by model.busy.collectAsState()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val noticeLocation = remember { BringIntoViewRequester() }; val reviewLocation = remember { BringIntoViewRequester() }
    if (manageLifecycle) {
    DisposableEffect(model, lifecycle) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_STOP) model.dismiss() }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer); model.dismiss() }
    }
    LaunchedEffect(model, lifecycle, wallet, selectedBase, generation, nativeApplicationReady) {
        // The foreground job waits for an existing account action instead of invalidating Off.
        model.invalidateAdmission()
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) { model.foreground(); awaitCancellation() }
    }
    LaunchedEffect(mutationsAllowed) { if (!mutationsAllowed) { model.dismiss(); model.foreground() } }
    }
    if (state.journal.identity.wallet != wallet) return
    val view = state.view?.takeIf { it.wallet == wallet && it.selectedBase?.baseId == selectedBase }
    val base = view?.selectedBase as? BoundCosmeticWakeSelectedBase.Available
    val preference = state.preference; val busy = running || state.busy
    val operation = state.journal.operation
    val review = state.review?.takeIf { it.command.request.baseId == selectedBase && it.generation == generation }
    LaunchedEffect(notice) { if (notice?.error == true) noticeLocation.bringIntoView() }
    LaunchedEffect(review) { if (review != null) reviewLocation.bringIntoView() }
    BackHandlerAt(BackPriority.CONFIRM, review != null) { model.invalidateAdmission() }
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("AURORA WAKE", style = MaterialTheme.typography.titleLarge, color = Palette.goldHi)
        Text("A permanent fleet appearance for your account. Each expedition keeps the choice saved when it departed.", color = Palette.muted)
        val sourceAppearance = view?.recipe?.appearance ?: state.original?.receipt?.appearance
            ?: state.journal.operation?.command?.appearance ?: state.journal.archives.firstOrNull()?.command?.appearance
        sourceAppearance?.let { appearance -> PaymentPlate("Appearance preview") {
            sourcePreview(appearance, Modifier.fillMaxWidth().heightIn(min = 112.dp))
            Text("Source appearance only. Fleet animation is not available in this client yet.", color = Palette.muted)
        } }
        if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
        notice?.let { Text(it.message, Modifier.bringIntoViewRequester(noticeLocation).semantics { liveRegion = LiveRegionMode.Polite }, color = if (it.error) Palette.danger else Palette.text) }
        if (!nativeApplicationReady || !state.accountApplicationReady) PaymentPlate("Appearance unavailable in this client") {
            Text("New Aurora crafts and switching on are held. Your account setting and original receipts remain available.", color = Palette.muted)
        }
        if (review != null) {
            var consent by remember(review) { mutableStateOf(false) }
            PaymentPlate("Review permanent craft", modifier = Modifier.bringIntoViewRequester(reviewLocation), details = wakeDetails(operation)) {
                WakeRecipe(review.command.recipe, review.view.selectedBase as? BoundCosmeticWakeSelectedBase.Available)
                Text("These materials are consumed when crafting starts. This cannot be cancelled or refunded. The appearance remains with your account after a kingdom transfer.", color = Palette.text)
                Text("No SOL, KEEP, SHARDS or Gems payment. No fleet or reward advantage.", color = Palette.muted)
                if (operation?.attempted == true) Text("This explicitly sends the same saved request again.", color = Palette.muted)
                Row(Modifier.fillMaxWidth()) {
                    Checkbox(consent, { consent = it }, enabled = !busy, modifier = Modifier.sizeIn(minWidth = 48.dp, minHeight = 48.dp)
                        .semantics { contentDescription = "Accept permanent consumption of the listed Aurora materials" })
                    Text("I agree to consume these materials permanently.", Modifier.weight(1f).padding(top = 10.dp))
                }
                Button(onClick = { model.confirm(review, consent) }, enabled = consent && !busy && mutationsAllowed && nativeApplicationReady,
                    modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text(if (operation?.attempted == true) "SEND SAME REQUEST" else "CRAFT AURORA") }
                OutlinedButton(onClick = model::invalidateAdmission, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("CANCEL REVIEW · KEEP DRAFT") }
            }
        } else {
            operation?.let { saved -> PaymentPlate("Saved Aurora · ${awningRequestStatus(saved)}", details = wakeDetails(saved)) {
                Text(when { saved.proof?.completion != null -> "Your account owns this appearance."
                    saved.proof != null -> "Your original craft is accepted. Refresh to observe automatic completion."
                    saved.attempted -> "The craft may already have started. Check its original receipt before explicitly resending."
                    else -> "Your exact recipe and original kingdom are saved. Nothing is consumed until you confirm." }, color = Palette.muted)
                OutlinedButton(onClick = { model.check() }, enabled = !busy, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("CHECK ORIGINAL RECEIPT") }
                if (saved.proof == null) OutlinedButton(onClick = { model.reviewSaved() }, enabled = !busy && mutationsAllowed && nativeApplicationReady && saved.command.request.baseId == selectedBase,
                    modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("REVIEW SAME REQUEST") }
                // Owner rule 2026-10-06: an unknown sent request closes only after archive's fresh check answers "unknown".
                OutlinedButton(onClick = { model.archive() }, enabled = !busy,
                    modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text(if (saved.proof != null) "SAVE TO HISTORY" else if (saved.attempted) "CHECK & CLOSE IF NOT FOUND" else "ARCHIVE UNSENT DRAFT") }
            } }
        }
        val proofs = wakeHistory(state)
        proofs.forEach { proof -> PaymentPlate("Aurora Wake", pill = PaymentPill(if (proof.completion != null) "OWNED" else "CRAFTING", if (proof.completion != null) PaymentTone.DONE else PaymentTone.OPEN),
            details = listOfNotNull(PaymentDetail("Original request", proof.idempotencyKey), proof.receipt?.let { PaymentDetail("Producing kingdom", it.request.baseId) }, proof.completion?.let { PaymentDetail("Completed (UTC)", it.completedAt) })) {
            Text(if (proof.completion != null) "Completed · stays with your account" else "Accepted · refresh to check completion", color = Palette.muted)
            if (state.journal.archives.any { it.command.key == proof.idempotencyKey }) OutlinedButton(onClick = { model.checkArchived(proof.idempotencyKey) }, enabled = !busy,
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("CHECK ORIGINAL RECEIPT") }
        } }
        OutlinedButton(onClick = { model.refresh() }, enabled = !busy, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("REFRESH WORKSHOP & RECEIPTS") }
    }
}

private fun wakeDetails(op: BoundCosmeticOperation?) = listOfNotNull(op?.let { PaymentDetail("Original request", it.command.key) }, op?.let { PaymentDetail("Producing kingdom", it.command.request.baseId) })
@Composable private fun WakeRecipe(recipe: BoundCosmeticRecipe, base: BoundCosmeticWakeSelectedBase.Available?) {
    Text("${fmtDur(recipe.durationSec)} · permanent account appearance", color = Palette.muted)
    recipe.inputs.forEach { input ->
        val available = base?.craftingStock?.singleOrNull { it.itemId == input.itemId }?.available
        val missing = available?.let { (input.quantity.toBigInteger() - it.toBigInteger()).max(java.math.BigInteger.ZERO) }
        Column(Modifier.fillMaxWidth().padding(vertical = 3.dp)) {
            Text(input.itemId.split('_').joinToString(" ") { it.replaceFirstChar(Char::uppercaseChar) }, style = MaterialTheme.typography.titleSmall)
            Text("Need ${fmtN(input.quantity)} · Available ${available?.let(::fmtN) ?: "unavailable"}", color = Palette.muted)
            if (missing != null && missing.signum() > 0) Text("Missing ${fmtN(missing.toString())}", color = Palette.danger)
        }
    }
}
