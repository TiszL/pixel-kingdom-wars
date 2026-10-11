package gg.pixelkingdomwars.nativeclient.ui.sheets.army.live

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.unit.dp
import androidx.compose.ui.zIndex
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import gg.pixelkingdomwars.nativeclient.data.BaseState
import gg.pixelkingdomwars.nativeclient.network.trainingCancelTarget
import gg.pixelkingdomwars.nativeclient.ops.IntentKind
import gg.pixelkingdomwars.nativeclient.ui.battle.BattleDecisionDialog
import gg.pixelkingdomwars.nativeclient.ui.battle.BattleDialogLine
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import androidx.compose.foundation.layout.fillMaxWidth
import gg.pixelkingdomwars.nativeclient.ui.ScreenNotice
import gg.pixelkingdomwars.nativeclient.ui.army.ResearchCurrencyConfirm
import gg.pixelkingdomwars.nativeclient.ui.roster.HeroCurrencyConfirm
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.army.ArmyUiState
import gg.pixelkingdomwars.nativeclient.ui.army.ArmyViewModel
import gg.pixelkingdomwars.nativeclient.ui.army.TrainingFinishCurrencyConfirm
import gg.pixelkingdomwars.nativeclient.ui.army.trainingCurrentArmy
import gg.pixelkingdomwars.nativeclient.ui.attack.AttackViewModel
import gg.pixelkingdomwars.nativeclient.ui.displayClock
import gg.pixelkingdomwars.nativeclient.ui.home.HomeRequest
import gg.pixelkingdomwars.nativeclient.ui.home.HomeRequests
import gg.pixelkingdomwars.nativeclient.ui.kit.FullScreenSheetBackdrop
import gg.pixelkingdomwars.nativeclient.ui.kit.FullScreenSheetEffect
import gg.pixelkingdomwars.nativeclient.ui.kit.FullScreenSheetGeometry
import gg.pixelkingdomwars.nativeclient.ui.kit.fullScreenSheetShelf
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.SheetScrim
import gg.pixelkingdomwars.nativeclient.ui.kit.ToastHost
import gg.pixelkingdomwars.nativeclient.ui.kit.ToastQueue
import gg.pixelkingdomwars.nativeclient.ui.model.CommandUi
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.SheetSize
import gg.pixelkingdomwars.nativeclient.ui.model.ToastKind
import gg.pixelkingdomwars.nativeclient.ui.model.ToastUi
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import gg.pixelkingdomwars.nativeclient.ui.roster.CodexData
import gg.pixelkingdomwars.nativeclient.ui.roster.RosterViewModel
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.ARMY_TAB_ARMY
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.ARMY_TAB_TRAIN
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.ArmyActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.ArmyFooter
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.ArmySheet
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.ArmyTallSheet
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.HERO_TAB_GEAR
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.HERO_TAB_HERO
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.HERO_TAB_SKILLS
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.HeroSwitchButton
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.HeroTabExtrasUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.HeroTabV2
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.HeroState
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.HeroSkillsActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.HeroSkillsTab
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.HeroesActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.HeroesSheet
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.HeroesUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.RAID_TAB_REVENGE
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.RaidActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.RaidRevengeTab
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.RaidRevengeFooter
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.RaidChooserSheet
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.ResearchActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.ResearchSheet
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.TrainActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.heroTabs
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.serialization.json.JsonObject

/*
 * Hosts of the live army sheets (MS-C2 interim, Opus lane). Each host collects the SAME view model the current screen
 * uses, runs the same read effects (refresh on resume, timer-driven refetch, review dismissal on pause), maps state with
 * the pure mappers in this package and renders the Opus sheet in a TALL slot (kit SheetScrim + y 104 → bottom; the
 * Codex SheetHost / SheetStack does not exist yet). Every action calls the existing view-model function the current
 * screen calls. Money is never rebuilt here: training FINISH, research FINISH and hero UPGRADE / FINISH rest request the
 * existing server review and mount its existing consent (the Gems Seal, or the KEEP dialog) over the sheet; TRAIN shows
 * the existing server quote in the designed ConfirmDialog; LOAD / SAVE of a saved army stay on the sheet. Saved-payment
 * recovery is on the sheets (SavedPaymentRecovery.kt). On Home the history icon opens the designed destination the caller
 * passes (`onHistoryDoor`: Battle log or History sheet); only the standalone routes, which pass none, still keep the
 * CURRENT screen behind it ([legacy]: saved-army edit and delete), and Back returns here.
 *
 * Pointer rule: the only full-size pointer node is the kit FullScreenSheetBackdrop (phone width) or SheetScrim (wide
 * window), composed only while the TALL sheet is shown; the sheet and toasts are painted panels. Toasts are local (kit ToastQueue / ToastHost) until the OverlayHost exists.
 */

/** A host's local toast list (kit ToastQueue rules: same key merges, at most 3, 4 s each). */
@Stable internal class LiveToasts {
    var list: List<ToastUi> by mutableStateOf(emptyList())
    fun post(key: String, message: String, error: Boolean = false) {
        list = ToastQueue.post(list, ToastUi(key, message, null, if (error) ToastKind.ERROR else ToastKind.INFO, null, null,
            report = false, postedAtMs = 0L), System.currentTimeMillis())
    }
    /** A DISABLED / LOCKED command's tap: its reason, never silence. */
    fun refused(cmd: CommandUi) = post(cmd.id.value, cmd.reason ?: "Not available right now.")
}

