package gg.pixelkingdomwars.nativeclient.ui.community

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import gg.pixelkingdomwars.nativeclient.AppGraph
import gg.pixelkingdomwars.nativeclient.SessionGraph
import gg.pixelkingdomwars.nativeclient.data.PlaytestBounds
import gg.pixelkingdomwars.nativeclient.data.TesterState
import gg.pixelkingdomwars.nativeclient.model.PlaytestCampaign
import gg.pixelkingdomwars.nativeclient.ui.chrome.Toasts
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.EventActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.EventRulesPanel
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.EventSheet
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.HubLink
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.LoadState
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.eventRulesUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live.EVENT_DOOR_FEATURES
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live.eventCanJoin
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live.liveEventUi
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

private val EVENT_TABS = setOf("POINTS", "RANKS", "PRIZES")

private fun eventClock(millis: Long): String =
    Instant.ofEpochMilli(millis).atOffset(ZoneOffset.UTC).format(DateTimeFormatter.ofPattern("HH:mm"))

/**
 * The designed Founding Kingdoms card for the standalone route and the typed Home sheet. Reads are the existing
 * `/playtest/campaigns/{id}/me` (polled at the catalogue's interval) and `/tester/me`; the last accepted campaign stays
 * on screen through every refresh. JOIN is the existing `playtest.participate` owner with the shown campaign as consent;
 * the header INFO opens the rules in place ([EventRulesPanel], over this card); submissions and saved-request recovery
 * stay on the campaign page ([onCampaign]).
 */
@Composable fun EventHub(
    graph: AppGraph, session: SessionGraph, onBack: () -> Unit, onFeedback: () -> Unit, onCampaign: () -> Unit,
    onDoor: (HubLink) -> Unit, modifier: Modifier = Modifier.fillMaxSize(), hosted: Boolean = false,
    selectedTab: String? = null, onTab: ((String) -> Unit)? = null, canRead: () -> Boolean = { true },
) {
    key(session) {
        EventHubContent(graph, session, onBack, onFeedback, onCampaign, onDoor, modifier, hosted, selectedTab, onTab, canRead)
    }
}

