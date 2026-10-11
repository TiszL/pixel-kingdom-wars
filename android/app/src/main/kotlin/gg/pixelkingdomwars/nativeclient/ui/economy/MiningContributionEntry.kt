package gg.pixelkingdomwars.nativeclient.ui.economy

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import gg.pixelkingdomwars.nativeclient.data.MiningContributionRepository
import gg.pixelkingdomwars.nativeclient.ui.chrome.OutlinedButton
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.awaitCancellation

/** Lazy Gold Forge discovery; an unavailable server cannot hide saved originals. */
@Composable fun MiningContributionEntry(loaded: Result<MiningContributionRepository>, generation: Long, onOpen: () -> Unit) {
    val repository = loaded.getOrNull()
    val state = repository?.state?.collectAsState()?.value
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(repository, lifecycle, generation) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            try { repository?.awaitIdle(); repository?.refresh() }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { /* Original history stays available when discovery fails. */ }
            awaitCancellation()
        }
    }
    if (miningContributionEntryAvailable(state, loaded.isFailure)) {
        val saved = loaded.isFailure || state?.journal?.let { it.operation != null || it.archives.isNotEmpty() } == true
        OutlinedButton(onClick = onOpen, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
            Text(if (saved) "MINING & SAVED CONTRIBUTIONS" else "CONTRIBUTE TO KEEP MINING")
        }
    }
}
