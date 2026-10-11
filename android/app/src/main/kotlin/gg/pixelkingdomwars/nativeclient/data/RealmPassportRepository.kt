package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.session.AccountSessionHolder
import java.time.Instant
import java.time.format.DateTimeFormatterBuilder
import gg.pixelkingdomwars.nativeclient.starter.paidStarterRealmIds
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

@Serializable data class PassportExpedition(val kind: String, val expeditionId: String, val returnId: String,
    val originalBaseId: String, val realmId: String, val routeId: String, val routeVersion: Int?, val policyVersion: Int?,
    val departedAt: String, val scheduledReturnAt: String, val returnedAt: String)
@Serializable data class PassportExpeditions(val kind: String, val rows: List<PassportExpedition>, val nextCursor: String?)
@Serializable data class PassportLeaf(val wallet: String, val sequence: String, val cumulativeKeepBaseUnits: String,
    val cumulativeRenown: String, val cumulativeDays: String)
@Serializable data class PassportProof(val hash: String, val sumBaseUnits: String, val isLeft: Boolean)
@Serializable data class PassportInclusion(val sequence: String, val day: String, val root: String, val sourceHash: String,
    val publicationSignature: String, val publicationSlot: Long, val genesisHash: String, val programId: String,
    val configAddress: String, val keepMint: String, val reserveOwner: String, val totalCumulativeBaseUnits: String,
    val leaf: PassportLeaf, val proof: List<PassportProof>)
@Serializable data class PassportInclusions(val rows: List<PassportInclusion>, val nextCursor: String?)
@Serializable data class PassportPublished(val cumulativeRenown: String, val cumulativeDays: String)
@Serializable data class PassportAttested(val renownTotal: String, val daysAttested: String, val lastSequence: String)
@Serializable data class PassportCurrent(val observedSlot: Long, val chainUnixTimestamp: String, val publicationSequence: String,
    val published: PassportPublished, val attested: PassportAttested?)

/** Immutable display observations only. These types cannot enter claim preparation or reward code. */
data class PassportObservation<T>(val data: T?, val serverNow: String, val unavailableReason: String?)
data class PassportSection<T>(val observation: PassportObservation<T>? = null, val busy: Boolean = false, val error: String? = null)
data class RealmPassportState(val discoverable: Boolean = false, val expeditions: PassportSection<PassportExpeditions> = PassportSection(),
    val inclusions: PassportSection<PassportInclusions> = PassportSection(), val current: PassportSection<PassportCurrent> = PassportSection())

object RealmPassportWire {
    private val json = Json { ignoreUnknownKeys = false; isLenient = false; coerceInputValues = false }
    private val decimal = Regex("0|[1-9][0-9]*")
    private val uuid = Regex("(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)")
    // Frozen transport bounds from realmPassportApi.ts, not game tuning.
    private const val PAGE_SIZE = 20
    private const val PROOF_SIZE = 16
    private val route = Regex("(?:[a-z][a-z0-9_]*|[a-z][a-z0-9]*(?:[_-][a-z0-9]+)*)")
    private val canonicalTime = DateTimeFormatterBuilder().appendInstant(3).toFormatter()
    private val hash = Regex("[0-9a-f]{64}")
    private val base58 = Regex("[1-9A-HJ-NP-Za-km-z]+")
    private fun amount(value: String, positive: Boolean = false) {
        require(value.length <= 20 && decimal.matches(value) && value.toBigInteger() <= "18446744073709551615".toBigInteger())
        if (positive) require(value != "0")
    }
    private fun address(value: String) { require(value.length in 32..44 && base58.matches(value)) }
    private fun time(value: String) {
        require(Regex("""\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z""").matches(value))
        require(canonicalTime.format(Instant.parse(value)) == value)
    }
    private fun safe(value: Long) { require(value in 0..9_007_199_254_740_991L) }
    // Kotlin's JSON decoder accepts quoted numeric/Boolean primitives even with
    // isLenient=false. Preserve the shared wire grammar before typed decoding.
    private fun JsonObject.numeric(name: String, nullable: Boolean = false) {
        val value = getValue(name)
        if (nullable && value == JsonNull) return
        require(value is JsonPrimitive && !value.isString && value.longOrNull != null)
    }

