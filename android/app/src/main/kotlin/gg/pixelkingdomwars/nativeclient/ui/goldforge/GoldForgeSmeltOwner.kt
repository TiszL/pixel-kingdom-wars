package gg.pixelkingdomwars.nativeclient.ui.goldforge

import androidx.compose.foundation.layout.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import gg.pixelkingdomwars.nativeclient.data.MiningContributionReview
import gg.pixelkingdomwars.nativeclient.data.MiningContributionState
import gg.pixelkingdomwars.nativeclient.miningcontribution.*
import gg.pixelkingdomwars.nativeclient.ui.economy.MINING_CONTRIBUTION_CONSENT
import gg.pixelkingdomwars.nativeclient.ui.economy.MiningContributionViewModel
import gg.pixelkingdomwars.nativeclient.ui.economy.miningBasket
import gg.pixelkingdomwars.nativeclient.ui.economy.miningBasketTotal
import gg.pixelkingdomwars.nativeclient.ui.economy.miningResourceLabel
import gg.pixelkingdomwars.nativeclient.ui.kit.*
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.SheetFrameUi
import gg.pixelkingdomwars.nativeclient.ui.model.SheetSize
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.*
import java.math.BigDecimal
import java.math.BigInteger
import java.math.RoundingMode
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.launch

/** The existing risk sentence of the a51 mining contribution review, shown verbatim under the consent in the SMELT Seal. */
internal const val MINING_CONTRIBUTION_RISK = "Rewards depend on qualification and your share of the daily pool. KEEP is not guaranteed."
/** SPEC §3a: a tap that would pass today's allowance shakes the tile and says this; never a silent clamp. */
internal const val GOLD_FORGE_SMELT_ALLOWANCE_FULL = "Today's allowance is full"
internal const val GOLD_FORGE_SMELT_NO_MORE = "You have no more of this to add."
internal const val GOLD_FORGE_SMELT_SETTLED = "Tap the result above to file it, then choose a new basket."
internal const val GOLD_FORGE_SMELT_SAVED_FIRST = "Review or discard the saved basket first."
internal const val GOLD_FORGE_SMELT_ORDERS_PAUSED = "Game orders are paused. Original receipts remain available."
internal const val GOLD_FORGE_SMELT_CHECKING = "The forge is checking. Try again in a moment."
internal const val GOLD_FORGE_SMELT_SENDING = "The forge is answering. Wait for the receipt."
internal const val GOLD_FORGE_SMELT_UPDATE_BASKET = "Update the basket to fit current stock and allowance."
private const val SMELT_UNAVAILABLE = "Smelting details are unavailable. Refresh to check current stock."
/** The frame footnote of the held face (`smelt-held.png`): one basket a day. */
private const val SMELT_ONE_A_DAY = "One basket a day · the furnace relights at midnight (00:00 UTC)"

/** The frame step words (`smelt.png`, `smelt-held.png`): Basket · Raid · Coins. */
private val CHOOSING_STEPS = listOf(StepUi("Basket", "fill it now", StepState.NOW), StepUi("Raid", "win today", StepState.TODO),
    StepUi("Coins", "midnight", StepState.TODO))
private val HELD_STEPS = listOf(StepUi("Basket", "held", StepState.DONE), StepUi("Raid", "win today", StepState.NOW),
    StepUi("Coins", "midnight", StepState.TODO))

internal data class GoldForgeSmeltScope(val wallet: String, val baseId: String?, val generation: Long, val owner: Any? = null)
internal enum class GoldForgeSmeltEdit { ADD, MAX, MINUS, REMOVE }
internal data class GoldForgeSmeltOwnerUi(
    val body: SmeltUi?, val seal: SmeltSealUi?,
    /** The exact accepted receipt's quantities. No raid qualification or estimate is inferred. */
    val held: List<MiningContributionValuedLine> = emptyList(),
    val savedMessage: String? = null,
    /** Large counts and stock-invalidated lines stay exact and removable outside the tile strip. */
    val largeBasket: List<MiningContributionLine> = emptyList(),
)

internal fun goldForgeSmeltConsentCurrent(review: MiningContributionReview?, consentReview: MiningContributionReview?, consent: Boolean) =
    review != null && review === consentReview && consent
internal fun goldForgeSmeltMayDismiss(review: MiningContributionReview?, sendingReview: MiningContributionReview?) =
    review == null || review !== sendingReview

