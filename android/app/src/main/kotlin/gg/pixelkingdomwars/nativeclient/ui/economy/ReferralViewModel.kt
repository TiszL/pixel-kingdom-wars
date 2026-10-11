package gg.pixelkingdomwars.nativeclient.ui.economy

import gg.pixelkingdomwars.nativeclient.data.ReferralRepository
import gg.pixelkingdomwars.nativeclient.data.ReferralReview
import gg.pixelkingdomwars.nativeclient.ui.ScreenViewModel

class ReferralViewModel(private val repository: ReferralRepository) : ScreenViewModel() {
    val state = repository.state
    suspend fun foreground() = repository.refresh()
    fun refresh() = run { repository.refresh() }
    fun review(code: String) = run { repository.review(code) }
    fun confirm(review: ReferralReview) = run { repository.confirm(review) }
    fun retry() = run { repository.retry() }
    fun close() = run { repository.close() }
    fun finish() = run { repository.finish() }
    fun dismiss() = repository.dismiss()
}
