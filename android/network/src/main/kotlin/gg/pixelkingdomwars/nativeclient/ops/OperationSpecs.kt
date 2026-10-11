package gg.pixelkingdomwars.nativeclient.ops

import gg.pixelkingdomwars.nativeclient.model.ResearchSpeedup
import gg.pixelkingdomwars.nativeclient.model.BuilderJobSpeedup
import gg.pixelkingdomwars.nativeclient.model.BuilderJobSpeedupIntent
import gg.pixelkingdomwars.nativeclient.model.BuilderJobSpeedupAcceptance
import gg.pixelkingdomwars.nativeclient.model.ResearchSpeedupIntent
import gg.pixelkingdomwars.nativeclient.model.ResearchSpeedupAcceptance
import gg.pixelkingdomwars.nativeclient.model.TrainingFinish
import gg.pixelkingdomwars.nativeclient.model.PaidTrainingFinishIntent
import gg.pixelkingdomwars.nativeclient.model.PaidTrainingFinishAcceptance
import gg.pixelkingdomwars.nativeclient.model.PlotGeometry
import gg.pixelkingdomwars.nativeclient.model.BaseDirectory
import gg.pixelkingdomwars.nativeclient.model.BaseSnapshot
import gg.pixelkingdomwars.nativeclient.model.FarmUnlockResult
import gg.pixelkingdomwars.nativeclient.model.LandAddress
import gg.pixelkingdomwars.nativeclient.model.LandDeposit
import gg.pixelkingdomwars.nativeclient.model.WallRowQuote
import gg.pixelkingdomwars.nativeclient.model.WallRowResult
import gg.pixelkingdomwars.nativeclient.model.WallRowUpgraded
import gg.pixelkingdomwars.nativeclient.network.ApiCompatibilityException
import gg.pixelkingdomwars.nativeclient.network.ApiException
import gg.pixelkingdomwars.nativeclient.network.researchStateAdvanced
import java.time.Instant
import kotlinx.serialization.json.*