internal fun goldForgeSmeltActionCurrent(expected: GoldForgeSmeltScope, current: GoldForgeSmeltScope,
    state: MiningContributionState, actionsAllowed: Boolean, running: Boolean, resumed: Boolean,
    review: MiningContributionReview? = null): Boolean = expected == current && resumed && actionsAllowed && !running &&
    !state.busy && state.journal.identity.wallet == current.wallet &&
    (review == null || state.review === review && review.generation == current.generation &&
        review.command.request.baseId == current.baseId && review.view.wallet == current.wallet)

internal fun goldForgeSmeltLines(view: MiningContributionView, quantities: Map<String, String>): List<MiningContributionLine>? =
    miningBasket(view, quantities)?.takeIf { lines -> runCatching {
        val total = miningBasketTotal(view, lines)
        view.remainingValue?.let { total <= it.toBigInteger() } ?: true
    }.getOrDefault(false) }

/** Same exact allowance arithmetic as the original MAX; a rejected +1 returns null, never a silent clamp. */
internal fun goldForgeSmeltSelect(view: MiningContributionView, quantities: Map<String, String>, resourceId: String,
    edit: GoldForgeSmeltEdit): Map<String, String>? = runCatching {
    view.validate()
    if (edit == GoldForgeSmeltEdit.REMOVE) return@runCatching quantities.filterKeys { it != resourceId }
    val stock = view.resources.single { it.resourceId == resourceId }
    val old = quantities[resourceId]?.toBigInteger() ?: BigInteger.ZERO
    val next = when (edit) {
        GoldForgeSmeltEdit.ADD -> old + BigInteger.ONE
        GoldForgeSmeltEdit.MINUS -> (old - BigInteger.ONE).max(BigInteger.ZERO)
        GoldForgeSmeltEdit.REMOVE -> BigInteger.ZERO
        GoldForgeSmeltEdit.MAX -> {
            val others = requireNotNull(miningBasket(view, quantities.filterKeys { it != resourceId }))
            val otherValue = miningBasketTotal(view, others)
            val room = view.remainingValue?.toBigInteger()?.minus(otherValue)?.max(BigInteger.ZERO)?.divide(stock.unitValue.toBigInteger())
            room?.min(stock.available.toBigInteger()) ?: stock.available.toBigInteger()
        }
    }
    val changed = quantities.toMutableMap().apply { if (next.signum() == 0) remove(resourceId) else put(resourceId, next.toString()) }
    // Removing a stale line must remain possible even when another line also exceeds newly read stock.
    if (edit == GoldForgeSmeltEdit.ADD || edit == GoldForgeSmeltEdit.MAX) requireNotNull(goldForgeSmeltLines(view, changed))
    changed.toMap()
}.getOrNull()

/** Why an action that needs the idle, admitted owner did not run (never a silent drop). */
internal fun goldForgeSmeltWaitReason(busy: Boolean, actionsAllowed: Boolean): String = when {
    !actionsAllowed -> GOLD_FORGE_SMELT_ORDERS_PAUSED
    busy -> GOLD_FORGE_SMELT_CHECKING
    else -> "This forge view changed. Try again."
}

/** Why a saved original blocks a new basket: a settled one is filed from its callout, a held one waits for midnight. */
internal fun goldForgeSmeltSavedReason(saved: MiningContributionOperation): String = when {
    saved.proof?.settlement != null -> GOLD_FORGE_SMELT_SETTLED
    saved.proof != null -> SMELT_ONE_A_DAY
    else -> GOLD_FORGE_SMELT_SAVED_FIRST
}

/** The server's lock on new baskets, in the primary's own words (SPEC SMELT states); null while open. */
private fun goldForgeSmeltClosedReason(view: MiningContributionView): String? = when {
    !view.developmentReady -> "Build the mining buildings first"
    !view.acceptingContributions -> "New smelting is paused"
    else -> null
}

/** One basket edit: the new quantities, or why it was refused (the caller shows it; the tile already shook). */
internal data class GoldForgeSmeltEditResult(val quantities: Map<String, String>?, val explanation: String?)

