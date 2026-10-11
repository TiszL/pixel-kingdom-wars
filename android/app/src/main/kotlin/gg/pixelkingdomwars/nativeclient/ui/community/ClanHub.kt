package gg.pixelkingdomwars.nativeclient.ui.community

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import gg.pixelkingdomwars.nativeclient.AppGraph
import gg.pixelkingdomwars.nativeclient.SessionGraph
import gg.pixelkingdomwars.nativeclient.data.ClansState
import gg.pixelkingdomwars.nativeclient.network.string
import gg.pixelkingdomwars.nativeclient.ops.InterruptedIntent
import gg.pixelkingdomwars.nativeclient.ops.Receipt
import gg.pixelkingdomwars.nativeclient.ui.Copy
import gg.pixelkingdomwars.nativeclient.ui.chrome.Toasts
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.*
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.*
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.flow.first

internal data class ClanHubOwner(val session: Any, val baseId: String?, val generation: Long)
internal fun clanHubOwnerCurrent(expected: ClanHubOwner, current: ClanHubOwner?): Boolean =
    current != null && expected.session === current.session && expected.baseId == current.baseId && expected.generation == current.generation

/** Entry fence only; repository admission and persisted command identity still govern each operation. */
internal class ClanHubGate(
    private val expected: ClanHubOwner,
    private val current: () -> ClanHubOwner?,
    private val busy: () -> Boolean,
    private val held: () -> String?,
    private val explain: (String) -> Unit,
) {
    fun run(action: () -> Unit): Boolean {
        val reason = when {
            !clanHubOwnerCurrent(expected, current()) -> "The account or kingdom changed. Open Clans again."
            busy() -> "A clan request is still finishing. Please wait."
            else -> held()
        }
        if (reason != null) { explain(reason); return false }
        action(); return true
    }
    fun requireCurrent() {
        if (!clanHubOwnerCurrent(expected, current())) throw CancellationException("Clan owner changed")
    }
}

/** One designed body for Home and the standalone route. Financial activity keeps its existing owners. */
@Composable fun ClanHub(
    graph: AppGraph, session: SessionGraph, model: ClansViewModel,
    onBack: () -> Unit, onChat: () -> Unit, onBuyLand: () -> Unit,
    onCharterControls: () -> Unit, onTournamentControls: () -> Unit,
    modifier: Modifier = Modifier.fillMaxSize(), hosted: Boolean = false,
    selectedTab: String? = null, onTab: ((String) -> Unit)? = null,
    canRead: () -> Boolean = { true }, onReport: () -> Unit = {},
) {
    val account by graph.account.state.collectAsState()
    val owner = remember(session, account.selectedBaseId, account.baseSelectionGeneration) {
        ClanHubOwner(session.session, account.selectedBaseId, account.baseSelectionGeneration)
    }
    key(owner) {
        ClanHubContent(graph, session, model, owner, onBack, onChat, onBuyLand, onCharterControls,
            onTournamentControls, modifier, hosted, selectedTab, onTab, canRead, onReport)
    }
}

