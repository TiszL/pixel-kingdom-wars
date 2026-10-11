package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.diagnostics.BootTimeline
import gg.pixelkingdomwars.nativeclient.diagnostics.LoadEvent
import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.session.AccountSessionHolder
import gg.pixelkingdomwars.nativeclient.wallet.WalletLogin
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.*

enum class AccountPhase { RESTORING, SIGNED_OUT, TOTP, ALPHA, SIGNED_IN }

/** A fully authenticated cookie awaiting admission, never a playable AccountSession. */
class PendingAdmission(val wallet: String, val token: SessionToken, val seeker: SeekerIdentityStatus) {
    override fun toString() = "PendingAdmission(${wallet.take(6)}…)"
}

data class AccountState(
    val phase: AccountPhase = AccountPhase.RESTORING,
    val busy: Boolean = false,
    val error: String? = null,
    val identity: Identity? = null,
    val pendingWallet: String? = null,
    val directory: BaseDirectory? = null,
    val selectedBaseId: String? = null,
    /** Synchronous consent fence: A→B→A must never revive an old money review. */
    val baseSelectionGeneration: Long = 0,
    val security: SecurityStatus? = null,
    val playtest: PlaytestAccess? = null,
    val session: AccountSession? = null,
    val admission: PendingAdmission? = null,
) {
    val wallet: String? get() = identity?.wallet
    val selectedBase: BaseSummary? get() = directory?.bases?.firstOrNull { it.id == selectedBaseId }
    /** Land gate (web: `/me.entryPaid` + base presence). Free play continues until land is bought. */
    val landOwned: Boolean get() = identity?.entryPaid == true
}

/** One sign-in attempt: exchanges the server challenge for a session response with whichever signer the
 * player chose (an MWA wallet app or the Privy embedded wallet of a social account). */
fun interface SignInAttempt { suspend fun signIn(session: SessionToken, requireCurrentIdentity: () -> Unit): JsonObject }

interface AccountRepository {
    val state: StateFlow<AccountState>
    suspend fun restore()
    suspend fun connect(wallet: WalletLogin)
    suspend fun connectWith(attempt: SignInAttempt)
    suspend fun verifyTotp(code: String)
    /** Server logout first; [afterLocalSignOut] then releases device credentials (MWA token, Privy session). */
    suspend fun logout(afterLocalSignOut: suspend () -> Unit)
    suspend fun selectBase(id: String)
    /** `POST /bases/:id/activate` (web bases.tsx `activate`): the server re-reads deed ownership; the directory is re-read after. */
    suspend fun activateBase(id: String, replaceBaseId: String?)
    suspend fun refreshDirectory()
    suspend fun refreshIdentity()
    suspend fun resumeAdmission(admission: PendingAdmission) { error("Playtest admission is unavailable") }
    suspend fun loadSecurity()
    /** Handles a definitive 401 for [session]: clears local credentials and returns to the title. */
    fun discardSession(session: AccountSession, error: ApiException?)
}

/** Owns sign-in, TOTP, sign-out, the deed directory and the active-base selection. Installs the
 * [AccountSession] in the holder; everything account-scoped hangs off that session's scope. */
