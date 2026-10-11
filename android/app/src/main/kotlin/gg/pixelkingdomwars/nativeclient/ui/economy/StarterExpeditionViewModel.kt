package gg.pixelkingdomwars.nativeclient.ui.economy

import gg.pixelkingdomwars.nativeclient.data.StarterExpeditionRepository
import gg.pixelkingdomwars.nativeclient.data.StarterExpeditionReview
import gg.pixelkingdomwars.nativeclient.data.StarterExpeditionState
import gg.pixelkingdomwars.nativeclient.ui.ScreenViewModel
import kotlinx.coroutines.Job

/** The entry remains reachable for original recovery even when current discovery disappears. */
fun starterExpeditionEntryAvailable(state: StarterExpeditionState?, storageUnavailable: Boolean = false): Boolean =
    storageUnavailable || state?.let { it.advertised || it.journal.operation != null || it.journal.archives.isNotEmpty() } == true

/** Foreground and completion checks only GET. Only an explicit reviewed confirmation may POST. */
class StarterExpeditionViewModel(private val repository: StarterExpeditionRepository) : ScreenViewModel() {
    val state = repository.state
    private var lastAction: Job? = null
    private fun action(block: suspend () -> Unit): Job? = run(block).also { if (it != null) lastAction = it }
    suspend fun foreground() { lastAction?.join(); refresh()?.join() }
    fun refresh() = action {
        repository.awaitIdle()
        // Archived departures can return while this base is paused, transferred or no longer selected.
        state.value.journal.archives.filter { it.operation.proof != null && it.operation.proof?.returned == null }
            .forEach { repository.checkArchived(it.operation.command.key) }
        repository.refresh()
    }
    fun selectPaid(realm: Int) = action { repository.selectPaidRealm(realm) }
    fun startPaid(realm: Int) = action { repository.reviewPaidDeparture(realm) }
    fun start(routeId: String) = action { repository.reviewDeparture(routeId) }
    fun reviewSaved() = action { repository.reviewSaved() }
    fun confirm(review: StarterExpeditionReview) = action { repository.confirm(review) }
    fun check() = action { repository.check() }
    fun checkArchived(key: String) = action { repository.checkArchived(key) }
    fun archiveUnusedOrRefused() = action { repository.archiveDraftOrRefusal() }
    fun finish() = action { repository.finish(); notify("Original receipt archived. Automatic return remains available in history.") }
    fun dismiss() = repository.dismiss()
}