@Composable internal fun rememberLiveToasts(): LiveToasts {
    val toasts = remember { LiveToasts() }
    LaunchedEffect(toasts.list) {
        val next = ToastQueue.nextExpiry(toasts.list) ?: return@LaunchedEffect
        delay((next - System.currentTimeMillis()).coerceAtLeast(0L))
        toasts.list = ToastQueue.expire(toasts.list, System.currentTimeMillis())
    }
    return toasts
}

/** Posts a view-model notice once and clears it (the current screens draw it as a banner). */
@Composable internal fun NoticeToToast(notice: ScreenNotice?, toasts: LiveToasts, clear: () -> Unit) {
    LaunchedEffect(notice) { notice?.let { toasts.post("notice", it.message, it.error); clear() } }
}

/** The TALL slot and the toasts over the footer. Owner 2026-10-06 ("make it full screen"): on a phone-width window the
 *  sheet is one opaque full-screen card (kit FullScreenSheet.kt): an opaque backdrop over the whole window, the sheet
 *  edge to edge from below the resource shelf to the safe bottom, no scrim and no world strip. On a wide window it keeps
 *  the framed design: the kit 40 % scrim (tap = close), the sheet from y 104 under the safe top (4 dp sides, above the
 *  navigation bar). Its parent is the whole window ([ArmyHomeFrame], or a route screen). */
@Composable internal fun ArmyLiveTallSlot(onScrimTap: () -> Unit, toasts: LiveToasts, sheet: @Composable BoxScope.(Modifier) -> Unit) {
    val fills = FullScreenSheetGeometry.fillsScreen(SheetSize.TALL, LocalConfiguration.current.screenWidthDp.toFloat())
    FullScreenSheetEffect(active = fills)
    val shelf = fullScreenSheetShelf()
    Box(Modifier.fillMaxSize()) {
        if (fills) FullScreenSheetBackdrop() else SheetScrim(SheetSize.TALL, onScrimTap)
        sheet(if (fills) Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing).padding(top = shelf).zIndex(PkwTokens.Z.SHEET)
            else Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal))
                .windowInsetsPadding(WindowInsets.navigationBars)
                .padding(start = 4.dp, end = 4.dp, top = ARMY_FRAMED_TOP_GAP + PkwTokens.Dims.tallSheetTop).zIndex(PkwTokens.Z.SHEET))
        ToastHost(toasts.list, onGo = {}, onReport = {}, Modifier.align(Alignment.BottomCenter).padding(bottom = 132.dp).zIndex(PkwTokens.Z.TOAST))
    }
}

/** The framed (wide-window) slot keeps the 24 dp the former ArmyHomeFrame added under the safe top. */
internal val ARMY_FRAMED_TOP_GAP = 24.dp

/** Dismisses a review on pause and on dispose, like the current screens (an unsent consent never outlives the view). */
@Composable private fun DismissOnPause(key: Any, dismiss: () -> Unit) {
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(key, lifecycle) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_PAUSE) dismiss() }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer); dismiss() }
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Army (TRAIN + ARMY)
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The Army sheet (TRAIN · ARMY) over [ArmyViewModel]: what `ArmyScreen` does, through the Opus `ArmySheet`.
 * A queued [HomeRequest.Training] opens TRAIN (and is consumed here, like ArmyScreen); otherwise ARMY.
 * In place on the sheet (S1): TRAIN shows the server quote in [TrainReviewConfirm]; a paid FINISH requests the existing
 * review and mounts `TrainingFinishCurrencyConfirm` (Gems Seal, or the KEEP dialog); LOAD fills the TRAIN draft from a
 * saved army (spends nothing); SAVE writes today's army into an empty slot.
 * [legacy] is the current ArmyScreen behind the history icon only on a standalone route that passes no [onHistoryDoor]; its
 * back returns here.
 */
