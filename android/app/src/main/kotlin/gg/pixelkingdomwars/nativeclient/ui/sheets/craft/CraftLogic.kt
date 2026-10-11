package gg.pixelkingdomwars.nativeclient.ui.sheets.craft

import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.kit.tileCount
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeTone
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeUi
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.ItemTileState
import gg.pixelkingdomwars.nativeclient.ui.model.ItemTileUi
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.TabUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import java.util.Locale

/*
 * The pure rules of the craft cluster (craft/SPEC.md): time and count formatting, quantity limits, ingredient rows,
 * which primary each tab shows and why, default tabs, art names and sprite-atlas frames. No Compose. JVM-tested in
 * `CraftLogicTest`; the composables only call these.
 *
 * Money honesty (DESIGN-SYSTEM §9, design correction 7): an unknown count is "…", never "0"; an uncertain result is
 * "being checked" and keeps its recovery; only an authoritative refusal may say nothing was spent.
 */

/** The busy label while a refresh or a check runs. */
const val CHECKING_TEXT = "Checking…"

// ---------------------------------------------------------------------------------------------------------------- numbers

/** A whole count with thousands separators ("1,200"); null is "…". */
fun groupDigits(value: Long?): String = if (value == null) UNKNOWN else String.format(Locale.US, "%,d", value)

/** A job length as the mockups print it: "9m 00s", "1h 00m", "2d 4h". Null or negative is "…". */
fun craftDuration(seconds: Long?): String {
    if (seconds == null || seconds < 0) return UNKNOWN
    val d = seconds / 86_400; val h = seconds % 86_400 / 3_600; val m = seconds % 3_600 / 60; val s = seconds % 60
    return when {
        d > 0 -> "${d}d ${h}h"
        h > 0 -> String.format(Locale.US, "%dh %02dm", h, m)
        else -> String.format(Locale.US, "%dm %02ds", m, s)
    }
}

/** Time left on a running clock: "3:48" under an hour, "2h 10m" under a day, "1d 4h" above. Null is "…". */
fun timeLeft(seconds: Long?): String {
    if (seconds == null || seconds < 0) return UNKNOWN
    val d = seconds / 86_400; val h = seconds % 86_400 / 3_600; val m = seconds % 3_600 / 60; val s = seconds % 60
    return when {
        d > 0 -> "${d}d ${h}h"
        h > 0 -> String.format(Locale.US, "%dh %02dm", h, m)
        else -> String.format(Locale.US, "%d:%02d", m, s)
    }
}

/** A cadence without zero parts: "6h", "1h 30m", "45m", "30s". Null is "…". */
fun shortDuration(seconds: Long?): String {
    if (seconds == null || seconds < 0) return UNKNOWN
    val parts = listOf(seconds / 86_400 to "d", seconds % 86_400 / 3_600 to "h", seconds % 3_600 / 60 to "m", seconds % 60 to "s")
        .filter { it.first > 0 }
    return if (parts.isEmpty()) "0s" else parts.joinToString(" ") { "${it.first}${it.second}" }
}

/**
 * Whole seconds until [readyAtMs] on the server clock (the device clock [nowMs] plus [serverOffsetMs]), rounded up so a
 * timer never reads 0 early; 0 once due; null when the server gave no time.
 */
fun secondsLeft(readyAtMs: Long?, nowMs: Long, serverOffsetMs: Long = 0L): Long? {
    if (readyAtMs == null) return null
    val diff = readyAtMs - (nowMs + serverOffsetMs)
    return if (diff <= 0L) 0L else (diff + 999L) / 1000L
}

/** A countdown's text. At 0 it says "Checking…", never "Done": only the server says a job is done (SPEC §2.3). */
fun countdownText(seconds: Long?): String = when {
    seconds == null -> UNKNOWN
    seconds <= 0L -> CHECKING_TEXT
    else -> timeLeft(seconds)
}

/**
 * How far (0..1) a job running to [readyAtMs] is. Its start is [startedAtMs], else [totalSec] before the end; null when
 * neither is known. [stepMs] quantises the clock (reduced motion: the bar steps once a minute).
 */
fun jobProgress(startedAtMs: Long?, readyAtMs: Long?, totalSec: Long?, nowMs: Long, serverOffsetMs: Long = 0L, stepMs: Long = 1L): Float? {
    if (readyAtMs == null) return null
    val start = startedAtMs ?: totalSec?.let { readyAtMs - it * 1000L } ?: return null
    val raw = nowMs + serverOffsetMs
    val now = if (stepMs > 1L) raw - Math.floorMod(raw, stepMs) else raw
    val span = readyAtMs - start
    if (span <= 0L) return 1f
    return ((now - start).toFloat() / span).coerceIn(0f, 1f)
}

/** The bench slot line ("1 of 1 slot", "1 of 2 slots"). */
fun slotLine(used: Int, capacity: Int): String = "$used of $capacity slot" + if (capacity == 1) "" else "s"

/** A tile strip's count ("3"), with the "▸" scroll hint once it holds more tiles than fit before the peek ("8 ▸"). */
fun stripCount(count: Int): String = if (count > STRIP_VISIBLE_TILES) "$count ▸" else count.toString()

/** Whole 72 dp tiles a strip shows before the fifth peeks (SPEC §1 TileStrip). */
private const val STRIP_VISIBLE_TILES = 4

/** I, II, III, IV for the awning tiers; other numbers as digits. */
fun romanTier(tier: Int): String = when (tier) { 1 -> "I"; 2 -> "II"; 3 -> "III"; 4 -> "IV"; 5 -> "V"; else -> tier.toString() }

// ------------------------------------------------------------------------------------------------------------- quantities

/** [current] clamped to [min]..[max] (a max under min collapses to min). */
fun clampQuantity(current: Int, min: Int, max: Int): Int = current.coerceIn(min, maxOf(min, max))

/** One stepper press: [current] + [delta], clamped to [min]..[max] (SPEC §2.1 `onQty(delta)` clamps to 1..maxBatch). */
fun stepQuantity(current: Int, delta: Int, min: Int, max: Int): Int = clampQuantity(current + delta, min, max)

/** The Long form (Market lots). */
fun stepQuantity(current: Long, delta: Long, min: Long, max: Long): Long = (current + delta).coerceIn(min, maxOf(min, max))

/** The most ingots one cast may make: min(batch size, today's remaining, holding room); null while any is unknown. */
fun ingotCastMax(batchSize: Long?, dailyRemaining: Long?, holdingRemaining: Long?): Long? {
    if (batchSize == null || dailyRemaining == null || holdingRemaining == null) return null
    return minOf(batchSize, dailyRemaining, holdingRemaining).coerceAtLeast(0L)
}

