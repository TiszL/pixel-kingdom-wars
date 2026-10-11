package gg.pixelkingdomwars.nativeclient.ui.economy

import gg.pixelkingdomwars.nativeclient.data.HarvesterRepository
import gg.pixelkingdomwars.nativeclient.data.HarvesterReview
import gg.pixelkingdomwars.nativeclient.data.HarvesterState
import gg.pixelkingdomwars.nativeclient.ui.ScreenViewModel
import kotlinx.coroutines.Job

fun harvesterEntryAvailable(state: HarvesterState?, storageUnavailable: Boolean = false): Boolean =
    storageUnavailable || state?.let { it.advertised || it.journal.operation != null || it.journal.archives.isNotEmpty() } == true

/** Foreground observes original automatic earnings; only reviewed confirmation selects a source. */
class HarvesterViewModel(private val repository: HarvesterRepository) : ScreenViewModel() {
    val state = repository.state
    private var lastAction: Job? = null
    private fun action(block: suspend () -> Unit): Job? = run(block).also { if (it != null) lastAction = it }
    suspend fun foreground() { lastAction?.join(); refresh()?.join() }
    fun refresh() = action {
        repository.awaitIdle()
        state.value.journal.archives.filter { it.operation.proof != null && it.operation.proof?.settlement?.closure == null }
            .forEach { repository.checkArchived(it.operation.command.key) }
        repository.refresh()
    }
    fun start(harvesterId: String) = action { repository.reviewSelection(harvesterId) }
    fun reviewSaved() = action { repository.reviewSaved() }
    fun confirm(review: HarvesterReview) = action { repository.confirm(review) }
    fun check() = action { repository.check() }
    fun checkArchived(key: String) = action { repository.checkArchived(key) }
    fun archiveUnusedOrRefused() = action { repository.archiveDraftOrRefusal() }
    fun finish() = action { repository.finish(); notify("Original source archived. Earning observations remain available in history.") }
    fun dismiss() = repository.dismiss()
}
