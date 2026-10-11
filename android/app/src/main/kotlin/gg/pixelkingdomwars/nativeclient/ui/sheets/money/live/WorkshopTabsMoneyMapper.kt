package gg.pixelkingdomwars.nativeclient.ui.sheets.money.live

import gg.pixelkingdomwars.nativeclient.boundcosmetics.*
import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.OrdinaryCraftingIdentity
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.*
import java.time.Instant

/** Additive observation-only tabs; Workshop-v2 INGOTS and its recovery/mounting conditions are unchanged.
 * Flags witness an admitted read for the exact account/base/generation, not just equality of retained snapshots.
 * Null means the host must retain the original owner/unavailable presentation, never draw an empty ready body.
 * No command, review, Seal, receipt, celebration or callback is synthesized. All new spending remains disabled.
 */
internal fun workshopRefineTabUi(
    state: OrdinaryCraftingState?, identity: OrdinaryCraftingIdentity?, selectedBaseId: String?,
    repositoryCurrent: Boolean = false, viewCurrent: Boolean = false, benchCapacity: Int? = null,
    quantity: Int = 1, selectedRecipeId: String? = null, serverOffsetMs: Long? = null,
    items: Map<String, CraftItemUi> = emptyMap(),
): WorkshopRefineUi? {
    if (!repositoryCurrent || !viewCurrent || state == null || identity == null || state.busy || !state.advertised ||
        state.journal.identity != identity || state.journal.operation != null || benchCapacity == null || benchCapacity <= 0) return null
    return runCatching {
        identity.validate()
        val view = requireNotNull(state.view).also { it.validate() }
        require(view.wallet == identity.wallet && view.baseId == selectedBaseId)
        require(view.pendingJobs.isEmpty() || serverOffsetMs != null)
        val qty = quantity.coerceIn(1, view.maxBatch)
        val recipes = view.recipes.map { r ->
            // The existing kit multiplies signed Long amounts. Refuse an unrepresentable selection before rendering.
            r.batch(qty)
            RecipeUi(r.recipeId, r.recipeVersion.toString(), if (r.recipeId.startsWith("refine_")) RecipeGroup.REFINE else RecipeGroup.KIT,
                r.output.itemId, r.output.quantity.toLong(), r.inputs.map { input ->
                    RecipeInputUi(when (input.kind) { "raw" -> InputKind.RAW; "crafting" -> InputKind.CRAFTING; "shards" -> InputKind.SHARDS; else -> error("Unknown ingredient") },
                        input.itemId, input.quantity.toLong())
                }, r.durationSec, items[r.output.itemId]?.usedFor.orEmpty(), null)
        }
        val stock = view.rawStock.associate { it.resourceId to StockUi(it.available.toLong(), it.reserved.toLong(), it.total.toLong()) } +
            view.craftingStock.associate { it.itemId to StockUi(it.available.toLong(), pendingOutput = it.pendingOutput.toLong()) }
        WorkshopRefineUi(recipes, stock, view.maxBatch, view.acceptingJobs,
            view.pendingJobs.map { BenchJobUi(it.jobId, it.recipe.recipeId, it.recipe.quantity.toLong(), epoch(it.readyAt), startedAtMs = epoch(it.startedAt)) },
            false, selectedRecipeId?.takeIf { id -> recipes.any { it.recipeId == id } }, qty, null, CraftHydration.Ready,
            items, view.shardsAvailable?.toLong(), benchCapacity, serverOffsetMs ?: 0)
    }.getOrNull()
}

/** Equipment's stock has a reserved count, not trip destinations. Require the trip owner's complete current
 * projection, including an explicit empty list; never infer no trips from a missing fleet read.
 */
internal fun workshopToolsTabUi(
    state: EquipmentState?, identity: StarterIdentity?, selectedBaseId: String?,
    repositoryCurrent: Boolean = false, viewCurrent: Boolean = false,
    travelling: List<TravellingToolUi>? = null, travellingCurrent: Boolean = false,
    serverOffsetMs: Long? = null, items: Map<String, CraftItemUi> = emptyMap(), selectedRecipeId: String? = null,
): WorkshopToolsUi? {
    if (!repositoryCurrent || !viewCurrent || !travellingCurrent || travelling == null || state == null || identity == null ||
        state.busy || state.error != null || state.journal?.identity != identity || state.journal?.pending?.isNotEmpty() != false) return null
    return runCatching {
        identity.validate()
        val view = requireNotNull(state.view).also { it.validate() }
        require(view.wallet == identity.wallet && view.baseId == selectedBaseId && view.pendingJobs.size <= 1)
        require((view.pendingJobs.isEmpty() && travelling.isEmpty()) || serverOffsetMs != null)
        require(travelling.map { it.installationId }.distinct().size == travelling.size)
        require(travelling.all { it.installationId.isNotBlank() && it.returnsAtMs >= 0 && view.equipmentStock.any { s -> s.itemId == it.itemId } })
        view.equipmentStock.forEach { s -> require(s.reserved.toLong() == travelling.count { it.itemId == s.itemId }.toLong()) }
        val recipes = view.recipes.map { r ->
            // Tools UI represents exactly one output per job; a different server recipe needs a kit contract change.
            require(r.output.quantity == "1")
            val item = items[r.output.itemId]
            ToolRecipeUi(r.recipeId, r.output.itemId, item?.name ?: r.output.itemId, item?.name ?: r.output.itemId,
                item?.usedFor.orEmpty(), item?.icon.orEmpty(), r.inputs.map { RecipeInputUi(InputKind.CRAFTING, it.itemId, it.quantity.toLong()) }, r.durationSec)
        }
        WorkshopToolsUi(recipes, view.equipmentStock.associate { it.itemId to Math.addExact(it.available.toLong(), it.reserved.toLong()) },
            travelling, view.pendingJobs.singleOrNull()?.let { BenchJobUi(it.jobId, it.recipe.recipeId, it.recipe.quantity.toLong(),
                epoch(it.readyAt), startedAtMs = epoch(it.startedAt)) }, view.acceptingJobs, null,
            selectedRecipeId?.takeIf { id -> recipes.any { it.recipeId == id } },
            stock = view.craftingStock.associate { it.itemId to StockUi(it.available.toLong(), pendingOutput = it.pendingOutput.toLong()) },
            items = items, actionsAllowed = false, serverOffsetMs = serverOffsetMs ?: 0)
    }.getOrNull()
}

