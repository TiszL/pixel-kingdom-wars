package gg.pixelkingdomwars.nativeclient.ops

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext

/** A saved intent whose outcome the player must resolve before repeating that kind of request. */
data class InterruptedIntent(val intent: PendingIntent, val lastObservation: Receipt<*>? = null,
    /** Set by the [ReceiptObserver] from the registered spec ([MoneyOpSpec.forgetsOnServerAbsent]). */
    val forgetsOnClose: Boolean = false,
    /** Set by the [ReceiptObserver]: false once the request no longer refuses a new order of its kind ([supersedable]): it
     * stays shown with RETRY CHECK. Unregistered kinds stay blocking. */
    val blocking: Boolean = true,
    /** A request kept on this device out of the active slot (owner review 2026-10-06, B1/M2): a newer order parked it. It
     * is shown, never blocks, offers RETRY CHECK only, and every Home resume re-reads it so a late acceptance surfaces. */
    val kept: Boolean = false,
    /** Set by the [ReceiptObserver] from the persisted facts and the minimum age ([closableRequest]); null for a bare
     * value (tests, previews), which then offers CLOSE only for a never-sent request or training's server closure. */
    val closeOffered: Boolean? = null) {
    val kind: String get() = intent.kind
    val proven: Boolean get() = intent.receipt != null
    /** CLOSE: a never-sent request (the attempted flag is durable before any byte leaves); or, once its last attempt is old
     * enough, a server `absent` answer for this key, or an `unknown` a day old ([archivable]: archived on this device,
     * re-read on resume); or training's own server closure on `unknown`. A kept request only through [closeOffered]. */
    val closable: Boolean get() = closeOffered ?: (!kept && intent.receipt == null && (!intent.attempted ||
        (lastObservation == Receipt.Unknown || lastObservation == Receipt.Absent) && intent.kind == IntentKind.TRAINING_BATCH))
    /** Kinds the server replays idempotently for the same body: cancellation, construction, wall rows and layout unlocks by
     * key, a land reservation by wallet and purchase kind (one pending reservation per wallet), and the
     * item operations by their namespaced keys (`item:`, `use:` in
     * apps/api/src/game/{heroes,items}.ts) — a replay answers `duplicate` and moves nothing twice. */
    val retryable: Boolean get() = !kept && (intent.attempted && intent.receipt == null && intent.kind in setOf(IntentKind.TRAINING_CANCEL, IntentKind.CONSTRUCTION, IntentKind.LAND_RESERVATION, IntentKind.WALL_ROW, IntentKind.LAYOUT_UNLOCK,
        IntentKind.ITEM_BUY, IntentKind.ITEM_USE, IntentKind.MARKET_LIST, IntentKind.MARKET_RESERVE, IntentKind.MARKET_CANCEL)
        // A crash can occur between durable creation and the attempted marker. The same v1 key
        // is still explicitly retryable; legacy clan requests never sent a key and stay excluded.
        || (intent.receipt == null && intent.kind in setOf(IntentKind.CLAN_LEAVE, IntentKind.CLAN_KICK) && runCatching {
            ClanCommandSpec(intent.kind, gg.pixelkingdomwars.nativeclient.model.ClanCommandContract.text(requireNotNull(intent.quote), "cluster")).validate(intent)
        }.isSuccess)
        || (intent.receipt == null && intent.kind == IntentKind.FORGE_CLAIM && runCatching {
            ForgeClaimSpec(gg.pixelkingdomwars.nativeclient.model.ForgeClaimContract.text(requireNotNull(intent.quote), "cluster")).validate(intent)
        }.isSuccess))
}

/** Publishes every interrupted intent of the signed-in wallet (and the kept ones, B1) and drives GET-only observation
 * through the registered operations. One instance per account scope; it never POSTs. */
class ReceiptObserver(private val store: PendingIntentStore, private val clock: () -> Long = System::currentTimeMillis) {
    private val checks = mutableMapOf<String, suspend (String) -> Receipt<*>?>()
    private val closes = mutableMapOf<String, suspend (String) -> Receipt<*>?>()
    private val retries = mutableMapOf<String, suspend (String) -> Receipt<*>?>()
    private val keptChecks = mutableMapOf<String, suspend (PendingIntent) -> Receipt<*>>()
    private val keptClosers = mutableMapOf<String, suspend (PendingIntent) -> Receipt<*>>()
    private val specs = mutableMapOf<String, MoneyOpSpec<*>>()
    private val _interrupted = MutableStateFlow<List<InterruptedIntent>>(emptyList())
    val interrupted: StateFlow<List<InterruptedIntent>> = _interrupted.asStateFlow()

    fun <T> register(op: MoneyOp<T>, hydrate: suspend (Receipt.Accepted<T>) -> Unit) {
        specs[op.spec.kind] = op.spec
        checks[op.spec.kind] = { wallet -> op.observe(wallet, hydrate) }
        closes[op.spec.kind] = { wallet -> op.close(wallet, confirmed = true, hydrate) }
        retries[op.spec.kind] = { wallet -> op.retry(wallet, hydrate) }
        keptChecks[op.spec.kind] = { kept -> op.observeKept(kept, hydrate) }
        keptClosers[op.spec.kind] = { kept -> op.closeKept(kept, hydrate) }
    }

