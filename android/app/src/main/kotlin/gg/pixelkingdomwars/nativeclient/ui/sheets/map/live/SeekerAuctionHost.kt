package gg.pixelkingdomwars.nativeclient.ui.sheets.map.live

import android.os.SystemClock
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import gg.pixelkingdomwars.nativeclient.AppGraph
import gg.pixelkingdomwars.nativeclient.SessionGraph
import gg.pixelkingdomwars.nativeclient.data.SeekerAuctionKind
import gg.pixelkingdomwars.nativeclient.data.SeekerAuctionNotice
import gg.pixelkingdomwars.nativeclient.data.SeekerAuctionRepository
import gg.pixelkingdomwars.nativeclient.data.SeekerAuctionStage
import gg.pixelkingdomwars.nativeclient.data.SeekerAuctionState
import gg.pixelkingdomwars.nativeclient.data.SeekerAuctionTarget
import gg.pixelkingdomwars.nativeclient.data.seekerAuctionNoticeText
import gg.pixelkingdomwars.nativeclient.seekerauction.SeekerAuctionBidRequest
import gg.pixelkingdomwars.nativeclient.seekerauction.SeekerAuctionSourcedRoundView
import gg.pixelkingdomwars.nativeclient.seekerauction.SeekerAuctionSpot
import gg.pixelkingdomwars.nativeclient.seekerauction.SeekerAuctionWithdrawRequest
import gg.pixelkingdomwars.nativeclient.ui.chrome.Toasts
import gg.pixelkingdomwars.nativeclient.ui.kit.Celebration
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Seal
import gg.pixelkingdomwars.nativeclient.ui.model.CelebrationUi
import gg.pixelkingdomwars.nativeclient.ui.model.MoneyStage
import gg.pixelkingdomwars.nativeclient.ui.model.SealUi
import gg.pixelkingdomwars.nativeclient.ui.model.SpotSheetUi
import gg.pixelkingdomwars.nativeclient.ui.model.SpotState
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import gg.pixelkingdomwars.nativeclient.ui.phasee.RealmSalesViewLifetime
import gg.pixelkingdomwars.nativeclient.ui.phasee.realmSalesActionsAllowed
import gg.pixelkingdomwars.nativeclient.ui.phasee.realmSalesRealmNames
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.IslandKind
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.MapSearchActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.MapSearchDrawer
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.MapSearchUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.MoneyFailureUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.SearchKind
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.SearchRowUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.SearchSectionUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.SeekerPanel
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.SeekerPanelActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.SeekerSpotActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.SeekerSpotSheet
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.SeekerSpotUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.SpotFilter
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.SpotLook
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.siteArt
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.longOrNull

/*
 * The live Seeker Island auction on the World tab (plan onchain-client-reach.md §5.4 S-E; design/final/map/SPEC.md §3.1,
 * §3.4-§3.7, §2.4): the panel → the spot-number search (MapSearchDrawer, spotsOnly; ENTER ISLAND opens it until an island
 * scene exists, a logged deviation) → the spot sheet → the Seal → the money sequence (gold → Check wallet → Sending → SENT
 * only after the repository's finalized receipt and refreshed round, or RETRY) → the withdraw Seal → the won Celebration
 * once a finalized round shows the spot settled to this wallet.
 *
 * Every amount, window and wording comes from the S-D mappers (SeekerAuctionMappers.kt) and every money step from the S-C
 * repository (SeekerAuctionRepository: prepare → pin check → saved intent → the shared WalletLogin.pay rail → submit →
 * observe). This file adds no signing, payment or consent wording; the Seal text is `bidSealUi` / `withdrawSealUi` as is.
 * A new wallet step is admitted only while this view is open and in the foreground, content admits game orders, the deed
 * interlock allows actions and no battle is shown: the RealmSalesRegistration view-lifetime, content and battle guards.
 */