internal fun goldForgeSmeltEditResult(state: MiningContributionState, scope: GoldForgeSmeltScope, quantities: Map<String, String>,
    resourceId: String, edit: GoldForgeSmeltEdit, admitted: Boolean, busy: Boolean, actionsAllowed: Boolean): GoldForgeSmeltEditResult {
    state.journal.operation?.let { return GoldForgeSmeltEditResult(null, goldForgeSmeltSavedReason(it)) }
    if (!admitted) return GoldForgeSmeltEditResult(null, goldForgeSmeltWaitReason(busy, actionsAllowed))
    val view = state.view?.takeIf { it.wallet == scope.wallet && it.baseId == scope.baseId }
        ?: return GoldForgeSmeltEditResult(null, SMELT_UNAVAILABLE)
    goldForgeSmeltClosedReason(view)?.let { return GoldForgeSmeltEditResult(null, it) }
    goldForgeSmeltSelect(view, quantities, resourceId, edit)?.let { return GoldForgeSmeltEditResult(it, null) }
    val stock = view.resources.firstOrNull { it.resourceId == resourceId }?.available?.toBigIntegerOrNull()
    val chosen = quantities[resourceId]?.toBigIntegerOrNull() ?: BigInteger.ZERO
    // Say what really stopped it: the stock (an uncapped deed furnace has no allowance) or today's allowance.
    return GoldForgeSmeltEditResult(null, when {
        edit == GoldForgeSmeltEdit.ADD && stock != null && chosen >= stock -> GOLD_FORGE_SMELT_NO_MORE
        edit == GoldForgeSmeltEdit.ADD || edit == GoldForgeSmeltEdit.MAX -> GOLD_FORGE_SMELT_ALLOWANCE_FULL
        else -> GOLD_FORGE_SMELT_UPDATE_BASKET
    })
}

/** SMELT's begin decision: the exact lines for `model.start(lines)`, or why not. */
internal data class GoldForgeSmeltStart(val lines: List<MiningContributionLine>?, val explanation: String?)

internal fun goldForgeSmeltStart(state: MiningContributionState, scope: GoldForgeSmeltScope, quantities: Map<String, String>,
    admitted: Boolean, busy: Boolean, actionsAllowed: Boolean): GoldForgeSmeltStart {
    state.journal.operation?.let { return GoldForgeSmeltStart(null, goldForgeSmeltSavedReason(it)) }
    if (!admitted) return GoldForgeSmeltStart(null, goldForgeSmeltWaitReason(busy, actionsAllowed))
    val view = state.view?.takeIf { it.wallet == scope.wallet && it.baseId == scope.baseId }
        ?: return GoldForgeSmeltStart(null, SMELT_UNAVAILABLE)
    goldForgeSmeltClosedReason(view)?.let { return GoldForgeSmeltStart(null, it) }
    val lines = goldForgeSmeltLines(view, quantities) ?: return GoldForgeSmeltStart(null, GOLD_FORGE_SMELT_UPDATE_BASKET)
    if (lines.isEmpty()) return GoldForgeSmeltStart(null, "Tap what to smelt first")
    return GoldForgeSmeltStart(lines, null)
}

/** The UTC mining day as the frame shows it, without "UTC" ("2 Oct"); the server's own string if it cannot be read. */
internal fun goldForgeSmeltDay(day: String, locale: Locale = Locale.getDefault()): String =
    runCatching { LocalDate.parse(day).format(DateTimeFormatter.ofPattern("d MMM", locale)) }.getOrDefault(day)

/** What a tile says the player has (`smelt.png`): Shards as a short amount ("40.9K"), items as "x6". Rounded down, so a
 *  tile never shows more than the server holds; five glyphs fit the 72 dp tile. */
internal fun goldForgeSmeltHave(resourceId: String, available: String): String =
    if (resourceId == "shards") compactAmount(available, maxGlyphs = 5) else "x" + compactAmount(available, maxGlyphs = 4)

private fun smeltIcon(id: String) = when (id) { "forge_ingot" -> "gf:forge_ingot"; "shards" -> "shards"; else -> "craft:inv_$id" }
private fun smeltRatio(value: String, cap: String?): Float = cap?.let {
    BigDecimal(value).divide(BigDecimal(it), 6, RoundingMode.DOWN).coerceIn(BigDecimal.ZERO, BigDecimal.ONE).toFloat()
} ?: 0f
private fun itemsLabel(count: BigInteger) = "${exactAmount(count.toString())} ${if (count == BigInteger.ONE) "item" else "items"}"

/**
 * The held face (`smelt-held.png`) over the accepted original receipt and today's server view. The receipt carries no
 * raid-qualification field and the server sends no estimate or counted raid days, so this never produces QUALIFIED, the
 * estimate card reads "Your share is set at payout" and the raid-day row shows its no-data line.
 */
