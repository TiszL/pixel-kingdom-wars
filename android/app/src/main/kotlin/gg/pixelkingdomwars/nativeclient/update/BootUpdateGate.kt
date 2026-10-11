package gg.pixelkingdomwars.nativeclient.update

import gg.pixelkingdomwars.nativeclient.model.NativeCapabilities
import gg.pixelkingdomwars.nativeclient.model.NativeUpdateOffer
import gg.pixelkingdomwars.nativeclient.model.decode
import gg.pixelkingdomwars.nativeclient.ui.boot.BootDestination
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.longOrNull

/** The boot check's whole budget, retry included: a launch without a usable answer waits no longer than this. */
internal const val BOOT_CHECK_BUDGET_MS = 8_000L
/** The pause before the one retry, inside [BOOT_CHECK_BUDGET_MS]. */
internal const val BOOT_CHECK_RETRY_MS = 750L

/** The fields of `GET /native/capabilities` the boot gate reads: the frozen M45 §1 `update` block, `minimumVersionCode`
 * and `simVersion`. [readable] says whether this build's full [NativeCapabilities] decode accepts the same answer; when
 * it does not, the content check can no longer run here and only a newer build reads the server again. */
data class PublicUpdateView(val update: NativeUpdateOffer?, val minimumVersionCode: Long, val simVersion: Long?, val readable: Boolean)

/** Owner 2026-09-27: "I deploy a next huge update and this version won't be able to launch the game and also won't be
 * able to update." The offer must never depend on anything else in the response decoding: every sibling field may be
 * added, removed or reshaped by a later server. A malformed `update` is no offer; a malformed floor is no floor. */
fun publicUpdateView(raw: JsonObject): PublicUpdateView = PublicUpdateView(
    update = (raw["update"] as? JsonObject)?.let { runCatching { it.decode<NativeUpdateOffer>() }.getOrNull() },
    minimumVersionCode = (raw["minimumVersionCode"] as? JsonPrimitive)?.longOrNull?.coerceAtLeast(0) ?: 0,
    simVersion = (raw["simVersion"] as? JsonPrimitive)?.longOrNull,
    readable = runCatching { NativeCapabilities.from(raw) }.isSuccess,
)

/** The launch check's progress: [Pending] holds the boot screen; [Done] carries the answer, or null when none came in time. */
sealed interface BootCheck {
    data object Pending : BootCheck
    data class Done(val view: PublicUpdateView?) : BootCheck
}

/** What the boot screen does about the app update before the game opens. */
enum class BootUpdate { CHECKING, NONE, OPTIONAL, REQUIRED }

/** True when this build can no longer run against the server that answered: its content did not open, the server retired
 * it (`minimumVersionCode`), the server fights on a SIM this build does not carry, or this build cannot read the answer. */
fun bootIncompatible(check: BootCheck, versionCode: Long, contentFailed: Boolean, loadedSimVersion: Int?): Boolean {
    if (contentFailed) return true
    val view = (check as? BootCheck.Done)?.view ?: return false
    return view.minimumVersionCode > versionCode || !view.readable ||
        (loadedSimVersion != null && view.simVersion != null && view.simVersion != loadedSimVersion.toLong())
}

/** The boot decision (owner 2026-09-27), pure so PkwApp computes it from the same frame as the route:
 * - after the launch has left the boot screen ([released]) nothing here applies; later offers use the Title/Home chrome;
 * - until the bounded check concludes the boot screen waits;
 * - without an eligible offer the launch goes on exactly as before this gate existed;
 * - a mandatory offer, or a build that can no longer run ([incompatible]), is REQUIRED: no way into the game;
 * - any other offer is OPTIONAL until the player picks LATER (or declined it earlier in this process). */
fun bootUpdateDecision(check: BootCheck, state: UpdateState, mandatory: Boolean, incompatible: Boolean, later: Boolean, released: Boolean): BootUpdate = when {
    released -> BootUpdate.NONE
    check is BootCheck.Pending -> BootUpdate.CHECKING
    state.offer == null -> BootUpdate.NONE
    mandatory || incompatible -> BootUpdate.REQUIRED
    later || state is UpdateState.Declined || state is UpdateState.Installed -> BootUpdate.NONE
    else -> BootUpdate.OPTIONAL
}

/** The boot card's buttons: UPDATE NOW until the player has asked for the install, then only the way on (LATER), which
 * never cancels the download. No else branch: a new state must be given its buttons here. */
