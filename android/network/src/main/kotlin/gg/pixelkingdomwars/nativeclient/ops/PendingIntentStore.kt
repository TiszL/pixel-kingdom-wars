package gg.pixelkingdomwars.nativeclient.ops

import gg.pixelkingdomwars.nativeclient.network.SecretStore
import kotlinx.serialization.json.*

/** The four pre-shell per-operation journals. Each is read once, decoded into [PendingIntent]s,
 * written into the unified journal and only then cleared, so an interrupted request saved by an
 * older build still recovers through its receipt route after the upgrade. */
class LegacyPendingStores(
    val training: SecretStore? = null,
    val construction: SecretStore? = null,
    val cancellation: SecretStore? = null,
    val research: SecretStore? = null,
)

/** What this device knows about one saved request beyond its frozen terms (owner 2026-10-06 dead-end rules). It lives
 * beside the intents in the journal ("facts"), so an older build that reads the journal ignores it and a PendingIntent's
 * own bytes never change. [attemptedAtMs]: wall clock of the last dispatch (null for requests sent by an older build).
 * [answer]: the last server read that was not an acceptance ("unknown", "absent" or "unsupported"). [retryRefused]: an
 * explicit retry got a coded refusal the spec proves is raised after the server's key lookup. */
data class SavedRequestFacts(val attemptedAtMs: Long? = null, val answer: String? = null, val answeredAtMs: Long? = null,
    val retryRefused: Boolean = false) {
    companion object {
        const val UNKNOWN = "unknown"
        const val ABSENT = "absent"
        const val UNSUPPORTED = "unsupported"
    }
}

/** A request out of the active slot, kept on this device and never sent again: [closed] after CLOSE (archived, hidden,
 * still re-read so a late acceptance surfaces), otherwise parked by a newer order of its kind (shown, never blocking). */
data class KeptIntent(val intent: PendingIntent, val closed: Boolean)

/** One encrypted journal for every money operation. Malformed or unreadable content fails closed:
 * it is never treated as "nothing pending" and never overwritten by a fresh intent. */
class PendingIntentStore(private val store: SecretStore, private val legacy: LegacyPendingStores? = null) {
    private var migrated = false

    /** The parsed journal object, or null when nothing is saved. */
    private fun document(): JsonObject? = store.read()?.let { Json.parseToJsonElement(it).jsonObject }

