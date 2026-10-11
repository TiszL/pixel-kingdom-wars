package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.ops.*
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.session.AccountSessionHolder
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.serialization.json.*

data class ClanChangeReceipt(val clanId: String, val target: String?, val disbanded: Boolean, val command: ClanCommandReceipt? = null)
/** Legacy journals retain their original protocol. V1 alone can recover exact immutable outcomes. */
class ClanChangeSpec(override val kind: String, cluster: String) : MoneyOpSpec<ClanChangeReceipt> {
    val versioned = ClanCommandSpec(kind, cluster)
    private fun value(r: ClanCommandReceipt) = ClanChangeReceipt(r.clanId, r.target, r.state == "disbanded", r)
    private fun isVersioned(intent: PendingIntent) = intent.path == versioned.path
    init { require(kind == IntentKind.CLAN_LEAVE || kind == IntentKind.CLAN_KICK) }
    /** V1 commands: the by-key status answers `receipt: null` for this exact key. A legacy request never sent a server key,
     * so nothing can ever read or retry it: it no longer refuses a new clan change (dead-end audit 2026-10-06). */
    override val savedRequestExit = SavedRequestExit.FORGET_AFTER_SERVER_ABSENT
    override fun forgetsOnServerAbsent(intent: PendingIntent) = isVersioned(intent)
    override fun supersededByNewOrder(intent: PendingIntent) = !isVersioned(intent)
    override fun receiptRequest(intent: PendingIntent): ReceiptRequest? = if (isVersioned(intent)) versioned.receiptRequest(intent) else null
    override fun decodeReceipt(intent: PendingIntent, response: JsonObject): Receipt<ClanChangeReceipt> {
        if (!isVersioned(intent)) return Receipt.Unsupported
        return when (val r = versioned.decodeReceipt(intent, response)) {
            is Receipt.Accepted -> Receipt.Accepted(value(r.value), r.document)
            Receipt.Unknown -> Receipt.Unknown
            else -> error("Unexpected clan command observation")
        }
    }
    override fun acknowledge(intent: PendingIntent, response: JsonObject): ClanChangeReceipt {
        if (isVersioned(intent)) return value(versioned.acknowledge(intent, response))
        val quote = requireNotNull(intent.quote)
        val clan = requireNotNull(quote.string("clanId")); require(UUID.fromString(clan).toString() == clan.lowercase())
        val target = quote.string("target")
        if (kind == IntentKind.CLAN_LEAVE) {
            require(intent.path == "/clans/leave" && response["left"] == JsonPrimitive(true) && target == null)
            require(intent.body.string("baseId") == intent.baseId && intent.baseId != null)
        } else require(intent.path == "/clans/kick" && target != null && response.string("kicked") == target && intent.body.string("wallet") == target)
        val disbanded = response["disbanded"]?.let { requireNotNull((it as? JsonPrimitive)?.takeUnless { value -> value.isString }?.booleanOrNull) } ?: false
        return ClanChangeReceipt(clan, target, disbanded)
    }
    override fun restore(intent: PendingIntent, document: JsonObject): ClanChangeReceipt {
        if (isVersioned(intent)) return value(versioned.restore(intent, document))
        require(ReceiptDocument.source(document) == ReceiptDocument.SOURCE_POST)
        return acknowledge(intent, ReceiptDocument.payload(document))
    }
}

data class ClanReview(val clanId: String, val clanName: String, val baseId: String?, val target: String?, val epoch: Long)
/** A refreshed balance is display data; the immutable command alone proves the payout. */
data class ClanPayoutRefresh(val baseId: String?, val balances: Balances?, val unavailable: String?)
data class ClansState(val membership: ClanMembership? = null, val board: ClanBoard? = null,
    val pending: List<PendingIntent> = emptyList(), val busy: Boolean = false, val supported: Boolean = false,
    /** The saved changes that still refuse a new one (owner 2026-10-06: a legacy request nothing can resolve never does). */
    val blocking: List<PendingIntent> = emptyList(),
    val review: ClanReview? = null, val receipt: ClanCommandReceipt? = null, val payout: ClanPayoutRefresh? = null,
    val notice: String? = null,
    /** Per kind, the saved v1 key that offers CLOSE (owner review 2026-10-06: never sent, or a settled server `absent` answer;
     * `unknown` only stops it blocking). A legacy request reads
     * Unsupported, never `unknown`, so it is never listed here (it never blocks: ClanChangeSpec.supersededByNewOrder). */
    val serverUnknownKeys: Map<String, String> = emptyMap())