    /** Re-reads the journal; call after sign-in, base switch and every money operation. */
    suspend fun refresh(wallet: String) {
        val now = clock()
        val (saved, parked) = withContext(Dispatchers.IO) {
            store.all(wallet).map { it to store.facts(it) } to store.parked(wallet).map { it to store.facts(it) }
        }
        // An observation belongs to the exact saved key: a newer request of the same kind never inherits it.
        fun previous(intent: PendingIntent) = _interrupted.value.firstOrNull {
            it.intent.identity == intent.identity && it.intent.idempotencyKey == intent.idempotencyKey }?.lastObservation
        _interrupted.value = saved.map { (intent, facts) -> describe(intent, facts, factsAnswer(facts) ?: previous(intent), now) } +
            parked.map { (intent, facts) -> InterruptedIntent(intent, factsAnswer(facts) ?: previous(intent), blocking = false, kept = true,
                closeOffered = archivable(specs[intent.kind], intent, facts, now)) }
    }

    private fun describe(intent: PendingIntent, facts: SavedRequestFacts, observation: Receipt<*>?, now: Long): InterruptedIntent {
        val spec = specs[intent.kind] ?: return InterruptedIntent(intent, observation)
        return InterruptedIntent(intent, observation,
            forgetsOnClose = runCatching { spec.forgetsOnServerAbsent(intent) }.getOrDefault(false),
            blocking = !supersedable(spec, intent, facts, now),
            closeOffered = closableRequest(spec, intent, facts, now))
    }

    /** True while a saved request of [kind] still refuses a new one (owner 2026-10-06: never forever, see [supersedable]). */
    fun blocks(kind: String): Boolean = _interrupted.value.any { it.kind == kind && it.blocking }

    /** RETRY CHECK: the active request of [kind] and every kept request of that kind are read again (GET-only). */
    suspend fun check(kind: String, wallet: String): Receipt<*>? {
        val active = withContext(Dispatchers.IO) { store.get(kind, wallet) }
        val result = if (active != null || checks[kind] == null) run(kind, wallet, requireNotNull(checks[kind]) { "No observer for $kind" }) else null
        val late = recheckKept(wallet, kind)
        return result ?: late.firstOrNull { it.second is Receipt.Accepted }?.second ?: late.firstOrNull()?.second
    }
    /** CLOSE of [kind]: every kept request of that kind CLOSE may archive ([archivable], read once more first), then the
     * active request's own close (owner 2026-10-06: two saved placements of one kind each need their way out). */
    suspend fun close(kind: String, wallet: String): Receipt<*>? {
        val closer = requireNotNull(closes[kind]) { "No closer for $kind" }
        val kept = closeKept(kind, wallet)
        val active = withContext(Dispatchers.IO) { store.get(kind, wallet) } ?: return kept
        // The CLOSE tapped was a kept request's: an active one that offers no CLOSE of its own is left alone.
        if (kept != null && _interrupted.value.none { it.intent == active && !it.kept && it.closable }) return kept
        return run(kind, wallet, closer)
    }

    private suspend fun closeKept(kind: String, wallet: String): Receipt<*>? {
        val closer = keptClosers[kind] ?: return null
        val spec = specs[kind]; val now = clock()
        val eligible = withContext(Dispatchers.IO) {
            store.parked(wallet).filter { it.kind == kind && archivable(spec, it, store.facts(it), now) }
        }
        if (eligible.isEmpty()) return null
        var last: Receipt<*>? = null
        for (intent in eligible) last = try { closer(intent) }
            catch (error: kotlinx.coroutines.CancellationException) { throw error } catch (_: Exception) { last }
        refresh(wallet)
        return last
    }

    /** Milliseconds until the active request of [kind] can be settled by a read ([SAVED_REQUEST_MIN_AGE_MS] after its last
     * send), or null when it needs no wait: Home re-checks then, so a door opens without a tap. */
    suspend fun msUntilSettled(kind: String, wallet: String): Long? = withContext(Dispatchers.IO) {
        val saved = store.get(kind, wallet)?.takeIf { it.attempted && it.receipt == null } ?: return@withContext null
        val facts = store.facts(saved)
        if (answeredSettled(facts)) null else (lastSendMs(facts) + SAVED_REQUEST_MIN_AGE_MS - clock()).coerceAtLeast(0)
    }
    suspend fun retry(kind: String, wallet: String): Receipt<*>? = run(kind, wallet, requireNotNull(retries[kind]) { "No retry for $kind" })

    /** Owner review 2026-10-06 (M2): re-reads every kept request (parked or closed) of registered kinds, or of [kind] only.
     * A late acceptance is hydrated and released; the caller announces it. A read that fails leaves the record kept. */
    suspend fun recheckKept(wallet: String, kind: String? = null): List<Pair<PendingIntent, Receipt<*>>> {
        val kept = withContext(Dispatchers.IO) { store.kept(wallet) }.map { it.intent }.filter { (kind == null || it.kind == kind) && it.kind in keptChecks }
        val answers = kept.mapNotNull { intent ->
            try { intent to requireNotNull(keptChecks[intent.kind])(intent) }
            catch (error: kotlinx.coroutines.CancellationException) { throw error }
            catch (_: Exception) { null }
        }
        refresh(wallet)
        return answers
    }

    private suspend fun run(kind: String, wallet: String, action: suspend (String) -> Receipt<*>?): Receipt<*>? {
        val result = try { action(wallet) } finally { refresh(wallet) }
        _interrupted.value = _interrupted.value.map { if (it.kind == kind && !it.kept) it.copy(lastObservation = result) else it }
        return result
    }
}