    private fun <T> envelope(raw: JsonObject, wallet: String, decode: (JsonObject) -> T): PassportObservation<T> {
        val state = raw["state"]?.jsonPrimitive?.content
        require(raw.keys == if (state == "available") setOf("version", "wallet", "serverNow", "projection", "state", "data")
            else setOf("version", "wallet", "serverNow", "projection", "state", "reason", "data"))
        require(raw["version"] == JsonPrimitive(1) && raw["wallet"] == JsonPrimitive(wallet) && raw["projection"] == JsonPrimitive("history-only"))
        val now = raw.getValue("serverNow").jsonPrimitive.let { require(it.isString); it.content }.also(::time)
        return when (state) {
            "available" -> PassportObservation(decode(raw.getValue("data").jsonObject), now, null)
            "unavailable" -> {
                val reason = raw["reason"]?.jsonPrimitive?.content
                require(reason in setOf("SOURCE_UNAVAILABLE", "SOURCE_CONFLICT", "NOT_CONFIGURED") && raw["data"] == JsonNull)
                PassportObservation(null, now, reason)
            }
            else -> error("Unsupported Passport response")
        }
    }
    fun expeditions(raw: JsonObject, wallet: String, kind: String, cursor: String?): PassportObservation<PassportExpeditions> = envelope(raw, wallet) {
        require(kind in setOf("starter", "advanced")); cursor?.let { require(uuid.matches(it)) }
        it.getValue("rows").jsonArray.forEach { element -> element.jsonObject.apply {
            numeric("routeVersion", nullable = true); numeric("policyVersion", nullable = true)
        } }
        json.decodeFromJsonElement<PassportExpeditions>(it).also { page ->
            require(page.kind == kind && page.rows.size <= PAGE_SIZE)
            var previous = cursor
            page.rows.forEach { row ->
                require(row.kind == kind && uuid.matches(row.expeditionId) && uuid.matches(row.returnId) && uuid.matches(row.originalBaseId))
                require(previous == null || row.expeditionId > previous!!); previous = row.expeditionId
                require(row.realmId in paidStarterRealmIds && row.routeId.length in 1..64 && route.matches(row.routeId))
                if (kind == "starter") require(row.routeVersion != null && row.routeVersion > 0 && row.policyVersion == null)
                else require(row.routeVersion == null && row.policyVersion != null && row.policyVersion > 0)
                listOf(row.departedAt, row.scheduledReturnAt, row.returnedAt).forEach(::time)
                require(Instant.parse(row.departedAt) < Instant.parse(row.scheduledReturnAt) && Instant.parse(row.scheduledReturnAt) <= Instant.parse(row.returnedAt))
            }
            if (page.nextCursor != null) require(page.rows.size == PAGE_SIZE && page.nextCursor == page.rows.last().expeditionId)
        }
    }
    fun inclusions(raw: JsonObject, wallet: String, cursor: String?): PassportObservation<PassportInclusions> = envelope(raw, wallet) {
        cursor?.let { amount(it, true) }
        it.getValue("rows").jsonArray.forEach { element -> element.jsonObject.apply {
            numeric("publicationSlot")
            getValue("proof").jsonArray.forEach { node -> node.jsonObject.apply {
                val direction = getValue("isLeft")
                require(direction is JsonPrimitive && !direction.isString && direction.booleanOrNull != null)
            } }
        } }
        json.decodeFromJsonElement<PassportInclusions>(it).also { page ->
            require(page.rows.size <= PAGE_SIZE)
            val first = page.rows.firstOrNull()
            var previous = cursor?.toBigInteger()
            page.rows.forEach { row ->
                amount(row.sequence, true); amount(row.day, true); amount(row.totalCumulativeBaseUnits, true); safe(row.publicationSlot)
                require(previous == null || row.sequence.toBigInteger() > previous!!); previous = row.sequence.toBigInteger()
                require(hash.matches(row.root) && hash.matches(row.sourceHash))
                require(row.publicationSignature.length in 64..88 && base58.matches(row.publicationSignature))
                listOf(row.genesisHash, row.programId, row.configAddress, row.keepMint, row.reserveOwner).forEach(::address)
                require(row.leaf.wallet == wallet && row.leaf.sequence == row.sequence)
                amount(row.leaf.cumulativeKeepBaseUnits, true); amount(row.leaf.cumulativeRenown); amount(row.leaf.cumulativeDays)
                require(row.leaf.cumulativeKeepBaseUnits.toBigInteger() <= row.totalCumulativeBaseUnits.toBigInteger())
                require(row.leaf.cumulativeRenown.toBigInteger() <= row.leaf.cumulativeDays.toBigInteger())
                require(row.proof.size <= PROOF_SIZE && row.genesisHash == first!!.genesisHash && row.programId == first.programId && row.configAddress == first.configAddress)
                row.proof.forEach { node -> require(hash.matches(node.hash)); amount(node.sumBaseUnits) }
            }
            if (page.nextCursor != null) require(page.rows.size == PAGE_SIZE && page.nextCursor == page.rows.last().sequence)
        }
    }
    fun current(raw: JsonObject, wallet: String): PassportObservation<PassportCurrent> = envelope(raw, wallet) {
        it.numeric("observedSlot")
        json.decodeFromJsonElement<PassportCurrent>(it).also { value ->
            safe(value.observedSlot); amount(value.chainUnixTimestamp); amount(value.publicationSequence, true)
            amount(value.published.cumulativeRenown); amount(value.published.cumulativeDays)
            require(value.published.cumulativeRenown.toBigInteger() <= value.published.cumulativeDays.toBigInteger())
            value.attested?.let { record ->
                amount(record.renownTotal); amount(record.daysAttested); amount(record.lastSequence)
                require(record.renownTotal.toBigInteger() <= value.published.cumulativeRenown.toBigInteger() &&
                    record.daysAttested.toBigInteger() <= value.published.cumulativeDays.toBigInteger() &&
                    record.lastSequence.toBigInteger() <= value.publicationSequence.toBigInteger())
            }
        }
    }
}

