package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.SecretStore
import kotlinx.serialization.json.*

data class SavedBaseClaim(val request: BaseClaimRequest, val receipt: BaseClaimReceipt? = null, val cancelled: Boolean = false)

/** Scoped independently of paid land; null receipt is uncertainty, never cancellation evidence. */
class BaseClaimJournal(private val secret: SecretStore, private val wallet: String, private val origin: String, private val cluster: String) {
    @Synchronized fun read(): SavedBaseClaim? = secret.read()?.let {
        val raw = Json.parseToJsonElement(it).jsonObject
        BaseClaimContract.keys(raw, "version", "wallet", "origin", "cluster", "request", "receipt", "cancelled")
        require(raw["version"] == JsonPrimitive(1) && raw["wallet"] == JsonPrimitive(wallet) && raw["origin"] == JsonPrimitive(origin) && raw["cluster"] == JsonPrimitive(cluster))
        SavedBaseClaim(BaseClaimRequest.from(requireNotNull(raw["request"] as? JsonObject)),
            if (raw["receipt"] == JsonNull) null else BaseClaimReceipt.from(requireNotNull(raw["receipt"] as? JsonObject)), BaseClaimContract.flag(raw, "cancelled")).also(::validate)
    }
    private fun validate(saved: SavedBaseClaim) {
        require(BaseClaimRequest.from(saved.request.json()) == saved.request)
        require(!saved.cancelled || saved.receipt == null)
        saved.receipt?.let { require(it.actor == wallet && it.request == saved.request && BaseClaimReceipt.from(it.raw) == it) }
    }
    private fun write(saved: SavedBaseClaim) {
        validate(saved)
        secret.write(buildJsonObject {
            put("version", 1); put("wallet", wallet); put("origin", origin); put("cluster", cluster)
            put("request", saved.request.json()); put("receipt", saved.receipt?.raw ?: JsonNull); put("cancelled", saved.cancelled)
        }.toString())
    }
    @Synchronized fun begin(request: BaseClaimRequest) { check(read() == null); write(SavedBaseClaim(request)) }
    @Synchronized fun accept(receipt: BaseClaimReceipt) {
        val old = requireNotNull(read()); require(!old.cancelled && old.request == receipt.request && (old.receipt == null || old.receipt == receipt))
        write(old.copy(receipt = receipt))
    }
    @Synchronized fun cancel(request: BaseClaimRequest) {
        val old = requireNotNull(read()); require(old.request == request && old.receipt == null); write(old.copy(cancelled = true))
    }
    @Synchronized fun finish(expected: SavedBaseClaim) {
        require(read() == expected && (expected.receipt != null || expected.cancelled)); secret.clear()
    }
}
