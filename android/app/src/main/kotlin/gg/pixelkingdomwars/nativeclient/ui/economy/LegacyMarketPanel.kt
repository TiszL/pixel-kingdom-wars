package gg.pixelkingdomwars.nativeclient.ui.economy

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.data.LegacyMarketState
import gg.pixelkingdomwars.nativeclient.model.marketSol
import gg.pixelkingdomwars.nativeclient.ui.Notice
import gg.pixelkingdomwars.nativeclient.ui.Palette
import gg.pixelkingdomwars.nativeclient.ui.chrome.Button
import gg.pixelkingdomwars.nativeclient.ui.chrome.GameArt
import gg.pixelkingdomwars.nativeclient.ui.chrome.OutlinedButton
import gg.pixelkingdomwars.nativeclient.ui.chrome.TextButton

/** Web marketPurchases.tsx: saved (unsettled) purchases stay visible above the fold; MY TRADE HISTORY is a
 * disclosure plate. `hiddenSaved` is the SHOW row for a locally hidden saved-purchase plate (MarketTradePanel). */
@Composable internal fun LegacyMarketPanel(model: MarketTradeViewModel, state: LegacyMarketState,
    tradeBusy: Boolean, itemName: (String) -> String, hiddenSaved: (@Composable () -> Unit)? = null) {
    val busy = state.busy || tradeBusy
    var historyOpen by remember(model) { mutableStateOf(false) }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        state.pendingError?.let {
            DismissableNotice("Saved purchases could not be loaded: $it", true)
            OutlinedButton(onClick = model::refreshLegacy, enabled = !busy, modifier = Modifier.fillMaxWidth()) { Text("RELOAD SAVED PURCHASES") }
        }
        state.page?.purchases.orEmpty().forEach { purchase ->
            key(purchase.listingId, purchase.reference) {
                TitledPlate("ORIGINAL PURCHASE · ${itemName(purchase.itemId).uppercase()}", art = "sol", note = "NEEDS CHECKING") {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                        GameArt("sol", Modifier.size(14.dp)); Text("${marketSol(purchase.priceLamports)} SOL", style = MaterialTheme.typography.titleSmall, color = Palette.goldHi)
                        Text("· payment status needs checking", style = MaterialTheme.typography.bodySmall, color = Palette.muted)
                    }
                    Text("Receiving inventory: ${purchase.buyerBaseId?.let { "Land Deed $it" } ?: "Wallet inventory"}", style = MaterialTheme.typography.bodySmall, color = Palette.muted)
                    var details by remember { mutableStateOf(false) }
                    TextButton(onClick = { details = !details }) { Text(if (details) "HIDE PAYMENT REFERENCE" else "ORIGINAL PAYMENT REFERENCE") }
                    if (details) SelectionContainer { Text(purchase.reference, style = MaterialTheme.typography.labelSmall, color = Palette.textFaint) }
                    Button(onClick = { model.checkLegacy(purchase) }, enabled = !busy && state.fresh, modifier = Modifier.fillMaxWidth()) { Text("CHECK ORIGINAL PAYMENT") }
                }
            }
        }
        if (state.after != null || state.page?.next != null) Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (state.after != null) TextButton(onClick = { model.legacyPage(null) }, enabled = !busy) { Text("FIRST SAVED PURCHASES") }
            state.page?.next?.let { next -> TextButton(onClick = { model.legacyPage(next) }, enabled = !busy && state.fresh) { Text("MORE SAVED PURCHASES") } }
        }
        state.notice?.let { DismissableNotice(it, false) }
        DisclosurePlate("SAVED PURCHASES & TRADE HISTORY", historyOpen, { historyOpen = !historyOpen }) {
            hiddenSaved?.invoke()
            state.historyError?.let { Notice("Trade history unavailable: $it", true) }
            TextButton(onClick = model::refreshLegacy, enabled = !busy) { Text("RELOAD HISTORY") }
            if (state.history?.trades?.isEmpty() == true && hiddenSaved == null) EmptyPlate("NO COMPLETED ITEM TRADES.")
            state.history?.trades.orEmpty().forEach { trade ->
                TitledPlate("${trade.role.uppercase()} · ${itemName(trade.itemId).uppercase()}", art = if (trade.role == "bought") "bag" else "sol") {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                        GameArt("sol", Modifier.size(14.dp)); Text("${marketSol(trade.priceLamports)} SOL", style = MaterialTheme.typography.titleSmall, color = Palette.goldHi)
                        trade.settledAt?.let { Text("· $it", style = MaterialTheme.typography.labelSmall, color = Palette.textFaint) }
                    }
                    SelectionContainer { Text("Transaction: ${trade.txSignature}", style = MaterialTheme.typography.labelSmall, color = Palette.textFaint) }
                }
            }
            if (state.history?.hasMore == true) Text("Showing the latest 50 completed trades.", style = MaterialTheme.typography.labelSmall, color = Palette.textFaint)
        }
    }
}
