package gg.pixelkingdomwars.nativeclient.update

import gg.pixelkingdomwars.nativeclient.model.NativeCapabilities
import gg.pixelkingdomwars.nativeclient.model.NativeUpdateOffer
import gg.pixelkingdomwars.nativeclient.network.GameApi
import gg.pixelkingdomwars.nativeclient.network.SessionSupersededException
import gg.pixelkingdomwars.nativeclient.network.SessionToken
import gg.pixelkingdomwars.nativeclient.telemetry.NativeError
import gg.pixelkingdomwars.nativeclient.telemetry.NativeTelemetryRuntime
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

sealed interface UpdateState {
    val offer: NativeUpdateOffer? get() = null
    data object Idle : UpdateState
    data class Offered(override val offer: NativeUpdateOffer, val mandatory: Boolean, val sizeBytes: Long) : UpdateState
    /** Not an error: a battle or replay is on screen, so the download waits until the player asks again. */
    data class WaitingForBattle(override val offer: NativeUpdateOffer) : UpdateState
    data class NeedsMeteredConsent(override val offer: NativeUpdateOffer) : UpdateState
    data class Downloading(override val offer: NativeUpdateOffer, val bytes: Long, val total: Long) : UpdateState
    data class Verifying(override val offer: NativeUpdateOffer) : UpdateState
    data class ReadyToInstall(override val offer: NativeUpdateOffer) : UpdateState
    data class AwaitingUserAction(override val offer: NativeUpdateOffer, val prompt: SystemPrompt) : UpdateState
    data class AwaitingPermission(override val offer: NativeUpdateOffer, val prompt: SystemPrompt) : UpdateState
    data class Installing(override val offer: NativeUpdateOffer) : UpdateState
    data class Installed(override val offer: NativeUpdateOffer) : UpdateState
    data class Declined(override val offer: NativeUpdateOffer) : UpdateState
    data class Failed(override val offer: NativeUpdateOffer, val kind: UpdateFailureKind, val retryable: Boolean, val detail: String? = null) : UpdateState
}

/** Holds the one repository for platform entry points that cannot receive it (the installer status receiver, the
 * Title and Home banner mounts). Set once by AppGraph. */
internal object NativeUpdateRuntime { @Volatile var repository: UpdateRepository? = null }

/** M45 §5 in-app update state machine. Main-thread confined like the rest of the app graph; file work runs on IO
 * inside the downloader, verifier and installer. Declines and metered consent are remembered in this process only. */