// ------------------------------------------------------------------------------------------------------------ ingredients

/** One "YOU NEED" row (SPEC §1 IngredientRow), derived from a recipe input, the quantity and the stock. */
data class IngredientLine(
    val itemId: String,
    val icon: String,
    val name: String,
    val source: String,
    /** Available now; null = unknown. */
    val have: Long?,
    val need: Long,
    /** How many more are needed; null while [have] is unknown. */
    val missing: Long?,
    /** Non-null: this Workshop makes it, so GO selects that recipe in place (SPEC §2.2). */
    val goRecipeId: String?,
) {
    /** "36/24"; "…/24" while unknown. */
    val count: String get() = "${groupDigits(have)}/${groupDigits(need)}"
    /** The green OK tag shows only for a known, sufficient count. */
    val ok: Boolean get() = missing == 0L
    /** The blood row + GO. */
    val short: Boolean get() = (missing ?: 0L) > 0L
}

/** The rows for [inputs] × [quantity]. Shards inputs are left out (they are the cost pill). [countsKnown] false (a
 *  refresh is running) makes every "have" unknown. */
fun ingredientLines(inputs: List<RecipeInputUi>, quantity: Int, stock: Map<String, StockUi>, items: Map<String, CraftItemUi>,
    countsKnown: Boolean = true): List<IngredientLine> =
    inputs.filter { it.kind != InputKind.SHARDS }.map { input ->
        val item = items[input.itemId]
        val need = input.perUnit * quantity.coerceAtLeast(1)
        val have = if (countsKnown) stock[input.itemId]?.available else null
        IngredientLine(input.itemId, item?.icon ?: craftItemIcon(input.itemId), item?.name ?: input.itemId, item?.source.orEmpty(),
            have, need, have?.let { (need - it).coerceAtLeast(0L) }, item?.makeHereRecipeId)
    }

/** The Shards a recipe spends for [quantity], or null when it spends none. */
fun shardsCost(inputs: List<RecipeInputUi>, quantity: Int): Long? =
    inputs.filter { it.kind == InputKind.SHARDS }.takeIf { it.isNotEmpty() }?.sumOf { it.perUnit * quantity.coerceAtLeast(1) }

/** The cost pill preserves unknown funds as CHECKING; only observed funds can be sufficient. */
fun shardsPrice(cost: Long?, balance: Long?): PriceUi? = cost?.let {
    PriceUi(Currency.SHARDS, groupDigits(it), when { balance == null -> PriceStatus.CHECKING; balance < it -> PriceStatus.SHORT; else -> PriceStatus.OK })
}

/** The reason line under a primary that is off for a missing ingredient (SPEC §2.2). */
fun shortReason(lines: List<IngredientLine>): String? =
    lines.firstOrNull { it.short }?.let { "Need ${groupDigits(it.missing)} more ${it.name}. Tap GO." }

// ---------------------------------------------------------------------------------------------------------------- primary

/** What a tap on the sheet's one primary does. */
enum class PrimaryAction {
    /** Busy: nothing (the kit ignores taps). */
    NONE,
    /** Opens the review half sheet (or, on the Market BUY tab, asks the host for the Seal). */
    START,
    /** Reloads after an error. */
    RETRY,
    /** Opens the Need-more half sheet for the SHORT price. */
    NEED_MORE,
    /** Off or locked: shake 2 dp × 2 in 160 ms; the reason is already on screen; never opens a sheet. */
    SHAKE,
    /** Collect (server receipt for Forge Ingots; client-only acknowledgement for auto-delivered output). */
    COLLECT,
    /** Show the owned awning on the Market (free). */
    SHOW,
    /** Hide the awning (free). */
    HIDE,
    /** Opens Profile › WALLET. */
    LINK_WALLET,
    /** Switches to the ORDERS tab. */
    OPEN_ORDERS,
    /** Switches to the SELL tab. */
    OPEN_SELL,
    /** Opens the system Upgrade half sheet. */
    UPGRADE,
}

/** The resolved primary of a tab: what PrimaryButton draws, the cost pill above it, and what a tap does. */
data class CraftPrimaryUi(
    val label: String,
    val sub: String?,
    val state: CommandState,
    val verb: Verb,
    val reason: String?,
    val price: PriceUi?,
    val action: PrimaryAction,
    val badge: BadgeUi? = null,
)

/** The green "!" of a ready primary or tab. */
val READY_BADGE = BadgeUi("!", BadgeTone.READY, "Ready to collect")

internal fun busyPrimary(label: String) =
    CraftPrimaryUi(label, null, CommandState.BUSY, Verb.STONE, null, null, PrimaryAction.NONE)

internal fun offPrimary(label: String, sub: String?, reason: String, price: PriceUi? = null) =
    CraftPrimaryUi(label, sub, CommandState.DISABLED, Verb.GOLD, reason, price, PrimaryAction.SHAKE)

internal fun lockedPrimary(label: String, reason: String?) =
    CraftPrimaryUi(label, null, CommandState.LOCKED, Verb.CHARCOAL, reason, null, PrimaryAction.SHAKE)

/** A priced primary by its price status (design correction 7): SHORT opens Need-more, UNAVAILABLE is off, CHECKING and
 *  OK are enabled (the review re-reads the price). */
internal fun pricedPrimary(label: String, sub: String?, price: PriceUi?, verb: Verb, action: PrimaryAction): CraftPrimaryUi = when (price?.status) {
    PriceStatus.SHORT -> CraftPrimaryUi(label, sub, CommandState.SHORT, verb, null, price, PrimaryAction.NEED_MORE)
    PriceStatus.UNAVAILABLE -> CraftPrimaryUi(label, sub, CommandState.DISABLED, verb, "The price is unavailable right now.", price, PrimaryAction.SHAKE)
    else -> CraftPrimaryUi(label, sub, CommandState.ENABLED, verb, null, price, action)
}

/**
 * The states every primary checks first (SPEC §5): a refresh shows busy dots (the last view stays), an error offers
 * "Try again", a request in flight is busy, an uncertain one is "Being checked", and a saved request turns the primary
 * off until it is checked. Null = none applies.
 */