/** UI clock granularity for the countdowns (one redraw a second), not a game number. */
private const val CLOCK_TICK_MS = 1_000L
private const val PAUSED = "New bids are paused right now."
private const val STORAGE = "Saved bid storage is unavailable. It has been preserved; restore access before continuing."
private const val LOADING = "The auction is still loading. Try again in a moment."
private const val NEED_MORE = "SKR comes from your wallet"
private const val LATER = "Opens later on this server"
private const val WITHDRAWN = "SKR sent to your wallet."
private const val SPOT_ID = "seeker/"

/** The routine re-read cadence while the panel is open: the auction service's own chain poll (`PHASE_E_SEEKER_AUCTION_RUNTIME
 *  .crankPollMs` of the admitted catalogue), so a new leader or a settlement shows without a tap. Null (no catalogue value) =
 *  read on open, on foreground, on RETRY and on each spot only; no Kotlin copy of the number. */
internal fun seekerAuctionRefreshMs(catalogue: JsonObject?): Long? = runCatching {
    val runtime = (catalogue?.get("constants") as? JsonObject)?.get("PHASE_E_SEEKER_AUCTION_RUNTIME") as? JsonObject
    (runtime?.get("crankPollMs") as? JsonPrimitive)?.takeUnless { it.isString }?.longOrNull?.takeIf { it > 0L }
}.getOrNull()

/** The spot search's query: digits only (spot numbers; the drawer opens a numeric keyboard, but a paste may carry more). */
internal fun seekerSpotQuery(text: String): String = text.filter { it in '0'..'9' }

/** The protocol index a search row points at, or null for a row this host did not make. */
internal fun seekerSearchSpot(row: SearchRowUi): Int? =
    row.id.takeIf { row.kind == SearchKind.SPOT && it.startsWith(SPOT_ID) }?.removePrefix(SPOT_ID)?.toIntOrNull()

/** One spot as the search sees it: the round its sheet shows ([seekerSpotView]) and that round's row. */
private class SpotEntry(val index: Int, val view: SeekerAuctionSourcedRoundView, val row: SeekerAuctionSpot)

/** Won and still operating (the panel's MY SPOTS rule). */
private fun SpotEntry.mine(nowSec: Long) = row.settled && row.highBidder == view.wallet && nowSec < view.operatingEnd.toLong()
/** Holding unsettled escrow (the panel's MY BIDS rule). */
private fun SpotEntry.bidding() = row.yourBidRaw != "0" && !row.settled
private fun SpotEntry.stake() = row.yourBidRaw != "0" || row.highBidder == view.wallet

private fun spotWord(state: SpotState): String? = when (state) {
    SpotState.LIVE -> "bidding open"
    SpotState.YOU_LEAD -> "you lead"
    SpotState.OUTBID -> "you were outbid"
    SpotState.KING -> "yours"
    SpotState.CLOSED -> "closed this term"
    SpotState.NOT_OPEN -> "not open yet"
    SpotState.LICENCE_LATER -> null
}

/**
 * The search rows (SPEC §2.4, island scope): a numeric [query] matches spot numbers by prefix ("4" → 4, 40-49); [filter]
 * MINE / BIDS keeps only your operating wins / unsettled escrow (the YOU HERE cards); an empty query in ALL lists your
 * spots first, then every spot in order. Each row's art and line come from the spot sheet mapper, never a guess.
 */