private fun goldForgeSmeltHeldBody(view: MiningContributionView, held: List<MiningContributionValuedLine>, total: String,
    locale: Locale): SmeltUi {
    val tiles = held.map { line -> SmeltTileUi(line.resourceId, smeltIcon(line.resourceId), "x" + exactAmount(line.quantity),
        line.quantity.toIntOrNull() ?: 0, exactAmount(line.unitValue), "", miningResourceLabel(line.resourceId), canAdd = false) }
    return SmeltUi(goldForgeSmeltDay(view.day, locale), view.pool, exactAmount(view.committedValue),
        view.dailyCapValue?.let { exactAmount(it) }, exactAmount(total), 0f, smeltRatio(view.committedValue, view.dailyCapValue),
        HELD_STEPS, null, emptyList(), null, tiles, null, smeltPrimaryCommand(SmeltState.HELD, 0), null, SmeltState.HELD)
}

/** Display over the existing owner's observations. It creates no journal, request, receipt or reward. */
internal fun goldForgeSmeltOwnerUi(state: MiningContributionState, scope: GoldForgeSmeltScope,
    quantities: Map<String, String>, selected: String?, actionsAllowed: Boolean, running: Boolean,
    consent: Boolean, armedAtMs: Long, sending: Boolean = false, locale: Locale = Locale.getDefault()): GoldForgeSmeltOwnerUi {
    val identity = state.journal.identity
    if (identity.wallet != scope.wallet || runCatching { identity.validate() }.isFailure)
        return GoldForgeSmeltOwnerUi(null, null, savedMessage = "Open smelting for the current account.")
    val operation = state.journal.operation
    val proof = operation?.let { op -> op.proof?.takeIf { it.status == "accepted" && runCatching { it.validate(identity, op.command) }.isSuccess } }
    val settlement = proof?.settlement
    val review = state.review?.takeIf { actionsAllowed && it.generation == scope.generation &&
        it.command.request.baseId == scope.baseId && it.view.wallet == scope.wallet &&
        runCatching { it.command.admit(identity, it.view) }.isSuccess }
    // The frame's label sits under the full existing legal sentence and its risk line (SPEC §9 fallback; the owner rules on
    // the shorter label). No new consent wording is introduced.
    val seal = review?.takeIf { sending || (!state.busy && !running) }?.let {
        val count = it.command.request.lines.fold(BigInteger.ZERO) { n, line -> n + line.quantity.toBigInteger() }
        SmeltSealUi(itemsLabel(count), exactAmount(it.command.totalValue),
            it.command.lines.map { line -> smeltIcon(line.resourceId) }.take(2), consent, armedAtMs,
            sending = sending, consentBody = MINING_CONTRIBUTION_CONSENT, riskLine = MINING_CONTRIBUTION_RISK)
    }
    val savedMessage = operation?.let {
        when {
            settlement != null -> "This basket was ${settlement.outcome}. The original settlement remains in history."
            proof != null -> "Resources are reserved. Raid qualification is not included in this receipt; settlement is automatic."
            it.refusal != null -> "The server declined this basket. Check its original receipt before archiving."
            it.attemptRevision != null -> "This basket may have been accepted. Check its original receipt; checking never sends it again."
            else -> "This exact basket is saved. Resources are reserved only after confirmation is accepted."
        }
    }
    val view = (review?.view ?: state.view)?.takeIf { state.advertised && it.wallet == scope.wallet && it.baseId == scope.baseId &&
        runCatching { it.validate() }.isSuccess }
    val held = if (proof != null && settlement == null) requireNotNull(proof.receipt).lines else emptyList()
    if (operation != null && review == null) {
        // A saved original the designed faces cannot show stays with its receipt controls: an unsent, attempted or declined
        // basket, a receipt without a current view, or a count too large for a tile.
        if (view == null || proof == null || held.any { it.quantity.toIntOrNull() == null })
            return GoldForgeSmeltOwnerUi(null, null, held = held, savedMessage = savedMessage)
        if (settlement == null) return GoldForgeSmeltOwnerUi(goldForgeSmeltHeldBody(view, held,
            requireNotNull(proof.receipt).totalValue, locale), null, held = held, savedMessage = savedMessage)
        // A settled original shows today's view with its result callout until the player files it.
    }
    if (view == null) return GoldForgeSmeltOwnerUi(null, seal, savedMessage = savedMessage)
    val chosen = review?.command?.request?.lines?.associate { it.resourceId to it.quantity } ?: quantities
    val lines = goldForgeSmeltLines(view, chosen)
    val total = lines?.let { miningBasketTotal(view, it).toString() } ?: UNKNOWN
    val itemCount = lines?.fold(BigInteger.ZERO) { n, line -> n + line.quantity.toBigInteger() } ?: BigInteger.ZERO
    val phase = when {
        review != null && sending -> SmeltState.SENDING
        state.busy || running -> SmeltState.LOADING
        review != null -> SmeltState.REVIEW
        settlement != null -> SmeltState.PAUSED
        !view.developmentReady -> SmeltState.NOT_READY
        !view.acceptingContributions || !actionsAllowed -> SmeltState.PAUSED
        else -> SmeltState.CHOOSING
    }
    val large = chosen.mapNotNull { (id, count) -> runCatching { MiningContributionLine(id, count).also { it.validate() } }.getOrNull() }
        .filter { lines == null || it.quantity.toIntOrNull() == null || view.resources.none { stock -> stock.resourceId == it.resourceId && stock.available.toBigInteger().signum() > 0 } }
    // A chosen line keeps its tile after its stock runs out, so its "− 1" can still take it back in place.
    val tiles = view.resources.filter { it.available.toBigInteger().signum() > 0 || chosen.containsKey(it.resourceId) }.sortedWith(
        compareBy<MiningContributionStock> { when (it.resourceId) { "forge_ingot" -> 0; "shards" -> 1; else -> 2 } }.thenBy { it.resourceId })
        .map { stock -> SmeltTileUi(stock.resourceId, smeltIcon(stock.resourceId), goldForgeSmeltHave(stock.resourceId, stock.available),
            chosen[stock.resourceId]?.toIntOrNull() ?: 0, exactAmount(stock.unitValue), "", miningResourceLabel(stock.resourceId),
            canAdd = phase == SmeltState.CHOOSING && goldForgeSmeltSelect(view, chosen, stock.resourceId, GoldForgeSmeltEdit.ADD) != null) }
    var primary = smeltPrimaryCommand(phase, if (itemCount.signum() > 0) 1 else 0, reason = when {
        settlement != null -> GOLD_FORGE_SMELT_SETTLED
        !actionsAllowed -> GOLD_FORGE_SMELT_ORDERS_PAUSED
        else -> null
    })
    if (itemCount.signum() > 0 && phase in setOf(SmeltState.CHOOSING, SmeltState.REVIEW)) primary = primary.copy(sub = itemsLabel(itemCount))
    if (lines == null) primary = primary.copy(state = CommandState.DISABLED, reason = GOLD_FORGE_SMELT_UPDATE_BASKET)
    // Display strings are grouped ("1,800"); every ratio and comparison above uses the raw server strings.
    val body = SmeltUi(goldForgeSmeltDay(view.day, locale), view.pool, exactAmount(view.committedValue),
        view.dailyCapValue?.let { exactAmount(it) }, exactAmount(total),
        if (total == UNKNOWN) 0f else smeltRatio(total, view.dailyCapValue), smeltRatio(view.committedValue, view.dailyCapValue),
        CHOOSING_STEPS, null, tiles, tiles.firstOrNull { it.resourceId == selected }, null, null, primary,
        settlement?.let { SmeltResultUi(melted = it.outcome == "consumed") }, phase, seal)
    return GoldForgeSmeltOwnerUi(body, seal, savedMessage = savedMessage, largeBasket = large)
}

