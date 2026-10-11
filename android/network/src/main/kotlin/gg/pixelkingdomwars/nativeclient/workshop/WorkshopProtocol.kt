package gg.pixelkingdomwars.nativeclient.workshop

import java.math.BigInteger
import java.net.URI
import java.time.Instant
import java.time.format.DateTimeFormatterBuilder
import java.util.UUID
import kotlinx.serialization.Serializable
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.descriptors.*
import kotlinx.serialization.json.*

internal val workshopJson = Json { encodeDefaults = true }
/** kotlinx accepts quoted numeric primitives; the canonical wire schema does not. */
@OptIn(ExperimentalSerializationApi::class)
internal fun strictPrimitives(raw: JsonElement, schema: SerialDescriptor) {
    if (raw == JsonNull) { require(schema.isNullable); return }
    when (schema.kind) {
        StructureKind.CLASS -> { val objectValue = raw.jsonObject; for (i in 0 until schema.elementsCount) objectValue[schema.getElementName(i)]?.let { strictPrimitives(it, schema.getElementDescriptor(i)) } }
        StructureKind.LIST -> raw.jsonArray.forEach { strictPrimitives(it, schema.getElementDescriptor(0)) }
        PrimitiveKind.STRING -> require(raw.jsonPrimitive.isString)
        PrimitiveKind.BOOLEAN -> require(!raw.jsonPrimitive.isString && raw.jsonPrimitive.booleanOrNull != null)
        PrimitiveKind.INT, PrimitiveKind.LONG -> require(!raw.jsonPrimitive.isString && raw.jsonPrimitive.longOrNull != null)
        else -> Unit // JsonObject receipt fields are checked explicitly against their operation schema.
    }
}
private const val SAFE = 9_007_199_254_740_991L // JavaScript wire precision, not a game number.
internal fun count(n: Long, positive: Boolean = false) { require(n in (if (positive) 1 else 0)..SAFE) }
internal fun uuid(s: String) { require(UUID.fromString(s).toString() == s) }
internal fun stamp(s: String): Instant = Instant.parse(s).also {
    require(DateTimeFormatterBuilder().appendInstant(3).toFormatter().format(it) == s)
}
internal fun wallet(s: String) {
    val alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
    require(s.length in 32..44)
    var n = BigInteger.ZERO
    for (c in s) { val digit = alphabet.indexOf(c); require(digit >= 0); n = n * BigInteger.valueOf(58) + BigInteger.valueOf(digit.toLong()) }
    require((n.bitLength() + 7) / 8 + s.takeWhile { it == '1' }.length == 32)
}
internal fun scope(s: String?) { require(s == null || s in setOf("free_wallet", "deed_base")) }
internal fun amount(s: String): BigInteger { require(s.matches(Regex("[1-9][0-9]{0,18}"))); return s.toBigInteger().also { require(it <= BigInteger.valueOf(Long.MAX_VALUE)) } }
@Serializable data class WorkshopIdentity(val origin: String, val cluster: String, val wallet: String) {
    fun validate() { val u = URI(origin); require(u.scheme in setOf("https", "http") && u.host != null && u.userInfo == null && u.query == null && u.fragment == null && u.path.isEmpty()); require(cluster in setOf("devnet", "mainnet-beta")); wallet(wallet) }
}
@Serializable data class WorkshopFeature(val version: Int, val receipts: Int, val allowance: Int)
@Serializable data class WorkshopFeatures(val workshop: WorkshopFeature)
@Serializable data class WorkshopDaily(val cap: Long, val used: Long, val remaining: Long)
@Serializable data class WorkshopHolding(val held: Long, val pending: Long, val listed: Long, val reserved: Long, val cap: Long, val remaining: Long)
@Serializable data class WorkshopAllowance(val version: Int, val scope: String, val day: String, val resetsAt: String, val capacityUnits: Long, val daily: WorkshopDaily, val holding: WorkshopHolding) {
    fun validate() {
        require(version == 1); scope(scope); require(scope.isNotEmpty()); count(capacityUnits, true)
        val start = stamp(day); require(day.endsWith("T00:00:00.000Z") && stamp(resetsAt) == start.plusSeconds(86_400))
        listOf(daily.cap, daily.used, daily.remaining, holding.held, holding.pending, holding.cap, holding.remaining).forEach { count(it) }
        require(holding.listed == 0L && holding.reserved == 0L)
        require(daily.remaining.toBigInteger() == (daily.cap.toBigInteger() - daily.used.toBigInteger()).max(BigInteger.ZERO))
        require(holding.remaining.toBigInteger() == (holding.cap.toBigInteger() - holding.held.toBigInteger() - holding.pending.toBigInteger()).max(BigInteger.ZERO))
    }
}
@Serializable data class WorkshopBatch(val size: Long, val max: Long)
@Serializable data class WorkshopInventory(val baseId: String, val held: Long, val pending: Long)
@Serializable data class WorkshopLegacyHolding(val held: Long, val listed: Long, val reserved: Long, val inProgress: Long, val cap: Long)
@Serializable data class WorkshopJob(val jobId: String, val ingots: Long, val shards: String, val recipeVersion: Long, val workshopLevel: Long,
    val startedAt: String, val readyAt: String, val ready: Boolean, val collectedAt: String?, val capacityScopeAtStart: String? = null) {
    fun validate(price: Long, now: Instant) {
        uuid(jobId); listOf(ingots, recipeVersion, workshopLevel).forEach { count(it, true) }; scope(capacityScopeAtStart)
        require(amount(shards) == ingots.toBigInteger() * price.toBigInteger()); val start = stamp(startedAt); val end = stamp(readyAt)
        require(start <= now && end >= start && ready == (end <= now)); collectedAt?.let { require(ready && stamp(it) in end..now) }
    }
}
/** Wallet-wide allowance and selected-base inventory intentionally remain different fields. */
@Serializable data class WorkshopView(val features: WorkshopFeatures, val acceptingJobs: Boolean, val level: Long, val recipeVersion: Long,
    val shardsPerIngot: Long, val batch: WorkshopBatch, val secPerIngot: Long?, val inventory: WorkshopInventory,
    val allowance: WorkshopAllowance, val dailyRefineCap: Long, val refinedToday: Long, val holding: WorkshopLegacyHolding,
    val capacity: Long, val jobs: List<WorkshopJob>, val serverNow: String) {
    fun validate() {
        require(features.workshop == WorkshopFeature(1, 1, 1)); count(level); count(recipeVersion, true); count(shardsPerIngot, true)
        count(batch.size); count(batch.max, true); require(batch.size <= batch.max)
        require(if (level == 0L) batch.size == 0L && secPerIngot == null else batch.size > 0 && secPerIngot != null)
        secPerIngot?.let { count(it, true) }; uuid(inventory.baseId); allowance.validate(); val now = stamp(serverNow)
        require(serverNow.take(10) + "T00:00:00.000Z" == allowance.day)
        listOf(inventory.held, inventory.pending, dailyRefineCap, refinedToday, holding.held, holding.inProgress, holding.cap).forEach { count(it) }
        require(capacity == allowance.capacityUnits && dailyRefineCap == allowance.daily.cap && holding.cap == allowance.holding.cap)
        require(holding.listed == 0L && holding.reserved == 0L && inventory.held == holding.held && inventory.pending == holding.inProgress)
        if (allowance.scope == "deed_base") require(refinedToday == allowance.daily.used && inventory.held == allowance.holding.held && inventory.pending == allowance.holding.pending)
        require(jobs.map { it.jobId }.distinct().size == jobs.size); jobs.forEach { it.validate(shardsPerIngot, now) }
    }
    companion object { fun from(raw: JsonObject): WorkshopView { strictPrimitives(raw, serializer().descriptor); return workshopJson.decodeFromJsonElement<WorkshopView>(raw).also { it.validate() } } }
}
/** Original economic terms are retained; no catalogue game-number copy exists in Kotlin. */
@Serializable data class WorkshopCommand(val kind: String, val baseId: String, val key: String, val ingots: Long,
    val jobId: String?, val recipeVersion: Long?, val shardsPerIngot: Long?, val workshopLevel: Long?, val secPerIngot: Long?, val capacityScope: String?) {
    fun validate() {
        uuid(baseId); require(key.length in 8..128); count(ingots, true); scope(capacityScope)
        when (kind) {
            "start" -> { require(jobId == null); listOf(recipeVersion, shardsPerIngot, workshopLevel, secPerIngot).forEach { count(requireNotNull(it), true) }; require(capacityScope != null); amount(charge()) }
            "collect" -> { uuid(requireNotNull(jobId)); require(recipeVersion == null && shardsPerIngot == null && workshopLevel == null && secPerIngot == null && capacityScope == null) }
            else -> error("Unsupported Workshop command")
        }
    }
    fun charge() = (ingots.toBigInteger() * requireNotNull(shardsPerIngot).toBigInteger()).toString()
    fun body() = buildJsonObject { put("idempotencyKey", key); if (kind == "start") { put("baseId", baseId); put("ingots", ingots); put("recipeVersion", requireNotNull(recipeVersion)) } }
    val postPath get() = if (kind == "start") "/workshop/jobs" else "/workshop/jobs/$jobId/collect"
    val receiptPath get() = if (kind == "start") "/workshop/jobs/by-key/${java.net.URLEncoder.encode(key, "UTF-8").replace("+", "%20")}" else "/workshop/jobs/$jobId/collect/by-key/${java.net.URLEncoder.encode(key, "UTF-8").replace("+", "%20")}"
    fun admit(view: WorkshopView) {
        validate(); view.validate(); require(view.inventory.baseId == baseId)
        if (kind == "start") require(view.acceptingJobs && view.level == workshopLevel && view.recipeVersion == recipeVersion && view.shardsPerIngot == shardsPerIngot && view.secPerIngot == secPerIngot && view.allowance.scope == capacityScope && ingots <= view.batch.size && ingots <= view.allowance.daily.remaining && ingots <= view.allowance.holding.remaining)
        else require(view.jobs.any { it.jobId == jobId && it.ingots == ingots && it.ready && it.collectedAt == null })
    }
    companion object {
        fun start(view: WorkshopView, key: String, ingots: Long) = WorkshopCommand("start", view.inventory.baseId, key, ingots, null, view.recipeVersion, view.shardsPerIngot, view.level, view.secPerIngot, view.allowance.scope).also { it.admit(view) }
        fun collect(view: WorkshopView, key: String, jobId: String) = WorkshopCommand("collect", view.inventory.baseId, key, view.jobs.single { it.jobId == jobId }.ingots, jobId, null, null, null, null, null).also { it.admit(view) }
    }
}
@Serializable data class WorkshopProof(val wallet: String, val idempotencyKey: String, val status: String, val receipt: JsonObject?, val serverNow: String) {
    fun validate(identity: WorkshopIdentity, command: WorkshopCommand) {
        identity.validate(); command.validate(); require(wallet == identity.wallet && idempotencyKey == command.key); val now = stamp(serverNow)
        if (status == "unknown") { require(receipt == null); return }; require(status == "accepted"); val r = requireNotNull(receipt)
        fun s(k: String) = r.getValue(k).jsonPrimitive.also { require(it.isString) }.content
        fun n(k: String) = r.getValue(k).jsonPrimitive.also { require(!it.isString) }.long
        val common = setOf("version", "status", "wallet", "baseId", "jobId", "receiptId")
        val extra = if (command.kind == "start") setOf("ingots", "shardsCharged", "recipeVersion", "workshopLevelAtStart", "startedAt", "readyAt", "acceptedAt") else setOf("ingotsCredited", "collectedAt")
        require(r.keys == common + extra || command.kind == "start" && r.keys == common + extra + "capacityScopeAtStart")
        require(n("version") == 1L && s("status") == "accepted" && s("wallet") == wallet && s("baseId") == command.baseId)
        uuid(s("jobId")); uuid(s("receiptId"))
        if (command.kind == "start") {
            require(n("ingots") == command.ingots && s("shardsCharged") == command.charge() && n("recipeVersion") == command.recipeVersion)
            count(n("workshopLevelAtStart"), true)
            // Old receipts may lack this additive historical field; do not invent it.
            r["capacityScopeAtStart"]?.let { if (it != JsonNull) scope(it.jsonPrimitive.also { p -> require(p.isString) }.content) }
            require(stamp(s("startedAt")) <= now && stamp(s("readyAt")) >= stamp(s("startedAt")) && stamp(s("acceptedAt")) <= now)
        } else require(s("jobId") == command.jobId && s("receiptId") == command.jobId && n("ingotsCredited") == command.ingots && stamp(s("collectedAt")) <= now)
    }
    companion object { fun from(raw: JsonObject, identity: WorkshopIdentity, command: WorkshopCommand): WorkshopProof { strictPrimitives(raw, serializer().descriptor); return workshopJson.decodeFromJsonElement<WorkshopProof>(raw).also { it.validate(identity, command) } } }
}
