package gg.pixelkingdomwars.nativeclient.ui.community

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import gg.pixelkingdomwars.nativeclient.AppGraph
import gg.pixelkingdomwars.nativeclient.SessionGraph
import gg.pixelkingdomwars.nativeclient.data.CommunityState
import gg.pixelkingdomwars.nativeclient.model.LeaguePresentationMode
import gg.pixelkingdomwars.nativeclient.network.ApiException
import gg.pixelkingdomwars.nativeclient.ui.chrome.Toasts
import gg.pixelkingdomwars.nativeclient.ui.displayClock
import gg.pixelkingdomwars.nativeclient.ui.hud.HudIds
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.PrimaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.compactAmount
import gg.pixelkingdomwars.nativeclient.ui.kit.exactAmount
import gg.pixelkingdomwars.nativeclient.ui.model.ResourceAccent
import gg.pixelkingdomwars.nativeclient.ui.model.ResourceChipUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import gg.pixelkingdomwars.nativeclient.ui.nav.HomeCommunityReads
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.*
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live.HubLeagueScope
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.delay

/**
 * The designed, read-only Leagues card (SPEC §2.2, §3.4, §3.6; part two §A): LEAGUE, LADDER and REWARDS, the in-card
 * loading, and the error state over the kept board. The standalone route and the Home sheet ([hosted], [reads] = the
 * Home queue) share it. No claim is ever submitted here: FIND A MATCH, GET LAND and Report only navigate through
 * [onFindMatch], [onLand] and [onReport]; History and a row or item tap open the card's own facts view.
 */
@Composable internal fun LeaguesHub(
    graph: AppGraph,
    session: SessionGraph,
    onClose: () -> Unit,
    onFindMatch: () -> Unit,
    onLand: () -> Unit,
    onReport: () -> Unit,
    modifier: Modifier = Modifier.fillMaxSize(),
    selectedTab: String? = null,
    onTab: ((String) -> Unit)? = null,
    hosted: Boolean = false,
    canRead: () -> Boolean = { true },
    reads: HomeCommunityReads? = null,
    explain: (String) -> Unit = { Toasts.post(it) },
) {
    val account by graph.account.state.collectAsState()
    val owner = remember(session, account.selectedBaseId, account.baseSelectionGeneration) {
        HubLeagueScope(session.session, account.selectedBaseId, account.baseSelectionGeneration)
    }
    key(owner) {
        LeaguesHubContent(graph, session, owner, onClose, onFindMatch, onLand, onReport, modifier,
            selectedTab, onTab, hosted, canRead, reads, explain)
    }
}