    /** A saved intent of a kind this build does not know (a later build's, or one a later build retired): kept verbatim and
     * written back unchanged, never decoded, so it can neither break this journal nor be lost by it. */
    private fun foreign(raw: JsonElement): Boolean {
        val kind = ((raw as? JsonObject)?.get("kind") as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return false
        return kind !in IntentKind.all
    }

    private fun entries(): List<PendingIntent> {
        val value = document()
        val current = if (value == null) emptyList() else {
            require(value["schemaVersion"] == JsonPrimitive(SCHEMA_VERSION)) { "Saved requests need a compatible client" }
            val list = requireNotNull(value["intents"] as? JsonArray) { "Saved requests are malformed" }
            list.filterNot(::foreign).map { raw ->
                // Kotlin's number decoder may coerce quoted primitives. Journal generations must
                // be canonical JSON integers; malformed/overflowing values never reset to zero.
                (raw as? JsonObject)?.get("attemptRevision")?.let { value ->
                    val primitive = value as? JsonPrimitive
                    val revision = primitive?.takeUnless { it.isString }?.longOrNull
                    require(revision != null && revision >= 0 && primitive.content == revision.toString()) { "Saved dispatch revision is malformed" }
                }
                Json.decodeFromJsonElement<PendingIntent>(raw)
            }.also { intents ->
                require(intents.map { it.identity }.distinct().size == intents.size) { "Saved requests are malformed" }
            }
        }
        if (migrated || legacy == null) return current
        val inherited = LegacyPendingIntents.decodeAll(legacy)
        if (inherited.isEmpty()) { migrated = true; return current }
        val merged = current.toMutableList()
        for (intent in inherited) {
            val existing = merged.firstOrNull { it.identity == intent.identity }
            if (existing == null) merged.add(intent)
            else require(existing.idempotencyKey == intent.idempotencyKey) { "Conflicting saved ${intent.kind} requests; recover them before continuing" }
        }
        write(merged)
        // Clearing after the unified write: a crash in between leaves both copies, which the
        // same-key rule above reconciles on the next read.
        listOfNotNull(legacy.training, legacy.construction, legacy.cancellation, legacy.research).forEach { it.clear() }
        migrated = true
        return merged
    }

    private fun foreignEntries(): List<JsonElement> = (document()?.get("intents") as? JsonArray).orEmpty().filter(::foreign)

    /** Kept requests; the "parked" list an earlier build of this branch wrote is read as parked (not closed). */
    private fun keptEntries(): List<KeptIntent> {
        val value = document() ?: return emptyList()
        val kept = (value["kept"] as? JsonArray).orEmpty().filterNot { foreign((it as? JsonObject)?.get("intent") ?: JsonNull) }.map { raw ->
            val row = requireNotNull(raw as? JsonObject) { "Saved requests are malformed" }
            KeptIntent(Json.decodeFromJsonElement<PendingIntent>(requireNotNull(row["intent"])), row["closed"] == JsonPrimitive(true))
        }
        val parked = (value["parked"] as? JsonArray).orEmpty().filterNot(::foreign).map { KeptIntent(Json.decodeFromJsonElement<PendingIntent>(it), closed = false) }
        return kept + parked.filter { p -> kept.none { it.intent.idempotencyKey == p.intent.idempotencyKey && it.intent.kind == p.intent.kind } }
    }

    private fun factsEntries(): Map<String, SavedRequestFacts> {
        val facts = document()?.get("facts") as? JsonObject ?: return emptyMap()
        return facts.mapNotNull { (id, raw) -> (raw as? JsonObject)?.let { row ->
            id to SavedRequestFacts(
                (row["attemptedAt"] as? JsonPrimitive)?.takeUnless { it.isString }?.longOrNull,
                (row["answer"] as? JsonPrimitive)?.takeIf { it.isString }?.content,
                (row["answeredAt"] as? JsonPrimitive)?.takeUnless { it.isString }?.longOrNull,
                row["retryRefused"] == JsonPrimitive(true))
        } }.toMap()
    }

    private fun factsId(intent: PendingIntent) = "${intent.kind} ${intent.wallet} ${intent.idempotencyKey}"

    private fun write(intents: List<PendingIntent>, kept: List<KeptIntent> = keptEntries(), facts: Map<String, SavedRequestFacts> = factsEntries()) {
        val foreign = foreignEntries()
        val live = (intents.map(::factsId) + kept.map { factsId(it.intent) }).toSet()
        val usedFacts = facts.filterKeys { it in live }
        if (intents.isEmpty() && kept.isEmpty() && foreign.isEmpty()) store.clear()
        else store.write(buildJsonObject {
            put("schemaVersion", SCHEMA_VERSION)
            put("intents", JsonArray(intents.map { Json.encodeToJsonElement(it) } + foreign))
            if (kept.isNotEmpty()) put("kept", JsonArray(kept.map { k -> buildJsonObject { put("intent", Json.encodeToJsonElement(k.intent)); put("closed", k.closed) } }))
            if (usedFacts.isNotEmpty()) put("facts", buildJsonObject { usedFacts.forEach { (id, f) -> put(id, buildJsonObject {
                f.attemptedAtMs?.let { put("attemptedAt", it) }; f.answer?.let { put("answer", it) }
                f.answeredAtMs?.let { put("answeredAt", it) }; if (f.retryRefused) put("retryRefused", true)
            }) } })
        }.toString())
    }

    /** Requests kept on this device for [wallet] (parked and closed). */
    @Synchronized fun kept(wallet: String): List<KeptIntent> = keptEntries().filter { it.intent.wallet == wallet }
    /** Kept requests that a newer order parked (shown, never blocking). */
    @Synchronized fun parked(wallet: String): List<PendingIntent> = kept(wallet).filterNot { it.closed }.map { it.intent }
    /** Moves only the exact saved record out of the active journal, kept on this device: [closed] archives it (CLOSE),
     * otherwise it is parked so a new order of its kind can be saved. Its facts stay with it. */
    @Synchronized fun park(expected: PendingIntent, closed: Boolean = false): Boolean {
        val current = entries()
        if (current.none { it == expected }) return false
        write(current.filterNot { it == expected }, keptEntries().filterNot { it.intent.kind == expected.kind && it.intent.wallet == expected.wallet &&
            it.intent.idempotencyKey == expected.idempotencyKey }.plus(KeptIntent(expected, closed)).takeLast(PARKED_LIMIT))
        return true
    }
    /** Archives a parked record (CLOSE on a kept request the server has no record of): it stays kept, hidden, re-read. */
    @Synchronized fun archiveKept(expected: PendingIntent): Boolean {
        val kept = keptEntries()
        if (kept.none { it.intent == expected && !it.closed }) return false
        write(entries(), kept.map { if (it.intent == expected) it.copy(closed = true) else it })
        return true
    }
    /** Puts back the facts a refused retry replaced (the refused dispatch is not in flight), only for the exact saved record. */
    @Synchronized fun restoreFacts(expected: PendingIntent, facts: SavedRequestFacts): Boolean {
        val current = entries()
        if (current.none { it == expected }) return false
        write(current, keptEntries(), factsEntries() + (factsId(expected) to facts))
        return true
    }
    /** Retires a kept record (its late acceptance was surfaced). */
    @Synchronized fun releaseKept(expected: PendingIntent): Boolean {
        val kept = keptEntries()
        if (kept.none { it.intent == expected }) return false
        write(entries(), kept.filterNot { it.intent == expected })
        return true
    }

    @Synchronized fun facts(intent: PendingIntent): SavedRequestFacts = factsEntries()[factsId(intent)] ?: SavedRequestFacts()
    /** Records a dispatch (time, and a cleared refused-retry mark): an ambiguous later retry makes the outcome open again. */
    @Synchronized fun recordAttempt(intent: PendingIntent, atMs: Long) {
        val facts = factsEntries()
        write(entries(), keptEntries(), facts + (factsId(intent) to SavedRequestFacts(attemptedAtMs = atMs)))
    }
    /** Records the last server read that was not an acceptance ([SavedRequestFacts.UNKNOWN], ABSENT or UNSUPPORTED) and when
     * it answered. The dispatch time is never invented here: a request an older build sent keeps none, so it counts as sent
     * before this build ([SENT_BY_OLDER_BUILD_MS]); owner field result 2026-10-06, Seeker build 880a7e7a. */
    @Synchronized fun recordAnswer(intent: PendingIntent, answer: String, atMs: Long) {
        val facts = factsEntries(); val id = factsId(intent); val known = facts[id] ?: SavedRequestFacts()
        write(entries(), keptEntries(), facts + (id to known.copy(answer = answer, answeredAtMs = atMs)))
    }
    @Synchronized fun recordRetryRefused(intent: PendingIntent) {
        val facts = factsEntries(); val id = factsId(intent)
        write(entries(), keptEntries(), facts + (id to (facts[id] ?: SavedRequestFacts()).copy(retryRefused = true)))
    }

    @Synchronized fun get(kind: String, wallet: String): PendingIntent? {
        require(wallet.isNotBlank())
        return entries().firstOrNull { it.kind == kind && it.wallet == wallet }
    }
    @Synchronized fun all(wallet: String): List<PendingIntent> = entries().filter { it.wallet == wallet }
    /** Persists a new intent; false when this kind already has an outstanding intent for the wallet. */
    @Synchronized fun create(intent: PendingIntent): Boolean {
        val current = entries()
        if (current.any { it.identity == intent.identity }) return false
        write(current + intent)
        return true
    }
    /** Compare-and-swap on the exact saved record; a newer intent can never be overwritten by an older reply. */
    @Synchronized fun replaceIfMatching(expected: PendingIntent, replacement: PendingIntent): Boolean {
        checkReplacement(expected, replacement)
        val current = entries()
        if (current.none { it == expected }) return false
        write(current.map { if (it == expected) replacement else it })
        return true
    }
    /** The attempted marker ([replaceIfMatching]) and the dispatch time ([recordAttempt]) in ONE journal write, so a send
     * costs exactly the writes it did before the facts existed. */
    @Synchronized fun markAttempted(expected: PendingIntent, attempted: PendingIntent, atMs: Long): Boolean {
        checkReplacement(expected, attempted)
        require(attempted.attempted && attempted.receipt == null)
        val current = entries()
        if (current.none { it == expected }) return false
        write(current.map { if (it == expected) attempted else it }, keptEntries(), factsEntries() + (factsId(attempted) to SavedRequestFacts(attemptedAtMs = atMs)))
        return true
    }
    private fun checkReplacement(expected: PendingIntent, replacement: PendingIntent) {
        require(expected.identity == replacement.identity && expected.idempotencyKey == replacement.idempotencyKey)
        require(expected.expectedCurrency == replacement.expectedCurrency) { "A saved command's currency cannot change" }
        require(replacement.attemptRevision == expected.attemptRevision ||
            (expected.attemptRevision < Long.MAX_VALUE && replacement.attemptRevision == expected.attemptRevision + 1 && replacement.attempted && replacement.receipt == null)) { "A dispatch revision cannot be reset or skipped" }
        require(!expected.attempted || replacement.attempted) { "An attempted request cannot become unsent" }
        require(expected.receipt == null || replacement.receipt == expected.receipt) { "A proven receipt cannot change" }
    }
    /** Retires only the exact saved record. */
    @Synchronized fun clearIfMatching(expected: PendingIntent): Boolean {
        val current = entries()
        if (current.none { it == expected }) return false
        write(current.filterNot { it == expected })
        return true
    }

    companion object {
        const val SCHEMA_VERSION = 2
        /** The kept history is support evidence, not state: only the most recent requests are kept. */
        const val PARKED_LIMIT = 64
    }
}

/** Decoders for the on-disk formats written before the unified journal. Each format is checked as
 * strictly as its original store did; anything unrecognised throws instead of vanishing. */
object LegacyPendingIntents {
    fun decodeAll(legacy: LegacyPendingStores): List<PendingIntent> =
        decodeTraining(legacy.training?.read()) + decodeConstruction(legacy.construction?.read()) +
            decodeCancellation(legacy.cancellation?.read()) + decodeResearch(legacy.research?.read())