@Composable internal fun ArmyLiveHost(model: ArmyViewModel, requests: HomeRequests, baseGeneration: Long, actionsAllowed: Boolean,
    onBack: () -> Unit, onOpenHero: (String) -> Unit, onOpenBuildTray: () -> Unit, onAttack: () -> Unit, onNeedMore: (PriceUi) -> Unit,
    legacy: @Composable (onDone: () -> Unit) -> Unit,
    /** SPEC §1 history: the designed destination (the Battle log); null keeps [legacy] behind the icon (standalone routes). */
    onHistoryDoor: (() -> Unit)? = null) {
    val state by model.state.collectAsState()
    val actionBusy by model.busy.collectAsState()
    val notice by model.notice.collectAsState()
    val busy = actionBusy || state.domain.loading
    val now = displayClock()
    val request by requests.pending.collectAsState()
    var tab by rememberSaveable { mutableStateOf(if (request == HomeRequest.Training) ARMY_TAB_TRAIN else ARMY_TAB_ARMY) }
    var legacyOpen by rememberSaveable { mutableStateOf(false) }
    var infoTroop by remember(state.wallet, state.baseId, baseGeneration) { mutableStateOf<String?>(null) }
    // The empty slot whose SAVE is in flight: only its row shows the dots; cleared when that save's job ends.
    var savingSlot by remember { mutableStateOf<Int?>(null) }
    // The saved army whose manage dialog is open (replace / delete), or null.
    var manageSlot by remember(state.wallet, state.baseId, baseGeneration) { mutableStateOf<Int?>(null) }
    val toasts = rememberLiveToasts()
    LaunchedEffect(request, legacyOpen) {
        if (!legacyOpen && request == HomeRequest.Training) { tab = ARMY_TAB_TRAIN; requests.consume(HomeRequest.Training) }
    }
    if (legacyOpen) { legacy { legacyOpen = false }; return }

    DismissOnPause(model) { model.dismissTrainingFinishReview() }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(model, lifecycle, state.wallet, state.baseId, baseGeneration, actionsAllowed, state.ordersAllowed) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            model.busy.first { !it }
            model.refreshTrainingFinish(includeHeroes = true)?.join(); kotlinx.coroutines.awaitCancellation()
        }
    }
    val army = trainingCurrentArmy(state, baseGeneration)
    val headFinish = army?.queue?.firstOrNull()?.finishesAt
    LaunchedEffect(headFinish) {
        val end = secondsUntil(headFinish, 0L)?.times(1000) ?: return@LaunchedEffect
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            delay(if (end <= System.currentTimeMillis()) 2_000 else end - System.currentTimeMillis() + 1_500)
            model.busy.first { !it }
            model.refreshTrainingFinish()?.join(); kotlinx.coroutines.awaitCancellation()
        }
    }
    // Saved armies are read once when the ARMY tab needs them (the same GET the current SAVED ARMIES toggle sends).
    LaunchedEffect(tab, state.presetRules != null, state.domain.presets == null) {
        if (tab == ARMY_TAB_ARMY && state.presetRules != null && state.domain.presets == null && !state.presetsOpen) model.togglePresets()
    }
    NoticeToToast(notice, toasts, model::dismissNotice)
    NoticeToToast(state.domain.error?.let { ScreenNotice(it, true) } ?: state.domain.message?.let { ScreenNotice(it, false) }, toasts, model::clearNotice)
    BackHandlerAt(BackPriority.SHEET, enabled = state.domain.reviewed != null) { model.dismissQuote() }
    BackHandlerAt(BackPriority.SHEET, enabled = state.domain.trainingFinishReview != null) { model.dismissTrainingFinishReview() }
    BackHandlerAt(BackPriority.SHEET, enabled = state.domain.reviewed == null && state.domain.trainingFinishReview == null) {
        if (infoTroop != null) infoTroop = null else onBack()
    }

    val train = trainLiveUi(state, baseGeneration, now, busy, actionsAllowed)
    val overview = armyLiveUi(state, baseGeneration, now, busy, savingSlot)
    // Why the TRAIN draft cannot change right now (+1 or LOAD), read from the model's current state; null when it can.
    fun composerRefusal(current: ArmyUiState): String? = when {
        current.wallet != state.wallet || current.baseId != state.baseId || trainingCurrentArmy(current, baseGeneration) == null ->
            "Wait for the current army to load."
        model.busy.value || current.domain.loading -> "Waiting for the server."
        else -> trainComposerReason(current)
    }
    val onTrain = TrainActions(
        onClose = onBack, onHistory = { if (onHistoryDoor != null) onHistoryDoor() else legacyOpen = true }, onTab = { tab = it },
        onAdd = { troop ->
            val current = model.state.value
            // Owner 2026-10-11: short Shards is a message on the Barracks, never a hop to the Gold Forge.
            composerRefusal(current)?.let { toasts.post("composer", it) }
                ?: trainShortMessage(current, baseGeneration, troop)?.let { toasts.post("short", it, error = true) } ?: model.selectOne(troop)
        },
        onRemove = { troop -> model.selectOne(troop, -1) },
        onLastArmy = { model.retrainPrevious() },
        onTrain = { model.quote() },
        onFinish = {
            // The server's free first finish runs exactly as ArmyScreen runs it. A paid finish re-maps FINISH from the
            // model's current state and, while it is still ENABLED for this base, asks the existing owner for its review;
            // the consent mounted below (TrainingFinishCurrencyConfirm) shows the price and confirms. Otherwise its reason.
            if (army?.freeFinishAllOffer != null) model.finishAll(free = true)
            else {
                val current = model.state.value
                val fresh = trainLiveUi(current, baseGeneration, System.currentTimeMillis(), model.busy.value || current.domain.loading,
                    actionsAllowed).finish
                if (fresh?.state == CommandState.ENABLED && current.domain.trainingFinishReview == null &&
                    current.wallet == state.wallet && current.baseId == state.baseId &&
                    trainingCurrentArmy(current, baseGeneration)?.freeFinishAllOffer == null) model.reviewTrainingFinish()
                else toasts.post("training-finish", fresh?.reason ?: "Review the training queue again.")
            }
        },
        onLocked = { troop -> infoTroop = troop },
        onShort = { troop ->
            val current = model.state.value
            if (current.wallet == state.wallet && current.baseId == state.baseId) {
                trainShortMessage(current, baseGeneration, troop)?.let { toasts.post("short", it, error = true) }
                    ?: toasts.post("short", "Your balance changed. Tap the troop again to refresh the selection.")
            }
        },
        onQueueChip = { i ->
            val troop = train.queue.getOrNull(i)?.troop
            when {
                troop == null || army == null -> Unit
                trainingCancelTarget(army.queue, troop) == null -> toasts.post("queue", "This training finishes normally; it has no refund to cancel.")
                else -> trainComposerReason(state)?.let { toasts.post("composer", it) } ?: model.cancelOne(troop)
            }
        },
        onNoRoom = { troop -> toasts.post("room", state.capacityReason(troop)?.label?.lowercase()?.replaceFirstChar { it.uppercase() }
            ?: "Camp and queue are full. FINISH or raid.") },
        onNeedMore = onNeedMore, onRefused = toasts::refused,
    )
    val onArmy = ArmyActions(
        onClose = onBack, onHistory = { if (onHistoryDoor != null) onHistoryDoor() else legacyOpen = true }, onTab = { tab = it },
        onTroop = { troop -> infoTroop = troop },
        onHero = { hero -> if (overview.heroes.firstOrNull { it.hero == hero }?.state == HeroState.NOT_RECRUITED) onOpenBuildTray() else onOpenHero(hero) },
        onLoadSaved = { slot ->
            // SPEC §3: LOAD fills the TRAIN draft and switches to TRAIN; it spends nothing (TRAIN still quotes on the server).
            val current = model.state.value
            val refusal = composerRefusal(current)
            val fill = savedArmyFill(current, baseGeneration, slot)
            when {
                refusal != null -> toasts.post("composer", refusal)
                fill == null -> toasts.post("saved", "That saved army is empty")
                else -> {
                    model.clearQuantities()
                    fill.quantities.forEach { (troop, count) -> model.setQuantity(troop, count.toString()) }
                    tab = ARMY_TAB_TRAIN
                    if (fill.dropped > 0) toasts.post("saved", "${fill.dropped} ${if (fill.dropped == 1) "troop" else "troops"} didn't fit")
                }
            }
        },
        onSaveSlot = { slot ->
            // "Empty · save today's army": the camp's troops into this slot through the existing preset owner (a plan, no
            // purchase). Replacing or deleting a saved army is its name's manage dialog (onManageSaved below).
            val current = model.state.value
            val composition = currentArmyPresetComposition(current, baseGeneration)
            when {
                model.busy.value -> toasts.post("saved", "Waiting for the server.")
                current.wallet != state.wallet || current.baseId != state.baseId || trainingCurrentArmy(current, baseGeneration) == null ->
                    toasts.post("saved", "Wait for the current army to load.")
                current.domain.presets?.any { it.slot == slot } == true -> toasts.post("saved", "Slot $slot already holds a saved army.")
                composition == null -> toasts.post("saved", "Train troops first")
                else -> {
                    val job = model.saveCurrentArmy(slot, "ARMY $slot", composition)
                    if (job == null) toasts.post("saved", "Waiting for the server.")
                    else { savingSlot = slot; job.invokeOnCompletion { if (savingSlot == slot) savingSlot = null } }
                }
            }
        },
        // A saved army's name opens its manage dialog. editPreset only marks the slot for the existing preset owner (no
        // request); the dialog's REPLACE / DELETE send the same PUT / DELETE the old ArmyScreen editor sent.
        onManageSaved = { slot ->
            if (model.state.value.domain.presets?.any { it.slot == slot } == true) { model.editPreset(slot); manageSlot = slot }
            else toasts.post("saved", "That saved army is empty")
        },
        onAttack = onAttack, onNeedMore = onNeedMore, onRefused = toasts::refused,
    )
    manageSlot?.let { slot ->
        val preset = state.domain.presets?.firstOrNull { it.slot == slot }
        val close: () -> Unit = { model.cancelEditing(); manageSlot = null }
        // A dialog that leaves without CLOSE (base switch, sheet swap) must not leave its slot marked: Home refuses to swap
        // the army owner while a saved-army draft is open. DELETE has already read the draft when this runs.
        DisposableEffect(slot) { onDispose { if (model.state.value.presetDraft?.slot == slot) model.cancelEditing() } }
        BattleDecisionDialog("ARMY $slot", onDismiss = close, body = {
            BattleDialogLine(preset?.name ?: "Saved army")
            SecondaryButton("REPLACE WITH TODAY'S ARMY", {
                val current = model.state.value
                val composition = currentArmyPresetComposition(current, baseGeneration)
                when {
                    model.busy.value -> toasts.post("saved", "Waiting for the server.")
                    composition == null -> toasts.post("saved", "Train troops first")
                    else -> { model.saveCurrentArmy(slot, preset?.name ?: "ARMY $slot", composition); close() }
                }
            }, Modifier.fillMaxWidth(), verb = Verb.BLUE, enabled = !busy && preset != null)
            SecondaryButton("DELETE", {
                if (!model.busy.value && model.state.value.presetDraft?.slot == slot) { model.deletePreset(); manageSlot = null }
                else toasts.post("saved", "Waiting for the server.")
            }, Modifier.fillMaxWidth(), verb = Verb.RED, enabled = !busy && preset != null)
        }) {
            SecondaryButton("CLOSE", close, Modifier.weight(1f))
        }
    }
    val info = infoTroop?.let { armyTroopInfo(state, baseGeneration, it) }
    // A saved training payment is checked and re-reviewed ON the TRAIN panel (SavedPaymentRecovery.kt), not on the old screen.
    val savedPayments = trainingSavedPayments(state)
    val trainRecovery: (@Composable ColumnScope.() -> Unit)? = if (savedPayments.isEmpty) null else ({
        SavedPaymentRecovery(savedPayments, "SAVED TRAINING PAYMENT", state, busy, actionsAllowed, model, onReview = {
            val current = model.state.value
            val saved = trainingSavedPayments(current).saved.firstOrNull(::savedPaymentReviewShown)
            if (saved != null && current.domain.trainingFinishReview == null &&
                savedPaymentReviewEnabled(current, saved, model.busy.value || current.domain.loading, actionsAllowed)) model.reviewTrainingFinishSaved()
            else toasts.post("saved-payment", "The original payment is unresolved. Check its receipt before another finish.")
        })
    })
    if (info == null) ArmyLiveTallSlot(onBack, toasts) { modifier -> ArmySheet(tab, train, overview, onTrain, onArmy, modifier, trainRecovery = trainRecovery) }
    else ArmyTroopInfoSheet(info, onClose = { infoTroop = null }, onGo = {
        val current = model.state.value
        val fresh = if (current.wallet == state.wallet && current.baseId == state.baseId)
            armyTroopInfo(current, baseGeneration, info.troop) else null
        if (fresh?.focusBuildingId != null && fresh.focusBuildingId == info.focusBuildingId) {
            requests.request(HomeRequest.FocusBuilding(fresh.focusBuildingId))
            infoTroop = null; onBack()
        } else infoTroop = null
    })
    // The server quote of TRAIN, in the designed ConfirmDialog (the server step stays; only the look changed).
    TrainReviewConfirm(state.domain.reviewed, busy || state.trainingBlocked, model::confirmTraining, model::dismissQuote,
        onNothingToQueue = { toasts.post("train-review", NOTHING_TO_QUEUE) })
    // The paid FINISH consent: the existing owner's Gems Seal, or its KEEP dialog (A5 decision), over the sheet.
    TrainingFinishCurrencyConfirm(state, busy, actionsAllowed, baseGeneration, model)
}