@Composable private fun ClanHubContent(
    graph: AppGraph, session: SessionGraph, model: ClansViewModel, owner: ClanHubOwner,
    onBack: () -> Unit, onChat: () -> Unit, onBuyLand: () -> Unit,
    onCharterControls: () -> Unit, onTournamentControls: () -> Unit,
    modifier: Modifier, hosted: Boolean, selectedTab: String?, onTab: ((String) -> Unit)?,
    canRead: () -> Boolean, onReport: () -> Unit,
) {
    val state by model.state.collectAsState()
    val modelBusy by model.busy.collectAsState()
    val notice by model.notice.collectAsState()
    val account by graph.account.state.collectAsState()
    val content by graph.content.state.collectAsState()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val context = LocalContext.current
    val latestCanRead by rememberUpdatedState(canRead)
    var localTab by rememberSaveable { mutableStateOf("CLAN") }
    var query by rememberSaveable { mutableStateOf("") }
    var filter by rememberSaveable { mutableStateOf("ALL") }
    var expanded by rememberSaveable { mutableStateOf<String?>(null) }
    // CREATE / invite-code drafts: held here (inside the owner key, so an account or kingdom change starts them fresh) and
    // projected through the mapper, which applies the catalogue's charter rules.
    var createName by rememberSaveable { mutableStateOf("") }
    var createTag by rememberSaveable { mutableStateOf("") }
    var createInviteOnly by rememberSaveable { mutableStateOf(false) }
    var codeDraft by rememberSaveable { mutableStateOf("") }
    var refresh by remember { mutableIntStateOf(0) }
    var reading by remember { mutableStateOf(true) }
    var readCompleted by remember { mutableStateOf(false) }
    var feedback by remember { mutableStateOf<String?>(null) }
    var readError by remember { mutableStateOf<String?>(null) }
    var foreground by remember(lifecycle) { mutableStateOf(lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) }

    fun current(): ClanHubOwner? {
        val now = graph.account.state.value
        if (graph.sessionGraph.value !== session || now.session !== session.session || graph.holder.current !== session.session) return null
        return ClanHubOwner(session.session, now.selectedBaseId, now.baseSelectionGeneration)
    }
    fun explain(reason: String) { feedback = reason; Toasts.post(reason) }
    fun readHold(): String? = when {
        !foreground -> "Return to Clans before continuing."
        !latestCanRead() -> "Clans is waiting for the current Home view."
        else -> null
    }
    fun orderHold(): String? = readHold() ?: when {
        !readCompleted || readError != null -> "Refresh Clans before changing membership."
        !graph.content.state.value.allowsGameOrders(graph.versionCode) || !session.interlock.state.value.actionsAllowed ->
            "Game orders are paused. Saved changes remain available."
        session.battle.state.value.let { it.battleVisible || it.replay != null || it.spectator != null } ->
            "Close the battle view before changing clan membership."
        else -> null
    }
    val gate = ClanHubGate(owner, ::current, { reading || model.busy.value || model.state.value.busy }, ::orderHold, ::explain)
    fun requireReadCurrent() {
        gate.requireCurrent()
        if (readHold() != null) throw CancellationException("Clan view is no longer available")
    }
    fun requireOrderCurrent() {
        gate.requireCurrent()
        if (orderHold() != null) throw CancellationException("Clan order admission changed")
    }
    fun control(action: () -> Unit) {
        if (!clanHubOwnerCurrent(owner, current())) explain("The account or kingdom changed. Open Clans again.")
        else if (!latestCanRead()) explain("Clans is waiting for the current Home view.")
        else action()
    }
    fun accepted(job: Job?) { if (job == null) explain("A clan request is still finishing. Please wait.") }
    fun retryRead() = control {
        if (reading || model.busy.value || model.state.value.busy) explain("A clan request is still finishing. Please wait.")
        else refresh++
    }
    fun close() = control { if (model.state.value.review != null) model.dismiss() else { model.dismiss(); onBack() } }
    fun navigate(action: () -> Unit) = control { model.dismiss(); action() }
    fun selectTab(value: String) = control {
        model.dismiss()
        localTab = clanHubTab(value, model.state.value.membership?.clan != null)
        onTab?.invoke(localTab)
    }

    BackHandlerAt(BackPriority.CONFIRM, enabled = state.review != null) { model.dismiss() }
    if (!hosted) BackHandlerAt(BackPriority.SCREEN) { close() }
    DisposableEffect(owner, lifecycle, model) {
        model.dismiss()
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) foreground = true
            if (event == Lifecycle.Event.ON_PAUSE || event == Lifecycle.Event.ON_STOP) { foreground = false; model.dismiss() }
        }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer); model.dismiss() }
    }
    LaunchedEffect(owner, model, lifecycle, refresh) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            reading = true
            try {
                model.busy.first { !it }
                requireReadCurrent()
                val job = model.refresh(::requireReadCurrent)
                if (job == null) readError = "The last clan request is still finishing. Refresh to try again."
                else {
                    job.join(); requireReadCurrent()
                    readError = model.notice.value?.takeIf { it.error }?.message
                    readCompleted = readError == null
                }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { if (clanHubOwnerCurrent(owner, current())) readError = "Clans could not refresh. Saved requests are preserved." }
            finally { if (clanHubOwnerCurrent(owner, current())) reading = false }
            awaitCancellation()
        }
    }

    val clan = state.membership?.clan.takeIf { account.landOwned }
    val tab = clanHubTab(selectedTab ?: localTab, clan != null)
    val load = when { reading -> LoadState.Loading; readError != null -> LoadState.Error(readError!!); else -> LoadState.Ready }
    val shell = clanLiveUi(state, session.session.wallet, account.landOwned, account.directory?.enabled == true,
        owner.baseId, content.catalogue, tab, load)
    val status: @Composable ColumnScope.() -> Unit = {
        ClanStatus(state, reading || modelBusy, listOfNotNull(feedback, readError, notice?.message, state.notice, state.payout?.unavailable).distinct(),
            onRefresh = ::retryRead, onReport = { navigate(onReport) }, onRetry = { kind ->
                gate.run {
                    val saved = model.state.value.pending.firstOrNull { it.kind == kind }
                    if (saved == null || !InterruptedIntent(saved).retryable) explain("Check the saved clan change before retrying.")
                    else accepted(model.retry(kind, ::requireOrderCurrent))
                }
            }, onClose = { kind ->
                gate.run {
                    val now = model.state.value
                    val saved = now.pending.firstOrNull { it.kind == kind }
                    if (saved == null || saved.receipt != null || now.serverUnknownKeys[kind] != saved.idempotencyKey)
                        explain("Check the saved clan change before closing it.")
                    else accepted(model.close(kind, ::requireOrderCurrent))
                }
            })
    }
    // K-night-A11 (owner: "clan building sheet cut-offs"): the standalone route (ClansRoute: the map's Clan Hall door, the
    // menu, the Profile route) draws in an edge-to-edge window, so it keeps the safe area itself, as ProfileHub and EventHub
    // do; without it the card's header sat under the camera cut-out and its LEAVE / CHAT foot under the bottom edge. The
    // Home sheet ([hosted]) is already inside the SheetHost's safe viewport. The keyboard inset keeps the finder's fields up.
    val frame = modifier.then(if (hosted) Modifier else Modifier.background(PkwTokens.Colors.charcoal)
        .windowInsetsPadding(WindowInsets.safeDrawing).imePadding().padding(8.dp))
    if (account.landOwned && clan == null && state.membership != null) {
        val finder = clanFinderLiveUi(state, content.catalogue, tab, query, filter, codeDraft, name = createName, tag = createTag,
            inviteOnly = createInviteOnly, captain = account.identity?.name?.takeIf { it.isNotBlank() } ?: shortAddress(session.session.wallet))
        ClanFinderSheet(finder, ClanFinderActions(
            onTab = ::selectTab, onClose = ::close,
            onSearch = { value -> control { query = value } }, onFilter = { value -> control { filter = value } },
            onJoin = { explain(CLAN_JOIN_UNAVAILABLE) }, onAsk = { explain(CLAN_JOIN_UNAVAILABLE) },
            onCodeDraft = { value -> control { codeDraft = value } },
            onCode = { explain(CLAN_JOIN_UNAVAILABLE) }, onExplain = ::explain,
            onName = { value -> control { createName = value } }, onTag = { value -> control { createTag = value } },
            onInviteOnly = { value -> control { createInviteOnly = value } },
            // CREATE CLAN is a hand-off: creation (Shards, the SOL core fee and the wallet signature) stays with the existing
            // charter owner in Bases › Activities; the form's CLAN_OWNER_CONTROLS line says so above the button.
            onControls = { navigate(onCharterControls) }, onCreate = { navigate(onCharterControls) },
            onNeedMore = { navigate(onCharterControls) },
        ), frame, status = status)
    } else {
        val frozen = state.review
        val tourneyActions = ClanTourneyActions(onRankings = { navigate(onTournamentControls) }, onExplain = ::explain)
        ClanSheet(shell, ClanActions(
            onTab = ::selectTab, onClose = ::close, onConfirmBack = model::dismiss,
            onCopyCode = { control {
                val code = model.state.value.membership?.clan?.inviteCode
                if (code == null) explain("The invite code is unavailable. Refresh Clans.")
                else {
                    (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager)
                        .setPrimaryClip(ClipData.newPlainText("Clan invite code", code))
                    explain("Invite code copied")
                }
            } },
            onLeave = { gate.run {
                val now = model.state.value
                val reason = clanLeaveReason(now, session.session.wallet, account.landOwned, account.directory?.enabled == true, owner.baseId)
                if (reason != null) explain(reason)
                else now.membership?.clan?.let { accepted(model.reviewLeave(it.id, if (account.directory?.enabled == true) owner.baseId else null, ::requireOrderCurrent)) }
            } },
            onConfirm = { gate.run {
                if (frozen == null || model.state.value.review != frozen) explain("This clan review changed. Review the action again.")
                else accepted(model.confirm(frozen, ::requireOrderCurrent))
            } },
            onChat = { navigate(onChat) }, onGo = { navigate(onBuyLand) }, onRetry = ::retryRead, onReport = { navigate(onReport) },
        ), frame,
            // An if-expression hands the slot type straight to each lambda; a lambda returned through let would not be
            // inferred as a composable ColumnScope slot.
            members = if (clan == null) null else ({
                ClanMembersBody(clanMembersLiveUi(clan, session.session.wallet, content.catalogue, MemberSort.TROPHIES, expanded),
                    ClanMembersActions(onExpand = { value -> control { expanded = value } }, onExplain = ::explain,
                        onVisit = { explain("Member visits are unavailable here. Find their kingdom on the world map.") },
                        onPromote = { explain(CLAN_JOIN_UNAVAILABLE) },
                        onKick = { target -> gate.run {
                            val now = model.state.value
                            val live = now.membership?.clan
                            when {
                                !account.landOwned || !now.supported -> explain("Clan management needs land and the server update.")
                                now.blocking.isNotEmpty() -> explain("Check the saved clan change before another change.")
                                live == null || live.leaderWallet != session.session.wallet || target == session.session.wallet || live.roster.none { it.wallet == target } ->
                                    explain("That player is not a removable member of your clan.")
                                else -> accepted(model.reviewKick(live.id, target, ::requireOrderCurrent))
                            }
                        } }))
            }),
            charter = if (clan == null) null else ({
                ClanCharterBody(clanCharterSummaryUi(clan, session.session.wallet, content.catalogue),
                    ClanCharterActions(onHistory = { navigate(onCharterControls) }, onExplain = ::explain,
                        onHandOver = { explain(CLAN_OWNER_CONTROLS) }, onRegister = { navigate(onCharterControls) },
                        onInviteOnly = { explain(CLAN_OWNER_CONTROLS) }, onPending = { navigate(onCharterControls) }))
            }),
            // clan-tourney.png: RANKINGS + FIND MATCH take the wood foot on TOURNEY, so the body draws no second row.
            tourney = if (clan == null) null else ({
                ClanTourneyBody(clanTourneySummaryUi(clan, session.session.wallet), tourneyActions, withActions = false)
            }), status = status,
            tourneyFooter = if (clan == null) null else ({
                ClanTourneyFooter(clanTourneySummaryUi(clan, session.session.wallet), tourneyActions, onDark = true)
            }))
    }
}