fun bootCardActions(state: UpdateState, installRequested: Boolean): List<UpdateAction> = when (state) {
    UpdateState.Idle, is UpdateState.Declined, is UpdateState.Installed -> emptyList()
    is UpdateState.Offered, is UpdateState.ReadyToInstall -> listOf(UpdateAction.UPDATE_NOW, UpdateAction.LATER)
    is UpdateState.Downloading, is UpdateState.Verifying ->
        if (installRequested) listOf(UpdateAction.LATER) else listOf(UpdateAction.UPDATE_NOW, UpdateAction.LATER)
    is UpdateState.WaitingForBattle, is UpdateState.NeedsMeteredConsent, is UpdateState.AwaitingUserAction, is UpdateState.AwaitingPermission,
    is UpdateState.Installing, is UpdateState.Failed -> listOfNotNull(updateForwardAction(state), UpdateAction.LATER)
}

/** The required boot screen's CHECK AGAIN and dApp Store line: shown whenever the update itself has no way forward (an
 * unretryable failure, or nothing in progress), and for the rest of the launch once the update has failed on it
 * ([failedThisLaunch]): a download that fails every time (a 404, a full disk) must never leave TRY AGAIN as the only way. */
fun bootRetryOffered(state: UpdateState, failedThisLaunch: Boolean): Boolean = failedThisLaunch ||
    (updateForwardAction(state) == null && state !is UpdateState.Verifying && state !is UpdateState.Installing)

/** The 426 / unreadable-response dialog's way forward: an offered build is one tap away; without one, browsing goes on. */
fun incompatibleResponseAction(state: UpdateState): UpdateAction? =
    if (state.offer != null && state !is UpdateState.Installed) UpdateAction.UPDATE_NOW else null

/** Owner 2026-09-27: every launch looks for a newer build on the loading screen, before the game opens. [fetch] is the
 * session-less `GET /native/capabilities` (stable rows are public): no cookie, so no restore, sign-in or 401 can
 * supersede it. Runs on [scope] (the app scope), so a content failure or a cancelled boot attempt never stops it.
 * PkwApp only forwards its frames and events here ([decide], [onFrame], [onServerMovedOn], [dialogUpdate], [checkAgain]),
 * so every reaction of the launch is tested without Compose. */
