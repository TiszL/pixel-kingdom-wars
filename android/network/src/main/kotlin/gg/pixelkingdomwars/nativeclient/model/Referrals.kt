package gg.pixelkingdomwars.nativeclient.model

import java.time.Instant
import java.util.Locale
import java.util.UUID
import kotlinx.serialization.json.*

/** Wire bounds and ECMAScript normalization from shared/referrals.ts, not eligibility or tuning. */
object ReferralCode {
    private const val TRIM = "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
    fun normalize(input: String): String = input.trim { it in TRIM }.uppercase(Locale.ROOT).also {
        require(it.length in 6..16) { "Enter a referral code between 6 and 16 characters." }
    }
}
private fun JsonObject.refText(key: String) = requireNotNull((get(key) as? JsonPrimitive)?.takeIf { it.isString }?.content)
private fun referralWallet(value: String) = value.also { require(it.matches(Regex("[1-9A-HJ-NP-Za-km-z]{32,44}"))) }

data class ReferralRelationship(val id: String, val referee: String, val referrer: String, val createdAt: String, val raw: JsonObject) {
    companion object { fun from(raw: JsonObject): ReferralRelationship {
        require(raw.keys == setOf("id", "refereeWallet", "referrerWallet", "createdAt"))
        val id = raw.refText("id"); require(UUID.fromString(id).toString() == id.lowercase(Locale.ROOT))
        val referee = referralWallet(raw.refText("refereeWallet")); val referrer = referralWallet(raw.refText("referrerWallet"))
        require(referee != referrer)
        val time = raw.refText("createdAt"); require(time.endsWith('Z')); Instant.parse(time)
        return ReferralRelationship(id, referee, referrer, time, raw)
    } }
}
data class ReferralStatus(val wallet: String, val relationship: ReferralRelationship?) {
    companion object { fun from(raw: JsonObject): ReferralStatus {
        require(raw.keys == setOf("version", "wallet", "relationship") && raw["version"] == JsonPrimitive(1))
        val wallet = referralWallet(raw.refText("wallet"))
        val relationship = if (raw["relationship"] == JsonNull) null else ReferralRelationship.from(requireNotNull(raw["relationship"] as? JsonObject))
        require(relationship == null || relationship.referee == wallet)
        return ReferralStatus(wallet, relationship)
    } }
}
data class ReferralUseResult(val wallet: String, val code: String, val outcome: String, val relationship: ReferralRelationship) {
    companion object { fun from(raw: JsonObject): ReferralUseResult {
        require(raw.keys == setOf("version", "wallet", "submittedCode", "outcome", "relationship") && raw["version"] == JsonPrimitive(1))
        val wallet = referralWallet(raw.refText("wallet")); val code = raw.refText("submittedCode")
        require(ReferralCode.normalize(code) == code)
        val outcome = raw.refText("outcome"); require(outcome in setOf("applied", "already_applied", "already_bound"))
        val relationship = ReferralRelationship.from(requireNotNull(raw["relationship"] as? JsonObject))
        require(relationship.referee == wallet)
        return ReferralUseResult(wallet, code, outcome, relationship)
    } }
}