fun commonGate(hydration: CraftHydration, submit: SubmitUi, saved: SavedOpUi?, label: String, sub: String?,
    loadingLabel: String = CHECKING_TEXT): CraftPrimaryUi? = when {
    hydration is CraftHydration.Loading -> busyPrimary(loadingLabel)
    hydration is CraftHydration.Error -> CraftPrimaryUi("Try again", null, CommandState.ENABLED, Verb.STONE, null, null, PrimaryAction.RETRY)
    submit.stage == SubmitStage.SENDING -> busyPrimary(submit.busyLabel)
    submit.stage == SubmitStage.CHECKING -> busyPrimary("Being checked")
    saved != null -> offPrimary(label, sub, "Check the request from earlier first.")
    else -> null
}

/** The line shown under the primary for the submit stage. CHECKING never claims nothing was spent; only REFUSED
 *  (an authoritative server refusal) may. */
fun submitNotice(submit: SubmitUi): String? = when (submit.stage) {
    SubmitStage.CHECKING -> "The answer got lost. It is being checked; wait before starting another."
    SubmitStage.REFUSED -> submit.message ?: "The server refused it. Nothing was spent."
    SubmitStage.IDLE, SubmitStage.SENDING -> null
}

/** Why new work is off: a read-only base first, then a server pause ("New refining is paused"). */
fun pausedReason(actionsAllowed: Boolean, acceptingJobs: Boolean, work: String = "refining"): String? = when {
    !actionsAllowed -> "Orders are paused on this base"
    !acceptingJobs -> "New $work is paused"
    else -> null
}

/** Busy "Bench busy · 3:48" while the bench is full; null when a slot is free (a server queue: SPEC §2.3). */
fun benchBusy(jobs: List<BenchJobUi>, capacity: Int, acceptingJobs: Boolean, nowMs: Long, serverOffsetMs: Long): CraftPrimaryUi? {
    val job = jobs.minByOrNull { it.readyAtMs } ?: return null
    if (acceptingJobs && capacity > jobs.size) return null
    return busyPrimary("Bench busy · ${countdownText(secondsLeft(job.readyAtMs, nowMs, serverOffsetMs))}")
}

// --------------------------------------------------------------------------------------------------------- workshop REFINE

/** The selected recipe, or the first one. */
fun selectedRecipe(ui: WorkshopRefineUi): RecipeUi? = ui.recipes.firstOrNull { it.recipeId == ui.selectedRecipeId } ?: ui.recipes.firstOrNull()

/** "REFINE 6" for refining, "CRAFT 2" for kits. */
fun refineLabel(recipe: RecipeUi, quantity: Int): String = (if (recipe.group == RecipeGroup.KIT) "CRAFT " else "REFINE ") + quantity

/** The REFINE tab's quantity, clamped to 1..maxBatch. */
fun refineQuantity(ui: WorkshopRefineUi): Int = clampQuantity(ui.quantity, 1, ui.maxBatch)

/** The REFINE tab's ingredient rows for the selected recipe. */
fun refineLines(ui: WorkshopRefineUi): List<IngredientLine> {
    val recipe = selectedRecipe(ui) ?: return emptyList()
    return ingredientLines(recipe.inputs, refineQuantity(ui), ui.stock, ui.items, ui.hydration != CraftHydration.Loading)
}

/** The Shards a review of the selected recipe spends, independent of the primary's gates (the review half sheet shows
 *  it while the footer behind it is closed). Null when the recipe spends no Shards. */
fun refineShardsPrice(ui: WorkshopRefineUi): PriceUi? =
    selectedRecipe(ui)?.let { shardsPrice(shardsCost(it.inputs, refineQuantity(ui)), ui.shards) }

/** The REFINE primary (SPEC §2.1 states, §2.2 short, §2.3 busy). Null when there are no recipes (empty state). */
fun refinePrimary(ui: WorkshopRefineUi, nowMs: Long): CraftPrimaryUi? {
    val recipe = selectedRecipe(ui) ?: return null
    val qty = refineQuantity(ui)
    val label = refineLabel(recipe, qty)
    val sub = "takes ${craftDuration(recipe.secondsPerUnit?.let { it * qty })}"
    commonGate(ui.hydration, ui.submit, ui.savedOperation, label, sub, "Checking stock")?.let { return it }
    benchBusy(ui.pendingJobs, ui.benchCapacity, ui.acceptingJobs, nowMs, ui.serverOffsetMs)?.let { return it }
    pausedReason(ui.actionsAllowed, ui.acceptingJobs)?.let { return offPrimary(label, sub, it) }
    recipe.locked?.let { return lockedPrimary(it.requirement, it.line) }
    val price = shardsPrice(shardsCost(recipe.inputs, qty), ui.shards)
    shortReason(refineLines(ui))?.let { return offPrimary(label, sub, it, price) }
    return pricedPrimary(label, sub, price, Verb.GOLD, PrimaryAction.START)
}

/** One recipe tile and whether it is locked. */
data class RecipeTile(val tile: ItemTileUi, val locked: Boolean)

/**
 * The tiles of one [group]: the output icon and the count held ("x14", "…" while unknown). The selected one has the
 * gold rim; an output that is a short input of the selected recipe has the missing style (red "0"); all stay tappable.
 */
fun recipeTiles(ui: WorkshopRefineUi, group: RecipeGroup): List<RecipeTile> {
    val known = ui.hydration != CraftHydration.Loading
    val selected = selectedRecipe(ui)
    val missing = refineLines(ui).filter { it.short }.map { it.itemId }.toSet()
    return ui.recipes.filter { it.group == group }.map { recipe ->
        val item = ui.items[recipe.outputItemId]
        val held = if (known) ui.stock[recipe.outputItemId]?.available else null
        val isMissing = recipe.outputItemId in missing
        val state = when {
            recipe.recipeId == selected?.recipeId -> ItemTileState.SELECTED
            isMissing -> ItemTileState.MISSING
            else -> ItemTileState.OWNED
        }
        val count = when {
            held == null -> UNKNOWN
            isMissing -> tileCount(held)
            else -> "x" + tileCount(held)
        }
        val name = item?.name ?: recipe.outputItemId
        val spoken = listOfNotNull("$name, ${if (held == null) "count unknown" else "$held held"}",
            if (state == ItemTileState.SELECTED) "selected" else null, recipe.locked?.line).joinToString(", ")
        RecipeTile(ItemTileUi(recipe.recipeId, item?.icon ?: craftItemIcon(recipe.outputItemId), count, spoken, state), recipe.locked != null)
    }
}

/** The header wells for the REFINE tab: the selected recipe's first input → its output. The input is 45 % when short
 *  (SPEC §2.2); while the bench works the input is 35 % and the output 50 % (§2.3). */
