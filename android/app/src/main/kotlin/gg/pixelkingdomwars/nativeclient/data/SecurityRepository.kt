package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.wallet.RecentAuthPurpose
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.serialization.json.*

data class AccountSecurityState(
    val status: AccountSecurityStatus? = null, val fresh: Boolean = false, val busy: Boolean = false,
    val enrollment: AuthenticatorEnrollment? = null, val enrollmentStarted: Boolean = false,
    val notice: String? = null, val error: String? = null, val needsSignIn: Boolean = false,
    val savedRecovery: SavedRecoveryAction? = null, val sensitiveRevision: Int = 0,
)

interface SecurityRepository {
    val state: StateFlow<AccountSecurityState>
    suspend fun refresh()
    suspend fun sendFactorEmail()
    suspend fun enrollAuthenticator(stepCode: String)
    suspend fun verifyAuthenticator(code: String)
    suspend fun disableAuthenticator(code: String)
    suspend fun startEmail(email: String, stepCode: String)
    suspend fun verifyEmail(code: String)
    suspend fun setLoginProtection(enabled: Boolean, code: String)
    suspend fun startRecovery()
    suspend fun confirmRecovery(code: String)
    suspend fun cancelRecovery(code: String)
    suspend fun sendRecoveryCompletionEmail()
    suspend fun completeRecovery(code: String)
    fun clearSensitive()
    fun setForeground(foreground: Boolean)
}

/** Account-only, usable with a full or login-recovery cookie. The integration supplies an exact cookie/
 * identity guard and WalletRecentAuth.prove; embedded TOTP_RECOVERY proof must first require fresh Privy MFA.
 * Grants live only on the action stack. Nothing here retries a mutation on error or on resume. */
