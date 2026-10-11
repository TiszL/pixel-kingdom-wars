package gg.pixelkingdomwars.nativeclient.session

import gg.pixelkingdomwars.nativeclient.network.SessionSupersededException
import gg.pixelkingdomwars.nativeclient.network.SessionToken
import kotlin.coroutines.CoroutineContext
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineName
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** Identity = wallet + origin + cookie generation. Every sign-in, TOTP completion, logout and
 * supersession creates a new instance; equality is by reference so a stale capture never matches. */
class AccountSession(val wallet: String, val origin: String, val token: SessionToken) {
    init { require(wallet.isNotBlank() && origin.isNotBlank()) }
    override fun toString() = "AccountSession(${wallet.take(6)}…)"
}

/** A SupervisorJob scope owned by exactly one [AccountSession]. Cancelled and recreated whenever
 * identity changes; repositories launch polling and receipt observation here, never in a global scope. */
class AccountScope internal constructor(val session: AccountSession, parent: Job?, dispatcher: CoroutineDispatcher) : CoroutineScope {
    private val job = SupervisorJob(parent)
    override val coroutineContext: CoroutineContext = job + dispatcher + CoroutineName("account:${session.wallet.take(6)}")
    val active: Boolean get() = job.isActive
    internal fun close(reason: String) { job.cancel(SessionSupersededException()); if (job.isActive) cancel(reason) }
}

/** The single source of truth for "who is signed in". Replacing the value cancels the previous
 * scope before the new one exists, so no coroutine of the old identity can publish afterwards. */
class AccountSessionHolder(private val parent: Job? = null, private val dispatcher: CoroutineDispatcher = Dispatchers.Main.immediate) {
    private val _session = MutableStateFlow<AccountSession?>(null)
    val session: StateFlow<AccountSession?> = _session.asStateFlow()
    private var scope: AccountScope? = null

    val current: AccountSession? get() = _session.value

    /** Installs [next] (or signs out with null) and returns its scope. */
    @Synchronized fun replace(next: AccountSession?): AccountScope? {
        scope?.close("Account identity changed")
        scope = next?.let { AccountScope(it, parent, dispatcher) }
        _session.value = next
        return scope
    }
    @Synchronized fun scopeOf(session: AccountSession): AccountScope? = scope?.takeIf { it.session === session && it.active }
    fun isCurrent(session: AccountSession): Boolean = _session.value === session
    /** Publish rule: a result computed for [captured] may be applied only while it is still current. */
    fun requireCurrent(captured: AccountSession) { if (!isCurrent(captured)) throw SessionSupersededException() }
    inline fun <T> publish(captured: AccountSession, block: () -> T): T? = if (isCurrent(captured)) block() else null
}
