package gg.pixelkingdomwars.nativeclient.ui.goldforge

import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.referentialEqualityPolicy
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import gg.pixelkingdomwars.nativeclient.data.MiningContributionReview
import gg.pixelkingdomwars.nativeclient.data.MiningContributionState
import gg.pixelkingdomwars.nativeclient.miningcontribution.MiningContributionOperation
import gg.pixelkingdomwars.nativeclient.ui.economy.MiningContributionViewModel
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.SmeltActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.SmeltSeal
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.SmeltState
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.SmeltUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.smeltPrimaryCommand
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

/**
 * The Home-mounted SMELT tab acting in place (design/final/goldforge SPEC §3; `smelt.png`, `smelt-seal.png`,
 * `smelt-held.png`) over the existing session-scoped [MiningContributionViewModel]. The only money calls are its
 * `start(lines)`, `confirm(review)` and the GET-only receipt reads; nothing here signs, posts or opens the old route.
 */
internal data class GoldForgeSmeltBinding(
    /** The designed body and footer; null when there is no current view for this wallet and base. */
    val ui: SmeltUi?,
    val actions: SmeltActions,
    /** True while a review is up or a confirm is being answered: the host refuses close, refresh and other doors. */
    val reviewOpen: Boolean,
    /** The saved-basket controls, only while something needs recovering; the host draws them in place of the body. */
    val recovery: (@Composable ColumnScope.() -> Unit)?,
    /** The consent Seal. Compose it always, at the Home overlay layer, so its exit animation runs. */
    val overlay: @Composable () -> Unit,
)

/** The last body shown, kept across a routine read so the tab never blanks (SPEC §1 Motion: "The body never blanks"). */
private class GoldForgeSmeltMemory { var body: SmeltUi? = null }

/** What to remember after this composition: a settled body; across a read, the previous one; otherwise nothing, so a
 *  saved basket that legitimately has no body is never covered by an old one. */
internal fun goldForgeSmeltKept(previous: SmeltUi?, mapped: SmeltUi?, reading: Boolean): SmeltUi? = when {
    mapped != null && mapped.state != SmeltState.LOADING -> mapped
    reading -> previous
    else -> null
}

/** The body to draw: the mapped one, or during a read (view cleared, or the owner busy) the last body with its values and
 *  a stone "Checking" primary. The first read with nothing shown yet keeps the designed loading skeleton. */
internal fun goldForgeSmeltShown(mapped: SmeltUi?, kept: SmeltUi?, reading: Boolean): SmeltUi? = when {
    mapped != null && mapped.state != SmeltState.LOADING -> mapped
    reading && kept != null -> goldForgeSmeltChecking(kept)
    else -> mapped
}

/** A kept body while the owner reads: same values, no Seal, the primary turned into the busy "Checking" face. */
internal fun goldForgeSmeltChecking(ui: SmeltUi): SmeltUi =
    ui.copy(seal = null, primary = smeltPrimaryCommand(SmeltState.LOADING, 0).copy(caption = "Checking"))

/** The saved-basket controls replace the body only when a saved original has no designed face to show it. */
internal fun goldForgeSmeltRecoveryNeeded(body: SmeltUi?, saved: MiningContributionOperation?): Boolean = saved != null && body == null

/** The command key of an accepted original still waiting for settlement; its receipt is re-read (GET only) once per start. */
internal fun goldForgeSmeltSettlementWatch(state: MiningContributionState): String? =
    state.journal.operation?.takeIf { op -> op.proof?.let { it.status == "accepted" && it.settlement == null } == true }?.command?.key

/**
 * Builds the SMELT tab for the Home sheet. [current] is the host's session, identity and lifecycle witness; it excludes the
 * review on purpose and is combined with this owner's own admission. The host's read pass refreshes the repository, so
 * opening calls neither `foreground()` nor `refresh()`.
 */
