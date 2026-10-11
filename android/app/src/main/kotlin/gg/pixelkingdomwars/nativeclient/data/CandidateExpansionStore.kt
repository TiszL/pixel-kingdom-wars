package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.SecretStore
import kotlinx.serialization.json.*

data class SavedCandidateExpansion(val request: BasePurchaseRequest, val state: CandidateExpansionState? = null, val confirmedHash: String? = null)

/** Own origin/wallet namespace; no real-purchase journal or payment signature. */
class CandidateExpansionStore(private val secret: SecretStore, private val wallet: String, private val origin: String) {
    @Synchronized fun <T> access(current: () -> Unit, block: () -> T): T { current(); return block() }
    @Synchronized fun read(): SavedCandidateExpansion? {
        require(origin == CandidateExpansionContract.ORIGIN)
        return secret.read()?.let { encoded ->
            val raw = Json.parseToJsonElement(encoded).jsonObject; val c = BasePurchaseContract
            c.keys(raw, "version", "mode", "origin", "wallet", "request", "state", "confirmedHash"); CandidateExpansionContract.tag(raw)
            require(c.text(raw, "origin") == origin && c.text(raw, "wallet") == wallet)
            SavedCandidateExpansion(BasePurchaseRequest.from(c.obj(raw, "request")), if (raw["state"] == JsonNull) null else CandidateExpansionState.from(c.obj(raw, "state")),
                c.optional(raw, "confirmedHash")).also(::validate)
        }
    }
    private fun validate(saved: SavedCandidateExpansion) {
        require(saved.request.kind == "expansion")
        saved.state?.let { val quote = it.quote; require(it.wallet == wallet && it.key == saved.request.key && (quote == null || quote.request == saved.request)) }
        require(saved.confirmedHash == null || saved.state?.quote?.hash == saved.confirmedHash)
    }
    private fun write(saved: SavedCandidateExpansion): SavedCandidateExpansion {
        validate(saved); secret.write(buildJsonObject {
            put("version", 1); put("mode", CandidateExpansionContract.MODE); put("origin", origin); put("wallet", wallet)
            put("request", saved.request.raw); put("state", saved.state?.raw ?: JsonNull)
            put("confirmedHash", saved.confirmedHash?.let(::JsonPrimitive) ?: JsonNull)
        }.toString()); return saved
    }
    @Synchronized fun draft(request: BasePurchaseRequest): SavedCandidateExpansion { check(read() == null); return write(SavedCandidateExpansion(request)) }
    @Synchronized fun adopt(state: CandidateExpansionState): SavedCandidateExpansion {
        val old = requireNotNull(read()); old.state?.let { prior ->
            if (prior.quote != null) require(prior.quote == state.quote) { "The original test quote changed." }
            if (prior.status in setOf("granted", "cancelled")) require(prior == state) { "The original test outcome changed." }
        }
        return write(old.copy(state = state))
    }
    @Synchronized fun confirm(hash: String): SavedCandidateExpansion {
        val old = requireNotNull(read()); require(old.state?.status == "quoted" && old.state.quote?.hash == hash)
        return write(old.copy(confirmedHash = hash))
    }
    /** Dead-end audit 2026-10-06 (shape A). [observed] is the state the repository's same action just read by key
     * and adopted: `unquoted` for exactly the saved key, with no quote, receipt or saved consent. */
    @Synchronized fun finishUnquoted(observed: CandidateExpansionState) {
        val old = requireNotNull(read())
        check(old.state == observed && observed.status == "unquoted" && observed.key == old.request.key && observed.quote == null &&
            observed.receipt == null && old.confirmedHash == null) { "The server has a quote or outcome for this request; it stays saved." }
        secret.clear()
    }
    @Synchronized fun finish(hydrated: Boolean) {
        val old = requireNotNull(read()); require(old.state?.status == "cancelled" || old.state?.status == "granted" && hydrated)
        secret.clear()
    }
}