fun refineWells(ui: WorkshopRefineUi): Pair<CraftWellUi?, CraftWellUi?> {
    val recipe = selectedRecipe(ui) ?: return null to null
    val working = ui.pendingJobs.isNotEmpty()
    val lines = refineLines(ui)
    val first = lines.firstOrNull()
    val inputIcon = first?.icon ?: if (recipe.inputs.any { it.kind == InputKind.SHARDS }) "shards" else null
    val input = inputIcon?.let {
        CraftWellUi(it, when { working -> 0.35f; first?.short == true -> 0.45f; else -> 1f }, "Input: ${first?.name ?: "Shards"}")
    }
    val outItem = ui.items[recipe.outputItemId]
    val output = CraftWellUi(outItem?.icon ?: craftItemIcon(recipe.outputItemId), if (working) 0.5f else 1f, "Output: ${outItem?.name ?: recipe.outputItemId}")
    return input to output
}

// --------------------------------------------------------------------------------------------------------- workshop INGOTS

/** The most ingots the stepper allows now; null while unknown. */
fun ingotQuantityMax(ui: WorkshopIngotsUi): Long? =
    ingotCastMax(ui.batch.size, ui.allowance.daily.remaining, ui.allowance.holding.remaining)

/** The INGOTS quantity clamped to 1..max. */
fun ingotQuantity(ui: WorkshopIngotsUi): Int = clampQuantity(ui.quantity, 1, (ingotQuantityMax(ui) ?: 1L).coerceAtMost(Int.MAX_VALUE.toLong()).toInt())

/** A retained or partial body is not proof that the bench is empty. Price hydration is independent. */
fun ingotsObservationKnown(ui: WorkshopIngotsUi): Boolean = ui.saved == null && ui.hydration == CraftHydration.Ready &&
    ui.inventory.held != null && ui.inventory.pending != null &&
    ui.allowance.daily.let { it.used != null && it.cap != null && it.remaining != null } &&
    ui.allowance.holding.let { it.held != null && it.pending != null && it.cap != null && it.remaining != null } &&
    ui.batch.size?.let { it > 0 } == true

fun ingotsBenchLabel(ui: WorkshopIngotsUi): String = when {
    !ingotsObservationKnown(ui) -> "unknown"
    ui.job == null -> "empty"
    else -> slotLine(1, 1)
}

fun ingotsBenchUnknownText(ui: WorkshopIngotsUi): String =
    if (ui.saved != null) "Workshop inventory and bench have not been confirmed. Check the original receipt first."
    else "Workshop inventory and bench have not been confirmed."

/** The host binds this dedicated callback ONLY to WorkshopRepository.check(). Never use the generic
 * saved/review/confirm/retry adapter, which may resume a POST. The exact original key stays unchanged. */
fun ingotsOriginalCheck(ui: WorkshopIngotsUi, on: WorkshopSheetActions): ((String) -> Unit)? {
    val saved = ui.saved?.takeUnless { it.checking } ?: return null
    val check = on.ingots.onCheckOriginalReceipt ?: return null
    return { key -> if (key == saved.opId) check(key) }
}

/** The INGOTS primary (SPEC §2.5): COLLECT with the receipt sequence, else CAST with its limits. */
fun ingotsPrimary(ui: WorkshopIngotsUi, nowMs: Long): CraftPrimaryUi {
    val job = ui.job
    when (ui.collect) {
        CollectStage.COLLECTING -> return busyPrimary("Collecting")
        CollectStage.COLLECTED -> return CraftPrimaryUi("COLLECTED", null, CommandState.ENABLED, Verb.MOSS, null, null, PrimaryAction.NONE)
        CollectStage.FAILED, CollectStage.IDLE -> Unit
    }
    if (job?.state == IngotJobState.COLLECTING) return busyPrimary("Collecting")
    val qty = ingotQuantity(ui)
    val label = "CAST $qty"
    val sub = "takes ${craftDuration(ui.secondsPerIngot?.let { it * qty })}"
    // Preserve observed in-flight work; saved originals still pre-empt generic reload/retry actions.
    if (ui.submit.stage == SubmitStage.SENDING) return busyPrimary(ui.submit.busyLabel)
    if (ui.submit.stage == SubmitStage.CHECKING) return busyPrimary("Being checked")
    if (ui.saved != null) return offPrimary("CAST", null, "Check the original receipt first.")
    commonGate(ui.hydration, ui.submit, null, label, sub)?.let { return it }
    if (!ingotsObservationKnown(ui)) return offPrimary("CAST", null, ingotsBenchUnknownText(ui))
    if (ui.collect == CollectStage.FAILED) {
        if (!ui.actionsAllowed) return offPrimary("RETRY", "Forge Ingots", "This Workshop view is read-only.")
        return CraftPrimaryUi("RETRY", "Forge Ingots", CommandState.ENABLED, Verb.RED, null, null, PrimaryAction.COLLECT)
    }
    if (job?.state == IngotJobState.READY) {
        val collectLabel = "COLLECT ${groupDigits(job.ingots)}"
        if (!ui.actionsAllowed) return offPrimary(collectLabel, "Forge Ingots", "This Workshop view is read-only.")
        return CraftPrimaryUi(collectLabel, "Forge Ingots", CommandState.ENABLED, Verb.GOLD, null, null, PrimaryAction.COLLECT, READY_BADGE)
    }
    if (job?.state == IngotJobState.RUNNING) return busyPrimary("Casting · ${countdownText(secondsLeft(job.readyAtMs, nowMs, ui.serverOffsetMs))}")
    val price = ui.shardsPerIngot?.let { shardsPrice(it * qty, ui.shards) } ?: PriceUi(Currency.SHARDS, null, PriceStatus.CHECKING)
    if (!ui.actionsAllowed) return offPrimary(label, sub, "Orders are paused on this base", price)
    if (ui.allowance.daily.remaining == 0L) {
        val resets = timeLeft(secondsLeft(ui.allowance.resetsAtMs, nowMs, ui.serverOffsetMs))
        return offPrimary(label, sub, "Today's ${groupDigits(ui.allowance.daily.cap)} are cast. Resets in $resets.", price)
    }
    if (ui.allowance.holding.remaining == 0L) return offPrimary(label, sub, "Holding room is full. Smelt some at the Gold Forge.", price)
    return pricedPrimary(label, sub, price, Verb.GOLD, PrimaryAction.START)
}

// ------------------------------------------------------------------------------------------------- saved requests (§5)

/** Where the one door under a saved request's recovery row leads (SPEC §5; the archive of anything unproven lives in
 *  History, never in the main flow). */