class BootUpdateGate(
    private val scope: CoroutineScope,
    private val updates: UpdateRepository,
    private val fetch: suspend () -> JsonObject,
    /** This build's `versionCode`, for [bootIncompatible]. */
    private val versionCode: Long,
    /** False for an offline preview: it never checks, so it never waits. */
    private val enabled: Boolean = true,
    private val budgetMs: Long = BOOT_CHECK_BUDGET_MS,
    private val retryMs: Long = BOOT_CHECK_RETRY_MS,
) {
    private val _check = MutableStateFlow<BootCheck>(if (enabled) BootCheck.Pending else BootCheck.Done(null))
    val check: StateFlow<BootCheck> = _check.asStateFlow()
    private val _later = MutableStateFlow(false)
    /** The player chose LATER on the boot card: this launch opens the game; the Title/Home banner keeps the offer. */
    val later: StateFlow<Boolean> = _later.asStateFlow()
    private val _released = MutableStateFlow(false)
    /** This launch left the boot screen; the boot decision no longer applies until the next launch ([beginLaunch]). */
    val released: StateFlow<Boolean> = _released.asStateFlow()
    private var job: Job? = null
    /** The last answer this process read. A check that gets none keeps it: a failed CHECK AGAIN must not turn an
     * incompatible build's verdict into an optional offer. Only a process that never had an answer fails open. */
    private var last: PublicUpdateView? = null
    /** The decision and offer [onFrame] last acted on: each is acted on once per launch. */
    private var acted: Pair<BootUpdate, NativeUpdateOffer?>? = null
    private var launchFailures = 0

    /** Every Activity launch begins here (BootViewModel.init), before its first frame. Exit finishes the Activity while the
     * process, and this app-scoped gate, may live on: the next launch must meet the gate again, not inherit the last
     * launch's LATER or release. */
    fun beginLaunch() {
        _later.value = false; _released.value = false; acted = null
        launchFailures = updates.failures.value
        if (enabled) _check.value = BootCheck.Pending
    }

    /** Starts (or restarts, for a boot retry) the bounded check: one request, one retry after [retryMs], all inside
     * [budgetMs]. No answer in time is [BootCheck.Done] with the last answer, or none: the launch fails open. An answer
     * reaches the update channel as a public one before the decision is published, so the route never sees the answer
     * without its offer. */
    fun start(): Job? = launchCheck(fresh = true)

    /** A 426 or an unreadable response: ask again (tolerantly) unless a check is already running. The last answer stands
     * until a new one arrives, so a screen already showing the update never falls back to the loading card. */
    fun refresh(): Job? = if (job?.isActive == true) job else launchCheck(fresh = false)

    private fun launchCheck(fresh: Boolean): Job? {
        if (!enabled) return null
        job?.cancel()
        if (fresh) _check.value = BootCheck.Pending
        return scope.launch {
            val started = gg.pixelkingdomwars.nativeclient.diagnostics.BootTimeline.clock()
            val read = withTimeoutOrNull(budgetMs) { read() }
            if (read != null) last = read
            val view = read ?: last
            // The boot screen's own offer stands against later empty answers until the launch leaves it.
            if (!_released.value) updates.holdForLaunch(view?.update)
            read?.let { updates.onOffer(it.update, sessionBound = false) }
            _check.value = BootCheck.Done(view)
            gg.pixelkingdomwars.nativeclient.diagnostics.BootTimeline.stage(gg.pixelkingdomwars.nativeclient.diagnostics.LoadEvent.BOOT_CAPABILITIES,
                started, if (read != null) "answered" else "unanswered")
        }.also { job = it }
    }

    private suspend fun read(): PublicUpdateView? {
        repeat(2) { attempt ->
            try { return publicUpdateView(fetch()) }
            catch (error: CancellationException) { throw error }
            catch (_: Exception) { if (attempt == 0) delay(retryMs) }
        }
        return null
    }

    fun later() { _later.value = true }
    /** The launch reached a screen past the boot route: its decision, and its hold on the offer, end here. */
    fun release() { _released.value = true; updates.holdForLaunch(null) }

    /** This launch's decision from one frame's state, so the route and the gate always agree. */
    fun decide(check: BootCheck, state: UpdateState, mandatory: Boolean, contentFailed: Boolean, loadedSimVersion: Int?,
               later: Boolean, released: Boolean): BootUpdate =
        bootUpdateDecision(check, state, mandatory, bootIncompatible(check, versionCode, contentFailed, loadedSimVersion), later, released)

    /** PkwApp forwards every frame's route, decision and offer. Reaching any screen past the boot route releases the
     * launch. Each new decision, or a new offer under the same decision (a tester row that replaced the public one), is
     * acted on once through [onDecision]. */
    fun onFrame(destination: BootDestination, decision: BootUpdate, offer: NativeUpdateOffer?): Job? {
        if (!destination.bootScreen && !_released.value) release()
        if (acted == decision to offer) return null
        acted = decision to offer
        return onDecision(decision)
    }

    /** A required update starts at once and goes to the installer when verified; an optional one downloads in the
     * background on an unmetered network, so UPDATE NOW is one tap. */
    fun onDecision(decision: BootUpdate): Job? = when (decision) {
        BootUpdate.REQUIRED -> updates.updateNow()
        BootUpdate.OPTIONAL -> updates.prefetch()
        BootUpdate.CHECKING, BootUpdate.NONE -> null
    }

    /** A 426 or an unreadable response anywhere in the game: ask again, tolerantly, so its dialog can lead to the offer. */
    fun onServerMovedOn(): Job? = refresh()

    /** The 426 dialog's UPDATE NOW: the download, then Android's installer without a second tap. Null without an offer,
     * where the dialog keeps only "Continue browsing". */
    fun dialogUpdate(state: UpdateState): (() -> Job?)? =
        if (incompatibleResponseAction(state) != null) ({ updates.updateNow() }) else null

    /** The required screen's CHECK AGAIN: the content retry when the content did not open (it starts a fresh check too),
     * otherwise a fresh check. */
    fun checkAgain(contentFailed: Boolean, restartBoot: () -> Unit): Job? = if (contentFailed) { restartBoot(); null } else start()

    /** True once an update step failed during this launch, for [bootRetryOffered]. */
    fun failedThisLaunch(failures: Int): Boolean = failures > launchFailures
}
