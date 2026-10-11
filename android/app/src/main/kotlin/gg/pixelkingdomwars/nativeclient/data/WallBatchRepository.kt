package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.audio.BaseAudioAction
import gg.pixelkingdomwars.nativeclient.audio.UiAudioCue
import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.ops.*
import gg.pixelkingdomwars.nativeclient.renderer.WallStrokeMode
import gg.pixelkingdomwars.nativeclient.renderer.WallStrokeTile
import gg.pixelkingdomwars.nativeclient.scene.wallStrokeMode
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.session.AccountSessionHolder
import java.util.UUID
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.serialization.json.*

data class WallBatchDrawing(val mode: WallStrokeMode, val originalBaseId: String?, val base: BaseSnapshot,
    val terms: WallBatchTerms, val availableShards: String, val remaining: Int, val epoch: Long)
data class WallBatchState(val supported: Boolean = false, val enabled: Boolean = false, val busy: Boolean = false,
    val drawing: WallBatchDrawing? = null, val preview: List<WallStrokeTile> = emptyList(), val pending: PendingIntent? = null,
    val receipt: WallBatchReceipt? = null, val unavailable: String? = null, val receiptDismissed: Boolean = false,
    /** The saved key whose card offers CLOSE after a read (owner review 2026-10-06: never sent, or a settled server `absent`
     * answer for exactly this key; an `unknown` answer keeps it shown and only stops it blocking, [MoneyOp.closable]). */
    val serverUnknownKey: String? = null) {
    val historyVisible: Boolean get() = pending != null || receipt != null && !receiptDismissed
}

