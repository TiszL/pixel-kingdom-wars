package gg.pixelkingdomwars.nativeclient.ui.kingdom

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import gg.pixelkingdomwars.nativeclient.data.CandidateExpansionRepository
import gg.pixelkingdomwars.nativeclient.ui.ScreenViewModel
import gg.pixelkingdomwars.nativeclient.ui.chrome.*

class CandidateExpansionViewModel(private val repository: CandidateExpansionRepository) : ScreenViewModel() {
    val state = repository.state
    fun open(baseId: String) = run { repository.open(baseId) }
    fun create(baseId: String) = run { repository.create(baseId) }
    fun check() = run { repository.check() }
    fun retry() = run { repository.retryQuote() }
    fun confirm() = run { repository.confirm() }
    fun cancel() = run { repository.cancel() }
    fun finish(onFinished: () -> Unit) = run {
        repository.finish()
        if (state.value.loaded && state.value.saved == null && state.value.error == null) onFinished()
    }
    fun dismiss() = repository.dismiss()
}

@Composable fun CandidateExpansionScreen(model: CandidateExpansionViewModel, baseId: String, onBack: () -> Unit) {
    val state by model.state.collectAsState(); val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(model, baseId, lifecycle) { lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) { model.open(baseId) } }
    DisposableEffect(model) { onDispose { model.dismiss() } }
    var details by remember { mutableStateOf(false) }
    val back = { model.dismiss(); onBack() }
    DesignedPage("Expand your kingdom", back) {
        Text("Private test kingdom", style = MaterialTheme.typography.labelLarge)
        Text("Try the next expansion. No SOL is charged and no wallet approval is needed.")
        if (state.busy) Text("Checking your expansion…", style = MaterialTheme.typography.bodySmall)
        val saved = state.saved; val quote = saved?.state?.quote; val status = saved?.state?.status
        when {
            saved == null -> {
                Button(onClick = { model.create(baseId) }, enabled = state.loaded && state.available && !state.busy,
                    modifier = Modifier.fillMaxWidth()) { Text("Review next expansion") }
                if (!state.available && !state.busy) Text("Select your prepared test base, then check availability.")
                OutlinedButton(onClick = { model.open(baseId) }, enabled = !state.busy) { Text("Check availability") }
            }
            status == "granted" -> {
                Text("Kingdom expanded", style = MaterialTheme.typography.headlineSmall)
                Text("${quote?.toTiles} × ${quote?.toTiles} buildable tiles", style = MaterialTheme.typography.titleLarge)
                Text("Test expansion complete · 0 SOL charged")
                state.refreshError?.let { Text(it) }
                OutlinedButton(onClick = { model.check() }, enabled = !state.busy) { Text("Refresh original base") }
                Button(onClick = { model.finish(back) }, enabled = state.hydrated && !state.busy) { Text("Done") }
            }
            status == "cancelled" -> {
                Text("Expansion cancelled. Your claim is unchanged.")
                Button(onClick = { model.finish(back) }, enabled = !state.busy) { Text("Done") }
            }
            quote != null -> {
                Card(Modifier.fillMaxWidth()) { Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("${quote.fromTiles} × ${quote.fromTiles}  →  ${quote.toTiles} × ${quote.toTiles}", style = MaterialTheme.typography.headlineSmall)
                    Text("Buildable tiles · Keep level ${quote.keepLevel}")
                    Text("Reference price: ${basePurchaseSol(quote.referencePrice)} SOL")
                    Text("Your test cost: 0 SOL", style = MaterialTheme.typography.titleLarge)
                } }
                if (saved.confirmedHash != null) Text("An original confirmation is saved. Check its outcome before retrying.")
                Button(onClick = { model.confirm() }, enabled = !state.busy && state.loaded, modifier = Modifier.fillMaxWidth()) {
                    Text(if (saved.confirmedHash != null) "Retry original confirmation" else "Expand test base · free")
                }
                OutlinedButton(onClick = { model.check() }, enabled = !state.busy) { Text("Check original request") }
                OutlinedButton(onClick = { model.cancel() }, enabled = !state.busy) { Text("Cancel expansion") }
            }
            else -> {
                Text("Your expansion request is saved. Check for its original quote before continuing.")
                OutlinedButton(onClick = { model.check() }, enabled = !state.busy) { Text("Check original request") }
                Button(onClick = { model.retry() }, enabled = !state.busy && state.loaded) { Text("Retry original quote") }
                OutlinedButton(onClick = { model.cancel() }, enabled = !state.busy) { Text("Cancel expansion") }
                // Dead-end audit 2026-10-06: the repository finishes an unquoted request only after its own by-key read in the
                // same action answers `unquoted` for this key (CandidateExpansionRepository.finish); otherwise it refuses.
                if (saved.confirmedHash == null) OutlinedButton(onClick = { model.finish(back) }, enabled = !state.busy) { Text("Done") }
            }
        }
        state.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        if (saved != null) {
            TextButton(onClick = { details = !details }) { Text(if (details) "Hide expansion details" else "Expansion details") }
            if (details) SelectionContainer { Text("Original base: ${saved.request.baseId}\nRequest: ${saved.request.key}\nStatus: ${status ?: "saved"}", style = MaterialTheme.typography.bodySmall) }
        }
    }
}