@Composable private fun EventHubContent(
    graph: AppGraph, session: SessionGraph, onBack: () -> Unit, onFeedback: () -> Unit, onCampaign: () -> Unit,
    onDoor: (HubLink) -> Unit, modifier: Modifier, hosted: Boolean, selectedTab: String?, onTab: ((String) -> Unit)?,
    canRead: () -> Boolean,
) {
    val content by graph.content.state.collectAsState()
    val bounds = remember(content.catalogue) { PlaytestBounds.from(content.catalogue) }
    val tester by session.tester.state.collectAsState()
    val playtest by session.playtest.state.collectAsState()
    val latestCanRead by rememberUpdatedState(canRead)
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val scope = rememberCoroutineScope()
    var localTab by rememberSaveable { mutableStateOf("POINTS") }
    val tab = (selectedTab ?: localTab).takeIf { it in EVENT_TABS } ?: "POINTS"
    // A reopened card starts from the repository's last Founding read, never from an empty board.
    var accepted by remember { mutableStateOf(session.playtest.state.value.campaign?.takeIf { it.kind == "founding" }) }
    var acceptedAt by remember { mutableStateOf<Long?>(null) }
    var readError by remember { mutableStateOf<String?>(null) }
    var reading by remember { mutableStateOf(false) }
    var refresh by remember { mutableIntStateOf(0) }
    var joining by remember { mutableStateOf(false) }
    var justJoined by remember { mutableStateOf(false) }
    var now by remember { mutableStateOf<Long?>(null) }
    // The rules are this card's own child panel (event.png header INFO), not a hop to the campaign page.
    var rulesOpen by rememberSaveable { mutableStateOf(false) }

    fun explain(reason: String) { Toasts.post(reason) }
    fun current(): Boolean = graph.sessionGraph.value === session && graph.holder.current === session.session
    fun act(action: () -> Unit) {
        when {
            !current() -> explain("Your account changed. Open the event again.")
            !latestCanRead() -> explain("The event is paused while another review or read finishes.")
            else -> action()
        }
    }
    suspend fun readOnce(limits: PlaytestBounds) {
        if (!current()) return
        if (!latestCanRead()) { readError = "The event is paused while another review or read finishes."; return }
        reading = true
        try {
            try {
                val id = limits.foundingId
                if (session.playtest.state.value.selectedId == id) session.playtest.refresh() else session.playtest.open(id)
                check(current()) { "Your account changed. Open the event again." }
                session.playtest.state.value.campaign?.takeIf { it.id == id }?.let { accepted = it; acceptedAt = System.currentTimeMillis() }
                readError = null
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: Exception) { if (current()) readError = failure.message ?: "The event board could not be refreshed." }
            try { session.tester.refreshProgress() }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) {
                // TODAY keeps the last progress read; say so only when there is nothing to keep.
                if (current() && session.tester.state.value.progress == null && readError == null) readError = "Today's activity could not be read."
            }
        } finally { reading = false; now = System.currentTimeMillis() }
    }
    LaunchedEffect(bounds, refresh, lifecycle) {
        val limits = bounds
        if (limits == null) { readError = "Event rules are unavailable. Update game content."; return@LaunchedEffect }
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            readOnce(limits)
            while (isActive) { delay(limits.pollMs); readOnce(limits) }
        }
    }
    // The server's own award wording ("+n tester points — …") reaches the player once, then is cleared.
    LaunchedEffect(tester.awardNotice) {
        val notice = tester.awardNotice ?: return@LaunchedEffect
        Toasts.post(notice)
        runCatching { session.tester.dismissAward() }
    }

    fun join() = act {
        val shown = accepted
        val state = session.playtest.state.value
        when {
            joining -> explain("Joining is still finishing. Please wait.")
            state.pending != null -> { explain("A saved event request needs checking first."); onCampaign() }
            shown == null -> explain("The event is still loading. Try again in a moment.")
            !state.canAct -> explain("The event is refreshing. Try again in a moment.")
            !eventCanJoin(shown, state) -> explain("Registration is not open.")
            else -> {
                joining = true
                scope.launch { joinWith(shown, session, { accepted = it; justJoined = it.participant != null }, ::explain) { joining = false } }
            }
        }
    }
    fun retry() = act {
        when {
            session.playtest.state.value.pending != null -> onCampaign()
            reading -> explain("The event is refreshing. Please wait.")
            else -> refresh++
        }
    }

    val valid = current()
    val campaign = accepted.takeIf { valid }
    val error = readError
    val load = when {
        error != null -> LoadState.Error(error, asOf = acceptedAt?.let(::eventClock))
        campaign == null -> LoadState.Loading
        else -> LoadState.Ready
    }
    val ui = liveEventUi(campaign, if (valid) tester else TesterState(), playtest, tab = tab,
        name = (campaign?.name ?: bounds?.foundingName ?: "Founding Kingdoms").uppercase(), ownWallet = session.session.wallet,
        nowMillis = now, load = load, joining = joining, justJoined = justJoined)

    val rules = eventRulesUi(campaign, bounds, playtest.pending != null)
    val rulesShown = rulesOpen && rules != null
    fun openRules() = act {
        if (rules == null) { explain("Event rules are unavailable. Update game content."); return@act }
        rulesOpen = true
    }

    BackHandlerAt(BackPriority.SHEET, enabled = rulesShown) { rulesOpen = false }
    if (!hosted) BackHandlerAt(BackPriority.SCREEN) { onBack() }
    Box(modifier.then(if (hosted) Modifier else Modifier.background(PkwTokens.Colors.charcoal)
        .windowInsetsPadding(WindowInsets.safeDrawing).padding(8.dp))) {
        EventSheet(ui, EventActions(
            onTab = { next -> if (next in EVENT_TABS) { localTab = next; onTab?.invoke(next) } else explain("This event tab is not available.") },
            onDoor = { link -> act { if (link.feature.value in EVENT_DOOR_FEATURES) onDoor(link) else explain("This activity opens from your kingdom.") } },
            onJoin = ::join,
            onRules = ::openRules,
            onClose = onBack,
            onRetry = ::retry,
            onReport = { act(onFeedback) },
        ), Modifier.fillMaxSize())
        // A saved request keeps its owner: OPEN leaves the rules for the campaign page that checks or retries it.
        if (rulesShown && rules != null) EventRulesPanel(rules, onClose = { rulesOpen = false },
            onSavedRequest = { rulesOpen = false; act(onCampaign) }, modifier = Modifier.fillMaxSize())
    }
}

/** The existing participation owner with the campaign the player saw as consent; the repository re-checks its revision. */
private suspend fun joinWith(shown: PlaytestCampaign, session: SessionGraph, accept: (PlaytestCampaign) -> Unit,
    explain: (String) -> Unit, done: () -> Unit) {
    try {
        session.playtest.participate(shown)
        session.playtest.state.value.campaign?.takeIf { it.id == shown.id }?.let(accept)
    } catch (cancelled: CancellationException) { throw cancelled }
    catch (failure: Exception) { explain(failure.message ?: "Joining did not finish. Check the saved request on the rules page.") }
    finally { done() }
}