class LiveAccountRepository(
    private val api: GameApi,
    private val origin: String,
    private val holder: AccountSessionHolder,
    private val selectionStore: SecretStore,
    private val routing: ApiRouting,
    private val onSession: (AccountSession) -> Unit,
) : AccountRepository {
    /** Optional device-subscription cleanup runs while the authenticated cookie is still current. */
    var beforeLogout: suspend () -> Unit = {}
    var beforeIdentityChange: () -> Unit = {}
    private val _state = MutableStateFlow(AccountState())
    override val state: StateFlow<AccountState> = _state.asStateFlow()

    private fun client(token: SessionToken) = SessionApiClient(api, token, routing)

    override suspend fun restore() = authenticating {
        if (holder.current != null) beforeIdentityChange()
        val token = api.beginAuthentication()
        val statusAt = BootTimeline.clock()
        val status = LoginStatus.from(client(token).get("/auth/login/status"))
        BootTimeline.stage(LoadEvent.BOOT_SESSION, statusAt)
        if (status.loginRequired) awaitTotp(requireNotNull(status.wallet)) else loadAccount(token)
    }

    override suspend fun connect(wallet: WalletLogin) = connectWith { token, guard -> wallet.signIn(session = token, requireCurrentIdentity = guard) }

    override suspend fun connectWith(attempt: SignInAttempt) = authenticating {
        beforeIdentityChange()
        val token = api.beginAuthentication()
        val result = attempt.signIn(token) { api.requireCurrentSession(token) }
        signedIn(result, token)
    }

    override suspend fun verifyTotp(code: String) = authenticating {
        require(code.length == 6 && code.all(Char::isDigit)) { "Enter the 6-digit authenticator code" }
        val token = api.beginAuthentication()
        signedIn(client(token).post("/auth/login/verify", jsonBody("code" to code)), token)
    }

    private suspend fun signedIn(result: JsonObject, token: SessionToken) {
        api.requireCurrentSession(token)
        if (result.flag("loginRequired")) awaitTotp(requireNotNull(result.string("wallet"))) else loadAccount(token, expectedWallet = requireNotNull(result.string("wallet")))
    }

    private fun awaitTotp(wallet: String) {
        beforeIdentityChange()
        holder.replace(null)
        _state.update { AccountState(phase = AccountPhase.TOTP, pendingWallet = wallet, busy = it.busy) }
    }

    private suspend fun loadAccount(token: SessionToken, probeAlpha: Boolean = true, expectedWallet: String? = null) {
        val client = client(token)
        val identityAt = BootTimeline.clock()
        // This bootstrap owns ALPHA_GATED; do not also open the generic in-game gate dialog.
        val identity = try { Identity.from(api.get("/me", session = token)) } catch (error: Exception) {
            if (error !is ApiException || error.code != "ALPHA_GATED" || !probeAlpha) {
                if ((error as? ApiException)?.code != "ALPHA_GATED") routing.report(error)
                throw error
            }
            // Canonical gate probe supplies the authenticated wallet even after cold restore.
            // It can auto-admit a game wallet holding its SGT; it never signs or links an auxiliary wallet.
            val probe = client.post("/alpha/seeker")
            api.requireCurrentSession(token)
            val wallet = requireNotNull(probe.string("wallet")); require(gg.pixelkingdomwars.nativeclient.wallet.SeekerLinkContract.validWallet(wallet))
            require(expectedWallet == null || wallet == expectedWallet) { "The signed-in wallet changed" }
            val seeker = SeekerIdentityStatus.from(probe.getValue("seeker").jsonObject)
            require(probe["admitted"] == JsonPrimitive(true) || probe["admitted"] == JsonPrimitive(false))
            if (probe["admitted"] == JsonPrimitive(true)) { loadAccount(token, probeAlpha = false, expectedWallet = wallet); return }
            beforeIdentityChange()
            holder.replace(null)
            _state.update { AccountState(phase = AccountPhase.ALPHA, admission = PendingAdmission(wallet, token, seeker), busy = it.busy) }
            return
        }
        require(expectedWallet == null || identity.wallet == expectedWallet) { "The signed-in wallet changed" }
        BootTimeline.stage(LoadEvent.BOOT_IDENTITY, identityAt)
        val directoryAt = BootTimeline.clock()
        val directory = BaseDirectory.from(client.get("/bases"))
        BootTimeline.stage(LoadEvent.BOOT_DIRECTORY, directoryAt)
        val signedInAt = BootTimeline.clock()
        val saved = withContext(Dispatchers.IO) { readSelection(identity.wallet) }
        val selected = resolveSelection(saved, identity.wallet, directory)
        withContext(Dispatchers.IO) { persistSelection(identity.wallet, selected) }
        val playtest = runCatching { PlaytestAccess.from(client.get("/playtest/access")) }.getOrNull()
        api.requireCurrentSession(token)
        val session = AccountSession(identity.wallet, origin, token)
        holder.replace(session)
        _state.update { AccountState(phase = AccountPhase.SIGNED_IN, identity = identity, directory = directory, selectedBaseId = selected,
            playtest = playtest, session = session, busy = it.busy) }
        BootTimeline.stage(LoadEvent.BOOT_SIGNED_IN, signedInAt)
        // Home's own reads go first: optional reads wait for the first Home read (bounded; HomeReadGate).
        HomeReadGate.current.arm()
        onSession(session)
    }

    override suspend fun logout(afterLocalSignOut: suspend () -> Unit) = authenticating {
        val originalToken = api.sessionToken()
        beforeLogout()
        val token = api.beginLogout(originalToken)
        holder.replace(null)
        try { api.logout(token) }
        catch (error: CancellationException) { throw error }
        catch (error: Exception) {
            if (error is SecretStorageException) throw error
            if (error !is ApiException || error.status != 401) throw java.io.IOException("Signed out on this device. Server session revocation could not be confirmed.", error)
        } finally {
            // The local logout token stays current after its credentials are cleared; a superseding
            // login keeps both its UI and its MWA authorization.
            if (runCatching { api.requireCurrentSession(token) }.isSuccess) {
                withContext(NonCancellable) { _state.update { AccountState(phase = AccountPhase.SIGNED_OUT, busy = it.busy) }; afterLocalSignOut() }
            }
        }
    }

    /** Web UNLINK suspends this device's push and wallet connection while keeping its server cookie
     * and Privy session. Rotate the transport generation so old gameplay responses cannot revive it. */
    suspend fun unlink(clearWalletAuthorization: () -> Unit) = authenticating {
        val original = requireNotNull(holder.current) { "Connect a wallet first" }
        beforeLogout()
        holder.requireCurrent(original)
        api.requireCurrentSession(original.token)
        clearWalletAuthorization()
        api.beginAuthentication(original.token)
        holder.replace(null)
        _state.update { AccountState(phase = AccountPhase.SIGNED_OUT, busy = it.busy) }
    }

    override fun discardSession(session: AccountSession, error: ApiException?) {
        if (!holder.isCurrent(session)) return
        beforeIdentityChange()
        holder.replace(null)
        val message = try { api.forgetLocalSession(session.token); error?.message } catch (failure: Exception) { failure.message }
        _state.update { AccountState(phase = AccountPhase.SIGNED_OUT, error = message ?: "Your session ended. Sign in again.") }
    }

    /** Security completion can end a full or pending-login cookie. The existing logout path guards
     * credential release against a newer login; keep the verified/uncertain recovery notice at title. */
    suspend fun endSecuritySession(access: SecurityAccess, message: String, release: suspend () -> Unit) {
        access.requireCurrent()
        // Returning to Title disposes the security screen's coroutine. Once this captured cleanup
        // begins, finish credential release and its notice even when navigation cancels that scope.
        withContext(NonCancellable) {
            access.requireCurrent()
            var endedToken: SessionToken? = null
            logout { endedToken = api.sessionToken(); release() }
            val token = endedToken
            if (token != null && runCatching { api.requireCurrentSession(token) }.isSuccess && _state.value.phase == AccountPhase.SIGNED_OUT) {
                _state.update { it.copy(error = message) }
            }
        }
    }

    override suspend fun selectBase(id: String) {
        val current = _state.value
        val session = requireNotNull(current.session) { "Sign in first" }
        require(current.directory?.bases?.any { it.id == id && it.selectable } == true) { "This base is no longer active" }
        _state.update { if (it.session === session) it.copy(baseSelectionGeneration = it.baseSelectionGeneration + 1) else it }
        val generation = _state.value.baseSelectionGeneration
        withContext(Dispatchers.IO) { persistSelection(session.wallet, id) }
        holder.requireCurrent(session)
        _state.update { if (it.session === session && it.baseSelectionGeneration == generation) it.copy(selectedBaseId = id) else it }
    }

    override suspend fun activateBase(id: String, replaceBaseId: String?) {
        val session = requireNotNull(_state.value.session) { "Sign in first" }
        require(id.matches(Regex("[0-9a-fA-F-]{36}")) && (replaceBaseId == null || replaceBaseId.matches(Regex("[0-9a-fA-F-]{36}"))))
        client(session.token).post("/bases/$id/activate", buildJsonObject { replaceBaseId?.let { put("replaceBaseId", it) } })
        holder.requireCurrent(session)
        refreshDirectory()
    }

    override suspend fun refreshDirectory() {
        val session = requireNotNull(_state.value.session)
        val directory = BaseDirectory.from(client(session.token).get("/bases"))
        val saved = withContext(Dispatchers.IO) { readSelection(session.wallet) }
        val selected = resolveSelection(saved ?: _state.value.selectedBaseId?.let { buildJsonObject { put("wallet", session.wallet); put("baseId", it) } }, session.wallet, directory)
        withContext(Dispatchers.IO) { persistSelection(session.wallet, selected) }
        holder.requireCurrent(session)
        _state.update { if (it.session === session) it.copy(directory = directory, selectedBaseId = selected, baseSelectionGeneration = it.baseSelectionGeneration + if (it.selectedBaseId != selected) 1 else 0) else it }
    }

    override suspend fun refreshIdentity() {
        val session = requireNotNull(_state.value.session)
        val identity = Identity.from(client(session.token).get("/me"))
        require(identity.wallet == session.wallet) { "The signed-in wallet changed" }
        holder.requireCurrent(session)
        _state.update { if (it.session === session) it.copy(identity = identity) else it }
    }

    override suspend fun resumeAdmission(admission: PendingAdmission) {
        api.requireCurrentSession(admission.token)
        check(_state.value.phase == AccountPhase.ALPHA && _state.value.admission === admission) { "The playtest account changed" }
        try { loadAccount(admission.token, probeAlpha = false, expectedWallet = admission.wallet) }
        catch (error: ApiException) { if (error.status == 401) discardAdmission(admission, error); throw error }
    }

    fun discardAdmission(admission: PendingAdmission, error: ApiException) {
        if (_state.value.phase != AccountPhase.ALPHA || _state.value.admission !== admission) return
        api.requireCurrentSession(admission.token)
        beforeIdentityChange()
        api.forgetLocalSession(admission.token)
        _state.value = AccountState(phase = AccountPhase.SIGNED_OUT, error = error.message)
    }

    override suspend fun loadSecurity() {
        val session = requireNotNull(_state.value.session)
        val security = SecurityStatus.from(client(session.token).get("/2fa/status"))
        holder.requireCurrent(session)
        _state.update { if (it.session === session) it.copy(security = security) else it }
    }

    /** One authentication transition at a time; the transport rejects a superseded token itself. */
    private suspend fun authenticating(block: suspend () -> Unit) {
        _state.update { it.copy(busy = true, error = null) }
        try { block() }
        catch (error: CancellationException) { throw error }
        catch (error: Exception) {
            val expired = error is ApiException && error.status == 401
            if (expired) beforeIdentityChange()
            // A cookie-less cold restore answers 401: that is "not signed in", not a failure to show.
            val silent = expired && _state.value.phase == AccountPhase.RESTORING
            _state.update { (if (it.phase == AccountPhase.RESTORING || expired) AccountState(phase = AccountPhase.SIGNED_OUT) else it)
                .copy(error = if (silent) null else error.message ?: "Connection interrupted. Please retry.") }
            if (expired) runCatching { error.session?.let(api::forgetLocalSession) }
        } finally { _state.update { it.copy(busy = false) } }
    }

    private fun readSelection(wallet: String): JsonObject? {
        val selection = selectionStore.read()?.let { value -> runCatching { Json.parseToJsonElement(value).jsonObject }.getOrNull() }
        return if (selection?.string("wallet") != wallet) { selectionStore.clear(); null } else selection
    }
    private fun persistSelection(wallet: String, baseId: String?) {
        if (baseId == null) selectionStore.clear() else selectionStore.write(jsonBody("wallet" to wallet, "baseId" to baseId).toString())
    }
    private fun resolveSelection(saved: JsonObject?, wallet: String, directory: BaseDirectory): String? =
        resolveBaseSelection(saved, wallet, directory.bases.map { base -> buildJsonObject {
            put("id", base.id); base.status?.let { put("status", it) }; put("slot", base.slot?.let(::JsonPrimitive) ?: JsonNull)
        } })
}
