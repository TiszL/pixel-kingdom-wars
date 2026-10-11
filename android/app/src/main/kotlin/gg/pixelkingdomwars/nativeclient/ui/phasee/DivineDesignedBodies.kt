package gg.pixelkingdomwars.nativeclient.ui.phasee

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import gg.pixelkingdomwars.nativeclient.data.ContentState
import gg.pixelkingdomwars.nativeclient.divine.DivineRules
import gg.pixelkingdomwars.nativeclient.divine.drows
import gg.pixelkingdomwars.nativeclient.divine.dt
import gg.pixelkingdomwars.nativeclient.ui.chrome.Toasts
import gg.pixelkingdomwars.nativeclient.ui.chrome.blockSceneInput
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.DivineFragmentsActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.DivineFragmentsSheet
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.DivineFragmentsUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.DivineTrialsActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.DivineTrialsSheet
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.DivineTrialsUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.FinePrintSeal
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.MapColors
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.TRIALS_STANDINGS
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.live.FragmentDeliverStep
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.live.TRIAL_STANDINGS_CLOSED
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.live.TrialPlanStep
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.live.divineFragmentDeliverStep
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.live.divineFragmentSealUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.live.divineFragmentsDisplay
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.live.divineFragmentsOriginalRequired
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.live.divineFragmentsUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.live.divineRoutineUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.live.divineTrialPlanReason
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.live.divineTrialPlanStep
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.live.divineTrialPortraits
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.live.divineTrialPrizeWaiting
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.live.divineTrialsDisplay
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.live.divineTrialsOriginalRequired
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.live.divineTrialsUi
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

/*
 * The designed home bodies of DIVINE TRIALS and CRYSTAL FRAGMENTS (frames divine-trials #154, divine-fragments #155). Their
 * main actions run in place through the original owners (owner 2026-10-06): PLAN & FIGHT enters, uses a try and plans it on
 * the original DivineTrialBattle; DELIVER reviews one earning or Seeker share and confirms it on the FinePrintSeal with the
 * original dialog's wording. No new request, signature or payment code exists here. Whenever a saved request, an unclaimed
 * prize or the player's own ask (History, RETRY, a recovery row) needs the original screen, it is drawn instead and stays
 * until the player leaves.
 */

/** Entry is its own request; the next PLAN & FIGHT uses the first try. */
private const val TRIAL_ENTERED = "Entry confirmed."

/** INTO's CHANGE: the destination is the account's selected kingdom. */
private const val FRAGMENTS_CHANGE_KINGDOM = "Choose another in Your Bases."

/** SOLO TRIALS home. ENTER, USE ATTEMPT, the planner and the BEST replay run here; the original [DivineTrialScreen] keeps
 *  week discovery, history, recovery and sponsor prizes. */