/**
 * The saved-basket controls (A4's route block, same wording and guards): exact rows for basket lines a tile cannot show,
 * then the saved original with its receipt checks. The route and the Home binding both draw it; a refused tap says why.
 */
@Composable internal fun GoldForgeSmeltRecovery(model: MiningContributionViewModel, ui: GoldForgeSmeltOwnerUi,
    saved: MiningContributionOperation?, selectedBase: String?, busy: Boolean, actionsAllowed: Boolean,
    admitted: () -> Boolean, readAllowed: () -> Boolean, currentBase: () -> String?,
    onEdit: (String, GoldForgeSmeltEdit) -> Unit, onFindRaid: (() -> Unit)?, onRefused: (String) -> Unit) {
    val refuse = { onRefused(goldForgeSmeltWaitReason(model.state.value.busy || model.busy.value, actionsAllowed)) }
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        ui.largeBasket.forEach { line ->
            SmeltExactLine(line.resourceId, line.quantity)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                SecondaryButton("− 1", { onEdit(line.resourceId, GoldForgeSmeltEdit.MINUS) }, enabled = admitted())
                SecondaryButton("REMOVE", { onEdit(line.resourceId, GoldForgeSmeltEdit.REMOVE) }, enabled = admitted())
            }
        }
        if (saved != null) {
            if (ui.held.isEmpty()) {
                SectionRow("SAVED BASKET")
                saved.command.request.lines.forEach { line -> SmeltExactLine(line.resourceId, line.quantity) }
            } else if (ui.body == null) {
                // With a designed held face above, its tiles already show the basket.
                SectionRow("IN THE FURNACE", tag = { Tag("HELD", Verb.MOSS) })
                ui.held.forEach { line -> SmeltExactLine(line.resourceId, line.quantity) }
                EstimateCard(null)
            }
            PkwText(ui.savedMessage.orEmpty(), PkwTokens.Type.body, color = PkwTokens.Colors.textOnParch, maxLines = Int.MAX_VALUE)
            PkwText("${exactAmount(saved.command.totalValue)} contribution value · ${saved.command.request.expectedDay}", PkwTokens.Type.small,
                color = PkwTokens.Colors.textOnParch2)
            SmeltReceiptDetails(saved)
            if (saved.command.request.baseId != selectedBase) PkwText("Select the original kingdom to review this basket. Receipt checks remain available here.", PkwTokens.Type.small,
                color = PkwTokens.Colors.textOnParch2, maxLines = Int.MAX_VALUE)
            if (saved.attemptRevision != null && saved.proof == null && saved.refusal == null)
                PkwText("Reviewing and confirming again resends the same saved request after checking its original receipt.", PkwTokens.Type.small,
                    color = PkwTokens.Colors.textOnParch2, maxLines = Int.MAX_VALUE)
            if (saved.proof == null && saved.refusal == null) SecondaryButton("REVIEW SAVED BASKET", {
                if (admitted() && model.state.value.journal.operation === saved && saved.command.request.baseId == currentBase()) model.reviewSaved()
                else refuse()
            }, enabled = !busy && actionsAllowed && saved.command.request.baseId == selectedBase)
            SecondaryButton("CHECK ORIGINAL RECEIPT", {
                if (readAllowed() && model.state.value.journal.operation === saved) model.check() else refuse()
            }, enabled = !busy)
            if (saved.proof != null) SecondaryButton("SAVE TO HISTORY", {
                if (readAllowed() && model.state.value.journal.operation === saved) model.finish() else refuse()
            }, enabled = !busy)
            else if (saved.refusal != null || saved.attemptRevision == null) SecondaryButton(
                if (saved.refusal != null) "ARCHIVE DECLINED BASKET" else "DISCARD UNSENT BASKET",
                { if (readAllowed() && model.state.value.journal.operation === saved) model.archiveUnusedOrRefused() else refuse() }, enabled = !busy)
            else {
                // Dead-end audit 2026-10-06: an attempted basket the server has no record of (CLOSE re-reads by key first).
                PkwText("If the server has no record of this basket, CLOSE checks once more and moves it to history so you can smelt again.", PkwTokens.Type.small,
                    color = PkwTokens.Colors.textOnParch2, maxLines = Int.MAX_VALUE)
                SecondaryButton("CLOSE · NO SERVER RECORD", {
                    if (readAllowed() && model.state.value.journal.operation === saved) model.archiveUnknown() else refuse()
                }, enabled = !busy)
            }
            if (ui.held.isNotEmpty() && ui.body == null && onFindRaid != null) SecondaryButton("FIND A RAID", onFindRaid, enabled = !busy && actionsAllowed)
        }
    }
}

