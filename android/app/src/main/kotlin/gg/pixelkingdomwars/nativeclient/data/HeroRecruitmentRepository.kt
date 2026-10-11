package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.ops.*
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.session.AccountSessionHolder
import gg.pixelkingdomwars.nativeclient.audio.BaseAudioAction
import gg.pixelkingdomwars.nativeclient.audio.UiAudioCue
import java.util.UUID
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.serialization.json.*

data class HeroAltarOffer(val definition: HeroAltarDefinition, val contracts: Int, val recruited: Boolean)
data class HeroAltarReview(val offer: HeroAltarOffer, val baseId: String?, val tx: Int, val ty: Int, val epoch: Long)
data class HeroRecruitmentState(val supported: Boolean = false, val enabled: Boolean = false, val busy: Boolean = false,
    val offers: List<HeroAltarOffer> = emptyList(), val base: BaseSnapshot? = null, val review: HeroAltarReview? = null,
    val pending: PendingIntent? = null, val receipt: HeroRecruitmentReceipt? = null, val unavailable: String? = null,
    /** The saved key whose card offers CLOSE after a read (owner review 2026-10-06: never sent, or a settled server `absent`
     * answer for exactly this key; an `unknown` answer keeps it shown and only stops it blocking, [MoneyOp.closable]). */
    val serverUnknownKey: String? = null,
    /** CONFIRM PLACEMENT is running. The review is consumed (hidden) before the POST, but the placement draft is cleared only
     * when the confirm returns, so Home must keep its placement tile dialog and band hidden meanwhile (owner Seeker 2026-10-06
     * 16:45: on QA, ~8 s of POST + hydration redrew them where the review was, and a tap there was a clearTile `dismiss()`
     * that fenced the accepted request: "The altar review closed. Check the original saved request."). */
    val confirming: Boolean = false)