/** Original leave/kick evidence stays reachable above every tab, including the landless and clanless states. */
@Composable private fun ClanStatus(
    state: ClansState, busy: Boolean, notices: List<String>, onRefresh: () -> Unit, onReport: () -> Unit, onRetry: (String) -> Unit,
    /** Owner 2026-10-06: the owner's CLOSE (LiveClansRepository.close), drawn only after the by-key status answered `unknown`
     *  for this saved v1 key; a legacy request never gets it (it reads Unsupported and no longer blocks a change). */
    onClose: (String) -> Unit,
) {
    Column(Modifier.fillMaxWidth().heightIn(max = if (state.pending.isNotEmpty() || state.receipt != null) 260.dp else 160.dp)
        .verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            SecondaryButton(if (busy) "READING" else "REFRESH", onRefresh, Modifier.weight(1f))
            if (notices.isNotEmpty()) SecondaryButton("REPORT", onReport, Modifier.width(108.dp))
        }
        notices.forEach { line -> PkwText(line, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch, maxLines = Int.MAX_VALUE) }
        if (!state.supported && !busy) PkwText("Clan management needs the server update. Existing standings and saved changes remain available.",
            PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2, maxLines = Int.MAX_VALUE)
        state.pending.forEach { intent ->
            SelectionContainer {
                PkwText("${if (intent.receipt != null) "Confirmed; refresh pending" else "Unconfirmed"}: ${intent.label}\n" +
                    "Original clan: ${intent.quote?.string("clanName") ?: intent.quote?.string("clanId")}\n" +
                    (intent.body.string("wallet")?.let { "Selected member: $it" } ?: "Payout destination: ${intent.baseId ?: "wallet SHARDS"}") +
                    "\nSaved request: ${intent.idempotencyKey}", PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch, maxLines = Int.MAX_VALUE)
            }
            if (InterruptedIntent(intent).retryable) SecondaryButton("RETRY ORIGINAL REQUEST", { onRetry(intent.kind) },
                Modifier.fillMaxWidth(), enabled = !busy && state.supported)
            if (intent.receipt == null && state.serverUnknownKeys[intent.kind] == intent.idempotencyKey) {
                Copy.observation(Receipt.Absent)?.let { PkwText(it, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2, maxLines = 4) }
                SecondaryButton(Copy.CLOSE_REQUEST.uppercase(), { onClose(intent.kind) }, Modifier.fillMaxWidth(), enabled = !busy,
                    contentDescription = "Close saved request")
            }
        }
        state.receipt?.let { proof -> SelectionContainer {
            PkwText("Original clan: ${proof.clanId}\nRequest: ${proof.idempotencyKey}\nRecorded: ${proof.createdAt}" +
                (proof.ledgerTransactionId?.let { "\nLedger transaction: $it" } ?: ""),
                PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch, maxLines = Int.MAX_VALUE)
        } }
    }
}