/** GET-only, account-scoped, one page per history. A failed current observation never leaves stale current facts. */
class RealmPassportRepository(private val session: AccountSession, private val holder: AccountSessionHolder, private val api: ApiClient) {
    private val mutable = MutableStateFlow(RealmPassportState()); val state = mutable.asStateFlow()
    private val admission = Mutex()
    private var generation = 0L
    fun dismiss(clearDiscovery: Boolean = true) {
        generation++
        mutable.value = RealmPassportState(discoverable = !clearDiscovery && mutable.value.discoverable)
    }
    private suspend fun guard(epoch: Long) { currentCoroutineContext().ensureActive(); holder.requireCurrent(session); if (epoch != generation) throw CancellationException("Passport closed") }
    private class SourceChanged : Exception()
    private suspend fun read(start: () -> Unit, failure: (Exception) -> Unit, finish: () -> Unit, block: suspend (Long) -> Unit) {
        if (!admission.tryLock()) return
        val epoch = generation
        try {
            guard(epoch); start()
            try { block(epoch) } catch (e: CancellationException) { throw e } catch (error: Exception) { guard(epoch); failure(error) }
        } finally { admission.unlock(); if (holder.isCurrent(session) && epoch == generation) finish() }
    }
    /** One bounded configured-history probe. It retains no returned private rows. */
    suspend fun discover() {
        if (state.value.discoverable) return
        read({}, { mutable.value = RealmPassportState() }, {}) { epoch ->
            val raw = api.get("/realm-passport/expeditions", mapOf("kind" to "starter")); guard(epoch)
            RealmPassportWire.expeditions(raw, session.wallet, "starter", null)
            mutable.value = RealmPassportState(discoverable = true)
        }
    }
    suspend fun expeditions(kind: String, next: Boolean = false) {
        require(kind in setOf("starter", "advanced"))
        val cursor = if (next) state.value.expeditions.observation?.data?.takeIf { it.kind == kind }?.nextCursor ?: return else null
        read({ mutable.value = mutable.value.copy(expeditions = if (next) mutable.value.expeditions.copy(busy = true, error = null) else PassportSection(busy = true)) },
            { mutable.value = mutable.value.copy(expeditions = mutable.value.expeditions.copy(error = "Expedition history could not be verified. Try again.")) },
            { mutable.value = mutable.value.copy(expeditions = mutable.value.expeditions.copy(busy = false)) }) { epoch ->
            val query = buildMap { put("kind", kind); if (cursor != null) put("cursor", cursor) }
            val raw = api.get("/realm-passport/expeditions", query); guard(epoch)
            val result = RealmPassportWire.expeditions(raw, session.wallet, kind, cursor)
            mutable.value = mutable.value.copy(expeditions = PassportSection(result))
        }
    }
    suspend fun inclusions(next: Boolean = false) {
        val cursor = if (next) state.value.inclusions.observation?.data?.nextCursor ?: return else null
        read({ mutable.value = mutable.value.copy(inclusions = if (next) mutable.value.inclusions.copy(busy = true, error = null) else PassportSection(busy = true)) },
            { mutable.value = mutable.value.copy(inclusions = mutable.value.inclusions.copy(error = if (it is SourceChanged) "Mining source changed. Refresh mining history from the start." else "Mining history could not be verified. Try again.")) },
            { mutable.value = mutable.value.copy(inclusions = mutable.value.inclusions.copy(busy = false)) }) { epoch ->
            val raw = api.get("/realm-passport/mining/inclusions", cursor?.let { mapOf("cursor" to it) } ?: emptyMap()); guard(epoch)
            val result = RealmPassportWire.inclusions(raw, session.wallet, cursor)
            if (next) {
                val previous = state.value.inclusions.observation?.data?.rows?.firstOrNull()
                val following = result.data?.rows?.firstOrNull()
                if (previous != null && following != null && (previous.genesisHash != following.genesisHash ||
                    previous.programId != following.programId || previous.configAddress != following.configAddress)) throw SourceChanged()
            }
            mutable.value = mutable.value.copy(inclusions = PassportSection(result))
        }
    }
    suspend fun current() = read({ mutable.value = mutable.value.copy(current = PassportSection(busy = true)) },
        { mutable.value = mutable.value.copy(current = PassportSection(error = "Current participation could not be verified. Try again.")) },
        { mutable.value = mutable.value.copy(current = mutable.value.current.copy(busy = false)) }) { epoch ->
        val raw = api.get("/realm-passport/mining/current"); guard(epoch)
        mutable.value = mutable.value.copy(current = PassportSection(RealmPassportWire.current(raw, session.wallet)))
    }
}