enum class SavedDoor {
    /** The owner's explicit archive of a proven request (its `finish()`); a delivered result then celebrates. */
    FINISH,
    /** The owner's same-key re-review of an unsent draft, reopening the review half sheet in place. */
    REVIEW,
    /** The owner's original-records view (History), where checks, re-reviews and archives of the rest live. */
    HISTORY,
}

/** The saved request's door: a [proven] request finishes; an unsent draft (not [declined], not [attempted]) re-reviews
 *  when the owner can review it now ([canReview]: orders allowed, same kingdom); everything else opens History. */
fun savedRequestDoor(proven: Boolean, declined: Boolean, attempted: Boolean, canReview: Boolean): SavedDoor = when {
    proven -> SavedDoor.FINISH
    !declined && !attempted && canReview -> SavedDoor.REVIEW
    else -> SavedDoor.HISTORY
}

// ---------------------------------------------------------------------------------------------------------- workshop TOOLS

/** The selected tool recipe, or the first. */
fun selectedTool(ui: WorkshopToolsUi): ToolRecipeUi? = ui.recipes.firstOrNull { it.recipeId == ui.selectedRecipeId } ?: ui.recipes.firstOrNull()

/** The selected tool's rows (quantity is fixed at 1: SPEC 0.9). */
fun toolLines(ui: WorkshopToolsUi): List<IngredientLine> {
    val tool = selectedTool(ui) ?: return emptyList()
    return ingredientLines(tool.inputs, 1, ui.stock, ui.items, ui.hydration != CraftHydration.Loading)
}

/** The TOOLS primary: full-width "CRAFT COMPASS", no stepper. */
fun toolsPrimary(ui: WorkshopToolsUi, nowMs: Long): CraftPrimaryUi? {
    val tool = selectedTool(ui) ?: return null
    val label = "CRAFT ${tool.shortName}"
    val sub = "takes ${craftDuration(tool.durationSec)}"
    commonGate(ui.hydration, ui.submit, ui.saved, label, sub)?.let { return it }
    benchBusy(listOfNotNull(ui.job), 1, ui.acceptingJobs, nowMs, ui.serverOffsetMs)?.let { return it }
    pausedReason(ui.actionsAllowed, ui.acceptingJobs, "crafting")?.let { return offPrimary(label, sub, it) }
    tool.locked?.let { return lockedPrimary(it.requirement, it.line) }
    val price = shardsPrice(shardsCost(tool.inputs, 1), ui.shards)
    shortReason(toolLines(ui))?.let { return offPrimary(label, sub, it, price) }
    return pricedPrimary(label, sub, price, Verb.GOLD, PrimaryAction.START)
}

/** The TravelRow lines ("1 compass is out on a trip", "Back at the Lodge in 2h 10m"), or null when nothing is away. */
fun travelSummary(ui: WorkshopToolsUi, nowMs: Long): Pair<String, String>? {
    if (ui.travelling.isEmpty()) return null
    val kinds = ui.travelling.map { it.itemId }.toSet()
    val first = if (ui.travelling.size == 1) {
        val short = ui.recipes.firstOrNull { it.itemId == kinds.first() }?.shortName?.lowercase(Locale.US) ?: "tool"
        "1 $short is out on a trip"
    } else "${ui.travelling.size} tools are out on a trip"
    val soonest = ui.travelling.minOf { it.returnsAtMs }
    return first to "Back at the Lodge in ${timeLeft(secondsLeft(soonest, nowMs, ui.serverOffsetMs))}"
}

// ---------------------------------------------------------------------------------------------------------- workshop STYLE

/** An awning tier's state (SPEC §2.7 TierPicker). */
enum class AwningTierState { APPLIED, OWNED, CRAFTABLE, LOCKED }

fun awningTierState(tier: AwningTierUi, appliedTier: Int?): AwningTierState = when {
    tier.owned && appliedTier == tier.tier -> AwningTierState.APPLIED
    tier.owned -> AwningTierState.OWNED
    tier.craftable -> AwningTierState.CRAFTABLE
    else -> AwningTierState.LOCKED
}

/** The tier's tag: ON (green), OWNED (stone), CRAFT (gold), MKT n (stone). */
fun awningTag(tier: AwningTierUi, appliedTier: Int?): Pair<String, Verb> = when (awningTierState(tier, appliedTier)) {
    AwningTierState.APPLIED -> "ON" to Verb.GREEN
    AwningTierState.OWNED -> "OWNED" to Verb.STONE
    AwningTierState.CRAFTABLE -> "CRAFT" to Verb.GOLD
    AwningTierState.LOCKED -> "MKT ${tier.requiredMarketLevel}" to Verb.STONE
}

/** The tier selected by default: the first craftable one not yet owned, else the applied one, else the first. */
fun defaultAwningTier(awning: AwningUi): Int? =
    awning.tiers.firstOrNull { it.craftable && !it.owned }?.tier ?: awning.appliedTier ?: awning.tiers.firstOrNull()?.tier

/** The selected tier. */
fun selectedAwning(ui: WorkshopStyleUi): AwningTierUi? {
    val tier = ui.selectedTier ?: defaultAwningTier(ui.awning)
    return ui.awning.tiers.firstOrNull { it.tier == tier } ?: ui.awning.tiers.firstOrNull()
}

/** The STYLE rows: the wake recipe's inputs when the wake is selected, else the selected awning tier's. */
fun styleLines(ui: WorkshopStyleUi): List<IngredientLine> {
    val inputs = if (ui.wakeSelected) ui.wake.recipe?.inputs.orEmpty() else selectedAwning(ui)?.inputs.orEmpty()
    return ingredientLines(inputs, 1, ui.stock, ui.items, ui.hydration != CraftHydration.Loading)
}

/** The STYLE primary (SPEC §2.7): craft a tier or the wake (gold); an owned tier is a free green SHOW ON MARKET or stone
 *  HIDE; a tier above the Market's level is locked; an unverified preview holds crafting. */
