package gg.pixelkingdomwars.nativeclient.ui.sheets.money.live

import gg.pixelkingdomwars.nativeclient.boundcosmetics.*
import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.ui.economy.awningCraftHold
import gg.pixelkingdomwars.nativeclient.ui.economy.awningMatchingOwned
import gg.pixelkingdomwars.nativeclient.ui.economy.awningLabel
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.*

internal fun styleVerifiedTier(outputId: String, verified: Map<String, Int>): Int? = verified[outputId]?.takeIf { it > 0 }

/** The kingdom's Awning setting as the designed owned-tier primary (SPEC §2.7: green SHOW ON MARKET or stone HIDE,
 * both free). The owner keeps one Boolean per kingdom; the PreviewCard's setting line says what SHOW enables. */
internal fun styleAwningPreferencePrimary(enabled: Boolean?, current: Boolean, busy: Boolean,
    actionsAllowed: Boolean, showReady: Boolean): CraftPrimaryUi? {
    if (enabled == null) return null
    val label = if (enabled) "HIDE" else "SHOW ON MARKET"
    if (!current || !actionsAllowed) return offPrimary(label, "free", "The current appearance owner must allow this change.")
    if (busy) return busyPrimary("Checking appearance")
    if (!enabled && !showReady) return offPrimary(label, "free", "A matching owned appearance and verified application art are required.")
    return CraftPrimaryUi(label, "free", CommandState.ENABLED, if (enabled) Verb.STONE else Verb.GREEN,
        null, null, if (enabled) PrimaryAction.HIDE else PrimaryAction.SHOW)
}

internal fun styleWakePreferenceAllowed(enabled: Boolean?, accountCurrent: Boolean, busy: Boolean,
    mutationsAllowed: Boolean, nativeApplicationReady: Boolean, accountApplicationReady: Boolean, owned: Boolean): Boolean =
    enabled != null && accountCurrent && !busy && mutationsAllowed &&
        (enabled || nativeApplicationReady && accountApplicationReady && owned)