    /** `PendingTrainingStore`: `{"schemaVersion":1,"requests":{wallet:{body,quote}}}` or the first
     * preview format `{wallet,body,quote}`. */
    fun decodeTraining(text: String?): List<PendingIntent> {
        if (text == null) return emptyList()
        val value = Json.parseToJsonElement(text).jsonObject
        val requests: Map<String, JsonObject> = value.text("wallet")?.let { wallet ->
            mapOf(wallet to buildJsonObject { put("body", requireNotNull(value["body"])); put("quote", requireNotNull(value["quote"])) })
        } ?: run {
            require(value.text("schemaVersion") == "1") { "A saved training request needs a compatible client" }
            requireNotNull(value["requests"] as? JsonObject).mapValues { requireNotNull(it.value as? JsonObject) }
        }
        return requests.map { (wallet, record) ->
            val body = requireNotNull(record["body"] as? JsonObject)
            val quote = requireNotNull(record["quote"] as? JsonObject)
            PendingIntent(IntentKind.TRAINING_BATCH, wallet, body.text("baseId"), requireNotNull(body.text("idempotencyKey")),
                "/army/training/batch", body, "Train army", quote, attempted = true)
        }
    }

    /** `PendingBaseOrderStore`: `{"schemaVersion":1,"requests":{wallet:{path,body,label}}}`. */
    fun decodeConstruction(text: String?): List<PendingIntent> {
        if (text == null) return emptyList()
        val value = Json.parseToJsonElement(text).jsonObject
        require(value.text("schemaVersion") == "1") { "Saved construction needs a compatible client" }
        return requireNotNull(value["requests"] as? JsonObject).map { (wallet, raw) ->
            val order = raw.jsonObject
            val path = requireNotNull(order.text("path"))
            require(path == "/base/buildings" || Regex("/base/(buildings/[0-9a-fA-F-]{36}/upgrade|jobs/[0-9a-fA-F-]{36}/(cancel|speedup))").matches(path))
            val body = requireNotNull(order["body"] as? JsonObject)
            PendingIntent(IntentKind.CONSTRUCTION, wallet, body.text("baseId"), requireNotNull(body.text("idempotencyKey")),
                path, body, requireNotNull(order.text("label")?.takeIf { it.isNotBlank() }), attempted = true)
        }
    }