fun stylePrimary(ui: WorkshopStyleUi, nowMs: Long): CraftPrimaryUi? {
    if (ui.wakeSelected) {
        if (ui.wake.owned) return null
        val recipe = ui.wake.recipe ?: return null
        val label = "CRAFT WAKE"
        val sub = "takes ${craftDuration(recipe.durationSec)} · once"
        return craftablePrimary(ui, label, sub, recipe.inputs, nowMs)
    }
    val tier = selectedAwning(ui) ?: return null
    val roman = romanTier(tier.tier)
    val label = "CRAFT AWNING $roman"
    val sub = "takes ${craftDuration(tier.durationSec)} · once"
    commonGate(ui.hydration, ui.submit, ui.saved, label, sub)?.let { return it }
    if (!ui.awning.previewVerified) return offPrimary(label, sub, "Preview unavailable. Crafting is held.")
    val needsMarket = "Market ${tier.requiredMarketLevel}"
    val marketTooLow = ui.marketLevel == null || ui.marketLevel < tier.requiredMarketLevel
    return when (awningTierState(tier, ui.awning.appliedTier)) {
        AwningTierState.APPLIED -> CraftPrimaryUi("HIDE", "free", CommandState.ENABLED, Verb.STONE, null, null, PrimaryAction.HIDE)
        AwningTierState.OWNED -> if (marketTooLow) lockedPrimary(needsMarket, tier.lockReason?.line ?: "Shows on a level ${tier.requiredMarketLevel} Market.")
            else CraftPrimaryUi("SHOW ON MARKET", "free", CommandState.ENABLED, Verb.GREEN, null, null, PrimaryAction.SHOW)
        AwningTierState.LOCKED -> lockedPrimary(needsMarket, tier.lockReason?.line)
        AwningTierState.CRAFTABLE -> craftablePrimary(ui, label, sub, tier.inputs, nowMs)
    }
}

private fun craftablePrimary(ui: WorkshopStyleUi, label: String, sub: String, inputs: List<RecipeInputUi>, nowMs: Long): CraftPrimaryUi {
    commonGate(ui.hydration, ui.submit, ui.saved, label, sub)?.let { return it }
    benchBusy(listOfNotNull(ui.job), 1, ui.acceptingJobs, nowMs, ui.serverOffsetMs)?.let { return it }
    pausedReason(ui.actionsAllowed, ui.acceptingJobs, "crafting")?.let { return offPrimary(label, sub, it) }
    val price = shardsPrice(shardsCost(inputs, 1), ui.shards)
    shortReason(styleLines(ui))?.let { return offPrimary(label, sub, it, price) }
    return pricedPrimary(label, sub, price, Verb.GOLD, PrimaryAction.START)
}

// -------------------------------------------------------------------------------------------------------------- harvester

/** The Harvester YIELD primary (SPEC §4.1-§4.2 and the interval table). Null hides the footer primary (max level). */
fun harvesterPrimary(ui: HarvesterYieldUi): CraftPrimaryUi? {
    if (!ui.complete) return lockedPrimary("Finish building first", null)
    val unseen = ui.arrived.unseenQuantity
    // A client-only acknowledgement (SPEC 0.2): no server call, so it works while a refresh runs or on a read-only base.
    if (unseen > 0L) return CraftPrimaryUi("COLLECT ${groupDigits(unseen)}", "already safe in your stores", CommandState.ENABLED,
        Verb.GOLD, null, null, PrimaryAction.COLLECT, READY_BADGE)
    val startLabel = if (ui.interval.state == IntervalState.ENDED) "START AGAIN" else "START"
    return when (ui.interval.state) {
        IntervalState.NONE, IntervalState.ENDED -> {
            commonGate(ui.hydration, ui.submit, ui.saved, startLabel, null)?.let { return it }
            if (!ui.actionsAllowed) offPrimary(startLabel, null, "Orders are paused on this base")
            else CraftPrimaryUi(startLabel, null, CommandState.ENABLED, Verb.GOLD, null, null, PrimaryAction.START)
        }
        IntervalState.RUNNING -> {
            val cost = ui.upgradeCost ?: return null
            commonGate(ui.hydration, ui.submit, ui.saved, "UPGRADE", ui.nextLevelDelta)?.let { return it }
            if (!ui.actionsAllowed) offPrimary("UPGRADE", ui.nextLevelDelta, "Orders are paused on this base", cost)
            else pricedPrimary("UPGRADE", ui.nextLevelDelta, cost, Verb.GREEN, PrimaryAction.UPGRADE)
        }
    }
}

/** The Harvester footer note: "Hauls arrive on their own. Nothing to tap." while gathering, "Next haul in 6h 00m." once a
 *  haul arrived. */
fun harvesterNote(ui: HarvesterYieldUi, nowMs: Long): String = when {
    ui.arrived.unseenQuantity > 0L -> "Next haul in ${timeLeft(secondsLeft(ui.interval.nextHaulAtMs, nowMs, ui.serverOffsetMs))}."
    ui.interval.state == IntervalState.RUNNING -> "Hauls arrive on their own. Nothing to tap."
    else -> "This starts a new interval. Earned units stay owed to their kingdom."
}

// ------------------------------------------------------------------------------------------------------- headers, live chip

/** The Workshop header for a bench [state] at [tier] (SPEC §2 header table): working plays the 9-frame loop at 8 fps. */
fun workshopHeader(tier: Int?, state: BenchSprite): CraftHeaderUi =
    CraftHeaderUi(workshopSprite(tier, state), loop = if (state == BenchSprite.WORKING) CraftAtlases.workshopWorking(tier) else null, loopFps = 8)

/** The Workshop bench state from the sheet's own observed jobs: ready while an ingot batch waits on the bench (or is being
 *  collected), working while any ingot, refine, tool or style job runs, otherwise idle. */
fun workshopBenchSprite(ui: WorkshopSheetUi): BenchSprite {
    val ingot = ui.ingots?.job?.state
    return when {
        ingot == IngotJobState.READY || ingot == IngotJobState.COLLECTING -> BenchSprite.READY
        ingot == IngotJobState.RUNNING || ui.refine?.pendingJobs?.isNotEmpty() == true || ui.tools?.job != null ||
            ui.style?.job != null -> BenchSprite.WORKING
        else -> BenchSprite.IDLE
    }
}

/** The header a sheet draws: its own sprite when it has one; otherwise, when the host admitted a server art tier
 *  ([hostTier], from `craftBuildingArtTier`), the Workshop at that tier in its bench state, keeping the tab's wells. No
 *  tier keeps the honest grass-only header (never a tier-one guess). */
fun workshopHeaderArt(ui: WorkshopSheetUi, hostTier: Int?): CraftHeaderUi =
    if (ui.header.sprite != null || hostTier == null) ui.header
    else workshopHeader(hostTier, workshopBenchSprite(ui)).copy(input = ui.header.input, output = ui.header.output)

/** The Market header (SPEC §3 header): the 8-frame working strip at 6 fps, or the static awning sprite when one is shown. */
fun marketHeader(tier: Int?, appliedAwningTier: Int?): CraftHeaderUi =
    if (appliedAwningTier != null) CraftHeaderUi(awningSprite(appliedAwningTier))
    else CraftHeaderUi(marketSprite(tier), loop = CraftAtlases.marketWorking(tier), loopFps = 6)

