package gg.pixelkingdomwars.nativeclient.ui.economy

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
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
import gg.pixelkingdomwars.nativeclient.ui.chrome.Button
import gg.pixelkingdomwars.nativeclient.ui.chrome.OutlinedButton
import gg.pixelkingdomwars.nativeclient.ui.chrome.LinearProgressIndicator
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import kotlinx.coroutines.awaitCancellation

/** Content for the parent's single scrolling Workshop page. Preview is supplied
 * by the admitted art adapter; this UI has no fallback artwork or admission.
 * Display hints never replace the repository's actual mutation/preflight guards. */
@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable fun BoundCosmeticWorkshopScreen(model: BoundCosmeticWorkshopViewModel, wallet: String,
    selectedBase: String?, generation: Long, actionsAllowed: Boolean, nativeApplicationReady: Boolean,
    completedMarketOutput: (Long) -> String, manageLifecycle: Boolean = true,
    preview: @Composable (BoundCosmeticAppearance, Modifier) -> Unit) {
    val state by model.state.collectAsState(); val notice by model.notice.collectAsState(); val running by model.busy.collectAsState()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val noticeLocation = remember { BringIntoViewRequester() }
    val reviewLocation = remember { BringIntoViewRequester() }
    if (manageLifecycle) {
    DisposableEffect(model, lifecycle) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_STOP) model.dismiss() }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer); model.dismiss() }
    }
    LaunchedEffect(model, lifecycle, wallet, selectedBase, generation, nativeApplicationReady) {
        model.dismiss()
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) { model.foreground(); awaitCancellation() }
    }
    LaunchedEffect(actionsAllowed) { if (!actionsAllowed) { model.dismiss(); model.foreground() } }
    }
    if (state.journal.identity.wallet != wallet) return
    val view = state.view?.takeIf { it.wallet == wallet && it.selectedBase?.baseId == selectedBase }
    val base = view?.selectedBase as? BoundCosmeticSelectedBase.Available
    val busy = running || state.busy
    val operation = state.journal.operation
    val review = state.review?.takeIf { it.command.request.baseId == selectedBase && it.generation == generation }
    LaunchedEffect(notice) { if (notice?.error == true) noticeLocation.bringIntoView() }
    LaunchedEffect(review) { if (review != null) reviewLocation.bringIntoView() }
    BackHandlerAt(BackPriority.CONFIRM, review != null) { model.dismiss() }
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("ARTISAN AWNINGS", style = MaterialTheme.typography.titleLarge, color = Palette.goldHi)
        Text("Craft a permanent account appearance, then choose whether to show it in this kingdom. Awnings do not change gameplay stats.", color = Palette.muted)
        if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
        notice?.let { Text(it.message, Modifier.bringIntoViewRequester(noticeLocation).semantics { liveRegion = LiveRegionMode.Polite }, color = if (it.error) Palette.danger else Palette.text) }
        if (!actionsAllowed) Text("Game orders are paused. Checking originals and completion history remains available.", color = Palette.muted)
        if (review != null) {
            var consent by remember(review) { mutableStateOf(false) }
            val reviewedBase = review.view.selectedBase as? BoundCosmeticSelectedBase.Available
            PaymentPlate("Review permanent craft", modifier = Modifier.bringIntoViewRequester(reviewLocation), details = listOf(PaymentDetail("Producing kingdom", review.command.request.baseId), PaymentDetail("Original request", review.command.key))) {
                Text(awningLabel(review.command.recipe.outputId), style = MaterialTheme.typography.titleMedium, color = Palette.goldHi)
                if (nativeApplicationReady) preview(review.command.appearance, Modifier.fillMaxWidth().heightIn(min = 112.dp))
                else Text("Verified preview is unavailable. Crafting is held.", color = Palette.muted)
                AwningRecipe(review.command.recipe, reviewedBase)
                Text("The listed materials are consumed immediately. This craft cannot be cancelled or refunded. This appearance can be crafted once for this account.", color = Palette.text)
                Text("No SOL, KEEP, Gems or SHARDS payment. Completion is automatic and remains with the original account after a kingdom transfer.", color = Palette.muted)
                if (operation?.attempted == true) Text("This sends the exact saved request again only after checking its original outcome.", color = Palette.muted)
                Row(Modifier.fillMaxWidth()) {
                    Checkbox(consent, { consent = it }, enabled = !busy,
                        modifier = Modifier.sizeIn(minWidth = 48.dp, minHeight = 48.dp).semantics { contentDescription = "Accept permanent consumption of the listed materials" })
                    Text("I agree to consume these materials permanently.", Modifier.weight(1f).padding(top = 10.dp))
                }
                Button(onClick = { model.confirm(review, consent) }, enabled = consent && !busy && actionsAllowed && nativeApplicationReady,
                    modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text(if (operation?.attempted == true) "SEND SAME REQUEST" else "CRAFT AWNING") }
                OutlinedButton(onClick = model::dismiss, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("CANCEL REVIEW · KEEP DRAFT") }
            }
        } else {
            operation?.let { saved ->
                PaymentPlate("Saved request · ${awningRequestStatus(saved)}", details = awningOriginalDetails(saved)) {
                    Text(awningLabel(saved.command.recipe.outputId), style = MaterialTheme.typography.titleMedium, color = Palette.goldHi)
                    Text(when {
                        saved.proof?.completion != null -> "Crafting completed for this account. Return to STYLE to change its appearance."
                        saved.proof != null -> "The start was accepted. Completion is automatic; a timer alone is not a delivery receipt."
                        saved.attempted -> "The request may have been accepted. Check its original receipt before deciding whether to resend."
                        else -> "This draft is saved. Closing this page does not spend materials or erase it."
                    }, color = Palette.muted)
                    OutlinedButton(onClick = { model.check() }, enabled = !busy, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("CHECK ORIGINAL RECEIPT") }
                    if (saved.proof == null) OutlinedButton(onClick = { model.reviewSaved() },
                        enabled = !busy && actionsAllowed && nativeApplicationReady && saved.command.request.baseId == selectedBase,
                        modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text(if (saved.attempted) "REVIEW SAME REQUEST" else "REVIEW SAVED DRAFT") }
                    // Owner rule 2026-10-06: an unknown sent request closes only after archive's fresh check answers "unknown".
                    OutlinedButton(onClick = { model.archive() }, enabled = !busy,
                        modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text(if (saved.proof != null) "MOVE TO HISTORY" else if (saved.attempted) "CHECK & CLOSE IF NOT FOUND" else "ARCHIVE UNUSED DRAFT") }
                }
            }
            val owned = view?.originals?.filter { it.completion != null && it.receipt?.appearance?.outputId?.startsWith("artisan_market_awning_t") == true }.orEmpty()
            if (view == null) Text("Refresh to load account appearances. Saved receipts remain in History.", color = Palette.muted)
            else if (owned.isEmpty()) Text("Completed appearances will appear here. No appearance has been reported as completed for this account.", color = Palette.muted)
            owned.forEach { proof -> val receipt = requireNotNull(proof.receipt)
                PaymentPlate(awningLabel(receipt.recipe.outputId), details = listOf(PaymentDetail("Completed (UTC)", requireNotNull(proof.completion).completedAt))) {
                    if (nativeApplicationReady && receipt.appearance.outputId.startsWith("artisan_market_awning_t")) preview(receipt.appearance, Modifier.fillMaxWidth().heightIn(min = 112.dp))
                    Text("Owned by this account · one craft", color = Palette.muted)
                }
            }
                    if (state.journal.archives.isEmpty()) Text("Archived drafts and accepted originals appear here. They remain available after a kingdom transfer.", color = Palette.muted)
                    state.journal.archives.asReversed().forEach { saved -> PaymentPlate(awningLabel(saved.command.recipe.outputId),
                        pill = PaymentPill(awningRequestStatus(saved), if (saved.proof?.completion != null) PaymentTone.DONE else PaymentTone.OPEN), details = awningOriginalDetails(saved)) {
                        Text(saved.command.recipe.inputs.joinToString(" + ") { "${fmtN(it.quantity)} ${awningMaterialLabel(it.itemId)}" }, color = Palette.muted)
                        Text(if (saved.proof?.completion != null) "The server observed completion. Current kingdom stock is separate from this original receipt."
                            else if (saved.proof != null) "Start accepted. Check its original for automatic completion."
                            else if (saved.closedUnknown) "Closed after the server had no record of it. Checking this original never sends it."
                            else "Unused archived draft. Checking this original never sends it.", color = Palette.muted)
                        OutlinedButton(onClick = { model.checkArchived(saved.command.key) }, enabled = !busy, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("CHECK ORIGINAL RECEIPT") }
                    } }
            OutlinedButton(onClick = { model.refresh() }, enabled = !busy, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("REFRESH APPEARANCES & RECEIPTS") }
        }
    }
}

