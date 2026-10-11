package gg.pixelkingdomwars.nativeclient.model

import java.time.Instant
import java.util.UUID
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

/** K156 wallet purchase identity. Numbers are exact safe wire integers, never floating point. */
@Serializable data class GemsBuyIntent(val id: String, val kind: String, val wallet: String,
    val idempotencyKey: String, val reference: String, val source: String, val destination: String,
    val mint: String, val decimals: Int, val keepIn: Long, val gemsOut: Long, val expiresAt: String) {
    fun validate() {
        require(UUID.fromString(id).toString() == id && kind == "gems_buy")
        require(idempotencyKey.matches(Regex("[a-zA-Z0-9_-]{8,128}")))
        require(keepIn in 1..((1L shl 53) - 1) && gemsOut == keepIn && decimals in 0..19)
        require(baseUnits.bitLength() <= 64)
        require(listOf(wallet, reference, source, destination, mint).all { it.matches(Regex("[1-9A-HJ-NP-Za-km-z]{32,44}")) })
        require(listOf(wallet, reference, source, destination, mint).distinct().size == 5)
        Instant.parse(expiresAt)
    }
    val baseUnits get() = keepIn.toBigInteger() * java.math.BigInteger.TEN.pow(decimals)
}
@Serializable data class GemsBuyFunding(val currency: String, val amount: String, val baseUnits: String)
@Serializable data class GemsBuyResult(val currency: String, val amount: String, val rate: Long)
@Serializable data class GemsBuyReceipt(val version: Int, val receiptId: String, val acceptedAt: String,
    val wallet: String, val depositId: String, val txSignature: String,
    val funding: GemsBuyFunding, val result: GemsBuyResult) {
    fun validate(q: GemsBuyIntent) {
        require(version == 1 && UUID.fromString(receiptId).toString() == receiptId)
        require(wallet == q.wallet && depositId == q.id && txSignature.matches(Regex("[1-9A-HJ-NP-Za-km-z]{64,88}")))
        Instant.parse(acceptedAt)
        require(funding.currency == "KEEP" && result.currency == "GEMS" && result.rate == q.gemsOut / q.keepIn)
        require(listOf(funding.amount, funding.baseUnits, result.amount).all { it.matches(Regex("[1-9][0-9]{0,31}")) })
        require(funding.amount == result.amount && funding.baseUnits.toBigInteger() / java.math.BigInteger.TEN.pow(q.decimals) == funding.amount.toBigInteger())
    }
}
@Serializable data class GemsBuyDeposit(val originalIntent: GemsBuyIntent, val status: String,
    val txSignature: String?, val paymentSignature: String?, val amount: String?, val createdAt: String,
    val finalizedAt: String?, val keepIn: Long, val gemsOut: Long, val dustBaseUnits: String?,
    val keepCredited: String?, val gemsCredited: String?, val receipt: GemsBuyReceipt?) {
    fun validate() {
        val q = originalIntent; q.validate()
        require(status in setOf("pending", "finalized", "credited", "expired", "failed"))
        require(keepIn == q.keepIn && gemsOut == q.gemsOut)
        require(Instant.parse(createdAt) < Instant.parse(q.expiresAt)); finalizedAt?.let(Instant::parse)
        listOfNotNull(txSignature, paymentSignature).forEach { require(it.matches(Regex("[1-9A-HJ-NP-Za-km-z]{64,88}"))) }
        amount?.let { wholeGemsAmount(it) }
        require(dustBaseUnits == amount?.toBigInteger()?.rem(java.math.BigInteger.TEN.pow(q.decimals))?.toString())
        if (status == "credited") {
            val r = requireNotNull(receipt); r.validate(q)
            require(r.txSignature == txSignature && r.funding.baseUnits == amount)
            require(keepCredited == r.funding.amount && gemsCredited == r.result.amount)
        } else require(receipt == null && keepCredited == null && gemsCredited == null)
    }
}
@Serializable data class GemsBuyRecovery(val version: Int, val wallet: String, val idempotencyKey: String,
    val recoveryOnly: Boolean, val serverNow: String, val status: String, val deposit: GemsBuyDeposit?,
    /** K159: old K156 receipts stay readable, but new signing requires positive late-payment recovery. */
    val expiredPaymentRecovery: Int? = null) {
    fun validate(expectedWallet: String, key: String) {
        require(version == 1 && recoveryOnly && wallet == expectedWallet && idempotencyKey == key)
        Instant.parse(serverNow)
        require(status in setOf("unknown", "known") && (status == "known") == (deposit != null))
        deposit?.let { it.validate(); require(it.originalIntent.wallet == wallet && it.originalIntent.idempotencyKey == key) }
    }
    companion object { fun from(raw: JsonObject, wallet: String, key: String) = raw.decode<GemsBuyRecovery>().also { it.validate(wallet, key) } }
}
