package gg.pixelkingdomwars.nativeclient.ui.economy

import gg.pixelkingdomwars.nativeclient.data.GemsRepository
import gg.pixelkingdomwars.nativeclient.data.GemsReview
import gg.pixelkingdomwars.nativeclient.ui.Copy
import gg.pixelkingdomwars.nativeclient.ui.ScreenViewModel

class GemsViewModel(private val repository: GemsRepository) : ScreenViewModel() {
    val state = repository.state
    suspend fun foreground() { refresh()?.join() }
    fun refresh() = run { repository.refresh() }
    fun review(kind: String, amount: String? = null, taskId: String? = null) = run { repository.review(kind, amount, taskId) }
    fun confirm(review: GemsReview) = run { repository.confirm(review) }
    fun dismiss() = repository.dismiss()
    fun check(kind: String) = run { Copy.observation(repository.check(kind))?.let { notify(it) } }
    fun retry(kind: String) = run { repository.retry(kind) }
    /** CLOSE on a saved request the server answered `unknown` for; its observation is announced like CHECK's. */
    fun close(kind: String) = run { Copy.observation(repository.close(kind))?.let { notify(it) } }
}
