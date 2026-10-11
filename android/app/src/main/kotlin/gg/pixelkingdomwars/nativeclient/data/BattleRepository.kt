package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.session.AccountSessionHolder
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.Job
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** A read-only stronghold or target preview shown by the scout screen (web `ScoutHud` over the scout scene). */
sealed interface ScoutPreview {
    val head: PresentationHead
    val title: String
    val keepLevel: Int?
    /** The preview window: the catalogue's `RAID_RULES.scoutPreviewSec` for a stage, the server's `previewSec` for a target. */
    val previewSec: Int?
}
/** `GET /campaign/:stage/preview` (web `FantasyCampaign.scout`): trophies are always zero, the window is the catalogue's. */
data class CampaignPreview(val stage: Int, override val head: PresentationHead, override val previewSec: Int? = null, val generation: Int = 0) : ScoutPreview {
    val name: String? get() = head.raw.string("name")
    override val title: String get() = "STAGE $stage · ${name.orEmpty()}"
    override val keepLevel: Int? get() = (head.raw["snapshot"] as? JsonObject)?.string("keepLevel")?.toIntOrNull()
}
/** `GET /map/scout/:target` (web map.tsx `runScout`): the server names the target, its trophies and the window. */
data class TargetScout(val wallet: String, val baseId: String?, val report: ScoutReport, val attackUnavailable: String? = null, val generation: Int = 0) : ScoutPreview {
    override val head: PresentationHead get() = report.head
    override val title: String get() = report.name
    override val keepLevel: Int get() = report.keepLevel
    override val previewSec: Int get() = report.previewSec
}

/** A create that the server refused before any march existed (web RaidUI's `!raid && err` panel). */
data class RaidCreateFailure(val status: Int, val code: String?, val message: String, val target: RaidCreateTarget) {
    /** Web `noTargetsPool` (raidNoTargets.tsx): the code is the signal, an older build's message the only fallback.
     * A deedless empty pool is never the ladder: offering the world map to a landless player is a button whose
     * only outcome is a 402. */
    val pool: String? get() = when {
        code == "no_targets_deedless" -> "deedless"
        code == "no_targets" -> "ladder"
        status != 404 -> null
        message.contains("no other settlers", ignoreCase = true) -> "deedless"
        message.contains("no eligible targets", ignoreCase = true) -> "ladder"
        else -> null
    }
    /** raids.ts createRaid 422; daily-cap and shard-ante 422s deliberately do not match. */
    val outOfEnergy: Boolean get() = status == 422 && message.contains("out of raid energy", ignoreCase = true)
    /** Web: TRY AGAIN only for a NEXT TARGET re-roll that found nobody else (`raidTarget.excludeBaseId && !noTargets && !outOfEnergy`). */
    val retryable: Boolean get() = (target as? RaidCreateTarget.Pvp)?.excludeBaseId != null && pool == null && !outOfEnergy
}

/** Web raidlog.tsx: the selected deed's permanent record, the wallet's prior participation and its unfinished marches. */
data class BattleHistoryState(
    val baseId: String? = null,
    val deed: List<BattleRecord> = emptyList(),
    val deedCursor: String? = null,
    val participant: List<BattleRecord> = emptyList(),
    val participantCursor: String? = null,
    val pending: List<PendingMarch> = emptyList(),
    val stable: Boolean = false,
    val deedSelected: Boolean = false,
    val loading: Boolean = false,
    val loadingMoreDeed: Boolean = false,
    val loadingMoreParticipant: Boolean = false,
    val error: String? = null,
)

/** Web `priorParticipantRows`: selected-deed rows already appear with deed authority; removing them from the
 * participant section prevents duplicates without hiding fights from a sold or merely different deed. */
fun priorParticipantRows(rows: List<BattleRecord>, selectedBaseId: String?): List<BattleRecord> =
    rows.filter { it.baseId != selectedBaseId }.map { it.copy(replayAccess = "participant") }

/** The defender's live view of a raid on the selected deed (web `RaidTarget.kind:'live'`). */
data class SpectatorView(val spectator: BattleSpectator, val baseId: String)

/** What entering Home found (web `raidRecoveryDestination`): nothing, one march to resume, or several for the history. */
enum class EntryRecovery { NONE, BATTLE, HISTORY }