/** The Workshop live chip, ticking (SPEC §2.0 state lines): ingots ready (green), "Refining · 3:48", "Casting · 1:35",
 *  "Crafting · 21:00", else the mapper's chip or "Free to work". */
fun workshopLive(ui: WorkshopSheetUi, nowMs: Long): CraftLiveUi {
    val ingots = ui.ingots
    val ingotJob = ingots?.job
    if (ingotJob != null && ingotJob.state == IngotJobState.READY) {
        return CraftLiveUi("ui:ready-status", "${groupDigits(ingotJob.ingots)} ingots ready", ready = true)
    }
    val refine = ui.refine
    val refineJob = refine?.pendingJobs?.minByOrNull { it.readyAtMs }
    if (refine != null && refineJob != null) {
        return CraftLiveUi("timer", "Refining ·", countdownText(secondsLeft(refineJob.readyAtMs, nowMs, refine.serverOffsetMs)))
    }
    if (ingots != null && ingotJob != null && ingotJob.state == IngotJobState.RUNNING) {
        return CraftLiveUi("timer", "Casting ·", countdownText(secondsLeft(ingotJob.readyAtMs, nowMs, ingots.serverOffsetMs)))
    }
    val tools = ui.tools
    val style = ui.style
    val craftJob = tools?.job ?: style?.job
    if (craftJob != null) {
        val offset = if (tools?.job != null) tools.serverOffsetMs else style?.serverOffsetMs ?: 0L
        return CraftLiveUi("timer", "Crafting ·", countdownText(secondsLeft(craftJob.readyAtMs, nowMs, offset)))
    }
    return ui.frame.live ?: CraftLiveUi("ui:ready-status", "Free to work")
}

/** The Harvester live chip, ticking (SPEC §4 header): green "12 ore arrived", or "Next haul 2h 10m". */
fun harvesterLive(ui: HarvesterYieldUi, nowMs: Long, fallback: CraftLiveUi?): CraftLiveUi? = when {
    ui.arrived.unseenQuantity > 0L -> CraftLiveUi("ui:ready-status", "${groupDigits(ui.arrived.unseenQuantity)} ${ui.arrivedNoun} arrived", ready = true)
    ui.interval.state == IntervalState.RUNNING ->
        CraftLiveUi("timer", "Next haul", timeLeft(secondsLeft(ui.interval.nextHaulAtMs, nowMs, ui.serverOffsetMs)))
    else -> fallback
}

// ------------------------------------------------------------------------------------------------------------------ tabs

/** The Workshop's registry / Destination tab ids (UX-ARCHITECTURE §4.2: REFINE · INGOTS · EQUIPMENT · COSMETICS). */
object WorkshopTab {
    const val REFINE = "REFINE"
    const val INGOTS = "INGOTS"
    const val EQUIPMENT = "EQUIPMENT"
    const val COSMETICS = "COSMETICS"
}

/** The Market's registry / Destination tab ids (BUY · SELL · MY ORDERS · COLLECTION). */
object MarketTab {
    const val BUY = "BUY"
    const val SELL = "SELL"
    const val ORDERS = "MY ORDERS"
    const val OWNED = "COLLECTION"
}

/** The Harvester's tab ids. */
object HarvesterTab {
    const val YIELD = "YIELD"
    const val HISTORY = "HISTORY"
}

/** The Workshop's stacked tabs (SPEC 0.1: visible labels REFINE · INGOTS · TOOLS · STYLE, ids unchanged). Only tabs in
 *  [available] (the registry's gates) are listed; INGOTS carries the green "!" when [ingotsReady]. */
fun workshopTabs(available: Collection<String> = listOf(WorkshopTab.REFINE, WorkshopTab.INGOTS, WorkshopTab.EQUIPMENT, WorkshopTab.COSMETICS),
    ingotsReady: Boolean = false, unseenTab: String? = null): List<TabUi> = listOf(
    TabUi(WorkshopTab.REFINE, "ui:workshop-menu", "REFINE", null, false),
    TabUi(WorkshopTab.INGOTS, "craft:inv_forge_ingot", "INGOTS", null, false),
    TabUi(WorkshopTab.EQUIPMENT, "craft:item_route_compass", "TOOLS", null, false),
    TabUi(WorkshopTab.COSMETICS, "craft:item_awning", "STYLE", null, false),
).filter { it.id in available }.map { tab ->
    val ready = (tab.id == WorkshopTab.INGOTS && ingotsReady) || tab.id == unseenTab
    if (ready) tab.copy(badge = READY_BADGE) else tab
}

/** The Market's stacked tabs (BUY · SELL · ORDERS · OWNED); ORDERS carries the green "!" when a lot sold. */
fun marketTabs(soldSinceLastVisit: Boolean = false): List<TabUi> = listOf(
    TabUi(MarketTab.BUY, "ui:market-menu", "BUY", null, false),
    TabUi(MarketTab.SELL, "craft:ingot_crate", "SELL", null, false),
    TabUi(MarketTab.ORDERS, "ui:queue-status", "ORDERS", if (soldSinceLastVisit) BadgeUi("!", BadgeTone.READY, "A lot sold") else null, false),
    TabUi(MarketTab.OWNED, "itm_deed_earth", "OWNED", null, false),
)

/** The Harvester's two side-by-side tabs. */
fun harvesterTabs(): List<TabUi> = listOf(
    TabUi(HarvesterTab.YIELD, "ui:harvester-menu", "YIELD", null, false),
    TabUi(HarvesterTab.HISTORY, "replay", "HISTORY", null, false),
)

// --------------------------------------------------------------------------------------------------------- default tabs

/** The Workshop's opening tab (SPEC §2 Entry): INGOTS when an ingot job is ready, else the tab of an unseen finished
 *  job, else the last-used tab, else REFINE. Only tabs in [available] are chosen. */
fun workshopDefaultTab(ingotReady: Boolean, unseenDoneTab: String?, lastTab: String?, available: List<String>): String {
    val tabs = available.ifEmpty { listOf(WorkshopTab.REFINE) }
    if (ingotReady && WorkshopTab.INGOTS in tabs) return WorkshopTab.INGOTS
    if (unseenDoneTab != null && unseenDoneTab in tabs) return unseenDoneTab
    if (lastTab != null && lastTab in tabs) return lastTab
    return if (WorkshopTab.REFINE in tabs) WorkshopTab.REFINE else tabs.first()
}

