package gg.pixelkingdomwars.nativeclient.ui.economy

import gg.pixelkingdomwars.nativeclient.data.WorkshopRepository
import gg.pixelkingdomwars.nativeclient.data.WorkshopReview
import gg.pixelkingdomwars.nativeclient.ui.ScreenViewModel
import gg.pixelkingdomwars.nativeclient.ui.sheets.money.live.WorkshopCompletionEvents
import gg.pixelkingdomwars.nativeclient.ui.sheets.money.live.WorkshopCompletionToken
import gg.pixelkingdomwars.nativeclient.ui.sheets.money.live.ingotWorkshopCompletion
import kotlinx.coroutines.Job

/** Foreground/history never mutate. Only the explicit confirmation button may POST. */
class WorkshopViewModel(private val repository: WorkshopRepository) : ScreenViewModel() {
    val state=repository.state
    private val completionEvents = WorkshopCompletionEvents()
    val completion = completionEvents.state
    fun acknowledgeCompletion(token: WorkshopCompletionToken) = completionEvents.acknowledge(token)
    fun selectCompletionBase(baseId: String?) = completionEvents.selectBase(baseId)
    private var lastAction: Job? = null
    private fun action(block:suspend ()->Unit):Job? = run(block).also { if(it!=null) lastAction=it }
    suspend fun foreground() { lastAction?.join(); refresh()?.join() }
    fun refresh()=action { repository.refresh() }
    fun start(quantity:String)=action {
        require(quantity.matches(Regex("[1-9][0-9]{0,15}"))) { "Enter a whole ingot quantity." }
        repository.reviewStart(requireNotNull(quantity.toLongOrNull()))
    }
    fun collect(jobId:String)=action { repository.reviewCollect(jobId) }
    fun reviewSaved()=action { repository.reviewSaved() }
    fun confirm(review:WorkshopReview)=action { repository.confirm(review) }
    fun check()=action { repository.check() }
    fun archiveUnusedOrRefused()=action { repository.archiveDraftOrRefusal() }
    fun finish() = action {
        val before = state.value
        repository.finish()
        // Only this successful existing receipt + hydration + archive boundary may offer a local celebration.
        if (!completionEvents.offer(ingotWorkshopCompletion(before, state.value)))
            notify("Original receipt archived. History remains available.")
    }
    fun dismiss()=repository.dismiss()
}
