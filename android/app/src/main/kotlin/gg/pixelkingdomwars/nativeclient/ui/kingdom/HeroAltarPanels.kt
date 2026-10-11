package gg.pixelkingdomwars.nativeclient.ui.kingdom

import gg.pixelkingdomwars.nativeclient.ui.chrome.Button
import gg.pixelkingdomwars.nativeclient.ui.chrome.TextButton
import gg.pixelkingdomwars.nativeclient.ui.chrome.AlertDialog
import gg.pixelkingdomwars.nativeclient.ui.chrome.PixelPanel
import gg.pixelkingdomwars.nativeclient.ui.chrome.GameArt
import gg.pixelkingdomwars.nativeclient.ui.chrome.Card

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import gg.pixelkingdomwars.nativeclient.ui.chrome.CloseButton
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.sp
import gg.pixelkingdomwars.nativeclient.ui.Palette
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.data.HeroAltarOffer
import gg.pixelkingdomwars.nativeclient.data.HeroAltarReview
import gg.pixelkingdomwars.nativeclient.data.HeroRecruitmentState
import gg.pixelkingdomwars.nativeclient.network.fmtN
import gg.pixelkingdomwars.nativeclient.network.fmtDur
import gg.pixelkingdomwars.nativeclient.network.trayLabel
import gg.pixelkingdomwars.nativeclient.network.string

internal fun HeroAltarOffer.priceLabel() = if (contracts > 0) "Uses 1 hero contract · no KEEP"
    else "Up to ${fmtN(definition.costKeep)} KEEP, or 1 hero contract if available"

@Composable internal fun HeroBuildMenu(state: HeroRecruitmentState, busy: Boolean, onPick: (String) -> Unit,
    onRefresh: () -> Unit, onBuildings: () -> Unit, onClose: () -> Unit) {
    // The build selector is an inline tray; HeroAltarConfirm below remains a real consent dialog.
    PixelPanel(Modifier.fillMaxWidth()) {
        Row(Modifier.fillMaxWidth().background(Palette.ink).padding(horizontal = 8.dp, vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = onBuildings) { Text("‹ BUILD", fontSize = 16.sp) }
            Text("HERO ALTARS", Modifier.weight(1f), color = Palette.gold, fontSize = 21.sp)
            TextButton(onClick = onClose, modifier = Modifier.size(44.dp).semantics { contentDescription = "Close hero altars" }, contentPadding = PaddingValues(10.dp)) {
                GameArt("close", Modifier.size(20.dp))
            }
        }
        Column(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()).padding(10.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            if (!state.supported) Text("Hero recruitment is unavailable on this server until recovery support is released. Saved receipts remain available.", style = MaterialTheme.typography.bodySmall, color = Palette.muted)
            else if (!state.enabled) Text("New hero recruitment is currently unavailable. Saved receipts remain available.", style = MaterialTheme.typography.bodySmall, color = Palette.muted)
            state.offers.forEach { offer ->
                val base = state.base; val definition = offer.definition
                val exists = offer.recruited || base?.buildings?.any { it.type == definition.type } == true
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                            GameArt(if (definition.type == "heroaltar") "hero_vex_portrait" else "hero_theo_portrait", Modifier.size(64.dp))
                            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                                Text(definition.name.uppercase(), color = Palette.gold, style = MaterialTheme.typography.titleLarge)
                                Text(trayLabel(definition.type), color = Palette.muted, style = MaterialTheme.typography.labelSmall)
                                if (exists) Text("✓ ALREADY PLACED", color = Palette.goldHi, fontSize = 16.sp)
                            }
                        }
                        if (exists) {
                            Text("This hero's altar is already in your kingdom.", style = MaterialTheme.typography.bodySmall, color = Palette.muted)
                        } else {
                            Text(offer.priceLabel(), color = Palette.goldHi, style = MaterialTheme.typography.bodyMedium)
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                                GameArt("timer", Modifier.size(16.dp))
                                Text("${fmtDur(definition.buildSec.toLong())} · Keep level ${definition.keepLevel} · one altar per base", style = MaterialTheme.typography.bodySmall, color = Palette.muted)
                            }
                            when {
                                base != null && base.player.keepLevel < definition.keepLevel -> Text("Requires Keep level ${definition.keepLevel}.", style = MaterialTheme.typography.bodySmall, color = Palette.gold)
                                base?.freeBuilders == 0 -> Text("Your builder is busy. Open the active job or wait.", style = MaterialTheme.typography.bodySmall, color = Palette.muted)
                            }
                            Button(onClick = { onPick(definition.type) }, modifier = Modifier.fillMaxWidth(), enabled = state.supported && state.enabled && !busy && state.pending == null
                                && base != null && base.player.keepLevel >= definition.keepLevel && base.freeBuilders > 0) {
                                Text("CHOOSE ALTAR LOCATION", fontSize = 18.sp)
                            }
                        }
                    }
                }
            }
        }
        TextButton(onClick = onRefresh, enabled = !busy, modifier = Modifier.fillMaxWidth().padding(8.dp)) {
            Text("REFRESH HERO CONTRACTS", fontSize = 16.sp)
        }
    }
}

