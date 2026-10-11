package gg.pixelkingdomwars.nativeclient.ui.economy

import gg.pixelkingdomwars.nativeclient.data.ForgeClaimsRepository
import gg.pixelkingdomwars.nativeclient.data.ForgeClaimReview
import gg.pixelkingdomwars.nativeclient.data.ForgeClaimRefreshException
import gg.pixelkingdomwars.nativeclient.ui.Copy
import gg.pixelkingdomwars.nativeclient.ui.ScreenViewModel

class ForgeClaimsViewModel(private val repository: ForgeClaimsRepository) : ScreenViewModel() {
    val state = repository.state
    suspend fun foreground() { refresh()?.join() }
    fun refresh() = claimAction { repository.refresh() }
    fun review(base: String?, day: String?) = run { repository.review(base, day) }
    fun confirm(review: ForgeClaimReview) = claimAction { repository.confirm(review) }
    fun retry() = claimAction { repository.retry() }
    /** CLOSE on a saved claim the server answered `unknown` for; its observation is announced in the panel's notice. */
    fun close() = run { Copy.observation(repository.close())?.let { notify(it) } }
    private fun claimAction(block: suspend () -> Unit) = run {
        try { block() } catch (_: ForgeClaimRefreshException) { /* The receipt stays successful; the panel offers refresh. */ }
        catch (error: java.io.IOException) {
            if (state.value.pending?.receipt == null && state.value.pending != null)
                notify("Checking outcome. Your original claim is saved.")
            else throw error
        }
    }
    fun dismiss() = repository.dismiss()
}
