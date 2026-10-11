package gg.pixelkingdomwars.nativeclient.ui.economy

import gg.pixelkingdomwars.nativeclient.data.OrdinaryCraftingRepository
import gg.pixelkingdomwars.nativeclient.data.OrdinaryCraftingReview
import gg.pixelkingdomwars.nativeclient.data.OrdinaryCraftingState
import gg.pixelkingdomwars.nativeclient.ui.ScreenViewModel
import gg.pixelkingdomwars.nativeclient.ui.sheets.money.live.WorkshopCompletionEvents
import gg.pixelkingdomwars.nativeclient.ui.sheets.money.live.WorkshopCompletionToken
import gg.pixelkingdomwars.nativeclient.ui.sheets.money.live.ordinaryWorkshopCompletion
import kotlinx.coroutines.Job

/** The entry remains reachable for original recovery even when current discovery disappears. */
fun ordinaryCraftingEntryAvailable(state: OrdinaryCraftingState?, storageUnavailable: Boolean = false): Boolean =
    storageUnavailable || state?.let { it.advertised || it.journal.operation != null || it.journal.archives.isNotEmpty() } == true

/** Foreground and completion checks only GET. Only an explicit reviewed confirmation may POST. */
class OrdinaryCraftingViewModel(private val repository: OrdinaryCraftingRepository) : ScreenViewModel() {
    val state = repository.state
    private val completionEvents = WorkshopCompletionEvents()
    val completion = completionEvents.state
    fun acknowledgeCompletion(token: WorkshopCompletionToken) = completionEvents.acknowledge(token)
    fun selectCompletionBase(baseId: String?) = completionEvents.selectBase(baseId)
    private var lastAction: Job? = null
    private fun action(block: suspend () -> Unit): Job? = run(block).also { if (it != null) lastAction = it }
    suspend fun foreground() { lastAction?.join(); refresh()?.join() }
    fun refresh() = action {
        repository.awaitIdle()
        // Archived starts can finish while this base is paused, transferred or no longer selected.
        state.value.journal.archives.filter { it.operation.proof != null && it.operation.proof?.completion == null }
            .forEach { repository.checkArchived(it.operation.command.key) }
        repository.refresh()
    }
    fun start(recipeId: String, quantity: String) = action {
        require(quantity.matches(Regex("[1-9][0-9]*"))) { "Enter a whole batch quantity." }
        val count = requireNotNull(quantity.toIntOrNull()) { "Batch quantity is too large." }
        repository.reviewStart(recipeId, count)
    }
    fun reviewSaved() = action { repository.reviewSaved() }
    fun confirm(review: OrdinaryCraftingReview) = action { repository.confirm(review) }
    fun check() = action { repository.check() }
    fun checkArchived(key: String) = action { repository.checkArchived(key) }
    fun archiveUnusedOrRefused() = action { repository.archiveDraftOrRefusal() }
    fun finish() = action {
        val before = state.value
        repository.finish()
        // Only this successful existing receipt + hydration + archive boundary may offer a local celebration.
        if (!completionEvents.offer(ordinaryWorkshopCompletion(before, state.value)))
            notify("Original receipt archived. Automatic completion remains available in history.")
    }
    fun dismiss() = repository.dismiss()
}

/** Server inventory and the exact reviewed batch supply every quantity shown in the ingredient panel. */
internal data class OrdinaryIngredientAvailability(val itemId: String, val kind: String, val needed: String,
    val owned: String, val missing: String)
internal fun ordinaryIngredientAvailability(recipe: gg.pixelkingdomwars.nativeclient.ordinarycrafting.OrdinaryCraftingRecipe,
    view: gg.pixelkingdomwars.nativeclient.ordinarycrafting.OrdinaryCraftingView): List<OrdinaryIngredientAvailability> = recipe.inputs.map {
    val available = view.available(it)
    OrdinaryIngredientAvailability(it.itemId, it.kind, it.quantity, available,
        (it.quantity.toBigInteger() - available.toBigInteger()).max(java.math.BigInteger.ZERO).toString())
}
internal fun ordinaryCraftingIngredientConsent(recipe: gg.pixelkingdomwars.nativeclient.ordinarycrafting.OrdinaryCraftingRecipe): String =
    recipe.inputs.singleOrNull { it.kind == "shards" }?.let {
        "${it.quantity} SHARDS are consumed as an ingredient alongside the listed materials. This is not a service fee or tax."
    } ?: "The listed materials are consumed at the start."
