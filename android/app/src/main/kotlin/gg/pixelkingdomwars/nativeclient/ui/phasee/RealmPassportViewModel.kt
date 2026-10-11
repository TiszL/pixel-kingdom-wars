package gg.pixelkingdomwars.nativeclient.ui.phasee

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import gg.pixelkingdomwars.nativeclient.data.RealmPassportRepository
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

class RealmPassportViewModel(private val repository: RealmPassportRepository) : ViewModel() {
    val state = repository.state
    private val selected = MutableStateFlow("starter"); val kind = selected.asStateFlow()
    private var work: Job? = null
    private fun action(block: suspend () -> Unit): Job? {
        if (work?.isActive == true) return null
        return viewModelScope.launch { block() }.also { work = it }
    }
    fun discover() = action { repository.discover() }
    suspend fun awaitIdle() { work?.join() }
    /** Borrowed Home read; the selected kind of the existing history screen is left intact. */
    fun readExpeditions(kind: String, next: Boolean = false): Job? {
        require(kind in setOf("starter", "advanced"))
        return action { repository.expeditions(kind, next) }
    }
    fun refresh() = action { repository.expeditions(selected.value); repository.inclusions(); repository.current() }
    fun selectKind(kind: String) {
        require(kind in setOf("starter", "advanced"))
        if (work?.isActive == true || kind == selected.value) return
        selected.value = kind; refreshExpeditions()
    }
    fun refreshExpeditions() = action { repository.expeditions(selected.value) }
    fun nextExpeditions() = action { repository.expeditions(selected.value, next = true) }
    fun refreshInclusions() = action { repository.inclusions() }
    fun nextInclusions() = action { repository.inclusions(next = true) }
    fun refreshCurrent() = action { repository.current() }
    fun close() { repository.dismiss(clearDiscovery = false); work?.cancel(); work = null }
    fun dismiss() { repository.dismiss(); work?.cancel(); work = null }
    override fun onCleared() { dismiss() }
}