@Composable internal fun rememberGoldForgeSmeltBinding(model: MiningContributionViewModel, wallet: String, selectedBase: String?,
    generation: Long, actionsAllowed: Boolean, current: () -> Boolean, onFindRaid: () -> Unit, onGoWorkshop: () -> Unit,
    onGoBuild: () -> Unit, onGoClaim: () -> Unit, onExplain: (String) -> Unit): GoldForgeSmeltBinding {
    val stateHolder = model.state.collectAsState()
    val runningHolder = model.busy.collectAsState()
    val state = stateHolder.value
    val running = runningHolder.value
    val notice by model.notice.collectAsState()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val lifecycleState by lifecycle.currentStateFlow.collectAsState()
    val coroutineScope = rememberCoroutineScope()
    val expected = GoldForgeSmeltScope(wallet, selectedBase, generation, model)
    val currentScope by rememberUpdatedState(expected)
    val currentAllowed by rememberUpdatedState(actionsAllowed)
    val hostCurrent by rememberUpdatedState(current)
    val explain by rememberUpdatedState(onExplain)
    val findRaid by rememberUpdatedState(onFindRaid)
    val goWorkshop by rememberUpdatedState(onGoWorkshop)
    val goBuild by rememberUpdatedState(onGoBuild)
    val goClaim by rememberUpdatedState(onGoClaim)
    val quantities = remember(model, wallet, selectedBase, generation) { mutableStateMapOf<String, String>() }
    var selected by remember(model, wallet, selectedBase, generation) { mutableStateOf<String?>(null) }
    val memory = remember(model, wallet, selectedBase, generation) { GoldForgeSmeltMemory() }
    val review = state.review
    var consent by remember(model) { mutableStateOf(false) }
    var consentReview by remember(model) { mutableStateOf<MiningContributionReview?>(null, referentialEqualityPolicy()) }
    var sendingReview by remember(model) { mutableStateOf<MiningContributionReview?>(null, referentialEqualityPolicy()) }
    val armedAt = remember(review) { System.currentTimeMillis() }

    // Lifecycle (A4 guards): a new owner or kingdom generation, a stop, leaving the forge or closed orders drop the review.
    DisposableEffect(model, lifecycle) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_STOP) model.dismiss() }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer); model.dismiss() }
    }
    LaunchedEffect(model, generation) { model.dismiss() }
    LaunchedEffect(model, actionsAllowed) { if (!actionsAllowed) model.dismiss() }
    // The owner's answers (a refusal, "Original receipt archived…") reach the player through the host's toast zone.
    LaunchedEffect(model, notice) { notice?.let { explain(it.message); model.dismissNotice() } }
    // A held basket's receipt is re-read once each time the app starts, only when the owner is idle, so a settlement shows.
    val watchKey = goldForgeSmeltSettlementWatch(state)
    LaunchedEffect(model, watchKey, lifecycle) {
        if (watchKey == null) return@LaunchedEffect
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            snapshotFlow { !stateHolder.value.busy && !runningHolder.value }.first { it }
            if (goldForgeSmeltSettlementWatch(model.state.value) == watchKey) model.check()
            awaitCancellation()
        }
    }
    BackHandlerAt(BackPriority.CONFIRM, review != null) {
        if (goldForgeSmeltMayDismiss(review, sendingReview)) model.dismiss() else explain(GOLD_FORGE_SMELT_SENDING)
    }

    val resumed = lifecycleState == Lifecycle.State.RESUMED
    val currentConsent = goldForgeSmeltConsentCurrent(review, consentReview, consent)
    val owner = goldForgeSmeltOwnerUi(state, expected, quantities, selected, actionsAllowed && resumed, running, currentConsent,
        armedAt, sending = review != null && review === sendingReview)
    val reading = state.busy || running
    val shown = goldForgeSmeltShown(owner.body, memory.body, reading)
    SideEffect { memory.body = goldForgeSmeltKept(memory.body, owner.body, reading) }
    val saved = state.journal.operation

    fun busyNow() = model.state.value.busy || model.busy.value
    fun admitted(reviewed: MiningContributionReview? = null) = hostCurrent() && goldForgeSmeltActionCurrent(expected, currentScope,
        model.state.value, currentAllowed, model.busy.value, lifecycle.currentState == Lifecycle.State.RESUMED, reviewed)
    fun readAllowed() = hostCurrent() && expected == currentScope && lifecycle.currentState == Lifecycle.State.RESUMED &&
        model.state.value.journal.identity.wallet == wallet && !busyNow()
    fun explainWait() = explain(goldForgeSmeltWaitReason(busyNow(), currentAllowed))
    fun edit(id: String, kind: GoldForgeSmeltEdit) {
        val result = goldForgeSmeltEditResult(model.state.value, currentScope, quantities.toMap(), id, kind, admitted(), busyNow(),
            currentAllowed)
        val changed = result.quantities
        if (changed == null) result.explanation?.let { explain(it) }
        else { quantities.clear(); quantities.putAll(changed); selected = id }
    }
    // A door that leaves the forge drops any review first, as the route's doors did.
    fun leave(door: () -> Unit) { if (admitted()) { model.dismiss(); door() } else explainWait() }

    val actions = SmeltActions(
        onTile = { edit(it, GoldForgeSmeltEdit.ADD) },
        onTileHold = { edit(it, GoldForgeSmeltEdit.MAX) },
        onMinus = { edit(it, GoldForgeSmeltEdit.MINUS) },
        onSmelt = {
            val start = goldForgeSmeltStart(model.state.value, currentScope, quantities.toMap(), admitted(), busyNow(), currentAllowed)
            val lines = start.lines
            if (lines == null) start.explanation?.let { explain(it) }
            else if (model.start(lines) == null) explainWait()
        },
        // Consent belongs to the exact review object on screen; a new review starts unticked.
        onConsent = { checked -> if (review != null && admitted(review)) { consentReview = review; consent = checked } else explainWait() },
        onConfirm = {
            if (review != null && goldForgeSmeltConsentCurrent(review, consentReview, consent) && sendingReview == null && admitted(review)) {
                val job = model.confirm(review)
                if (job == null) explainWait()
                else {
                    sendingReview = review
                    coroutineScope.launch {
                        job.join()
                        if (sendingReview === review) sendingReview = null
                        // An accepted receipt reserved the basket: read today's load again (GET only) so the held face
                        // shows the server's committed value, never a client sum.
                        if (goldForgeSmeltSettlementWatch(model.state.value) != null && readAllowed()) model.refresh()
                    }
                }
            } else explainWait()
        },
        onBack = { if (goldForgeSmeltMayDismiss(review, sendingReview)) model.dismiss() else explain(GOLD_FORGE_SMELT_SENDING) },
        onFindRaid = { leave(findRaid) },
        onRetry = { if (readAllowed()) model.refresh() else explainWait() },
        onMinusHold = { edit(it, GoldForgeSmeltEdit.REMOVE) },
        onResultGo = { if (hostCurrent()) goClaim() else explainWait() },
        // Tapping the settlement callout files the settled original (its receipt stays in history).
        onResultDismiss = {
            if (model.state.value.journal.operation?.proof?.settlement != null && readAllowed()) model.finish() else explainWait()
        },
        onGoWorkshop = { leave(goWorkshop) },
        onGoBuild = { leave(goBuild) },
        onExplain = { explain(it) },
    )
    val recoveryContent: @Composable ColumnScope.() -> Unit = {
        GoldForgeSmeltRecovery(model, owner, saved, selectedBase, reading, actionsAllowed, admitted = { admitted() },
            readAllowed = { readAllowed() }, currentBase = { currentScope.baseId }, onEdit = { id, kind -> edit(id, kind) },
            onFindRaid = actions.onFindRaid, onRefused = { explain(it) })
    }
    val seal = owner.seal
    val overlay: @Composable () -> Unit = { SmeltSeal(seal, actions) }
    return GoldForgeSmeltBinding(shown, actions, state.review != null || sendingReview != null,
        if (goldForgeSmeltRecoveryNeeded(shown, saved)) recoveryContent else null, overlay)
}
