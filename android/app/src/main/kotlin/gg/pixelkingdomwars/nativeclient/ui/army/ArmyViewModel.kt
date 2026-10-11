package gg.pixelkingdomwars.nativeclient.ui.army

import androidx.lifecycle.viewModelScope
import gg.pixelkingdomwars.nativeclient.AppGraph
import gg.pixelkingdomwars.nativeclient.SessionGraph
import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.model.ResearchRow
import gg.pixelkingdomwars.nativeclient.model.TrainingQueueRow
import gg.pixelkingdomwars.nativeclient.model.TroopCount
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.ops.InterruptedIntent
import gg.pixelkingdomwars.nativeclient.ops.IntentKind
import gg.pixelkingdomwars.nativeclient.ops.ReceiptObserver
import gg.pixelkingdomwars.nativeclient.ui.Copy
import gg.pixelkingdomwars.nativeclient.ui.InterruptedActions
import gg.pixelkingdomwars.nativeclient.ui.ScreenViewModel
import java.math.BigInteger
import java.math.RoundingMode
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject

/** A saved army being edited (web trainingPresets.tsx `editing`): a plan, never a purchase. */
data class PresetDraft(val slot: Int, val name: String, val composition: List<TroopCount>, val existing: Boolean)

/** Why a troop card cannot take another unit right now (web TrainTray `capacityReason`). */
enum class CapacityReason(val label: String) { ARMY("ARMY CAPACITY LIMIT"), QUEUE("TRAINING QUEUE CAPACITY LIMIT"), SELECTION("SELECTION LIMIT") }

data class ArmyUiState(
    val domain: ArmyDomainState = ArmyDomainState(),
    val home: BaseState = BaseState(),
    val wallet: String? = null,
    val baseId: String? = null,
    val quantities: Map<String, String> = emptyMap(),
    val interrupted: List<InterruptedIntent> = emptyList(),
    val catalogue: JsonObject? = null,
    val ordersAllowed: Boolean = true,
    /** Rows a −1 tap already cancelled whose POST has not drained (D-096). */
    val pendingCancelIds: Set<String> = emptySet(),
    val presetsOpen: Boolean = false,
    val presetDraft: PresetDraft? = null,
) {
    val draft: ArmyTrainingDraft? get() = if (wallet != null && baseId != null) ArmyTrainingDraft(wallet, baseId, quantities) else null
    val draftComposition: List<TroopCount> get() = quantities.mapNotNull { (troop, text) -> text.toIntOrNull()?.takeIf { it > 0 }?.let { TroopCount(troop, it) } }
    val draftUnits: Int get() = draftComposition.sumOf { it.count }
    val trainingBlocked: Boolean get() = interrupted.any { (it.kind == IntentKind.TRAINING_BATCH || it.kind == IntentKind.TRAINING_CANCEL || it.kind == IntentKind.TRAINING_FINISH) && it.blocking }
    val composerEnabled: Boolean get() = !trainingBlocked && domain.reviewed == null && domain.trainingFinishReview == null && domain.scheduling != TrainingScheduling.UNSUPPORTED && ordersAllowed
    fun cancellation(row: TrainingQueueRow): TrainingCancellationChoice? = TrainingCancellationChoice.of(wallet, baseId, domain.army, row)
    /** The Barracks TRAIN table (pack order, trainable troops only) and the saved-army rules; both fail closed. */
    val trainTable: List<String> get() = trainableTroops(catalogue)
    val presetRules: TrainingPresetRules? get() = TrainingPresetRules.from(catalogue)
    val room: TrainingRoom? get() = domain.army?.let { manualTrainingRoom(catalogue, it.queue, it.rosterPts, it.campCapacityPts, it.barracksQueuePts, draftComposition) }
    fun unlock(troop: String): TroopUnlock = troopUnlockView(catalogue, troop, home.base?.player?.keepLevel, domain.army?.eliteUnlocks)
    fun rollout(troop: String): RolloutGate = troopRolloutGate(catalogue, troop, domain.army?.features?.darkAttackerRoster)
    fun capacityReason(troop: String): CapacityReason? {
        val pts = troopPoints(catalogue, troop) ?: return CapacityReason.SELECTION
        val room = room ?: return null
        val limit = presetRules?.maxCompositionUnits
        return when {
            pts > room.campFreePts -> CapacityReason.ARMY
            pts > room.queueFreePts -> CapacityReason.QUEUE
            limit != null && draftUnits >= limit -> CapacityReason.SELECTION
            else -> null
        }
    }
    /** ⚡ FINISH ALL priced like the web: the shared curve over the tail row's remaining time, re-derived
     * every tick; null when the pack lacks the coefficients (the server ceiling is still sent). */
    fun liveFinishCost(nowMs: Long): BigInteger? = domain.army?.let { speedupCostKeep(catalogue, queueRemainingSec(it.queue, nowMs)) }
    /** Web `finishShortfall`: a KNOWN short KEEP balance disables the paid FINISH ALL and says why; an
     * unknown balance never blocks (the server re-prices and refuses on its own). Decimal text only. */
    fun shortfall(costKeep: String?): String? {
        val cost = costKeep?.toBigDecimalOrNull() ?: return null
        val have = home.balances?.keep?.toBigDecimalOrNull() ?: return null
        return if (have < cost) "NEED ${fmtN(cost.toPlainString())} KEEP · HAVE ${fmtN(have.setScale(0, RoundingMode.DOWN).toPlainString())}" else null
    }
    val finishShortfall: String? get() = shortfall(domain.army?.finishAllQuote?.maxCostKeep)
}