    /** `PendingTrainingCancellationStore`: `{"schemaVersion":1,"requests":{wallet:{baseId,queueId,
     * idempotencyKey,troop,refundShards,attempted,receipt}}}`; the receipt (if any) is the GET envelope. */
    fun decodeCancellation(text: String?): List<PendingIntent> {
        if (text == null) return emptyList()
        val value = Json.parseToJsonElement(text).jsonObject
        require(value["schemaVersion"] == JsonPrimitive(1)) { "Saved cancellation needs a compatible client" }
        return requireNotNull(value["requests"] as? JsonObject).map { (wallet, raw) ->
            val row = requireNotNull(raw as? JsonObject) { "Saved cancellation is malformed" }
            require(row.keys == setOf("baseId", "queueId", "idempotencyKey", "troop", "refundShards", "attempted", "receipt"))
            val baseId = if (row["baseId"] == JsonNull) null else requireNotNull(row.text("baseId"))
            val queueId = requireNotNull(row.text("queueId"))
            val attempted = requireNotNull((row["attempted"] as? JsonPrimitive)?.takeUnless { it.isString }?.booleanOrNull)
            val receipt = row["receipt"].takeIf { it != JsonNull }?.let { requireNotNull(it as? JsonObject) }
            val key = requireNotNull(row.text("idempotencyKey"))
            PendingIntent(IntentKind.TRAINING_CANCEL, wallet, baseId, key, "/army/train/$queueId/cancel",
                buildJsonObject { put("idempotencyKey", key); baseId?.let { put("baseId", it) } }, "Cancel training",
                quote = buildJsonObject { put("queueId", queueId); put("troop", requireNotNull(row.text("troop"))); put("refundShards", requireNotNull(row.text("refundShards"))) },
                attempted = attempted || receipt != null,
                receipt = receipt?.let { ReceiptDocument.fromReceiptRoute(it) })
        }
    }

    /** `PendingResearchStore`: `{wallet:{target,body}}` (no schema header). */
    fun decodeResearch(text: String?): List<PendingIntent> {
        if (text == null) return emptyList()
        return Json.parseToJsonElement(text).jsonObject.map { (wallet, raw) ->
            val order = requireNotNull(raw as? JsonObject) { "Saved research is malformed" }
            val target = requireNotNull(order["target"] as? JsonObject)
            val body = requireNotNull(order["body"] as? JsonObject)
            val troop = requireNotNull(target.text("troop")).also { require(it.matches(Regex("[a-z][a-z0-9_]*"))) }
            val path = when (target.text("action")) {
                "start" -> "/army/research"; "finish" -> "/army/research/speedup"; "cancel" -> "/army/research/$troop/cancel"
                else -> throw IllegalArgumentException("Unknown research action")
            }
            PendingIntent(IntentKind.RESEARCH, wallet, body.text("baseId"), requireNotNull(body.text("idempotencyKey")), path, body,
                "Research $troop", target, attempted = true)
        }
    }

    private fun JsonObject.text(key: String): String? = (this[key] as? JsonPrimitive)?.contentOrNull
}
