package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.SecretStore
import kotlinx.serialization.json.*

data class SavedReferral(val code: String?, val relationship: ReferralRelationship? = null, val outcome: String? = null)

/** One immutable account relationship. An absent observation can never clear an interrupted code. */
class ReferralJournal(private val secret: SecretStore, private val wallet: String, private val origin: String, private val cluster: String) {
    @Synchronized fun read(): SavedReferral? = secret.read()?.let {
        val raw = Json.parseToJsonElement(it).jsonObject
        require(raw.keys == setOf("version", "wallet", "origin", "cluster", "code", "relationship", "outcome"))
        require(raw["version"] == JsonPrimitive(1) && raw["wallet"] == JsonPrimitive(wallet) &&
            raw["origin"] == JsonPrimitive(origin) && raw["cluster"] == JsonPrimitive(cluster))
        fun optional(key: String): String? = if (raw[key] == JsonNull) null else requireNotNull((raw[key] as? JsonPrimitive)?.takeIf { v -> v.isString }?.content)
        SavedReferral(optional("code"), if (raw["relationship"] == JsonNull) null else ReferralRelationship.from(requireNotNull(raw["relationship"] as? JsonObject)), optional("outcome")).also(::validate)
    }
    private fun validate(saved: SavedReferral) {
        saved.code?.let { require(ReferralCode.normalize(it) == it) }
        require(saved.code != null || saved.relationship != null)
        if (saved.relationship == null) require(saved.outcome == null)
        else {
            require(ReferralRelationship.from(saved.relationship.raw) == saved.relationship && saved.relationship.referee == wallet)
            require(saved.outcome in setOf("observed", "applied", "already_applied", "already_bound"))
            require(saved.code != null || saved.outcome == "observed")
        }
    }
    private fun write(saved: SavedReferral): SavedReferral {
        validate(saved)
        secret.write(buildJsonObject {
            put("version", 1); put("wallet", wallet); put("origin", origin); put("cluster", cluster)
            put("code", saved.code?.let(::JsonPrimitive) ?: JsonNull)
            put("relationship", saved.relationship?.raw ?: JsonNull); put("outcome", saved.outcome?.let(::JsonPrimitive) ?: JsonNull)
        }.toString())
        return saved
    }
    @Synchronized fun begin(code: String): SavedReferral {
        check(read() == null) { "Recover the saved referral before another code." }
        return write(SavedReferral(code))
    }
    @Synchronized fun observe(relationship: ReferralRelationship): SavedReferral {
        val old = read()
        require(old?.relationship == null || old.relationship == relationship) { "The saved referral relationship changed. Its original proof is retained." }
        return write(SavedReferral(old?.code, relationship, old?.outcome ?: "observed"))
    }
    @Synchronized fun accept(code: String, result: ReferralUseResult): SavedReferral {
        val old = requireNotNull(read()); require(old.code == code && result.code == code && result.wallet == wallet)
        require(old.relationship == null || old.relationship == result.relationship)
        return write(SavedReferral(code, result.relationship, result.outcome))
    }
    /** Only the repository's fresh first POST can supply a proved atomic refusal. */
    @Synchronized fun firstRefused(code: String) {
        val old = requireNotNull(read()); require(old.code == code && old.relationship == null)
        secret.clear()
    }
    /** Dead-end audit 2026-10-06: forgets exactly the unresolved [code] after the repository's fresh status read in the same
     *  action showed no relationship for this wallet (one relationship per wallet, so that read is the by-key equivalent). */
    @Synchronized fun closeUnknown(code: String) {
        check(read() == SavedReferral(code)) { "The saved referral changed. Check its status again." }
        secret.clear()
    }
    @Synchronized fun finish() {
        val old = requireNotNull(read()); val relationship = requireNotNull(old.relationship) { "Check the saved referral before finishing." }
        // Keep positive immutable attribution, even if a later stale server returns null.
        write(SavedReferral(null, relationship, "observed"))
    }
}