// ---------------------------------------------------------------------------------------------------------------------
// Research
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The Alchemy Lab sheet over [ArmyViewModel]: what `ResearchScreen` does, through the Opus `ResearchSheet`. START is the
 * same direct Shards order; FINISH requests the existing review and mounts `ResearchCurrencyConfirm` over the sheet;
 * saved-payment recovery acts on the sheet; history opens `onHistoryDoor`, or [legacy] (the current ResearchScreen) only
 * on the standalone route that passes none.
 */
@Composable internal fun ResearchLiveHost(model: ArmyViewModel, baseGeneration: Long, actionsAllowed: Boolean, onBack: () -> Unit,
    onFocusBuilding: (String) -> Unit, onNeedMore: (PriceUi) -> Unit, legacy: @Composable (onDone: () -> Unit) -> Unit,
    /** SPEC §1 history: the designed destination (the History sheet); null keeps [legacy] behind the icon (standalone routes). */
    onHistoryDoor: (() -> Unit)? = null) {
    val state by model.state.collectAsState()
    val actionBusy by model.busy.collectAsState()
    val notice by model.notice.collectAsState()
    val busy = actionBusy || state.domain.loading
    val now = displayClock()
    var selected by rememberSaveable { mutableStateOf<String?>(null) }
    var legacyOpen by rememberSaveable { mutableStateOf(false) }
    val toasts = rememberLiveToasts()
    if (legacyOpen) { legacy { legacyOpen = false }; return }

    DismissOnPause(model) { model.dismissResearchReview() }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(model, lifecycle, state.wallet, baseGeneration, actionsAllowed) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            model.busy.first { !it }
            model.refreshResearch()?.join(); kotlinx.coroutines.awaitCancellation()
        }
    }
    val data = researchLiveData(state, baseGeneration)
    val activeFinish = data?.army?.research?.firstOrNull()?.finishesAt
    LaunchedEffect(activeFinish) {
        val end = secondsUntil(activeFinish, 0L)?.times(1000) ?: return@LaunchedEffect
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            delay(if (end <= System.currentTimeMillis()) 2_000 else end - System.currentTimeMillis() + 1_500)
            model.busy.first { !it }
            model.refreshResearch()?.join(); kotlinx.coroutines.awaitCancellation()
        }
    }
    NoticeToToast(notice, toasts, model::dismissNotice)
    NoticeToToast(state.domain.error?.let { ScreenNotice(it, true) } ?: state.domain.message?.let { ScreenNotice(it, false) }, toasts, model::clearNotice)
    BackHandlerAt(BackPriority.SHEET, enabled = state.domain.researchReview != null) { model.dismissResearchReview() }
    BackHandlerAt(BackPriority.SHEET, enabled = state.domain.researchReview == null) { onBack() }

    val ui = researchLiveUi(state, baseGeneration, now, selected, busy, actionsAllowed)
    val on = ResearchActions(
        onClose = onBack, onHistory = { if (onHistoryDoor != null) onHistoryDoor() else legacyOpen = true },
        onSelect = { selected = it },
        onResearch = {
            val troop = ui.selected?.troop
            val choice = data?.choices?.firstOrNull { it.troop == troop }
            val order = if (data != null && choice != null) researchStartOrder(data, choice) else null
            if (order == null) toasts.post("research", "Pick a troop to research.") else model.submitResearch(order)
        },
        onFinish = {
            val current = model.state.value
            val fresh = researchLiveUi(current, baseGeneration, System.currentTimeMillis(), selected,
                model.busy.value || current.domain.loading, actionsAllowed)
            val command = fresh.finishCommand()
            val troop = fresh.job?.troop
            if (command?.state != CommandState.ENABLED || troop == null || troop != ui.job?.troop)
                toasts.post("research-finish", command?.reason ?: "Review the current research again.")
            else model.reviewResearchFinish(troop)
        },
        onLabCap = {
            val forge = state.home.base?.buildings?.filter { it.type == "forge" }?.maxByOrNull { it.level }
            if (forge != null) onFocusBuilding(forge.id) else toasts.post("labcap", "Upgrade the Alchemy Lab to research higher levels.")
        },
        onShort = { troop -> data?.choices?.firstOrNull { it.troop == troop }?.let { researchPrice(it) }?.let(onNeedMore) },
        onLocked = { troop -> toasts.post("locked-$troop", researchCardReason(state, baseGeneration, troop) ?: "This research is not open yet.") },
        onBusyCard = { toasts.post("busy", "The Lab works on one troop at a time.") },
        onRefresh = { model.refreshResearch() },
        // In place: the existing GET-only receipt observation (the old ResearchScreen's CHECK), never the old screen.
        onCheckPayment = { if (model.busy.value) toasts.post("busy", "Waiting for the server.") else model.interrupted.check(IntentKind.RESEARCH) },
        onNeedMore = onNeedMore, onRefused = toasts::refused,
    )
    // A saved research payment is checked and re-reviewed ON the sheet (SavedPaymentRecovery.kt); its rows replace the
    // one-line CHECK row, which would only repeat them.
    val savedPayments = researchSavedPayments(state)
    val recovery: (@Composable ColumnScope.() -> Unit)? = if (savedPayments.isEmpty) null else ({
        SavedPaymentRecovery(savedPayments, "SAVED RESEARCH PAYMENT", state, busy, actionsAllowed, model, onReview = {
            val current = model.state.value
            val saved = researchSavedPayments(current).saved.firstOrNull(::savedPaymentReviewShown)
            if (saved != null && current.domain.researchReview == null &&
                savedPaymentReviewEnabled(current, saved, model.busy.value || current.domain.loading, actionsAllowed)) model.reviewResearchSaved()
            else toasts.post("saved-payment", "The original payment is unresolved. Check its receipt before another finish.")
        })
    })
    ArmyLiveTallSlot(onBack, toasts) { modifier ->
        ResearchSheet(if (recovery != null) ui.copy(pendingPayment = null) else ui, on, modifier, recovery = recovery)
    }
    ResearchCurrencyConfirm(state, busy, actionsAllowed, model, baseGeneration)
}

