package gg.pixelkingdomwars.nativeclient.ui.economy

import gg.pixelkingdomwars.nativeclient.boundcosmetics.*
import gg.pixelkingdomwars.nativeclient.data.BoundCosmeticWorkshopRepository
import gg.pixelkingdomwars.nativeclient.data.BoundCosmeticWorkshopReview
import gg.pixelkingdomwars.nativeclient.data.BoundCosmeticWorkshopState
import gg.pixelkingdomwars.nativeclient.network.SessionSupersededException
import gg.pixelkingdomwars.nativeclient.ui.ScreenViewModel
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job

fun boundCosmeticWorkshopEntryAvailable(state: BoundCosmeticWorkshopState?, storageUnavailable: Boolean = false): Boolean =
    storageUnavailable || state?.let { it.advertised || it.journal.operation != null || it.journal.archives.isNotEmpty() } == true

/** Foreground only observes originals. A material spend always requires a fresh,
 * exact repository review and explicit consent; closing never erases its intent. */
class BoundCosmeticWorkshopViewModel(private val repository: BoundCosmeticWorkshopRepository) : ScreenViewModel() {
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
    fun review(recipeId: String) = action { repository.reviewStart(recipeId) }
    fun reviewSaved() = action { repository.reviewSaved() }
    fun confirm(review: BoundCosmeticWorkshopReview, materialConsent: Boolean) = action {
        check(materialConsent) { "Confirm that the listed materials will be permanently consumed." }
        repository.confirm(review)
    }
    fun check() = action { repository.check() }
    fun checkArchived(key: String) = action { repository.checkArchived(key) }
    fun archive() = action { repository.archive(); notify("Original request archived. Its receipt remains in History.") }
    fun setPreference(enabled: Boolean) = action { repository.setPreference(enabled) }
    fun dismiss() { repository.dismiss(); dismissNotice() }
}

internal data class AwningMaterial(val itemId: String, val needed: String, val available: String?, val missing: String?)
internal fun awningMaterials(recipe: BoundCosmeticRecipe, base: BoundCosmeticSelectedBase.Available?): List<AwningMaterial> = recipe.inputs.map { input ->
    val available = base?.craftingStock?.singleOrNull { it.itemId == input.itemId }?.available
    AwningMaterial(input.itemId, input.quantity, available, available?.let {
        (input.quantity.toBigInteger() - it.toBigInteger()).max(java.math.BigInteger.ZERO).toString()
    })
}
internal fun awningCraftHold(state: BoundCosmeticWorkshopState, row: BoundCosmeticCatalogueRow, actionsAllowed: Boolean, nativeReady: Boolean): String? {
    val view = state.view ?: return "Refresh to load this kingdom's Workshop."
    val base = view.selectedBase as? BoundCosmeticSelectedBase.Available ?: return "Select an active kingdom with verified ownership."
    return when {
        !actionsAllowed -> "Game orders are paused. Saved originals remain available."
        !nativeReady || !view.applicationReady -> "Awning artwork is unavailable in this client. Saved originals remain available."
        !view.acceptingJobs -> "New Awning crafting is paused. Accepted work still completes."
        state.journal.operation != null -> "Resolve or archive the saved request first."
        view.originals.any { it.receipt?.recipe?.outputId == row.recipe.outputId } -> "This appearance is already owned or being crafted."
        view.blueprint.state == "unavailable" -> "Blueprint history is unavailable. Refresh to try again."
        view.blueprint.state != "eligible" -> "Complete a refining job to earn the Artisan Finishes Blueprint."
        base.workshops.isEmpty() -> "Complete a Workshop in this kingdom."
        base.markets.none { it.level >= row.recipe.requiredFacility.level } -> "Requires completed Market level ${row.recipe.requiredFacility.level}."
        base.queue.isNotEmpty() -> "The Workshop is busy. Materials, equipment and Awnings share its queue."
        awningMaterials(row.recipe, base).any { it.missing != "0" } -> "Gather the missing refined materials."
        else -> null
    }
}
internal data class AwningOwnedMatch(val available: Boolean, val originals: List<BoundCosmeticProof>)
internal fun awningMatchingOwned(view: BoundCosmeticWorkshopView, completedMarketOutput: (Long) -> String): AwningOwnedMatch {
    val base = view.selectedBase as? BoundCosmeticSelectedBase.Available ?: return AwningOwnedMatch(false, emptyList())
    val outputs = try { base.markets.map { completedMarketOutput(it.level) }.toSet() }
    catch (_: Exception) { return AwningOwnedMatch(false, emptyList()) }
    return AwningOwnedMatch(true, view.originals.filter { it.completion != null && it.receipt?.recipe?.outputId in outputs })
}
internal fun awningLabel(outputId: String): String = if (outputId.startsWith("artisan_market_awning_t"))
    "Artisan Awning · Tier ${outputId.removePrefix("artisan_market_awning_t")}" else "Saved appearance"
internal fun awningRequestStatus(operation: BoundCosmeticOperation): String = when {
    operation.proof?.completion != null -> "Crafted"
    operation.proof != null -> "Crafting"
    operation.closedUnknown -> "Closed · not found"
    operation.attempted -> "Outcome unknown"
    else -> "Saved draft"
}