/** Existing route owner, restyled. Only explicit guarded callbacks call the supplied ViewModel. */
@Composable fun GoldForgeSmeltOwner(model: MiningContributionViewModel, wallet: String, selectedBase: String?, generation: Long,
    actionsAllowed: Boolean, onFindRaid: (() -> Unit)? = null, onGoWorkshop: (() -> Unit)? = null,
    onGoBuild: (() -> Unit)? = null, onBack: () -> Unit) {
    val state by model.state.collectAsState()
    val notice by model.notice.collectAsState()
    val running by model.busy.collectAsState()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val coroutineScope = rememberCoroutineScope()
    val lifecycleState by lifecycle.currentStateFlow.collectAsState()
    val expected = GoldForgeSmeltScope(wallet, selectedBase, generation, model)
    val currentScope by rememberUpdatedState(expected)
    val currentAllowed by rememberUpdatedState(actionsAllowed)
    val quantities = remember(model, wallet, selectedBase, generation) { mutableStateMapOf<String, String>() }
    var selected by rememberSaveable(wallet, selectedBase, generation) { mutableStateOf<String?>(null) }
    var history by rememberSaveable(wallet) { mutableStateOf(false) }
    var explanation by remember(wallet, selectedBase, generation) { mutableStateOf<String?>(null) }
    val review = state.review
    var consent by remember(model) { mutableStateOf(false) }
    var consentReview by remember(model) { mutableStateOf<MiningContributionReview?>(null, referentialEqualityPolicy()) }
    var sendingReview by remember(model) { mutableStateOf<MiningContributionReview?>(null, referentialEqualityPolicy()) }
    val armedAt = remember(review) { System.currentTimeMillis() }
    DisposableEffect(model, lifecycle) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_STOP) model.dismiss() }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer); model.dismiss() }
    }
    LaunchedEffect(model, lifecycle, generation) {
        model.dismiss()
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) { model.foreground(); awaitCancellation() }
    }
    LaunchedEffect(actionsAllowed) { if (!actionsAllowed) model.dismiss() }
    val busy = state.busy || running
    val resumed = lifecycleState == Lifecycle.State.RESUMED
    fun admitted(reviewed: MiningContributionReview? = null) = goldForgeSmeltActionCurrent(expected, currentScope,
        model.state.value, currentAllowed, model.busy.value, lifecycle.currentState == Lifecycle.State.RESUMED, reviewed)
    fun readAllowed() = expected == currentScope && lifecycle.currentState == Lifecycle.State.RESUMED &&
        model.state.value.journal.identity.wallet == wallet && !model.state.value.busy && !model.busy.value
    fun waitReason() = goldForgeSmeltWaitReason(model.state.value.busy || model.busy.value, currentAllowed)
    val back = { model.dismiss(); onBack() }
    BackHandlerAt(BackPriority.SCREEN) { back() }
    BackHandlerAt(BackPriority.CONFIRM, review != null) {
        if (goldForgeSmeltMayDismiss(review, sendingReview)) model.dismiss() else explanation = GOLD_FORGE_SMELT_SENDING
    }
    val currentConsent = goldForgeSmeltConsentCurrent(review, consentReview, consent)
    val ui = goldForgeSmeltOwnerUi(state, expected, quantities, selected, actionsAllowed && resumed,
        running, currentConsent, armedAt, sending = review != null && review === sendingReview)
    fun edit(id: String, kind: GoldForgeSmeltEdit) {
        val result = goldForgeSmeltEditResult(model.state.value, currentScope, quantities.toMap(), id, kind, admitted(),
            model.state.value.busy || model.busy.value, currentAllowed)
        val changed = result.quantities
        if (changed == null) explanation = result.explanation
        else { quantities.clear(); quantities.putAll(changed); selected = id; explanation = null }
    }
    fun navigate(callback: (() -> Unit)?, unavailable: String) {
        if (!admitted()) { explanation = waitReason(); return }
        if (callback == null) explanation = unavailable else { model.dismiss(); callback() }
    }
    val actions = SmeltActions(onTile = { edit(it, GoldForgeSmeltEdit.ADD) }, onTileHold = { edit(it, GoldForgeSmeltEdit.MAX) },
        onMinus = { edit(it, GoldForgeSmeltEdit.MINUS) }, onMinusHold = { edit(it, GoldForgeSmeltEdit.REMOVE) },
        onSmelt = {
            val start = goldForgeSmeltStart(model.state.value, currentScope, quantities.toMap(), admitted(),
                model.state.value.busy || model.busy.value, currentAllowed)
            val lines = start.lines
            if (lines != null) model.start(lines) else explanation = start.explanation
        }, onConsent = { if (review != null && admitted(review)) { consentReview = review; consent = it } else explanation = waitReason() },
        onConfirm = {
            if (review != null && goldForgeSmeltConsentCurrent(review, consentReview, consent) && sendingReview == null && admitted(review)) {
                model.confirm(review)?.let { job ->
                    sendingReview = review
                    coroutineScope.launch { job.join(); if (sendingReview === review) sendingReview = null }
                }
            } else explanation = waitReason()
        },
        onBack = { if (goldForgeSmeltMayDismiss(review, sendingReview)) model.dismiss() else explanation = GOLD_FORGE_SMELT_SENDING },
        onRetry = { if (readAllowed()) model.refresh() else explanation = waitReason() },
        onFindRaid = { navigate(onFindRaid, "Open raids from Home.") },
        onGoWorkshop = { navigate(onGoWorkshop, "Open the Workshop from Home.") },
        onGoBuild = { navigate(onGoBuild, "Open BUILD from Home.") },
        // This recovery page has no CLAIM tab; the Gold Forge on Home does.
        onResultGo = { explanation = "Open CLAIM from the Gold Forge." },
        onResultDismiss = {
            if (readAllowed() && model.state.value.journal.operation?.proof?.settlement != null) model.finish() else explanation = waitReason()
        },
        onExplain = { explanation = it })
    Box(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing)) {
        SheetFrame(SheetFrameUi("GOLD FORGE · SMELT", null, SheetSize.FULL, emptyList(), "SMELT", history = true),
            onClose = back, onHistory = { history = !history }, modifier = Modifier.fillMaxSize(),
            footer = { if (!history) ui.body?.let { SmeltFooter(it, actions) } }) {
            (explanation ?: notice?.message)?.let { PkwText(it, PkwTokens.Type.body,
                Modifier.semantics { liveRegion = LiveRegionMode.Polite }, color = PkwTokens.Colors.textOnParch, maxLines = Int.MAX_VALUE) }
            if (!actionsAllowed) PkwText(GOLD_FORGE_SMELT_ORDERS_PAUSED, PkwTokens.Type.small,
                color = PkwTokens.Colors.textOnParch2, maxLines = Int.MAX_VALUE)
            if (!history) {
                ui.body?.let { SmeltBody(it, actions) }
                if (ui.body == null && state.journal.operation == null) PkwText(
                    if (busy) "Checking the forge…" else SMELT_UNAVAILABLE,
                    PkwTokens.Type.body, color = PkwTokens.Colors.textOnParch, maxLines = Int.MAX_VALUE)
                if (state.journal.operation != null || ui.largeBasket.isNotEmpty()) GoldForgeSmeltRecovery(model, ui,
                    state.journal.operation, selectedBase, busy, actionsAllowed, admitted = { admitted() }, readAllowed = { readAllowed() },
                    currentBase = { currentScope.baseId }, onEdit = { id, kind -> edit(id, kind) },
                    onFindRaid = if (onFindRaid != null) actions.onFindRaid else null, onRefused = { explanation = it })
            } else {
                SectionRow("CONTRIBUTION HISTORY")
                if (state.journal.archives.isEmpty()) PkwText("No saved contribution receipts.", PkwTokens.Type.body, color = PkwTokens.Colors.textOnParch)
                state.journal.archives.asReversed().forEach { archive ->
                    Plate(PlateKind.CREAM) { Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        PkwText(archive.operation.command.request.expectedDay, PkwTokens.Type.label, color = PkwTokens.Colors.textOnParch)
                        archive.operation.command.request.lines.forEach { SmeltExactLine(it.resourceId, it.quantity) }
                        PkwText(archive.operation.proof?.settlement?.outcome?.let { "Settlement: $it" } ?: "Saved original receipt. Historical proof is not available stock.",
                            PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2, maxLines = Int.MAX_VALUE)
                        SmeltReceiptDetails(archive.operation)
                        SecondaryButton("CHECK SAVED RECEIPT", {
                            if (readAllowed() && model.state.value.journal.archives.any { it.operation.command.key == archive.operation.command.key }) model.checkArchived(archive.operation.command.key)
                            else explanation = waitReason()
                        }, enabled = !busy)
                    } }
                }
            }
            SecondaryButton(if (history) "BACK TO SMELT" else "CONTRIBUTION HISTORY (${state.journal.archives.size})", { history = !history })
            SecondaryButton("REFRESH STOCK & RECEIPTS", { if (readAllowed()) model.refresh() else explanation = waitReason() }, enabled = !busy)
        }
        // The designed consent Seal (`smelt-seal.png`) carries the full existing legal sentence above the frame's label.
        SmeltSeal(ui.seal, actions)
    }
}