class LiveSecurityRepository(
    private val api: ApiClient, private val requireCurrentIdentity: () -> Unit,
    private val authorize: suspend (RecentAuthPurpose, JsonObject?) -> String,
    private val recoveryStore: SecurityRecoveryStore,
    private val onSessionEnded: suspend (message: String) -> Unit,
    private val loginRecovery: Boolean = false,
    private val newRecoveryId: () -> String = { UUID.randomUUID().toString() },
) : SecurityRepository {
    private val mutable = MutableStateFlow(AccountSecurityState())
    override val state = mutable.asStateFlow()
    private val admission = Mutex()
    private var foreground = true
    override fun clearSensitive() { mutable.update { it.enrollment?.clearQr(); it.copy(enrollment = null, sensitiveRevision = it.sensitiveRevision + 1) } }
    override fun setForeground(foreground: Boolean) { this.foreground = foreground; if (!foreground) clearSensitive() }
    private suspend fun guard() { currentCoroutineContext().ensureActive(); requireCurrentIdentity() }
    private fun known(): AccountSecurityStatus {
        check(mutable.value.fresh && !mutable.value.needsSignIn) { "Refresh account security before making changes." }
        return requireNotNull(mutable.value.status)
    }
    private fun factors(replacementAllowed: Boolean = false): AccountSecurityStatus = known().also {
        check(!it.factorsLocked) { "Confirm, complete or cancel authenticator recovery before changing factors." }
        check(replacementAllowed || !it.replacementRequired) { "Verify a replacement authenticator first." }
    }
    private fun checkedCode(value: String, login: Boolean = false) = value.trim().also {
        // Wire schema: CodeBody accepts 6–8 ASCII digits; login/protection requires exactly 6.
        require(it.matches(if (login) Regex("[0-9]{6}") else Regex("[0-9]{6,8}"))) { "Enter the verification code." }
    }
    private fun step(method: String, value: String) = buildJsonObject { put("method", method); put("code", checkedCode(value)) }
    private fun bodyCode(value: String) = jsonBody("code" to checkedCode(value))

    private suspend fun ended(message: String) {
        guard(); clearSensitive()
        mutable.update { it.copy(needsSignIn = true, fresh = false, notice = message, error = null) }
        onSessionEnded(message)
    }
    private suspend fun readStatus() {
        guard()
        val saved = recoveryStore.read()
        val raw = api.get("/2fa/status"); guard()
        val status = try { AccountSecurityStatus.from(raw) } catch (_: Exception) { throw ApiCompatibilityException("/2fa/status") }
        val r = status.recovery
        val resolved = saved != null && r.id == saved.recoveryId && when (saved.action) {
            RecoveryAction.START -> r.phase != null
            RecoveryAction.CONFIRM -> r.phase != RecoveryPhase.EMAIL_PENDING
            RecoveryAction.CANCEL -> r.phase in setOf(RecoveryPhase.CANCELLED, RecoveryPhase.COMPLETED, RecoveryPhase.EXPIRED)
            RecoveryAction.SEND_COMPLETION -> r.phase != RecoveryPhase.HOLDING
            RecoveryAction.COMPLETE -> r.phase == RecoveryPhase.COMPLETED
        }
        if (resolved) recoveryStore.clear()
        mutable.update { it.copy(status = status, fresh = true, savedRecovery = if (resolved) null else saved,
            enrollment = if (status.totpEnabled || status.factorsLocked) null else it.enrollment,
            enrollmentStarted = !status.totpEnabled && it.enrollmentStarted) }
        if (saved?.action == RecoveryAction.COMPLETE && resolved) ended("Authenticator recovery completed. Sign in again to enroll a replacement.")
    }
    private suspend fun exclusive(block: suspend () -> Unit) {
        // Ignore a second tap instead of queueing a later mutation after the first has changed factors.
        if (!admission.tryLock()) return
        try {
            guard(); mutable.update { it.copy(busy = true, error = null, notice = null) }
            block()
        } catch (error: CancellationException) { throw error }
        catch (error: Exception) {
            guard()
            if (error is ApiException && error.status == 401) ended("Your session ended. Sign in again to check account security.")
            else mutable.update { it.copy(error = when (error) {
                is ApiException -> error.message
                is IllegalArgumentException, is IllegalStateException -> error.message ?: "Check the account security information."
                else -> "Account security could not be verified. Refresh before making changes."
            }) }
        } finally { mutable.update { it.copy(busy = false) }; admission.unlock() }
    }
    override suspend fun refresh() = exclusive {
        mutable.update { it.copy(fresh = false) }; readStatus()
        if (mutable.value.savedRecovery != null) mutable.update { it.copy(notice = "An earlier recovery request may be unfinished. Current server status is shown; no request was repeated.") }
    }
    private suspend fun post(path: String, body: JsonObject, purpose: RecentAuthPurpose? = RecentAuthPurpose.FACTOR_CHANGE,
                             recovery: SavedRecoveryAction? = null, success: String,
                             accept: suspend (JsonObject) -> Unit = {}) {
        guard()
        val intent = if (purpose == RecentAuthPurpose.TOTP_RECOVERY) jsonBody("recoveryId" to requireNotNull(recovery).recoveryId,
            "action" to if (recovery.action == RecoveryAction.START) "start" else "complete") else null
        // Wallet/MFA refusals precede dispatch and never become ambiguous server mutations.
        val grant = purpose?.let { authorize(it, intent).also { guard() } }
        recovery?.let { recoveryStore.write(it); mutable.update { state -> state.copy(savedRecovery = it) } }
        try {
            val result = if (grant == null) api.post(path, body) else api.postWithRecentAuth(path, body, grant)
            guard(); accept(result)
            if (recovery?.action == RecoveryAction.SEND_COMPLETION) recoveryStore.clear()
            if (!mutable.value.needsSignIn) {
                mutable.update { it.copy(fresh = false) }; readStatus()
                if (!mutable.value.needsSignIn) mutable.update { it.copy(notice = success) }
            }
        } catch (error: CancellationException) { throw error }
        catch (error: Exception) {
            guard(); mutable.update { it.copy(fresh = false) }
            // An HTTP refusal is definitive, but mutable server status can still have changed (expiry,
            // delivery failure after creating the recovery row, or another active session).
            val definitive = error is ApiException && error.status in 400..499
            try { readStatus() } catch (cancelled: CancellationException) { throw cancelled }
            catch (refresh: Exception) {
                if (refresh is ApiException && refresh.status == 401) {
                    ended("Your session ended. Sign in again to check whether the security change completed."); return
                }
            }
            if (!mutable.value.needsSignIn) mutable.update { it.copy(
                error = if (definitive) (error as ApiException).message else "The reply was interrupted. Check the server status below before trying this action again.",
                notice = null,
            ) }
        }
    }
    override suspend fun sendFactorEmail() = exclusive {
        val s = factors(replacementAllowed = true); check(s.emailVerified) { "A verified contact email is required." }
        post("/2fa/step-up/email", buildJsonObject {}, success = "Verification code sent to your current contact email.")
    }
    override suspend fun enrollAuthenticator(stepCode: String) = exclusive {
        val s = factors(replacementAllowed = true); check(!s.totpEnabled) { "An authenticator is already enabled." }
        val body = buildJsonObject { if (s.emailVerified) put("stepUp", step("email", stepCode)) }
        post("/2fa/totp/enroll", body, success = "Add the setup key to your authenticator, then verify its code.") { raw ->
            val enrollment = AuthenticatorEnrollment.from(raw)
            mutable.update { it.copy(enrollment = if (foreground) enrollment else null, enrollmentStarted = true) }
        }
    }
    override suspend fun verifyAuthenticator(code: String) = exclusive {
        val before = factors(replacementAllowed = true)
        post("/2fa/totp/verify", bodyCode(code), success = "Authenticator verified. Withdrawal readiness is shown below.") { raw ->
            check((raw["totpEnabled"] as? JsonPrimitive)?.takeUnless { it.isString }?.booleanOrNull == true) { "Authenticator verification could not be confirmed." }
            clearSensitive()
            if (loginRecovery || (before.replacementRequired && before.loginTotpRequired)) ended("Replacement authenticator verified. Sign in again with its new code.")
        }
    }
    override suspend fun disableAuthenticator(code: String) = exclusive {
        val s = factors(); check(!loginRecovery && s.totpEnabled && !s.loginTotpRequired) { "Disable login protection before removing its authenticator." }
        post("/2fa/totp/disable", bodyCode(code), success = "Authenticator disabled.")
    }
    override suspend fun startEmail(email: String, stepCode: String) = exclusive {
        val s = factors(); check(!loginRecovery) { "Finish signing in before changing contact email." }
        val address = email.trim(); require(address.length in 3..254 && '@' in address) { "Enter your contact email address." }
        val body = buildJsonObject {
            put("email", address)
            if (s.totpEnabled) put("stepUp", step("totp", stepCode)) else if (s.emailVerified) put("stepUp", step("email", stepCode))
        }
        post("/2fa/email/start", body, success = "Verification email requested. Enter the code sent to the pending address.")
    }
    override suspend fun verifyEmail(code: String) = exclusive {
        factors(); check(!loginRecovery) { "Finish signing in before changing contact email." }
        post("/2fa/email/verify", bodyCode(code), success = "Contact email verified.")
    }
    override suspend fun setLoginProtection(enabled: Boolean, code: String) = exclusive {
        val s = factors(); check(!loginRecovery && s.totpEnabled) { "A verified authenticator is required." }
        check(!enabled || (s.emailVerified && s.recoveryEnabled)) { "Login protection needs verified email and available recovery." }
        post("/auth/login/protection", buildJsonObject { put("enabled", enabled); put("code", checkedCode(code, login = true)) },
            success = "Login protection updated. Your other sessions were signed out.")
    }
    private fun active(vararg phases: RecoveryPhase): String {
        val r = known().recovery; check(r.phase in phases) { "Refresh to see the current recovery step." }
        return requireNotNull(r.id)
    }
    override suspend fun startRecovery() = exclusive {
        val s = known(); check(s.recoveryEnabled && s.totpEnabled && s.emailVerified && !s.replacementRequired) { "Recovery requires an enabled authenticator, verified contact email and available recovery service." }
        check(s.recovery.phase != RecoveryPhase.HOLDING) { "Authenticator recovery is already on hold." }
        val saved = recoveryStore.read()
        val id = if (s.recovery.phase == RecoveryPhase.EMAIL_PENDING) requireNotNull(s.recovery.id)
            else saved?.takeIf { it.action == RecoveryAction.START }?.recoveryId ?: newRecoveryId()
        UUID.fromString(id)
        post("/2fa/totp/recovery/start", jsonBody("recoveryId" to id), RecentAuthPurpose.TOTP_RECOVERY,
            SavedRecoveryAction(id, RecoveryAction.START), "Recovery email requested. Confirm it to start the security hold.")
    }
    override suspend fun confirmRecovery(code: String) = exclusive {
        val id = active(RecoveryPhase.EMAIL_PENDING)
        post("/2fa/totp/recovery/confirm", jsonBody("recoveryId" to id, "code" to checkedCode(code)), null,
            SavedRecoveryAction(id, RecoveryAction.CONFIRM), "Recovery hold started. The server refund receipt is shown below.")
    }
    override suspend fun cancelRecovery(code: String) = exclusive {
        val id = active(RecoveryPhase.EMAIL_PENDING, RecoveryPhase.HOLDING)
        post("/2fa/totp/recovery/cancel", jsonBody("recoveryId" to id, "code" to checkedCode(code)), null,
            SavedRecoveryAction(id, RecoveryAction.CANCEL), "Recovery cancelled. Refunded withdrawals remain cancelled.")
    }
    override suspend fun sendRecoveryCompletionEmail() = exclusive {
        val id = active(RecoveryPhase.HOLDING)
        post("/2fa/totp/recovery/complete/send-code", jsonBody("recoveryId" to id), RecentAuthPurpose.TOTP_RECOVERY,
            SavedRecoveryAction(id, RecoveryAction.SEND_COMPLETION), "Completion code sent to your verified contact email.")
    }
    override suspend fun completeRecovery(code: String) = exclusive {
        val id = active(RecoveryPhase.HOLDING)
        post("/2fa/totp/recovery/complete", jsonBody("recoveryId" to id, "code" to checkedCode(code)), RecentAuthPurpose.TOTP_RECOVERY,
            SavedRecoveryAction(id, RecoveryAction.COMPLETE), "") { raw ->
            val recovery = AuthenticatorRecovery.from(requireNotNull(raw["status"] as? JsonObject))
            check(recovery.id == id && recovery.phase == RecoveryPhase.COMPLETED) { "Recovery completion could not be verified." }
            recoveryStore.clear()
            ended("Old authenticator removed. All sessions ended. Sign in again to enroll a replacement.")
        }
    }
}
