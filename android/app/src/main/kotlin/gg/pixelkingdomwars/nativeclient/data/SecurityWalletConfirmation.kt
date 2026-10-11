package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.wallet.*
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject

/** One screen's MFA presentation follows only its active, identity-bound wallet action. */
class SecurityWalletConfirmation(
    private val access: SecurityAccess,
    private val isEmbedded: suspend (String) -> Boolean,
    private val social: () -> SocialLogin?,
    private val external: () -> WalletSigner,
    private val proveWithdrawal: suspend (WalletSigner, JsonObject, () -> Unit) -> RecentWalletProof = { _, _, _ -> error("Withdrawal confirmation is unavailable.") },
    private val prove: suspend (RecentAuthPurpose, WalletSigner, JsonObject?, () -> Unit) -> String,
) {
    private val mutableMfa = MutableStateFlow<PrivyMfaRequest?>(null)
    val mfa = mutableMfa.asStateFlow()
    private var activeSocial: SocialLogin? = null
    suspend fun authorize(purpose: RecentAuthPurpose, intent: JsonObject?): String = withSigner(purpose) { signer ->
        prove(purpose, signer, intent, access::requireCurrent)
    }
    suspend fun authorizeWithdrawal(intent: JsonObject): RecentWalletProof = withSigner(RecentAuthPurpose.WITHDRAWAL) { signer ->
        proveWithdrawal(signer, intent, access::requireCurrent)
    }
    private suspend fun <T> withSigner(purpose: RecentAuthPurpose, action: suspend (WalletSigner) -> T): T = coroutineScope {
        access.requireCurrent()
        val embedded = isEmbedded(access.wallet); access.requireCurrent()
        if (!embedded) return@coroutineScope action(external())
        val login = requireNotNull(social()) { "Reconnect the existing game wallet before confirming this action." }
        activeSocial = login
        val prompt = launch { login.mfa.collect { request -> access.requireCurrent(); mutableMfa.value = request } }
        try {
            if (purpose == RecentAuthPurpose.TOTP_RECOVERY) login.requireFreshMfa(access.wallet, access.token, access::requireCurrent)
            access.requireCurrent()
            val signer = login.securitySigner(access.wallet, access.token, access::requireCurrent)
            access.requireCurrent()
            action(signer)
        } finally { prompt.cancel(); mutableMfa.value = null; activeSocial = null }
    }
    suspend fun submitMfa(request: PrivyMfaRequest, code: String) {
        access.requireCurrent()
        check(mutableMfa.value === request) { "This wallet verification is no longer pending." }
        val login = requireNotNull(activeSocial)
        check(login.mfa.value === request) { "This wallet verification is no longer pending." }
        login.submitMfaCode(request, code)
        access.requireCurrent()
    }
    fun cancelMfa(request: PrivyMfaRequest) {
        access.requireCurrent()
        val login = activeSocial ?: return
        if (mutableMfa.value === request && login.mfa.value === request) login.cancelMfa()
    }
}