class UpdateRepository(
    private val scope: CoroutineScope,
    private val apiOrigin: String,
    private val running: () -> RunningIdentity?,
    private val downloader: ApkDownloader,
    private val verifier: UpdateVerifier,
    private val installer: UpdateInstaller,
    private val isMetered: () -> Boolean,
    /** False while a battle or replay scene is active; watched for the whole transfer, not only at its start. */
    private val activation: StateFlow<Boolean>,
    private val marker: InstallMarker,
    private val record: (NativeError) -> Unit = { NativeTelemetryRuntime.record(it) },
) {
    private val _state = MutableStateFlow<UpdateState>(UpdateState.Idle)
    val state: StateFlow<UpdateState> = _state.asStateFlow()
    private val _mandatoryBlocking = MutableStateFlow(false)
    /** An eligible mandatory offer pauses game orders through `ContentState.allowsGameOrders`, nothing more. */
    val isMandatoryBlocking: StateFlow<Boolean> = _mandatoryBlocking.asStateFlow()

    private data class Key(val code: Long, val sha256: String)
    private val NativeUpdateOffer.key get() = Key(latestVersionCode, sha256)
    private var eligible: UpdateEligibility.Eligible? = null
    /** True while [eligible] came from a check bound to the caller's session, the only view that carries tester rows. */
    private var sessionOffer = false
    private var identity: RunningIdentity? = null
    private var verified: VerifiedApk? = null
    private var job: Job? = null
    private val offered = mutableSetOf<Key>()
    private val declined = mutableSetOf<Key>()
    /** UPDATE NOW (the boot card) or the boot gate's required update: this offer goes to Android's installer as soon as
     * its file is verified, without a second tap. The system dialog still asks the player. */
    private var installKey: Key? = null
    private val _installRequested = MutableStateFlow(false)
    val installRequested: StateFlow<Boolean> = _installRequested.asStateFlow()
    private fun requestInstall(key: Key?) { installKey = key; _installRequested.value = key != null }
    private val meteredConsent = mutableSetOf<Key>()
    private val permissionBlocked = mutableSetOf<Key>()
    private fun canActivate() = activation.value
    /** The boot gate's own offer while its launch is still on the boot screen ([holdForLaunch]). */
    private var launchHold: Key? = null
    private val _failures = MutableStateFlow(0)
    /** Update steps that failed in this process; the boot gate compares it with the count its launch began with. */
    val failures: StateFlow<Int> = _failures.asStateFlow()

    /** Owner 2026-09-27: the offer the boot gate read decides its launch. Until the launch leaves the boot screen (null),
     * no later answer without an offer (a race with a withdrawn row, a caller that does not see it) may clear it, so a
     * required update cannot be lifted behind the player's back. A different eligible row still replaces it. */
    fun holdForLaunch(offer: NativeUpdateOffer?) { launchHold = offer?.key }

    init {
        // A self-update kills this process before STATUS_SUCCESS can reach it: the newer build counts the install.
        marker.pendingVersionCode?.let { code ->
            if ((running()?.versionCode ?: 0) >= code) { record(NativeError.UPDATE_INSTALLED); marker.pendingVersionCode = null }
        }
        // Independent of the network: the APK that installed this build (and any older one) can never be offered again,
        // and a later capabilities check may never come, so it is released now rather than when an empty offer arrives.
        scope.launch(Dispatchers.IO) { runCatching { running()?.let { downloader.prune(it.versionCode, keep = null) } } }
    }

    internal val busy get() = when (_state.value) {
        is UpdateState.Downloading, is UpdateState.Verifying, is UpdateState.Installing, is UpdateState.AwaitingUserAction, is UpdateState.Installed -> true
        else -> false
    }
    private fun offered(offer: NativeUpdateOffer): UpdateState =
        if (!offer.mandatory && offer.key in declined) UpdateState.Declined(offer) else UpdateState.Offered(offer, offer.mandatory, offer.sizeBytes)

    /** Offers belong to the caller that fetched them (M45 §1: tester rows reach only tester wallets). A new caller starts
     * clean, unless the previous caller's install is already with the system installer. A public offer (a stable row,
     * visible to every caller) is kept with its transfer: the restore's sign-in must not wipe the offer the boot gate
     * just showed (owner 2026-09-27); the new caller's session-bound check confirms or replaces it. */
    fun onCallerChanged() {
        if (_state.value is UpdateState.Installing || _state.value is UpdateState.AwaitingUserAction || _state.value is UpdateState.Installed) return
        if (!sessionOffer && eligible != null) return
        job?.cancel(); eligible = null; verified = null; sessionOffer = false; requestInstall(null)
        _mandatoryBlocking.value = false
        _state.value = UpdateState.Idle
    }

    /** [sessionBound] is false for an answer fetched without the caller's session: it sees stable rows only, so it may add
     * or refresh an offer but never clear, replace or un-pause one a session-bound check produced (owner 2026-09-27: a
     * tester row must not vanish behind a public answer). A session-bound answer without `update` still clears: the row
     * was withdrawn, or the wallet lost tester status. */
    fun onCapabilities(capabilities: NativeCapabilities, sessionBound: Boolean = true) = onOffer(capabilities.update, sessionBound)

    /** [onCapabilities] for an offer read without the full capabilities decode (the boot gate's tolerant read). */
    fun onOffer(update: NativeUpdateOffer?, sessionBound: Boolean = true) {
        val running = running().also { identity = it }
        val next = update?.let { offer ->
            eligibleOffer(offer, running?.versionCode ?: Long.MAX_VALUE, apiOrigin, running?.signerSha256) as? UpdateEligibility.Eligible
        }
        if (!sessionBound && sessionOffer && next?.offer?.key != eligible?.offer?.key) return
        if (next == null && launchHold != null && eligible?.offer?.key == launchHold) return
        val current = _state.value
        if (next != null && current.offer?.key == next.offer.key) {
            eligible = next; if (sessionBound) sessionOffer = true
            _mandatoryBlocking.value = next.offer.mandatory
            // Same file; only `mandatory` may change (false→true) on the server. Refresh an idle offer's copy.
            if (current is UpdateState.Offered || current is UpdateState.Declined) _state.value = offered(next.offer)
            return
        }
        // The boot gate's public offer may already be downloading when the caller's session-bound answer names another row
        // (a tester build): that answer is the caller's own and replaces it. An answer without a row replaces nothing: it
        // is not the caller's own build, and the public transfer (a required one, maybe) keeps going. Nothing replaces a
        // file the installer holds.
        val replacesPublic = sessionBound && !sessionOffer && next != null && (current is UpdateState.Downloading || current is UpdateState.Verifying)
        // The pause follows the offer that stays: an answer that cannot change the transfer cannot lift its pause either.
        if (busy && !replacesPublic) return
        if (replacesPublic) job?.cancel()
        // UPDATE NOW named the offer being replaced; the boot gate asks again for the new one.
        if (next?.offer?.key != installKey) requestInstall(null)
        _mandatoryBlocking.value = next?.offer?.mandatory == true
        eligible = next; verified = null; sessionOffer = sessionBound && next != null
        if (next == null) downloader.discard() else running?.let { downloader.prune(it.versionCode, keep = next.offer) }
        _state.value = next?.let { offered(it.offer) } ?: UpdateState.Idle
        if (next != null && offered.add(next.offer.key)) record(NativeError.UPDATE_OFFERED)
    }

    /** Refuses during a battle or replay; asks first on a metered network. Returns the transfer job for observers. */
    fun startDownload(consentToMetered: Boolean = false): Job? {
        val target = eligible ?: return null
        val running = identity ?: return null
        if (busy || job?.isActive == true) return job
        val offer = target.offer
        if (!canActivate()) { _state.value = UpdateState.WaitingForBattle(offer); return null }
        if (consentToMetered) meteredConsent += offer.key
        if (offer.key !in meteredConsent && isMetered()) { _state.value = UpdateState.NeedsMeteredConsent(offer); return null }
        _state.value = UpdateState.Downloading(offer, 0, offer.sizeBytes)
        return scope.launch transfer@{
            // A battle or replay that opens mid-transfer stops it; the .part file stays for a Range resume.
            val guard = launch { activation.first { !it }; this@transfer.cancel() }
            try {
                // Progress arrives on the IO thread: it never overwrites a state a cancel, decline or caller change already set.
                val apk = downloader.download(offer, target.resolvedUrl) { bytes, total ->
                    _state.update { if (it is UpdateState.Downloading && it.offer == offer) UpdateState.Downloading(offer, bytes, total) else it }
                }
                record(NativeError.UPDATE_DOWNLOADED)
                _state.value = UpdateState.Verifying(offer)
                verified = verifier.verify(apk.file, offer, running)
                record(NativeError.UPDATE_VERIFIED)
                _state.value = UpdateState.ReadyToInstall(offer)
                if (installKey == offer.key) install()
            } catch (error: CancellationException) {
                // Only this transfer's own state is replaced; a decline or a caller change already set the next one.
                val current = _state.value
                if ((current is UpdateState.Downloading || current is UpdateState.Verifying) && current.offer == offer)
                    _state.value = if (canActivate()) offered(offer) else UpdateState.WaitingForBattle(offer)
                throw error
            }
            catch (error: UpdateFailure) { fail(offer, error) }
            finally { guard.cancel() }
        }.also { job = it }
    }

    fun cancel() { requestInstall(null); job?.cancel() }

    /** UPDATE NOW on the boot card, and the boot gate's required update: download if needed (asking first on a metered
     * network, as [startDownload] does) and hand the verified file to Android's installer without another tap. */
    fun updateNow(consentToMetered: Boolean = false): Job? {
        val offer = eligible?.offer ?: return null
        requestInstall(offer.key)
        val state = _state.value
        return if (state is UpdateState.ReadyToInstall || (state is UpdateState.Failed && state.kind == UpdateFailureKind.INSTALL)) install()
            else startDownload(consentToMetered)
    }

    /** The boot card's background start, so UPDATE NOW is one tap: only for an offer still waiting on the player, and
     * never on a metered network, where the player is asked first. */
    fun prefetch(): Job? = if (_state.value is UpdateState.Offered && !isMetered()) startDownload() else null

    /** Starts the system install flow; after an unknown-sources grant, [onForeground] resumes it. */
    fun install(): Job? {
        val apk = verified ?: return null
        val offer = eligible?.offer ?: return null
        val state = _state.value
        if (state !is UpdateState.ReadyToInstall && state !is UpdateState.AwaitingPermission && !(state is UpdateState.Failed && state.kind == UpdateFailureKind.INSTALL)) return null
        if (!canActivate()) return null
        _state.value = UpdateState.Installing(offer)
        return scope.launch {
            marker.pendingVersionCode = offer.latestVersionCode
            try { installer.install(apk) }
            catch (error: UpdateFailure) {
                marker.pendingVersionCode = null
                if (error.kind == UpdateFailureKind.PERMISSION && error.prompt != null) {
                    // Counted once per offer: returning from Settings without the grant, or a later retry, is the same block.
                    if (permissionBlocked.add(offer.key)) record(NativeError.UPDATE_FAILED_PERMISSION)
                    _state.value = UpdateState.AwaitingPermission(offer, error.prompt)
                } else { if (error.kind == UpdateFailureKind.HASH) verified = null; fail(offer, error) }
            }
        }.also { job = it }
    }

    fun onInstallEvent(event: InstallEvent) {
        val offer = _state.value.offer ?: return
        when (event) {
            is InstallEvent.PendingUserAction -> _state.value = UpdateState.AwaitingUserAction(offer, event.prompt)
            InstallEvent.Success -> { marker.pendingVersionCode = null; record(NativeError.UPDATE_INSTALLED); _state.value = UpdateState.Installed(offer) }
            is InstallEvent.Failure -> { marker.pendingVersionCode = null; fail(offer, UpdateFailure(UpdateFailureKind.INSTALL, event.detail, telemetry = event.telemetry)) }
        }
    }

    /** The player returned from Settings: continue only if the grant was given. */
    fun onForeground(): Job? =
        if (_state.value is UpdateState.AwaitingPermission && installer.canInstall()) install() else null

    /** Mandatory offers cannot be declined, only put away; orders stay paused until the update installs. */
    fun decline() {
        val offer = _state.value.offer ?: return
        job?.cancel(); requestInstall(null)
        if (offer.mandatory) { _state.value = UpdateState.Offered(offer, true, offer.sizeBytes); return }
        if (declined.add(offer.key)) record(NativeError.UPDATE_DECLINED)
        _state.value = UpdateState.Declined(offer)
    }

    private fun fail(offer: NativeUpdateOffer, error: UpdateFailure) {
        record(error.telemetry)
        _failures.value++ // before the state, so a screen drawing the failure already counts it
        _state.value = UpdateState.Failed(offer, error.kind, error.kind.retryable, error.message)
    }
}

