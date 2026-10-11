package gg.pixelkingdomwars.nativeclient.model

import java.security.MessageDigest
import kotlinx.serialization.json.*

/** Separate zero-charge protocol. Never accepted as a SOL purchase receipt. */
object CandidateExpansionContract {
    const val ORIGIN = "https://qa.pixelkingdomwars.com"
    const val MODE = "candidate-expansion"
    fun lane(flag: Boolean, origin: String, applicationId: String, offline: Boolean) =
        flag && origin == ORIGIN && applicationId == "gg.pixelkingdomwars.twa.debug" && !offline
    fun tag(raw: JsonObject) { require(raw["version"] == JsonPrimitive(1) && BasePurchaseContract.text(raw, "mode") == MODE) }
    fun digest(value: JsonElement): String {
        fun sorted(element: JsonElement): JsonElement = when (element) {
            is JsonObject -> JsonObject(element.toSortedMap().mapValues { sorted(it.value) })
            is JsonArray -> JsonArray(element.map(::sorted))
            else -> element
        }
        return MessageDigest.getInstance("SHA-256").digest(sorted(value).toString().toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
    }
    fun sha(value: String) = value.also { require(it.matches(Regex("[a-f0-9]{64}"))) }
    fun capability(raw: JsonObject, wallet: String, baseId: String) = with(BasePurchaseContract) {
        keys(raw, "version", "mode", "enabled", "origin", "sourceSha", "wallet", "baseId"); tag(raw)
        require(flag(raw, "enabled") && text(raw, "origin") == ORIGIN && text(raw, "wallet") == wallet && text(raw, "baseId") == baseId)
        text(raw, "sourceSha").also { require(it.matches(Regex("[a-f0-9]{40}"))) }
    }
}

data class CandidateExpansionQuote(val raw: JsonObject, val wallet: String, val request: BasePurchaseRequest,
    val sourceSha: String, val hash: String, val landPaidAt: String, val fromTiles: Int, val toTiles: Int,
    val keepLevel: Int, val referencePrice: String) {
    companion object { fun from(raw: JsonObject): CandidateExpansionQuote = with(BasePurchaseContract) {
        keys(raw, "version", "mode", "origin", "sourceSha", "wallet", "fixtureId", "request", "baseEpoch", "offer", "createdAt", "quoteHash")
        CandidateExpansionContract.tag(raw); require(text(raw, "origin") == CandidateExpansionContract.ORIGIN)
        val source = text(raw, "sourceSha").also { require(it.matches(Regex("[a-f0-9]{40}"))) }
        id(text(raw, "fixtureId")); date(text(raw, "createdAt"))
        val request = BasePurchaseRequest.from(obj(raw, "request")); require(request.kind == "expansion")
        val epoch = obj(raw, "baseEpoch"); keys(epoch, "landPaidAt", "deedAssetId"); require(epoch["deedAssetId"] == JsonNull)
        val offer = obj(raw, "offer"); keys(offer, "expectedExpansions", "fromClaimTiles", "toClaimTiles", "requiredKeepLevel", "referencePriceLamports", "chargedLamports")
        require(integer(offer, "expectedExpansions") == request.expectedExpansions && text(offer, "chargedLamports") == "0")
        val from = integer(offer, "fromClaimTiles"); val to = integer(offer, "toClaimTiles"); val keep = integer(offer, "requiredKeepLevel")
        require(from > 0 && to > from && from % 2 == 0 && to % 2 == 0 && keep > 0)
        val price = lamports(text(offer, "referencePriceLamports")); require(price.toBigInteger().signum() > 0)
        val hash = CandidateExpansionContract.sha(text(raw, "quoteHash"))
        require(hash == CandidateExpansionContract.digest(JsonObject(raw - "quoteHash"))) { "The original test expansion quote changed." }
        CandidateExpansionQuote(raw, address(text(raw, "wallet")), request, source, hash, date(text(epoch, "landPaidAt")), from, to, keep, price)
    } }
}

data class CandidateExpansionState(val raw: JsonObject, val wallet: String, val key: String, val status: String,
    val quote: CandidateExpansionQuote?, val receipt: JsonObject?) {
    companion object { fun from(raw: JsonObject): CandidateExpansionState = with(BasePurchaseContract) {
        keys(raw, "version", "mode", "wallet", "idempotencyKey", "status", "quote", "receipt"); CandidateExpansionContract.tag(raw)
        val wallet = address(text(raw, "wallet")); val key = id(text(raw, "idempotencyKey")); val status = text(raw, "status")
        require(status in setOf("unquoted", "quoted", "granted", "cancelled"))
        val quote = if (raw["quote"] == JsonNull) null else CandidateExpansionQuote.from(obj(raw, "quote"))
        val receipt = if (raw["receipt"] == JsonNull) null else obj(raw, "receipt")
        require(quote == null || quote.wallet == wallet && quote.request.key == key)
        require(when (status) { "unquoted" -> quote == null && receipt == null; "quoted" -> quote != null && receipt == null
            "granted" -> quote != null && receipt != null; else -> receipt == null })
        if (receipt != null) {
            keys(receipt, "version", "mode", "id", "wallet", "idempotencyKey", "baseId", "quoteHash", "fromExpansions", "toExpansions", "fromClaimTiles", "toClaimTiles", "chargedLamports", "acceptedAt")
            CandidateExpansionContract.tag(receipt); id(text(receipt, "id")); date(text(receipt, "acceptedAt")); val q = requireNotNull(quote)
            require(text(receipt, "wallet") == wallet && text(receipt, "idempotencyKey") == key && text(receipt, "baseId") == q.request.baseId
                && text(receipt, "quoteHash") == q.hash && text(receipt, "chargedLamports") == "0"
                && integer(receipt, "fromExpansions") == q.request.expectedExpansions
                && integer(receipt, "toExpansions").toLong() == requireNotNull(q.request.expectedExpansions).toLong() + 1
                && integer(receipt, "fromClaimTiles") == q.fromTiles && integer(receipt, "toClaimTiles") == q.toTiles)
        }
        CandidateExpansionState(raw, wallet, key, status, quote, receipt)
    } }
}