internal fun seekerSpotSearchRows(query: String, filter: SpotFilter, current: SeekerAuctionSourcedRoundView,
    previous: SeekerAuctionSourcedRoundView?, nowSec: Long): List<SearchRowUi> {
    val entries = current.spots.mapNotNull { s ->
        val view = seekerSpotView(current, previous, s.spot) ?: return@mapNotNull null
        view.spots.firstOrNull { it.spot == s.spot }?.let { SpotEntry(s.spot, view, it) }
    }.filter { e ->
        (query.isEmpty() || seekerSpotNo(e.index).toString().startsWith(query)) && when (filter) {
            SpotFilter.MINE -> e.mine(nowSec)
            SpotFilter.BIDS -> e.bidding()
            else -> true
        }
    }
    val ordered = if (query.isEmpty() && filter == SpotFilter.ALL) entries.sortedBy { !it.stake() } else entries
    return ordered.map { e ->
        val ui = seekerSpotUi(e.view, e.index, nowSec)
        val no = seekerSpotNo(e.index)
        val sub = listOfNotNull("Seeker Island", "King".takeIf { e.row.spotClass == "king" }, ui?.spot?.state?.let(::spotWord))
        SearchRowUi("$SPOT_ID${e.index}", SearchKind.SPOT, siteArt(IslandKind.SEEKER, ui?.look ?: SpotLook.AVAILABLE), "Spot $no",
            sub.joinToString(" · "))
    }
}

/** The search drawer (SPEC §2.4): dots while the first read runs, the danger line + RETRY when it failed, else one section. */
internal fun seekerSpotSearchUi(query: String, filter: SpotFilter, state: SeekerAuctionState, nowSec: Long): MapSearchUi {
    val current = state.current ?: return MapSearchUi(query, busy = !state.readFailed, sections = emptyList(),
        error = if (state.readFailed) seekerAuctionNoticeText(SeekerAuctionNotice.UNAVAILABLE) else null, spotsOnly = true)
    val title = when (filter) {
        SpotFilter.MINE -> "MY SPOTS"
        SpotFilter.BIDS -> "MY BIDS"
        else -> "SPOTS"
    }
    return MapSearchUi(query, busy = false, sections = listOf(SearchSectionUi(title, seekerSpotSearchRows(query, filter, current,
        state.previous, nowSec))), spotsOnly = true)
}

private fun SeekerAuctionStage.money(): MoneyStage = when (this) {
    SeekerAuctionStage.CHECK_WALLET -> MoneyStage.CHECK_WALLET
    SeekerAuctionStage.SENDING -> MoneyStage.SENDING
    SeekerAuctionStage.SENT -> MoneyStage.SENT
    SeekerAuctionStage.FAILED -> MoneyStage.FAILED
}

/** Where one spot's BID and WITHDRAW stand, and the line under them while a sent step's outcome is still being checked. */
internal data class SeekerSpotMoney(val bid: MoneyStage, val withdraw: MoneyStage, val failure: MoneyFailureUi?)

/**
 * The money sequence of [spot] in [round]: the repository's stage when its last action is this exact (kind, round, spot);
 * else SENDING while a saved, unresolved wallet step for it exists (it reads as checking, never as a fresh BID: nothing
 * re-prompts); else READY. [SeekerSpotMoney.failure] is the non-authoritative "Checking whether ... went through." line, shown
 * once a sent step is uncertain (the repository's CHECKING notice, or a saved step from an earlier visit), never while the
 * step is still plainly in flight.
 */
internal fun seekerSpotMoney(state: SeekerAuctionState, round: String, spot: Int): SeekerSpotMoney {
    fun live(kind: SeekerAuctionKind) = state.stage?.takeIf { state.action == SeekerAuctionTarget(kind, round, spot) }
    fun saved(kind: SeekerAuctionKind) = state.pending.any { it.kind == kind && it.round == round && it.spot == spot }
    fun stage(kind: SeekerAuctionKind): MoneyStage = live(kind)?.money() ?: if (saved(kind)) MoneyStage.SENDING else MoneyStage.READY
    fun checking(kind: SeekerAuctionKind): Boolean {
        val now = live(kind)
        return if (now != null) now == SeekerAuctionStage.SENDING && state.notice == SeekerAuctionNotice.CHECKING else saved(kind)
    }
    val failure = when {
        checking(SeekerAuctionKind.BID) -> MoneyFailureUi("bid", authoritative = false)
        checking(SeekerAuctionKind.WITHDRAW) -> MoneyFailureUi("withdrawal", authoritative = false)
        else -> null
    }
    return SeekerSpotMoney(stage(SeekerAuctionKind.BID), stage(SeekerAuctionKind.WITHDRAW), failure)
}