// ---------------------------------------------------------------------------------------------------------------------
// Heroes (HERO + SKILLS; GEAR opens the current Inventory)
// ---------------------------------------------------------------------------------------------------------------------

/** The Heroes sheet frame with the re-done HERO tab (`HeroTabV2`) as its body: HeroesSheet's own frame, footer and
 *  hero switch, composed here because HeroesSheet.kt keeps its round 1 `HeroTab` private (new files only). */
@Composable internal fun HeroLiveSheet(ui: HeroesUi, extras: HeroTabExtrasUi, on: HeroesActions, modifier: Modifier = Modifier,
    skillsTab: (@Composable ColumnScope.() -> Unit)? = null) {
    val switchTo = ui.header.switchTo
    ArmyTallSheet(ui.header, heroTabs(ui.portrait, ui.skills.firstOrNull()?.icon ?: "ui_skill_rally", ui.gearNew), ui.tab,
        on.onClose, on.onHistory, on.onTab, modifier,
        headerTrailing = if (switchTo != null) ({ HeroSwitchButton(switchTo, on.onSwitchHero) }) else null,
        // heroes.png / heroes-theodor.png: the footer info line under the price is t-ink, not the lighter t-ink2 default.
        footer = { ArmyFooter(ui.footer, on.onUpgrade, on.onNeedMore, on.onRefused, infoWidth = 132.dp, infoColor = PkwTokens.Colors.textOnParch) }) {
        if (ui.tab == HERO_TAB_SKILLS && skillsTab != null) skillsTab.invoke(this) else HeroTabV2(ui, extras, on)
    }
}

