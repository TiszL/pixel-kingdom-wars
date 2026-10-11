package gg.pixelkingdomwars.nativeclient.ui.more

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import gg.pixelkingdomwars.nativeclient.AppGraph
import gg.pixelkingdomwars.nativeclient.SessionGraph
import gg.pixelkingdomwars.nativeclient.data.BaseState
import gg.pixelkingdomwars.nativeclient.model.QuestBoard
import gg.pixelkingdomwars.nativeclient.ui.chrome.Toasts
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.home.HomeRequest
import gg.pixelkingdomwars.nativeclient.ui.hud.HudIds
import gg.pixelkingdomwars.nativeclient.ui.kingdom.questLabel
import gg.pixelkingdomwars.nativeclient.ui.kit.compactAmount
import gg.pixelkingdomwars.nativeclient.ui.kit.exactAmount
import gg.pixelkingdomwars.nativeclient.ui.model.EmptyStateUi
import gg.pixelkingdomwars.nativeclient.ui.model.ResourceAccent
import gg.pixelkingdomwars.nativeclient.ui.model.ResourceChipUi
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.HubLink
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.LoadState
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.QuestsActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.QuestsSheet
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live.liveQuestsUi
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

/** The selection generation prevents an old board from reviving after A -> B -> A. */
internal data class QuestsScope(val session: Any, val baseId: String?, val generation: Long)

internal fun questsScopeCurrent(expected: QuestsScope, actual: QuestsScope?): Boolean =
    actual != null && expected.session === actual.session && expected.baseId == actual.baseId &&
        expected.generation == actual.generation

/** A retained row callback can claim only the same unique ready row the player was shown. */
internal fun currentClaimableQuest(id: String, accepted: QuestBoard?, current: QuestBoard?): Boolean {
    if (id.isBlank()) return false
    val shown = accepted?.quests.orEmpty().filter { it.questIdentity == id }.singleOrNull() ?: return false
    val now = current?.quests.orEmpty().filter { it.questIdentity == id }.singleOrNull() ?: return false
    return shown == now && shown.completed && !shown.claimed
}

/** A reopened sheet starts on the board its own last read accepted for this exact owner (owner 2026-10-06 "always
 * loading": no skeleton on every open). Display only: claims stay closed until this opening's fresh read answers, and
 * another session, kingdom or selection generation (A to B to A) never revives it. */
internal fun retainedQuestsBoard(owner: QuestsScope, last: Pair<QuestsScope, BaseState>?): BaseState? =
    last?.takeIf { questsScopeCurrent(owner, it.first) }?.second

/** Only the response to this captured read may enter this card, never an unrelated repository publication. */
internal suspend fun readCurrentQuestBoard(requireCurrent: () -> Unit, read: suspend () -> QuestBoard): QuestBoard {
    requireCurrent()
    val board = read()
    requireCurrent()
    return board
}

/** Tap admission is separate from continuation: an operation must not reject its own busy state. */
internal class QuestsActionGate(
    private val expected: QuestsScope,
    private val current: () -> QuestsScope?,
    private val busy: () -> Boolean,
    private val readError: () -> String?,
    private val explain: (String) -> Unit,
) {
    fun run(action: () -> Unit): Boolean {
        val reason = when {
            !questsScopeCurrent(expected, current()) -> "The selected kingdom changed. Open Quests again."
            busy() -> "A quest request is still finishing. Please wait."
            else -> readError()
        }
        if (reason != null) { explain(reason); return false }
        action()
        return true
    }

    fun requireCurrent() {
        if (!questsScopeCurrent(expected, current())) throw CancellationException("Quest owner changed")
    }
}

/** One designed body for the standalone route and the typed Home sheet; all claims retain their existing owner. */
@Composable fun QuestsHub(
    graph: AppGraph, session: SessionGraph, model: QuestsViewModel,
    onBack: () -> Unit, onBuild: () -> Unit, onTrain: () -> Unit, onCampaign: () -> Unit, onLand: () -> Unit,
    modifier: Modifier = Modifier.fillMaxSize(), hosted: Boolean = false,
    selectedTab: String? = null, onTab: ((String) -> Unit)? = null,
    canRead: () -> Boolean = { true }, onReport: () -> Unit = {},
    /** The raid chooser (MATCH) for the PvP daily quests; a host without one falls back to the campaign door. */
    onRaid: () -> Unit = onCampaign,
) {
    val account by graph.account.state.collectAsState()
    val owner = remember(session, account.selectedBaseId, account.baseSelectionGeneration) {
        QuestsScope(session.session, account.selectedBaseId, account.baseSelectionGeneration)
    }
    key(owner) {
        QuestsHubContent(graph, session, model, owner, onBack, onBuild, onTrain, onCampaign, onLand,
            modifier, hosted, selectedTab, onTab, canRead, onReport, onRaid)
    }
}

