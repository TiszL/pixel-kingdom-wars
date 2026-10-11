package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.AppGraph
import gg.pixelkingdomwars.nativeclient.SessionGraph
import gg.pixelkingdomwars.nativeclient.network.SessionSupersededException
import gg.pixelkingdomwars.nativeclient.seeker.*
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.session.AccountSessionHolder
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.*
import okhttp3.HttpUrl.Companion.toHttpUrl

/** Current grammar comes from admitted canonical content, never an API claim or saved receipt. */
fun seekerShardsClaimsPolicy(catalogue: JsonObject?): SeekerShardsClaimsPolicy? = runCatching {
    val island = requireNotNull(catalogue).getValue("constants").jsonObject.getValue("PHASE_E_POLICY").jsonObject.getValue("seekerIsland").jsonObject
    SeekerShardsClaimsPolicy.from(buildJsonObject { put("totalSpots", island.getValue("totalSpots")); put("operatingTermSec", island.getValue("operatingTermSec")) })
}.getOrNull()

data class SeekerShardsLifecycle(val active: Boolean, val visible: Boolean, val epoch: Long, val actionsAllowed: Boolean, val contentReady: Boolean, val contentIdentity: String?)
class SeekerShardsViewLifetime {
    private var active = false; private var visible = false; private var disposed = false; private var epoch = 0L
    fun start() { if (!disposed) active = true }
    fun stop() { active = false; invalidate() }
    fun setOpen(value: Boolean) { if (visible != value) { visible = value; invalidate() } }
    fun invalidate() { epoch++ }
    fun dispose() { disposed = true; stop() }
    fun snapshot(orders: Boolean, ready: Boolean, contentIdentity: String? = null) = SeekerShardsLifecycle(active && !disposed, visible, epoch, orders, ready, contentIdentity)
}

/** Exact existing cookie owner and actor, plus a fresh lifecycle guard at every enqueue.
 * Hidden foreground discovery only reads; POST requires the currently open consent view. */
class SeekerShardsClaimsAppPort(private val session: AccountSession, private val holder: AccountSessionHolder, cluster: String,
    private val store: SeekerShardsClaimStore, private val http: SeekerShardsClaimsHttpPort,
    private val catalogue: () -> JsonObject?, private val lifecycle: () -> SeekerShardsLifecycle) : SeekerShardsClaimPort {
    @Volatile private var retired = false
    init {
        require(store.identity.wallet == session.wallet && store.identity.cluster == cluster && store.identity.origin == session.origin.toHttpUrl().toString().trimEnd('/'))
        holder.requireCurrent(session); http.requireCurrent(store.identity, session.token)
    }
    fun capture(post: Boolean, original: () -> Unit): () -> Unit {
        val before = lifecycle()
        val guard = {
            check(!retired); holder.requireCurrent(session); http.requireCurrent(store.identity, session.token); original()
            val now = lifecycle(); check(now.active && now.epoch == before.epoch) { "The claim view changed. Check its saved receipt." }
            if (post) check(now.visible && now.actionsAllowed && now.contentReady && now.contentIdentity == before.contentIdentity && seekerShardsClaimsPolicy(catalogue()) == store.policy) {
                "New claims are unavailable. Your saved receipt remains available."
            }
        }
        guard(); return guard
    }
    fun actionsAllowed(): Boolean = runCatching { capture(true) {} () }.isSuccess
    fun retire() { retired = true }
    override suspend fun get(path: String, query: Map<String, String>, guard: () -> Unit, retain: (JsonObject) -> Unit) =
        http.get(path, query, capture(false, guard), retain)
    override suspend fun post(body: JsonObject, guard: () -> Unit, retain: (JsonObject) -> Unit) =
        http.post(body, capture(true, guard), retain)
}
class SeekerShardsClaimsBinding(val repository: SeekerShardsClaimsRepository, private val port: SeekerShardsClaimsAppPort) {
    suspend fun close() {
        port.retire(); repository.dismiss()
        withContext(NonCancellable) { try { repository.awaitIdle() } catch (_: SessionSupersededException) { /* The old request drained before this check. */ } }
    }
}

/** Source-only app composition: all balance publication uses the selected-base guard. */
fun AppGraph.seekerShardsClaimsClient(session: SessionGraph, lifecycle: () -> SeekerShardsLifecycle): SeekerShardsClaimsBinding {
    holder.requireCurrent(session.session); gameApi.requireCurrentSession(session.session.token)
    val policy = requireNotNull(seekerShardsClaimsPolicy(content.state.value.catalogue)) { "SHARDS claim content is unavailable. Saved claims are preserved." }
    val store = seekerShardsClaimStore(session, policy)
    val port = SeekerShardsClaimsAppPort(session.session, holder, cluster.id, store,
        gameApi.seekerShardsClaimsPort(store.identity, session.session.token, store.policy), { content.state.value.catalogue }, lifecycle)
    val repository = SeekerShardsClaimsRepository(session.session, holder, port, store,
        { account.state.value.selectedBaseId }, { account.state.value.baseSelectionGeneration }, { account.state.value.directory },
        { account.refreshIdentity(); holder.requireCurrent(session.session); account.refreshDirectory() }, { guard ->
            val original = requireNotNull(account.state.value.selectedBaseId); guard()
            requireNotNull(session.base as? LiveBaseRepository) { "Live kingdom refresh is unavailable; keep the saved claim." }.refreshForWorkshop(guard); guard()
            val current = session.base.state.value
            check(current.error == null && current.base?.baseId == original && current.balances != null) {
                "Claim accepted. Refresh the original kingdom before keeping its receipt."
            }
        }, port::actionsAllowed)
    return SeekerShardsClaimsBinding(repository, port)
}
