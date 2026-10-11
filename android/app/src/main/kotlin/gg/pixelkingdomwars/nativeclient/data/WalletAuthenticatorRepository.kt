package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.wallet.PrivyTotpSetup
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

data class WalletAuthenticatorState(val embedded: Boolean? = null, val enrolled: Boolean? = null,
    val setup: PrivyTotpSetup? = null, val busy: Boolean = false, val message: String? = null)

/** Vendor MFA is separate from PKW 2FA. No setup seed/code is persisted and no factor is removed. */
class WalletAuthenticatorRepository(private val wallet: String, private val requireCurrent: () -> Unit,
    private val isEmbedded: suspend () -> Boolean,
    private val read: suspend (() -> Unit) -> Boolean,
    private val begin: suspend (() -> Unit) -> PrivyTotpSetup,
    private val finish: suspend (PrivyTotpSetup, String, () -> Unit) -> Unit) {
    private val mutable = MutableStateFlow(WalletAuthenticatorState())
    val state = mutable.asStateFlow()
    private val admission = Mutex()
    private var foreground = false
    private var generation = 0L
    fun setForeground(value: Boolean) {
        if (foreground == value) return
        foreground = value; generation++
        if (!value) mutable.value = mutable.value.copy(setup = null, enrolled = null, busy = false, message = null)
    }
    fun dismissSetup() { generation++; mutable.value = mutable.value.copy(setup = null, busy = false, message = null) }
    private fun guard(version: Long) {
        try { requireCurrent() } catch (error: Exception) {
            mutable.update { it.copy(setup = null, enrolled = null, busy = false) }; throw error
        }
        if (!foreground || generation != version) throw CancellationException("Wallet security screen changed")
    }
    private suspend fun action(failure: String, run: suspend (Long) -> Unit) {
        val version = generation
        admission.withLock {
            guard(version); mutable.update { it.copy(busy = true, message = null) }
            try { run(version); guard(version) }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { guard(version); mutable.update { it.copy(message = failure) } }
            finally { if (generation == version) mutable.update { it.copy(busy = false) } }
        }
    }
    suspend fun refresh() = action("Wallet security is unavailable. Reconnect your existing game wallet or refresh.") { version ->
        mutable.update { it.copy(enrolled = null, setup = null) }
        val embedded = isEmbedded(); guard(version)
        mutable.update { it.copy(embedded = embedded) }
        if (embedded) {
            val enrolled = read { guard(version) }; guard(version)
            mutable.update { it.copy(enrolled = enrolled) }
        }
    }
    suspend fun start(acknowledged: Boolean) = action("Setup could not be started. Refresh wallet security before trying again.") { version ->
        require(acknowledged && mutable.value.embedded == true && mutable.value.enrolled == false && mutable.value.setup == null)
        // Re-read before creating a factor so another device's enrollment is never replaced.
        val enrolled = read { guard(version) }; guard(version)
        mutable.update { it.copy(enrolled = enrolled) }; check(!enrolled)
        val setup = begin { guard(version) }; guard(version); require(setup.wallet == wallet)
        mutable.update { it.copy(setup = setup) }
    }
    suspend fun verify(setup: PrivyTotpSetup, code: String) = action("Verification was not confirmed. Refresh wallet security before starting another setup.") { version ->
        require(setup === mutable.value.setup && setup.wallet == wallet && code.matches(Regex("[0-9]{6}")))
        // A lost response can still mean enrolled. Clear the seed and require a provider read;
        // never replay a code or replace the factor because the response disappeared.
        mutable.update { it.copy(setup = null, enrolled = null) }
        finish(setup, code) { guard(version) }; guard(version)
        val enrolled = read { guard(version) }; guard(version); check(enrolled)
        mutable.update { it.copy(enrolled = true, message = "Privy wallet authenticator is enabled. Keep its setup key safe.") }
    }
}
