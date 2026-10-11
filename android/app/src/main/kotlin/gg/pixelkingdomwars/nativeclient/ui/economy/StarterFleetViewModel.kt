package gg.pixelkingdomwars.nativeclient.ui.economy

import gg.pixelkingdomwars.nativeclient.data.StarterFleetRepository
import gg.pixelkingdomwars.nativeclient.data.StarterFleetReview
import gg.pixelkingdomwars.nativeclient.data.StarterFleetState
import gg.pixelkingdomwars.nativeclient.ui.ScreenViewModel
import kotlinx.coroutines.Job

/** The entry remains reachable for original recovery even when current discovery disappears. */
fun starterFleetEntryAvailable(state: StarterFleetState?, storageUnavailable: Boolean = false): Boolean =
    storageUnavailable || state?.let { it.advertised || it.journal.operation != null || it.journal.archives.isNotEmpty() } == true

/** Foreground and completion checks only GET. Only an explicit reviewed confirmation may POST. */
class StarterFleetViewModel(private val repository: StarterFleetRepository) : ScreenViewModel() {
    val state = repository.state
    private var lastAction: Job? = null
    private fun action(block: suspend () -> Unit): Job? = run(block).also { if (it != null) lastAction = it }
    suspend fun foreground() { lastAction?.join(); refresh()?.join() }
    fun refresh() = action {
        repository.awaitIdle()
        repository.refresh()
    }
    fun start(berthId: String) = action { repository.reviewInstall(berthId) }
    fun reviewSaved() = action { repository.reviewSaved() }
    fun confirm(review: StarterFleetReview) = action { repository.confirm(review) }
    fun check() = action { repository.check() }
    fun checkArchived(key: String) = action { repository.checkArchived(key) }
    fun archiveUnusedOrRefused() = action { repository.archiveDraftOrRefusal() }
    fun finish() = action { repository.finish(); notify("Original installation receipt archived.") }
    fun dismiss() = repository.dismiss()
}