/** A spot sheet while its round is unread (or unreadable): "…" cards and the stone CHECKING primary, never a blank. */
private fun seekerSpotChecking(spot: Int): SeekerSpotUi = SeekerSpotUi(
    SpotSheetUi(seekerSpotNo(spot), false, SpotState.NOT_OPEN, emptyList(), null, null, null, emptyList(), false),
    phase = null, look = SpotLook.AVAILABLE, loading = true)

/** The spot sheet for protocol index [spot]: the S-D mapper's sheet of the round [seekerSpotView] picks, with this host's
 *  money stages copied in ([seekerSpotMoney]). */
internal fun seekerHostSpotUi(state: SeekerAuctionState, spot: Int, nowSec: Long, draftRaw: String?,
    realmNames: Map<Long, String>): SeekerSpotUi {
    val view = seekerSpotView(state.current, state.previous, spot) ?: return seekerSpotChecking(spot)
    val ui = seekerSpotUi(view, spot, nowSec, draftRaw, realmNames) ?: return seekerSpotChecking(spot)
    val money = seekerSpotMoney(state, view.round, spot)
    return ui.copy(bidMoney = money.bid, withdraw = ui.withdraw?.let { money.withdraw }, failure = money.failure)
}

/** What a raised Seal asks the program to do. [view] is the round it was reviewed from (its decimals and source). */
internal sealed interface SeekerSealIntent {
    val view: SeekerAuctionSourcedRoundView
    data class Bid(override val view: SeekerAuctionSourcedRoundView, val draft: SeekerBidDraft) : SeekerSealIntent
    data class Withdraw(override val view: SeekerAuctionSourcedRoundView, val spot: Int) : SeekerSealIntent
}

/** The Seal of [intent] (null = none): the mappers' `bidSealUi` / `withdrawSealUi` wording, unchanged. */
internal fun seekerSealUi(intent: SeekerSealIntent?, armedAtMs: Long): SealUi? = when (intent) {
    null -> null
    is SeekerSealIntent.Bid -> seekerBidSeal(intent.view, intent.draft, armedAtMs)
    is SeekerSealIntent.Withdraw -> seekerWithdrawSeal(intent.view, intent.spot, armedAtMs)
}

/** Whether the Seal still says what would be asked now: a bid only when the latest rounds still give the very same draft
 *  (total, increment, minimum, balance); a withdrawal only while that round still holds refundable escrow there. */
internal fun seekerSealCurrent(intent: SeekerSealIntent, state: SeekerAuctionState, nowSec: Long): Boolean = when (intent) {
    is SeekerSealIntent.Bid -> seekerSpotView(state.current, state.previous, intent.draft.spot)
        ?.let { seekerBidDraft(it, intent.draft.spot, nowSec, intent.draft.newTotalRaw) } == intent.draft
    is SeekerSealIntent.Withdraw -> listOfNotNull(state.current, state.previous).firstOrNull { it.round == intent.view.round }
        ?.let { seekerWithdrawSeal(it, intent.spot, 0L) } != null
}

/** The next "SPOT n IS YOURS" not yet shown: a finalized chain round settled to this wallet ([seekerWonCelebrations]) whose
 *  term has not ended. */
internal fun seekerNextCelebration(state: SeekerAuctionState, seen: Set<String>, nowSec: Long): CelebrationUi? =
    listOfNotNull(state.previous, state.current).filter { nowSec < it.operatingEnd.toLong() }
        .flatMap(::seekerWonCelebrations).firstOrNull { it.receiptId !in seen }

