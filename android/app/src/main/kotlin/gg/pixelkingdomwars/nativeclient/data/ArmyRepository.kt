package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.ops.*
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.session.AccountSessionHolder
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.sync.Mutex
import kotlinx.serialization.json.*

/** Unsent player input, bound to the account and base that displayed the Army. A [plan] (saved army or the
 * previous attack) may name troops this base cannot train yet: the server quotes them as `remaining`
 * (web trainingPresets.tsx `preview`), so only a manual draft is checked against the live options. */
data class ArmyTrainingDraft(val wallet: String, val baseId: String, val quantities: Map<String, String>, val plan: Boolean = false) {
    fun composition(): JsonArray = JsonArray(quantities.mapNotNull { (troop, text) ->
        if (text.isNotEmpty()) {
            require(text.all { it in '0'..'9' }) { "Enter whole troop quantities" }
            val count = requireNotNull(text.toIntOrNull()) { "Troop quantity is too large" }
            if (count > 0) buildJsonObject { put("troop", troop); put("count", count) } else null
        } else null
    }).also { require(it.isNotEmpty()) { "Choose troops to train" } }
    fun request(wallet: String?, baseId: String?, available: Set<String>): JsonObject {
        require(this.wallet == wallet && this.baseId == baseId) { "The account or base changed. Choose your army again." }
        val composition = composition()
        require(plan || composition.all { it.jsonObject.string("troop") in available }) { "Army options changed. Choose your army again." }
        return buildJsonObject { put("baseId", this@ArmyTrainingDraft.baseId); put("composition", composition) }
    }
    companion object {
        fun ofPlan(wallet: String, baseId: String, composition: List<TroopCount>): ArmyTrainingDraft =
            ArmyTrainingDraft(wallet, baseId, composition.associateTo(LinkedHashMap()) { it.troop to it.count.toString() }, plan = true)
    }
}

/** A confirmation names the exact server row, not its position or troop type. */
data class TrainingCancellationChoice(val wallet: String, val baseId: String, val queueId: String, val troop: String, val refundShards: String) {
    fun requireCurrent(wallet: String?, baseId: String?, army: ArmyState?) {
        require(wallet == this.wallet && baseId == this.baseId) { "Your account or kingdom changed. Choose the unit again." }
        val row = requireNotNull(army?.queue?.firstOrNull { it.id == queueId }) { "This unit is no longer in the training queue. Refresh your army." }
        require(row.canCancel && row.troop == troop && row.refundShards == refundShards) { "The server's cancellation details changed. Refresh your army and review again." }
    }
    companion object {
        fun of(wallet: String?, baseId: String?, army: ArmyState?, row: TrainingQueueRow): TrainingCancellationChoice? = runCatching {
            require(row.canCancel)
            val refund = requireNotNull(row.refundShards); require(refund.length <= 32 && refund.matches(Regex("[1-9][0-9]*")))
            TrainingCancellationChoice(requireNotNull(wallet), requireNotNull(baseId), row.id, row.troop, refund).also { it.requireCurrent(wallet, baseId, army) }
        }.getOrNull()
    }
}

/** A reviewed quote whose consent is frozen in [body] exactly as the server issued it. */
data class ReviewedQuote(val draft: ArmyTrainingDraft, val quote: TrainingQuote, val body: JsonObject, val scheduling: TrainingScheduling) {
    val schedule: TrainingSchedule? get() = runCatching { trainingQuoteSchedule(quote.raw) }.getOrNull()
}

/** Unsent consent; dismissal invalidates in-flight review without touching saved payment evidence. */
data class ReviewedHeroSpend(val intent: PendingIntent, val generation: Long)
data class ReviewedResearchSpend(val intent: PendingIntent, val generation: Long, val revision: Long)
data class ReviewedTrainingFinishSpend(val intent: PendingIntent, val generation: Long, val revision: Long)

data class ArmyDomainState(
    val army: ArmyState? = null,
    val armyBaseId: String? = null,
    val armyBaseGeneration: Long? = null,
    val heroes: HeroRoster? = null,
    /** Base that supplied this roster, frozen into hero-spend confirmations. */
    val heroesBaseId: String? = null,
    val heroReview: ReviewedHeroSpend? = null,
    val researchReview: ReviewedResearchSpend? = null,
    val trainingFinishReview: ReviewedTrainingFinishSpend? = null,
    val inventory: Inventory? = null,
    val reviewed: ReviewedQuote? = null,
    /** Saved armies (`GET /army/presets`); null until the player opens them. */
    val presets: List<TrainingPreset>? = null,
    val loading: Boolean = false,
    val error: String? = null,
    val message: String? = null,
) {
    val scheduling: TrainingScheduling? get() = army?.let { trainingScheduling(it.raw) }
}

interface ArmyRepository {
    val state: StateFlow<ArmyDomainState>
    val training: MoneyOp<TrainingAcceptance>
    val cancellation: MoneyOp<CancellationAcceptance>
    val finish: MoneyOp<FinishAcceptance>
    val research: MoneyOp<ResearchAcceptance>
    val heroUpgrade: MoneyOp<HeroUpgradeAcceptance>
    val heroRecovery: MoneyOp<HeroRecoveryAcceptance>
    val itemPurchase: MoneyOp<ItemPurchaseAcceptance>
    val itemUse: MoneyOp<ItemUseAcceptance>
    suspend fun refreshArmy()
    suspend fun refreshHeroes()
    suspend fun refreshInventory()
    suspend fun quote(draft: ArmyTrainingDraft)
    fun dismissQuote()
    suspend fun confirmTraining()
    suspend fun cancelQueued(choice: TrainingCancellationChoice)
    /** Legacy UI compatibility: only the free first-troops offer may enter here. Paid orders require review. */
    suspend fun finishAll(free: Boolean, displayedCostKeep: String? = null)
    suspend fun reviewTrainingFinish() { error("Training currency review is unavailable") }
    suspend fun reviewTrainingFinishSaved() { error("Training currency review is unavailable") }
    suspend fun confirmTrainingFinish() { error("Training currency review is unavailable") }
    fun dismissTrainingFinishReview() {}
    suspend fun reviewResearchFinish(troop: String) { error("Research finish review is unavailable") }
    suspend fun reviewResearchSaved() { error("Research finish review is unavailable") }
    suspend fun confirmResearchFinish() { error("Research finish review is unavailable") }
    fun dismissResearchReview() {}
    suspend fun submitResearch(target: JsonObject)
    suspend fun refreshPresets()
    suspend fun savePreset(slot: Int, name: String, composition: List<TroopCount>)
    suspend fun deletePreset(slot: Int)
    /** `GET /army/previous` then a quote of its deployed troops, or the server's message when there were none. */
    suspend fun quotePrevious()
    suspend fun reviewHeroUpgrade(hero: String) { error("Hero currency review is unavailable") }
    suspend fun reviewHeroRecovery(hero: String) { error("Hero currency review is unavailable") }
    suspend fun confirmHeroSpend() { error("Hero currency review is unavailable") }
    fun dismissHeroReview() {}
    suspend fun upgradeHero(hero: String, level: Int, costKeep: String)
    suspend fun recoverHero(hero: String, costKeep: String, recoveryUntil: String)
    suspend fun buyItem(itemId: String)
    suspend fun useItem(itemId: String, jobId: String? = null)
    suspend fun equip(hero: String, slot: String, itemId: String?, expectedVersion: Int)
    /** Clears an item's NEW marker; best effort, never blocks the screen (web `select`). */
    suspend fun markItemSeen(itemId: String)
    fun clearNotice()
}

