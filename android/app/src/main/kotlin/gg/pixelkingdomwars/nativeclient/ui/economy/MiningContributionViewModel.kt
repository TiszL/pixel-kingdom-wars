package gg.pixelkingdomwars.nativeclient.ui.economy

import gg.pixelkingdomwars.nativeclient.data.MiningContributionRepository
import gg.pixelkingdomwars.nativeclient.data.MiningContributionReview
import gg.pixelkingdomwars.nativeclient.data.MiningContributionState
import gg.pixelkingdomwars.nativeclient.ui.ScreenViewModel
import kotlinx.coroutines.Job

/** The entry remains reachable for original recovery even when current discovery disappears. */
fun miningContributionEntryAvailable(state: MiningContributionState?, storageUnavailable: Boolean = false): Boolean =
    storageUnavailable || state?.let { it.advertised || it.journal.operation != null || it.journal.archives.isNotEmpty() } == true

/** Foreground and settlement checks only GET. Only an explicit reviewed confirmation may POST. */
class MiningContributionViewModel(private val repository: MiningContributionRepository) : ScreenViewModel() {
    val state = repository.state
    private var lastAction: Job? = null
    private fun action(block: suspend () -> Unit): Job? = run(block).also { if (it != null) lastAction = it }
    suspend fun foreground() { lastAction?.join(); refresh()?.join() }
    fun refresh() = action {
        repository.awaitIdle()
        // Archived starts can finish while this base is paused, transferred or no longer selected.
        state.value.journal.archives.filter { it.operation.proof != null && it.operation.proof?.settlement == null }
            .forEach { repository.checkArchived(it.operation.command.key) }
        repository.refresh()
    }
    fun start(lines: List<gg.pixelkingdomwars.nativeclient.miningcontribution.MiningContributionLine>) = action {
        repository.reviewStart(lines)
    }
    fun reviewSaved() = action { repository.reviewSaved() }
    fun confirm(review: MiningContributionReview) = action { repository.confirm(review) }
    fun check() = action { repository.check() }
    fun checkArchived(key: String) = action { repository.checkArchived(key) }
    fun archiveUnusedOrRefused() = action { repository.archiveDraftOrRefusal() }
    fun archiveUnknown() = action { repository.archiveUnknown() }
    fun finish() = action { repository.finish(); notify("Original receipt archived. Daily settlement remains available in history.") }
    fun dismiss() = repository.dismiss()
}
