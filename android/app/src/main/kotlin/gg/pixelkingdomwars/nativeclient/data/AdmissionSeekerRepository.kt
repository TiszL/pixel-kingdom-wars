package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.wallet.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.serialization.json.*

/** Pre-alpha uses only the canonical cookie-authenticated admission/link routes.
 * Neither a badge nor a local phase can substitute for the server's admitted verdict. */
class AdmissionSeekerRepository(private val admission: PendingAdmission, private val origin: String,
    private val api: ApiClient, private val journal: SeekerJournal, private val bounds: () -> SeekerBounds?,
    private val requireCurrent: () -> Unit, private val enter: suspend () -> Unit) {
    private val mutable = MutableStateFlow(SeekerState(status = admission.seeker))
    val state = mutable.asStateFlow()
    private val mutex = Mutex()
    val interaction = SeekerInteraction()
    private var interactionVersion = 0L
    private suspend fun current() { currentCoroutineContext().ensureActive(); requireCurrent(); interaction.checkCurrent(interactionVersion) }
    private suspend fun action(block: suspend () -> Unit) {
        if (!mutex.tryLock()) return
        try { interactionVersion = interaction.begin(); current() } catch (error: Exception) { mutex.unlock(); throw error }
        mutable.update { it.copy(busy = true, error = null) }
        try { mutable.update { it.copy(pending = journal.read()) }; block() }
        catch (error: CancellationException) { throw error }
        catch (error: Exception) { current(); mutable.update { it.copy(error = error.message ?: "Playtest access could not be checked.") } }
        finally { mutex.unlock(); if (runCatching(requireCurrent).isSuccess) mutable.update { it.copy(busy = false) } }
    }
    private suspend fun refreshCurrent() {
        val raw = api.post("/alpha/seeker"); current()
        require(raw.string("wallet") == admission.wallet) { "The playtest account changed." }
        require(raw["admitted"] == JsonPrimitive(true) || raw["admitted"] == JsonPrimitive(false))
        val status = SeekerIdentityStatus.from(raw.getValue("seeker").jsonObject)
        if (raw["admitted"] == JsonPrimitive(true)) {
            // Keep interrupted state until /me and the normal account bootstrap succeed.
            enter()
            // enter intentionally ends this pre-admission epoch. Its replacement owns the UI.
            return
        }
        journal.clear()
        mutable.update { it.copy(status = status, loaded = true, pending = null,
            notice = "The server has not admitted this game wallet yet. A linked token alone does not override playtest access.") }
    }
    suspend fun refresh() = action { refreshCurrent() }
    suspend fun link(wallet: SeekerProofWallet, domain: String) = action {
        check(mutable.value.loaded && journal.read() == null) { "Check current access before linking." }
        check(mutable.value.status?.linked == false) { "This token is already linked. Check access or contact support." }
        val limits = requireNotNull(bounds()) { "Update game content before linking." }
        val name = domain.trim(); require(name.length <= SeekerIdentityStatus.DOMAIN_MAX)
        var candidate: String? = null
        val proof = interaction.withWallet(interactionVersion) { wallet.prove({ selected ->
            current(); require(candidate == null && SeekerLinkContract.validWallet(selected)); candidate = selected
            val challenge = api.post("/seeker/link/challenge", jsonBody("seekerWallet" to selected)); current()
            SeekerLinkContract.message(origin, admission.wallet, selected, requireNotNull(challenge.string("nonce")),
                requireNotNull(challenge.string("message")), requireNotNull(challenge.string("expiresAt")), limits.challengeMinutes)
        }, { requireCurrent(); interaction.checkCurrent(interactionVersion) }) }
        current(); require(proof.wallet == candidate && proof.signature.size == 64)
        journal.begin("link"); mutable.update { it.copy(pending = "link") }
        val raw = api.post("/seeker/link/verify", buildJsonObject {
            put("seekerWallet", proof.wallet); put("signature", base58(proof.signature)); if (name.isNotEmpty()) put("skrDomain", name)
        }); current()
        val status = SeekerIdentityStatus.from(raw.getValue("seeker").jsonObject)
        require(status.linked && status.seekerWallet == candidate)
        refreshCurrent()
    }
}