/** Survives the package replacement: the version this app handed to the system installer, read by the next launch. */
interface InstallMarker { var pendingVersionCode: Long? }

/** AppGraph's M45 §5 edges in one tested place. [callers] emits the signed-in wallet, or null when signed out: every
 * caller gets its own offer, because the server shows tester rows only to tester wallets and stable rows to everyone,
 * signed out included (the Title banner). [fetch] receives that caller ([updateCapabilities]) and must bind a signed-in
 * caller's check to that caller's session (or fail): only a signed-out check is public. A check that fails (a token
 * swap discarded it, or the network dropped) is retried once [settled] says the account restore reached a terminal
 * state. Each [foreground] signal (the app came back to the screen) asks again, at most once per [FOREGROUND_RECHECK_MS]
 * by [clock] (milliseconds), so a row published while this process lives is seen without a cold start. A mandatory
 * eligible offer reaches `ContentState.allowsGameOrders` through [blockOrders], and lifts when the offer goes. */
internal fun CoroutineScope.bindUpdateChannel(updates: UpdateRepository, callers: Flow<String?>,
                                              fetch: suspend (caller: String?) -> NativeCapabilities,
                                              settled: Flow<Boolean> = flowOf(true), foreground: Flow<Unit> = emptyFlow(),
                                              clock: () -> Long = { System.nanoTime() / 1_000_000 }, blockOrders: (Boolean) -> Unit) {
    launch { updates.isMandatoryBlocking.collect { blockOrders(it) } }
    launch { callers.distinctUntilChanged().collectLatest { caller ->
        updates.onCallerChanged()
        var last = 0L
        suspend fun check(): Boolean = try { last = clock(); updates.onCapabilities(fetch(caller), sessionBound = caller != null); true }
            // Superseded is a CancellationException, but here it names someone else's identity change, not ours.
            catch (_: SessionSupersededException) { currentCoroutineContext().ensureActive(); false }
            catch (error: CancellationException) { throw error } catch (_: Exception) { false }
        // Best effort: one retry after the restore settles; after that the next foreground check offers again.
        if (!check()) { settled.first { it }; check() }
        // Owner 2026-09-27: the code 27 tester row was published while the process lived and a warm start asked nothing.
        // Never while a transfer or the system installer holds this app's update: that state is left exactly as it is.
        foreground.collect { if (clock() - last >= FOREGROUND_RECHECK_MS && !updates.busy) check() }
    } }
}

/** The capabilities check behind [bindUpdateChannel]. Stable rows are public, so without a [session] (signed out, or
 * the restore still running) the request carries no cookie and no restore, sign-in or 401 can supersede it. A signed-in
 * caller's check is bound to that session, so the server adds the tester rows for its wallet. */
internal suspend fun updateCapabilities(api: GameApi, session: SessionToken?): NativeCapabilities =
    NativeCapabilities.from(if (session == null) api.getPublic(CAPABILITIES_PATH) else api.get(CAPABILITIES_PATH, session = session))

private const val CAPABILITIES_PATH = "/native/capabilities"
/** The foreground re-check's floor: a player flicking between apps costs at most one capabilities request a minute. */
internal const val FOREGROUND_RECHECK_MS = 60_000L