/** One release is one original ordered wall request. The renderer never owns transport or storage. */
class WallBatchRepository(private val session: AccountSession, private val holder: AccountSessionHolder,
    private val api: ApiClient, private val store: PendingIntentStore, private val observer: ReceiptObserver,
    private val selectedBaseId: () -> String?, private val directory: () -> BaseDirectory?,
    private val refreshAccount: suspend () -> Unit, private val catalogue: () -> JsonObject?, private val renderCatalogue: () -> JsonObject?,
    private val ordersAllowed: () -> Boolean, private val refreshSelected: suspend () -> Unit, cluster: String) {
    private val mutable = MutableStateFlow(WallBatchState()); val state = mutable.asStateFlow()
    private val admission = Mutex(); private var epoch = 0L; private var actionEpoch: Long? = null
    private var selected: String? = null; private var requireSelection = false; private var permittedKey: String? = null
    private var actionCatalogue: JsonObject? = null; private var actionRender: JsonObject? = null
    private val spec = WallBatchSpec(cluster)
    private suspend fun guard() {
        currentCoroutineContext().ensureActive(); holder.requireCurrent(session)
        check(actionEpoch == null || actionEpoch == epoch) { "Wall drawing was cancelled. Check any saved original batch." }
        check(!requireSelection || selected == selectedBaseId()) { "The selected base changed. Draw walls again." }
        check(!requireSelection || catalogue() == actionCatalogue && renderCatalogue() == actionRender) { "Wall content changed. Draw the batch again." }
    }
    private suspend fun <T> bounded(block: suspend () -> T): T { guard(); return block().also { guard() } }
    private val op = MoneyOp(spec, store, object : OpTransport {
        override suspend fun get(path: String, query: Map<String, String>) = bounded { api.get(path, query) }
        override suspend fun post(path: String, body: JsonObject): JsonObject {
            check(actionEpoch != null && permittedKey != null && body["idempotencyKey"] == JsonPrimitive(permittedKey) && path == spec.path)
            check(ordersAllowed()) { "Wall building is unavailable while game orders are blocked. Keep the original request saved." }
            return bounded { api.post(path, body) }
        }
    })
    init { mutable.update { it.copy(pending = op.pending(session.wallet)) }; observer.register(op, ::hydrate) }
    fun dismiss() { epoch++; if (holder.isCurrent(session)) mutable.update { it.copy(drawing = null, preview = emptyList()) } }
    /** Session-owned presentation survives Home/layout remounts; dismissing never retires a saved intent. */
    fun dismissReceipt(receiptId: String) {
        if (!holder.isCurrent(session)) return
        mutable.update { if (it.pending == null && it.receipt?.receiptId == receiptId) it.copy(receiptDismissed = true) else it }
    }
    fun preview(token: String, tiles: List<WallStrokeTile>) {
        if (!holder.isCurrent(session)) return
        val drawing = mutable.value.drawing ?: return
        if (drawing.epoch != epoch || drawing.mode.token != token || drawing.originalBaseId != selectedBaseId()) return
        require(tiles.distinct().size == tiles.size && tiles.all { it in drawing.mode.validTiles })
        mutable.update { it.copy(preview = tiles.toList()) }
    }
    private suspend fun <T> action(selection: Boolean = false, block: suspend () -> T): T {
        holder.requireCurrent(session); check(admission.tryLock()) { "A wall batch is already in progress." }
        actionEpoch = epoch; selected = selectedBaseId(); requireSelection = selection; actionCatalogue = catalogue(); actionRender = renderCatalogue()
        mutable.update { it.copy(busy = true) }
        try { guard(); return block() } finally {
            actionEpoch = null; permittedKey = null; requireSelection = false
            try { if (holder.isCurrent(session)) { observer.refresh(session.wallet); holder.requireCurrent(session)
                mutable.update { it.copy(busy = false, pending = op.pending(session.wallet)) } } } finally { admission.unlock() }
        }
    }
    private suspend fun probe(): Boolean {
        mutable.update { it.copy(supported = false, enabled = false) }; val key = UUID.randomUUID().toString()
        val raw = try { bounded { api.get("${spec.path}/$key") } }
        catch (error: ApiException) { guard(); if (error.status == 404) return false else throw error }
        val c = HeroRecruitmentContract; c.keys(raw, "version", "wallet", "idempotencyKey", "enabled", "receipt")
        require(raw["version"] == JsonPrimitive(1) && raw["wallet"] == JsonPrimitive(session.wallet)
            && raw["idempotencyKey"] == JsonPrimitive(key) && raw["receipt"] == JsonNull)
        val enabled = c.flag(raw, "enabled"); mutable.update { it.copy(supported = true, enabled = enabled) }; return enabled
    }
    private fun originalAvailable(base: String?) {
        val dir = requireNotNull(directory()) { "Refresh the original base directory." }
        check(if (base == null) !dir.enabled else dir.bases.any { it.id == base && it.selectable } && (!dir.enabled || dir.stableMutations)) {
            "The original wall destination is unavailable. Its saved scope cannot change."
        }
    }
    private suspend fun home(base: String?): HomeSnapshot {
        val snapshot = BaseSnapshot.from(bounded { api.get("/base", base?.let { mapOf("baseId" to it) }.orEmpty()) })
        val resolved = requireNotNull(snapshot.baseId)
        require(snapshot.player.wallet == session.wallet && (base == null || resolved == base)) { "The original wall base could not be verified." }
        val raw = bounded { api.get("/balances", mapOf("baseId" to resolved)) }
        listOf("shards", "keep").forEach { ForgeClaimContract.amount(HeroRecruitmentContract.text(raw, it)) }
        return HomeSnapshot(snapshot, Balances.from(raw), null)
    }
    suspend fun refresh() = action {
        val observed = op.observe(session.wallet, ::hydrate)
        val unknownKey = op.pending(session.wallet)?.idempotencyKey?.takeIf { observed != null && op.closable(session.wallet) }
        mutable.update { it.copy(serverUnknownKey = unknownKey) }
        probe(); Unit
    }
    /** The wall batch card's CLOSE (owner 2026-10-06): the existing MoneyOp closure. It reads the receipt once more; an
     * acceptance found there is hydrated as usual, and only a settled server `absent` answer for this exact key archives it on this device (re-read on every Home resume). */
    suspend fun close(): Receipt<*>? = action { op.close(session.wallet, confirmed = true, ::hydrate) }
    suspend fun prepare() = action(selection = true) {
        check(op.blocking(session.wallet) == null) { "Check the original wall batch before drawing another." }
        check(!observer.blocks(IntentKind.CONSTRUCTION)) { "Resolve the original construction request before drawing walls." }
        check(ordersAllowed()) { "Wall building is currently unavailable." }
        bounded { refreshAccount() }; originalAvailable(selected)
        check(probe()) { "Wall strokes require available v1 recovery support. No walls were ordered." }
        val c = requireNotNull(catalogue()); val home = home(selected); val terms = WallBatchTerms.from(c, home.base.plotVersion)
        val count = requireNotNull(buildCountPresentation(c, "wall", home.base.player.keepLevel, home.base.buildings.map { it.type }))
        check(count.owned < count.max) { "This base has reached its current wall cap." }
        check(home.balances.shards.toLong() >= terms.unitCostShards.toLong()) { "Not enough SHARDS for a wall." }
        val mode = wallStrokeMode(UUID.randomUUID().toString(), home.base, terms, c, renderCatalogue())
        mutable.update { it.copy(drawing = WallBatchDrawing(mode, selected, home.base, terms, home.balances.shards, count.max - count.owned, epoch),
            preview = emptyList(), receipt = null, unavailable = null, receiptDismissed = false) }
    }
    suspend fun release(token: String, tiles: List<WallStrokeTile>) = action(selection = true) {
        val drawing = requireNotNull(mutable.value.drawing) { "Draw a new wall batch." }
        require(drawing.mode.token == token && drawing.epoch == epoch && drawing.originalBaseId == selected)
        check(op.blocking(session.wallet) == null && !observer.blocks(IntentKind.CONSTRUCTION))
        require(tiles.isNotEmpty() && tiles.distinct().size == tiles.size && tiles.all { it in drawing.mode.validTiles })
        mutable.update { it.copy(drawing = null, preview = emptyList()) } // Consume the lease before any suspension or duplicate release.
        check(tiles.size <= drawing.remaining) { "The whole stroke exceeds the reviewed wall cap. No partial batch was submitted." }
        val request = WallBatchRequest(UUID.randomUUID().toString(), drawing.originalBaseId, tiles.map { WallBatchTile(it.tx, it.ty) }, drawing.terms.cost(tiles.size))
        request.validate(drawing.terms)
        check(request.maxCostShards.toLong() <= drawing.availableShards.toLong()) { "The whole stroke exceeds the reviewed SHARDS balance. No partial batch was submitted." }
        bounded { refreshAccount() }; originalAvailable(request.baseId); check(ordersAllowed())
        check(probe()) { "New wall batches are unavailable. Nothing was submitted." }
        val c = requireNotNull(catalogue()); val home = home(request.baseId); require(WallBatchTerms.from(c, home.base.plotVersion) == drawing.terms) { "Wall prices changed. Draw again." }
        val current = wallStrokeMode(token, home.base, drawing.terms, c, renderCatalogue())
        val cap = requireNotNull(buildCountPresentation(c, "wall", home.base.player.keepLevel, home.base.buildings.map { it.type }))
        require(tiles.all { it in current.validTiles } && cap.owned + tiles.size <= cap.max
            && request.maxCostShards.toLong() <= home.balances.shards.toLong()) { "The original stroke is no longer fully buildable or affordable. No partial batch was submitted." }
        val intent = spec.intent(session.wallet, request, drawing.terms); permittedKey = intent.idempotencyKey
        op.submit(intent) { accepted ->
            guard(); currentCoroutineContext()[BaseAudioAction]?.accepted(session, request.baseId, listOf(UiAudioCue.WALL)); hydrate(accepted)
        }; Unit
    }
    suspend fun retry() = action(selection = true) {
        val saved = requireNotNull(op.pending(session.wallet)); spec.terms(saved)
        val observed = op.observe(session.wallet, ::hydrate)
        if (observed == Receipt.Unsupported) mutable.update { it.copy(supported = false, enabled = false) }
        if (observed != Receipt.Unknown && observed != Receipt.Absent) return@action
        check(probe()) { "Keep the original batch until wall recovery is enabled." }
        bounded { refreshAccount() }; originalAvailable(saved.baseId); check(selected == saved.baseId)
        permittedKey = saved.idempotencyKey; op.retry(session.wallet, ::hydrate); Unit
    }
    private suspend fun hydrate(accepted: Receipt.Accepted<WallBatchReceipt>) {
        guard(); val proof = accepted.value; val base = proof.request.baseId; bounded { refreshAccount() }
        val dir = requireNotNull(directory()); val unavailable = when {
            base == null && dir.enabled -> "The original wallet wall scope cannot be refreshed in multi-base mode. The original receipt remains authoritative."
            base != null && (!dir.enabled || !dir.bases.any { it.id == base && it.selectable }) -> "The original wall destination is unavailable for refresh. Its receipt does not prove current wall positions or ownership."
            else -> null
        }
        if (unavailable == null) {
            home(base); bounded { refreshAccount() }; require(directory() == dir) { "The original directory changed. Check this receipt again." }
            if (selectedBaseId() == base) bounded { refreshSelected() }
        }
        guard(); mutable.update { it.copy(receipt = proof, unavailable = unavailable,
            receiptDismissed = it.receiptDismissed && it.receipt?.receiptId == proof.receiptId) }
    }
}