/**
 * The Hero Altar sheet over [RosterViewModel]: what `HeroesScreen` shows, through the Opus Heroes sheet. UPGRADE and
 * FINISH rest are KEEP / Gems spends: they request the existing review and mount `HeroCurrencyConfirm` over the sheet.
 */
@Composable internal fun HeroesLiveHost(model: RosterViewModel, initialHero: String?, onBack: () -> Unit, onRecruit: () -> Unit,
    onOpenGear: () -> Unit, onNeedMore: (PriceUi) -> Unit, legacy: @Composable (onDone: () -> Unit) -> Unit,
    /** SPEC §1 history on every tab: the designed destination (the History sheet); null keeps the old doors (standalone routes). */
    onHistoryDoor: (() -> Unit)? = null) {
    val state by model.state.collectAsState()
    val actionBusy by model.busy.collectAsState()
    val notice by model.notice.collectAsState()
    val busy = actionBusy || state.domain.loading
    val now = displayClock()
    var hero by rememberSaveable(model, initialHero) { mutableStateOf(initialHero ?: state.selectedHero) }
    LaunchedEffect(model, hero) { if (model.state.value.selectedHero != hero) model.selectHero(hero) }
    var selectedSlot by rememberSaveable(model, hero) { mutableStateOf<String?>(null) }
    var skillInfoId by rememberSaveable(model, hero, state.home.base?.baseId) { mutableStateOf<String?>(null) }
    var tab by rememberSaveable { mutableStateOf(HERO_TAB_HERO) }
    var legacyOpen by rememberSaveable { mutableStateOf(false) }
    val toasts = rememberLiveToasts()
    if (legacyOpen) { legacy { legacyOpen = false }; return }

    val ui = heroesLiveUi(state, hero, tab, now, busy, selectedSlot).let { mapped ->
        mapped.copy(skills = mapped.skills.map { it.copy(icon = heroSkillIcon(hero, it.id).orEmpty()) })
    }
    val skillInfo = skillInfoId?.let { heroSkillInfoLiveUi(state, hero, ui, it) }
    val skills = if (tab == HERO_TAB_SKILLS) heroSkillsLiveUi(state, hero, ui) else null
    // SKILLS stays on the sheet when the skill read is not usable (S1: it used to hop to the legacy HeroesScreen). The R2
    // integer fields cannot show unknown levels and round-one HeroesSheet would turn them into Lv 0, so neither draws
    // them: a hero not yet recruited shows its recruit state on HERO; otherwise SKILLS says the details are loading and
    // CHECK reads the roster again.
    val skillsPending = tab == HERO_TAB_SKILLS && skills == null
    val shown = if (skillsPending && ui.recruit != null) ui.copy(tab = HERO_TAB_HERO) else ui

    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(model, lifecycle) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_STOP) model.dismissHeroReview() }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer); model.dismissHeroReview() }
    }
    LaunchedEffect(Unit) { model.loadHeroes() }
    LaunchedEffect(model, hero, state.home.base?.baseId) { model.loadInventory() }
    // The roster re-reads when the base snapshot's hero recovery state changes (HeroesScreen's `heroRecoveryRevision`).
    val recoveryRevision = state.home.base?.raw?.get("heroes")?.toString()
    var priorRevision by remember { mutableStateOf(recoveryRevision) }
    LaunchedEffect(recoveryRevision) { if (priorRevision != null && recoveryRevision != null && priorRevision != recoveryRevision) model.loadHeroes(); priorRevision = recoveryRevision }
    NoticeToToast(notice, toasts, model::dismissNotice)
    NoticeToToast(state.domain.error?.let { ScreenNotice(it, true) } ?: state.domain.message?.let { ScreenNotice(it, false) }, toasts, model::clearNotice)
    BackHandlerAt(BackPriority.SHEET, enabled = state.domain.heroReview != null) { model.dismissHeroReview() }
    BackHandlerAt(BackPriority.SHEET, enabled = state.domain.heroReview == null) { if (skillInfoId != null) skillInfoId = null else onBack() }

    val saveGear: () -> Unit = {
        val current = model.state.value
        val itemId = gearEquipItem(current, hero, selectedSlot, model.busy.value || current.domain.loading,
            expectedItemId = ui.gear.selectedItem?.id, expectedWorn = ui.gear.selectedItem?.worn)
        if (itemId == null) toasts.post("gear", "Equipment changed or is unavailable. Select the item again.")
        else model.equip(itemId)
    }
    val on = HeroesActions(
        onClose = onBack, onHistory = { if (onHistoryDoor != null) onHistoryDoor() else if (tab == HERO_TAB_GEAR) onOpenGear() else legacyOpen = true },
        onTab = { next -> tab = next },
        onSwitchHero = { hero = otherHero(hero); model.selectHero(hero) },
        onUpgrade = {
            val current = model.state.value
            val command = heroPrimary(current, current.hero(hero), model.busy.value || current.domain.loading).primary
            if (current.domain.heroReview != null || command.state != CommandState.ENABLED)
                toasts.post("hero-upgrade", command.reason ?: "Finish the current review first.")
            else model.reviewHeroUpgrade(hero)
        },
        onSkill = { id ->
            val current = model.state.value
            if (heroSkillInfoLiveUi(current, hero, ui, id) != null) skillInfoId = id
            else toasts.post("skill", "Skill details are unavailable.")
        },
        onAllSkills = { tab = HERO_TAB_SKILLS },
        onGearGo = { tab = HERO_TAB_GEAR },
        onSlot = { slot ->
            val current = model.state.value
            val gear = gearLiveProjection(current, hero, slot, model.busy.value || current.domain.loading).gear
            if (current.selectedHero == hero && gear.slots.any { it.slot == slot }) {
                selectedSlot = slot
                val wornId = current.domain.inventory?.loadout(hero)?.equipment?.get(slot)
                if (current.selectedItemId != wornId) model.selectItem(wornId)
            }
        },
        onBagItem = { id ->
            val current = model.state.value
            val gear = gearLiveProjection(current, hero, selectedSlot, model.busy.value || current.domain.loading).gear
            if (current.selectedHero == hero && gear.bag.any { it.id == id }) model.selectItem(id)
        },
        onEquip = saveGear, onUnequip = saveGear,
        onFinishRest = {
            val current = model.state.value
            val command = heroesLiveUi(current, hero, tab, System.currentTimeMillis(), model.busy.value || current.domain.loading).finishRest
            if (current.domain.heroReview != null || command?.state != CommandState.ENABLED)
                toasts.post("hero-recovery", command?.reason ?: "Review this hero's recovery again.")
            else model.reviewHeroRecovery(hero)
        },
        onRecruit = onRecruit,
        onGo = { onRecruit() },
        onNeedMore = onNeedMore, onRefused = toasts::refused,
    )
    if (skillInfo != null) HeroSkillInfoLiveSheet(skillInfo) { skillInfoId = null }
    else ArmyLiveTallSlot(onBack, toasts) { modifier ->
        if (skills != null) HeroLiveSheet(ui, heroTabExtrasLive(state, hero), on, modifier,
            skillsTab = { HeroSkillsTab(skills, HeroSkillsActions(onSkill = on.onSkill, onCheck = model::loadHeroes, onGo = on.onGo)) })
        else if (skillsPending && shown.recruit == null) HeroLiveSheet(shown, heroTabExtrasLive(state, hero), on, modifier,
            skillsTab = {
                PkwText("Skill details are loading.", PkwTokens.Type.body, color = PkwTokens.Colors.textOnParch2, maxLines = 2)
                SecondaryButton("CHECK", { if (model.loadHeroes() == null) toasts.post("skills", "Waiting for the server.") })
            })
        else if (usesHeroTabV2(shown)) HeroLiveSheet(shown, heroTabExtrasLive(state, hero), on, modifier) else HeroesSheet(shown, on, modifier)
    }
    HeroCurrencyConfirm(state, busy, model)
}