@Composable private fun QuestsHubContent(
    graph: AppGraph, session: SessionGraph, model: QuestsViewModel, owner: QuestsScope,
    onBack: () -> Unit, onBuild: () -> Unit, onTrain: () -> Unit, onCampaign: () -> Unit, onLand: () -> Unit,
    modifier: Modifier, hosted: Boolean, selectedTab: String?, onTab: ((String) -> Unit)?,
    canRead: () -> Boolean, onReport: () -> Unit, onRaid: () -> Unit,
) {
    val content by graph.content.state.collectAsState()
    val busy by model.busy.collectAsState()
    val latestCanRead by rememberUpdatedState(canRead)
    var tab by rememberSaveable { mutableStateOf("DAILY") }
    var refresh by remember { mutableIntStateOf(0) }
    var reading by remember { mutableStateOf(true) }
    var readError by remember { mutableStateOf<String?>(null) }
    var feedback by remember { mutableStateOf<String?>(null) }
    var accepted by remember { mutableStateOf<BaseState?>(retainedQuestsBoard(owner, model.lastAccepted)) }
    val observationScope = rememberCoroutineScope()

    fun current(): QuestsScope? {
        val now = graph.account.state.value
        if (graph.sessionGraph.value !== session || now.session !== session.session || graph.holder.current !== session.session) return null
        return QuestsScope(now.session!!, now.selectedBaseId, now.baseSelectionGeneration)
    }
    fun explain(reason: String) { feedback = reason; Toasts.post(reason) }
    fun available(): String? = when {
        !latestCanRead() -> "Quests is paused while another review or read finishes."
        readError != null -> readError
        accepted == null -> "Refresh Quests before claiming a reward."
        else -> null
    }
    val gate = QuestsActionGate(owner, ::current, { reading || model.busy.value }, ::available, ::explain)
    fun requireAdmission() {
        gate.requireCurrent()
        if (!latestCanRead()) throw CancellationException("Quest sheet owner changed or another review opened")
    }
    fun observeClaim(job: Job?) {
        if (job == null) { explain("A quest request is still finishing. Please wait."); return }
        observationScope.launch {
            job.join()
            gate.requireCurrent()
            // The following read clears controller/repository notices; retain the acknowledged outcome here.
            feedback = listOfNotNull(model.notice.value?.message, session.base.state.value.message)
                .distinct().joinToString("\n").takeIf { it.isNotBlank() } ?: feedback
            // Refresh only the view after the existing owner settles; never repeat a claim.
            refresh++
        }
    }
    fun currentControl(action: () -> Unit) {
        if (!questsScopeCurrent(owner, current())) explain("The selected kingdom changed. Open Quests again.")
        else action()
    }
    fun retry() = currentControl {
        when {
            !latestCanRead() -> explain("Quests is paused while another review or read finishes.")
            reading || model.busy.value -> explain("A quest request is still finishing. Please wait.")
            else -> refresh++
        }
    }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(owner, lifecycle, refresh) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            reading = true
            try {
                // The existing model may already be refreshing from its constructor. Do not lose this scoped read.
                model.busy.first { !it }
                gate.requireCurrent()
                if (!latestCanRead()) {
                    readError = "Quests is paused while another review or read finishes."
                } else {
                    readError = null
                    val read = model.refresh()
                    if (read == null) {
                        readError = "A quest request is still finishing. Try again."
                    } else {
                        read.join()
                        gate.requireCurrent()
                        // refreshQuests also feeds the existing controller's frozen batch IDs. Its shared state
                        // carries no origin stamp, so capture our own exact response for rendering after it.
                        val board = readCurrentQuestBoard(::requireAdmission) {
                            QuestBoard.from(session.api.get("/quests", owner.baseId?.let { mapOf("baseId" to it) }.orEmpty()))
                        }
                        val fresh = session.base.state.value.copy(quests = board)
                        accepted = fresh; model.lastAccepted = owner to fresh
                    }
                }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) {
                if (questsScopeCurrent(owner, current())) readError = "The quest board could not be refreshed. Try again."
            }
            finally { if (questsScopeCurrent(owner, current())) reading = false }
        }
    }
    val valid = questsScopeCurrent(owner, current())
    val observed = accepted.takeIf { valid }
    // /quests does not hydrate balances; the retained base snapshot may still belong to the previous selection.
    val balances = observed?.takeIf { owner.baseId != null && it.base?.baseId == owner.baseId }?.balances
    val board = observed?.quests
    val refusal = if (!valid) "The selected kingdom changed. Open Quests again." else available()
    val load = when {
        reading -> LoadState.Loading
        refusal != null -> LoadState.Error(refusal)
        else -> LoadState.Ready
    }
    // Every daily template gets the door to its place (QuestDoors.kt); the six tutorial templates keep the doors they had.
    val destinations = questDoorLinks(board) + mapOf(
        "first_camp" to HubLink(FeatureId("hud.build")),
        "first_mine" to HubLink(FeatureId("hud.build")),
        "first_barracks" to HubLink(FeatureId("hud.build")),
        "first_troops" to HubLink(FeatureId("barracks.train")),
        "first_raid" to HubLink(FeatureId("raid.campaign")),
        "first_land" to HubLink(FeatureId("profile.land")),
    )
    val labels = board?.quests.orEmpty().associate { it.templateCode to questLabel(content.catalogue, it.templateCode) }
    val mapped = liveQuestsUi(board, selectedTab ?: tab, busy || reading, claimFlowBound = true,
        labels = labels, destinations = destinations, load = load,
        claimAllBound = true, claimUnavailable = refusal,
        icons = questDoorIcons(board) + mapOf("first_camp" to "shape:hammer", "first_mine" to "shards", "first_barracks" to "shape:hammer",
            "first_troops" to "ui_portrait_highlander_t2", "first_raid" to "attack", "first_land" to "map"))
    val ui = mapped.copy(
            // quests.png DAILY BONUS n/m: dailies claimed today out of the catalogue's QUESTS.dailyBonusAt.
            bonus = questBonusUi(board, questBonusTarget(content.catalogue)),
            keepTier = null,
            readouts = buildList {
                add(ResourceChipUi(HudIds.SHARDS, "shards", compactAmount(balances?.shards), null, false, null,
                    name = "Shards", accent = ResourceAccent.SHARDS, exactDescription = "Shards ${exactAmount(balances?.shards)}"))
                if (balances?.features?.gems?.supported == true) add(ResourceChipUi(HudIds.GEMS, "gem", compactAmount(balances.gems), null, false, null,
                    name = "Gems", accent = ResourceAccent.GEMS, exactDescription = "Gems ${exactAmount(balances.gems)}"))
            },
            empty = if (board != null && load == LoadState.Ready) EmptyStateUi("quest", "No quests in this tab", "Your quest board is up to date.", null, null) else null,
            // The sheet's own re-read is not a quest request: the mapper's "Quests are refreshing" note covers it.
            notice = listOfNotNull(mapped.notice, feedback, if (busy && !reading) "A quest request is still finishing. Please wait." else null)
                .distinct().joinToString("\n").takeIf { it.isNotBlank() },
        )
    if (!hosted) BackHandlerAt(BackPriority.SCREEN) { currentControl(onBack) }
    QuestsSheet(ui, QuestsActions(
        onTab = { value -> currentControl { if (value in setOf("DAILY", "KINGDOM")) { tab = value; onTab?.invoke(value) } else explain("This Quests tab is unavailable.") } },
        onClaim = { id -> gate.run {
            if (currentClaimableQuest(id, board, session.base.state.value.quests)) observeClaim(model.claim(id, ::requireAdmission))
            else explain("This quest changed. Refresh Quests before claiming.")
        } },
        onClaimAll = { gate.run {
            val currentBoard = session.base.state.value.quests
            val ready = currentBoard?.quests.orEmpty().filter { it.completed && !it.claimed }
            val identities = currentBoard?.quests.orEmpty().mapNotNull { it.questIdentity }.groupingBy { it }.eachCount()
            if (currentBoard != board || model.state.value.first.quests != board || ready.isEmpty() ||
                ready.any { it.questIdentity.isNullOrBlank() || identities[it.questIdentity] != 1 }) {
                explain("The quest board changed. Refresh Quests before claiming all.")
            } else observeClaim(model.claimAll(::requireAdmission))
        } },
        onGo = { link -> gate.run { when (link.feature.value) {
            "hud.build" -> onBuild()
            "barracks.train" -> onTrain()
            "raid.campaign" -> onCampaign()
            "profile.land" -> onLand()
            QuestDoorIds.RAID -> onRaid()
            // The place is a building on the base: close the card and select it there (the herald's mine door does the
            // same); a base without one simply shows the base.
            QuestDoorIds.MINE, QuestDoorIds.FORGE -> {
                val type = if (link.feature.value == QuestDoorIds.MINE) "mine" else "goldforge"
                session.base.state.value.base?.buildings?.firstOrNull { it.type == type && !it.underConstruction }
                    ?.let { graph.homeRequests.request(HomeRequest.FocusBuilding(it.id)) }
                currentControl(onBack)
            }
            QuestDoorIds.HOME -> currentControl(onBack)
            else -> explain("This quest destination is unavailable. Open More destinations for other screens.")
        } } },
        onClose = { currentControl(onBack) }, onLocked = ::explain, onRetry = ::retry,
        onReport = { currentControl(onReport) },
    ), modifier)
}