class LiveArmyRepository(
    private val session: AccountSession,
    private val holder: AccountSessionHolder,
    private val api: ApiClient,
    intents: PendingIntentStore,
    private val observer: ReceiptObserver,
    private val baseId: () -> String?,
    private val catalogue: () -> JsonObject?,
    private val home: () -> BaseState,
    private val hydrateHome: suspend () -> Unit,
    private val newKey: () -> String = { UUID.randomUUID().toString() },
    private val now: () -> Long = System::currentTimeMillis,
    private val refreshAccount: suspend () -> Unit = {},
    private val baseGeneration: () -> Long = { 0 },
    private val heroActionsAllowed: () -> Boolean = { true },
    private val hydrateResearchHome: suspend (publicationGuard: () -> Unit) -> Unit = { error("Protected research refresh is unavailable") },
    private val hydrateTrainingFinishHome: suspend (publicationGuard: () -> Unit) -> Unit = { error("Protected training refresh is unavailable") },
) : ArmyRepository {
    private val _state = MutableStateFlow(ArmyDomainState())
    override val state: StateFlow<ArmyDomainState> = _state.asStateFlow()
    private val transport = api.asTransport()
    private val heroAdmission = Mutex()
    private var heroReviewRevision = 0L
    private val heroTransport = HeroCurrencyTransport(transport) { intent, refusal ->
        val reviewed = requireNotNull(_state.value.heroReview) { "Review your Hero payment again." }
        check(reviewed.intent.nextAttempt() == intent)
        val current = {
            check(_state.value.heroReview === reviewed) { "The Hero payment review is no longer active." }
            requireHeroAdmissionScope(reviewed.intent.baseId, reviewed.generation)
        }
        current()
        api.postMoneyCommand(intent.path, intent.body, GameCurrency.valueOf(requireNotNull(intent.expectedCurrency)), refusal, current)
    }
    private val armyReads = java.util.concurrent.atomic.AtomicLong()
    private val researchRevision = java.util.concurrent.atomic.AtomicLong()
    private val researchAdmission = Mutex()
    private val researchTransport = ResearchCurrencyTransport(transport) { intent, refusal ->
        val reviewed = requireNotNull(_state.value.researchReview) { "Review the original research finish first." }
        check(reviewed.intent.nextAttempt() == intent)
        val guard = { requireResearchReview(reviewed) }
        guard()
        api.postMoneyCommand(intent.path, intent.body, GameCurrency.valueOf(requireNotNull(intent.expectedCurrency)), refusal, guard)
    }
    private val trainingFinishRevision = java.util.concurrent.atomic.AtomicLong()
    private val trainingFinishAdmission = Mutex()
    private val trainingFinishTransport = TrainingFinishCurrencyTransport(transport) { intent, refusal ->
        val reviewed = requireNotNull(_state.value.trainingFinishReview) { "Review the original training finish first." }
        check(reviewed.intent.nextAttempt() == intent)
        val guard = { requireTrainingFinishReview(reviewed) }
        guard()
        api.postMoneyCommand(intent.path, intent.body, GameCurrency.valueOf(requireNotNull(intent.expectedCurrency)), refusal, guard)
    }
    private data class ArmyRead(val number: Long, val base: String?, val generation: Long)
    private fun armyRead(base: String? = baseId()) = ArmyRead(armyReads.incrementAndGet(), base, baseGeneration())
    private fun requireArmyRead(ticket: ArmyRead) {
        requireBase(ticket.base)
        check(ticket.generation == baseGeneration() && ticket.number == armyReads.get()) { "Army read superseded. Refresh the current kingdom." }
    }
    private fun publishArmy(ticket: ArmyRead, army: ArmyState, guard: () -> Unit = {}, change: (ArmyDomainState) -> ArmyDomainState = { it }) {
        _state.update { requireArmyRead(ticket); guard(); change(it).copy(army = army, armyBaseId = ticket.base, armyBaseGeneration = ticket.generation) }
    }
    private suspend fun readArmy(ticket: ArmyRead): ArmyState {
        requireArmyRead(ticket)
        return ArmyState.from(api.get("/army", ticket.base?.let { mapOf("baseId" to it) }.orEmpty())).also { requireArmyRead(ticket) }
    }
    private var heroesBaseId: String? = null
    private var inventoryBaseId: String? = null
    private fun requireBase(expected: String?) {
        holder.requireCurrent(session)
        check(baseId() == expected) { "The selected base changed. Refresh before continuing." }
    }
    override val training = MoneyOp(TrainingBatchSpec, intents, transport)
    override val cancellation = MoneyOp(TrainingCancelSpec, intents, transport)
    override val finish = MoneyOp(TrainingFinishSpec, intents, trainingFinishTransport)
    override val research = MoneyOp(ResearchSpec, intents, researchTransport)
    override val heroUpgrade = MoneyOp(HeroUpgradeSpec, intents, heroTransport)
    override val heroRecovery = MoneyOp(HeroRecoverySpec, intents, heroTransport)
    /** A consented purchase carries its exact currency header (night/server itemPurchaseIntent refuses consent without it);
     * a legacy purchase keeps the ordinary transport. Same session guard as every money command. */
    private val itemTransport = object : OpTransport {
        override suspend fun get(path: String, query: Map<String, String>) = transport.get(path, query)
        override suspend fun post(path: String, body: JsonObject) = transport.post(path, body)
        override suspend fun post(intent: PendingIntent): JsonObject = postObserved(intent) {}
        override suspend fun postObserved(intent: PendingIntent, refusal: (ApiException) -> Unit): JsonObject {
            val currency = intent.expectedCurrency ?: return transport.post(intent)
            return api.postMoneyCommand(intent.path, intent.body, GameCurrency.valueOf(currency), refusal) { holder.requireCurrent(session) }
        }
    }
    override val itemPurchase = MoneyOp(ItemBuySpec, intents, itemTransport)
    override val itemUse = MoneyOp(ItemUseSpec, intents, transport)
    init {
        observer.register(training) { hydrateTraining(requireNotNull(training.pending(session.wallet)).baseId) }
        observer.register(cancellation) { hydrateTraining(requireNotNull(cancellation.pending(session.wallet)).baseId) }
        observer.register(finish) {
            val saved = requireNotNull(finish.pending(session.wallet))
            if (saved.expectedCurrency != null) hydrateTrainingFinishReceipt(saved) else hydrateTraining(saved.baseId)
        }
        observer.register(research) {
            val saved = requireNotNull(research.pending(session.wallet))
            if (saved.expectedCurrency != null) hydrateResearchReceipt(saved) else hydrateTraining(saved.baseId)
        }
        observer.register(heroUpgrade) { hydrateHeroReceipt(requireNotNull(heroUpgrade.pending(session.wallet)), it.document) }
        observer.register(heroRecovery) { hydrateHeroReceipt(requireNotNull(heroRecovery.pending(session.wallet)), it.document) }
        observer.register(itemPurchase) { hydrateInventory(requireNotNull(itemPurchase.pending(session.wallet)).baseId) }
        observer.register(itemUse) { hydrateInventory(requireNotNull(itemUse.pending(session.wallet)).baseId) }
    }

    private fun query() = baseId()?.let { mapOf("baseId" to it) }.orEmpty()
    private fun body(extra: JsonObject = buildJsonObject {}) = JsonObject(extra + buildJsonObject { baseId()?.let { put("baseId", it) } })

    /** Hydrate-before-publish for every training operation: Home and Army are re-read with this session. */
    private suspend fun hydrateTraining(selected: String? = baseId()) {
        val ticket = armyRead(selected)
        requireArmyRead(ticket)
        if (selected != null) hydrateHome()
        publishArmy(ticket, readArmy(ticket))
    }
    /** Hero KEEP spends: balances (Home) and the roster are re-read before the result is published. */
    private suspend fun hydrateRoster(selected: String? = baseId(), generation: Long? = null) {
        requireHeroScope(selected, generation)
        if (selected != null) hydrateHome()
        requireHeroScope(selected, generation)
        val heroes = HeroRoster.from(api.get("/heroes", query()))
        requireHeroScope(selected, generation)
        heroesBaseId = selected
        _state.update { it.copy(heroes = heroes, heroesBaseId = selected) }
    }
    /** A historical GET proves an earlier payment, not today's roster. Its persisted provenance
     * keeps this path recoverable after process death, including a deed sold since the purchase. */
    private suspend fun hydrateHeroReceipt(intent: PendingIntent, document: JsonObject, originalGeneration: Long? = null) {
        if (ReceiptDocument.source(document) != ReceiptDocument.SOURCE_RECEIPT) {
            hydrateRoster(intent.baseId)
            return
        }
        holder.requireCurrent(session)
        if (originalGeneration != null) requireHeroScope(intent.baseId, originalGeneration)
        refreshAccount()
        holder.requireCurrent(session)
        if (originalGeneration != null) requireHeroScope(intent.baseId, originalGeneration)
        val selected = baseId()
        val generation = baseGeneration()
        var balancesUnavailable = false
        if (selected != null) hydrateRoster(selected, generation)
        else {
            // /balances currently requires a base in stable mode. An explicit no-selection
            // refusal cannot undo an immutable payment; leave values absent rather than zero.
            try { Balances.from(api.get("/balances")) }
            catch (error: ApiException) {
                if (error.status != 409 || error.code != "BASE_ID_REQUIRED") throw error
                balancesUnavailable = true
            }
            requireHeroScope(selected, generation)
            heroesBaseId = null
            _state.update { it.copy(heroes = null, heroesBaseId = null) }
        }
        requireHeroScope(selected, generation)
        val origin = intent.baseId?.let { "kingdom $it" } ?: "your earlier kingdom"
        _state.update { it.copy(message = "Earlier hero payment confirmed for $origin." +
            if (balancesUnavailable) " Balance refresh needs an active kingdom." else "") }
    }

    /** Item purchases and uses: balances, base jobs (a finish item completes a build) and the bag are re-read. */
    private suspend fun hydrateInventory(selected: String? = baseId()) {
        requireBase(selected)
        if (selected != null) hydrateHome()
        requireBase(selected)
        val inventory = Inventory.from(api.get("/items", query()))
        requireBase(selected)
        inventoryBaseId = selected
        _state.update { it.copy(inventory = inventory) }
    }

    override suspend fun refreshArmy() = guarded {
        val ticket = armyRead()
        publishArmy(ticket, readArmy(ticket))
    }
    override suspend fun refreshHeroes() = guarded {
        val selected = baseId()
        val heroes = HeroRoster.from(api.get("/heroes", query()))
        requireBase(selected)
        heroesBaseId = selected
        _state.update { it.copy(heroes = heroes, heroesBaseId = selected) }
    }
    override suspend fun refreshInventory() = guarded {
        val selected = baseId()
        val inventory = Inventory.from(api.get("/items", query()))
        requireBase(selected)
        inventoryBaseId = selected
        _state.update { it.copy(inventory = inventory) }
    }

    /** Training schedule v2 (D-114): quote first, then keep the server's `consent` verbatim. */
    override suspend fun quote(draft: ArmyTrainingDraft) = guarded { quoteDraft(draft) }
    private suspend fun quoteDraft(draft: ArmyTrainingDraft) {
        check(!observer.blocks(IntentKind.TRAINING_CANCEL)) { "Recover your saved training cancellation before buying another batch." }
        check(!observer.blocks(IntentKind.TRAINING_BATCH)) { "Recover the interrupted training request before starting another batch." }
        require(draft.wallet == session.wallet && draft.baseId == baseId()) { "The account or base changed. Choose your army again." }
        check(_state.value.reviewed == null) { "Finish reviewing your current training quote first." }
        val ticket = armyRead()
        val army = readArmy(ticket)
        val scheduling = trainingScheduling(army.raw)
        if (scheduling == TrainingScheduling.UNSUPPORTED) throw ApiCompatibilityException("/army/training/quote")
        val quote = TrainingQuote.from(api.post("/army/training/quote", draft.request(session.wallet, baseId(), army.counts.keys)))
        holder.requireCurrent(session)
        require(baseId() == draft.baseId) { "The selected base changed. Review a new training quote." }
        val body = trainingConfirmation(quote.raw, draft.baseId, newKey(), scheduling)
        publishArmy(ticket, army) { it.copy(reviewed = ReviewedQuote(draft, quote, body, scheduling)) }
    }

    override fun dismissQuote() { if (!_state.value.loading) _state.update { it.copy(reviewed = null) } }

    /** `POST /army/training/batch` with `consent` + `confirmedCostShards`; 409s re-present the quote. */
    override suspend fun confirmTraining() = guarded {
        val reviewed = requireNotNull(_state.value.reviewed) { "Review a training quote first" }
        require(reviewed.body.string("baseId") == baseId()) { "Return to the quoted base before confirming training" }
        check(reviewed.body == trainingConfirmation(reviewed.quote.raw, reviewed.draft.baseId, requireNotNull(reviewed.body.string("idempotencyKey")), reviewed.scheduling)) { "The saved training quote changed" }
        val intent = PendingIntent(IntentKind.TRAINING_BATCH, session.wallet, reviewed.draft.baseId, requireNotNull(reviewed.body.string("idempotencyKey")),
            TrainingBatchSpec.PATH, reviewed.body, "Train army", reviewed.quote.raw)
        try {
            val accepted = training.submit(intent) { hydrateTraining(intent.baseId) }
            _state.update { it.copy(reviewed = null, message = "Training accepted · ${accepted.value.costShards} SHARDS") }
        } catch (error: ApiException) {
            holder.requireCurrent(session)
            when (error.code) {
                "TRAINING_QUOTE_CHANGED" -> {
                    val replacement = (error.details["quote"] as? JsonObject)?.let { runCatching { TrainingQuote.from(it) }.getOrNull() }
                    if (replacement != null) {
                        val body = trainingConfirmation(replacement.raw, reviewed.draft.baseId, newKey(), reviewed.scheduling)
                        _state.update { it.copy(reviewed = reviewed.copy(quote = replacement, body = body), message = "The training schedule changed. Review the refreshed quote before confirming.") }
                    } else { _state.update { it.copy(reviewed = null) }; quoteDraft(reviewed.draft) }
                }
                "TRAINING_CONSENT_REQUIRED" -> { _state.update { it.copy(reviewed = null) }; quoteDraft(reviewed.draft) }
                "TRAINING_BATCH_CLOSED" -> _state.update { it.copy(reviewed = null, message = "That training request was closed. Review a new quote.") }
                else -> if (error.status >= 500) _state.update { it.copy(reviewed = null) }
            }
            throw error
        } finally { observer.refresh(session.wallet) }
    }

    override suspend fun cancelQueued(choice: TrainingCancellationChoice) = guarded {
        val ticket = armyRead(choice.baseId)
        val fresh = readArmy(ticket)
        choice.requireCurrent(session.wallet, baseId(), fresh)
        publishArmy(ticket, fresh)
        check(!observer.blocks(IntentKind.TRAINING_BATCH) && _state.value.reviewed == null) { "Finish reviewing or recovering your training purchase first." }
        val intent = TrainingCancelSpec.intent(session.wallet, choice.baseId, choice.queueId, newKey(), choice.troop, choice.refundShards)
        try {
            val accepted = cancellation.submit(intent) { hydrateTraining(intent.baseId) }
            _state.update { it.copy(message = "Cancellation confirmed. ${accepted.value.refundShards} SHARDS returned to the original kingdom.") }
        } finally { observer.refresh(session.wallet) }
    }

    /** Compatibility entry for the free first-troops offer (D-121). Paid finish requires exact review. */
    override suspend fun finishAll(free: Boolean, displayedCostKeep: String?) = guarded {
        check(free) { "Review the exact training currency before paying." }
        val army = requireNotNull(_state.value.army) { "Load your army first" }
        val frozen: FinishAllConsent = if (free) requireNotNull(army.freeFinishAllOffer) { "The free finish is not available" }.consent
            else requireNotNull(army.finishAllQuote) { "The server offered no finish price" }
        require(frozen.queue.isNotEmpty()) { "Nothing is training" }
        val displayed = displayedCostKeep?.also { require(it.matches(Regex("0|[1-9][0-9]*"))) { "Invalid finish price" } }
        val consent = if (free || displayed == null || displayed.toBigInteger() >= frozen.maxCostKeep.toBigInteger()) frozen else frozen.copy(maxCostKeep = displayed)
        val key = newKey()
        val body = buildJsonObject {
            baseId()?.let { put("baseId", it) }; put("idempotencyKey", key)
            put("consent", ApiJson.encodeToJsonElement(FinishAllConsent.serializer(), consent))
            if (free) put("freeOffer", requireNotNull(army.freeFinishAllOffer).offer)
        }
        val intent = PendingIntent(IntentKind.TRAINING_FINISH, session.wallet, baseId(), key, TrainingFinishSpec.PATH, body, if (free) "Finish all (free)" else "Finish all", army.raw["finishAllQuote"] as? JsonObject)
        try {
            val accepted = finish.submit(intent) { hydrateTraining(intent.baseId) }
            _state.update { it.copy(message = if (free) "Your first troops are ready." else "Training finished · ${accepted.value.costKeep} KEEP") }
        } catch (error: ApiException) {
            if (error.status == 409) { runCatching { refreshArmy() }; _state.update { it.copy(message = "The finish price changed. Review the refreshed army before finishing again.") } }
            throw error
        } finally { observer.refresh(session.wallet) }
    }

    override fun dismissTrainingFinishReview() {
        trainingFinishRevision.incrementAndGet()
        _state.update { it.copy(trainingFinishReview = null) }
    }
    private fun trainingFinishCurrent(revision: Long) {
        holder.requireCurrent(session)
        check(trainingFinishRevision.get() == revision) { "The training finish view closed. Check its saved receipt." }
    }
    private fun trainingFinishScope(base: String?, generation: Long, revision: Long, admit: Boolean = true) {
        trainingFinishCurrent(revision); requireBase(base)
        check(baseGeneration() == generation) { "The selected kingdom changed. Review training again." }
        if (admit) check(heroActionsAllowed()) { "Game orders are paused. Training receipts remain available." }
    }
    private fun requireTrainingFinishReview(review: ReviewedTrainingFinishSpend) {
        trainingFinishScope(review.intent.baseId, review.generation, review.revision)
        check(_state.value.trainingFinishReview === review) { "Review the original training finish again." }
    }
    private suspend fun trainingFinishAction(block: suspend (Long) -> Unit) {
        holder.requireCurrent(session); check(trainingFinishAdmission.tryLock()) { "A training finish request is already running." }
        val revision = trainingFinishRevision.get(); val generation = baseGeneration()
        try {
            _state.update { trainingFinishCurrent(revision); it.copy(loading = true, error = null, message = null) }
            block(revision)
        } catch (error: CancellationException) { throw error }
        catch (error: Exception) {
            _state.update { if (holder.isCurrent(session) && trainingFinishRevision.get() == revision && baseGeneration() == generation) it.copy(error = error.message) else it }
            throw error
        } finally {
            _state.update { if (holder.isCurrent(session)) it.copy(loading = false) else it }
            trainingFinishAdmission.unlock()
        }
    }
    private data class TrainingFinishFresh(val army: ArmyState, val balances: JsonObject, val capabilities: JsonObject, val ticket: ArmyRead)
    private suspend fun freshTrainingFinish(base: String, generation: Long, revision: Long): TrainingFinishFresh {
        val guard = { trainingFinishScope(base, generation, revision) }
        guard(); val ticket = armyRead(base)
        refreshAccount(); guard(); requireArmyRead(ticket)
        val capabilities = api.get("/native/capabilities"); guard(); requireArmyRead(ticket)
        val balances = api.get("/balances", mapOf("baseId" to base)); guard(); requireArmyRead(ticket)
        val army = readArmy(ticket); guard()
        return TrainingFinishFresh(army, balances, capabilities, ticket)
    }
    private fun trainingFinishTerms(fresh: TrainingFinishFresh, key: String) = TrainingFinish.prepare(fresh.ticket.base, key,
        fresh.army.raw, fresh.balances, fresh.capabilities, requireNotNull(catalogue()) { "Verified game content is unavailable." })
    private fun matchTrainingFinish(intent: PendingIntent, fresh: TrainingFinishFresh) {
        val original = TrainingFinishSpec.exact(intent)
        val current = trainingFinishTerms(fresh, original.idempotencyKey)
        check(current.baseId == original.baseId && current.queue.all { it in original.queue } &&
            current.maxCostKeep.toBigInteger() <= original.maxCostKeep.toBigInteger()) { "Training queue or price changed. Keep the original receipt." }
        // Natural completion may shrink the queue and lower the cost. The server proves why rows
        // disappeared; the submitted command always retains its complete original consent.
        ExactGameCurrency.requireCovered(original.expectedCurrency, current.maxCostKeep, fresh.balances)
    }
    override suspend fun reviewTrainingFinish() {
        dismissTrainingFinishReview()
        trainingFinishAction { revision ->
            check(finish.blocking(session.wallet) == null) { "Check the interrupted training finish before another payment." }
            val base = requireNotNull(baseId()); val generation = baseGeneration()
            val fresh = freshTrainingFinish(base, generation, revision)
            val intent = TrainingFinishSpec.intent(session.wallet, trainingFinishTerms(fresh, newKey()))
            val review = ReviewedTrainingFinishSpend(intent, generation, revision)
            publishArmy(fresh.ticket, fresh.army, { trainingFinishScope(base, generation, revision) }) { it.copy(trainingFinishReview = review) }
        }
    }
    override suspend fun reviewTrainingFinishSaved() {
        dismissTrainingFinishReview()
        trainingFinishAction { revision ->
            val original = finish.pending(session.wallet) ?: return@trainingFinishAction
            check(original.expectedCurrency != null) { "Use the saved legacy training recovery." }
            // Recovery is independent of feature availability and never starts another POST.
            finish.observe(session.wallet) { hydrateTrainingFinishReceipt(requireNotNull(finish.pending(session.wallet))) }
            trainingFinishCurrent(revision)
            val saved = finish.pending(session.wallet) ?: return@trainingFinishAction
            check(saved.expectedCurrency != null && saved.receipt == null) { "Use the saved legacy training recovery." }
            val base = requireNotNull(saved.baseId); val generation = baseGeneration()
            val fresh = freshTrainingFinish(base, generation, revision); matchTrainingFinish(saved, fresh)
            val review = ReviewedTrainingFinishSpend(saved, generation, revision)
            publishArmy(fresh.ticket, fresh.army, { trainingFinishScope(base, generation, revision) }) { it.copy(trainingFinishReview = review) }
        }
    }
    override suspend fun confirmTrainingFinish() = trainingFinishAction { _ ->
        val review = requireNotNull(_state.value.trainingFinishReview) { "Review the training finish first." }
        val guard = { requireTrainingFinishReview(review) }
        try {
            guard()
            val fresh = freshTrainingFinish(requireNotNull(review.intent.baseId), review.generation, review.revision)
            matchTrainingFinish(review.intent, fresh); guard(); requireArmyRead(fresh.ticket)
            val hydrate: suspend (Receipt.Accepted<FinishAcceptance>) -> Unit = { guard(); hydrateTrainingFinishReceipt(review.intent, guard) }
            if (review.intent.attempted) finish.retry(session.wallet, hydrate) else finish.submit(review.intent, hydrate)
        } finally { dismissTrainingFinishReview(); observer.refresh(session.wallet) }
    }
    private suspend fun hydrateTrainingFinishReceipt(intent: PendingIntent, originalGuard: (() -> Unit)? = null) {
        TrainingFinishSpec.exact(intent)
        val revision = trainingFinishRevision.get()
        val current = { trainingFinishCurrent(revision); originalGuard?.invoke(); Unit }
        current(); refreshAccount(); current()
        val selected = baseId(); val generation = baseGeneration(); val ticket = armyRead(selected)
        val guard = { current(); trainingFinishScope(selected, generation, revision, admit = false); requireArmyRead(ticket) }
        guard()
        if (selected != null) {
            hydrateTrainingFinishHome(guard); guard()
            publishArmy(ticket, readArmy(ticket), guard) { it.copy(message = "Earlier training payment confirmed in ${intent.expectedCurrency}.") }
        } else {
            _state.update { guard(); it.copy(army = null, armyBaseId = null, armyBaseGeneration = null, message = "Earlier training payment confirmed. Select a kingdom to refresh current army and balances.") }
        }
        guard()
    }

    override fun dismissResearchReview() {
        researchRevision.incrementAndGet()
        _state.update { it.copy(researchReview = null) }
    }
    private fun researchCurrent(revision: Long) {
        holder.requireCurrent(session)
        check(researchRevision.get() == revision) { "The research view closed. Check its saved receipt." }
    }
    private fun researchScope(base: String?, generation: Long, revision: Long, admit: Boolean = true) {
        researchCurrent(revision); requireBase(base)
        check(baseGeneration() == generation) { "The selected kingdom changed. Review research again." }
        if (admit) check(heroActionsAllowed()) { "Game orders are paused. Research receipts remain available." }
    }
    private fun requireResearchReview(review: ReviewedResearchSpend) {
        researchScope(review.intent.baseId, review.generation, review.revision)
        check(_state.value.researchReview === review) { "Review the original research finish again." }
    }
    private suspend fun researchAction(block: suspend (Long) -> Unit) {
        holder.requireCurrent(session); check(researchAdmission.tryLock()) { "A research request is already running." }
        val revision = researchRevision.get(); val generation = baseGeneration()
        try {
            _state.update { researchCurrent(revision); it.copy(loading = true, error = null, message = null) }
            block(revision)
        } catch (error: CancellationException) { throw error }
        catch (error: Exception) {
            _state.update { if (holder.isCurrent(session) && researchRevision.get() == revision && baseGeneration() == generation) it.copy(error = error.message) else it }
            throw error
        } finally {
            _state.update { if (holder.isCurrent(session)) it.copy(loading = false) else it }
            researchAdmission.unlock()
        }
    }
    private data class ResearchFresh(val army: ArmyState, val balances: JsonObject, val capabilities: JsonObject, val ticket: ArmyRead)
    private suspend fun freshResearch(base: String, generation: Long, revision: Long): ResearchFresh {
        val guard = { researchScope(base, generation, revision) }
        guard(); val ticket = armyRead(base)
        refreshAccount(); guard(); requireArmyRead(ticket)
        val capabilities = api.get("/native/capabilities"); guard(); requireArmyRead(ticket)
        val balances = api.get("/balances", mapOf("baseId" to base)); guard(); requireArmyRead(ticket)
        val army = readArmy(ticket); guard()
        return ResearchFresh(army, balances, capabilities, ticket)
    }
    private fun researchTerms(fresh: ResearchFresh, troop: String, key: String) = ResearchSpeedup.prepare(troop, fresh.ticket.base, key,
        fresh.army.raw, fresh.balances, fresh.capabilities, requireNotNull(catalogue()) { "Verified game content is unavailable." })
    private fun matchResearch(intent: PendingIntent, fresh: ResearchFresh) {
        val original = ResearchSpec.exact(intent)
        val current = researchTerms(fresh, original.troop, original.idempotencyKey)
        check(current.copy(expectedCurrency = original.expectedCurrency, maxCostKeep = original.maxCostKeep) == original &&
            current.maxCostKeep.toBigInteger() <= original.maxCostKeep.toBigInteger()) { "Research episode or price changed. Keep the original receipt." }
        ExactGameCurrency.requireCovered(original.expectedCurrency, original.maxCostKeep, fresh.balances)
    }
    override suspend fun reviewResearchFinish(troop: String) {
        dismissResearchReview()
        researchAction { revision ->
            check(research.blocking(session.wallet) == null) { "Check the interrupted research before another payment." }
            val base = requireNotNull(baseId()); val generation = baseGeneration()
            val fresh = freshResearch(base, generation, revision)
            val intent = ResearchSpec.intent(session.wallet, researchTerms(fresh, troop, newKey()))
            val review = ReviewedResearchSpend(intent, generation, revision)
            publishArmy(fresh.ticket, fresh.army, { researchScope(base, generation, revision) }) { it.copy(researchReview = review) }
        }
    }
    override suspend fun reviewResearchSaved() {
        dismissResearchReview()
        researchAction { revision ->
            // Recovery is independent of feature availability and never starts another POST.
            research.observe(session.wallet) { hydrateResearchReceipt(requireNotNull(research.pending(session.wallet))) }
            researchCurrent(revision)
            val saved = research.pending(session.wallet) ?: return@researchAction
            check(saved.expectedCurrency != null && saved.receipt == null) { "Use the saved legacy research recovery." }
            val base = requireNotNull(saved.baseId); val generation = baseGeneration()
            val fresh = freshResearch(base, generation, revision); matchResearch(saved, fresh)
            val review = ReviewedResearchSpend(saved, generation, revision)
            publishArmy(fresh.ticket, fresh.army, { researchScope(base, generation, revision) }) { it.copy(researchReview = review) }
        }
    }
    override suspend fun confirmResearchFinish() = researchAction { _ ->
        val review = requireNotNull(_state.value.researchReview) { "Review the research finish first." }
        val guard = { requireResearchReview(review) }
        try {
            guard()
            val fresh = freshResearch(requireNotNull(review.intent.baseId), review.generation, review.revision)
            matchResearch(review.intent, fresh); guard(); requireArmyRead(fresh.ticket)
            val hydrate: suspend (Receipt.Accepted<ResearchAcceptance>) -> Unit = { guard(); hydrateResearchReceipt(review.intent, guard) }
            if (review.intent.attempted) research.retry(session.wallet, hydrate) else research.submit(review.intent, hydrate)
        } finally { dismissResearchReview(); observer.refresh(session.wallet) }
    }
    private suspend fun hydrateResearchReceipt(intent: PendingIntent, originalGuard: (() -> Unit)? = null) {
        ResearchSpec.exact(intent)
        val revision = researchRevision.get()
        val current = { researchCurrent(revision); originalGuard?.invoke(); Unit }
        current(); refreshAccount(); current()
        val selected = baseId(); val generation = baseGeneration(); val ticket = armyRead(selected)
        val guard = { current(); researchScope(selected, generation, revision, admit = false); requireArmyRead(ticket) }
        guard()
        if (selected != null) {
            hydrateResearchHome(guard); guard()
            publishArmy(ticket, readArmy(ticket), guard) { it.copy(message = "Earlier research payment confirmed in ${intent.expectedCurrency}.") }
        } else {
            _state.update { guard(); it.copy(army = null, armyBaseId = null, armyBaseGeneration = null, message = "Earlier research payment confirmed. Select a kingdom to refresh current army and balances.") }
        }
        guard()
    }

    override suspend fun submitResearch(target: JsonObject) = guarded {
        val base = requireNotNull(baseId()) { "Wait for your base to load" }
        require(target.string("baseId") == base) { "Research selection changed" }
        check(!observer.blocks(IntentKind.RESEARCH)) { "Check your interrupted research before another order" }
        hydrateTraining(base)
        val army = requireNotNull(_state.value.army)
        require(researchConsentSupported(army.raw)) { "This server has not enabled safe native research orders yet" }
        require(researchActionMatches(target, army.raw)) { "Research changed. Review the refreshed Forge before confirming." }
        val catalogue = requireNotNull(catalogue()) { "Game content is still loading" }
        val snapshot = home()
        val balances = requireNotNull(snapshot.balances?.let { buildJsonObject { put("shards", it.shards); put("keep", it.keep) } })
        val row = army.research.firstOrNull { it.troop == target.string("troop") }
        when (target.string("action")) {
            "start" -> {
                val choice = researchChoices(catalogue, requireNotNull(snapshot.base).raw, army.raw, balances).single { it.troop == target.string("troop") }
                require(choice.reason == null && choice.cost.toString() == target.string("price")) { "Research eligibility or price changed. Review the Forge." }
            }
            "cancel" -> require(row?.canCancel == true && row.refundShards == target.string("price")) { "This research is no longer refundable" }
            "finish" -> {
                val price = researchSpeedupPrice(catalogue, army.raw.objects("research").first { it.string("troop") == target.string("troop") }, now())
                require(price != null && price <= requireNotNull(target.string("price")).toBigInteger() && snapshot.balances.keep.toBigInteger() >= price) { "Review the current finish price and KEEP balance" }
            }
            else -> error("Unknown research action")
        }
        val troop = requireNotNull(target.string("troop"))
        val key = newKey()
        val body = buildJsonObject { put("baseId", base); put("troop", troop); put("idempotencyKey", key); put("consent", researchConsent(target)) }
        val path = when (target.string("action")) { "start" -> "/army/research"; "finish" -> "/army/research/speedup"; else -> "/army/research/$troop/cancel" }
        val intent = PendingIntent(IntentKind.RESEARCH, session.wallet, base, key, path, body, "Research $troop", target)
        try {
            research.submit(intent) { hydrateTraining(intent.baseId) }
            _state.update { it.copy(message = "Research updated. The server's current level, queue and balances are shown.") }
        } finally { observer.refresh(session.wallet) }
    }

    // --- Saved armies (apps/api/src/game/armyPresets.ts): wallet-owned plans, never purchases ------------------
    override suspend fun refreshPresets() = guarded {
        val list = TrainingPresetList.from(api.get("/army/presets"))
        holder.requireCurrent(session); _state.update { it.copy(presets = list.presets.sortedBy { p -> p.slot }) }
    }
    override suspend fun savePreset(slot: Int, name: String, composition: List<TroopCount>) = guarded {
        val rules = requireNotNull(TrainingPresetRules.from(catalogue())) { "Saved armies need a game content update (TRAINING_PRESETS)." }
        rules.validateSlot(slot); val trimmed = rules.validateName(name)
        rules.validateComposition(composition, trainableTroops(catalogue()))
        val saved = TrainingPreset.from(api.put("/army/presets/$slot", buildJsonObject {
            put("name", trimmed); put("composition", JsonArray(composition.map { buildJsonObject { put("troop", it.troop); put("count", it.count) } }))
        }))
        holder.requireCurrent(session)
        _state.update { it.copy(presets = (it.presets.orEmpty().filter { p -> p.slot != saved.slot } + saved).sortedBy { p -> p.slot }) }
    }
    override suspend fun deletePreset(slot: Int) = guarded {
        requireNotNull(TrainingPresetRules.from(catalogue())) { "Saved armies need a game content update (TRAINING_PRESETS)." }.validateSlot(slot)
        api.delete("/army/presets/$slot")
        holder.requireCurrent(session)
        _state.update { it.copy(presets = it.presets.orEmpty().filter { p -> p.slot != slot }) }
    }
    override suspend fun quotePrevious() = guarded {
        val base = requireNotNull(baseId()) { "Wait for your base to load" }
        val previous = PreviousArmy.from(api.get("/army/previous", mapOf("baseId" to base)))
        holder.requireCurrent(session)
        if (previous.composition.isEmpty()) _state.update { it.copy(message = previous.message ?: "No troops in the previous attack.") }
        else quoteDraft(ArmyTrainingDraft.ofPlan(session.wallet, base, previous.composition))
    }

    private fun requireHeroScope(selected: String?, generation: Long?) {
        requireBase(selected)
        check(generation == null || generation == baseGeneration()) { "The selected base changed. Review your Hero again." }
    }
    private fun requireHeroAdmissionScope(selected: String?, generation: Long) {
        requireHeroScope(selected, generation)
        if (!heroActionsAllowed()) {
            dismissHeroReview()
            error("Hero payments are temporarily unavailable. Keep the original receipt for recovery.")
        }
    }
    private fun requireHeroAdmission() {
        check(heroUpgrade.blocking(session.wallet) == null && heroRecovery.blocking(session.wallet) == null) {
            "Check the interrupted Hero payment before starting another."
        }
    }
    private suspend fun freshHeroTerms(selected: String, generation: Long): Pair<HeroRoster, JsonObject> {
        requireHeroAdmissionScope(selected, generation)
        refreshAccount()
        requireHeroAdmissionScope(selected, generation)
        val capabilities = api.get("/native/capabilities")
        requireHeroAdmissionScope(selected, generation)
        val support = ((capabilities["economy"] as? JsonObject)?.get("gameCurrency") as? JsonObject)
        check(support?.get("version") == JsonPrimitive(1) && support["exactSpendCurrency"] == JsonPrimitive(1)) {
            "Hero currency confirmation needs a server update."
        }
        val balances = api.get("/balances", mapOf("baseId" to selected))
        requireHeroAdmissionScope(selected, generation)
        val roster = HeroRoster.from(api.get("/heroes", mapOf("baseId" to selected)))
        requireHeroAdmissionScope(selected, generation)
        check(roster.heroConsentSupported && (roster.features?.get("heroReceipts") as? JsonObject)?.get("version") == JsonPrimitive(1)) {
            "Hero payments need original receipt support. Refresh after the server update."
        }
        return roster to balances
    }
    private suspend fun heroAction(block: suspend () -> Unit) {
        check(heroAdmission.tryLock()) { "A Hero payment is already being reviewed." }
        try { guarded(block) } finally { heroAdmission.unlock() }
    }
    override fun dismissHeroReview() {
        heroReviewRevision++
        _state.update { it.copy(heroReview = null) }
    }
    override suspend fun reviewHeroUpgrade(hero: String) = reviewHero(hero, recovery = false)
    override suspend fun reviewHeroRecovery(hero: String) = reviewHero(hero, recovery = true)
    private suspend fun reviewHero(hero: String, recovery: Boolean) = heroAction {
        dismissHeroReview()
        val revision = heroReviewRevision
        requireHeroAdmission()
        val selected = requireNotNull(baseId()) { "Select an owned kingdom before reviewing a Hero payment." }
        val generation = baseGeneration()
        val (roster, balances) = freshHeroTerms(selected, generation)
        val row = requireNotNull(roster.heroes.firstOrNull { it.hero == hero }) { "This Hero is unavailable." }
        check(row.recruited) { "Recruit this Hero first." }
        val cost = if (recovery) requireNotNull(row.recoveryFinishNow?.costKeep) { "This Hero is not recovering." }
            else requireNotNull(row.next?.costKeep) { "This Hero has no next level." }
        val currency = ExactGameCurrency.choose(cost, balances)
        val intent = if (recovery) HeroRecoverySpec.intent(session.wallet, selected, hero, newKey(), cost,
            requireNotNull(row.recoveryUntil), currency.name)
        else HeroUpgradeSpec.intent(session.wallet, selected, hero, newKey(), requireNotNull(row.next).level, cost, currency.name)
        requireHeroAdmissionScope(selected, generation)
        check(revision == heroReviewRevision) { "The Hero review was dismissed. Review again to pay." }
        heroesBaseId = selected
        _state.update { it.copy(heroes = roster, heroesBaseId = selected, heroReview = ReviewedHeroSpend(intent, generation)) }
    }
    override suspend fun confirmHeroSpend() = heroAction {
        val reviewed = requireNotNull(_state.value.heroReview) { "Review your Hero payment first." }
        val intent = reviewed.intent
        try {
            requireHeroAdmission()
            val selected = requireNotNull(intent.baseId)
            val (roster, balances) = freshHeroTerms(selected, reviewed.generation)
            val row = requireNotNull(roster.heroes.firstOrNull { it.hero == intent.quote?.string("hero") })
            val ceiling = requireNotNull(intent.quote?.string("costKeep"))
            if (intent.kind == IntentKind.HERO_UPGRADE) {
                val next = requireNotNull(row.next) { "This Hero has no next level." }
                check(row.recruited && next.level == HeroUpgradeSpec.level(intent) && next.costKeep == ceiling) {
                    "The Hero level or price changed. Review again."
                }
            } else {
                val cost = requireNotNull(row.recoveryFinishNow?.costKeep) { "This Hero has already recovered." }
                check(row.recoveryUntil == HeroRecoverySpec.recoveryUntil(intent) && cost.toBigInteger() <= ceiling.toBigInteger()) {
                    "The Hero recovery episode or price changed. Review again."
                }
            }
            ExactGameCurrency.requireCovered(GameCurrency.valueOf(requireNotNull(intent.expectedCurrency)), ceiling, balances)
            requireHeroAdmissionScope(selected, reviewed.generation)
            check(_state.value.heroReview == reviewed) { "The Hero review was dismissed. Review again to pay." }
            // MoneyOp durably saves the immutable key/body/currency before its request-local transport runs.
            if (intent.kind == IntentKind.HERO_UPGRADE) heroUpgrade.submit(intent) {
                requireHeroScope(selected, reviewed.generation)
                hydrateHeroReceipt(intent, it.document, reviewed.generation)
                requireHeroScope(selected, reviewed.generation)
            } else heroRecovery.submit(intent) {
                requireHeroScope(selected, reviewed.generation)
                hydrateHeroReceipt(intent, it.document, reviewed.generation)
                requireHeroScope(selected, reviewed.generation)
            }
            requireHeroScope(selected, reviewed.generation)
            _state.update { it.copy(message = "Hero payment confirmed in ${intent.expectedCurrency}.") }
        } finally {
            dismissHeroReview()
            observer.refresh(session.wallet)
        }
    }

    // --- Heroes (apps/api/src/game/heroes.ts): every price comes from the roster row the player tapped ---------
    override suspend fun upgradeHero(hero: String, level: Int, costKeep: String) = guarded {
        requireBase(heroesBaseId)
        check(!observer.blocks(IntentKind.HERO_UPGRADE)) { "Check the interrupted hero upgrade before buying another level." }
        check(_state.value.heroes?.heroConsentSupported == true) { "Hero purchases need a server update. Refresh the roster when the update is available." }
        val row = requireNotNull(_state.value.heroes?.heroes?.firstOrNull { it.hero == hero }) { "Load your heroes first" }
        val next = requireNotNull(row.next) { "${row.name} is at the maximum level" }
        require(row.recruited) { "Recruit ${row.name} first — build the ${row.altar ?: "altar"} (Keep level ${row.unlockKeepLevel ?: "—"})" }
        require(next.level == level && next.costKeep == costKeep) { "The hero price changed. Review the roster again." }
        val intent = HeroUpgradeSpec.intent(session.wallet, baseId(), hero, newKey(), level, costKeep)
        try {
            val accepted = heroUpgrade.submit(intent) { hydrateRoster(intent.baseId) }
            _state.update { it.copy(message = "${hero.uppercase()} → L${accepted.value.level}${accepted.value.tierName?.let { t -> " · ${t.uppercase()}" } ?: ""}") }
        } finally { observer.refresh(session.wallet) }
    }
    override suspend fun recoverHero(hero: String, costKeep: String, recoveryUntil: String) = guarded {
        requireBase(heroesBaseId)
        check(!observer.blocks(IntentKind.HERO_RECOVERY)) { "Check the interrupted hero recovery before paying again." }
        check(_state.value.heroes?.heroConsentSupported == true) { "Hero purchases need a server update. Refresh the roster when the update is available." }
        val row = requireNotNull(_state.value.heroes?.heroes?.firstOrNull { it.hero == hero }) { "Load your heroes first" }
        val finish = requireNotNull(row.recoveryFinishNow) { "${row.name} is not recovering" }
        require(finish.costKeep == costKeep && row.recoveryUntil == recoveryUntil) { "The recovery price changed. Review the roster again." }
        val intent = HeroRecoverySpec.intent(session.wallet, baseId(), hero, newKey(), costKeep, recoveryUntil)
        try {
            heroRecovery.submit(intent) { hydrateRoster(intent.baseId) }
            _state.update { it.copy(message = "${hero.uppercase()} RECOVERED") }
        } finally { observer.refresh(session.wallet) }
    }

    // --- Items (apps/api/src/game/items.ts) ------------------------------------------------------------------
    override suspend fun buyItem(itemId: String) = guarded {
        requireBase(inventoryBaseId)
        check(!observer.blocks(IntentKind.ITEM_BUY)) { "Check the interrupted purchase before buying another item." }
        val item = requireNotNull(_state.value.inventory?.item(itemId)) { "Open the shop first" }
        require(!item.dropOnly && item.acquisition?.type != "drop") { "this item is forged, not sold — win it from the Gold Forge" }
        val cost = requireNotNull(item.costKeep) { "This item has no price" }
        // night/server 231e6cff9: where the server records consented purchases, the purchase freezes the price the player saw
        // and the exact currency (the same rule the server charges by), so a lost reply can be read back by its key.
        val inventory = requireNotNull(_state.value.inventory)
        val selected = baseId()
        val balances = if (inventory.itemPurchaseReceipts && inventory.catalogRevision != null)
            api.get("/balances", selected?.let { mapOf("baseId" to it) }.orEmpty()).also { requireBase(selected) } else null
        val intent = if (balances != null && ExactGameCurrency.supported(balances))
            ItemBuySpec.consentedIntent(session.wallet, selected, itemId, newKey(), cost, item.name.orEmpty(),
                requireNotNull(inventory.catalogRevision), ExactGameCurrency.choose(cost, balances).name)
        else ItemBuySpec.intent(session.wallet, selected, itemId, newKey(), cost, item.name.orEmpty())
        try {
            itemPurchase.submit(intent) { hydrateInventory(intent.baseId) }
            _state.update { it.copy(message = "ITEM ADDED TO INVENTORY") }
        } finally { observer.refresh(session.wallet) }
    }
    override suspend fun useItem(itemId: String, jobId: String?) = guarded {
        requireBase(inventoryBaseId)
        check(!observer.blocks(IntentKind.ITEM_USE)) { "The last item use is unverified. Check it before using another item." }
        val inventory = requireNotNull(_state.value.inventory) { "Open your inventory first" }
        val item = requireNotNull(inventory.item(itemId)) { "Unknown item" }
        require(item.kind == "consumable" && inventory.stored(itemId) > 0 && item.activation?.active != true) { "This item cannot be used now" }
        require(item.activation?.kind != "hero") { "a hero contract is used by placing the hero's altar (BUILD ▸ HEROES)" }
        val intent = ItemUseSpec.intent(session.wallet, baseId(), itemId, newKey(), item.name.orEmpty(), jobId)
        try {
            val accepted = itemUse.submit(intent) { hydrateInventory(intent.baseId) }
            _state.update { it.copy(message = "${item.name ?: itemId} used${accepted.value.left?.let { left -> " · $left left" } ?: ""}") }
        } finally { observer.refresh(session.wallet) }
    }
    /** Equipment writes are optimistic on `expectedVersion`; a stale version must refresh the authoritative
     * loadout or every retry would resend the same version (web inventory.tsx `act`). */
    override suspend fun equip(hero: String, slot: String, itemId: String?, expectedVersion: Int) = guarded {
        requireBase(inventoryBaseId)
        val inventory = requireNotNull(_state.value.inventory) { "Open your inventory first" }
        val loadout = requireNotNull(inventory.loadout(hero)) { "Unknown hero" }
        require(loadout.version == expectedVersion) { "Inventory changed elsewhere. Refresh and try again." }
        if (itemId != null) {
            val item = requireNotNull(inventory.item(itemId)) { "Unknown item" }
            require(item.kind == "gear" && item.slot == slot) { "item does not fit $slot" }
            require(loadout.recruited) { "hero is not recruited" }
        }
        try {
            EquipResult.from(api.put("/heroes/$hero/equipment/$slot", body(buildJsonObject { put("itemId", itemId?.let(::JsonPrimitive) ?: JsonNull); put("expectedVersion", expectedVersion) })))
        } catch (error: ApiException) {
            if (error.status == 409) { hydrateInventory(); _state.update { it.copy(message = "Inventory changed elsewhere. Refreshed — try again.") } }
            throw error
        }
        hydrateInventory()
    }
    override suspend fun markItemSeen(itemId: String) {
        holder.requireCurrent(session)
        val current = _state.value.inventory ?: return
        val selected = inventoryBaseId
        requireBase(selected)
        if (current.seen(itemId) || current.item(itemId) == null) return
        runCatching { api.post("/items/$itemId/seen", body()) }.onSuccess {
            runCatching { Inventory.from(api.get("/items", query())) }.getOrNull()?.let { fresh -> requireBase(selected); _state.update { it.copy(inventory = fresh) } }
        }
    }

    override fun clearNotice() { _state.update { it.copy(error = null, message = null) } }

    private suspend fun guarded(block: suspend () -> Unit) {
        holder.requireCurrent(session)
        _state.update { it.copy(loading = true, error = null, message = null) }
        try { block() }
        catch (error: CancellationException) { throw error }
        catch (error: Exception) {
            if (holder.isCurrent(session)) _state.update { it.copy(error = error.message ?: "Connection interrupted. Please retry.") }
            throw error
        } finally { if (holder.isCurrent(session)) _state.update { it.copy(loading = false) } }
    }
}