private val UUID = Regex("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
private fun JsonObject.text(key: String): String = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: error("Missing string $key")
private fun JsonObject.optionalText(key: String): String? = (this[key] as? JsonPrimitive)?.contentOrNull
private fun amount(value: String) = value.also { require(it.length <= 32 && it.matches(Regex("0|[1-9][0-9]*"))) }
private fun timestamp(value: String) = value.also { Instant.parse(it) }
private fun uuid(value: String) = value.also { require(UUID.matches(it)) }
private inline fun <T> strict(route: String, block: () -> T): T = try { block() } catch (_: Exception) { throw ApiCompatibilityException(route) }

/** Ordinary training batch: `POST /army/training/batch` with receipt/close on main. */
data class TrainingAcceptance(val costShards: String, val result: JsonObject)

object TrainingBatchSpec : MoneyOpSpec<TrainingAcceptance> {
    const val PATH = "/army/training/batch"
    const val RECEIPT = "/army/training/receipt"
    const val CLOSE = "/army/training/close"
    override val kind = IntentKind.TRAINING_BATCH
    override val savedRequestExit = SavedRequestExit.SERVER_CLOSE
    override fun receiptRequest(intent: PendingIntent) = ReceiptRequest(RECEIPT, mapOf("idempotencyKey" to intent.idempotencyKey))
    override fun closeRequest(intent: PendingIntent) = CLOSE to buildJsonObject { put("idempotencyKey", intent.idempotencyKey); put("confirmed", true) }
    override fun acknowledge(intent: PendingIntent, response: JsonObject): TrainingAcceptance {
        val cost = amount(intent.body.text("confirmedCostShards"))
        require(response.text("costShards") == cost) { "The training receipt differs from the quote" }
        return TrainingAcceptance(cost, response)
    }
    override fun restore(intent: PendingIntent, document: JsonObject): TrainingAcceptance = when (ReceiptDocument.source(document)) {
        ReceiptDocument.SOURCE_POST -> acknowledge(intent, ReceiptDocument.payload(document))
        else -> (decodeReceipt(intent, ReceiptDocument.payload(document)) as Receipt.Accepted).value
    }
    /** Receipts describe the original purchase independently of today's deed, queue or balance. */
    override fun decodeReceipt(intent: PendingIntent, response: JsonObject): Receipt<TrainingAcceptance> = strict(RECEIPT) {
        if (response["version"] != JsonPrimitive(1)) return@strict Receipt.Unsupported
        val body = intent.body
        require(response.text("idempotencyKey") == intent.idempotencyKey)
        when (response.text("status")) {
            "unknown" -> Receipt.Unknown
            "closed" -> Receipt.Closed(timestamp(response.text("closedAt")))
            "accepted" -> {
                require(response.containsKey("baseId"))
                val originalBase = body["baseId"] ?: JsonNull
                if (originalBase == JsonNull) require(response["baseId"] == JsonNull)
                else require(uuid(body.text("baseId")).equals(uuid(response.text("baseId")), ignoreCase = true))
                timestamp(response.text("acceptedAt"))
                val request = requireNotNull(response["request"] as? JsonObject)
                val composition = requireNotNull(body["composition"] as? JsonArray)
                require(composition.isNotEmpty() && request["composition"] == composition)
                val cost = amount(body.text("confirmedCostShards"))
                require(request.text("confirmedCostShards") == cost)
                val result = requireNotNull(response["result"] as? JsonObject)
                require(result.text("costShards") == cost && result["replayed"] == JsonPrimitive(true))
                val queue = requireNotNull(result["queue"] as? JsonArray)
                var index = 0
                val ids = mutableSetOf<String>()
                for (element in composition) {
                    val row = element.jsonObject
                    val troop = row.text("troop").also { require(it.isNotBlank()) }
                    val count = requireNotNull((row["count"] as? JsonPrimitive)?.takeUnless { it.isString }?.intOrNull)
                    require(count > 0 && count <= queue.size - index)
                    repeat(count) {
                        val queued = queue[index++].jsonObject
                        require(queued.text("troop") == troop && ids.add(uuid(queued.text("id")).lowercase()))
                        timestamp(queued.text("finishesAt"))
                    }
                }
                require(index == queue.size)
                Receipt.Accepted(TrainingAcceptance(cost, result), ReceiptDocument.fromReceiptRoute(response))
            }
            else -> Receipt.Unsupported
        }
    }
}

/** Construction: placement (`POST /base/buildings`, receipt on the ported backend), upgrade,
 * finish (speedup) and cancel. Modern paid finishes and placements have original receipt routes. */
data class ConstructionAcceptance(val label: String, val funding: Funding?, val receiptId: String?, val builderFinish: BuilderJobSpeedupAcceptance? = null)
data class Funding(val currency: String, val amount: String)

object ConstructionSpec : MoneyOpSpec<ConstructionAcceptance> {
    const val PLACE = "/base/buildings"
    const val RECEIPT = "/base/buildings/receipt"
    override val kind = IntentKind.CONSTRUCTION
    fun modernBuilder(intent: PendingIntent) = intent.expectedCurrency != null || intent.quote?.containsKey("builderJobSpeedup") == true || intent.body.containsKey("consent")
    fun builderIntent(wallet: String, terms: BuilderJobSpeedupIntent) = PendingIntent(kind, ResearchSpeedup.wallet(wallet), terms.baseId,
        terms.idempotencyKey, terms.path, terms.body, "Finish ${terms.consent.kind.replace('_', ' ')}",
        buildJsonObject { put("builderJobSpeedup", terms.json) }, expectedCurrency = terms.expectedCurrency.name)
    fun builderTerms(intent: PendingIntent): BuilderJobSpeedupIntent {
        require(intent.kind == kind && intent.expectedCurrency != null)
        val quote = requireNotNull(intent.quote); require(quote.keys == setOf("builderJobSpeedup"))
        val terms = BuilderJobSpeedup.parse(requireNotNull(quote["builderJobSpeedup"] as? JsonObject))
        ResearchSpeedup.wallet(intent.wallet)
        require(terms.path == intent.path && terms.baseId == intent.baseId && terms.idempotencyKey == intent.idempotencyKey &&
            terms.expectedCurrency.name == intent.expectedCurrency && terms.body == intent.body)
        return terms
    }
    private fun builderAcceptance(intent: PendingIntent, paid: BuilderJobSpeedupAcceptance) =
        ConstructionAcceptance(intent.label, Funding(paid.intent.expectedCurrency.name, paid.amount), paid.receiptId, paid)
    fun placementQuery(intent: PendingIntent): Map<String, String>? {
        if (intent.path != PLACE) return null
        val body = intent.body
        if (body.keys.any { it !in setOf("type", "tx", "ty", "idempotencyKey", "baseId") }) return null
        return runCatching {
            require(body.text("idempotencyKey").length in 8..128 && body.text("type").isNotBlank())
            val plot = intent.quote?.get("plotGeometry")?.let { PlotGeometry.saved(it.jsonObject).also { p -> require(p.version == 2) } }
            val tx = requireNotNull((body["tx"] as? JsonPrimitive)?.takeUnless { it.isString }?.intOrNull)
            val ty = requireNotNull((body["ty"] as? JsonPrimitive)?.takeUnless { it.isString }?.intOrNull)
            require(plot?.contains(tx, ty) ?: (tx >= 0 && ty >= 0))
            if (body.containsKey("baseId")) uuid(body.text("baseId"))
            body.mapValues { it.value.jsonPrimitive.content }
        }.getOrNull()
    }
    override fun validateSend(intent: PendingIntent) {
        if (modernBuilder(intent)) { builderTerms(intent); return }
        if (intent.path == PLACE || intent.quote?.containsKey("plotGeometry") == true) requireNotNull(placementQuery(intent)) { "Unsupported original plot geometry; keep the saved request until compatible recovery is available" }
    }
    override fun receiptRequest(intent: PendingIntent) = if (modernBuilder(intent)) ReceiptRequest(BuilderJobSpeedup.RECEIPT, builderTerms(intent).query)
        else placementQuery(intent)?.let { ReceiptRequest(RECEIPT, it) }
    /** The server has no construction closure route. Both receipt routes (placement and builder finish) are keyed by the
     * saved key; CLOSE archives a request only on a server `absent` answer (owner review 2026-10-06, M1: `unknown` is "no
     * matching evidence" and keeps it shown, no longer blocking BUILD once settled). Legacy orders with no receipt route
     * read GET /base ([absenceRequest]). */
    override val savedRequestExit = SavedRequestExit.FORGET_AFTER_SERVER_ABSENT
    /** Upgrade orders freeze the building's level when they are sent: `{"upgradeFrom":{"buildingId","fromLevel"}}` (B2). */
    const val UPGRADE_FROM = "upgradeFrom"
    fun upgradeQuote(buildingId: String, fromLevel: Int): JsonObject =
        buildJsonObject { put(UPGRADE_FROM, buildJsonObject { put("buildingId", buildingId); put("fromLevel", fromLevel) }) }
    /** Legacy upgrade / repair / finish / cancel / clear have no receipt route (dead-end audit 2026-10-06): GET /base, which
     * Home already reads, can show their effect. A placement whose plot geometry cannot be queried gets NO proof (owner
     * review M4: tile semantics cannot be validated and a carry would defeat it): it stays blocking and shown. */
    override fun absenceRequest(intent: PendingIntent): ReceiptRequest? {
        val target = legacyOrderTarget(intent) ?: return null
        // An upgrade sent without its frozen level (older builds): no GET /base answer can tell an untouched building from a
        // finished upgrade (B2), so nothing is read; it stays Unsupported and is never closed.
        if (target is LegacyOrderTarget.Building && target.action == "upgrade" && upgradeFrom(intent, target.id) == null) return null
        return ReceiptRequest("/base", intent.baseId?.let { mapOf("baseId" to it) }.orEmpty())
    }
    /**
     * Owner review 2026-10-06 (B2): never an absence when the order may have happened.
     * - upgrade: only with the frozen [UPGRADE_FROM] level: the building is still AT that level, no job references it and it
     *   is not under construction. A building above it, or an upgrade job on it, is an ACCEPTANCE ([effectAcceptance]).
     * - repair: the trap is still spent and no job references the building.
     * - finish / cancel: the job is still running, so neither was applied (a job that is gone may have been: no proof).
     * - clear: the obstacle is still there and no job references it.
     */
    override fun provesAbsence(intent: PendingIntent, response: JsonObject): Boolean {
        val base = currentBase(intent, response)
        return when (val target = requireNotNull(legacyOrderTarget(intent))) {
            is LegacyOrderTarget.Building -> {
                val building = base.buildings.firstOrNull { it.id.equals(target.id, ignoreCase = true) } ?: return false
                if (base.jobs.any { it.buildingId.equals(target.id, ignoreCase = true) }) return false
                if (target.action == "upgrade") { val from = upgradeFrom(intent, target.id) ?: return false; building.level == from && !building.underConstruction }
                else building.trapSpentAt != null
            }
            is LegacyOrderTarget.Job -> base.jobs.any { it.id.equals(target.id, ignoreCase = true) }
            is LegacyOrderTarget.Obstacle -> base.obstacles.any { it.id == target.id } && base.jobs.none { it.obstacleId == target.id }
        }
    }
    /** B2: the order's effect is visible, so the charge is real: an upgrade job runs on the building or it stands above the
     * frozen level; a clear job runs on the obstacle. Hydrated and shown as accepted, never hidden as "no record". */
    override fun effectAcceptance(intent: PendingIntent, response: JsonObject): Receipt.Accepted<ConstructionAcceptance>? {
        val base = currentBase(intent, response)
        val shown = when (val target = legacyOrderTarget(intent) ?: return null) {
            is LegacyOrderTarget.Building -> target.action == "upgrade" && run {
                val from = upgradeFrom(intent, target.id) ?: return null
                val building = base.buildings.firstOrNull { it.id.equals(target.id, ignoreCase = true) } ?: return null
                building.level > from || building.underConstruction || base.jobs.any { it.buildingId.equals(target.id, ignoreCase = true) }
            }
            is LegacyOrderTarget.Obstacle -> base.jobs.any { it.obstacleId == target.id }
            is LegacyOrderTarget.Job -> false
        }
        if (!shown) return null
        return Receipt.Accepted(ConstructionAcceptance(intent.label, null, null),
            ReceiptDocument.fromPost(buildJsonObject { put("effect", "observed on GET /base"); put("path", intent.path) }))
    }
    /** A legacy order the server cannot answer for (Unsupported, e.g. a finish whose job is gone) stops blocking once
     * settled and checked, and stays shown: never forgotten, never a dead BUILD (B2). A keyed request stops blocking on
     * `unknown`/`absent` (M1). A placement with no keyed route keeps blocking (M4). */
    override fun unblocksAfterCheck(intent: PendingIntent, answer: Receipt<*>): Boolean = when {
        legacyOrderTarget(intent) != null -> answer == Receipt.Unknown || answer == Receipt.Absent || answer == Receipt.Unsupported
        modernBuilder(intent) || placementQuery(intent) != null -> answer == Receipt.Unknown || answer == Receipt.Absent
        else -> false
    }
    private fun currentBase(intent: PendingIntent, response: JsonObject): BaseSnapshot = BaseSnapshot.from(response).also { base ->
        intent.baseId?.let { require(it.equals(base.baseId, ignoreCase = true)) { "The base read answered for another base" } }
    }
    private fun upgradeFrom(intent: PendingIntent, buildingId: String): Int? = runCatching {
        val from = requireNotNull(intent.quote?.get(UPGRADE_FROM) as? JsonObject)
        require(from.text("buildingId").equals(buildingId, ignoreCase = true))
        requireNotNull((from["fromLevel"] as? JsonPrimitive)?.takeUnless { it.isString }?.intOrNull).also { require(it >= 0) }
    }.getOrNull()
    private sealed interface LegacyOrderTarget {
        data class Building(val id: String, val action: String) : LegacyOrderTarget
        data class Job(val id: String) : LegacyOrderTarget
        data class Obstacle(val id: String) : LegacyOrderTarget
    }
    private val BUILDING_ORDER = Regex("/base/buildings/([^/]+)/(upgrade|repair)")
    private val JOB_ORDER = Regex("/base/jobs/([^/]+)/(speedup|cancel)")
    private val OBSTACLE_ORDER = Regex("/base/obstacles/([^/]+)/clear")
    private fun legacyOrderTarget(intent: PendingIntent): LegacyOrderTarget? {
        if (modernBuilder(intent)) return null
        BUILDING_ORDER.matchEntire(intent.path)?.let { return LegacyOrderTarget.Building(it.groupValues[1], it.groupValues[2]) }
        JOB_ORDER.matchEntire(intent.path)?.let { return LegacyOrderTarget.Job(it.groupValues[1]) }
        OBSTACLE_ORDER.matchEntire(intent.path)?.let { return LegacyOrderTarget.Obstacle(it.groupValues[1]) }
        return null
    }
    override fun acknowledge(intent: PendingIntent, response: JsonObject): ConstructionAcceptance {
        if (modernBuilder(intent)) return strict(BuilderJobSpeedup.RECEIPT) {
            builderAcceptance(intent, requireNotNull(BuilderJobSpeedup.proof(response, intent.wallet, builderTerms(intent))))
        }
        if (intent.quote?.containsKey("plotGeometry") == true) requireNotNull(placementQuery(intent)) { "Unsupported original plot geometry" }
        return ConstructionAcceptance(intent.label, null, null)
    }
    override fun acknowledgementDocument(response: JsonObject): JsonObject = if (response["version"] == JsonPrimitive(1) && response["status"] == JsonPrimitive("accepted") && response["wallet"] is JsonPrimitive && response["request"] is JsonObject)
        ReceiptDocument.fromReceiptRoute(response) else ReceiptDocument.fromPost(response)
    override fun restore(intent: PendingIntent, document: JsonObject): ConstructionAcceptance {
        if (modernBuilder(intent)) require(ReceiptDocument.source(document) == ReceiptDocument.SOURCE_RECEIPT) { "Builder finish requires original receipt provenance" }
        return when (ReceiptDocument.source(document)) {
            ReceiptDocument.SOURCE_POST -> acknowledge(intent, ReceiptDocument.payload(document))
            else -> (decodeReceipt(intent, ReceiptDocument.payload(document)) as Receipt.Accepted).value
        }
    }
    /** Historical acceptance does not claim the building still exists or is owned. */
    override fun decodeReceipt(intent: PendingIntent, response: JsonObject): Receipt<ConstructionAcceptance> = strict(RECEIPT) {
        if (modernBuilder(intent)) {
            val paid = BuilderJobSpeedup.proof(response, intent.wallet, builderTerms(intent))
            return@strict if (paid == null) Receipt.Unknown else Receipt.Accepted(builderAcceptance(intent, paid), ReceiptDocument.fromReceiptRoute(response))
        }
        if (response["version"] != JsonPrimitive(1)) return@strict Receipt.Unsupported
        if (intent.quote?.containsKey("plotGeometry") == true) requireNotNull(placementQuery(intent)) { "Unsupported original plot geometry" }
        val body = intent.body
        when (response.text("status")) {
            "unknown" -> { require(response.text("idempotencyKey") == intent.idempotencyKey); Receipt.Unknown }
            "accepted" -> {
                require(response["request"] == body) // The server echoes the parsed original request, original UUID spelling included.
                require(response.containsKey("baseId"))
                if (body.containsKey("baseId")) require(uuid(body.text("baseId")).equals(uuid(response.text("baseId")), ignoreCase = true))
                else require(response["baseId"] == JsonNull)
                val receiptId = uuid(response.text("receiptId"))
                timestamp(response.text("acceptedAt"))
                val funding = requireNotNull(response["funding"] as? JsonObject)
                val currency = funding.text("currency").also { require(it == "SHARDS" || it == "KEEP") }
                val amount = funding.text("amount").also { require(it.matches(Regex("[1-9][0-9]*"))) }
                Receipt.Accepted(ConstructionAcceptance(intent.label, Funding(currency, amount), receiptId), ReceiptDocument.fromReceiptRoute(response))
            }
            else -> Receipt.Unsupported
        }
    }
    override fun observedInitialRejection(intent: PendingIntent, error: ApiException): Boolean {
        if (!modernBuilder(intent)) return false
        return when (error.status) {
            409 -> when (error.code) {
                "BUILDER_SPEEDUP_QUOTE_CHANGED", "BUILDER_SPEEDUP_SCOPE_CHANGED", "BASE_ID_REQUIRED", "DEED_OWNERSHIP_CHANGED" -> true
                "CURRENCY_CONSENT_CHANGED" -> error.details["expectedCurrency"] == JsonPrimitive(intent.expectedCurrency)
                else -> false
            }
            404 -> error.code in setOf("BUILDER_JOB_NOT_RUNNING", "BASE_NOT_OWNED")
            // The land gate (`requireLandOwned`, the route's preHandler) answers before placeBuilding records the key:
            // nothing was charged, so the first attempt retires instead of leaving a card nothing can close (owner's
            // Seeker 2026-10-06, Gold Forge on a deedless base).
            402 -> error.code == "LAND_NOT_OWNED"
            423 -> error.code == "BASE_BEING_RAIDED"
            503 -> error.code == "DEED_AUTHORITY_UNAVAILABLE"
            else -> false
        }
    }
    override fun definitiveInitialRejection(intent: PendingIntent, error: ApiException) =
        if (modernBuilder(intent)) observedInitialRejection(intent, error) else isDefinitiveRejection(error.status)
}

/** Queued-troop cancellation: `POST /army/train/:queueId/cancel`, receipt at `…/cancel/receipt`. */
data class CancellationAcceptance(val queueId: String, val troop: String, val refundShards: String, val replayed: Boolean)

object TrainingCancelSpec : MoneyOpSpec<CancellationAcceptance> {
    override val kind = IntentKind.TRAINING_CANCEL
    /** The receipt answers `unknown` only for exactly this queue row, key and base ([identity]). */
    override val savedRequestExit = SavedRequestExit.FORGET_AFTER_SERVER_ABSENT
    fun queueId(intent: PendingIntent): String = uuid(requireNotNull(intent.quote).text("queueId"))
    fun troop(intent: PendingIntent): String = requireNotNull(intent.quote).text("troop").also { require(it.matches(Regex("[a-z][a-z0-9_]*"))) }
    fun refundShards(intent: PendingIntent): String = requireNotNull(intent.quote).text("refundShards").also { require(it.length <= 32 && it.matches(Regex("[1-9][0-9]*"))) }
    fun intent(wallet: String, baseId: String?, queueId: String, idempotencyKey: String, troop: String, refundShards: String): PendingIntent {
        baseId?.let(::uuid); uuid(queueId)
        return PendingIntent(kind, wallet, baseId, idempotencyKey, "/army/train/$queueId/cancel",
            buildJsonObject { put("idempotencyKey", idempotencyKey); baseId?.let { put("baseId", it) } }, "Cancel training",
            buildJsonObject { put("queueId", queueId); put("troop", troop); put("refundShards", refundShards) }).also { troop(it); refundShards(it) }
    }
    override fun receiptRequest(intent: PendingIntent) = ReceiptRequest("${intent.path}/receipt", intent.body.mapValues { it.value.jsonPrimitive.content })
    /** POST returns the result, not the receipt envelope; bind it to the request actually sent. */
    override fun acknowledge(intent: PendingIntent, response: JsonObject): CancellationAcceptance {
        val envelope = buildJsonObject {
            put("version", 1); put("status", "accepted"); put("queueId", queueId(intent)); put("idempotencyKey", intent.idempotencyKey)
            put("baseId", intent.baseId?.let(::JsonPrimitive) ?: JsonNull); put("result", response)
        }
        return validate(intent, envelope, requireReplay = false)
    }
    override fun restore(intent: PendingIntent, document: JsonObject): CancellationAcceptance = when (ReceiptDocument.source(document)) {
        ReceiptDocument.SOURCE_POST -> acknowledge(intent, ReceiptDocument.payload(document))
        else -> strict(receiptRequest(intent).path) { validate(intent, ReceiptDocument.payload(document), requireReplay = false) }
    }
    override fun decodeReceipt(intent: PendingIntent, response: JsonObject): Receipt<CancellationAcceptance> = strict(receiptRequest(intent).path) {
        if (response["version"] != JsonPrimitive(1)) return@strict Receipt.Unsupported
        identity(intent, response)
        when (response.text("status")) {
            "unknown" -> Receipt.Unknown
            "accepted" -> Receipt.Accepted(validate(intent, response, requireReplay = true), ReceiptDocument.fromReceiptRoute(response))
            else -> Receipt.Unsupported
        }
    }
    private fun identity(intent: PendingIntent, value: JsonObject) {
        require(uuid(value.text("queueId")).equals(queueId(intent), ignoreCase = true))
        require(value.text("idempotencyKey") == intent.idempotencyKey)
        if (intent.baseId == null) require(value["baseId"] == JsonNull)
        else require(uuid(value.text("baseId")).equals(intent.baseId, ignoreCase = true))
    }
    private fun validate(intent: PendingIntent, value: JsonObject, requireReplay: Boolean): CancellationAcceptance {
        require(value["version"] == JsonPrimitive(1) && value.text("status") == "accepted")
        identity(intent, value)
        val result = requireNotNull(value["result"] as? JsonObject)
        require(uuid(result.text("id")).equals(queueId(intent), ignoreCase = true))
        require(result.text("troop") == troop(intent) && result.text("refundShards") == refundShards(intent))
        timestamp(result.text("cancelledAt"))
        val replayed = requireNotNull((result["replayed"] as? JsonPrimitive)?.takeUnless { it.isString }?.booleanOrNull)
        require(!requireReplay || replayed)
        return CancellationAcceptance(queueId(intent), troop(intent), refundShards(intent), replayed)
    }
}

/** Modern FINISH is a paid original-episode command. Legacy state observation remains distinct. */
data class ResearchAcceptance(val action: String, val troop: String, val finish: ResearchSpeedupAcceptance? = null)

object ResearchSpec : MoneyOpSpec<ResearchAcceptance> {
    override val kind = IntentKind.RESEARCH
    private fun modern(intent: PendingIntent) = intent.expectedCurrency != null || intent.quote?.containsKey("researchSpeedup") == true
    fun intent(wallet: String, terms: ResearchSpeedupIntent): PendingIntent = PendingIntent(kind, ResearchSpeedup.wallet(wallet), terms.baseId,
        terms.idempotencyKey, ResearchSpeedup.PATH, terms.body, "Finish ${terms.troop} research",
        buildJsonObject { put("action", "finish"); put("researchSpeedup", terms.json) }, expectedCurrency = terms.expectedCurrency.name)
    fun exact(intent: PendingIntent): ResearchSpeedupIntent {
        require(intent.kind == kind && intent.path == ResearchSpeedup.PATH && intent.expectedCurrency != null)
        val quote = target(intent); require(quote.keys == setOf("action", "researchSpeedup") && quote["action"] == JsonPrimitive("finish"))
        val terms = ResearchSpeedup.parse(requireNotNull(quote["researchSpeedup"] as? JsonObject))
        ResearchSpeedup.wallet(intent.wallet)
        require(terms.baseId == intent.baseId && terms.idempotencyKey == intent.idempotencyKey && terms.expectedCurrency.name == intent.expectedCurrency && terms.body == intent.body)
        return terms
    }
    override fun validateSend(intent: PendingIntent) { if (modern(intent)) exact(intent) }
    /** Modern FINISH: the key-scoped receipt. Legacy start / finish / cancel: the /army read shows the order's own target
     * (`toLevel`, or the running episode for a cancel) was not reached, so it left no effect (owner 2026-10-06 audit). */
    override val savedRequestExit = SavedRequestExit.FORGET_AFTER_SERVER_ABSENT
    override fun forgetsOnServerAbsent(intent: PendingIntent) = modern(intent) || legacyTargetProves(intent)
    /** A legacy research with no usable target can never be read as unknown: it no longer refuses a new order. */
    override fun supersededByNewOrder(intent: PendingIntent) = !modern(intent) && !legacyTargetProves(intent)
    private fun legacyTargetProves(intent: PendingIntent): Boolean = runCatching {
        val target = target(intent)
        require(target.text("troop").isNotBlank())
        when (target.text("action")) {
            "start", "finish" -> requireNotNull((target["toLevel"] as? JsonPrimitive)?.takeUnless { it.isString }?.intOrNull) > 0
            "cancel" -> true
            else -> false
        }
    }.getOrDefault(false)
    fun target(intent: PendingIntent): JsonObject = requireNotNull(intent.quote) { "Research intent has no target" }
    override fun receiptRequest(intent: PendingIntent) = if (modern(intent))
        ReceiptRequest(ResearchSpeedup.RECEIPT, exact(intent).query)
    else ReceiptRequest("/army", intent.baseId?.let { mapOf("baseId" to it) }.orEmpty())
    override fun acknowledge(intent: PendingIntent, response: JsonObject): ResearchAcceptance = if (modern(intent)) strict(ResearchSpeedup.RECEIPT) {
        val accepted = requireNotNull(ResearchSpeedup.proof(response, intent.wallet, exact(intent)))
        ResearchAcceptance("finish", accepted.intent.troop, accepted)
    } else ResearchAcceptance(target(intent).text("action"), target(intent).text("troop"))
    override fun acknowledgementDocument(response: JsonObject): JsonObject = if (response["version"] == JsonPrimitive(1) && response["status"] == JsonPrimitive("accepted") && response["request"] is JsonObject && response["funding"] is JsonObject)
        ReceiptDocument.fromReceiptRoute(response) else ReceiptDocument.fromPost(response)
    override fun restore(intent: PendingIntent, document: JsonObject): ResearchAcceptance {
        if (modern(intent)) require(ReceiptDocument.source(document) == ReceiptDocument.SOURCE_RECEIPT) { "Research finish requires original receipt provenance" }
        return acknowledge(intent, ReceiptDocument.payload(document))
    }
    override fun decodeReceipt(intent: PendingIntent, response: JsonObject): Receipt<ResearchAcceptance> {
        if (modern(intent)) return strict(ResearchSpeedup.RECEIPT) {
            val paid = ResearchSpeedup.proof(response, intent.wallet, exact(intent))
            if (paid == null) Receipt.Unknown else Receipt.Accepted(ResearchAcceptance("finish", paid.intent.troop, paid), ReceiptDocument.fromReceiptRoute(response))
        }
        val order = buildJsonObject { put("target", target(intent)); put("body", intent.body) }
        return if (researchStateAdvanced(order, response)) Receipt.Accepted(acknowledge(intent, response), ReceiptDocument.fromReceiptRoute(response))
        else Receipt.Unknown
    }
    override fun observedInitialRejection(intent: PendingIntent, error: ApiException): Boolean {
        if (!modern(intent)) return false
        return when (error.status) {
            409 -> when (error.code) {
                "RESEARCH_CONSENT_STALE", "RESEARCH_PRICE_CHANGED", "TROOP_ROSTER_INACTIVE", "BASE_ID_REQUIRED", "DEED_OWNERSHIP_CHANGED" -> true
                "CURRENCY_CONSENT_CHANGED" -> error.details["expectedCurrency"] == JsonPrimitive(intent.expectedCurrency)
                else -> false
            }
            404 -> error.code == "BASE_NOT_OWNED"
            423 -> error.code == "BASE_BEING_RAIDED"
            503 -> error.code == "DEED_AUTHORITY_UNAVAILABLE"
            else -> false
        }
    }
    override fun definitiveInitialRejection(intent: PendingIntent, error: ApiException) =
        if (!modern(intent)) isDefinitiveRejection(error.status) else observedInitialRejection(intent, error)
}

/** Exact paid FINISH ALL uses original ledger proof. Free and legacy saved requests retain their recovery. */
data class FinishAcceptance(val free: Boolean, val costKeep: String, val completed: List<Pair<String, Int>>, val response: JsonObject,
    val paid: PaidTrainingFinishAcceptance? = null)

object TrainingFinishSpec : MoneyOpSpec<FinishAcceptance> {
    const val PATH = "/army/train/speedup"
    override val kind = IntentKind.TRAINING_FINISH
    private fun modern(intent: PendingIntent) = intent.expectedCurrency != null || intent.quote?.containsKey("paidTrainingFinish") == true
    fun intent(wallet: String, terms: PaidTrainingFinishIntent) = PendingIntent(kind, ResearchSpeedup.wallet(wallet), terms.baseId,
        terms.idempotencyKey, PATH, terms.body, "Finish all training", buildJsonObject { put("paidTrainingFinish", terms.json) }, expectedCurrency = terms.expectedCurrency.name)
    fun exact(intent: PendingIntent): PaidTrainingFinishIntent {
        require(intent.kind == kind && intent.path == PATH && intent.expectedCurrency != null)
        val quote = requireNotNull(intent.quote); require(quote.keys == setOf("paidTrainingFinish"))
        val terms = TrainingFinish.parse(requireNotNull(quote["paidTrainingFinish"] as? JsonObject)); ResearchSpeedup.wallet(intent.wallet)
        require(terms.baseId == intent.baseId && terms.idempotencyKey == intent.idempotencyKey && terms.expectedCurrency.name == intent.expectedCurrency && terms.body == intent.body)
        return terms
    }
    override fun validateSend(intent: PendingIntent) { if (modern(intent)) exact(intent) }
    /** Modern paid finish: the key-scoped receipt. Legacy: the /army read still lists consented rows, so the finish (which
     * completes the whole consented queue at once) was not applied (owner 2026-10-06 audit). */
    override val savedRequestExit = SavedRequestExit.FORGET_AFTER_SERVER_ABSENT
    override fun forgetsOnServerAbsent(intent: PendingIntent) = modern(intent) || legacyConsentedRows(intent)
    /** A legacy finish without consented row ids can never be read as unknown: it no longer refuses a new order. */
    override fun supersededByNewOrder(intent: PendingIntent) = !modern(intent) && !legacyConsentedRows(intent)
    private fun legacyConsentedRows(intent: PendingIntent): Boolean =
        ((intent.body["consent"] as? JsonObject)?.get("queue") as? JsonArray).orEmpty().any { (it as? JsonObject)?.optionalText("id") != null }
    override fun receiptRequest(intent: PendingIntent) = if (modern(intent)) ReceiptRequest(TrainingFinish.RECEIPT, exact(intent).query)
        else ReceiptRequest("/army", intent.baseId?.let { mapOf("baseId" to it) }.orEmpty())
    /** The acknowledgement `{cost, completed}` is bound to the consent that was sent (web
     * `trainingFreeFinish.verifyFreeFinish`, FINISH_ALL_RECOVERY.md): a free finish costs exactly
     * `0`, a paid one never more than the approved `maxCostKeep`, and the completed rows are
     * positive counts that fit inside the consented queue. */
    override fun acknowledge(intent: PendingIntent, response: JsonObject): FinishAcceptance {
        if (modern(intent)) return strict(TrainingFinish.RECEIPT) {
            val paid = requireNotNull(TrainingFinish.proof(response, intent.wallet, exact(intent)))
            FinishAcceptance(false, paid.amount, paid.completed, response, paid)
        }
        val free = intent.body.optionalText("freeOffer") != null
        val consent = requireNotNull(intent.body["consent"] as? JsonObject) { "Finish intent has no consent" }
        val ceiling = amount(consent.text("maxCostKeep")).toBigInteger()
        val cost = amount(response.text("cost"))
        require(if (free) cost == "0" else cost.toBigInteger() <= ceiling) { "The finish charge exceeds the approved KEEP ceiling" }
        val completed = requireNotNull(response["completed"] as? JsonArray) { "Finish acknowledgement has no completed rows" }.map { row ->
            val troop = row.jsonObject.text("troop").also { require(it.isNotBlank()) }
            val count = requireNotNull((row.jsonObject["count"] as? JsonPrimitive)?.takeUnless { it.isString }?.intOrNull)
            require(count > 0) { "A completed row must count troops" }
            troop to count
        }
        val queued = requireNotNull(consent["queue"] as? JsonArray).size
        require(completed.isNotEmpty() && completed.sumOf { it.second } <= queued) { "Finish confirmation is incomplete" }
        return FinishAcceptance(free, cost, completed, response)
    }
    override fun acknowledgementDocument(response: JsonObject): JsonObject = if (response["version"] == JsonPrimitive(1) && response["status"] == JsonPrimitive("accepted") && response["funding"] is JsonObject && response["request"] is JsonObject)
        ReceiptDocument.fromReceiptRoute(response) else ReceiptDocument.fromPost(response)
    override fun restore(intent: PendingIntent, document: JsonObject): FinishAcceptance {
        if (modern(intent)) {
            require(ReceiptDocument.source(document) == ReceiptDocument.SOURCE_RECEIPT) { "Paid training requires original receipt provenance" }
            return acknowledge(intent, ReceiptDocument.payload(document))
        }
        return when (ReceiptDocument.source(document)) {
            ReceiptDocument.SOURCE_POST -> acknowledge(intent, ReceiptDocument.payload(document))
            else -> (decodeReceipt(intent, ReceiptDocument.payload(document)) as? Receipt.Accepted)?.value ?: throw ApiCompatibilityException(PATH)
        }
    }
    override fun decodeReceipt(intent: PendingIntent, response: JsonObject): Receipt<FinishAcceptance> {
        if (modern(intent)) return strict(TrainingFinish.RECEIPT) {
            val paid = TrainingFinish.proof(response, intent.wallet, exact(intent))
            if (paid == null) Receipt.Unknown else Receipt.Accepted(FinishAcceptance(false, paid.amount, paid.completed, response, paid), ReceiptDocument.fromReceiptRoute(response))
        }
        val consented = (intent.body["consent"] as? JsonObject)?.get("queue") as? JsonArray ?: return Receipt.Unsupported
        val consentedIds = consented.mapNotNull { (it as? JsonObject)?.optionalText("id")?.lowercase() }.toSet()
        val queued = (response["queue"] as? JsonArray).orEmpty().mapNotNull { (it as? JsonObject)?.optionalText("id")?.lowercase() }.toSet()
        if (consentedIds.isEmpty() || consentedIds.any { it in queued }) return Receipt.Unknown
        // The army read proves the consented rows are gone, not what was charged: the recovered
        // acceptance carries the approved ceiling and no completion detail (FINISH_ALL_RECOVERY.md).
        val free = intent.body.optionalText("freeOffer") != null
        val ceiling = amount(requireNotNull(intent.body["consent"] as? JsonObject).text("maxCostKeep"))
        return Receipt.Accepted(FinishAcceptance(free, if (free) "0" else ceiling, emptyList(), response), ReceiptDocument.fromReceiptRoute(response))
    }
    override fun observedInitialRejection(intent: PendingIntent, error: ApiException): Boolean {
        if (!modern(intent)) return false
        return when (error.status) {
            409 -> when (error.code) {
                "TRAINING_FINISH_QUOTE_CHANGED", "TRAINING_FINISH_SCOPE_CHANGED", "TRAINING_CHANGED", "TROOP_ROSTER_INACTIVE", "BASE_ID_REQUIRED", "DEED_OWNERSHIP_CHANGED" -> true
                "CURRENCY_CONSENT_CHANGED" -> error.details["expectedCurrency"] == JsonPrimitive(intent.expectedCurrency)
                else -> false
            }
            404 -> error.code in setOf("TRAINING_NOT_RUNNING", "BASE_NOT_OWNED")
            423 -> error.code == "BASE_BEING_RAIDED"
            503 -> error.code == "DEED_AUTHORITY_UNAVAILABLE"
            else -> false
        }
    }
    override fun definitiveInitialRejection(intent: PendingIntent, error: ApiException) =
        if (modern(intent)) observedInitialRejection(intent, error) else isDefinitiveRejection(error.status)
}

/** Land checkout reservation: `POST /deposits {kind: entry|deed, landAddress: {kind: fantasy, worldId, tileId?}}`.
 * The server keeps one pending reservation per wallet and purchase kind and replays it for the same
 * request, so a lost reply is recovered by explicit retry (no receipt route exists). A 409
 * `RESERVATION_MISMATCH` / `PAYMENT_WINDOW_CLOSING` names that existing reservation in its details
 * and resolves this intent to it; the caller re-reads `GET /deposits/:id` while hydrating. */
data class LandReservationAcceptance(
    val deposit: LandDeposit,
    val recoveredFromRejection: Boolean,
    /** The 409 code (`RESERVATION_MISMATCH` | `PAYMENT_WINDOW_CLOSING`) that named [deposit]; null for a POST acceptance. */
    val rejectionCode: String? = null,
) {
    /** `POST /deposits` for a wallet that already paid entry answers `{alreadyPaid: true}`. */
    val alreadyPaid: Boolean get() = deposit.alreadyPaid
    val depositId: String? get() = deposit.id
}

object LandReservationSpec : MoneyOpSpec<LandReservationAcceptance> {
    const val PATH = "/deposits"
    val RESOLVING_CODES = setOf("RESERVATION_MISMATCH", "PAYMENT_WINDOW_CLOSING")
    override val kind = IntentKind.LAND_RESERVATION
    /** No read exists; the server keeps ONE pending reservation per wallet and kind and answers a new key with that same
     * reservation (409 RESERVATION_MISMATCH resolves it). A reservation moves no money, so once settled and checked it
     * stops refusing a new reservation (it stays shown; the server still answers the same reservation for the wallet). */
    override val savedRequestExit = SavedRequestExit.PARK_AFTER_RETRY_REFUSED
    override fun unblocksAfterCheck(intent: PendingIntent, answer: Receipt<*>) = true

    /** The exact body the web sends (`auth/useEntry.ts reserve`); the key is harmless to the server. */
    fun body(purchaseKind: String, tileId: Int?, idempotencyKey: String): JsonObject {
        require(purchaseKind == "entry" || purchaseKind == "deed") { "Unknown land purchase kind" }
        require(tileId == null || tileId >= 0) { "Invalid tile" }
        return buildJsonObject {
            put("kind", purchaseKind); put("idempotencyKey", idempotencyKey)
            put("landAddress", buildJsonObject { put("kind", "fantasy"); put("worldId", BaseDirectory.FANTASY_WORLD_ID); tileId?.let { put("tileId", it) } })
        }
    }
    fun intent(wallet: String, purchaseKind: String, tileId: Int?, idempotencyKey: String): PendingIntent =
        PendingIntent(kind, wallet, null, idempotencyKey, PATH, body(purchaseKind, tileId, idempotencyKey), if (purchaseKind == "deed") "Found another keep" else "Claim your land")
    fun purchaseKind(intent: PendingIntent): String = intent.body.text("kind").also { require(it == "entry" || it == "deed") }
    fun requestedTile(intent: PendingIntent): Int? = ((intent.body["landAddress"] as? JsonObject)?.get("tileId") as? JsonPrimitive)?.takeUnless { it.isString }?.intOrNull

    override fun receiptRequest(intent: PendingIntent): ReceiptRequest? = null
    override fun decodeReceipt(intent: PendingIntent, response: JsonObject): Receipt<LandReservationAcceptance> = Receipt.Unsupported
    /** `money/deposits.ts createDepositIntent` raises these before inserting the deposit (world flag
     * off, land purchases paused, stale client), so no attempt with this body can have reserved anything. */
    override fun disprovesAcceptance(error: ApiException): Boolean =
        (error.status == 503 && error.code == "FANTASY_WORLD_NOT_READY") || (error.status == 409 && error.code == "LAND_PURCHASES_PAUSED") || (error.status == 426 && error.code == "WORLD_UPDATE_REQUIRED")

    override fun acknowledge(intent: PendingIntent, response: JsonObject): LandReservationAcceptance {
        val purchase = purchaseKind(intent)
        val deposit = LandDeposit.from(response)
        when {
            deposit.alreadyPaid -> require(purchase == "entry" && (deposit.kind == null || deposit.kind == "entry")) { "Only the first land can already be paid" }
            // A closing reservation that verification found credited or failed is returned as the row itself.
            deposit.status == "credited" || deposit.status == "failed" -> { uuid(deposit.id.orEmpty()); require(deposit.kind == purchase) { "The recovered deposit is a different purchase" } }
            else -> {
                deposit.requireReservation(purchase); uuid(requireNotNull(deposit.id)); uuid(requireNotNull(deposit.baseId))
                val requested = requestedTile(intent)
                require(requested == null || requested == deposit.landAddress?.tileId) { "The server reserved a different tile" }
                require(deposit.status == null || deposit.status == "pending") { "The reservation is not payable" }
            }
        }
        return LandReservationAcceptance(deposit, recoveredFromRejection = false)
    }
    override fun restore(intent: PendingIntent, document: JsonObject): LandReservationAcceptance = when (ReceiptDocument.source(document)) {
        ReceiptDocument.SOURCE_POST -> acknowledge(intent, ReceiptDocument.payload(document))
        // The persisted rejection document carries the 409 code beside its details (see resolveRejection).
        ReceiptDocument.SOURCE_REJECTION -> strict(PATH) { ReceiptDocument.payload(document).let { recovered(intent, it, it.text("code")) } }
        else -> throw ApiCompatibilityException(PATH)
    }
    /** `{depositId, serverNow?, payableUntil?, retryAt?, landAddress?|earthCell?}` from the 409 details. */
    private fun recovered(intent: PendingIntent, details: JsonObject, code: String): LandReservationAcceptance {
        require(code in RESOLVING_CODES) { "Not a resolving land rejection" }
        val id = uuid(details.text("depositId"))
        val address = (details["landAddress"] as? JsonObject)?.let { runCatching { ApiJsonLand.decodeFromJsonElement(LandAddress.serializer(), it) }.getOrNull() }
        return LandReservationAcceptance(LandDeposit(id = id, kind = purchaseKind(intent), status = "pending", landAddress = address,
            serverNow = details.optionalText("serverNow"), payableUntil = details.optionalText("payableUntil"), retryAt = details.optionalText("retryAt")),
            recoveredFromRejection = true, rejectionCode = code)
    }
    override fun resolveRejection(intent: PendingIntent, error: ApiException): Receipt.Accepted<LandReservationAcceptance>? {
        if (error.status != 409 || error.code !in RESOLVING_CODES) return null
        val details = error.details
        if (runCatching { uuid(details.text("depositId")) }.isFailure) return null
        val code = requireNotNull(error.code)
        val document = ReceiptDocument.fromRejection(JsonObject(details + ("code" to JsonPrimitive(code))))
        return Receipt.Accepted(recovered(intent, details, code), document)
    }
    private val ApiJsonLand = Json { ignoreUnknownKeys = true; explicitNulls = false }
}

/** Wall row upgrade: `POST /base/walls/:id/upgrade-row {baseId?, idempotencyKey, quoteId}` (web
 * `ui/WallRowUpgrade.tsx`, api `upgradeWallRow`). The frozen quote rides on the intent; the server
 * replays a committed key as `duplicate: true`, so a lost reply is recovered by explicit retry of the
 * same key ("RETRY SAME UPGRADE") — no receipt route exists. */
data class WallRowAcceptance(val upgraded: List<WallRowUpgraded>, val costShards: String, val duplicate: Boolean)

object WallRowSpec : MoneyOpSpec<WallRowAcceptance> {
    /** Refusals that re-price the row: the server answers them with the replacement quote in `details.quote`. */
    val REPRICED = setOf("WALL_ROW_QUOTE_CHANGED", "WALL_ROW_FUNDS_CHANGED", "WALL_ROW_UNAVAILABLE")
    override val kind = IntentKind.WALL_ROW
    /** No receipt route: GET /base proves the row purchase left no effect ([provesAbsence]). */
    override val savedRequestExit = SavedRequestExit.FORGET_AFTER_SERVER_ABSENT
    override fun absenceRequest(intent: PendingIntent): ReceiptRequest? = runCatching { quote(intent) }.getOrNull()
        ?.takeIf { it.eligible.isNotEmpty() }?.let { ReceiptRequest("/base", intent.baseId?.let { id -> mapOf("baseId" to id) }.orEmpty()) }
    /** The purchase upgrades every eligible wall of the frozen quote at once: each of them still standing at its quoted level,
     * with no job and no construction on it, proves this key was never committed (dead-end audit 2026-10-06). */
    override fun provesAbsence(intent: PendingIntent, response: JsonObject): Boolean {
        val base = BaseSnapshot.from(response)
        intent.baseId?.let { require(it.equals(base.baseId, ignoreCase = true)) { "The base read answered for another base" } }
        val eligible = quote(intent).eligible
        return eligible.isNotEmpty() && eligible.all { wall ->
            base.jobs.none { it.buildingId.equals(wall.id, ignoreCase = true) } && base.buildings.any {
                it.id.equals(wall.id, ignoreCase = true) && it.type == "wall" && it.level == wall.level && !it.underConstruction }
        }
    }
    fun path(wallId: String) = "/base/walls/${uuid(wallId)}/upgrade-row"
    fun intent(wallet: String, baseId: String?, quote: WallRowQuote, idempotencyKey: String): PendingIntent {
        baseId?.let(::uuid)
        require(quote.eligible.isNotEmpty()) { "No wall in this row can upgrade." }
        return PendingIntent(kind, wallet, baseId, idempotencyKey, path(quote.selectedWallId),
            buildJsonObject { baseId?.let { put("baseId", it) }; put("idempotencyKey", idempotencyKey); put("quoteId", quote.quoteId) },
            "Upgrade wall row", quote.raw)
    }
    fun quote(intent: PendingIntent): WallRowQuote = WallRowQuote.from(requireNotNull(intent.quote) { "Wall row intent has no quote" })
    override fun receiptRequest(intent: PendingIntent): ReceiptRequest? = null
    override fun decodeReceipt(intent: PendingIntent, response: JsonObject): Receipt<WallRowAcceptance> = Receipt.Unsupported
    /** `upgradeWallRow` looks the key up in the ledger before it re-quotes, so a re-priced refusal proves
     * that no purchase with this key was ever committed — on a first attempt and on a retry alike. */
    override fun disprovesAcceptance(error: ApiException): Boolean = (error.status == 409 || error.status == 422) && error.code in REPRICED
    /** The acknowledgement must be the consented purchase: the quoted total and every eligible wall at its quoted target. */
    override fun acknowledge(intent: PendingIntent, response: JsonObject): WallRowAcceptance {
        val quote = quote(intent); val result = WallRowResult.from(response)
        require(amount(result.costShards) == amount(quote.totalCostShards)) { "The wall purchase differs from the quote" }
        val eligible = quote.eligible.associate { uuid(it.id).lowercase() to requireNotNull(it.targetLevel) }
        val upgraded = result.upgraded.associate { uuid(it.id).lowercase() to it.level }
        require(upgraded.isNotEmpty() && upgraded == eligible) { "The upgraded walls differ from the quote" }
        return WallRowAcceptance(result.upgraded, result.costShards, result.duplicate)
    }
    override fun restore(intent: PendingIntent, document: JsonObject): WallRowAcceptance = when (ReceiptDocument.source(document)) {
        ReceiptDocument.SOURCE_POST -> acknowledge(intent, ReceiptDocument.payload(document))
        else -> throw ApiCompatibilityException(intent.path)
    }
}

/** Second layout slot: `POST /base/layouts/FARM/unlock {baseId, idempotencyKey}` (web `LayoutEditor`
 * unlockFarm, api `unlockFarmLayout`). Charged once; an already-unlocked slot answers `chargedShards: "0"`,
 * and the ledger key replays, so a lost reply is recovered by explicit retry. No receipt route exists. */
data class LayoutUnlockAcceptance(val chargedShards: String, val balanceShards: String)

object LayoutUnlockSpec : MoneyOpSpec<LayoutUnlockAcceptance> {
    const val PATH = "/base/layouts/FARM/unlock"
    override val kind = IntentKind.LAYOUT_UNLOCK
    /** No receipt route: GET /base/layouts proves the slot is still locked, so this unlock (charge and unlock commit
     * together) was never committed (dead-end audit 2026-10-06). An unlocked slot stays Unsupported; TRY AGAIN answers 0. */
    override val savedRequestExit = SavedRequestExit.FORGET_AFTER_SERVER_ABSENT
    override fun absenceRequest(intent: PendingIntent): ReceiptRequest? = intent.baseId?.let { ReceiptRequest("/base/layouts", mapOf("baseId" to it)) }
    override fun provesAbsence(intent: PendingIntent, response: JsonObject): Boolean {
        require(response.text("baseId").equals(requireNotNull(intent.baseId), ignoreCase = true)) { "The layouts answered for another base" }
        return (response["farmUnlock"] as? JsonObject)?.get("locked") == JsonPrimitive(true)
    }
    fun intent(wallet: String, baseId: String, idempotencyKey: String): PendingIntent =
        PendingIntent(kind, wallet, uuid(baseId), idempotencyKey, PATH, buildJsonObject { put("baseId", baseId); put("idempotencyKey", idempotencyKey) }, "Unlock layout slot")
    override fun receiptRequest(intent: PendingIntent): ReceiptRequest? = null
    override fun decodeReceipt(intent: PendingIntent, response: JsonObject): Receipt<LayoutUnlockAcceptance> = Receipt.Unsupported
    override fun acknowledge(intent: PendingIntent, response: JsonObject): LayoutUnlockAcceptance {
        val result = FarmUnlockResult.from(response)
        require(result.slot == "FARM" && !result.locked) { "The layout slot is still locked" }
        require(uuid(result.baseId).equals(requireNotNull(intent.baseId), ignoreCase = true)) { "The unlock answered for another base" }
        return LayoutUnlockAcceptance(amount(result.chargedShards), amount(result.balanceShards))
    }
    override fun restore(intent: PendingIntent, document: JsonObject): LayoutUnlockAcceptance = when (ReceiptDocument.source(document)) {
        ReceiptDocument.SOURCE_POST -> acknowledge(intent, ReceiptDocument.payload(document))
        else -> throw ApiCompatibilityException(PATH)
    }
}

private val TROOP_OR_HERO_KEY = Regex("[a-z][a-z0-9_]*")
private val ITEM_ID = Regex("[a-z0-9_]{1,64}")
private fun JsonObject.whole(key: String): Int = requireNotNull((this[key] as? JsonPrimitive)?.takeUnless { it.isString }?.intOrNull) { "Missing whole number $key" }
private fun JsonObject.bool(key: String): Boolean = requireNotNull((this[key] as? JsonPrimitive)?.takeUnless { it.isString }?.booleanOrNull) { "Missing flag $key" }
/** Production writes some money amounts as JSON numbers (`costKeep: spec.costKeep`); the exact text is kept either way. */
private fun JsonObject.decimal(key: String): String = amount(requireNotNull((this[key] as? JsonPrimitive)?.takeIf { it !is JsonNull }?.content) { "Missing amount $key" })
/** Hero level purchase freezes one level and maximum price. Only a matching ledger receipt or
 * the saved POST acknowledgement identifies it; a current roster cannot substitute for either. */
data class HeroUpgradeAcceptance(val hero: String, val level: Int, val tierName: String?, val spentKeep: String, val replayed: Boolean, val currency: String = "KEEP")

/** Exact Hero admission only: each allowlisted code is raised before effects or rolls back the
 * original transaction. This never applies to an already attempted key or a receipt GET failure. */
private fun heroInitialRefusal(intent: PendingIntent, error: ApiException): Boolean {
    if (intent.expectedCurrency == null) return isDefinitiveRejection(error.status)
    return when (error.status) {
        409 -> when (error.code) {
            "HERO_CONSENT_STALE", "HERO_PRICE_CHANGED", "BASE_ID_REQUIRED", "DEED_OWNERSHIP_CHANGED" -> true
            "CURRENCY_CONSENT_CHANGED" -> error.details?.get("expectedCurrency") == JsonPrimitive(intent.expectedCurrency)
            "HERO_NOT_RECOVERING" -> intent.kind == IntentKind.HERO_RECOVERY
            else -> false
        }
        404 -> error.code == "BASE_NOT_OWNED"
        422 -> intent.kind == IntentKind.HERO_UPGRADE && error.code == "HERO_NOT_RECRUITED"
        423 -> error.code == "BASE_BEING_RAIDED"
        503 -> error.code == "DEED_AUTHORITY_UNAVAILABLE"
        else -> false
    }
}

object HeroUpgradeSpec : MoneyOpSpec<HeroUpgradeAcceptance> {
    override fun definitiveInitialRejection(intent: PendingIntent, error: ApiException) = heroInitialRefusal(intent, error)
    override fun observedInitialRejection(intent: PendingIntent, error: ApiException) = intent.expectedCurrency != null && heroInitialRefusal(intent, error)
    override val kind = IntentKind.HERO_UPGRADE
    /** The receipt answers `unknown` only for exactly this key ([decodeReceipt]). */
    override val savedRequestExit = SavedRequestExit.FORGET_AFTER_SERVER_ABSENT
    fun path(hero: String) = "/heroes/${hero.also { require(TROOP_OR_HERO_KEY.matches(it)) }}/upgrade"
    /** [level] and [costKeep] are the server's `next` values the tapped button printed (web heroes.tsx HeroRow). */
    fun intent(wallet: String, baseId: String?, hero: String, idempotencyKey: String, level: Int, costKeep: String, expectedCurrency: String? = null): PendingIntent {
        baseId?.let(::uuid); require(level > 1) { "A hero upgrade buys a level above the first" }; amount(costKeep)
        return PendingIntent(kind, wallet, baseId, idempotencyKey, path(hero),
            buildJsonObject { put("idempotencyKey", idempotencyKey); baseId?.let { put("baseId", it) }
                put("consent", buildJsonObject { put("expectedLevel", level - 1); put("maxCostKeep", costKeep) }) }, "Upgrade ${hero.uppercase()} to level $level",
            buildJsonObject { put("hero", hero); put("level", level); put("costKeep", costKeep) }, expectedCurrency = expectedCurrency)
    }
    fun hero(intent: PendingIntent): String = requireNotNull(intent.quote).text("hero").also { require(TROOP_OR_HERO_KEY.matches(it)) }
    fun level(intent: PendingIntent): Int = requireNotNull(intent.quote).whole("level")
    fun costKeep(intent: PendingIntent): String = amount(requireNotNull(intent.quote).text("costKeep"))
    private fun receiptBody(intent: PendingIntent) = heroReceiptIdentity(intent, hero(intent), buildJsonObject {
        put("expectedLevel", level(intent) - 1); put("maxCostKeep", costKeep(intent))
    })
    override fun validateSend(intent: PendingIntent) {
        if (intent.expectedCurrency != null) {
            require(intent.kind == kind && intent.path == path(hero(intent)))
            validateHeroCommand(intent, receiptBody(intent))
        }
    }
    override fun acknowledgementDocument(response: JsonObject) = heroAcknowledgementDocument(response)
    override fun receiptRequest(intent: PendingIntent) = heroReceiptRequest(intent, receiptBody(intent))
    /** `{hero, level, tierName, spentKeep, duplicate}`: the bought level is at least the consented one and the
     * debit never exceeds the price the button printed (`"0"` on a replay). */
    override fun acknowledge(intent: PendingIntent, response: JsonObject): HeroUpgradeAcceptance {
        if (intent.expectedCurrency != null) return (decodeReceipt(intent, response) as? Receipt.Accepted)?.value
            ?: throw ApiCompatibilityException(intent.path)
        require(response.text("hero") == hero(intent)) { "The upgrade answered for another hero" }
        val level = response.whole("level")
        require(if (intent.body.containsKey("consent")) level == level(intent) else level >= level(intent)) { "The server reports a different hero level than was bought" }
        val spent = response.decimal("spentKeep")
        require(spent.toBigInteger() <= costKeep(intent).toBigInteger()) { "The hero upgrade charged more than the approved KEEP price" }
        return HeroUpgradeAcceptance(hero(intent), level, response.optionalText("tierName"), spent, response.bool("duplicate"))
    }
    override fun restore(intent: PendingIntent, document: JsonObject): HeroUpgradeAcceptance = when (ReceiptDocument.source(document)) {
        ReceiptDocument.SOURCE_POST -> acknowledge(intent, ReceiptDocument.payload(document))
        else -> (decodeReceipt(intent, ReceiptDocument.payload(document)) as? Receipt.Accepted)?.value ?: throw ApiCompatibilityException(intent.path)
    }
    override fun decodeReceipt(intent: PendingIntent, response: JsonObject): Receipt<HeroUpgradeAcceptance> = strict("${intent.path}/receipt") {
        if (response["version"] != JsonPrimitive(1)) return@strict Receipt.Unsupported
        when (response.text("status")) {
            "unknown" -> { require(response.text("idempotencyKey") == intent.idempotencyKey); Receipt.Unknown }
            "accepted" -> {
                val spent = validateHeroReceipt(intent, response, receiptBody(intent), costKeep(intent))
                val result = requireNotNull(response["result"] as? JsonObject)
                require(result.whole("fromLevel") == level(intent) - 1 && result.whole("toLevel") == level(intent))
                Receipt.Accepted(HeroUpgradeAcceptance(hero(intent), level(intent), null, spent, true, intent.expectedCurrency ?: "KEEP"), ReceiptDocument.fromReceiptRoute(response))
            }
            else -> Receipt.Unsupported
        }
    }
    // Base authority can change before a replay's duplicate lookup; no status disproves an earlier commit.

}

/** Paid recovery pins its original deadline and maximum charge. The read-only ledger receipt proves
 * that episode even after a new injury; current availability or natural expiry proves no payment. */
data class HeroRecoveryAcceptance(val hero: String, val spentKeep: String, val replayed: Boolean, val currency: String = "KEEP")

object HeroRecoverySpec : MoneyOpSpec<HeroRecoveryAcceptance> {
    override fun definitiveInitialRejection(intent: PendingIntent, error: ApiException) = heroInitialRefusal(intent, error)
    override fun observedInitialRejection(intent: PendingIntent, error: ApiException) = intent.expectedCurrency != null && heroInitialRefusal(intent, error)
    override val kind = IntentKind.HERO_RECOVERY
    /** The receipt answers `unknown` only for exactly this key ([decodeReceipt]). */
    override val savedRequestExit = SavedRequestExit.FORGET_AFTER_SERVER_ABSENT
    fun path(hero: String) = "/heroes/${hero.also { require(TROOP_OR_HERO_KEY.matches(it)) }}/recovery/speedup"
    /** [costKeep] is the server's `recoveryFinishNow.costKeep` the row rendered; [recoveryUntil] pins the episode. */
    fun intent(wallet: String, baseId: String?, hero: String, idempotencyKey: String, costKeep: String, recoveryUntil: String, expectedCurrency: String? = null): PendingIntent {
        baseId?.let(::uuid); amount(costKeep); timestamp(recoveryUntil)
        return PendingIntent(kind, wallet, baseId, idempotencyKey, path(hero),
            buildJsonObject { put("idempotencyKey", idempotencyKey); baseId?.let { put("baseId", it) }
                put("consent", buildJsonObject { put("recoveryUntil", recoveryUntil); put("maxCostKeep", costKeep) }) }, "Recover ${hero.uppercase()}",
            buildJsonObject { put("hero", hero); put("costKeep", costKeep); put("recoveryUntil", recoveryUntil) }, expectedCurrency = expectedCurrency)
    }
    fun hero(intent: PendingIntent): String = requireNotNull(intent.quote).text("hero").also { require(TROOP_OR_HERO_KEY.matches(it)) }
    fun costKeep(intent: PendingIntent): String = amount(requireNotNull(intent.quote).text("costKeep"))
    fun recoveryUntil(intent: PendingIntent): String = timestamp(requireNotNull(intent.quote).text("recoveryUntil"))
    private fun receiptBody(intent: PendingIntent) = heroReceiptIdentity(intent, hero(intent), buildJsonObject {
        put("recoveryUntil", recoveryUntil(intent)); put("maxCostKeep", costKeep(intent))
    })
    override fun validateSend(intent: PendingIntent) {
        if (intent.expectedCurrency != null) {
            require(intent.kind == kind && intent.path == path(hero(intent)))
            validateHeroCommand(intent, receiptBody(intent))
        }
    }
    override fun acknowledgementDocument(response: JsonObject) = heroAcknowledgementDocument(response)
    override fun receiptRequest(intent: PendingIntent) = heroReceiptRequest(intent, receiptBody(intent))
    /** `{hero, spentKeep, duplicate, recoveryUntil: null}`: the charge never exceeds the printed price. */
    override fun acknowledge(intent: PendingIntent, response: JsonObject): HeroRecoveryAcceptance {
        if (intent.expectedCurrency != null) return (decodeReceipt(intent, response) as? Receipt.Accepted)?.value
            ?: throw ApiCompatibilityException(intent.path)
        require(response.text("hero") == hero(intent)) { "The recovery answered for another hero" }
        require(response["recoveryUntil"] == JsonNull) { "The server did not release the hero" }
        val spent = response.decimal("spentKeep")
        require(spent.toBigInteger() <= costKeep(intent).toBigInteger()) { "The recovery charged more than the approved KEEP price" }
        return HeroRecoveryAcceptance(hero(intent), spent, response.bool("duplicate"))
    }
    override fun restore(intent: PendingIntent, document: JsonObject): HeroRecoveryAcceptance = when (ReceiptDocument.source(document)) {
        ReceiptDocument.SOURCE_POST -> acknowledge(intent, ReceiptDocument.payload(document))
        else -> (decodeReceipt(intent, ReceiptDocument.payload(document)) as? Receipt.Accepted)?.value ?: throw ApiCompatibilityException(intent.path)
    }
    override fun decodeReceipt(intent: PendingIntent, response: JsonObject): Receipt<HeroRecoveryAcceptance> = strict("${intent.path}/receipt") {
        if (response["version"] != JsonPrimitive(1)) return@strict Receipt.Unsupported
        when (response.text("status")) {
            "unknown" -> { require(response.text("idempotencyKey") == intent.idempotencyKey); Receipt.Unknown }
            "accepted" -> {
                val spent = validateHeroReceipt(intent, response, receiptBody(intent), costKeep(intent))
                val result = requireNotNull(response["result"] as? JsonObject)
                require(Instant.parse(result.text("recoveryUntil")) == Instant.parse(recoveryUntil(intent)))
                Receipt.Accepted(HeroRecoveryAcceptance(hero(intent), spent, true, intent.expectedCurrency ?: "KEEP"), ReceiptDocument.fromReceiptRoute(response))
            }
            else -> Receipt.Unsupported
        }
    }
}

/** Query from the persisted quote also supports old pending bodies, without ever rewriting or
 * retrying their POST. A mismatched receipt remains unresolved through strict decode failure. */
private fun heroAcknowledgementDocument(response: JsonObject) =
    if (response["status"] == JsonPrimitive("accepted")) ReceiptDocument.fromReceiptRoute(response) else ReceiptDocument.fromPost(response)
private fun validateHeroCommand(intent: PendingIntent, request: JsonObject) {
    val expected = buildJsonObject {
        put("idempotencyKey", intent.idempotencyKey); intent.baseId?.let { put("baseId", it) }
        put("consent", JsonObject(request.filterKeys { it !in setOf("hero", "baseId", "idempotencyKey") }))
    }
    require(intent.body == expected) { "The original Hero consent changed." }
}
private fun heroReceiptIdentity(intent: PendingIntent, hero: String, consent: JsonObject) = buildJsonObject {
    put("hero", hero); put("idempotencyKey", intent.idempotencyKey); intent.baseId?.let { put("baseId", it) }
    for ((key, value) in consent) put(key, value)
}
private fun heroReceiptRequest(intent: PendingIntent, request: JsonObject) = ReceiptRequest("${intent.path}/receipt",
    request.filterKeys { it != "hero" }.mapValues { it.value.jsonPrimitive.content })
private fun validateHeroReceipt(intent: PendingIntent, response: JsonObject, request: JsonObject, ceiling: String): String {
    require(response["request"] == request && response.text("wallet") == intent.wallet)
    if (intent.baseId == null) require(response["baseId"] == JsonNull)
    else require(uuid(response.text("baseId")).equals(uuid(intent.baseId), ignoreCase = true))
    uuid(response.text("receiptId")); timestamp(response.text("acceptedAt"))
    val funding = requireNotNull(response["funding"] as? JsonObject)
    require(funding.text("currency") == (intent.expectedCurrency ?: "KEEP"))
    return amount(funding.text("amount")).also {
        require(it.toBigInteger().signum() > 0 && it.toBigInteger() <= ceiling.toBigInteger())
    }
}

/** Shop purchase: `POST /items/buy {itemId, idempotencyKey, baseId?}` → 201 `{itemId, costKeep, duplicate}`
 * (apps/api/src/game/items.ts `buyItem`). The charge and the grant commit together; the key is namespaced
 * `item:{wallet}:{base}:{key}` and a replay answers `duplicate: true` before any capacity or max-owned
 * check, so re-sending the same intent can never charge or grant twice. A legacy purchase (no consent) has no receipt
 * route and an inventory read cannot tell it from another, so its lost reply is recovered only by explicit retry.
 *
 * A CONSENTED purchase (night/server 231e6cff9, packages/shared/src/itemPurchase.ts ItemPurchaseIntentSchema) also sends
 * `consent {version:1, catalogRevision, quantity:1, maxCostKeep}` with the exact currency header, and the server records
 * that request with its charge, so `GET /items/buy/receipt?itemId&idempotencyKey[&baseId]` answers for exactly this key:
 * `accepted` (the original proof), `unknown` (a ledger row holds this key but does not match) or `absent` (no row). */
data class ItemPurchaseAcceptance(val itemId: String, val costKeep: String, val replayed: Boolean)

object ItemBuySpec : MoneyOpSpec<ItemPurchaseAcceptance> {
    const val PATH = "/items/buy"
    const val RECEIPT = "/items/buy/receipt"
    override val kind = IntentKind.ITEM_BUY
    /** Owner review 2026-10-06 (B1): every refusal the server can give a replay (429 limiter, 401 session, 409
     * BASE_ID_REQUIRED, 422 acquisition gate) is raised BEFORE spendGameCurrency claims the key, so none proves the original
     * never committed: [refusedAfterKeyLookup] stays false and a purchase keeps blocking new purchases until TRY AGAIN
     * resolves it. A consented purchase has a second way out: the keyed receipt's `absent`, read the minimum age after the
     * send, lets CLOSE archive it ([forgetsOnServerAbsent]). Its `unknown` keeps blocking: on this route it means a ledger
     * row already holds this key, so a new purchase could be a second charge for the same one. */
    override val savedRequestExit = SavedRequestExit.PARK_AFTER_RETRY_REFUSED
    override fun forgetsOnServerAbsent(intent: PendingIntent) = consented(intent)
    override fun unblocksAfterCheck(intent: PendingIntent, answer: Receipt<*>) = consented(intent) && answer == Receipt.Absent
    fun intent(wallet: String, baseId: String?, itemId: String, idempotencyKey: String, costKeep: String, name: String): PendingIntent {
        baseId?.let(::uuid); require(ITEM_ID.matches(itemId)) { "Unknown item" }; amount(costKeep)
        return PendingIntent(kind, wallet, baseId, idempotencyKey, PATH,
            buildJsonObject { put("itemId", itemId); put("idempotencyKey", idempotencyKey); baseId?.let { put("baseId", it) } }, "Buy ${name.ifBlank { itemId }}",
            buildJsonObject { put("itemId", itemId); put("costKeep", costKeep); put("name", name) })
    }
    /** A consented purchase: the legacy body plus `consent` ([costKeep] is the price the player saw, frozen as maxCostKeep)
     * and the exact [expectedCurrency] header, so the server can answer the keyed receipt for it. */
    fun consentedIntent(wallet: String, baseId: String?, itemId: String, idempotencyKey: String, costKeep: String, name: String,
                        catalogRevision: Int, expectedCurrency: String): PendingIntent {
        require(costKeep.matches(PRICE)) { "This item has no price" }; require(catalogRevision > 0) { "Refresh the shop first" }
        require(expectedCurrency == "KEEP" || expectedCurrency == "GEMS")
        val legacy = intent(wallet, baseId, itemId, idempotencyKey, costKeep, name)
        val consent = buildJsonObject { put("version", 1); put("catalogRevision", catalogRevision); put("quantity", 1); put("maxCostKeep", costKeep) }
        return legacy.copy(body = JsonObject(legacy.body + ("consent" to consent)), expectedCurrency = expectedCurrency)
    }
    /** Only a consented purchase has a receipt; a legacy POST posts a different ledger record the route would misread. */
    fun consented(intent: PendingIntent): Boolean = intent.expectedCurrency != null && intent.body["consent"] is JsonObject
    fun itemId(intent: PendingIntent): String = intent.body.text("itemId").also { require(ITEM_ID.matches(it)) }
    fun costKeep(intent: PendingIntent): String = amount(requireNotNull(intent.quote).text("costKeep"))
    private fun consent(intent: PendingIntent): JsonObject = requireNotNull(intent.body["consent"] as? JsonObject).also { c ->
        require(c.keys == setOf("version", "catalogRevision", "quantity", "maxCostKeep") && c["version"] == JsonPrimitive(1) && c["quantity"] == JsonPrimitive(1))
        require(((c["catalogRevision"] as? JsonPrimitive)?.takeUnless { it.isString }?.intOrNull ?: 0) > 0)
        require(c.text("maxCostKeep").matches(PRICE))
    }
    private fun bodyBaseId(intent: PendingIntent): String? = (intent.body["baseId"] as? JsonPrimitive)?.contentOrNull?.let(::uuid)?.lowercase()
    override fun validateSend(intent: PendingIntent) {
        if (intent.expectedCurrency == null && !intent.body.containsKey("consent")) return
        require(consented(intent) && intent.body.keys - "baseId" == setOf("itemId", "idempotencyKey", "consent")) { "Unsupported saved item purchase" }
        itemId(intent); consent(intent); bodyBaseId(intent)
        require(intent.body.text("idempotencyKey") == intent.idempotencyKey)
    }
    override fun receiptRequest(intent: PendingIntent): ReceiptRequest? = if (!consented(intent)) null else
        ReceiptRequest(RECEIPT, buildMap { put("itemId", itemId(intent)); put("idempotencyKey", intent.idempotencyKey); bodyBaseId(intent)?.let { put("baseId", it) } })
    /** The original request as the server echoes it (ItemPurchaseIntentSchema): base lowercased, or null. */
    private fun echoedRequest(intent: PendingIntent) = buildJsonObject {
        put("itemId", itemId(intent)); put("baseId", bodyBaseId(intent)?.let(::JsonPrimitive) ?: JsonNull)
        put("idempotencyKey", intent.idempotencyKey); put("expectedCurrency", requireNotNull(intent.expectedCurrency)); put("consent", consent(intent))
    }
    override fun decodeReceipt(intent: PendingIntent, response: JsonObject): Receipt<ItemPurchaseAcceptance> {
        if (!consented(intent)) return Receipt.Unsupported
        return strict(RECEIPT) {
            if (response["version"] != JsonPrimitive(1)) return@strict Receipt.Unsupported
            when (response.text("status")) {
                "unknown" -> { require(response.keys == setOf("version", "status", "idempotencyKey") && response.text("idempotencyKey") == intent.idempotencyKey); Receipt.Unknown }
                "accepted" -> Receipt.Accepted(proof(intent, response), ReceiptDocument.fromReceiptRoute(response))
                else -> Receipt.Unsupported
            }
        }
    }
    /** ItemPurchaseProofSchema with its refine: same wallet and original request, the consented currency, an amount within
     * the consented price, and the bought item. */
    private fun proof(intent: PendingIntent, response: JsonObject): ItemPurchaseAcceptance {
        require(response.keys == setOf("version", "status", "wallet", "request", "receiptId", "acceptedAt", "funding", "result"))
        require(response.text("wallet") == intent.wallet && response["request"] == echoedRequest(intent))
        uuid(response.text("receiptId")); timestamp(response.text("acceptedAt"))
        val funding = requireNotNull(response["funding"] as? JsonObject); require(funding.keys == setOf("currency", "amount"))
        require(funding.text("currency") == intent.expectedCurrency)
        val paid = funding.text("amount").also { require(it.matches(PRICE)) }
        require(paid.toBigInteger() <= consent(intent).text("maxCostKeep").toBigInteger()) { "The purchase charged more than the approved price" }
        require(response["result"] == buildJsonObject { put("itemId", itemId(intent)); put("quantity", 1) })
        return ItemPurchaseAcceptance(itemId(intent), paid, replayed = true)
    }
    /** The server owns the price (the web sends no confirmed amount for items); the acknowledgement reports what it charged.
     * A consented purchase must also report the consented currency and no more than the consented price. */
    override fun acknowledge(intent: PendingIntent, response: JsonObject): ItemPurchaseAcceptance {
        require(response.text("itemId") == itemId(intent)) { "The purchase answered for another item" }
        val charged = response.decimal("costKeep")
        if (consented(intent)) {
            require(response.text("currency") == intent.expectedCurrency) { "The purchase was paid in another currency" }
            require(charged.toBigInteger() <= consent(intent).text("maxCostKeep").toBigInteger()) { "The purchase charged more than the approved price" }
        }
        return ItemPurchaseAcceptance(itemId(intent), charged, response.bool("duplicate"))
    }
    override fun restore(intent: PendingIntent, document: JsonObject): ItemPurchaseAcceptance = when (ReceiptDocument.source(document)) {
        ReceiptDocument.SOURCE_POST -> acknowledge(intent, ReceiptDocument.payload(document))
        ReceiptDocument.SOURCE_RECEIPT -> strict(RECEIPT) { proof(intent, ReceiptDocument.payload(document)) }
        else -> throw ApiCompatibilityException(PATH)
    }
    private val PRICE = Regex("[1-9][0-9]{0,18}")
    // A replay may fail an acquisition/base gate before the ledger duplicate lookup. Its 404/422
    // therefore cannot disprove an earlier commit. MoneyOp still retires definitive FIRST refusals.
}

/** Consumable use: `POST /items/use {itemId, jobId?, idempotencyKey, baseId?}` → `{used, left, effect}` (items.ts
 * `useItem`). The key claim (`use:{wallet}:{base}:{key}`) is the FIRST write of the transaction and the unit
 * decrement commits with the effect, so: a replay answers `409 duplicate use request` (this intent landed —
 * the rejection resolves it), and every 422/404 is raised statelessly or after a fresh claim (nothing
 * landed). A successful inventory read cannot prove a lost reply either way (web inventory.tsx), so there is
 * no receipt route; the saved intent blocks another use until it is retried or resolved. */
data class ItemUseAcceptance(val itemId: String, val left: Int?, val effect: JsonObject?, val replayed: Boolean)

object ItemUseSpec : MoneyOpSpec<ItemUseAcceptance> {
    const val PATH = "/items/use"
    const val DUPLICATE_MESSAGE = "duplicate use request"
    override val kind = IntentKind.ITEM_USE
    /** As [ItemBuySpec] (B1): current item/base gates run before the use claim, so no refusal of a replay proves the
     * original never committed; it keeps blocking another use until TRY AGAIN resolves it. */
    override val savedRequestExit = SavedRequestExit.PARK_AFTER_RETRY_REFUSED
    fun intent(wallet: String, baseId: String?, itemId: String, idempotencyKey: String, name: String, jobId: String? = null): PendingIntent {
        baseId?.let(::uuid); jobId?.let(::uuid); require(ITEM_ID.matches(itemId)) { "Unknown item" }
        return PendingIntent(kind, wallet, baseId, idempotencyKey, PATH,
            buildJsonObject { put("itemId", itemId); jobId?.let { put("jobId", it) }; put("idempotencyKey", idempotencyKey); baseId?.let { put("baseId", it) } },
            "Use ${name.ifBlank { itemId }}", buildJsonObject { put("itemId", itemId); put("name", name) })
    }
    fun itemId(intent: PendingIntent): String = intent.body.text("itemId").also { require(ITEM_ID.matches(it)) }
    override fun receiptRequest(intent: PendingIntent): ReceiptRequest? = null
    override fun decodeReceipt(intent: PendingIntent, response: JsonObject): Receipt<ItemUseAcceptance> = Receipt.Unsupported
    override fun acknowledge(intent: PendingIntent, response: JsonObject): ItemUseAcceptance {
        require(response.text("used") == itemId(intent)) { "The server used another item" }
        val left = response.whole("left").also { require(it >= 0) }
        return ItemUseAcceptance(itemId(intent), left, requireNotNull(response["effect"] as? JsonObject) { "No effect was reported" }, replayed = false)
    }
    override fun restore(intent: PendingIntent, document: JsonObject): ItemUseAcceptance = when (ReceiptDocument.source(document)) {
        ReceiptDocument.SOURCE_POST -> acknowledge(intent, ReceiptDocument.payload(document))
        ReceiptDocument.SOURCE_REJECTION -> ItemUseAcceptance(itemId(intent), null, null, replayed = true)
        else -> throw ApiCompatibilityException(PATH)
    }
    /** The uncoded 409 the unique key claim raises for a key this wallet already consumed: the server's own
     * word that THIS request landed. A coded 409 (`BASE_ID_REQUIRED`) is an ordinary refusal. */
    override fun resolveRejection(intent: PendingIntent, error: ApiException): Receipt.Accepted<ItemUseAcceptance>? {
        if (error.status != 409 || error.code != null || !error.message.startsWith(DUPLICATE_MESSAGE)) return null
        val document = ReceiptDocument.fromRejection(buildJsonObject { put("status", 409); put("message", error.message); put("itemId", itemId(intent)) })
        return Receipt.Accepted(ItemUseAcceptance(itemId(intent), null, null, replayed = true), document)
    }
    // Current item/base gates run before the duplicate claim. A replay refusal cannot
    // disprove an earlier committed use; only a definitive first refusal retires it.
}