// ---------------------------------------------------------------------------------------------------------------------
// Raid chooser (MATCH + CAMPAIGN + live REVENGE)
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The Raid chooser over [AttackViewModel], shown while `model.chooser` is open (it replaces the current bottom sheet).
 * FIND A MATCH, campaign SCOUT / ATTACK, replays and march recovery call the same model functions the attack hub does.
 */
@Composable internal fun RaidChooserLiveHost(model: AttackViewModel, home: BaseState?, landOwned: Boolean, onboarding: Boolean,
    constants: JsonObject?, actionsAllowed: Boolean, onOpenWorld: () -> Unit, onOpenCampaignMap: () -> Unit, onOpenArmy: () -> Unit,
    onTrain: () -> Unit, onRaidLog: () -> Unit, onNeedMore: (PriceUi) -> Unit,
    initialTab: String? = null, onClose: (() -> Unit)? = null,
    armyState: gg.pixelkingdomwars.nativeclient.ui.army.ArmyUiState? = null) {
    val state by model.state.collectAsState()
    val busy by model.busy.collectAsState()
    val notice by model.notice.collectAsState()
    val historyReadError by model.historyReadError.collectAsState()
    val account = model.accountState?.collectAsState()?.value
    val now = displayClock()
    var tab by rememberSaveable(account?.session, account?.selectedBaseId, initialTab) { mutableStateOf(initialTab ?: raidDefaultTab(landOwned, onboarding)) }
    var stage by rememberSaveable(account?.session, account?.selectedBaseId) { mutableStateOf<Int?>(null) }
    var requested by remember(account?.session, account?.selectedBaseId) { mutableStateOf<String?>(null) }
    val toasts = rememberLiveToasts()
    NoticeToToast(notice, toasts, model::dismissNotice)
    fun close() { model.closeChooser(); onClose?.invoke() }
    BackHandlerAt(BackPriority.SHEET) { close() }
    val currentHome = home?.takeIf { it.base?.baseId == account?.selectedBaseId }
    val history = currentBattleHistory(state.history, account?.selectedBaseId)
    fun currentHistory() = currentBattleHistory(model.state.value.history, model.accountState?.value?.selectedBaseId)
    fun replay(id: String) {
        if (!model.busy.value) battleLogRecord(currentHistory(), id)?.let(model::openReplay)
    }
    fun revenge(id: String) {
        val row = battleLogRecord(currentHistory(), id)
        val freshHome = model.baseState?.value?.takeIf { it.base?.baseId == model.accountState?.value?.selectedBaseId }
        val current = raidRevengeLiveUi(currentHistory(), freshHome, constants, System.currentTimeMillis(),
            model.busy.value, model.interlockState?.value?.actionsAllowed == true)
        if (row != null && current.gate == null && current.rows.any { it.id == id && it.revenge != gg.pixelkingdomwars.nativeclient.ui.sheets.army.RevengeState.UNAVAILABLE }) {
            requested = id; model.revenge(row)
        } else toasts.post("revenge", current.gate ?: "Refresh battle history before answering this raid.")
    }
    val campaignArt = rememberCampaignPresentation()
    val ui = raidLiveUi(tab, state, currentHome, account?.selectedBaseId, landOwned, onboarding, constants, now, stage,
        busy || state.loading, actionsAllowed, armyState, account?.baseSelectionGeneration, campaignArt = campaignArt)
    val revengeUi = raidRevengeLiveUi(history, currentHome, constants, now, busy, actionsAllowed, requested.takeIf { busy })
    val on = RaidActions(
        onClose = ::close, onHistory = { close(); onRaidLog() },
        onTab = { tab = it },
        onFind = { model.autoMatch(); onClose?.invoke() },
        onWorldMap = { close(); onOpenWorld() },
        onArmy = { close(); onOpenArmy() },
        onTrain = { close(); onTrain() },
        onReplay = ::replay,
        onStage = { n -> stage = n },
        onScout = { n -> model.scout(n) },
        onCampaignAttack = { n -> model.attack(n) },
        onOpenCampaignMap = { model.closeChooser(); onOpenCampaignMap() },
        onRevenge = ::revenge,
        onRecoverMarch = { model.recover() },
        onNeedMore = onNeedMore, onRefused = toasts::refused,
    )
    val revengeActions = gg.pixelkingdomwars.nativeclient.ui.sheets.army.RaidRevengeActions(
        onRevenge = ::revenge, onReplay = ::replay, onNeedMore = onNeedMore,
        onTrain = { close(); onTrain() }, onExplain = { toasts.post("revenge", it) })
    ArmyLiveTallSlot(::close, toasts) { modifier -> RaidChooserSheet(ui, on, modifier,
        revengeTab = {
            (historyReadError ?: history.error)?.let {
                gg.pixelkingdomwars.nativeclient.ui.kit.PkwText(it, PkwTokens.Type.small, color = PkwTokens.Colors.shortText)
                gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton("REFRESH", { model.refresh() }, enabled = !busy)
            }
            RaidRevengeTab(revengeUi, revengeActions)
        },
        revengeFooter = { RaidRevengeFooter(revengeUi, revengeActions) },
        revengeBadgeCount = revengeUi.rows.count { it.revenge == gg.pixelkingdomwars.nativeclient.ui.sheets.army.RevengeState.AVAILABLE ||
            it.revenge == gg.pixelkingdomwars.nativeclient.ui.sheets.army.RevengeState.ATTACK_BACK }) }
}