/** Recruitment is placement, with contract-first funding. History is independent of today's altar and deed. */
class HeroRecruitmentRepository(private val session: AccountSession, private val holder: AccountSessionHolder,
    private val api: ApiClient, private val store: PendingIntentStore, private val observer: ReceiptObserver,
    private val selectedBaseId: () -> String?, private val directory: () -> BaseDirectory?,
    private val refreshAccount: suspend () -> Unit, private val catalogue: () -> JsonObject?,
    private val refreshSelected: suspend () -> Unit, cluster: String) {
    private val mutable = MutableStateFlow(HeroRecruitmentState()); val state = mutable.asStateFlow()
    private val admission = Mutex(); @Volatile private var epoch = 0L; @Volatile private var actionEpoch: Long? = null
    @Volatile private var selection: String? = null; @Volatile private var requireSelection = false; private var permittedKey: String? = null
    @Volatile private var actionCatalogue: JsonObject? = null
    private val spec = HeroRecruitmentSpec(cluster)
    private suspend fun guard() { currentCoroutineContext().ensureActive(); current() }
    private fun current() {
        holder.requireCurrent(session)
        check(actionEpoch == null || actionEpoch == epoch) { "The altar review closed. Check the original saved request." }
        check(!requireSelection || selection == selectedBaseId()) { "The selected base changed. Review recruitment again." }
        check(!requireSelection || catalogue() == actionCatalogue) { "The game content changed. Review recruitment again." }
    }
    private suspend fun <T> bounded(block: suspend () -> T): T { guard(); return block().also { guard() } }
    private val op = MoneyOp(spec, store, object : OpTransport {
        override suspend fun get(path: String, query: Map<String, String>) = bounded { api.get(path, query) }
        override suspend fun postObserved(intent: PendingIntent, refusal: (ApiException) -> Unit): JsonObject {
            check(actionEpoch != null && permittedKey == intent.idempotencyKey && intent.path == spec.path)
            return bounded { api.postMoneyCommand(intent.path, intent.body, null, refusal, ::current) }
        }
        override suspend fun post(path: String, body: JsonObject): JsonObject {
            check(actionEpoch != null && permittedKey != null && body["idempotencyKey"] == JsonPrimitive(permittedKey) && path == spec.path)
            return bounded { api.post(path, body) }
        }
    })
    init {
        // Recovery stays visible before a network read, including a landless or offline restart.
        mutable.update { it.copy(pending = op.pending(session.wallet)) }
        observer.register(op, ::hydrate)
    }
    fun dismiss() { epoch++; if (holder.isCurrent(session)) mutable.update { it.copy(review = null) } }
    private suspend fun <T> action(selected: Boolean = false, block: suspend () -> T): T {
        holder.requireCurrent(session); check(admission.tryLock()) { "An altar request is already in progress." }
        actionEpoch = epoch; selection = selectedBaseId(); actionCatalogue = catalogue(); requireSelection = selected; mutable.update { it.copy(busy = true) }
        try { guard(); return block() } finally {
            actionEpoch = null; requireSelection = false; permittedKey = null
            try { if (holder.isCurrent(session)) { observer.refresh(session.wallet); holder.requireCurrent(session)
                mutable.update { it.copy(busy = false, confirming = false, pending = op.pending(session.wallet)) } } } finally { admission.unlock() }
        }
    }
    private fun definitions(plotVersion: Int?) = HeroAltarDefinition.all(requireNotNull(catalogue()) { "Load the verified hero catalogue first." }, plotVersion)
    private suspend fun home(base: String?): HomeSnapshot = bounded { readHome(api, base) }.also {
        ForgeClaimContract.amount(it.balances.keep); ForgeClaimContract.amount(it.balances.shards)
    }
    private suspend fun probe(): Boolean {
        mutable.update { it.copy(supported = false, enabled = false) }
        val key = UUID.randomUUID().toString()
        val raw = try { bounded { api.get("${spec.path}/$key") } }
        catch (error: ApiException) { guard(); if (error.status == 404) return false else throw error }
        HeroRecruitmentContract.keys(raw, "version", "wallet", "idempotencyKey", "enabled", "receipt")
        require(raw["version"] == JsonPrimitive(1) && raw["wallet"] == JsonPrimitive(session.wallet)
            && raw["idempotencyKey"] == JsonPrimitive(key) && raw["receipt"] == JsonNull)
        val enabled = HeroRecruitmentContract.flag(raw, "enabled")
        mutable.update { it.copy(supported = true, enabled = enabled) }; return enabled
    }
    private fun requireOriginal(base: String?) {
        val dir = requireNotNull(directory()) { "Refresh your deed directory first." }
        check(if (base == null) !dir.enabled else dir.bases.any { it.id == base && it.selectable }
            && (!dir.enabled || dir.stableMutations)) { "The original recruitment base is unavailable. Its saved destination cannot change." }
    }
    private suspend fun readOffers(base: String?): List<HeroAltarOffer> {
        requireOriginal(base)
        val home = home(base)
        val query = base?.let { mapOf("baseId" to it) }.orEmpty()
        val items = bounded { api.get("/items", query) }; val roster = bounded { api.get("/heroes", query) }
        val defs = definitions(home.base.plotVersion); val offers = defs.map { heroOffer(it, items, roster) }
        mutable.update { it.copy(offers = offers, base = home.base) }; return offers
    }
    suspend fun refresh() = action(selected = true) {
        val observed = op.observe(session.wallet, ::hydrate)
        val unknownKey = op.pending(session.wallet)?.idempotencyKey?.takeIf { observed != null && op.closable(session.wallet) }
        mutable.update { it.copy(serverUnknownKey = unknownKey) }
        bounded { refreshAccount() }; probe()
        val dir = directory()
        if (dir != null && (selection == null && !dir.enabled || selection != null && dir.bases.any { it.id == selection && it.selectable })) readOffers(selection)
        else mutable.update { it.copy(offers = emptyList(), base = null) }
        Unit
    }
    private fun newAllowed() { check(op.blocking(session.wallet) == null && !observer.blocks(IntentKind.CONSTRUCTION)) { "Check the original saved construction before recruiting." } }
    private fun placeAllowed(offer: HeroAltarOffer, tx: Int, ty: Int) {
        val base = requireNotNull(mutable.value.base); val d = offer.definition
        require(!offer.recruited && base.buildings.none { it.type == d.type }) { "This base already has this hero's altar." }
        require(base.player.keepLevel >= d.keepLevel && base.freeBuilders > 0) { "Recruitment requires Keep level ${d.keepLevel} and a free builder." }
        HeroRecruitmentRequest(UUID.randomUUID().toString(), selection, d.type, tx, ty, offer.contracts > 0,
            if (offer.contracts > 0) "0" else d.costKeep).validate(d.plotTiles, d.plotGeometry)
    }
    suspend fun review(type: String, tx: Int, ty: Int) = action(selected = true) {
        newAllowed(); bounded { refreshAccount() }; requireOriginal(selection)
        check(probe()) { "Hero recruitment needs available v1 recovery support. No placement was submitted." }
        val offer = readOffers(selection).single { it.definition.type == type }; placeAllowed(offer, tx, ty)
        mutable.update { it.copy(review = HeroAltarReview(offer, selection, tx, ty, epoch), receipt = null, unavailable = null) }
    }
    suspend fun confirm(review: HeroAltarReview) = action(selected = true) {
        require(mutable.value.review == review && review.epoch == epoch && review.baseId == selection) { "Review the altar placement again." }
        mutable.update { it.copy(confirming = true) }
        newAllowed(); bounded { refreshAccount() }; requireOriginal(review.baseId)
        check(probe()) { "Recruitment is unavailable. No placement was submitted." }
        val current = readOffers(review.baseId).single { it.definition.type == review.offer.definition.type }
        require(current.definition == review.offer.definition) { "The recruitment terms changed. Review again." }
        require(review.offer.contracts == 0 || current.contracts > 0) { "The hero contract is no longer available. Review the KEEP price before placing." }
        placeAllowed(current, review.tx, review.ty)
        val request = HeroRecruitmentRequest(UUID.randomUUID().toString(), review.baseId, current.definition.type, review.tx, review.ty,
            review.offer.contracts > 0, if (review.offer.contracts > 0) "0" else review.offer.definition.costKeep)
        val intent = spec.intent(session.wallet, request, review.offer.definition)
        permittedKey = intent.idempotencyKey; mutable.update { it.copy(review = null) }
        op.submit(intent) { accepted ->
            guard(); currentCoroutineContext()[BaseAudioAction]?.accepted(session, review.baseId, listOf(UiAudioCue.PLACE))
            hydrate(accepted)
        }; Unit
    }
    suspend fun retry() = action(selected = true) {
        val saved = requireNotNull(op.pending(session.wallet)); spec.definition(saved)
        val observed = op.observe(session.wallet, ::hydrate)
        if (observed == Receipt.Unsupported) mutable.update { it.copy(supported = false, enabled = false) }
        if (observed != Receipt.Unknown && observed != Receipt.Absent) return@action
        check(probe()) { "Keep the original request saved until this server enables recruitment recovery." }
        bounded { refreshAccount() }; requireOriginal(saved.baseId)
        check(saved.baseId == selection) { "Select the original recruitment base before retrying." }
        // The persisted contract-only / KEEP ceiling stays intact even if the current bag changed.
        permittedKey = saved.idempotencyKey; op.retry(session.wallet, ::hydrate); Unit
    }
    /** The altar card's CLOSE (owner 2026-10-06): the existing MoneyOp closure. It reads the receipt once more; an acceptance
     * found there is hydrated as usual, and only a settled server `absent` answer for this exact key archives it on this device (re-read on every Home resume). No POST. */
    suspend fun close(): Receipt<*>? = action { op.close(session.wallet, confirmed = true, ::hydrate) }
    private suspend fun hydrate(accepted: Receipt.Accepted<HeroRecruitmentReceipt>) {
        guard(); val proof = accepted.value; val base = proof.request.baseId; bounded { refreshAccount() }
        val dir = requireNotNull(directory()) { "Refresh your deed directory before finishing." }
        val unavailable = when {
            base == null && dir.enabled -> "The original wallet base cannot be refreshed in current multi-base mode. The original accepted altar receipt remains authoritative."
            base != null && (!dir.enabled || !dir.bases.any { it.id == base && it.selectable }) -> "The original base is unavailable for refresh. This receipt proves the original placement, not current ownership or hero availability."
            else -> null
        }
        if (unavailable == null) {
            home(base)
            val query = base?.let { mapOf("baseId" to it) }.orEmpty()
            val items = bounded { api.get("/items", query) }; val heroes = bounded { api.get("/heroes", query) }
            require(items["catalog"] is JsonArray && items["owned"] is JsonArray && heroes["heroes"] is JsonArray)
            Inventory.from(items); require(HeroRoster.from(heroes).heroes.count { it.hero == proof.hero } == 1)
            bounded { refreshAccount() }; require(directory() == dir) { "The original directory changed. Refresh this receipt again." }
            if (selectedBaseId() == base) bounded { refreshSelected() }
        }
        guard(); mutable.update { it.copy(receipt = proof, unavailable = unavailable) }
    }
}

/** The API deliberately exposes legacy wallet contracts separately from sellable deed inventory. */
internal fun heroOffer(definition: HeroAltarDefinition, items: JsonObject, roster: JsonObject): HeroAltarOffer {
    val c = HeroRecruitmentContract
    val item = requireNotNull(items["catalog"] as? JsonArray).map { it.jsonObject }.single { it["id"] == JsonPrimitive(definition.itemId) }
    val activation = requireNotNull(item["activation"] as? JsonObject)
    require(c.text(activation, "kind") == "hero"); val active = c.flag(activation, "active")
    val contracts = c.integer(activation, "availableContracts").also { require(it >= 0) }
    val hero = requireNotNull(roster["heroes"] as? JsonArray).map { it.jsonObject }.single { it["hero"] == JsonPrimitive(definition.hero) }
    require(c.text(hero, "altar") == definition.type && c.text(hero, "recruitItemId") == definition.itemId
        && c.text(hero, "recruitCostKeep") == definition.costKeep && c.integer(hero, "unlockKeepLevel") == definition.keepLevel)
    val recruited = c.flag(hero, "recruited"); require(active == recruited) { "The hero changed during the inventory refresh. Refresh again." }
    return HeroAltarOffer(definition, contracts, recruited)
}