/** STYLE cannot represent unknown ownership, multiple building targets, or mixed queues. Both validated sibling
 * views must be current for one selected base; the named Market is selected explicitly, never guessed by max level.
 * outputTier comes from the admitted generated catalogue/art mapping. Owned free SHOW/HIDE bypass the kit's spend
 * gate, so a separately accepted existing-owner handoff is mandatory even though crafting remains disabled here.
 * An active/saved cosmetic operation falls back to its existing owner, which alone handles original recovery.
 */
internal fun workshopStyleTabUi(
    state: BoundCosmeticWorkshopState?, wakeState: BoundCosmeticWakeWorkshopState?, identity: BoundCosmeticIdentity?,
    selectedBaseId: String?, marketBuildingId: String?, repositoryCurrent: Boolean = false,
    viewCurrent: Boolean = false, wakeCurrent: Boolean = false, ownerHandoffReady: Boolean = false,
    previewVerified: Boolean = false, outputTier: (String) -> Int? = { null }, items: Map<String, CraftItemUi> = emptyMap(),
): WorkshopStyleUi? {
    if (!repositoryCurrent || !viewCurrent || !wakeCurrent || !ownerHandoffReady || state == null || wakeState == null || identity == null ||
        state.busy || wakeState.busy || !state.advertised || !wakeState.advertised || state.journal.identity != identity ||
        wakeState.journal.identity != identity || state.journal.operation != null || wakeState.journal.operation != null) return null
    return runCatching {
        identity.validate()
        val v = requireNotNull(state.view); val w = requireNotNull(wakeState.view)
        require(v.wallet == identity.wallet && w.wallet == identity.wallet)
        val base = v.selectedBase as? BoundCosmeticSelectedBase.Available ?: error("No admitted base")
        val wakeBase = w.selectedBase as? BoundCosmeticWakeSelectedBase.Available ?: error("No admitted Wake base")
        require(base.baseId == selectedBaseId && wakeBase.baseId == selectedBaseId)
        require(base.queue.isEmpty() && wakeBase.queue.isEmpty())
        require(base.craftingStock == wakeBase.craftingStock) // Conflicting independently refreshed inventory is unknown.
        base.craftingStock.forEach { it.validate() }
        base.visual.validate(); require(base.visual.state == "available")
        w.preference.validate(); require(w.preference.visual.state == "available")
        val market = base.markets.singleOrNull { it.buildingId == marketBuildingId } ?: error("Select one current Market")
        val marketLevel = Math.toIntExact(market.level)
        v.originals.forEach { it.validate(); require(it.wallet == identity.wallet && it.status == "accepted") }
        w.original?.let { it.validate(); require(it.wallet == identity.wallet && it.status == "accepted") }
        val tiers = v.recipes.map { row ->
            row.recipe.validate(); row.appearance.validate(); require(row.recipe.outputId == row.appearance.outputId)
            val tier = requireNotNull(outputTier(row.recipe.outputId)); require(tier > 0)
            val required = Math.toIntExact(row.recipe.requiredFacility.level)
            val owned = v.originals.any { it.completion != null && it.receipt?.appearance == row.appearance }
            AwningTierUi(tier, row.recipe.recipeId, required,
                row.recipe.inputs.map { RecipeInputUi(InputKind.CRAFTING, it.itemId, it.quantity.toLong()) },
                row.recipe.durationSec, owned, craftable = false)
        }
        require(tiers.isNotEmpty() && tiers.map { it.tier }.distinct().size == tiers.size)
        val applied = base.visual.visual!!.marketAwnings.singleOrNull { it.buildingId == marketBuildingId }?.appearance?.let {
            requireNotNull(outputTier(it.outputId))
        }
        require(applied == null || tiers.any { it.tier == applied && it.owned })
        w.recipe.recipe.validate(); w.recipe.appearance.validate()
        require(w.recipe.recipe.outputId == "aurora_wake" && w.recipe.appearance.outputId == "aurora_wake")
        val wakeOwned = w.original?.completion != null && w.original?.receipt?.appearance == w.recipe.appearance
        val wakeShown = w.preference.visual.visual?.wake != null
        require(!wakeShown || wakeOwned)
        WorkshopStyleUi(AwningUi(tiers, applied, previewVerified), WakeUi(wakeOwned, wakeShown,
            WakeRecipeUi(w.recipe.recipe.recipeId, w.recipe.recipe.inputs.map { RecipeInputUi(InputKind.CRAFTING, it.itemId, it.quantity.toLong()) },
                w.recipe.recipe.durationSec)), marketLevel, null, null,
            stock = base.craftingStock.associate { it.itemId to StockUi(it.available.toLong(), pendingOutput = it.pendingOutput.toLong()) },
            items = items, actionsAllowed = false, acceptingJobs = v.acceptingJobs && w.acceptingJobs)
    }.getOrNull()
}

private fun epoch(value: String): Long = Instant.parse(value).toEpochMilli()
