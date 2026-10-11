package gg.pixelkingdomwars.nativeclient.ui.community

import gg.pixelkingdomwars.nativeclient.data.ClanReview
import gg.pixelkingdomwars.nativeclient.data.LiveClansRepository
import gg.pixelkingdomwars.nativeclient.ui.Copy
import gg.pixelkingdomwars.nativeclient.ui.ScreenViewModel

class ClansViewModel(private val repository: LiveClansRepository) : ScreenViewModel() {
    val state = repository.state
    suspend fun foreground(requireCurrent: () -> Unit = {}) { refresh(requireCurrent)?.join() }
    fun refresh(requireCurrent: () -> Unit = {}) = run { requireCurrent(); repository.refresh() }
    fun reviewLeave(clan: String, base: String?, requireCurrent: () -> Unit = {}) = run { requireCurrent(); repository.reviewLeave(clan, base) }
    fun reviewKick(clan: String, target: String, requireCurrent: () -> Unit = {}) = run { requireCurrent(); repository.reviewKick(clan, target) }
    fun confirm(review: ClanReview, requireCurrent: () -> Unit = {}) = run { requireCurrent(); repository.confirm(review) }
    fun retry(kind: String, requireCurrent: () -> Unit = {}) = run { requireCurrent(); repository.retry(kind) }
    /** CLOSE on a saved v1 change the server answered `unknown` for; its observation joins the status notices. */
    fun close(kind: String, requireCurrent: () -> Unit = {}) = run { requireCurrent(); Copy.observation(repository.close(kind))?.let { notify(it) } }
    fun dismiss() = repository.dismiss()
}