@Composable private fun LeaguesHubContent(
    graph: AppGraph, session: SessionGraph, owner: HubLeagueScope,
    onClose: () -> Unit, onFindMatch: () -> Unit, onLand: () -> Unit, onReport: () -> Unit,
    modifier: Modifier, selectedTab: String?, onTab: ((String) -> Unit)?, hosted: Boolean,
    canRead: () -> Boolean, reads: HomeCommunityReads?, explain: (String) -> Unit,
) {
    val account by graph.account.state.collectAsState()
    val content by graph.content.state.collectAsState()
    val base by session.base.state.collectAsState()
    val queue = reads ?: remember(session) { HomeCommunityReads(session.community) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val latestCanRead by rememberUpdatedState(canRead)
    val latestExplain by rememberUpdatedState(explain)
    var tab by rememberSaveable { mutableStateOf(selectedTab?.takeIf { it in LEAGUE_HUB_TABS } ?: "LEAGUE") }
    var history by rememberSaveable { mutableStateOf(false) }
    var detailId by rememberSaveable { mutableStateOf<String?>(null) }
    var detailKind by rememberSaveable { mutableStateOf<String?>(null) }
    var refresh by remember { mutableIntStateOf(0) }
    var reading by remember { mutableStateOf(true) }
    var accepted by remember { mutableStateOf<CommunityState?>(null) }
    var acceptedAt by remember { mutableStateOf<String?>(null) }
    var load by remember { mutableStateOf<LoadState>(LoadState.Loading) }
    var autoRetryUsed by remember { mutableStateOf(false) }
    // The weekly season (PRIZE tab, owner 2026-10-06): its own GET, re-read every server-given interval while open.
    var season by remember { mutableStateOf<LeagueSeasonView?>(null) }
    var seasonOffset by remember { mutableLongStateOf(0L) }
    var seasonAt by remember { mutableStateOf<String?>(null) }
    var seasonLoad by remember { mutableStateOf<LoadState>(LoadState.Loading) }
    var seasonAutoRetryUsed by remember { mutableStateOf(false) }
    var seasonRefresh by remember { mutableIntStateOf(0) }
    val now = displayClock()

    fun current(): HubLeagueScope? {
        val live = graph.account.state.value
        if (graph.sessionGraph.value !== session || graph.holder.current !== session.session || live.session !== session.session) return null
        return HubLeagueScope(session.session, live.selectedBaseId, live.baseSelectionGeneration)
    }
    fun control(action: () -> Unit) = leagueHubControl(owner, ::current, latestCanRead, latestExplain, action)
    fun retry() {
        control {
            seasonRefresh++
            if (reading) latestExplain("Leagues is already refreshing.")
            else refresh++
        }
    }
    fun back() {
        when (leagueBackStep(detailId != null, history)) {
            LeagueBackStep.CLOSE_DETAIL -> { detailId = null; detailKind = null }
            LeagueBackStep.CLOSE_HISTORY -> history = false
            LeagueBackStep.CLOSE_CARD -> onClose()
        }
    }
    BackHandlerAt(if (hosted) BackPriority.SHEET else BackPriority.SCREEN,
        enabled = !hosted || leagueConsumesHostedBack(leagueBackStep(detailId != null, history)), onBack = ::back)
    LaunchedEffect(owner, lifecycle, refresh) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            reading = true
            // The kept board stays on screen while this read runs (REFRESHING, or the error row's busy RETRY), never blanked.
            load = leagueReadStarting(load)
            var failure: LeagueReadFailure? = null
            try {
                if (!latestCanRead()) {
                    failure = LeagueReadFailure.PAUSED
                } else {
                    var observed: CommunityState? = null
                    // Home Mail and Leagues retain their existing shared GET queue. No claim is submitted here.
                    val answered = readBeforeLoadingTimeout {
                        queue.read { repository ->
                            observed = readCurrentLeagues(owner, ::current) {
                                check(latestCanRead()) { "Leagues is waiting for the current action to finish." }
                                repository.refreshLeagues()
                                repository.state.value
                            }
                        }
                    }
                    if (!leagueHubScopeCurrent(owner, current())) throw CancellationException("League owner changed")
                    val board = observed
                    if (!answered) {
                        failure = LeagueReadFailure.TIMED_OUT
                    } else if (board == null) {
                        failure = LeagueReadFailure.FAILED
                    } else {
                        accepted = board
                        acceptedAt = DateTimeFormatter.ofPattern("HH:mm", Locale.getDefault()).withZone(ZoneId.systemDefault())
                            .format(Instant.ofEpochMilli(System.currentTimeMillis()))
                    }
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                failure = LeagueReadFailure.FAILED
            } finally {
                if (leagueHubScopeCurrent(owner, current())) reading = false
            }
            if (leagueHubScopeCurrent(owner, current())) {
                // Success re-arms the one automatic retry; a failure spends it, so a board that keeps failing is never looped.
                val settled = leagueReadSettled(failure, acceptedAt, autoRetryUsed)
                load = settled.load
                autoRetryUsed = settled.autoRetryUsed
                settled.retryAfterMs?.let { wait ->
                    delay(wait)
                    // A manual RETRY in the meantime restarts this effect and cancels this wait.
                    if (leagueHubScopeCurrent(owner, current()) && !reading) refresh++
                }
            }
            awaitCancellation()
        }
    }
    LaunchedEffect(owner, lifecycle, seasonRefresh) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            while (true) {
                seasonLoad = leagueReadStarting(seasonLoad)
                var failure: LeagueReadFailure? = null
                var answer: LeagueSeasonView? = null
                var sentAt = 0L
                try {
                    if (!latestCanRead()) failure = LeagueReadFailure.PAUSED
                    else {
                        sentAt = System.currentTimeMillis()
                        // GET only. Nothing here claims, signs or pays; a stopped read is safe.
                        val answered = readBeforeLoadingTimeout {
                            answer = decodeLeagueSeason(session.api.get("/leagues/season", owner.baseId?.let { mapOf("baseId" to it) }.orEmpty()))
                        }
                        if (!leagueHubScopeCurrent(owner, current())) throw CancellationException("League owner changed")
                        val board = answer
                        failure = when {
                            !answered -> LeagueReadFailure.TIMED_OUT
                            board == null -> LeagueReadFailure.FAILED
                            // A season answer about another kingdom is never shown as this one's.
                            board.standings.you?.let { it.baseId != owner.baseId } == true -> LeagueReadFailure.FAILED
                            else -> null
                        }
                    }
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (missing: ApiException) {
                    failure = if (missing.status == 404) LeagueReadFailure.NOT_SUPPLIED else LeagueReadFailure.FAILED
                } catch (_: Exception) {
                    failure = LeagueReadFailure.FAILED
                }
                if (!leagueHubScopeCurrent(owner, current())) throw CancellationException("League owner changed")
                val board = answer
                if (failure == null && board != null) {
                    val receivedAt = System.currentTimeMillis()
                    season = board
                    seasonOffset = seasonClockOffset(board.serverTime, (sentAt + receivedAt) / 2)
                    seasonAt = DateTimeFormatter.ofPattern("HH:mm", Locale.getDefault()).withZone(ZoneId.systemDefault())
                        .format(Instant.ofEpochMilli(receivedAt))
                }
                val settled = leagueReadSettled(failure, seasonAt, seasonAutoRetryUsed)
                seasonLoad = settled.load
                seasonAutoRetryUsed = settled.autoRetryUsed
                val wait = if (failure == null && board != null) board.refreshAfterSec * 1_000L else settled.retryAfterMs
                if (wait == null) awaitCancellation() else delay(wait)
            }
        }
    }
    // The week closed while the card was open: read the new season and board once.
    val seasonEnded = season?.let { runCatching { Instant.parse(it.season.closesAt).toEpochMilli() <= now + seasonOffset }.getOrNull() } == true
    LaunchedEffect(seasonEnded) {
        if (seasonEnded) { seasonRefresh++; if (!reading) refresh++ }
    }
    val liveScope = current()
    val currentOwner = leagueHubScopeCurrent(owner, liveScope)
    val visible = accepted?.takeIf { currentOwner }
    val selected = selectedTab?.takeIf { it in LEAGUE_HUB_TABS } ?: tab
    val ownBase = base.base?.takeIf { currentOwner && owner.baseId != null && it.baseId == owner.baseId }
    val mapped = leaguesHubUi(visible ?: CommunityState(), owner.takeIf { visible != null },
        liveScope ?: owner, content.catalogue, selected, now,
        if (currentOwner) load else LoadState.Error("Your kingdom changed. Reopen Leagues."),
        account.landOwned, currentOwner && latestCanRead(), fallbackTrophies = ownBase?.player?.trophies,
        season = season.takeIf { currentOwner })
    // The selected kingdom's own Home read, kept through a routine refresh (a reload must not blank the readout).
    val balances = base.balances.takeIf { ownBase != null }
    val ui = mapped.league.copy(readouts = listOf(ResourceChipUi(HudIds.SHARDS, "shards", compactAmount(balances?.shards), null,
        false, null, name = "Shards", accent = ResourceAccent.SHARDS, exactDescription = "Shards ${exactAmount(balances?.shards)}")))
    val overview = visible?.leagues?.takeUnless { it.presentationMode == LeaguePresentationMode.UNAVAILABLE }
    val facts = when (detailKind) {
        "player" -> ui.ladder?.let { board -> (board.rows + listOfNotNull(board.you)).firstOrNull { it.id == detailId } }?.let {
            listOfNotNull("Kingdom" to it.name, "Rank" to it.rankText, "Trophies" to it.trophies, it.clanTag?.let { tag -> "Clan" to tag })
        }.orEmpty()
        "item" -> (ui.rewardItems + mapped.rewards.tiers.flatMap { it.items } + ui.pastWeeks.flatMap { it.items })
            .firstOrNull { it.id == detailId }?.let {
                listOf("Item" to communityItemName(content.catalogue, it.id), "Amount" to it.count)
            }.orEmpty()
        else -> leagueHubSettlementFacts(overview?.lastSettlement, content.catalogue, overview?.presentationMode ?: LeaguePresentationMode.UNAVAILABLE)
    }
    if (history || detailId != null) {
        LeagueFactsSheet(if (detailKind == "player") "KINGDOM" else if (detailKind == "item") "REWARD ITEM" else "LEAGUE HISTORY",
            facts, ui, load, modifier, onBack = ::back, onClose = onClose,
            onRetry = ::retry, onReport = { control(onReport) }, onFindMatch = { control(onFindMatch) })
        return
    }
    val prize = leaguePrizeUi(season.takeIf { currentOwner }, now, seasonOffset,
        if (currentOwner) seasonLoad else LoadState.Error("Your kingdom changed. Reopen Leagues."),
        youName = ui.ladder?.you?.name ?: ownBase?.player?.name)
    LeaguesSheetR2(ui, mapped.rewards, LeaguesActions(
        onTab = { value -> control {
            if (value in LEAGUE_HUB_TABS) { tab = value; onTab?.invoke(value) }
            else latestExplain("This league tab is unavailable.")
        } },
        onFilter = { filter -> leagueLadderFilterRefusal(filter)?.let { latestExplain(it) } },
        onRow = { id -> control { detailKind = "player"; detailId = id } },
        onFindMatch = { control(onFindMatch) }, onRetry = ::retry, onReport = { control(onReport) }, onClose = onClose,
        // The empty ladder's GET LAND (leagueLadderEmpty) is the card's own land door; any other door says why.
        onEmptyGo = { go -> control { if (go.value == LEAGUE_LADDER_LAND_DOOR) onLand() else latestExplain("There is no destination for this league state.") } }),
        LeagueRewardsActions(onHistory = { control { history = true } }, onRetry = ::retry,
            onReport = { control(onReport) }, onItem = { id -> control { detailKind = "item"; detailId = id } },
            onGetLand = { control(onLand) }), modifier, prize = prize)
}

