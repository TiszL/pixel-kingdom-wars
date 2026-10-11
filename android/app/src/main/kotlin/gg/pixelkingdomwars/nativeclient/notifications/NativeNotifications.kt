package gg.pixelkingdomwars.nativeclient.notifications

import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.data.ApiClient
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import java.util.UUID
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.*

interface NotificationTokens {
    suspend fun token(): String
    suspend fun delete()
    fun autoInit(enabled: Boolean)
}
data class NotificationSettings(val supported: Boolean = false, val optedIn: Boolean = false,
    val busy: Boolean = false, val error: String? = null)

/** Registration is an idempotent preference sync. No push can authenticate, select a deed or issue a game order. */
class NativeNotifications(private val journal: NotificationJournal, private val tokens: NotificationTokens,
    private val current: () -> AccountSession?, private val api: (AccountSession) -> ApiClient,
    private val guard: (AccountSession) -> Unit, private val permitted: () -> Boolean,
    private val configured: Boolean, private val packageName: String, private val cancelShown: () -> Unit) {
    private val mutable = MutableStateFlow(NotificationSettings()); val state = mutable.asStateFlow()
    private val mutex = Mutex()
    private var epoch = 0L
    private var locallyBlocked = false
    private var blockedSession: AccountSession? = null
    fun identityChanged(session: AccountSession) {
        epoch++
        val saved = runCatching { journal.read() }.getOrNull()
        if (saved != null && saved.wallet != session.wallet) {
            journal.revoke(); tokens.autoInit(false); cancelShown()
        }
        mutable.update { it.copy(optedIn = false) }
    }
    private fun requireSame(session: AccountSession, captured: Long) {
        guard(session); check(current() === session && captured == epoch && !locallyBlocked) { "Notification settings changed." }
    }
    private suspend fun operation(block: suspend () -> Unit) = mutex.withLock {
        mutable.update { it.copy(busy = true, error = null) }
        try { withTimeout(30_000) { block() } } // Device/network deadline; never a gameplay timer.
        catch (_: TimeoutCancellationException) { mutable.update { it.copy(error = "Notification setup timed out. Your choice is saved for the next check.") } }
        catch (e: CancellationException) { throw e }
        catch (_: Exception) { mutable.update { it.copy(error = "Notification settings could not be confirmed. Try again when connected.") } }
        finally { mutable.update { it.copy(busy = false) } }
    }
    /** Immediate local revocation runs before cookie release, even when the network is unavailable. */
    fun blockLocally() {
        epoch++; locallyBlocked = true; blockedSession = current(); journal.revoke()
        tokens.autoInit(false); cancelShown()
        mutable.value = NotificationSettings()
    }
    suspend fun signOut() {
        if (current() != null) return
        blockLocally()
        val captured = epoch
        operation { if (captured == epoch && current() == null) {
            val saved = journal.read(); tokens.delete(); saved?.let(journal::clearIf)
        } }
    }
    suspend fun refresh() = operation {
        val session = current() ?: return@operation
        if (!configured) return@operation
        // A known logged-out capability never becomes consent for a later account.
        if (locallyBlocked) {
            if (blockedSession === session) return@operation
            locallyBlocked = false
        }
        val captured = epoch
        val saved = journal.read()
        // Consent remains revocable while delivery is paused or its last response is unknown.
        mutable.update { it.copy(optedIn = saved?.wallet == session.wallet && saved.consented) }
        val reply = api(session).get(PATH); requireSame(session, captured)
        require(reply.keys == setOf("version", "enabled") && reply["version"] == JsonPrimitive(1))
        val enabled = requireNotNull((reply["enabled"] as? JsonPrimitive)?.booleanOrNull)
        mutable.update { it.copy(supported = enabled) }
        if (saved != null && (!saved.consented || saved.wallet != session.wallet || !permitted())) {
            disableBound(session, saved); return@operation
        }
        if (enabled && saved != null && permitted()) register(session, saved, captured)
    }
    suspend fun enable() = operation {
        val session = requireNotNull(current()); check(configured && permitted())
        locallyBlocked = false; val captured = epoch
        val status = api(session).get(PATH); requireSame(session, captured)
        require(status.keys == setOf("version", "enabled") && status["version"] == JsonPrimitive(1) && status["enabled"] == JsonPrimitive(true))
        val previous = journal.read()
        if (previous != null && (!previous.consented || previous.wallet != session.wallet)) {
            tokens.autoInit(false); journal.revoke(); tokens.delete(); journal.clearIf(previous); requireSame(session, captured)
        }
        val saved = journal.read()?.takeIf { it.consented } ?: NotificationBinding(session.wallet, UUID.randomUUID().toString(), tokens.token())
        requireSame(session, captured); check(permitted())
        journal.save(saved); register(session, saved, captured)
    }
    private suspend fun register(session: AccountSession, original: NotificationBinding, captured: Long) {
        check(original.consented)
        val next = tokens.token(); requireSame(session, captured); check(permitted() && NotificationJournal.token(next))
        check(journal.matches(original)) { "The notification token changed. Check again." }
        val saved = if (next == original.token) original else original.copy(token = next, previousToken = original.token, active = false)
        journal.save(saved)
        mutable.update { it.copy(optedIn = true) }
        try {
            api(session).post("$PATH/subscribe", buildJsonObject {
                put("token", saved.token); put("bindingId", saved.bindingId); put("packageName", packageName)
                saved.previousToken?.let { put("previousToken", it) }
            })
        } catch (e: ApiException) {
            if (e.status in setOf(401, 403, 409) && journal.matches(saved)) {
                journal.revoke(); tokens.autoInit(false); cancelShown()
                mutable.update { it.copy(optedIn = false) }
            }
            throw e
        }
        requireSame(session, captured); check(permitted())
        journal.confirm(saved)
        tokens.autoInit(true)
        mutable.update { it.copy(supported = true, optedIn = true) }
    }
    suspend fun disable() = operation {
        val session = current(); val saved = journal.read()
        epoch++; locallyBlocked = true; blockedSession = session; journal.revoke(); tokens.autoInit(false); cancelShown()
        mutable.update { it.copy(optedIn = false) }
        try { if (session != null && saved != null && saved.wallet == session.wallet) retire(session, saved) }
        finally { tokens.delete(); saved?.let(journal::clearIf) }
    }
    private suspend fun disableBound(session: AccountSession, saved: NotificationBinding) {
        epoch++; journal.revoke(); tokens.autoInit(false); cancelShown()
        mutable.update { it.copy(optedIn = false) }
        try { if (saved.wallet == session.wallet) retire(session, saved) } finally { tokens.delete(); journal.clearIf(saved) }
    }
    private suspend fun retire(session: AccountSession, saved: NotificationBinding) {
        guard(session)
        api(session).delete("$PATH/subscribe", buildJsonObject { put("token", saved.token); put("bindingId", saved.bindingId) })
        saved.previousToken?.let { previous ->
            guard(session)
            api(session).delete("$PATH/subscribe", buildJsonObject { put("token", previous); put("bindingId", saved.bindingId) })
        }
    }
    /** Called with the still-current authenticated session before ordinary logout revokes its cookie. */
    suspend fun beforeLogout() {
        val session = current(); val saved = runCatching { journal.read() }.getOrNull()
        blockLocally()
        val captured = epoch
        // Revoked consent remains durable until SDK deletion succeeds, including process death.
        // Logout must not be held hostage by an unavailable notification endpoint.
        withContext(NonCancellable) {
            mutex.withLock {
                if (epoch != captured || current() !== session) return@withLock
                // Serialize SDK deletion with a later account's explicit enable.
                val deleted = runCatching { withTimeout(5_000) { tokens.delete() } }.isSuccess
                if (deleted) saved?.let(journal::clearIf)
                if (epoch != captured || current() !== session) return@withLock
                try { withTimeout(5_000) { if (session != null && saved != null && saved.wallet == session.wallet) retire(session, saved) } }
                catch (_: Exception) { /* Server logout independently retires this account's subscriptions. */ }
            }
        }
    }
    companion object { const val PATH = "/native/notifications/v1" }
}
