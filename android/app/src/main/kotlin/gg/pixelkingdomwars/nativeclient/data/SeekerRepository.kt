package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.session.*
import gg.pixelkingdomwars.nativeclient.wallet.*
import java.time.Instant
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

data class SeekerBounds(val recheckHours: Long, val challengeMinutes: Long) {
    companion object { fun from(catalogue: JsonObject?): SeekerBounds? = runCatching {
        val c = catalogue!!.getValue("constants").jsonObject.getValue("SEEKER").jsonObject
        SeekerBounds(c.getValue("recheckHours").jsonPrimitive.long, c.getValue("linkChallengeTtlMin").jsonPrimitive.long)
            .also { require(it.recheckHours > 0 && it.challengeMinutes > 0) }
    }.getOrNull() }
}
@Serializable data class SeekerIdentityStatus(val linked: Boolean, val seekerWallet: String?, val sgtMint: String?,
    val memberNumber: Long?, val skrDomain: String?, val verifiedAt: String?, val stale: Boolean,
    val verificationSources: Int, val unconfirmed: Boolean) {
    val verified get() = linked && !stale && verifiedAt != null
    companion object {
        // HTTP wire constraint in auth/routes.ts, not an economic/gameplay constant.
        const val DOMAIN_MAX = 70
        private val json = Json { ignoreUnknownKeys = true }
        fun from(raw: JsonObject) = json.decodeFromJsonElement<SeekerIdentityStatus>(raw).also {
            require(it.verificationSources >= 0 && (it.memberNumber == null || it.memberNumber in 0..9_007_199_254_740_991L))
            require(it.skrDomain == null || it.skrDomain.length <= DOMAIN_MAX && it.skrDomain.endsWith(".skr"))
            it.verifiedAt?.let(Instant::parse)
            if (it.linked) require(SeekerLinkContract.validWallet(requireNotNull(it.seekerWallet)) && SeekerLinkContract.validWallet(requireNotNull(it.sgtMint)) && it.verifiedAt != null)
            else require(it.seekerWallet == null && it.sgtMint == null && it.memberNumber == null && it.skrDomain == null && it.verifiedAt == null && !it.stale)
        }
    }
}
/** Only an action label is durable. Challenge, signature and auxiliary authorization are never stored. */
class SeekerJournal(private val store: SecretStore, private val wallet: String, private val origin: String) {
    constructor(store: SecretStore, session: AccountSession): this(store, session.wallet, session.origin)
    fun read(): String? = store.read()?.let { value -> Json.parseToJsonElement(value).jsonObject.let {
        check(it.string("wallet") == wallet && it.string("origin") == origin)
        requireNotNull(it.string("action")).also { action -> require(action in setOf("link", "unlink", "domain")) }
    } }
    fun begin(action: String) { check(read() == null); store.write(jsonBody("wallet" to wallet, "origin" to origin, "action" to action).toString()) }
    fun clear() = store.clear()
}
data class SeekerState(val status: SeekerIdentityStatus? = null, val busy: Boolean = false, val loaded: Boolean = false,
    val pending: String? = null, val error: String? = null, val notice: String? = null)

class SeekerRepository(private val session: AccountSession, private val holder: AccountSessionHolder, private val api: ApiClient,
    private val journal: SeekerJournal, private val bounds: () -> SeekerBounds?, private val hydrate: suspend () -> Unit) {
    private val mutable = MutableStateFlow(SeekerState()); val state = mutable.asStateFlow()
    private val admission = Mutex()
    val interaction = SeekerInteraction()
    private var interactionVersion = 0L
    private suspend fun current() { currentCoroutineContext().ensureActive(); holder.requireCurrent(session); interaction.checkCurrent(interactionVersion) }
    private suspend fun action(block: suspend () -> Unit) {
        if (!admission.tryLock()) return
        try { interactionVersion = interaction.begin(); current() } catch (error: Exception) { admission.unlock(); throw error }
        mutable.update { it.copy(busy = true, error = null, notice = null) }
        try { mutable.update { it.copy(pending = journal.read()) }; block() }
        catch (e: CancellationException) { throw e }
        catch (e: Exception) { current(); mutable.update { it.copy(error = e.message ?: "Seeker status is unavailable. Check again.") } }
        finally { admission.unlock(); if (holder.isCurrent(session)) mutable.update { it.copy(busy = false) } }
    }
    private fun decode(raw: JsonObject): SeekerIdentityStatus = try { SeekerIdentityStatus.from(raw) } catch (_: Exception) { throw ApiCompatibilityException("/seeker/status") }
    private suspend fun refreshed(recheck: Boolean = false) {
        val raw = api.get("/seeker/status", if (recheck) mapOf("refresh" to "1") else emptyMap()); current()
        val status = decode(raw)
        hydrate(); current()
        val interrupted = journal.read() != null
        journal.clear()
        mutable.update { it.copy(status = status, loaded = true, pending = null,
            notice = if (interrupted) "Current server status refreshed. The saved action was not resubmitted." else null) }
    }
    suspend fun refresh(recheck: Boolean = false) = action { refreshed(recheck) }
    private fun ready() {
        check(mutable.value.loaded && journal.read() == null) { "Check current Seeker status before another action." }
    }
    suspend fun link(wallet: SeekerProofWallet, domain: String) = action {
        ready(); check(mutable.value.status?.linked == false) { "This account already has a Seeker link." }
        val cfg = requireNotNull(bounds()) { "Update game content before linking." }
        val name = domain.trim(); require(name.length <= SeekerIdentityStatus.DOMAIN_MAX)
        var candidate: String? = null
        val proof = interaction.withWallet(interactionVersion) { wallet.prove({ selected ->
            current(); require(candidate == null && SeekerLinkContract.validWallet(selected)); candidate = selected
            val challenge = api.post("/seeker/link/challenge", jsonBody("seekerWallet" to selected)); current()
            SeekerLinkContract.message(session.origin, session.wallet, selected, requireNotNull(challenge.string("nonce")),
                requireNotNull(challenge.string("message")), requireNotNull(challenge.string("expiresAt")), cfg.challengeMinutes)
        }, { holder.requireCurrent(session); interaction.checkCurrent(interactionVersion) }) }
        current(); require(proof.wallet == candidate && proof.signature.size == 64)
        journal.begin("link"); mutable.update { it.copy(pending = "link") }
        val raw = api.post("/seeker/link/verify", buildJsonObject {
            put("seekerWallet", proof.wallet); put("signature", base58(proof.signature)); if (name.isNotEmpty()) put("skrDomain", name)
        }); current()
        val accepted = decode(raw.getValue("seeker").jsonObject)
        require(accepted.linked && accepted.seekerWallet == candidate) { "The server returned a different Seeker link. Check current status." }
        refreshed()
    }
    suspend fun unlink() = action {
        ready(); check(mutable.value.status?.linked == true)
        journal.begin("unlink"); mutable.update { it.copy(pending = "unlink") }
        val raw = api.delete("/seeker/link"); current(); require(raw["ok"] == JsonPrimitive(true))
        refreshed()
    }
    suspend fun adoptDomain() = action {
        ready(); val original = requireNotNull(mutable.value.status)
        check(original.linked && original.skrDomain == null)
        journal.begin("domain"); mutable.update { it.copy(pending = "domain") }
        val raw = api.post("/seeker/skr/adopt"); current()
        val status = decode(raw.getValue("seeker").jsonObject)
        require(status.linked && status.seekerWallet == original.seekerWallet && status.sgtMint == original.sgtMint)
        refreshed()
    }
}
