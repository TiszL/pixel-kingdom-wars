package gg.pixelkingdomwars.nativeclient.model

import kotlinx.serialization.json.*
import java.math.BigDecimal

/** Display-only economy reads. Keep exact server decimal text; unavailable RPC values stay null. */
private fun JsonObject.text(key: String): String = requireNotNull((get(key) as? JsonPrimitive)?.takeUnless { it is JsonNull }?.content)
private fun JsonObject.optionalText(key: String): String? = (get(key) as? JsonPrimitive)?.takeUnless { it is JsonNull }?.content
private fun JsonObject.amount(key: String): String = text(key).also { require(BigDecimal(it).signum() >= 0) }
private fun JsonObject.obj(key: String): JsonObject = requireNotNull(get(key) as? JsonObject)
private fun JsonObject.rows(key: String): List<JsonObject> = requireNotNull(get(key) as? JsonArray).map { it.jsonObject }
private fun JsonObject.bool(key: String): Boolean = requireNotNull((get(key) as? JsonPrimitive)?.booleanOrNull)
private fun JsonObject.count(key: String): Int = text(key).toInt().also { require(it >= 0) }
private fun <T> JsonObject.optional(key: String, parse: () -> T): T? = if (get(key) == null || get(key) is JsonNull) null else parse()
private fun JsonObject.items(): List<String> = optional("itemsDropped") {
    rowsOfText("itemsDropped")
} ?: listOfNotNull(optional("itemDropped") { text("itemDropped") })
private fun JsonObject.rowsOfText(key: String): List<String> = requireNotNull(get(key) as? JsonArray).map {
    requireNotNull(it as? JsonPrimitive).also { value -> require(value.isString) }.content
}
private fun forgeDay(value: String): String = value.also {
    require(it.matches(Regex("\\d{4}-\\d{2}-\\d{2}")))
    java.time.LocalDate.parse(it)
}

/**
 * `GET /wallet/balances`. [tokens] is symbol → exact amount text (0 = not held) or null (that cluster's read failed), in
 * server order: the catalogue's `WALLET_HUB.tokens` rows, then any extra game-cluster rows a host configured (the QA chain
 * lane's test SKR). Any symbol is accepted. A row whose amount is not a non-negative decimal is skipped rather than failing
 * the whole read: one bad extra row must not hide every other balance. `sol`, `tokens` and `asOf` themselves stay strict.
 */
data class WalletFunds(val sol: String?, val tokens: Map<String, String?>, val asOf: Long) {
    companion object { fun from(raw: JsonObject) = WalletFunds(raw.optionalText("sol")?.also { require(BigDecimal(it).signum() >= 0) },
        buildMap<String, String?> { raw.obj("tokens").forEach { (symbol, v) -> if (v is JsonNull) put(symbol, null) else tokenAmount(v)?.let { put(symbol, it) } } },
        raw.text("asOf").toLong().also { require(it >= 0) }) }
}
private fun tokenAmount(v: JsonElement): String? =
    (v as? JsonPrimitive)?.content?.takeIf { runCatching { BigDecimal(it).signum() >= 0 }.getOrDefault(false) }
