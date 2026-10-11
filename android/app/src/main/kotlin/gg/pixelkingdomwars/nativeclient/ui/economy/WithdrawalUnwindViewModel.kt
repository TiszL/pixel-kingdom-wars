package gg.pixelkingdomwars.nativeclient.ui.economy

import gg.pixelkingdomwars.nativeclient.data.WithdrawalUnwindRepository
import gg.pixelkingdomwars.nativeclient.data.WithdrawalUnwindReview
import gg.pixelkingdomwars.nativeclient.ops.WithdrawalUnwindAction
import gg.pixelkingdomwars.nativeclient.ui.Copy
import gg.pixelkingdomwars.nativeclient.ui.ScreenViewModel

class WithdrawalUnwindViewModel(private val repository: WithdrawalUnwindRepository) : ScreenViewModel() {
    val state = repository.state
    suspend fun foreground() { refresh()?.join() }
    fun refresh() = run { repository.refresh() }
    fun review(id: String, action: WithdrawalUnwindAction) = run { repository.review(id, action) }
    fun confirm(review: WithdrawalUnwindReview) = run { repository.confirm(review) }
    fun retry() = run { repository.retry() }
    /** CLOSE on a saved action the server answered `unknown` for; its observation is announced in the panel's notice. */
    fun close() = run { Copy.observation(repository.close())?.let { notify(it) } }
    fun dismiss() = repository.dismiss()
}