class LiveClansRepository(private val session: AccountSession, private val holder: AccountSessionHolder, private val api: ApiClient,
    private val store: PendingIntentStore, private val observer: ReceiptObserver, private val selectedBaseId: () -> String?,
    private val refreshBase: suspend () -> Unit, cluster: String, private val directory: () -> BaseDirectory?,
    private val landOwned: () -> Boolean, private val refreshAccount: suspend () -> Unit) {
    private val mutable = MutableStateFlow(ClansState())
    val state = mutable.asStateFlow()
    private val admission = Mutex()
    private var epoch = 0L
    private var actionEpoch: Long? = null
    private var permittedKey: String? = null
    private fun current() = holder.requireCurrent(session)
    private suspend fun guard() {
        currentCoroutineContext().ensureActive(); current()
        check(actionEpoch == null || actionEpoch == epoch) { "Review the clan action again after returning to this screen." }
    }
    fun dismiss() { epoch++; if (holder.isCurrent(session)) mutable.update { it.copy(review = null) } }
    private suspend fun <T> bounded(read: suspend () -> T): T { guard(); return read().also { guard() } }
    private val transport = object : OpTransport {
        override suspend fun get(path: String, query: Map<String, String>) = bounded { api.get(path, query) }
        override suspend fun post(path: String, body: JsonObject): JsonObject {
            check(actionEpoch != null) { "Open Clans to explicitly retry the saved request." }; guard()
            require(path == "/clans/v1/leave" || path == "/clans/v1/kick") { "A legacy clan request cannot be repeated." }
            require(permittedKey != null && body.string("idempotencyKey") == permittedKey) { "This clan request needs explicit confirmation." }
            return bounded { api.post(path, body) }
        }
    }
    private val leaveSpec = ClanChangeSpec(IntentKind.CLAN_LEAVE, cluster)
    private val kickSpec = ClanChangeSpec(IntentKind.CLAN_KICK, cluster)
    private val leaveOp = MoneyOp(leaveSpec, store, transport)
    private val kickOp = MoneyOp(kickSpec, store, transport)
    init { observer.register(leaveOp, ::hydrate); observer.register(kickOp, ::hydrate) }
    private suspend fun <T> action(block: suspend () -> T): T {
        current(); check(admission.tryLock()) { "A clan request is already in progress" }
        actionEpoch = epoch; mutable.update { it.copy(busy = true) }
        try { guard(); return block() } finally {
            actionEpoch = null; permittedKey = null
            try { if (holder.isCurrent(session)) {
                observer.refresh(session.wallet); current()
                mutable.update { it.copy(pending = listOfNotNull(leaveOp.pending(session.wallet), kickOp.pending(session.wallet)),
                    blocking = listOfNotNull(leaveOp.blocking(session.wallet), kickOp.blocking(session.wallet))) }
            } } finally { if (holder.isCurrent(session)) mutable.update { it.copy(busy = false) }; admission.unlock() }
        }
    }
    private suspend fun membership(): ClanMembership {
        val raw = bounded { api.get("/clans/mine") }
        return try { ClanMembership.from(raw).also { require(it.clan == null || it.clan?.roster?.any { member -> member.wallet == session.wallet } == true) } }
        catch (_: Exception) { throw ApiCompatibilityException("/clans/mine") }
    }
    private suspend fun browse() {
        if (!landOwned()) { mutable.update { it.copy(membership = null, board = null) }; return }
        val mine = membership(); val raw = bounded { api.get("/clans") }
        val board = try { ClanBoard.from(raw) } catch (_: Exception) { throw ApiCompatibilityException("/clans") }
        mutable.update { it.copy(membership = mine, board = board) }
    }
    private suspend fun supported(): Boolean {
        mutable.update { it.copy(supported = false) }
        val key = UUID.randomUUID().toString()
        val raw = try { bounded { api.get("/clans/v1/commands/$key") } }
        catch (error: ApiException) { guard(); if (error.status == 404) return false else throw error }
        val status = ClanCommandStatus.from(raw)
        require(status.wallet == session.wallet && status.idempotencyKey == key && status.receipt == null)
        mutable.update { it.copy(supported = true) }; return true
    }
    suspend fun refresh() = action { checkSaved(); bounded { refreshAccount() }; browse(); supported(); Unit }
    // Owner 2026-10-06: a legacy request nothing can resolve no longer refuses a change (MoneyOp.blocking); a new one parks it.
    private fun noUnknown() { check(leaveOp.blocking(session.wallet) == null && kickOp.blocking(session.wallet) == null) {
        "The last clan change has not been confirmed. Check it before making another change." } }
    private suspend fun review(clanId: String, baseId: String?, target: String?) = action {
        noUnknown(); val captured = epoch
        bounded { refreshAccount() }; check(landOwned()) { "A Land Deed is required for new clan management." }
        check(supported()) { "Clan management needs the server update. Existing standings remain available." }
        val clan = requireNotNull(membership().clan) { "You are no longer in this clan." }
        require(clan.id == clanId) { "Your clan changed. Review its current membership." }
        if (target == null) {
            val dir = requireNotNull(directory())
            if (dir.enabled) {
                check(dir.stableMutations && baseId != null && baseId == selectedBaseId() && dir.bases.any { it.id == baseId && it.selectable }) { "Review the original payout deed again." }
            } else require(baseId == null) { "This server pays the wallet balance; review it again." }
            check(clan.leaderWallet != session.wallet || clan.roster.size == 1) { "The leader leaves last. Remove other members first." }
        } else require(clan.leaderWallet == session.wallet && target != session.wallet && clan.roster.any { it.wallet == target }) {
            "That player is not a removable member of your clan." }
        guard(); mutable.update { it.copy(review = ClanReview(clanId, clan.name, baseId, target, captured)) }
    }
    suspend fun reviewLeave(clanId: String, baseId: String?) = review(clanId, baseId, null)
    suspend fun reviewKick(clanId: String, target: String) = review(clanId, null, target)
    suspend fun confirm(review: ClanReview) = action {
        require(mutable.value.review == review && review.epoch == epoch); noUnknown()
        bounded { refreshAccount() }; check(landOwned()) { "A Land Deed is required for new clan management." }
        check(supported()) { "Clan management requires the server update." }
        val dir = requireNotNull(directory())
        if (review.target == null) check(if (dir.enabled) dir.stableMutations && review.baseId != null && review.baseId == selectedBaseId()
            && dir.bases.any { it.id == review.baseId && it.selectable } else review.baseId == null) { "The payout base changed. Review again." }
        val clan = requireNotNull(membership().clan) { "Your clan changed. Review again." }
        require(clan.id == review.clanId)
        if (review.target == null) check(clan.leaderWallet != session.wallet || clan.roster.size == 1) { "The leader leaves last." }
        else require(clan.leaderWallet == session.wallet && review.target != session.wallet && clan.roster.any { it.wallet == review.target })
        guard(); require(review.epoch == epoch)
        val spec = if (review.target == null) leaveSpec else kickSpec
        val op = if (review.target == null) leaveOp else kickOp
        val intent = spec.versioned.intent(session.wallet, UUID.randomUUID().toString(), review.clanId, review.clanName, review.baseId, review.target)
        mutable.update { it.copy(review = null) }; permittedKey = intent.idempotencyKey; op.submit(intent, ::hydrate); Unit
    }
    private suspend fun checkSaved() {
        val leave = leaveOp.observe(session.wallet, ::hydrate); val kick = kickOp.observe(session.wallet, ::hydrate)
        val unknown = listOfNotNull(leaveOp.pending(session.wallet)?.takeIf { leave != null && leaveOp.closable(session.wallet) },
            kickOp.pending(session.wallet)?.takeIf { kick != null && kickOp.closable(session.wallet) })
        mutable.update { it.copy(serverUnknownKeys = unknown.associate { saved -> saved.kind to saved.idempotencyKey }) }
        if (leave == Receipt.Unsupported || kick == Receipt.Unsupported) mutable.update { it.copy(notice =
            "The saved clan change is unconfirmed. Current membership cannot prove its outcome or chest payout. Its original request is retained.") }
    }
    suspend fun checkChanges() = action { checkSaved() }
    suspend fun retry(kind: String) = action {
        val op = when (kind) { IntentKind.CLAN_LEAVE -> leaveOp; IntentKind.CLAN_KICK -> kickOp; else -> error("Unknown clan action") }
        val spec = if (kind == IntentKind.CLAN_LEAVE) leaveSpec else kickSpec
        val saved = requireNotNull(op.pending(session.wallet)); spec.versioned.validate(saved)
        if (op.observe(session.wallet, ::hydrate).let { it != Receipt.Unknown && it != Receipt.Absent }) return@action
        bounded { refreshAccount() }; check(landOwned()) { "The original request remains saved. A Land Deed is required to retry it." }
        val dir = requireNotNull(directory())
        if (kind == IntentKind.CLAN_LEAVE) check(if (dir.enabled) saved.baseId != null && dir.stableMutations && dir.bases.any { it.id == saved.baseId && it.selectable }
            else saved.baseId == null) { "The original payout deed is unavailable. Check the saved receipt; this request cannot change destination." }
        guard(); permittedKey = saved.idempotencyKey; op.retry(session.wallet, ::hydrate); Unit
    }
    /** The saved change's CLOSE (owner 2026-10-06): the existing MoneyOp closure. It reads the by-key status once more; an
     * acceptance found there is hydrated as usual, and only a settled server `absent` answer for this exact v1 key archives it on this device (re-read on every Home resume).
     * No POST. A sent legacy request is never closed here (it reads Unsupported and stays saved; it no longer blocks). */
    suspend fun close(kind: String): Receipt<*>? = action {
        val op = when (kind) { IntentKind.CLAN_LEAVE -> leaveOp; IntentKind.CLAN_KICK -> kickOp; else -> error("Unknown clan action") }
        op.close(session.wallet, confirmed = true, ::hydrate).also { mutable.update { state -> state.copy(serverUnknownKeys = state.serverUnknownKeys - kind) } }
    }
    private suspend fun hydrate(receipt: Receipt.Accepted<ClanChangeReceipt>) {
        guard(); val value = receipt.value; val proof = value.command
        if (proof == null) {
            val mine = membership()
            val intent = if (value.target == null) leaveOp.pending(session.wallet) else kickOp.pending(session.wallet)
            if (intent?.baseId != null && intent.baseId == selectedBaseId()) bounded { refreshBase() }
            mutable.update { it.copy(membership = mine, notice = when {
                value.target != null -> "The server confirmed removal of the selected member."
                value.disbanded -> "The server confirmed that the clan was dissolved. Any chest payout belongs to the saved base; this old reply does not report its amount."
                else -> "The server confirmed that you left the clan."
            }) }; return
        }
        bounded { refreshAccount() }; browse()
        val dir = requireNotNull(directory()) { "Refresh the deed directory before finishing this clan action." }
        val payout = if (proof.state == "disbanded" && proof.payoutShards != "0") {
            val original = proof.baseId?.let { id -> dir.bases.firstOrNull { it.id == id } }
            val unavailable = when {
                proof.baseId == null && dir.enabled -> "The original payout was to wallet SHARDS; current balance reads use deeds."
                proof.baseId != null && !dir.enabled -> "This server cannot refresh the original deed balance."
                proof.baseId != null && original == null -> "The original payout deed is no longer in your fresh deed directory."
                proof.baseId != null && original?.selectable != true -> "The original payout deed is inactive; its live balance is unavailable."
                else -> null
            }
            val balances = if (unavailable == null) Balances.from(bounded { api.get("/balances", proof.baseId?.let { mapOf("baseId" to it) }.orEmpty()) }) else null
            check(directory() == dir) { "Deed ownership changed during the payout refresh. Check the original receipt again." }
            ClanPayoutRefresh(proof.baseId, balances, unavailable)
        } else null
        guard(); mutable.update { it.copy(receipt = proof, payout = payout, notice = when (proof.state) {
            "refused" -> "The server refused this original clan action: ${proof.refusalCode}. No effect or payout was recorded."
            "kicked" -> "The server confirmed removal of ${proof.target} from the original clan."
            "left" -> "The server confirmed that you left the original clan. No chest payout was recorded."
            else -> "The server confirmed dissolution and ${proof.payoutShards} SHARDS to ${proof.baseId ?: "the original wallet balance"}."
        }) }
    }
}