/** The Market's opening tab (SPEC §3 Entry): ORDERS when a lot sold since the last visit, else BUY. */
fun marketDefaultTab(soldSinceLastVisit: Boolean, available: List<String>): String {
    val tabs = available.ifEmpty { listOf(MarketTab.BUY) }
    if (soldSinceLastVisit && MarketTab.ORDERS in tabs) return MarketTab.ORDERS
    return if (MarketTab.BUY in tabs) MarketTab.BUY else tabs.first()
}

// ------------------------------------------------------------------------------------------------------------- art names

/** A catalogue id in snake case: "CrownIronOre", "crown-iron-ore" and "crown_iron_ore" are all "crown_iron_ore". */
fun catalogueKey(itemId: String): String =
    itemId.trim().replace(Regex("(?<=[a-z0-9])(?=[A-Z])"), "_").replace('-', '_').replace(' ', '_').lowercase(Locale.US)

private val INVENTORY_ART = setOf(
    "frost_quartz", "frostglass", "heartwood_logs", "heartwood_beams", "sunstone_rubble", "sunstone_blocks", "crown_iron_ore",
    "crownsteel", "rough_prism", "prismstone_lens", "storm_ore", "stormalloy", "thorn_fibre", "thornsilk", "ember_nodules",
    "embercore", "forge_ingot",
)

private val NAMED_ART = mapOf(
    "navigation_kit" to "ui:navigation-kit", "climate_kit" to "ui:climate-kit", "expedition_kit" to "ui:expedition-kit",
    "crystal_fragments" to "ui:crystal-fragments", "renown" to "ui:renown", "exp" to "ui:exp",
    "route_compass" to "craft:item_route_compass", "survey_lens" to "craft:item_survey_lens", "aurora_wake" to "craft:item_aurora_wake",
    "artisan_market_awning" to "craft:item_awning", "market_awning" to "craft:item_awning",
    "shards" to "shards", "shard" to "shards", "gems" to "gem", "gem" to "gem", "keep" to "keep", "sol" to "sol",
    "land_deed" to "itm_deed_earth", "deed" to "itm_deed_earth",
)

/** The icon of a catalogue item; an item without bundled art gets the drawn "?" glyph (never another item's art). */
fun craftItemIcon(itemId: String): String {
    val key = catalogueKey(itemId)
    return if (key in INVENTORY_ART) "craft:inv_$key" else NAMED_ART[key] ?: "shape:unknown"
}

/** A tier for art lookup, 1..4. The tier itself comes from the server's building art map (SPEC §2: never computed). */
fun artTier(tier: Int?): Int = (tier ?: 1).coerceIn(1, 4)

/** The Workshop bench sprite states (SPEC §2 header table). */
enum class BenchSprite(val key: String) { IDLE("idle"), WORKING("working"), READY("ready"), UPGRADING("construction") }

fun workshopSprite(tier: Int?, state: BenchSprite): String = "craft:workshop_t${artTier(tier)}_${state.key}"
fun marketSprite(tier: Int?): String = "craft:market_t${artTier(tier)}_idle"
fun awningSprite(tier: Int?): String = "craft:awning_t${artTier(tier)}"

/** Harvester sprite states (SPEC §4 header). */
enum class HarvesterSprite(val key: String) { IDLE("idle"), READY("ready"), CONSTRUCTION("construction") }

/** The harvester art keys the bundled art covers. The key must come from the server's art map (SPEC §4.1 mismatch:
 *  `solana-reach` in the inventory manifest vs `seeker-reach` in the art); an unknown key draws no sprite. */
val HARVESTER_ART_KEYS: Set<String> = setOf("crownlands", "frostveil", "elderwood", "sunscar", "stormcairn", "thornwake", "cinderfall", "seeker-reach")

fun harvesterSprite(artKey: String?, tier: Int?, state: HarvesterSprite): String? =
    artKey?.takeIf { it in HARVESTER_ART_KEYS }?.let { "craft:harv_${it.replace('-', '_')}_t${artTier(tier)}_${state.key}" }

// ---------------------------------------------------------------------------------------------------------------- atlases

/** A sprite atlas: [frames] cells of [cell] art px, [columns] per row, the first at ([origin], [origin]), [stride] apart. */
data class CraftAtlas(val art: String, val frames: Int, val cell: Int, val columns: Int, val origin: Int = 0, val stride: Int = cell)

/** The art-pixel top-left of frame [index] (wrapped). */
fun atlasFrameOrigin(atlas: CraftAtlas, index: Int): Pair<Int, Int> {
    val i = Math.floorMod(index, atlas.frames.coerceAtLeast(1))
    val cols = atlas.columns.coerceAtLeast(1)
    return (atlas.origin + i % cols * atlas.stride) to (atlas.origin + i / cols * atlas.stride)
}

/** The frame a loop shows [elapsedMs] after it started at [fps]. */
fun loopFrame(elapsedMs: Long, fps: Int, frames: Int): Int =
    if (fps <= 0 || frames <= 0 || elapsedMs < 0) 0 else (elapsedMs * fps / 1000L % frames).toInt()

/** The bundled atlases (SPEC §6), frame layouts read from their json / sizes at copy time. */
object CraftAtlases {
    /** `workshop_t{n}_working_loop`: 344 × 344, 9 frames of 112 in a 3 × 3 grid, 2 px origin and gap. */
    fun workshopWorking(tier: Int?): CraftAtlas = CraftAtlas("craft:workshop_t${artTier(tier)}_working_loop", 9, 112, 3, origin = 2, stride = 114)
    /** `market-t{n}-working`: 896 × 112, 8 frames. */
    fun marketWorking(tier: Int?): CraftAtlas = CraftAtlas("craft:market_t${artTier(tier)}_working", 8, 112, 8)
    /** Forge-ingot casting: 512 × 64, 8 frames. */
    val ingotCasting = CraftAtlas("craft:fx_ingot_casting", 8, 64, 8)
    /** Forge-ingot ready: 576 × 64, 9 frames (play once, hold the last). */
    val ingotReady = CraftAtlas("craft:fx_ingot_ready", 9, 64, 9)
    /** shared-fx craft-success: 512 × 64, 8 frames at 12 fps. */
    val craftSuccess = CraftAtlas("craft:fx_craft_success", 8, 64, 8)
    /** shared-fx reward-claim: 512 × 64, 8 frames at 12 fps. */
    val rewardClaim = CraftAtlas("craft:fx_reward_claim", 8, 64, 8)
}