/**
 * Runs the repository's reads and its one money action at a time on a scope that outlives the sheet (a bid in the wallet
 * keeps going when the sheet closes; the repository owns the evidence). Nothing here re-tries or re-prompts.
 */
internal class SeekerAuctionHostViewModel(private val repository: SeekerAuctionRepository) : ViewModel() {
    val state: StateFlow<SeekerAuctionState> = repository.state
    private val shown = MutableStateFlow<Set<String>>(emptySet())
    /** Celebrations already shown while this view model lives (each settlement once). */
    val celebrated: StateFlow<Set<String>> = shown.asStateFlow()
    private var reading: Job? = null
    private var acting: Job? = null

    /** A routine read; skipped while one runs or an action runs (the action re-reads the rounds itself). It never blanks
     *  shown data: a failed read only sets the repository's `readFailed`. */
    fun refresh() {
        if (reading?.isActive == true || acting?.isActive == true) return
        reading = viewModelScope.launch { quietly { repository.refresh() } }
    }

    /** False when a bid or withdrawal is still running: the caller says so (a tap is never silently dropped). */
    fun bid(draft: SeekerBidDraft): Boolean =
        start { repository.bid(SeekerAuctionBidRequest(draft.round, draft.spot, draft.newTotalRaw), draft.incrementRaw) }

    fun withdraw(round: String, spot: Int): Boolean = start { repository.withdraw(SeekerAuctionWithdrawRequest(round, spot)) }

    /** Clears a finished result (SENT / FAILED); an action in flight keeps its stage. */
    fun dismiss() = repository.dismiss()

    fun markCelebrated(receiptId: String) = shown.update { it + receiptId }

    private fun start(block: suspend () -> Unit): Boolean {
        if (acting?.isActive == true || repository.state.value.busy) return false
        acting = viewModelScope.launch {
            quietly(block)
            // A refused or failed step may mean the rounds moved (an outbid, a closed window): read them again.
            if (repository.state.value.stage == SeekerAuctionStage.FAILED) quietly { repository.refresh() }
        }
        return true
    }

    private suspend fun quietly(block: suspend () -> Unit) {
        try { block() }
        catch (error: CancellationException) { throw error }
        catch (_: Exception) { /* The repository keeps its own failure state; a replaced session routes away. */ }
    }
}

/**
 * The Seeker Island auction in the World tab's island sheet slot, for the repository `AppGraph.seekerAuctionClient(session,
 * wallet)` returned (non-null only on a pinned devnet test build). [modifier] goes to the half sheet (panel or spot sheet);
 * the search drawer, the Seal and the Celebration cover the screen above it. [onClose] closes the island selection.
 */
