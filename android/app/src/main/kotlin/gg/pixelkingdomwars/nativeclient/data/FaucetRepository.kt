package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.session.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.serialization.json.*
import java.util.UUID

data class FaucetBounds(val pollMs: Long) {
    init { require(pollMs > 0) }
    companion object { fun from(catalogue: JsonObject?): FaucetBounds? = runCatching {
        // Match canonical worker cadence for foreground status checks; no client eligibility clock.
        val policy = catalogue?.get("constants")?.jsonObject?.get("DEVNET_FAUCET")?.jsonObject ?: return null
        FaucetBounds(policy.getValue("pollMs").jsonPrimitive.long)
    }.getOrNull() }
}
/** No client-key API exists here. Save uncertainty before POST and the server ID when it answers. */
class FaucetJournal(private val store: SecretStore, private val wallet: String, private val origin: String, private val cluster: String) {
    fun read(): JsonObject? = store.read()?.let { Json.parseToJsonElement(it).jsonObject.also { r ->
        require(r.string("wallet") == wallet && r.string("origin") == origin && r.string("cluster") == cluster)
        UUID.fromString(requireNotNull(r.string("attempt")))
        require(r.containsKey("grant") && (r["grant"] == JsonNull || r["grant"] is JsonObject))
        (r["grant"] as? JsonObject)?.let(DevnetGrant::from)
    } }
    fun save(attempt: String, grant: DevnetGrant? = null) = store.write(buildJsonObject {
        put("wallet", wallet); put("origin", origin); put("cluster", cluster); put("attempt", attempt)
        put("grant", grant?.raw ?: JsonNull)
    }.toString())
    fun clear() = store.clear()
    fun restore(previous: JsonObject?) { if (previous == null) clear() else store.write(previous.toString()) }
}
data class FaucetState(val status: DevnetFaucetStatus? = null, val saved: DevnetGrant? = null, val uncertain: Boolean = false,
    val busy: Boolean = false, val error: String? = null, val arrival: DevnetGrant? = null, val available: Boolean = false)

class FaucetRepository(private val session: AccountSession, private val holder: AccountSessionHolder, private val api: ApiClient,
    private val journal: FaucetJournal, private val cluster: String, private val bounds: () -> FaucetBounds?,
    private val refreshWallet: suspend () -> Unit) {
    private val mutable = MutableStateFlow(FaucetState(available = cluster == "devnet"))
    val state = mutable.asStateFlow()
    private val admission = Mutex()
    private var autoAttempted = false
    private val announced = mutableSetOf<String>()
    private fun current() = holder.requireCurrent(session)
    private suspend fun action(block: suspend () -> Unit) {
        current(); if (!admission.tryLock()) return
        mutable.update { it.copy(busy = true, error = null) }
        try {
            val saved = journal.read(); current()
            mutable.update { it.copy(uncertain = saved != null && saved["grant"] == JsonNull,
                saved = (saved?.get("grant") as? JsonObject)?.let(DevnetGrant::from)) }
            if (cluster != "devnet") return
            block()
        } catch (error: CancellationException) { throw error }
        catch (error: Exception) { current(); mutable.update { it.copy(error = error.message ?: "Faucet status is unavailable. Check again.") } }
        finally { admission.unlock(); if (holder.isCurrent(session)) mutable.update { it.copy(busy = false) } }
    }
    private suspend fun readStatus(): DevnetFaucetStatus {
        val raw = api.get("/devnet-faucet/status"); current()
        val status = try { DevnetFaucetStatus.from(raw) } catch (_: Exception) { throw ApiCompatibilityException("/devnet-faucet/status") }
        mutable.update { it.copy(status = status) }
        val saved = journal.read(); val expected = (saved?.get("grant") as? JsonObject)?.let(DevnetGrant::from)
        if (expected != null && status.last?.id == expected.id) {
            val fresh = requireNotNull(status.last)
            require(fresh.lamports == expected.lamports && fresh.requestedAt == expected.requestedAt) { "Grant identity changed." }
            journal.save(requireNotNull(saved.string("attempt")), fresh)
            mutable.update { it.copy(saved = fresh) }
            if (fresh.status != "requested") {
                refreshWallet(); current(); journal.clear()
                mutable.update { it.copy(saved = null, uncertain = false, arrival = if (fresh.status == "sent" && announced.add(fresh.id)) fresh else it.arrival) }
            }
        }
        return status
    }
    suspend fun refresh() = action { readStatus() }
    /** Screen remounts and concurrent surfaces share this one session repository. */
    suspend fun automatic() = action {
        if (autoAttempted) { readStatus(); return@action }
        autoAttempted = true
        val saved = journal.read()
        val status = readStatus()
        if (saved == null && status.eligible) sendClaim()
    }
    suspend fun claim() = action {
        autoAttempted = true
        val status = readStatus()
        check(status.enabled && status.eligible) { "The server does not currently allow another grant. Refresh for its current status." }
        sendClaim()
    }
    private suspend fun sendClaim() {
        current(); check(bounds() != null) { "Faucet support requires the current content pack." }
        val previous = journal.read()
        val attempt = UUID.randomUUID().toString()
        journal.save(attempt); mutable.update { it.copy(saved = null, uncertain = true, arrival = null) }
        try {
            val raw = api.post("/devnet-faucet/claim", buildJsonObject {}); current()
            val grant = DevnetGrant.from(raw.getValue("grant").jsonObject)
            val status = DevnetFaucetStatus.from(raw.getValue("status").jsonObject)
            require(grant.status == "requested" && status.last == grant && !status.eligible && status.reason == "pending") { "Unexpected faucet acknowledgement." }
            journal.save(attempt, grant); mutable.update { it.copy(saved = grant, uncertain = false, status = status) }
        } catch (error: CancellationException) { throw error }
        catch (error: Exception) {
            current()
            if (error is ApiException && error.code == "FAUCET_NOT_ELIGIBLE") {
                // This POST queued nothing. Preserve any earlier unknown request, then
                // resume the server's existing grant without treating the refusal as proof.
                journal.restore(previous)
                mutable.update { it.copy(uncertain = previous != null && previous["grant"] == JsonNull,
                    saved = (previous?.get("grant") as? JsonObject)?.let(DevnetGrant::from)) }
                readStatus(); return
            }
            // Recovery displays wallet grant state without claiming causal acceptance.
            runCatching { readStatus() }.onFailure { if (it is CancellationException) throw it }
            throw error
        }
    }
    suspend fun foreground(auto: Boolean) {
        if (auto) automatic() else refresh()
        if (cluster != "devnet") return
        while (currentCoroutineContext().isActive) {
            val poll = bounds()?.pollMs ?: return
            delay(poll); refresh()
        }
    }
    fun dismissArrival() { current(); mutable.update { it.copy(arrival = null) } }
    fun dismissError() { mutable.update { it.copy(error = null) } }
}