private fun awningTime(value: String): String = java.time.format.DateTimeFormatter.ofPattern("MMM d, HH:mm 'UTC'")
    .withZone(java.time.ZoneOffset.UTC).format(java.time.Instant.parse(value))
private fun awningMaterialLabel(id: String) = id.split('_').joinToString(" ") { it.replaceFirstChar(Char::uppercaseChar) }
@Composable private fun AwningRecipe(recipe: BoundCosmeticRecipe, base: BoundCosmeticSelectedBase.Available?) {
    Text("${fmtDur(recipe.durationSec)} · Requires completed Market level ${recipe.requiredFacility.level}", color = Palette.muted)
    awningMaterials(recipe, base).forEach { material -> Column(Modifier.fillMaxWidth().padding(vertical = 3.dp)) {
        Text(awningMaterialLabel(material.itemId), style = MaterialTheme.typography.titleSmall)
        Text("Need ${fmtN(material.needed)} · Available ${material.available?.let(::fmtN) ?: "unavailable"}", color = Palette.muted)
        if (material.missing != null && material.missing != "0") Text("Missing ${fmtN(material.missing)}", color = Palette.danger)
    } }
}
private fun awningOriginalDetails(op: BoundCosmeticOperation) = listOfNotNull(
    PaymentDetail("Producing kingdom", op.command.request.baseId), PaymentDetail("Original request", op.command.key),
    op.proof?.receipt?.let { PaymentDetail("Started (UTC)", it.startedAt) },
    op.proof?.receipt?.let { PaymentDetail("Ready (UTC)", it.readyAt) },
    op.proof?.completion?.let { PaymentDetail("Completed (UTC)", it.completedAt) })