data class BattleDomainState(
    val campaign: CampaignState? = null,
    val history: BattleHistoryState = BattleHistoryState(),
    val coordinator: BattleCoordinator? = null,
    val battleVisible: Boolean = false,
    val replay: PresentationHead? = null,
    val preview: ScoutPreview? = null,
    val spectator: SpectatorView? = null,
    /** The last create the player asked for: TRY AGAIN repeats it; NEXT RAID starts a new automatic match (web `raidTarget` / `createRequestRef`). */
    val lastTarget: RaidCreateTarget? = null,
    val createFailure: RaidCreateFailure? = null,
    /** A NEXT TARGET whose retreat is not yet confirmed keeps the button as RETRY NEXT TARGET (web `nextTargetIntentRef`). */
    val nextTargetIntent: Boolean = false,
    /** A retreat (or NEXT TARGET) request is in flight (web `retreating`): the dialogs say CONFIRMING…. */
    val retreating: Boolean = false,
    val stagingReservation: StagingReservationStatus = StagingReservationStatus.OPEN,
    val loading: Boolean = false,
    val error: String? = null,
) {
    val creating: Boolean get() = coordinator?.state?.value?.creating == true
}

interface BattleRepository {
    fun commandTiming(coordinator: BattleCoordinator): gg.pixelkingdomwars.nativeclient.diagnostics.LocalBattleReports.CommandLease? = null
    val state: StateFlow<BattleDomainState>
    suspend fun refreshCampaign()
    suspend fun refreshHistory()
    suspend fun loadOlderDeedBattles()
    suspend fun loadOlderParticipantBattles()
    /** Scout a stronghold before attacking (web `FantasyCampaign.scout`): the snapshot is read-only. */
    suspend fun previewStage(stage: Int)
    /** Scout another player's deed (web map.tsx `runScout`): everyone can scout everyone, only attacks are gated. */
    suspend fun scoutTarget(wallet: String, baseId: String?)
    suspend fun scoutTarget(wallet: String, baseId: String?, attackUnavailable: String?) = scoutTarget(wallet, baseId)
    /** Explicit attack keeps the currently shown preview and its original attacking base. */
    suspend fun attackPreview(preview: ScoutPreview) { error("Refresh this scout before attacking.") }
    fun closePreview()
    suspend fun campaignBattle(stage: Int)
    /** FIND ME A TARGET, a revenge row or a NEXT TARGET re-roll (web `raidCreateRequest` for `kind:'pvp'`). */
    suspend fun pvpBattle(target: RaidCreateTarget.Pvp)
    /** TRY AGAIN after a refused create: the same target under a fresh key. */
    suspend fun retryCreate()
    /** "Retry same request" for a saved march/order; a terminal refusal of the create becomes the refusal panel's cause. */
    suspend fun retrySavedRequest(coordinator: BattleCoordinator, id: String) = coordinator.retry(id)
    /** "Discard saved request" after the player's confirm (D153.333 d): forget an unconfirmed create on this device, then Home. */
    suspend fun discardSavedCreate(coordinator: BattleCoordinator, id: String) = coordinator.discardCreate(id)
    /** NEXT RAID / NEXT STAGE from the verdict (web `replayAgain`); false when the campaign has no next stage. */
    suspend fun raidAgain(): Boolean
    /** NEXT TARGET (web `confirmRetreat(true)`): retreat, and only after the server's settlement start the re-roll. */
    suspend fun nextTarget()
    /** RETREAT: the server settles; an unconfirmed request stays recoverable, never resent on its own. */
    suspend fun retreat()
    suspend fun recoverBattle()
    /** CONTINUE an unfinished march from the history (web `raidLogContinuationTarget`). */
    suspend fun resumePending(raidId: String)
    /** Web `raidRecoveryDestination`: an active march always wins over the base screen. */
    suspend fun recoverOnEntry(): EntryRecovery
    /** Foreground reads for the visible battle; collected while the battle screen is STARTED. */
    suspend fun foreground(coordinator: BattleCoordinator)
    fun stagingInputAllowed(coordinator: BattleCoordinator): Boolean = true
    suspend fun refreshStagingReservation(coordinator: BattleCoordinator) {}
    suspend fun foreground(spectator: BattleSpectator)
    /** Battle orders run in the account scope so leaving the screen cannot cancel a persisted send. */
    fun battleAction(action: suspend () -> Unit): Job?
    /** A deploy or hero order from a battlefield tap, in the same account scope. Its outcome shows on the field (the
     * ghost marker leaves, the card counter returns) and an unconfirmed send through the recovery pill, so it neither
     * clears nor writes the error line: a row that came and went per tap reflowed the HUD and moved the camera (owner
     * 2026-09-18). What stops every order (a retired build, a changed base) still surfaces. */
    fun deployAction(action: suspend () -> Unit): Job? = battleAction(action)
    suspend fun returnHome()
    /** Authority loss (web `recoverBaseAuthority`): leave the battle view without FINISH; the saved intent stays. */
    fun leaveBattleView()
    /** The defender's WATCH LIVE (web BaseRaidInterlockView): the canonical presentation, no orders. */
    suspend fun watchLive(raidId: String, baseId: String)
    fun closeSpectator()
    suspend fun openReplay(raidId: String)
    suspend fun openReplay(row: BattleRecord)
    fun closeReplay()
    fun clearNotice()
    /** Content may activate only with no replay, no visible battle and no pending or creating march. */
    fun activationAllowed(): Boolean
}

