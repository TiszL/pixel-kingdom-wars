package gg.pixelkingdomwars.nativeclient.ui.home

import gg.pixelkingdomwars.nativeclient.ui.chrome.TextButton
import gg.pixelkingdomwars.nativeclient.ui.chrome.AlertDialog

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.model.Balances
import gg.pixelkingdomwars.nativeclient.ui.Copy
import gg.pixelkingdomwars.nativeclient.ui.Palette
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import gg.pixelkingdomwars.nativeclient.ui.nav.Gate

/** The funds sheet every `INSUFFICIENT_*` refusal lands on: the server's message, the currency it
 * named, the current server balances and where that currency comes from. Android back closes it. */
@Composable fun FundsSheet(gate: Gate.Funds, balances: Balances?, onKingdom: () -> Unit, onQuests: () -> Unit, onLand: () -> Unit, onEconomy: () -> Unit = onLand, onGems: () -> Unit = onEconomy, gemsPending: Boolean = false, onClose: () -> Unit) {
    val currency = gate.code.removePrefix("INSUFFICIENT_")
    BackHandlerAt(BackPriority.SHEET) { onClose() }
    AlertDialog(onDismissRequest = onClose, title = { Text("${Copy.FUNDS_TITLE}: $currency") }, text = {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(gate.message)
            if (currency == "GEMS" && gemsPending) Text("A saved Gems request needs its original receipt checked. Open Gems to recover it before making another purchase.")
            balances?.let { Text("Your balances: ${it.shards} SHARDS · ${it.keep} KEEP${it.gems?.let { amount -> " · $amount GEMS" } ?: ""}", fontWeight = FontWeight.Bold, color = Palette.gold) }
            Text(when (currency) {
                "SHARDS" -> "Shards come from your mines and from quests. Collect mines in your kingdom or claim a completed objective."
                "GEMS" -> "Gems come from one-way KEEP conversion and available tasks. Gems cannot be withdrawn."
                "KEEP" -> "KEEP is smelted from Shards at the Gold Forge, which opens with your Land Deed."
                "SOL" -> "Add SOL to the wallet you play with, then try again."
                else -> "Top up the named currency, then try again."
            }, style = MaterialTheme.typography.bodySmall)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                when (currency) {
                    "SHARDS" -> { TextButton(onClick = onKingdom) { Text("Collect mines") }; TextButton(onClick = onQuests) { Text("Open quests") } }
                    "GEMS" -> TextButton(onClick = onGems) { Text("Get Gems") }
                    "KEEP", "SOL" -> TextButton(onClick = onEconomy) { Text("Wallet & economy") }
                    else -> {}
                }
            }
        }
    }, confirmButton = { TextButton(onClick = onClose) { Text("Close") } })
}
