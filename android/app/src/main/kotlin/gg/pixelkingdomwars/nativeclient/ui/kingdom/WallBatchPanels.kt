package gg.pixelkingdomwars.nativeclient.ui.kingdom

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import gg.pixelkingdomwars.nativeclient.data.WallBatchState
import gg.pixelkingdomwars.nativeclient.network.fmtN
import gg.pixelkingdomwars.nativeclient.network.string
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import kotlinx.serialization.json.JsonArray

// The wall stroke's draft lines moved to the kit placement band (HomeRecoveryPlates.kt wallStrokeLines / LegacyPlacementBand,
// owner 2026-10-06: no old dark panel on Home); the words are unchanged.

/** Above the land gate: an original receipt remains readable when its deed is unavailable. Owner 2026-10-06: drawn on the
 *  kit herald plate ([RecoveryPlate]) instead of the old dark card; the same words, the same three owner callbacks and the
 *  same X rule (only a resolved receipt can be put away, never a pending batch). */
@Composable internal fun WallBatchHistory(state: WallBatchState, busy: Boolean, onCheck: () -> Unit, onRetry: () -> Unit, onClose: (String) -> Unit,
    /** Owner 2026-10-06: the owner's CLOSE for the saved batch (WallBatchRepository.close), drawn only after the server
     *  answered `unknown` for this saved key; it reads the receipt once more and only then forgets it on this device. */
    onCloseSaved: (() -> Unit)? = null) {
    if (!state.historyVisible) return
    val serverUnknown = state.pending?.let { it.receipt == null && it.idempotencyKey == state.serverUnknownKey } == true
    var expanded by remember(state.receipt?.receiptId) { mutableStateOf(false) }
    val pending = state.pending
    val receipt = state.receipt
    val lines = buildList {
        if (pending != null) {
            add("${(pending.body["tiles"] as? JsonArray)?.size ?: "—"} original wall tiles · up to ${pending.body.string("maxCostShards")} SHARDS")
            add(if (pending.receipt == null) "Placement is unconfirmed. Keep this original batch until its receipt is resolved."
                else "The original batch was accepted. Check its receipt to finish refreshing its original destination.")
            if (!state.supported || !state.enabled) add("New wall strokes are currently unavailable. Checking a saved receipt never places walls.")
            if (serverUnknown) gg.pixelkingdomwars.nativeclient.ui.Copy.observation(gg.pixelkingdomwars.nativeclient.ops.Receipt.Absent)?.let { add(it) }
        }
        if (receipt != null) {
            add("${receipt.request.tiles.size} walls accepted together · ${fmtN(receipt.amount)} SHARDS charged.")
            state.unavailable?.let { add(it) }
            if (expanded) add("This receipt records the original purchase. Walls may have moved or changed ownership since then.")
        }
    }
    val details = buildList {
        if (pending != null) add("Original request: ${pending.idempotencyKey}\nBase: ${pending.baseId ?: "original wallet base"}")
        if (receipt != null && expanded) add("Base: ${receipt.request.baseId ?: "original wallet base"}\nLedger: ${receipt.receiptId}\nAccepted: ${receipt.acceptedAt}")
    }
    val actions = buildList {
        if (pending != null) {
            add(RecoveryAction("CHECK ORIGINAL RECEIPT", onCheck, enabled = !busy, verb = Verb.GOLD, spoken = "Check original receipt"))
            if (pending.receipt == null) add(RecoveryAction("RETRY ORIGINAL BATCH", onRetry, enabled = !busy, spoken = "Retry original batch"))
            if (serverUnknown && onCloseSaved != null) add(RecoveryAction(gg.pixelkingdomwars.nativeclient.ui.Copy.CLOSE_REQUEST.uppercase(), onCloseSaved,
                enabled = !busy, spoken = "Close saved batch"))
        }
        if (receipt != null) add(RecoveryAction(if (expanded) "HIDE RECEIPT DETAILS" else "RECEIPT DETAILS", { expanded = !expanded }))
    }
    RecoveryPlate("WALL BATCH RECEIPT", lines, actions, Modifier.fillMaxWidth(), details = details,
        onDismiss = if (pending == null) receipt?.let { r -> { onClose(r.receiptId) } } else null, dismissLabel = "Close")
}