class LiveBattleRepository(
    private val session: AccountSession,
    private val holder: AccountSessionHolder,
    private val scope: CoroutineScope,
    private val api: ApiClient,
    private val gameApi: GameApi,
    private val battleStore: PendingBattleStore,
    private val baseId: () -> String?,
    private val simVersion: () -> Int?,
    private val ordersAllowed: () -> Boolean,
    private val hydrateHome: suspend () -> Unit,
    private val onSessionExpired: (ApiException) -> Unit,
    private val log: (String) -> Unit = {},
    /** Web `baseSelectorAvailable(directory)`: deed-scoped history exists only with base-scoped reads. */
    private val stableSelector: () -> Boolean = { false },
    /** `CAMPAIGN.tierByStage.length` from the catalogue: past the last stage NEXT STAGE opens the campaign map. */
    private val campaignStages: () -> Int? = { null },
    private val scoutPreviewSec: () -> Int? = { null },
    private val now: () -> Long = System::currentTimeMillis,
    /** The battle transports ride the session-bound [gameApi]; tests supply scripted ones through `withTransport`. */
    private val coordinatorFactory: (String, Int) -> BattleCoordinator = { base, sim -> BattleCoordinator(session.wallet, base, sim, battleStore, gameApi, session.token) },
    private val spectatorFactory: (String, Int) -> BattleSpectator = { raid, sim -> BattleSpectator(raid, sim, gameApi, session.token) },
    private val archivedSimSupported:(Int)->Boolean = {it==simVersion()},
    private val commandTiming: (BattleCoordinator) -> gg.pixelkingdomwars.nativeclient.diagnostics.LocalBattleReports.CommandLease? = { null },
) : BattleRepository {
    override fun commandTiming(coordinator: BattleCoordinator) = commandTiming.invoke(coordinator)
    private val _state = MutableStateFlow(BattleDomainState())
    override val state: StateFlow<BattleDomainState> = _state.asStateFlow()
    private var previewGeneration = 0
    private var shownPreviewGeneration = 0
    private var previewBaseId: String? = null
    /** The unconfirmed create the player explicitly left with BACK TO BASE; in-memory only, so a relaunch still reopens it. */
    private var leftCreateId: String? = null

    private fun query(base: String? = baseId()) = base?.let { mapOf("baseId" to it) }.orEmpty()
    private fun requireBase(base: String?) {
        holder.requireCurrent(session)
        check(baseId() == base) { "Your active base changed. Refresh its battle information." }
    }

    override suspend fun refreshCampaign() = guarded {
        val base = baseId()
        val campaign = CampaignState.from(api.get("/campaign", query(base)))
        requireBase(base)
        require(base == null || campaign.baseId == base) { "Campaign response belongs to another base" }
        _state.update { it.copy(campaign = campaign) }
    }

    // --- Battle history (web raidlog.tsx): three independent reads, each failure named, none hiding the others. --
    private suspend fun <T> attempt(errors: MutableList<String>, fallback: String, block: suspend () -> T): T? =
        try { block() } catch (error: CancellationException) { throw error } catch (error: Exception) { errors += error.message ?: fallback; null }

    override suspend fun refreshHistory() {
        holder.requireCurrent(session)
        val stable = stableSelector(); val base = baseId()
        _state.update { it.copy(history = it.history.copy(loading = true, error = null, stable = stable, deedSelected = !stable || base != null)) }
        val errors = mutableListOf<String>()
        try {
            val deed = if (stable && base != null) attempt(errors, "DEED HISTORY UNAVAILABLE") { BattleHistory.from(api.get("/bases/$base/battles")) } else BattleHistory()
            val participant = attempt(errors, "PARTICIPANT HISTORY UNAVAILABLE") { BattleHistory.from(api.get("/battles/participated")) }
            val pending = attempt(errors, "UNFINISHED MARCHES UNAVAILABLE") { PendingMarches.from(api.get("/raids/pending")) }
            requireBase(base)
            _state.update { it.copy(history = BattleHistoryState(
                baseId = base,
                deed = deed?.battles.orEmpty().map { row -> row.copy(replayAccess = "deed") }, deedCursor = deed?.nextCursor,
                participant = priorParticipantRows(participant?.battles.orEmpty(), base), participantCursor = participant?.nextCursor,
                pending = pending?.raids.orEmpty().filter { march -> !stable || march.attackerBaseId == base },
                stable = stable, deedSelected = !stable || base != null, error = errors.distinct().joinToString(" · ").ifEmpty { null })) }
        } finally { if (holder.isCurrent(session)) _state.update { it.copy(history = it.history.copy(loading = false)) } }
    }
    override suspend fun loadOlderDeedBattles() {
        holder.requireCurrent(session)
        val history = _state.value.history; val base = baseId()
        val cursor = history.deedCursor ?: return
        if (!history.stable || base == null || history.baseId != base || history.loadingMoreDeed) return
        _state.update { it.copy(history = it.history.copy(loadingMoreDeed = true, error = null)) }
        try {
            val page = BattleHistory.from(api.get("/bases/$base/battles", mapOf("cursor" to cursor)))
            requireBase(base)
            _state.update { it.copy(history = it.history.copy(deedCursor = page.nextCursor, deed = it.history.deed + page.battles
                .filter { row -> it.history.deed.none { seen -> seen.raidId == row.raidId } }.map { row -> row.copy(replayAccess = "deed") })) }
        } catch (error: CancellationException) { throw error }
        catch (error: Exception) { if (holder.isCurrent(session)) _state.update { it.copy(history = it.history.copy(error = error.message)) }; throw error }
        finally { if (holder.isCurrent(session)) _state.update { it.copy(history = it.history.copy(loadingMoreDeed = false)) } }
    }
    override suspend fun loadOlderParticipantBattles() {
        holder.requireCurrent(session)
        val history = _state.value.history; val base = baseId()
        val cursor = history.participantCursor ?: return
        if (!history.stable || history.baseId != base || history.loadingMoreParticipant) return
        _state.update { it.copy(history = it.history.copy(loadingMoreParticipant = true, error = null)) }
        try {
            val page = BattleHistory.from(api.get("/battles/participated", mapOf("cursor" to cursor)))
            requireBase(base)
            _state.update { it.copy(history = it.history.copy(participantCursor = page.nextCursor, participant = it.history.participant + priorParticipantRows(page.battles, base)
                .filter { row -> it.history.participant.none { seen -> seen.baseId == row.baseId && seen.raidId == row.raidId && seen.role == row.role } })) }
        } catch (error: CancellationException) { throw error }
        catch (error: Exception) { if (holder.isCurrent(session)) _state.update { it.copy(history = it.history.copy(error = error.message)) }; throw error }
        finally { if (holder.isCurrent(session)) _state.update { it.copy(history = it.history.copy(loadingMoreParticipant = false)) } }
    }

    override suspend fun previewStage(stage: Int) = guarded {
        val generation = ++previewGeneration
        require(stage >= 1) { "Unknown campaign stage" }
        val base = baseId()
        val board = _state.value.campaign?.stages?.firstOrNull { it.stage == stage }
        val head = PresentationHead.from(api.get("/campaign/$stage/preview", query(base)))
        requireBase(base)
        require(head.raw.string("stage")?.toIntOrNull() == stage) { "Campaign preview mismatch" }
        val snapshot = requireNotNull(head.raw["snapshot"] as? JsonObject) { "Campaign preview mismatch" }
        if (board?.keepLevel != null) require(snapshot.string("keepLevel")?.toIntOrNull() == board.keepLevel) { "Campaign preview mismatch" }
        head.visualContext?.let { log("preview stage $stage ${it.describe()}") }
        check(generation == previewGeneration) { "This preview was closed or replaced." }
        previewBaseId = base
        shownPreviewGeneration = generation
        _state.update { it.copy(preview = CampaignPreview(stage, PresentationHead(head.visualContext, head.simVersion, JsonObject(head.raw + ("name" to JsonPrimitive(board?.name ?: "STAGE $stage")))), scoutPreviewSec(), generation)) }
    }
    override suspend fun scoutTarget(wallet: String, baseId: String?) = scoutTarget(wallet, baseId, null)
    override suspend fun scoutTarget(wallet: String, baseId: String?, attackUnavailable: String?) = guarded {
        val generation = ++previewGeneration
        val base = this.baseId()
        require(wallet.isNotBlank())
        // The same route accepts either a deed UUID or a legacy wallet. Neither may introduce a path segment.
        require(if (baseId != null) baseId.matches(Regex("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"))
            else wallet.matches(Regex("[1-9A-HJ-NP-Za-km-z]{32,44}"))) { "Unknown raid target" }
        val report = ScoutReport.from(api.get("/map/scout/${baseId ?: wallet}", query(base)))
        requireBase(base)
        report.head.visualContext?.let { log("scout ${baseId ?: wallet} ${it.describe()}") }
        check(generation == previewGeneration) { "This scout was closed or replaced." }
        previewBaseId = base
        shownPreviewGeneration = generation
        _state.update { it.copy(preview = TargetScout(wallet, baseId, report, attackUnavailable, generation)) }
    }
    override fun closePreview() { previewGeneration++; _state.update { it.copy(preview = null) } }
    override suspend fun attackPreview(preview: ScoutPreview) {
        holder.requireCurrent(session)
        check(_state.value.preview === preview && shownPreviewGeneration == previewGeneration) { "This scout was closed or replaced. Scout the target again." }
        requireBase(previewBaseId)
        when (preview) {
            is CampaignPreview -> campaignBattle(preview.stage)
            is TargetScout -> {
                check(preview.attackUnavailable == null) { requireNotNull(preview.attackUnavailable) }
                pvpBattle(RaidCreateTarget.Pvp(preview.wallet, preview.baseId, name = preview.report.name))
            }
        }
    }

    /** One coordinator per wallet/base; a base switch rebuilds it from its own saved intent. */
    private fun restoredTarget(coordinator: BattleCoordinator): RaidCreateTarget? = coordinator.state.value.pending?.let { pending ->
        pending.stage?.let { RaidCreateTarget.Campaign(it) }
            ?: RaidCreateTarget.Pvp(pending.target?.defenderWallet, pending.target?.defenderBaseId, pending.target?.excludeBaseId, pending.target?.name)
    }
    private suspend fun prepareCoordinator(): BattleCoordinator {
        val base = requireNotNull(baseId()) { "Wait for your base to load" }
        _state.value.coordinator?.takeIf { it.wallet == session.wallet && it.baseId == base }?.let { return it }
        val sim = requireNotNull(simVersion()) { "Game content is still loading" }
        val coordinator = withContext(Dispatchers.IO) { coordinatorFactory(base, sim) }
        holder.requireCurrent(session)
        check(baseId() == base) { "Your active base changed while restoring its battle" }
        _state.update { it.copy(coordinator = coordinator, battleVisible = coordinator.state.value.pending != null,
            lastTarget = restoredTarget(coordinator), createFailure = null, nextTargetIntent = false) }
        return coordinator
    }

    override suspend fun campaignBattle(stage: Int) = create(RaidCreateTarget.Campaign(stage))
    override suspend fun pvpBattle(target: RaidCreateTarget.Pvp) = create(target)
    override suspend fun retryCreate() = create(requireNotNull(_state.value.lastTarget) { "Choose a target first" })

    private suspend fun create(target: RaidCreateTarget) = guarded {
        check(ordersAllowed()) { "Install the available native app update before submitting game orders. Your account is preserved." }
        val coordinator = prepareCoordinator()
        previewGeneration++
        _state.update { it.copy(preview = null, createFailure = null, battleVisible = true, lastTarget = target) }
        battleAction { createWith(coordinator, target) }
    }
    /** The coordinator persists the key before the POST; a refusal before any march is kept as the panel's cause. */
    private suspend fun createWith(coordinator: BattleCoordinator, target: RaidCreateTarget) {
        try { coordinator.createRaid(target) }
        catch (error: ApiException) {
            if (holder.isCurrent(session)) _state.update { it.copy(createFailure = RaidCreateFailure(error.status, error.code, error.message, target)) }
            throw error
        }
    }
    override suspend fun retrySavedRequest(coordinator: BattleCoordinator, id: String) {
        val target = _state.value.lastTarget   // restoredTarget() made it non-null for every saved create
        try { coordinator.retry(id) }
        catch (error: ApiException) {
            // Mirrors createWith: the panel renders only once the coordinator retired the key (pending == null).
            if (target != null && isTerminalRaidCreateRefusal(error) && coordinator.state.value.pending == null && holder.isCurrent(session))
                _state.update { it.copy(createFailure = RaidCreateFailure(error.status, error.code, error.message, target)) }
            throw error
        }
    }
    override suspend fun discardSavedCreate(coordinator: BattleCoordinator, id: String) = guarded { requireBase(coordinator.baseId); coordinator.discardCreate(id); returnHome() }

    override suspend fun raidAgain(): Boolean {
        holder.requireCurrent(session)
        val previous = requireNotNull(_state.value.lastTarget) { "There is no march to repeat" }
        val coordinator = _state.value.coordinator
        check(coordinator?.state?.value?.terminal == true && !coordinator.state.value.creating) { "Wait for the server's battle result before the next raid" }
        val next = when (previous) {
            is RaidCreateTarget.Campaign -> {
                val stages = campaignStages()
                if (stages != null && previous.stage + 1 > stages) { returnHome(); return false }
                RaidCreateTarget.Campaign(previous.stage + 1)
            }
            is RaidCreateTarget.Pvp -> RaidCreateTarget.Pvp()
        }
        // A deliberate new march owns a fresh create key; the settled raid is retired first, exactly like HOME.
        returnHome()
        create(next)
        return true
    }

    override suspend fun nextTarget() = guarded {
        val coordinator = requireNotNull(_state.value.coordinator) { "No march is staged" }
        val live = coordinator.state.value
        val exclude = live.pending?.pvpDefenderBaseId
        val unresolved = live.unresolvedRetreat
        check(exclude != null && (unresolved != null || live.canChooseNextTarget)) { NEXT_TARGET_UNAVAILABLE }
        _state.update { it.copy(nextTargetIntent = true) }
        battleAction {
            settleRetreat(coordinator, unresolved)
            // Only a confirmed canonical settlement may release the old reservation.
            check(coordinator.state.value.terminal) { RETREAT_NOT_CONFIRMED }
            hydrateHome(); requireBase(coordinator.baseId)
            coordinator.home()
            _state.update { it.copy(nextTargetIntent = false, createFailure = null, lastTarget = RaidCreateTarget.Pvp(excludeBaseId = exclude)) }
            createWith(coordinator, RaidCreateTarget.Pvp(excludeBaseId = exclude))
        }
    }
    override suspend fun retreat() = guarded {
        val coordinator = requireNotNull(_state.value.coordinator) { "No march is staged" }
        battleAction { settleRetreat(coordinator, coordinator.state.value.unresolvedRetreat) }
    }
    /** Web `confirmRetreat` outcomes: a refusal is the server's line, a lost answer says whether it was ever sent. */
    private suspend fun settleRetreat(coordinator: BattleCoordinator, unresolved: PendingBattleWrite?) {
        _state.update { it.copy(retreating = true) }
        try { if (unresolved != null) coordinator.retry(unresolved.id) else coordinator.retreat() }
        catch (error: CancellationException) { throw error }
        catch (error: ApiException) { if (error.status == 401) throw error; throw IllegalStateException(error.message.uppercase(), error) }
        catch (error: Exception) { throw IllegalStateException(if (coordinator.state.value.unresolvedRetreat != null) RETREAT_NOT_CONFIRMED else RETREAT_NOT_SENT, error) }
        finally { if (holder.isCurrent(session)) _state.update { it.copy(retreating = false) } }
    }
    override suspend fun recoverBattle() = guarded { prepareCoordinator(); _state.update { it.copy(battleVisible = true) } }
    override suspend fun resumePending(raidId: String) = guarded {
        require(raidId.matches(Regex("[0-9a-fA-F-]{36}")))
        val coordinator = prepareCoordinator()
        coordinator.resumeRaid(raidId)
        requireBase(coordinator.baseId)
        _state.update { it.copy(battleVisible = true, createFailure = null, lastTarget = restoredTarget(coordinator)) }
    }
    override suspend fun recoverOnEntry(): EntryRecovery {
        holder.requireCurrent(session)
        if (baseId() == null || simVersion() == null) return EntryRecovery.NONE
        val coordinator = prepareCoordinator()
        val pending = coordinator.state.value.pending
        if (pending != null) {
            // An acknowledged raid always wins (web raidRecoveryDestination). An unconfirmed create reopens on a cold start, but never
            // again after BACK TO BASE (D153.333 b): ATTACK reopens its recovery ("Recover the existing march before starting another").
            if (pending.raidId != null || pending.create?.id != leftCreateId) { _state.update { it.copy(battleVisible = true) }; return EntryRecovery.BATTLE }
            return EntryRecovery.NONE   // resumeRaid refuses while a create is saved (BattleCoordinator.kt:235): do not read /raids/pending
        }
        // Web `choosePendingRaidRecovery`: one current-SIM march resumes on its own; several go to the history.
        val marches = PendingMarches.from(api.get("/raids/pending")).raids.filter { march ->
            march.attackerBaseId == coordinator.baseId && march.simVersion == simVersion() &&
                (march.ordersDeadlineAt?.let { runCatching { java.time.Instant.parse(it).toEpochMilli() > now() }.getOrDefault(false) } ?: false)
        }
        requireBase(coordinator.baseId)
        return when (marches.size) {
            0 -> EntryRecovery.NONE
            1 -> { coordinator.resumeRaid(marches.single().id); requireBase(coordinator.baseId); _state.update { it.copy(battleVisible = true, lastTarget = restoredTarget(coordinator)) }; EntryRecovery.BATTLE }
            else -> EntryRecovery.HISTORY
        }
    }

    override fun battleAction(action: suspend () -> Unit): Job? = launchOrder(quiet = false, action)
    override fun deployAction(action: suspend () -> Unit): Job? = launchOrder(quiet = true, action)
    private fun launchOrder(quiet: Boolean, action: suspend () -> Unit): Job? {
        val coordinator = _state.value.coordinator ?: return null
        return scope.launch {
            var admitted = false
            try {
                check(ordersAllowed()) { "Install the available native update before submitting new battle orders" }
                check(baseId() == coordinator.baseId) { "Your active base changed" }
                admitted = true
                if (!quiet) _state.update { it.copy(error = null) }
                action()
            } catch (error: CancellationException) { throw error }
            catch (error: Exception) {
                if (error is ApiException && error.status == 401) onSessionExpired(error)
                // A quiet order reports only the two refusals above, which stop every order until resolved.
                if ((!quiet || !admitted) && holder.isCurrent(session)) _state.update { it.copy(error = battleFailureMessage(error)) }
            }
        }
    }

    private var stagingReservation: Pair<BattleCoordinator, Pair<String, StagingReservationCheck>>? = null
    private fun stagingCheck(coordinator: BattleCoordinator): StagingReservationCheck? {
        val raid = coordinator.state.value.pending?.raidId ?: return null
        stagingReservation?.takeIf { it.first === coordinator && it.second.first == raid }?.let { return it.second.second }
        fun current() = holder.isCurrent(session) && _state.value.coordinator === coordinator &&
            baseId() == coordinator.baseId && coordinator.state.value.pending?.raidId == raid
        return StagingReservationCheck(raid, coordinator.baseId, { coordinator.state.value }, ::current,
            { path -> api.get(path) }, { status -> _state.update { it.copy(stagingReservation = status) } }).also {
            stagingReservation = coordinator to (raid to it)
            if (current()) _state.update { state -> state.copy(stagingReservation = StagingReservationStatus.OPEN) }
        }
    }
    override fun stagingInputAllowed(coordinator: BattleCoordinator) = stagingReservation?.takeIf {
        it.first === coordinator && it.second.first == coordinator.state.value.pending?.raidId
    }?.second?.second?.allowsInput() == true
    override suspend fun refreshStagingReservation(coordinator: BattleCoordinator) { stagingCheck(coordinator)?.refreshIfDue(retry = true) }

    override suspend fun foreground(coordinator: BattleCoordinator) {
        if (_state.value.coordinator !== coordinator) return
        try { coroutineScope {
            val staging = launch {
                while (isActive && !coordinator.state.value.terminal) {
                    stagingCheck(coordinator)?.refreshIfDue()
                    delay(250)
                }
            }
            try { coordinator.runForeground() } finally { staging.cancel() }
        } }
        catch (error: CancellationException) { throw error }
        catch (error: ApiException) {
            if (error.status != 401) throw error
            onSessionExpired(error)
        }
    }
    override suspend fun foreground(spectator: BattleSpectator) {
        if (_state.value.spectator?.spectator !== spectator) return
        try { spectator.runForeground() }
        catch (error: CancellationException) { throw error }
        catch (error: ApiException) {
            if (error.status != 401) throw error
            onSessionExpired(error)
        }
    }

    /** Reads must succeed before a terminal result is retired; a failed read keeps the battle visible. */
    override suspend fun returnHome() = guarded {
        val coordinator = _state.value.coordinator
        val base = coordinator?.baseId ?: baseId()
        requireBase(base)
        check(coordinator?.state?.value?.creating != true) { "Wait for your march request to finish before leaving" }
        // A march the server never acknowledged holds no raid: a failed Home read must not trap the player on
        // "Entering battle…" (tester, 0.5.3: the server answered a transient 503 DEED_AUTHORITY_UNAVAILABLE to the
        // create AND to this read, BACK TO BASE failed the same way and every relaunch reopened the screen). The saved
        // request stays durable and recoverable; with an acknowledged raid the read stays mandatory as before.
        val unacknowledged = coordinator?.state?.value?.let { it.pending?.raidId == null && !it.terminal } == true
        try { hydrateHome() }
        catch (e: CancellationException) { throw e }
        catch (e: Exception) { if (!unacknowledged || (e is ApiException && e.status == 401)) throw e }
        requireBase(base)
        if (coordinator?.state?.value?.terminal == true) coordinator.home()
        leftCreateId = coordinator?.state?.value?.pending?.takeIf { it.raidId == null }?.create?.id
        _state.update { it.copy(battleVisible = false, createFailure = null, nextTargetIntent = false) }
    }
    override fun leaveBattleView() { _state.update { it.copy(battleVisible = false, preview = null, spectator = null, createFailure = null, nextTargetIntent = false) } }

    override suspend fun watchLive(raidId: String, baseId: String) = guarded {
        requireBase(baseId)
        val sim = requireNotNull(simVersion()) { "Game content is still loading" }
        val spectator = spectatorFactory(raidId, sim)
        holder.requireCurrent(session)
        _state.update { it.copy(spectator = SpectatorView(spectator, baseId)) }
    }
    override fun closeSpectator() { _state.update { it.copy(spectator = null) } }

    override suspend fun openReplay(raidId: String) = openReplayAt("/battles/participated/$raidId/replay", raidId)
    override suspend fun openReplay(row: BattleRecord) = openReplayAt(row.replayPath, row.raidId)
    private suspend fun openReplayAt(path: String, raidId: String) = guarded {
        require(raidId.matches(Regex("[0-9a-fA-F-]{36}")))
        val base = baseId()
        val replay = PresentationHead.from(api.get(path))
        require(replay.simVersion?.let(archivedSimSupported)==true) { "This archived simulation requires a compatible native presentation update" }
        requireBase(base)
        replay.visualContext?.let { log("replay $raidId ${it.describe()}") }
        _state.update { it.copy(replay = replay) }
    }
    override fun closeReplay() { _state.update { it.copy(replay = null) } }
    override fun clearNotice() { _state.update { it.copy(error = null) } }
    override fun activationAllowed(): Boolean {
        val value = _state.value
        val live = value.coordinator?.state?.value
        return value.replay == null && value.preview == null && value.spectator == null && !value.battleVisible && live?.pending == null && live?.creating != true
    }

    private suspend fun guarded(block: suspend () -> Unit) {
        holder.requireCurrent(session)
        _state.update { it.copy(loading = true, error = null) }
        try { block() }
        catch (error: CancellationException) { throw error }
        catch (error: Exception) {
            if (holder.isCurrent(session)) _state.update { it.copy(error = error.message ?: "Connection interrupted. Please retry.") }
            throw error
        } finally { if (holder.isCurrent(session)) _state.update { it.copy(loading = false) } }
    }

    companion object {
        // Web RaidUI.tsx copy, verbatim.
        const val NEXT_TARGET_UNAVAILABLE = "NEXT TARGET IS AVAILABLE BEFORE DEPLOYING"
        const val RETREAT_NOT_CONFIRMED = "RETREAT NOT CONFIRMED — STAY TO WATCH OR RETRY"
        const val RETREAT_NOT_SENT = "RETREAT NOT SENT — STAY TO WATCH OR RETRY"
    }
}