@Composable internal fun DivineTrialsHome(model: DivineTrialViewModel, selectedBase: String?, allowed: Boolean, foreground: Boolean,
    content: ContentState, identity: String, onBack: () -> Unit) {
    val state by model.state.collectAsState()
    val running by model.busy.collectAsState()
    val notice by model.notice.collectAsState()
    val busy = running || state.busy
    var original by rememberSaveable { mutableStateOf(false) }
    // The planner (or the BEST replay) on the original battle surface. [battleId] pins its attempt once drawn, so a submitted
    // plan stays on its own result exactly as the original screen kept it.
    var planner by rememberSaveable(identity) { mutableStateOf(false) }
    var battleId by rememberSaveable(identity) { mutableStateOf<String?>(null) }
    val display = divineTrialsDisplay(state, divineTrialPortraits(state, content.catalogue))
    val required = divineTrialsOriginalRequired(display, original || divineTrialPrizeWaiting(state))
    SideEffect { if (required && !original) original = true }
    LaunchedEffect(foreground) { if (!foreground) { planner = false; battleId = null } }
    val saved = state.selected
    val attempts = saved?.participant?.drows("attempts").orEmpty()
    val attempt = (if (planner) battleId ?: display.planAttemptId else null)?.let { id -> attempts.singleOrNull { it.dt("id") == id } }
    // A try that was refused (or a tap the owner dropped) leaves nothing to plan: the home stays, and the notice says why.
    LaunchedEffect(planner, busy, attempt == null) { if (planner && !busy && attempt == null) { planner = false; battleId = null } }
    if (attempt != null && saved != null && foreground) {
        SideEffect { if (battleId == null) battleId = attempt.dt("id") }
        DivineTrialBattle(attempt, DivineRules.from(saved.rules), content, allowed && !running, { model.submit(attempt.dt("id"), it) },
            { planner = false; battleId = null }, state.error ?: notice?.message)
        return
    }
    if (required) {
        DivineTrialScreen(model, selectedBase, allowed, foreground, content, identity) { original = false; onBack() }
        return
    }
    // The original screen showed the owner's notices inline; here they ride the app-wide toasts, once each.
    LaunchedEffect(notice) { notice?.let { Toasts.post(it.message, it.error); model.dismissNotice() } }
    val loading = state.journal == null || busy
    var last by remember(model) { mutableStateOf<DivineTrialsUi?>(null) }
    val fresh = divineTrialsUi(display, loading)
    SideEffect { if (!loading) last = fresh }
    // A running request shows on the primary (stone dots) instead of a tap the owner would silently drop.
    val shown = divineRoutineUi(last, fresh, loading).let { if (busy) it.copy(primary = it.primary.copy(state = CommandState.BUSY)) else it }
    val scope = rememberCoroutineScope()
    val open = { original = true }
    val plan: () -> Unit = {
        when (divineTrialPlanStep(model.state.value, selectedBase, allowed)) {
            // No trial or participation here: discovery and the participation refresh live in the original screen.
            TrialPlanStep.DISCOVER -> { original = true }
            TrialPlanStep.ENTER -> {
                selectedBase?.let { base ->
                    model.enter(base)?.let { job ->
                        scope.launch { job.join(); if (divineTrialPlanStep(model.state.value, selectedBase, allowed) == TrialPlanStep.ADMIT) Toasts.post(TRIAL_ENTERED) }
                    }
                }
            }
            // Use the next try; the planner opens on it once the owner has admitted it.
            TrialPlanStep.ADMIT -> { selectedBase?.let { model.admit(it) }; planner = true }
            TrialPlanStep.PLAN -> { planner = true }
            TrialPlanStep.EXPLAIN -> { Toasts.post(divineTrialPlanReason(model.state.value, selectedBase, allowed)) }
        }
    }
    // BEST replays the confirmed attempt on the same battle surface the original's WATCH RESULT used.
    val watchBest: () -> Unit = { display.replayAttemptId?.let { battleId = it; planner = true } ?: open() }
    BackHandlerAt(BackPriority.SCREEN) { onBack() }
    DesignedStage {
        DivineTrialsSheet(shown, DivineTrialsActions(
            onTab = { if (it == TRIALS_STANDINGS) Toasts.post(TRIAL_STANDINGS_CLOSED) },
            onPlan = plan, onWatchBest = watchBest, onHistory = open, onRecover = { open() }, onClose = onBack,
            // The trial model's only re-read is the original's recovery check, so RETRY opens the original screen.
            onRetry = open, onReport = open, onExplain = { Toasts.post(it) }, onRow = { open() },
        ), Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing))
    }
}

/** CRYSTAL FRAGMENTS home. DELIVER reviews and confirms one earning or Seeker share here; the original
 *  [DivineFragmentScreen] keeps saved-outcome checks, recovery and history. [kingdomName] is drawn only when the host knows
 *  it (the account's base directory carries no name today). */