@Composable internal fun SeekerAuctionHost(graph: AppGraph, session: SessionGraph, repository: SeekerAuctionRepository,
    onClose: () -> Unit, modifier: Modifier = Modifier) {
    val model = viewModel<SeekerAuctionHostViewModel>(key = "seeker-auction-${System.identityHashCode(repository)}",
        factory = viewModelFactory { initializer { SeekerAuctionHostViewModel(repository) } })
    val state by model.state.collectAsState()
    val seen by model.celebrated.collectAsState()
    val content by graph.content.state.collectAsState(); val interlock by session.interlock.state.collectAsState()
    val battle by session.battle.state.collectAsState()
    val lifetime = remember(repository) { RealmSalesViewLifetime() }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var foreground by remember(lifecycle) { mutableStateOf(lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) }
    var searching by remember { mutableStateOf(false) }
    var filter by remember { mutableStateOf(SpotFilter.ALL) }
    var query by remember { mutableStateOf("") }
    var expanded by remember { mutableStateOf(emptySet<String>()) }
    var spot by remember { mutableStateOf<Int?>(null) }
    var draft by remember { mutableStateOf<String?>(null) }
    var seal by remember { mutableStateOf<SeekerSealIntent?>(null) }
    var armedAt by remember { mutableLongStateOf(0L) }
    var tick by remember { mutableLongStateOf(SystemClock.elapsedRealtime()) }

    // The RealmSalesRegistration view lifetime: open while composed, visible while STARTED; leaving drops the Seal.
    DisposableEffect(lifetime, lifecycle) {
        lifetime.setOpen(true)
        if (lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) lifetime.start()
        val observer = LifecycleEventObserver { _, event -> when (event) {
            Lifecycle.Event.ON_START -> { lifetime.start(); foreground = true }
            Lifecycle.Event.ON_STOP -> { lifetime.stop(); foreground = false; seal = null }
            else -> Unit
        } }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer); lifetime.dispose(); model.dismiss() }
    }
    val battleActive = battle.battleVisible || battle.replay != null || battle.spectator != null
    val orders = content.allowsGameOrders(graph.versionCode) && interlock.actionsAllowed
    LaunchedEffect(content.ready, content.manifest?.contentVersion, orders, battleActive) { lifetime.invalidate(); seal = null }
    LaunchedEffect(model, lifecycle) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            while (true) {
                model.refresh()
                delay(seekerAuctionRefreshMs(graph.content.state.value.catalogue) ?: break)
            }
        }
    }
    LaunchedEffect(Unit) { while (true) { tick = SystemClock.elapsedRealtime(); delay(CLOCK_TICK_MS) } }
    // The money sequence's toasts: RETRY carries the error toast; an uncertain step says it is being checked; SENT holds
    // for a toast's time, then the primary is ready again for a raise.
    LaunchedEffect(state.action, state.stage, state.notice) {
        val text = state.noticeText
        val stage = state.stage
        if (stage == SeekerAuctionStage.FAILED && text != null) Toasts.post(text, error = true)
        if (stage == SeekerAuctionStage.SENDING && state.notice == SeekerAuctionNotice.CHECKING && text != null) Toasts.post(text)
        if (stage == SeekerAuctionStage.SENT) {
            if (state.action?.kind == SeekerAuctionKind.WITHDRAW) Toasts.post(WITHDRAWN)
            delay(PkwTokens.Motion.TOAST_HOLD.toLong())
            model.dismiss()
        }
    }

    val nowSec = state.current?.let { seekerChainNowSec(it, tick - (state.readAtMs ?: tick)) } ?: 0L
    val realmNames = remember(content.catalogue) { realmSalesRealmNames(content.catalogue) }
    fun explain(text: String) { Toasts.post(text) }
    // Read at the tap from the owners themselves, as RealmSalesRegistration's lifecycle lambda does.
    fun refusal(): String? {
        val now = graph.content.state.value; val fight = session.battle.state.value
        val allowed = foreground && realmSalesActionsAllowed(true, lifetime.snapshot(
            now.allowsGameOrders(graph.versionCode) && session.interlock.state.value.actionsAllowed, now.ready,
            now.manifest?.contentVersion, fight.battleVisible || fight.replay != null || fight.spectator != null))
        return when {
            !allowed -> PAUSED
            model.state.value.journalUnreadable -> STORAGE
            model.state.value.busy -> SHARE_CLAIM_WORKING_LINE
            else -> null
        }
    }
    fun spotView(index: Int) = seekerSpotView(model.state.value.current, model.state.value.previous, index)
    fun openSpot(index: Int?) {
        if (index == null) { explain(LOADING); return }
        searching = false; spot = index; draft = null; model.refresh()
    }
    fun openSearch(f: SpotFilter) {
        val current = model.state.value.current
        if (f != SpotFilter.ALL && current != null &&
            seekerSpotSearchRows("", f, current, model.state.value.previous, nowSec).isEmpty()) {
            explain("No spots in ${if (f == SpotFilter.MINE) "MINE" else "BIDS"} yet"); return
        }
        filter = f; query = ""; expanded = emptySet(); searching = true; model.refresh()
    }
    fun raiseBid() {
        val index = spot ?: return
        refusal()?.let { explain(it); return }
        val view = spotView(index)
        val next = view?.let { seekerBidDraft(it, index, nowSec, draft) }
        if (view == null || next == null) { explain(seekerAuctionNoticeText(SeekerAuctionNotice.NOT_REVIEWED)); return }
        if (next.shortRaw != null) { explain(NEED_MORE); return }
        seal = SeekerSealIntent.Bid(view, next); armedAt = System.currentTimeMillis()
    }
    fun raiseWithdraw() {
        val index = spot ?: return
        refusal()?.let { explain(it); return }
        val view = spotView(index)
        if (view == null || seekerWithdrawSeal(view, index, 0L) == null) explain(seekerAuctionNoticeText(SeekerAuctionNotice.NOT_REVIEWED))
        else { seal = SeekerSealIntent.Withdraw(view, index); armedAt = System.currentTimeMillis() }
    }
    fun confirm() {
        val intent = seal ?: return
        seal = null
        refusal()?.let { explain(it); return }
        if (!seekerSealCurrent(intent, model.state.value, nowSec)) { explain(seekerAuctionNoticeText(SeekerAuctionNotice.NOT_REVIEWED)); return }
        val started = when (intent) {
            is SeekerSealIntent.Bid -> model.bid(intent.draft)
            is SeekerSealIntent.Withdraw -> model.withdraw(intent.view.round, intent.spot)
        }
        if (!started) explain(SHARE_CLAIM_WORKING_LINE)
    }

    BackHandlerAt(BackPriority.CONFIRM, seal != null) { seal = null }
    BackHandlerAt(BackPriority.SHEET, searching) { searching = false }
    BackHandlerAt(BackPriority.SHEET, spot != null && !searching) { spot = null; draft = null }

    val selected = spot
    if (selected == null) {
        SeekerPanel(seekerAuctionPanelUi(content.catalogue, state.current, state.previous, nowSec, state.readFailed), SeekerPanelActions(
            onEnter = { openSearch(SpotFilter.ALL) },
            onStat = { f -> openSearch(f) },
            onAlert = { no -> openSpot(model.state.value.current?.let { seekerSpotIndex(no, it) }) },
            onRetry = { model.refresh() },
            onClose = onClose,
            onPrimaryRefused = { explain(it.reason ?: it.caption) }), modifier)
    } else {
        SeekerSpotSheet(seekerHostSpotUi(state, selected, nowSec, draft, realmNames), SeekerSpotActions(
            onStep = { delta -> spot?.let { index -> spotView(index)?.let { seekerStepBid(it, index, draft, delta) } }?.let { draft = it } },
            onBid = { raiseBid() },
            onNeedMore = { explain(NEED_MORE) },
            onWithdraw = { raiseWithdraw() },
            onClaim = { explain(LATER) },
            onBuyPermit = { explain(LATER) },
            onHistory = { explain(LATER) },
            onExplain = { explain(it) },
            onClose = { spot = null; draft = null }), modifier)
    }
    if (searching) MapSearchDrawer(seekerSpotSearchUi(query, filter, state, nowSec), MapSearchActions(
        onQuery = { query = seekerSpotQuery(it) },
        onGo = { row -> openSpot(seekerSearchSpot(row)) },
        onMore = { id -> expanded = expanded + id },
        onRetry = { model.refresh() },
        onClose = { searching = false }),
        searchManagedExternally = true, expandedSections = expanded, emptyMessage = "No spot $query")
    Seal(seekerSealUi(seal, armedAt), onConfirm = { confirm() }, onCancel = { seal = null })
    val party = if (seal == null && !searching && state.current != null) seekerNextCelebration(state, seen, nowSec) else null
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Celebration(party, onDone = { party?.let { model.markCelebrated(it.receiptId) } })
    }
}