/** Selected-deed defender interlock host (web `useActiveBaseRaid(selectedBaseId, stableBaseMode)`): one
 * [RaidInterlock] per selected deed while Home is in the foreground; no deed or no base-scoped mutations means
 * nothing to lock. Results publish only for the session they were read for. */
class LiveDeedInterlock(
    private val session: AccountSession,
    private val holder: AccountSessionHolder,
    private val gameApi: GameApi,
    private val api: ApiClient,
    private val selection: Flow<Pair<String?, Boolean>>,
) {
    private val _state = MutableStateFlow(RaidInterlockState(null, known = true))
    val state: StateFlow<RaidInterlockState> = _state.asStateFlow()

    suspend fun foreground() = selection.distinctUntilChanged().collectLatest { (baseId, stable) ->
        if (baseId == null || !stable) { _state.value = RaidInterlockState(null, known = true); return@collectLatest }
        _state.value = RaidInterlockState()
        val poll: suspend (String) -> ActiveBaseRaid? = { id -> RaidInterlock.activeRaidOf(api.get("/bases/$id/active-raid"), id) }
        val interlock = RaidInterlock(baseId, gameApi, session.token, poll)
        coroutineScope {
            launch { interlock.state.collect { if (holder.isCurrent(session)) _state.value = it } }
            interlock.run()
        }
    }
}
