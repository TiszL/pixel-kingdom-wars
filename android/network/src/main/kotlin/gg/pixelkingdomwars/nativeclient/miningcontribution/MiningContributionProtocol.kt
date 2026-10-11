package gg.pixelkingdomwars.nativeclient.miningcontribution

import gg.pixelkingdomwars.nativeclient.workshop.WorkshopIdentity
import gg.pixelkingdomwars.nativeclient.workshop.strictPrimitives
import gg.pixelkingdomwars.nativeclient.workshop.wallet
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.quantity
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.timestamp
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.uuid
import java.math.BigInteger
import java.time.LocalDate
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

internal val contributionJson = Json { encodeDefaults = true }
/** Wire identities only. Values, stock, caps and consistency always come from the server. */
val miningContributionResourceIds = setOf("shards", "frost_quartz", "heartwood_logs", "sunstone_rubble", "crown_iron_ore",
    "rough_prism", "storm_ore", "thorn_fibre", "ember_nodules", "frostglass", "heartwood_beams", "sunstone_blocks",
    "crownsteel", "prismstone_lens", "stormalloy", "thornsilk", "embercore", "navigation_kit", "forge_ingot", "crystal_fragment")
val miningContributionResourceIdsV3 = miningContributionResourceIds + setOf("climate_kit", "expedition_kit")
fun miningContributionResourceIds(policyVersion: Int): Set<String> = when (policyVersion) {
    2 -> miningContributionResourceIds
    3 -> miningContributionResourceIdsV3
    else -> error("Unsupported mining contribution policy")
}
private fun day(value: String) { require(value.matches(Regex("[0-9]{4}-[0-9]{2}-[0-9]{2}")) && LocalDate.parse(value).toString() == value) }
internal fun miningValue(value: String): BigInteger { require(value.matches(Regex("0|[1-9][0-9]{0,31}"))); return value.toBigInteger() }
@Serializable data class MiningContributionIdentity(val origin: String, val cluster: String, val wallet: String) {
    fun validate() = WorkshopIdentity(origin, cluster, wallet).validate()
}
@Serializable data class MiningContributionLine(val resourceId: String, val quantity: String) {
    fun validate() { require(resourceId in miningContributionResourceIdsV3); quantity(quantity, true) }
}
@Serializable data class MiningContributionValuedLine(val resourceId: String, val quantity: String, val unitValue: String, val value: String) {
    fun validate() { MiningContributionLine(resourceId, quantity).validate(); require(miningValue(unitValue).signum() > 0); require(quantity(quantity, true) * miningValue(unitValue) == miningValue(value)) }
}
@Serializable data class MiningContributionStock(val resourceId: String, val available: String, val unitValue: String) {
    fun validate() { require(resourceId in miningContributionResourceIdsV3); quantity(available); require(miningValue(unitValue).signum() > 0) }
}
@Serializable data class MiningConsistencyPolicy(val windowDays: Int, val bonusPerQualifiedDayBps: Int, val maximumBonusBps: Int) {
    fun validate() { require(windowDays > 0 && bonusPerQualifiedDayBps > 0 && maximumBonusBps.toLong() == windowDays.toLong() * bonusPerQualifiedDayBps) }
}
@Serializable data class MiningContributionView(val wallet: String, val baseId: String, val policyVersion: Int, val day: String,
    val serverNow: String, val acceptingContributions: Boolean, val pool: String, val dailyCapValue: String?, val committedValue: String,
    val remainingValue: String?, val developmentReady: Boolean, val resources: List<MiningContributionStock>, val consistency: MiningConsistencyPolicy) {
    fun validate() {
        wallet(wallet); uuid(baseId); val ids = miningContributionResourceIds(policyVersion); day(day); timestamp(serverNow); require(serverNow.take(10) == day)
        require(resources.size == ids.size && resources.map { it.resourceId }.toSet() == ids)
        resources.forEach { it.validate() }; consistency.validate(); val committed = miningValue(committedValue)
        when (pool) {
            "deed" -> require(dailyCapValue == null && remainingValue == null)
            "free" -> { val cap = miningValue(requireNotNull(dailyCapValue)); require(cap.signum() > 0)
                require(miningValue(requireNotNull(remainingValue)) == (cap - committed).max(BigInteger.ZERO)) }
            else -> error("Unknown mining pool")
        }
    }
    fun value(lines: List<MiningContributionLine>): List<MiningContributionValuedLine> = lines.map { line ->
        line.validate(); val unit = resources.single { it.resourceId == line.resourceId }.unitValue
        MiningContributionValuedLine(line.resourceId, line.quantity, unit, (quantity(line.quantity, true) * miningValue(unit)).toString())
    }.sortedBy { it.resourceId }
    companion object { fun from(raw: JsonObject): MiningContributionView {
        strictPrimitives(raw, serializer().descriptor); return contributionJson.decodeFromJsonElement<MiningContributionView>(raw).also { it.validate() }
    } }
}
@Serializable data class MiningContributionRequest(val idempotencyKey: String, val baseId: String, val policyVersion: Int,
    val expectedDay: String, val lines: List<MiningContributionLine>) {
    fun validate() { uuid(idempotencyKey); uuid(baseId); val ids = miningContributionResourceIds(policyVersion); day(expectedDay)
        require(lines.isNotEmpty() && lines.size <= ids.size && lines.map { it.resourceId }.distinct().size == lines.size); lines.forEach { it.validate(); require(it.resourceId in ids) } }
    fun body(): JsonObject = contributionJson.encodeToJsonElement(serializer(), this).jsonObject
    companion object { fun from(raw: JsonObject): MiningContributionRequest {
        strictPrimitives(raw, serializer().descriptor); return contributionJson.decodeFromJsonElement<MiningContributionRequest>(raw).also { it.validate() }
    } }
}
/** Server-reviewed valuation is frozen beside the original request. It never prices or debits stock locally. */
@Serializable data class MiningContributionCommand(val request: MiningContributionRequest, val lines: List<MiningContributionValuedLine>, val totalValue: String) {
    val key get() = request.idempotencyKey
    val receiptPath get() = "/mining/contributions/by-key/$key"
    fun validate() { request.validate(); lines.forEach { it.validate() }
        require(lines.map { MiningContributionLine(it.resourceId, it.quantity) } == request.lines.sortedBy { it.resourceId })
        require(lines.fold(BigInteger.ZERO) { sum, line -> sum + miningValue(line.value) } == miningValue(totalValue)) }
    fun admit(identity: MiningContributionIdentity, current: MiningContributionView) {
        validate(); identity.validate(); current.validate()
        check(current.wallet == identity.wallet && current.baseId == request.baseId && current.acceptingContributions)
        check(current.developmentReady) { "Complete the minimum mining buildings before contributing resources." }
        check(current.day == request.expectedDay && current.policyVersion == request.policyVersion) { "Mining day or policy changed. Keep the original request for recovery." }
        check(current.value(request.lines) == lines) { "Reviewed resource values changed." }
        request.lines.forEach { input -> check(quantity(current.resources.single { it.resourceId == input.resourceId }.available) >= quantity(input.quantity, true)) { "Not enough available mining resources." } }
        current.remainingValue?.let { check(miningValue(totalValue) <= miningValue(it)) { "Basket exceeds the remaining daily mining allowance." } }
    }
    companion object { fun review(identity: MiningContributionIdentity, view: MiningContributionView, key: String, lines: List<MiningContributionLine>): MiningContributionCommand {
        view.validate(); val valued = view.value(lines)
        return MiningContributionCommand(MiningContributionRequest(key, view.baseId, view.policyVersion, view.day, lines), valued,
            valued.fold(BigInteger.ZERO) { sum, line -> sum + miningValue(line.value) }.toString()).also { it.admit(identity, view) }
    } }
}
@Serializable data class MiningContributionReceipt(val id: String, val epochId: String, val wallet: String, val day: String,
    val request: MiningContributionRequest, val lines: List<MiningContributionValuedLine>, val totalValue: String, val createdAt: String) {
    fun validate(identity: MiningContributionIdentity, command: MiningContributionCommand) {
        identity.validate(); command.validate(); uuid(id); uuid(epochId); wallet(wallet); day(day); timestamp(createdAt)
        require(wallet == identity.wallet && request == command.request && id == request.idempotencyKey && day == request.expectedDay && createdAt.take(10) == day)
        require(lines == command.lines && totalValue == command.totalValue)
    }
}
@Serializable data class MiningContributionSettlement(val outcome: String, val settledAt: String)
@Serializable data class MiningContributionProof(val wallet: String, val idempotencyKey: String, val serverNow: String,
    val status: String, val receipt: MiningContributionReceipt?, val settlement: MiningContributionSettlement?) {
    fun validate(identity: MiningContributionIdentity, command: MiningContributionCommand) {
        identity.validate(); command.validate(); require(wallet == identity.wallet && idempotencyKey == command.key); val now = timestamp(serverNow)
        if (status == "unknown") { require(receipt == null && settlement == null); return }
        require(status == "accepted"); val original = requireNotNull(receipt); original.validate(identity, command)
        require(timestamp(original.createdAt) <= now)
        settlement?.let { require(it.outcome in setOf("consumed", "returned") && timestamp(it.settledAt) in timestamp(original.createdAt)..now) }
    }
    companion object { fun from(raw: JsonObject, identity: MiningContributionIdentity, command: MiningContributionCommand): MiningContributionProof {
        strictPrimitives(raw, serializer().descriptor); return contributionJson.decodeFromJsonElement<MiningContributionProof>(raw).also { it.validate(identity, command) }
    } }
}
