package gg.pixelkingdomwars.nativeclient.ui.economy

import gg.pixelkingdomwars.nativeclient.boundcosmetics.BoundCosmeticProof
import gg.pixelkingdomwars.nativeclient.data.BoundCosmeticWakeWorkshopRepository
import gg.pixelkingdomwars.nativeclient.data.BoundCosmeticWakeWorkshopReview
import gg.pixelkingdomwars.nativeclient.data.BoundCosmeticWakeWorkshopState
import gg.pixelkingdomwars.nativeclient.network.SessionSupersededException
import gg.pixelkingdomwars.nativeclient.ui.ScreenViewModel
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job

fun wakeWorkshopEntryAvailable(state: BoundCosmeticWakeWorkshopState?, storageUnavailable: Boolean = false): Boolean =
    storageUnavailable || state?.let { it.advertised || it.original != null || it.journal.operation != null || it.journal.archives.isNotEmpty() } == true

/** Foreground observes only. Consent is explicit; account Off survives kingdom changes. */
class BoundCosmeticWakeWorkshopViewModel(private val repository: BoundCosmeticWakeWorkshopRepository) : ScreenViewModel() {
    val state = repository.state
    private var lastAction: Job? = null
    private fun action(block: suspend () -> Unit): Job? = run(block).also { if (it != null) lastAction = it }
    suspend fun foreground() { lastAction?.join(); refresh()?.join() }
    fun refresh() = action {
        repository.awaitIdle()
        var failure: Exception? = null
        suspend fun observe(block: suspend () -> Unit) {
            try { block() } catch (error: Exception) {
                if (error is CancellationException || error is SessionSupersededException) throw error
                if (failure == null) failure = error
            }
        }
        state.value.journal.archives.filter { it.proof != null && it.proof?.completion == null }
            .forEach { observe { repository.checkArchived(it.command.key) } }
        observe { repository.refresh() }
        failure?.let { throw it }
    }
    fun refreshPreference() = action { repository.refreshPreference() }
    fun review() = action { repository.reviewStart() }
    fun reviewSaved() = action { repository.reviewSaved() }
    fun confirm(review: BoundCosmeticWakeWorkshopReview, materialConsent: Boolean) = action {
        check(materialConsent) { "Confirm that the listed materials will be permanently consumed." }
        repository.confirm(review)
    }
    fun check() = action { repository.check() }
    fun checkArchived(key: String) = action { repository.checkArchived(key) }
    fun archive() = action { repository.archive(); notify("Original request saved to History.") }
    fun setPreference(enabled: Boolean) = action { repository.setPreference(enabled) }
    fun invalidateAdmission() = repository.invalidateAdmission()
    fun dismiss() { repository.dismiss(); dismissNotice() }
}

/** A stale current view must not hide a completed original recovered independently. */
internal fun wakeHistory(state: BoundCosmeticWakeWorkshopState): List<BoundCosmeticProof> =
    (listOfNotNull(state.original, state.journal.operation?.proof) + state.journal.archives.mapNotNull { it.proof })
        .groupBy { it.idempotencyKey }.values.map { same -> same.firstOrNull { it.completion != null } ?: same.first() }