/** Army: training composer → quote (consent frozen) → confirm; saved armies; queue cancellation bursts;
 * FINISH ALL; research completion. */
class ArmyViewModel(private val army: ArmyRepository, private val base: BaseRepository, private val content: ContentRepository,
                    private val observer: ReceiptObserver, private val wallet: () -> String?, private val baseId: () -> String?,
                    private val actions: InterruptedActions?, private val versionCode: Int) : ScreenViewModel() {
    constructor(graph: AppGraph, session: SessionGraph) : this(session.army, session.base, graph.content, session.observer, { session.session.wallet },
        { graph.account.state.value.selectedBaseId }, null, graph.versionCode) { fallback = interruptedActions(session) }
    private var fallback: InterruptedActions? = null
    private val quantities = MutableStateFlow<Map<String, String>>(emptyMap())
    private val pendingCancels = MutableStateFlow<Set<String>>(emptySet())
    private val presets = MutableStateFlow<Pair<Boolean, PresetDraft?>>(false to null)
    val state: StateFlow<ArmyUiState> = combine(combine(army.state, base.state, observer.interrupted, quantities, content.state) { domain, home, interrupted, quantities, content ->
        ArmyUiState(domain, home, wallet(), baseId(), quantities, interrupted, content.catalogue, content.allowsGameOrders(versionCode))
    }, pendingCancels, presets) { ui, pending, presets -> ui.copy(pendingCancelIds = pending, presetsOpen = presets.first, presetDraft = presets.second) }
        .stateIn(viewModelScope, SharingStarted.Eagerly, ArmyUiState())
    val interrupted: InterruptedActions get() = actions ?: requireNotNull(fallback)

    // D-096 tap-tap-tap: each −1 enqueues ONE exact POST on its own serialized chain; the chips never disable.
    private val cancelQueue = ArrayDeque<TrainingCancellationChoice>()
    private var draining: Job? = null
    private var burstCount = 0; private var burstRefund = BigInteger.ZERO; private val burstTroops = linkedSetOf<String>()
    private var previousResearch: List<ResearchRow>? = null

    init {
        if (baseId() != null) refresh()
        // The quote dialog now owns the intent; do not leave a second filled batch behind after purchase.
        viewModelScope.launch { army.state.map { it.reviewed != null }.distinctUntilChanged().collect { if (it) quantities.value = emptyMap() } }
        viewModelScope.launch { army.state.mapNotNull { it.army }.collect { army ->
            // Fresh /army data retires pending ids the server no longer lists — never earlier, or the count would flash back up.
            val live = army.queue.map { it.id }.toSet()
            pendingCancels.update { pending -> pending.filterTo(mutableSetOf()) { it in live } }
            // Celebrate the completion we OBSERVE (row gone + level at target), not the timer firing (web ResearchTray).
            previousResearch?.forEach { was -> if (army.research.none { it.troop == was.troop } && (army.levels[was.troop] ?: 1) >= (was.toLevel ?: Int.MAX_VALUE)) toast("${Copy.troopName(was.troop)} L${was.toLevel} RESEARCHED") }
            previousResearch = army.research
        } }
    }
    fun refresh() = run { army.refreshArmy() }
    fun setQuantity(troop: String, value: String) {
        if (value.all { it in '0'..'9' }) quantities.update { LinkedHashMap(it).apply { if (value.isEmpty() || value == "0") remove(troop) else put(troop, value) } }
    }
    /** A tap changes only the local draft (+1 within both capacities and the selection limit, −1 to zero). */
    fun selectOne(troop: String, delta: Int = 1) {
        val current = state.value
        if (!current.composerEnabled) return
        val count = current.quantities[troop]?.toIntOrNull() ?: 0
        if (delta > 0 && (current.capacityReason(troop) != null || current.unlock(troop).locked || current.rollout(troop).locked)) return
        setQuantity(troop, (count + delta).coerceAtLeast(0).toString())
    }
    fun clearQuantities() { quantities.value = emptyMap() }
    fun quote() = orders { army.quote(requireNotNull(state.value.draft) { "Wait for your base to load" }) }
    fun dismissQuote() = army.dismissQuote()
    fun confirmTraining() = orders { army.confirmTraining() }
    fun cancelQueued(choice: TrainingCancellationChoice) = orders { army.cancelQueued(choice) }
    fun finishAll(free: Boolean, displayedCostKeep: String? = null) = orders {
        check(free) { "Review the exact training currency before paying." }
        army.finishAll(free, displayedCostKeep)
    }
    fun reviewTrainingFinish() = orders { army.reviewTrainingFinish() }
    fun reviewTrainingFinishSaved() = orders { army.reviewTrainingFinishSaved() }
    fun confirmTrainingFinish() = orders { army.confirmTrainingFinish() }
    fun dismissTrainingFinishReview() = army.dismissTrainingFinishReview()
    /** Entry and resume observe the saved command before any optional current-army read.
     * The live Army entry also reads heroes; timer/payment callers retain their existing read scope. */
    fun refreshTrainingFinish(includeHeroes: Boolean = false) = run {
        val originalWallet = requireNotNull(wallet())
        observer.refresh(originalWallet)
        if (observer.interrupted.value.any { it.kind == IntentKind.TRAINING_FINISH && it.intent.wallet == originalWallet })
            observer.check(IntentKind.TRAINING_FINISH, originalWallet)
        val selected = baseId()
        if (selected != null) {
            army.refreshArmy()
            if (includeHeroes && wallet() == originalWallet && baseId() == selected) army.refreshHeroes()
        }
    }
    fun submitResearch(target: JsonObject) = orders {
        check(target.string("action") != "finish") { "Review the exact research currency before paying." }
        army.submitResearch(target)
    }
    fun reviewResearchFinish(troop: String) = orders { army.reviewResearchFinish(troop) }
    fun reviewResearchSaved() = orders { army.reviewResearchSaved() }
    fun confirmResearchFinish() = orders { army.confirmResearchFinish() }
    fun dismissResearchReview() = army.dismissResearchReview()
    /** Foreground entry observes original payment evidence before optional current-army reads. */
    fun refreshResearch() = run {
        val originalWallet = requireNotNull(wallet())
        observer.refresh(originalWallet)
        if (observer.interrupted.value.any { it.kind == IntentKind.RESEARCH }) observer.check(IntentKind.RESEARCH, originalWallet)
        if (baseId() != null) army.refreshArmy()
    }
    fun clearNotice() { army.clearNotice(); dismissNotice() }

    /** One −1 tap: decrement the chip at once and enqueue the exact row; a tap with every refundable row
     * spoken for is a no-op, never a duplicate POST. */
    fun cancelOne(troop: String) {
        val current = state.value
        if (!current.ordersAllowed) { notify(UPDATE_LOCK, error = true); return }
        val army = current.domain.army ?: return
        if (current.trainingBlocked || current.domain.reviewed != null) return
        val target = nextTrainingCancelTarget(army.queue, troop, current.pendingCancelIds) ?: return
        val row = army.queue.firstOrNull { it.id == target.id } ?: return
        val choice = current.cancellation(row) ?: return
        pendingCancels.update { it + target.id }
        cancelQueue.addLast(choice)
        if (draining?.isActive != true) draining = viewModelScope.launch { drainCancels() }
    }
    private suspend fun drainCancels() {
        while (true) {
            val choice = cancelQueue.removeFirstOrNull() ?: break
            try {
                army.cancelQueued(choice)
                burstCount++; burstRefund += choice.refundShards.toBigInteger(); burstTroops += choice.troop
            } catch (error: SessionSupersededException) { cancelQueue.clear(); return }
            catch (error: CancellationException) { throw error }
            catch (error: Exception) {
                // A refusal rolls THIS tap back and says why; later taps still run — each is its own exact row.
                pendingCancels.update { it - choice.queueId }
                notify(error.message ?: "Connection interrupted. Please retry.", error = true)
            }
        }
        // One toast per burst: refunds summed while the chain drained ("3 BOWMAN" or, across types, "5 TROOPS").
        if (burstCount > 0) {
            val what = if (burstTroops.size == 1) Copy.troopName(burstTroops.first()) else "TROOPS"
            toast("$burstCount $what CANCELLED · +${fmtN(burstRefund.toString())} SHARDS")
        }
        burstCount = 0; burstRefund = BigInteger.ZERO; burstTroops.clear()
    }

    // --- Saved armies -------------------------------------------------------------------------------------
    fun togglePresets() {
        val open = !state.value.presetsOpen
        presets.update { it.copy(first = open) }
        if (open && state.value.domain.presets == null) run { army.refreshPresets() }
    }
    fun previewPreset(slot: Int) = orders {
        val preset = requireNotNull(state.value.domain.presets?.firstOrNull { it.slot == slot }) { "That saved army is empty" }
        army.quote(ArmyTrainingDraft.ofPlan(requireNotNull(state.value.wallet), requireNotNull(state.value.baseId) { "Wait for your base to load" }, preset.composition))
    }
    fun retrainPrevious() = orders { army.quotePrevious() }
    fun editPreset(slot: Int) {
        val existing = state.value.domain.presets?.firstOrNull { it.slot == slot }
        presets.update { it.copy(second = existing?.let { p -> PresetDraft(p.slot, p.name, p.composition, existing = true) } ?: PresetDraft(slot, "ARMY $slot", emptyList(), existing = false)) }
    }
    fun cancelEditing() { presets.update { it.copy(second = null) } }
    fun editName(name: String) = editDraft { it.copy(name = name) }
    fun editCount(index: Int, count: Int) = editDraft { d -> d.copy(composition = d.composition.mapIndexed { i, row -> if (i == index) row.copy(count = count) else row }) }
    fun moveRow(index: Int, direction: Int) = editDraft { d ->
        val rows = d.composition.toMutableList(); val destination = index + direction
        if (destination !in rows.indices || index !in rows.indices) d else { val moved = rows.removeAt(index); rows.add(destination, moved); d.copy(composition = rows) }
    }
    fun removeRow(index: Int) = editDraft { d -> d.copy(composition = d.composition.filterIndexed { i, _ -> i != index }) }
    fun addRow(troop: String) = editDraft { d -> if (d.composition.any { it.troop == troop }) d else d.copy(composition = d.composition + TroopCount(troop, 1)) }
    private fun editDraft(transform: (PresetDraft) -> PresetDraft) { presets.update { it.copy(second = it.second?.let(transform)) } }
    fun savePreset() = run {
        val draft = requireNotNull(state.value.presetDraft) { "Nothing is being edited" }
        army.savePreset(draft.slot, draft.name, draft.composition)
        presets.update { it.copy(second = null) }
    }
    /** SAVE on an empty slot of the Army sheet ("save today's army"): the same `PUT /army/presets/:slot` as [savePreset],
     * with the camp's composition the caller read from current state. A wallet plan; nothing is bought. */
    fun saveCurrentArmy(slot: Int, name: String, composition: List<TroopCount>) = run { army.savePreset(slot, name, composition) }
    fun deletePreset() = run {
        val draft = requireNotNull(state.value.presetDraft) { "Nothing is being edited" }
        army.deletePreset(draft.slot)
        presets.update { it.copy(second = null) }
    }

    private fun orders(block: suspend () -> Unit) = run {
        check(state.value.ordersAllowed) { UPDATE_LOCK }
        block()
    }
    private companion object { const val UPDATE_LOCK = "Install the available native app update before submitting game orders. Your account is preserved." }
}
