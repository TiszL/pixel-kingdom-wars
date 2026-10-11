package gg.pixelkingdomwars.nativeclient.ui.economy

import androidx.lifecycle.viewModelScope
import gg.pixelkingdomwars.nativeclient.data.EconomyPage
import gg.pixelkingdomwars.nativeclient.data.EconomyRepository
import gg.pixelkingdomwars.nativeclient.data.EconomyReview
import gg.pixelkingdomwars.nativeclient.data.WithdrawalReview
import gg.pixelkingdomwars.nativeclient.data.WithdrawalAuthorization
import gg.pixelkingdomwars.nativeclient.ops.EconomyAction
import gg.pixelkingdomwars.nativeclient.ui.Copy
import gg.pixelkingdomwars.nativeclient.ui.ScreenViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject

class EconomyViewModel(private val repository: EconomyRepository) : ScreenViewModel() {
    val state = repository.state
    val interrupted = repository.interrupted
    private val mutableReview = MutableStateFlow<EconomyReview?>(null)
    val review = mutableReview.asStateFlow()
    private val mutableWithdrawal = MutableStateFlow<WithdrawalReview?>(null)
    val withdrawalReview = mutableWithdrawal.asStateFlow()
    private var globalRead: Job? = null
    suspend fun foreground(page: EconomyPage) = repository.refresh(page)
    fun refresh(page: EconomyPage) = run { repository.refresh(page) }
    fun moreAllocations() = run { repository.moreAllocations() }
    fun refreshGlobal(day: String? = null) {
        globalRead?.cancel()
        globalRead = viewModelScope.launch { repository.refreshGlobal(day) }
    }
    fun moreGlobal() {
        if (globalRead?.isActive == true) return
        globalRead = viewModelScope.launch { repository.moreGlobal() }
    }
    fun prepare(action: EconomyAction, amount: String) = run { mutableReview.value = repository.review(action, amount) }
    fun dismissReview() { mutableReview.value = null; mutableWithdrawal.value = null }
    fun confirm(review: EconomyReview) = run { dismissReview(); repository.confirm(review) }
    fun check(kind: String) = run { Copy.observation(repository.check(kind))?.let { notify(it) } }
    fun close(kind: String) = run { Copy.observation(repository.close(kind))?.let { notify(it) } }
    fun prepareWithdrawal(amount: String, destination: String, instant: Boolean) = run {
        mutableWithdrawal.value = repository.prepareWithdrawal(amount, destination, instant)
    }
    fun confirmWithdrawal(review: WithdrawalReview, code: String, authorize: suspend (JsonObject) -> WithdrawalAuthorization) = run {
        dismissReview(); repository.confirmWithdrawal(review, code, authorize)
    }
    fun linkFailed() = notify("No browser could open Jupiter. Try again after enabling a browser.", error = true)
}
