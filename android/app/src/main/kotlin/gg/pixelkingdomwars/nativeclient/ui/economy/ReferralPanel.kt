package gg.pixelkingdomwars.nativeclient.ui.economy

import gg.pixelkingdomwars.nativeclient.ui.chrome.SurfaceInk
import gg.pixelkingdomwars.nativeclient.ui.chrome.Button
import gg.pixelkingdomwars.nativeclient.ui.chrome.OutlinedButton
import gg.pixelkingdomwars.nativeclient.ui.chrome.TextButton
import gg.pixelkingdomwars.nativeclient.ui.Palette
import gg.pixelkingdomwars.nativeclient.ui.chrome.AlertDialog
import gg.pixelkingdomwars.nativeclient.ui.chrome.OutlinedTextField
import gg.pixelkingdomwars.nativeclient.ui.chrome.LinearProgressIndicator

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import gg.pixelkingdomwars.nativeclient.ui.chrome.GameArt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import kotlinx.coroutines.awaitCancellation

@Composable fun ReferralPanel(model: ReferralViewModel, wallet: String) {
    val state by model.state.collectAsState()
    val notice by model.notice.collectAsState()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var code by rememberSaveable(wallet) { mutableStateOf("") }
    BackHandlerAt(BackPriority.CONFIRM, state.review != null, model::dismiss)
    DisposableEffect(model, lifecycle) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_PAUSE) model.dismiss() }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer); model.dismiss() }
    }
    LaunchedEffect(model, lifecycle) { lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) { model.foreground(); awaitCancellation() } }
    TitledPlate("USE A REFERRAL CODE", art = "referral") {
        if (state.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
        state.error?.let { DismissableNotice(it, true) }
        notice?.let { DismissableNotice(it.message, it.error, model::dismissNotice) }
        if (state.loaded && !state.supported) Text("Referral entry and recovery will become available with the server update.", style = MaterialTheme.typography.bodySmall, color = SurfaceInk.muted)
        val saved = state.saved
        saved?.relationship?.let { relationship ->
            Text(when (saved.outcome) {
                "applied" -> "The server applied ${saved.code}."
                "already_applied" -> "The server confirmed ${saved.code} was already applied."
                "already_bound" -> "This wallet was already referred. ${saved.code} did not change its attribution."
                else -> "The server confirmed this wallet's existing referral relationship. This observation does not identify which submitted code created it."
            }, style = MaterialTheme.typography.bodySmall)
            SelectionContainer { Text("Referrer: ${relationship.referrer}\nRelationship: ${relationship.id}", style = MaterialTheme.typography.labelSmall, color = SurfaceInk.faint) }
            Text("Recorded ${relationship.createdAt}. Referral attribution cannot be changed later.", style = MaterialTheme.typography.bodySmall, color = SurfaceInk.muted)
            saved.code?.let { OutlinedButton(onClick = { model.finish() }, enabled = !state.busy, modifier = Modifier.fillMaxWidth()) { Text("FINISH REVIEW") } }
        }
        if (saved?.code != null && saved.relationship == null) {
            SelectionContainer { Text("Saved code: ${saved.code}", style = MaterialTheme.typography.bodySmall) }
            Text("The response is unresolved. An empty status does not prove the code failed. Check status or explicitly retry this same code.", style = MaterialTheme.typography.bodySmall, color = SurfaceInk.muted)
            OutlinedButton(onClick = { model.retry() }, enabled = state.supported && !state.busy, modifier = Modifier.fillMaxWidth()) { Text("RETRY ${saved.code}") }
            Text("If the server shows no referral for this wallet, CLOSE checks once more and removes the saved code so you can enter another.", style = MaterialTheme.typography.bodySmall, color = SurfaceInk.muted)
            OutlinedButton(onClick = { model.close() }, enabled = state.supported && !state.busy, modifier = Modifier.fillMaxWidth()) { Text("CLOSE SAVED CODE") }
        }
        if (state.canEnter) {
            OutlinedTextField(value = code, onValueChange = { code = it }, label = { Text("REFERRAL CODE") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                leadingIcon = { GameArt("referral", Modifier.size(18.dp)) })
            Button(onClick = { model.review(code) }, enabled = code.isNotBlank(), modifier = Modifier.fillMaxWidth()) { Text("REVIEW REFERRAL") }
        }
        TextButton(onClick = { model.refresh() }, enabled = !state.busy) { Text("CHECK REFERRAL STATUS") }
    }
    state.review?.let { review -> AlertDialog(onDismissRequest = model::dismiss,
        title = { Text("Use ${review.code}?") },
        text = { Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            SelectionContainer { Text("Wallet: $wallet") }
            Text("Referral attribution cannot be changed later. The server decides whether this code is eligible. Qualification and mining bonuses follow the existing game rules.")
        } },
        confirmButton = { TextButton(onClick = { model.confirm(review) }, enabled = !state.busy && state.supported) { Text("Confirm referral") } },
        dismissButton = { TextButton(onClick = model::dismiss) { Text("Back") } }) }
}