/** Current owner facts, not a new recipe or appearance policy. Each sibling can be unavailable independently. */
internal fun workshopStyleOwnerUi(
    state: BoundCosmeticWorkshopState?, wakeState: BoundCosmeticWakeWorkshopState?, wallet: String,
    selectedBase: String?, awningCurrent: Boolean, wakeCurrent: Boolean, accountCurrent: Boolean,
    busy: Boolean, actionsAllowed: Boolean, nativeAwningReady: Boolean, verifiedTiers: Map<String, Int>,
    completedMarketOutput: (Long) -> String, selectedTier: Int?, wakeSelected: Boolean,
    notice: String? = null,
): WorkshopStyleUi {
    val a = state?.takeIf { it.journal.identity.wallet == wallet }
    val w = wakeState?.takeIf { it.journal.identity.wallet == wallet }
    val view = a?.view?.takeIf { awningCurrent && it.wallet == wallet && it.selectedBase?.baseId == selectedBase }
    val base = view?.selectedBase as? BoundCosmeticSelectedBase.Available
    val wakeView = w?.view?.takeIf { wakeCurrent && it.wallet == wallet && it.selectedBase?.baseId == selectedBase }
    val wakeBase = wakeView?.selectedBase as? BoundCosmeticWakeSelectedBase.Available
    val appliedOutputs = base?.visual?.takeIf { it.state == "available" }?.visual?.marketAwnings
        ?.map { it.appearance.outputId }?.toSet().orEmpty()
    // The highest completed Market reported by the server; null when the selected kingdom was not read.
    val marketLevel = base?.markets?.maxOfOrNull { it.level }?.let { runCatching { Math.toIntExact(it) }.getOrNull() }
    val tiers = view?.recipes.orEmpty().mapNotNull { row ->
        val tier = styleVerifiedTier(row.recipe.outputId, verifiedTiers) ?: return@mapNotNull null
        runCatching {
            val owned = view!!.originals.any { it.completion != null && it.receipt?.appearance == row.appearance }
            val hold = awningCraftHold(requireNotNull(a), row, actionsAllowed, nativeAwningReady)
            val required = Math.toIntExact(row.recipe.requiredFacility.level)
            // MKT n only from the server's completed Markets (the owner's own hold rule); any other hold stays HELD.
            val marketLocked = base != null && base.markets.none { it.level >= row.recipe.requiredFacility.level }
            AwningTierUi(tier, row.recipe.recipeId, required,
                row.recipe.inputs.map { RecipeInputUi(InputKind.CRAFTING, it.itemId, it.quantity.toLong()) },
                row.recipe.durationSec, owned, hold == null,
                lockReason = if (marketLocked) LockReasonUi("Requires completed Market level $required.", "Market $required") else null,
                outputId = row.recipe.outputId, ownerApplied = row.recipe.outputId in appliedOutputs,
                ownerTag = when { owned -> "OWNED"; marketLocked -> "MKT $required"; hold == null -> "CRAFT"; else -> "HELD" })
        }.getOrNull()
    }
    val selected = tiers.firstOrNull { it.tier == selectedTier } ?: tiers.firstOrNull { it.craftable } ?: tiers.firstOrNull()
    val row = view?.recipes?.singleOrNull { it.recipe.recipeId == selected?.recipeId }
    val preference = base?.preference?.enabled
    val matching = view?.let { awningMatchingOwned(it, completedMarketOutput) }
    val showReady = nativeAwningReady && view?.applicationReady == true && matching?.available == true &&
        matching.originals.isNotEmpty() && matching.originals.all { it.receipt?.appearance?.outputId?.let { output -> output in verifiedTiers } == true }
    val preferencePrimary = styleAwningPreferencePrimary(preference, awningCurrent, busy, actionsAllowed, showReady)
    val ownedWake = w?.original?.completion != null
    // Account preference is independently refreshed even when selected-kingdom stock cannot be read.
    val wakePreference = w?.preference?.enabled?.takeIf { accountCurrent }
    val canToggleWake = styleWakePreferenceAllowed(wakePreference, accountCurrent, busy,
        actionsAllowed, nativeApplicationReady = false, accountApplicationReady = w?.accountApplicationReady == true, owned = ownedWake)
    val wakeRecipe = wakeView?.recipe?.recipe
    val mappedWake = wakeRecipe?.let { recipe -> runCatching {
        WakeRecipeUi(recipe.recipeId, recipe.inputs.map { RecipeInputUi(InputKind.CRAFTING, it.itemId, it.quantity.toLong()) }, recipe.durationSec)
    }.getOrNull() }
    val hold = row?.let { awningCraftHold(requireNotNull(a), it, actionsAllowed,
        nativeAwningReady && it.recipe.outputId in verifiedTiers) }
    val craftSub = row?.let { "takes ${craftDuration(it.recipe.durationSec)} · once" }
    val lock = selected?.lockReason
    val primary = when {
        wakeSelected -> if (ownedWake) null else offPrimary("CRAFT WAKE", null,
            "Fleet application is unavailable in this client. Source previews do not enable crafting.")
        // An owned tier: HIDE while the kingdom shows awnings; otherwise SHOW, or L "Market n" when no completed Market
        // can show this tier yet (SPEC §2.7 owner-specific state).
        selected?.owned == true -> when {
            preference == true -> preferencePrimary
            lock != null -> lockedPrimary(lock.requirement, lock.line)
            else -> preferencePrimary ?: offPrimary("SHOW ON MARKET", "free", "Kingdom appearance setting unavailable. Check appearances.")
        }
        busy -> busyPrimary("Checking appearance")
        row == null -> preferencePrimary
            ?: offPrimary("CRAFT AWNING", null, "Recipes or their verified previews are unavailable. Check appearances.")
        lock != null -> lockedPrimary(lock.requirement, lock.line)
        hold != null -> offPrimary("CRAFT AWNING ${romanTier(requireNotNull(selected).tier)}", craftSub, hold)
        else -> CraftPrimaryUi("CRAFT AWNING ${romanTier(requireNotNull(selected).tier)}", craftSub,
            CommandState.ENABLED, Verb.GOLD, null, null, PrimaryAction.START)
    }
    val selectedOperation = if (wakeSelected) w?.journal?.operation else a?.journal?.operation
    val stocks = if (wakeSelected) wakeBase?.craftingStock else base?.craftingStock
    val queue = if (wakeSelected) wakeBase?.queue else base?.queue
    val status = notice ?: when {
        busy -> "Checking current appearances and original receipts."
        (if (wakeSelected) wakeView else view) == null -> "Current kingdom recipes are unavailable. Account settings and original receipts remain separate."
        queue == null -> "The current Workshop queue has not been observed."
        queue.isNotEmpty() -> "${queue.size} jobs occupy the shared Workshop queue. Completion is automatic; check receipts."
        else -> "Permanent account appearances. Materials are spent only after the original review and consent."
    }
    val awningSetting = when (preference) {
        true -> "Awnings enabled for this kingdom. Each completed Market uses its matching owned tier."
        false -> "Awnings hidden in this kingdom. SHOW enables matching owned tiers; it does not choose one tier."
        null -> "Kingdom appearance setting unavailable. Original requests remain available."
    } + (if (base?.visual?.state == "unavailable") " The displayed visual is unverified; the saved preference is unchanged." else "") +
        (if (a?.preferenceChanged == true) " The choice changed elsewhere. Check the refreshed setting before changing it again." else "")
    val wakeSetting = when {
        wakePreference == null -> "Account setting unavailable. Check appearances."
        wakePreference -> "Enabled for future departures. HIDE remains available; fleet animation is unavailable here."
        ownedWake -> "Owned · account setting off. SHOW requires fleet application support."
        else -> "Not owned · source preview only. Crafting requires fleet application support."
    } + (if (w?.preferenceChanged == true) " The choice changed elsewhere. Check the refreshed account setting." else "")
    val ownedOutputs = view?.originals?.filter { it.completion != null }?.mapNotNull { it.receipt?.recipe?.outputId }
    val ownedLine = when {
        ownedOutputs == null -> "Current account appearance ownership is unavailable. Original receipts remain in History."
        ownedOutputs.isEmpty() -> "No completed Awnings were reported for this account."
        else -> ownedOutputs.joinToString(prefix = "Owned by this account: ", transform = ::awningLabel)
    }
    // YOU NEED names the server's input ids the way the other Workshop tabs do ("thornsilk" → "Thornsilk").
    val inputIds = (view?.recipes.orEmpty().flatMap { it.recipe.inputs } + wakeRecipe?.inputs.orEmpty()).map { it.itemId }.toSet()
    val items = inputIds.associateWith { id ->
        CraftItemUi(id, id.split('_').joinToString(" ") { it.replaceFirstChar(Char::uppercaseChar) }, craftItemIcon(id), "Refine at the Workshop")
    }
    return WorkshopStyleUi(AwningUi(tiers, null, selected?.outputId?.let { it in verifiedTiers } == true),
        WakeUi(ownedWake, wakePreference == true, mappedWake), marketLevel = marketLevel, job = null,
        saved = selectedOperation?.let { SavedOpUi(it.command.key, "Original appearance request",
            if (it.proof?.completion != null) "Completion observed. Original receipts remain in History." else "Check the saved original before starting another craft.", busy) },
        selectedTier = selected?.tier, wakeSelected = wakeSelected,
        stock = stocks.orEmpty().mapNotNull { stock ->
            val available = stock.available.toLongOrNull() ?: return@mapNotNull null
            val pending = stock.pendingOutput.toLongOrNull() ?: return@mapNotNull null
            stock.itemId to StockUi(available, pendingOutput = pending)
        }.toMap(), items = items,
        actionsAllowed = actionsAllowed && accountCurrent, acceptingJobs = false,
        ownerControls = WorkshopStyleOwnerControls(primary, canToggleWake, wakePreference, status, awningSetting,
            wakeSetting, accountCurrent && !busy, preferencePrimary, ownedLine, accountCurrent))
}
