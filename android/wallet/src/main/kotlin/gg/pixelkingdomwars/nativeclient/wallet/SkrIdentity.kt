package gg.pixelkingdomwars.nativeclient.wallet

import kotlinx.serialization.json.*

/** Public SKR identity supplied by the reviewed tester profile, never an environment mint alias. */
data class SkrIdentity(val mint: String, val decimals: Int) {
    init {
        require(mint.length in 32..44 && base58Decode(mint).size == 32 && base58(base58Decode(mint)) == mint)
        require(decimals in 0..255) // SPL Mint decimals is u8, not a game parameter.
    }
    companion object {
        fun fromProfile(cluster: String, mint: String?, decimals: Int?): SkrIdentity? =
            if (cluster != "devnet" || mint == null || decimals == null) null
            else runCatching { SkrIdentity(mint, decimals) }.getOrNull()
    }
}

/** MS-G owns only the additive SKR family. Other lane families may be added by their owners.
 * A missing profile/family leaves the client dark. No production SKR or KEEP address fallback. */
data class ChainProfile(val cluster: String, val skr: SkrIdentity?) {
    init { require(cluster in setOf("devnet", "mainnet-beta")); require(cluster == "devnet" || skr == null) }
    companion object {
        fun fromJson(raw: String?): ChainProfile? = raw?.let { runCatching {
            val profile = Json.parseToJsonElement(it).jsonObject
            val cluster = requireNotNull((profile["cluster"] as? JsonPrimitive)?.takeIf { value -> value.isString }?.content)
            val family = profile["skr"]
            val identity = if (family == null || family == JsonNull) null else {
                val row = family.jsonObject
                val mint = requireNotNull((row["mint"] as? JsonPrimitive)?.takeIf { value -> value.isString }?.content)
                val decimals = requireNotNull((row["decimals"] as? JsonPrimitive)?.takeUnless { value -> value.isString }?.intOrNull)
                val validated = SkrIdentity(mint, decimals)
                if (cluster == "devnet") validated else null
            }
            ChainProfile(cluster, identity)
        }.getOrNull() }
    }
}