data class EconomyMetric(val label: String, val amount: String, val currency: String)
data class EconomyTotals(val metrics: List<EconomyMetric>) {
    companion object { fun from(raw: JsonObject): EconomyTotals {
        val pool = raw.obj("pool"); val keep = raw.obj("keepFlows"); val shards = raw.obj("shards"); val flows = shards.obj("flows"); val chain = raw.obj("onchain")
        return EconomyTotals(listOf(
            EconomyMetric("Reward pool", pool.amount("emissionPool"), "KEEP"), EconomyMetric("In-game balances", pool.amount("circulating"), "KEEP"),
            EconomyMetric("Withdrawal escrow", pool.amount("withdrawalEscrow"), "KEEP"), EconomyMetric("Forge payout escrow", pool.amount("forgePayoutEscrow"), "KEEP"),
            EconomyMetric("Emitted today", keep.amount("emittedToday"), "KEEP"), EconomyMetric("Recycled", keep.amount("recycledTotal"), "KEEP"),
            EconomyMetric("Deposited", chain.amount("deposited"), "KEEP"), EconomyMetric("Withdrawn net", chain.amount("withdrawnNet"), "KEEP"),
            EconomyMetric("In-game balances", shards.amount("circulating"), "SHARDS"), EconomyMetric("Forge escrow", shards.amount("forgeEscrow"), "SHARDS"),
            EconomyMetric("Mined today", flows.amount("minedToday"), "SHARDS"), EconomyMetric("Issued", flows.amount("issuedTotal"), "SHARDS")))
    } }
}
data class ForgeOverview(val day: String, val cycleEndsAt: String, val emission: String, val totalShards: String, val myShards: String,
    val balance: String, val level: Int, val dailyCap: String, val claimableKeep: String, val claimableDays: Int, val expiresAt: String?,
    val softCapShards: String? = null, val drops: Map<String, Int> = emptyMap(), val yesterday: ForgeYesterday? = null,
    val serverNow: String? = null, val cycleEndsInSec: Int? = null, val maxDailyShareBps: Int? = null) {
    companion object { fun from(r: JsonObject) = ForgeOverview(r.text("day"), r.text("cycleEndsAt"), r.amount("dailyEmissionKeep"), r.amount("totalShards"),
        r.amount("myShards"), r.amount("myShardBalance"), r.count("goldforgeLevel"), r.amount("myDailyCapShards"), r.obj("claimable").amount("totalKeep"),
        r.obj("claimable").count("count"), r.obj("claimable").optionalText("nextExpiresAt"),
        r.optional("softCapShards") { r.amount("softCapShards").also { require(BigDecimal(it).signum() > 0) } },
        r.optional("drops") { r.obj("drops").obj("independentDropBps").mapValues { (_, value) ->
            requireNotNull((value as? JsonPrimitive)?.intOrNull).also { require(it in 0..10_000) }
        } }.orEmpty(),
        r.optional("yesterday") { ForgeYesterday.from(r.obj("yesterday")) },
        r.optional("serverNow") { r.text("serverNow").also { java.time.Instant.parse(it) } },
        r.optional("cycleEndsInSec") { r.count("cycleEndsInSec") },
        r.optional("maxDailyShareBps") { r.count("maxDailyShareBps").also { require(it <= 10_000) } }) }
}
data class ForgeYesterday(val shards: String, val keepPaid: String, val shardsRefunded: String, val items: List<String>, val status: String) {
    companion object { fun from(r: JsonObject) = ForgeYesterday(r.amount("shards"), r.amount("keepPaid"), r.amount("shardsRefunded"), r.items(), r.text("status")) }
}
data class ForgeAllocation(val day: String, val shards: String, val keep: String, val status: String, val expiresAt: String?, val items: List<String>)
data class ForgeAllocations(val days: List<ForgeAllocation>, val nextBefore: String?, val claimed: String, val claimable: String, val expired: String,
    val shardsBurned: String? = null, val itemsWon: Int? = null) {
    companion object { fun from(r: JsonObject): ForgeAllocations {
        val days = r.rows("days").map { row -> ForgeAllocation(row.text("day").also { require(it.matches(Regex("\\d{4}-\\d{2}-\\d{2}"))) },
            row.amount("shards"), row.amount("keepPaid"), row.text("status"), row.optionalText("expiresAt"),
            row.items()) }
        require(days.map { it.day }.distinct().size == days.size)
        require(days.zipWithNext().all { (a, b) -> a.day > b.day })
        val next = r.optionalText("nextBefore")
        require(next == null || (days.isNotEmpty() && next == days.last().day))
        val totals = r.obj("totals")
        return ForgeAllocations(days, next, totals.amount("keepClaimed"), totals.amount("keepClaimable"), totals.amount("keepExpired"),
            totals.optional("shardsBurned") { totals.amount("shardsBurned") }, totals.optional("itemsWon") { totals.count("itemsWon") })
    } }
}
/** Public settled-cycle data only. The wallet label is already abbreviated by the server. */
data class ForgeGlobalRow(val rank: Int, val walletShort: String, val name: String, val seeker: Boolean, val shards: String, val keepPaid: String) {
    companion object { fun from(r: JsonObject) = ForgeGlobalRow(r.count("rank").also { require(it > 0) },
        r.text("walletShort").also { require(it.isNotBlank() && it.contains('…')) }, r.text("name"), r.bool("seeker"), r.amount("shards"), r.amount("keepPaid")) }
}
data class ForgeGlobal(val day: String?, val settled: Boolean, val totalShards: String, val distributedKeep: String, val contributors: Int,
    val rows: List<ForgeGlobalRow>, val nextCursor: String?, val me: ForgeGlobalRow?, val days: List<String>) {
    companion object { fun from(r: JsonObject): ForgeGlobal {
        val result = ForgeGlobal(r.optional("day") { forgeDay(r.text("day")) }, r.bool("settled"), r.amount("totalShards"),
            r.amount("distributedKeep"), r.count("contributors"), r.rows("rows").map { ForgeGlobalRow.from(it) },
            r.optional("nextCursor") { r.text("nextCursor").also { require(it.length in 1..256 && it.matches(Regex("[A-Za-z0-9_-]+"))) } },
            r.optional("me") { ForgeGlobalRow.from(r.obj("me")) }, r.rowsOfText("days").map(::forgeDay))
        require(result.days.zipWithNext().all { (a, b) -> a > b })
        require(result.rows.zipWithNext().all { (a, b) -> b.rank.toLong() == a.rank.toLong() + 1 && BigDecimal(a.keepPaid) >= BigDecimal(b.keepPaid) })
        require(result.rows.all { it.rank <= result.contributors } && (result.me?.rank ?: 0) <= result.contributors)
        require(result.nextCursor == null || result.rows.isNotEmpty())
        if (result.day == null) require(!result.settled && result.rows.isEmpty() && result.me == null && result.nextCursor == null
            && result.days.isEmpty() && result.contributors == 0 && BigDecimal(result.totalShards).signum() == 0 && BigDecimal(result.distributedKeep).signum() == 0)
        else require(result.settled)
        return result
    } }
}
data class WithdrawalAllowance(val limit: String, val used: String, val remaining: String, val governingLevel: Int, val nextAt: String?) {
    companion object { fun from(r: JsonObject) = WithdrawalAllowance(r.amount("personalDailyLimitKeep"), r.amount("personalDailyUsedKeep"),
        r.amount("personalDailyRemainingKeep"), r.count("governingKeepLevel"), r.optionalText("nextAvailableAt")) }
}
data class WithdrawalRecord(val id: String, val status: String, val gross: String, val fee: String, val net: String, val destination: String,
    val createdAt: String, val unbondsAt: String?, val signature: String?, val refundable: Boolean, val mint: String?, val completedAt: String?) {
    companion object { fun list(r: JsonObject) = r.rows("withdrawals").map { row -> WithdrawalRecord(row.text("id"), row.text("status"), row.amount("amount"),
        row.amount("feeBurned"), row.amount("netAmount"), row.text("destination"), row.text("createdAt"), row.optionalText("unbondsAt"),
        row.optionalText("txSignature"), row.bool("refundable"), row.optionalText("mint"), row.optionalText("completedAt")).also { require(BigDecimal(it.gross).subtract(BigDecimal(it.fee)).compareTo(BigDecimal(it.net)) == 0) } } }
}
data class FaucetGrant(val status: String, val lamports: String, val signature: String?, val error: String?)
data class FaucetOverview(val enabled: Boolean, val eligible: Boolean, val reason: String, val grantSol: String, val grantedSol: String,
    val lifetimeCapSol: String, val nextAt: String?, val last: FaucetGrant?) {
    companion object { fun from(r: JsonObject) = FaucetOverview(r.bool("enabled"), r.bool("eligible"), r.text("reason"), r.amount("grantSol"),
        r.amount("grantedSol"), r.amount("lifetimeCapSol"), r.optionalText("nextEligibleAt"), (r["last"] as? JsonObject)?.let { last ->
            FaucetGrant(last.text("status"), last.amount("lamports"), last.optionalText("txSignature"), last.optionalText("error")) }) }
}
data class ReferralOverview(val code: String, val bonusBps: Int, val perReferralBps: Int) {
    companion object { fun from(r: JsonObject) = ReferralOverview(r.text("code"), r.count("bonusBps"), r.count("bonusBpsPerReferral")) }
}