/** History, a ladder row and a reward item: the server's facts, read-only, inside the same card frame. */
@Composable private fun LeagueFactsSheet(title: String, facts: List<Pair<String, String>>, ui: LeaguesUi, load: LoadState,
    modifier: Modifier, onBack: () -> Unit, onClose: () -> Unit, onRetry: () -> Unit, onReport: () -> Unit, onFindMatch: () -> Unit) {
    HubCard(modifier, readouts = ui.readouts,
        header = { CompactHeader(title, "replay", onClose, onBack = onBack) },
        footer = { PrimaryButton("FIND A MATCH", onFindMatch, Modifier.weight(1f), verb = Verb.RED, icon = "attack",
            state = ui.findMatchState, reason = ui.findMatchReason) }) {
        (load as? LoadState.Error)?.let { ErrorRow(it, onRetry, onReport) }
        Column(Modifier.fillMaxWidth().weight(1f).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (facts.isEmpty()) PkwText(if (load == LoadState.Loading) "Reading league history…" else "No settled rewards or details are available.",
                PkwTokens.Type.body, color = PkwTokens.Colors.textOnParch2)
            facts.forEach { (label, value) ->
                Column(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
                    PkwText(label, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2)
                    PkwText(value, PkwTokens.Type.body, color = PkwTokens.Colors.textOnParch)
                }
            }
            PkwText("History only. League rewards are settled by the server.", PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2)
        }
    }
}
