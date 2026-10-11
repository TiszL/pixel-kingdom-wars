package gg.pixelkingdomwars.nativeclient.ui

import gg.pixelkingdomwars.nativeclient.ui.chrome.Button
import gg.pixelkingdomwars.nativeclient.ui.chrome.OutlinedButton
import gg.pixelkingdomwars.nativeclient.ui.chrome.AlertDialog
import gg.pixelkingdomwars.nativeclient.ui.chrome.Switch

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.network.fmtN

/**
 * "ASK BEFORE SPENDING KEEP" (web `lib/keepConfirm.ts`, player report 2026-08-29): KEEP is the hard currency,
 * so every KEEP speed-up — and the hero upgrade — asks first. Defaults ON; the opt-out stays reversible.
 * A preference that cannot be read fails SAFE: an unreadable value is never "this player opted out".
 */
interface KeepConfirmPreference {
    fun on(): Boolean
    fun set(on: Boolean)
}

/** The web's `skp_confirm_keep` flag: `'0'` is the only opt-out value; anything else (or nothing) asks. */
fun keepConfirmOn(stored: String?): Boolean = stored != "0"

/** Shares the same device preference as building speed-ups and every other KEEP confirmation. */
class DeviceKeepConfirmPreference(private val preferences: gg.pixelkingdomwars.nativeclient.data.DevicePreferences) : KeepConfirmPreference {
    override fun on(): Boolean = preferences.keepConfirm
    override fun set(on: Boolean) { preferences.keepConfirm = on }
}

/** EXACTLY what the button that opened this dialog quoted; [immediate] = false for a purchase that hurries
 * nothing (a hero level is BOUGHT, so "immediately" would imply a slower free route that does not exist). */
data class KeepSpendIntent(val costKeep: String, val what: String, val immediate: Boolean = true, val alwaysReview: Boolean = false, val onConfirm: () -> Unit)

/** One dialog in front of every KEEP spend. `confirm` runs the spend at once when the player opted out;
 * CANCEL posts nothing at all. "DON'T ASK AGAIN" is applied on CONFIRM only — a player who cancels never
 * reached the "again", and disarming the guard on the way out of a refused purchase is the surprise this
 * dialog exists to prevent. */
class KeepSpendConfirmState(private val preference: KeepConfirmPreference) {
    var pending: KeepSpendIntent? by mutableStateOf(null)
        private set
    var optOut: Boolean by mutableStateOf(false)
    fun confirm(intent: KeepSpendIntent) { if (!intent.alwaysReview && !preference.on()) intent.onConfirm() else { optOut = false; pending = intent } }
    fun cancel() { pending = null; optOut = false }
    fun accept() {
        val intent = pending ?: return
        pending = null
        if (optOut && !intent.alwaysReview) preference.set(false)
        optOut = false
        intent.onConfirm()
    }
}

@Composable fun rememberKeepSpendConfirm(preference: KeepConfirmPreference): KeepSpendConfirmState = remember(preference) { KeepSpendConfirmState(preference) }

/** Web `KeepSpendConfirmDialog`: the price unlike a resource cost (token logo, KEEP in words), CONFIRM above
 * the taller full-width CANCEL so an impatient double-tap lands on the safe control. */
@Composable fun KeepSpendConfirmDialog(state: KeepSpendConfirmState) {
    val intent = state.pending ?: return
    val amount = fmtN(intent.costKeep)
    AlertDialog(onDismissRequest = state::cancel, title = { Text("SPEND KEEP?", color = Palette.gold, fontWeight = FontWeight.Bold, modifier = Modifier.fillMaxWidth(), textAlign = TextAlign.Center) },
        text = { Column(verticalArrangement = Arrangement.spacedBy(12.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Column(Modifier.fillMaxWidth().background(Palette.backdrop).border(2.dp, Palette.gold).padding(horizontal = 12.dp, vertical = 10.dp),
                horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(amount, style = MaterialTheme.typography.headlineLarge, color = Palette.gold, textAlign = TextAlign.Center)
                Text("KEEP", style = MaterialTheme.typography.titleMedium, color = Palette.gold)
            }
            Text("SPEND $amount KEEP TO ${intent.what}${if (intent.immediate) " IMMEDIATELY" else ""}?", style = MaterialTheme.typography.titleMedium, textAlign = TextAlign.Center)
            Text("KEEP IS THE HARD CURRENCY — NOT SHARDS.", style = MaterialTheme.typography.labelSmall, color = Palette.muted, textAlign = TextAlign.Center)
            if (!intent.alwaysReview) Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
                Text("DON'T ASK AGAIN", modifier = Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
                Switch(checked = state.optOut, onCheckedChange = { state.optOut = it })
            }
            Button(onClick = state::accept, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("CONFIRM · $amount") }
            OutlinedButton(onClick = state::cancel, modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp)) { Text("CANCEL") }
        } },
        confirmButton = {}, dismissButton = null)
}

/** Web `CancelJobConfirmDialog` (tester request 2026-09-04): a cancel throws away a running timer, so it
 * asks first; the refund quoted is the SERVER's own `refundShards` on the row. The destructive choice sits
 * above; the safe KEEP GOING is the taller bottom target. */
data class CancelJobIntent(val kind: String, val what: String, val refundShards: String, val onConfirm: () -> Unit)

@Composable fun CancelJobConfirmDialog(intent: CancelJobIntent?, onDismiss: () -> Unit) {
    intent ?: return
    val amount = fmtN(intent.refundShards)
    val lane = if (intent.kind == "UPGRADE") "THE BUILDER IS FREED" else "THE ALCHEMY LAB IS FREED"
    AlertDialog(onDismissRequest = onDismiss, title = { Text("CANCEL ${intent.kind}?", color = MaterialTheme.colorScheme.error, fontWeight = FontWeight.Bold, modifier = Modifier.fillMaxWidth(), textAlign = TextAlign.Center) },
        text = { Column(verticalArrangement = Arrangement.spacedBy(12.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Text("STOP ${intent.what}? PROGRESS SO FAR IS LOST.", style = MaterialTheme.typography.titleMedium, textAlign = TextAlign.Center)
            Column(Modifier.fillMaxWidth().background(Palette.backdrop).border(2.dp, Palette.gold).padding(horizontal = 12.dp, vertical = 10.dp),
                horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text("REFUND", style = MaterialTheme.typography.titleMedium, color = Palette.gold)
                Text("+$amount SHARDS", style = MaterialTheme.typography.headlineMedium, color = Palette.gold, textAlign = TextAlign.Center)
            }
            Text("$lane · A PAID FINISH IS NOT REFUNDED", style = MaterialTheme.typography.labelSmall, color = Palette.muted, textAlign = TextAlign.Center)
            OutlinedButton(onClick = { onDismiss(); intent.onConfirm() }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("CANCEL ${intent.kind} · +$amount") }
            Button(onClick = onDismiss, modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp)) { Text("KEEP GOING") }
        } },
        confirmButton = {}, dismissButton = null)
}