@Composable private fun SmeltReceiptDetails(operation: MiningContributionOperation) {
    val status = when {
        operation.proof?.settlement?.outcome == "consumed" -> "CONSUMED"
        operation.proof?.settlement?.outcome == "returned" -> "RETURNED"
        operation.proof != null -> "RESERVED"
        operation.refusal != null -> "DECLINED"
        operation.attemptRevision != null -> "CHECK OUTCOME"
        else -> "SAVED BASKET"
    }
    Tag(status, if (operation.proof?.settlement != null) Verb.MOSS else Verb.STONE)
    for (line in listOfNotNull("Kingdom ${operation.command.request.baseId}", "Request ${operation.command.key}",
        "Mining day (UTC) ${operation.command.request.expectedDay}",
        operation.proof?.receipt?.let { "Reserved (UTC) ${it.createdAt}" },
        operation.proof?.settlement?.let { "Settlement ${it.outcome} · ${it.settledAt}" })) {
        PkwText(line, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2)
    }
}

@Composable private fun SmeltExactLine(resourceId: String, quantity: String) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        GfIcon(smeltIcon(resourceId), 32.dp)
        PkwText(miningResourceLabel(resourceId), PkwTokens.Type.body, Modifier.weight(1f), color = PkwTokens.Colors.textOnParch)
        PkwText(quantity, PkwTokens.Type.body, color = PkwTokens.Colors.textOnParch)
    }
}