@Composable internal fun HeroAltarConfirm(review: HeroAltarReview, busy: Boolean, onConfirm: () -> Unit, onCancel: () -> Unit) {
    // Owner 2026-10-06 (no old dark dialog on Home): the kit confirm with the same words, the same guard and the same owners.
    KingdomConfirmDialog(KingdomConfirmUi("Place ${review.offer.definition.name}'s altar?".uppercase(), listOf(
        "Tile ${review.tx}, ${review.ty}. A builder constructs the altar; the hero becomes available when the server completes that job.",
        if (review.offer.contracts > 0) "If the contract disappears, this request will refuse. It cannot charge KEEP."
        else "The server uses an available prepaid hero contract first. Otherwise it may charge up to the reviewed KEEP amount."),
        confirmLabel = "CONFIRM PLACEMENT", backLabel = "BACK", emphasis = review.offer.priceLabel(), confirmEnabled = !busy),
        onConfirm = onConfirm, onBack = onCancel) {
        GameArt(if (review.offer.definition.type == "heroaltar") "hero_vex_portrait" else "hero_theo_portrait", Modifier.size(56.dp))
    }
}

/** A saved hero altar request or its receipt. Owner 2026-10-06: drawn on the kit herald plate ([RecoveryPlate]) instead of
 *  the old dark card; the same words, the same two owner callbacks, and the same rule that a saved pending intent is never
 *  closed by an X (money path); only a resolved receipt can be put away. */
@Composable internal fun HeroRecruitmentHistory(state: HeroRecruitmentState, busy: Boolean, onRefresh: () -> Unit, onRetry: () -> Unit,
    /** Owner 2026-10-06: the owner's CLOSE (HeroRecruitmentRepository.close), drawn only after the server answered `unknown`
     *  for this saved key; it reads the receipt once more and forgets the request on this device only then. Never an X. */
    onClose: (() -> Unit)? = null) {
    val serverUnknown = state.pending?.let { it.receipt == null && it.idempotencyKey == state.serverUnknownKey } == true
    if (state.pending == null && state.receipt == null) return
    var hidden by remember(state.receipt?.jobId, state.pending?.idempotencyKey) { mutableStateOf(false) }
    if (hidden && state.pending == null) return
    val pending = state.pending
    val receipt = state.receipt
    val lines = buildList {
        if (pending != null) {
            add("Original altar: ${pending.body.string("type")} at ${pending.body.string("tx")}, ${pending.body.string("ty")}")
            add(if (pending.body.string("heroContractOnly") == "true") "Original consent: 1 hero contract, no KEEP."
                else "Original consent: up to ${pending.body.string("maxCostKeep")} KEEP, or 1 available hero contract.")
            add(if (pending.receipt == null) "Placement is unconfirmed. Check the saved request before another recruitment." else "Placement is accepted. Refresh its original base to finish recovery.")
            if (serverUnknown) gg.pixelkingdomwars.nativeclient.ui.Copy.observation(gg.pixelkingdomwars.nativeclient.ops.Receipt.Absent)?.let { add(it) }
        }
        if (receipt != null) {
            add("${receipt.hero} altar placement accepted. This does not prove the construction job has finished.")
            val funding = receipt.funding
            add(if (funding.string("kind") == "contract") "Consumed 1 hero contract. No KEEP charged."
                else "${fmtN(funding.string("amount").orEmpty())} KEEP charged.")
            state.unavailable?.let { add(it) }
        }
    }
    val details = buildList {
        if (pending != null) add("Original request: ${pending.idempotencyKey}\nOriginal base: ${pending.baseId ?: "wallet base"}")
        if (receipt != null) {
            add("Base: ${receipt.request.baseId ?: "original wallet base"}\nBuilding: ${receipt.buildingId}\nJob: ${receipt.jobId}")
            val funding = receipt.funding
            add(if (funding.string("kind") == "contract") "Item use: ${funding.string("itemUseId")}"
                else "Ledger transaction: ${funding.string("ledgerTransactionId")}")
        }
    }
    val actions = buildList {
        if (pending != null) {
            add(RecoveryAction("CHECK ORIGINAL RECEIPT", onRefresh, enabled = !busy, verb = gg.pixelkingdomwars.nativeclient.ui.model.Verb.GOLD,
                spoken = "Check original receipt"))
            if (pending.receipt == null) add(RecoveryAction("RETRY ORIGINAL REQUEST", onRetry, enabled = !busy, spoken = "Retry original request"))
            if (serverUnknown && onClose != null) add(RecoveryAction(gg.pixelkingdomwars.nativeclient.ui.Copy.CLOSE_REQUEST.uppercase(), onClose,
                enabled = !busy, spoken = "Close saved request"))
        }
    }
    RecoveryPlate("HERO ALTAR RECEIPT", lines, actions, Modifier.fillMaxWidth(), details = details,
        onDismiss = if (pending == null) ({ hidden = true }) else null, dismissLabel = "Close")
}