@Composable internal fun DivineFragmentsHome(model: DivineFragmentViewModel, selectedBase: String?, allowed: Boolean, onBack: () -> Unit,
    kingdomName: String? = null) {
    val state by model.state.collectAsState()
    val running by model.busy.collectAsState()
    val notice by model.notice.collectAsState()
    val busy = running || state.busy
    var original by rememberSaveable { mutableStateOf(false) }
    val review = state.review
    val reviewed = review?.let { r -> state.journal?.commands?.singleOrNull { it.key == r.key } }
    // The request under the Seal is saved by its owner before it is shown, but it is this sheet's own review, not a forgotten
    // one: it stays here until its own action settles and the journal is re-read. Left unresolved after that (sent with no
    // outcome, or a draft the Seal could not close), it is a saved request and the original screen checks it.
    var sealKey by remember(model) { mutableStateOf<String?>(null) }
    SideEffect { if (reviewed != null) sealKey = reviewed.key }
    val shielded = review?.key ?: sealKey.takeIf { busy }
    val full = divineFragmentsDisplay(state, selectedBase, state.available)
    val display = if (shielded != null && full.recovery.all { it.key == shielded }) full.copy(recovery = emptyList()) else full
    val required = divineFragmentsOriginalRequired(display, original)
    SideEffect { if (required && !original) original = true }
    if (required) {
        DivineFragmentScreen(model, selectedBase, allowed) { original = false; onBack() }
        return
    }
    // The same first pages the original's REFRESH buttons read; a read that fails or is dropped leaves UNKNOWN, never "nothing".
    // A Seal's BACK clears the owner's stock view; this re-reads it while the last count stays drawn.
    val unread = state.available && (state.awards == null || state.claims == null || (selectedBase != null && state.stock == null))
    LaunchedEffect(model, allowed && unread, selectedBase) { if (allowed && unread) readFragmentHome(model, selectedBase) }
    // The original screen showed these inline; here they ride the app-wide toasts, once each.
    LaunchedEffect(notice) { notice?.let { Toasts.post(it.message, it.error); model.dismissNotice() } }
    // The owner keeps its last confirmation until the next request; one already there when the sheet opened is not news.
    var ownerNoticeSeen by remember(model) { mutableStateOf(state.notice) }
    LaunchedEffect(state.notice) { val n = state.notice; if (n != null && n != ownerNoticeSeen) Toasts.post(n); ownerNoticeSeen = n }
    val pagesUnread = !display.featureOff && (state.awards == null || state.claims == null)
    val loading = state.journal == null || busy || pagesUnread
    var last by remember(model) { mutableStateOf<DivineFragmentsUi?>(null) }
    val fresh = divineFragmentsUi(display, kingdomName ?: UNKNOWN, loading, state.available, selectedBase)
    SideEffect { if (!loading) last = fresh }
    // A running request shows on DELIVER (stone dots) instead of a tap the owner would silently drop.
    val shown = divineRoutineUi(last, fresh, loading).let { if (busy) it.copy(primary = it.primary.copy(state = CommandState.BUSY)) else it }
    val scope = rememberCoroutineScope()
    // BACK closes the Seal; [closing] keeps it down while its unsent draft is closed.
    var closing by remember(model) { mutableStateOf(false) }
    LaunchedEffect(review, busy) { if (review == null || !busy) closing = false }
    val canConfirm = reviewed?.let { fragmentCanReview(it, selectedBase, allowed, busy) } == true
    // The primary arms over 450 ms from the moment it can be confirmed, never from an earlier, unconfirmable draw.
    val armedAt = remember(review?.key, canConfirm) { System.currentTimeMillis() }
    // The name is the selected kingdom's: a review saved for another kingdom shows its own saved id, never this name.
    val seal = reviewed?.takeIf { !closing }?.let { c -> divineFragmentSealUi(c, kingdomName.takeIf { c.base == selectedBase }, armedAt, busy, canConfirm) }
    val sealBack: () -> Unit = back@{
        val r = model.state.value.review ?: return@back
        val c = model.state.value.journal?.commands?.singleOrNull { it.key == r.key }
        if (model.busy.value || model.state.value.busy || c == null || c.sent) {
            // The original dialog's dismiss: the owner's view fence keeps a sent request saved for its outcome check.
            model.dismiss()
        } else {
            // Never sent: close the draft through the owner, as the original screen's CLOSE UNSENT DRAFT does. If the owner
            // cannot close it now, the review is dismissed and the saved draft waits in the original screen.
            closing = true
            val job = model.abandon(r.key)
            scope.launch { job?.join(); if (model.state.value.review === r) model.dismiss() }
        }
    }
    val deliver: () -> Unit = {
        when (val step = divineFragmentDeliverStep(model.state.value, selectedBase, allowed)) {
            is FragmentDeliverStep.Deliver -> model.delivery(step.eventId)
            is FragmentDeliverStep.Claim -> model.claim(step.row)
            is FragmentDeliverStep.Explain -> Toasts.post(step.reason)
        }
    }
    val open = { original = true }
    BackHandlerAt(BackPriority.SCREEN) { onBack() }
    // Back cancels a Seal, never confirms it.
    BackHandlerAt(BackPriority.CONFIRM, seal != null) { sealBack() }
    DesignedStage {
        DivineFragmentsSheet(shown, DivineFragmentsActions(
            onDeliver = deliver, onChangeKingdom = { Toasts.post(FRAGMENTS_CHANGE_KINGDOM) }, onGo = { open() }, onHistory = open,
            onRecover = { open() }, onClose = onBack, onRetry = { model.foreground() }, onReport = open, onExplain = { Toasts.post(it) },
        ), Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing))
        FinePrintSeal(seal, onConfirm = { model.state.value.review?.let { model.confirm(it) } }, onBack = sealBack)
    }
}

/** One read at a time: the model drops an action while another runs, so each waits for the last to settle. */
private suspend fun readFragmentHome(model: DivineFragmentViewModel, selectedBase: String?) {
    model.busy.first { !it }
    if (model.state.value.awards == null) model.discover("awards")?.join()
    model.busy.first { !it }
    if (model.state.value.claims == null) model.discover("claims")?.join()
    model.busy.first { !it }
    if (selectedBase != null && model.state.value.stock == null) model.stock()?.join()
}

/** The full-screen stage under a designed sheet; painted, so it shields the scene as the original page does. */
@Composable private fun DesignedStage(content: @Composable BoxScope.() -> Unit) {
    Box(Modifier.fillMaxSize().background(MapColors.stage).blockSceneInput(), content = content)
}
