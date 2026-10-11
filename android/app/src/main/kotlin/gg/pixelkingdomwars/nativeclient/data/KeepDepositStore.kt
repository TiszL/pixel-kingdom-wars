package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.network.SecretStore
import gg.pixelkingdomwars.nativeclient.network.string
import gg.pixelkingdomwars.nativeclient.wallet.KeepDepositPayment
import gg.pixelkingdomwars.nativeclient.wallet.SignatureLanding
import java.math.BigInteger
import java.util.UUID
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

data class KeepDepositBounds(val maximum: BigInteger, val decimals: Int, val pollMs: Long, val timeoutMs: Long, val quoteWindowMs: Long) {
    init { require(maximum.signum() > 0 && decimals in 0..19 && pollMs > 0 && timeoutMs > 0 && quoteWindowMs > timeoutMs) }
    companion object {
        fun from(catalogue: JsonObject?): KeepDepositBounds? = runCatching {
            val c = requireNotNull(catalogue?.get("constants") as? JsonObject)
            val token = requireNotNull(c["TOKEN"] as? JsonObject)
            val recovery = requireNotNull(c["LAND_CHECKOUT_RECOVERY"] as? JsonObject)
            val economy = requireNotNull(c["ECONOMY"] as? JsonObject)
            val ttl = requireNotNull(economy.string("depositPendingTtlMin")).toLong()
            val margin = requireNotNull(economy.string("depositReuseMinRemainingMin")).toLong()
            require(ttl > margin && margin > 0)
            KeepDepositBounds(BigInteger(requireNotNull(token.string("totalSupply"))), requireNotNull(token.string("decimals")).toInt(),
                requireNotNull(recovery.string("pollMs")).toLong(), requireNotNull(recovery.string("requestTimeoutMs")).toLong(), Math.multiplyExact(ttl - margin, 60_000))
        }.getOrNull()
    }
    fun amount(input: String): String {
        val value = input.replace(Regex("[\\s,]"), "")
        require(value.length in 1..maximum.toString().length && value.matches(Regex("[0-9]+"))) { "Enter a whole KEEP amount." }
        val amount = BigInteger(value)
        require(amount.signum() > 0 && amount <= maximum && amount.multiply(BigInteger.TEN.pow(decimals)).bitLength() <= 64) { "Enter a valid whole KEEP amount." }
        return amount.toString()
    }
}

/** Full public POST quote. GET detail omits ATAs/mint/decimals, so it must NEVER rebuild this object. */
@Serializable data class KeepDepositQuote(val id: String, val wallet: String, val origin: String, val cluster: String,
    val amount: String, val source: String, val destination: String, val mint: String, val decimals: Int, val reference: String) {
    val baseUnits: BigInteger get() = BigInteger(amount).multiply(BigInteger.TEN.pow(decimals))
    fun validate() {
        require(UUID.fromString(id).toString() == id && origin.startsWith("https://") && cluster in setOf("devnet", "mainnet-beta"))
        require(amount.matches(Regex("[1-9][0-9]*")) && amount.length <= 20 && decimals in 0..19 && baseUnits.bitLength() <= 64)
        val keys = listOf(wallet, source, destination, mint, reference)
        require(keys.all(KeepDepositPayment::validAddress) && keys.distinct().size == keys.size)
    }
    companion object {
        fun from(raw: JsonObject, wallet: String, origin: String, cluster: String, amount: String, mint: String, decimals: Int): KeepDepositQuote {
            require(raw.string("kind") == "keep_deposit" && raw.string("mint") == mint && raw.string("decimals") == decimals.toString()) { "The KEEP deposit network changed." }
            fun text(key: String) = requireNotNull(raw.string(key)) { "Incomplete KEEP deposit quote" }
            return KeepDepositQuote(text("id"), wallet, origin, cluster, amount, text("source"), text("destination"), text("mint"), decimals, text("reference")).also { it.validate() }
        }
    }
}

@Serializable data class KeepDepositReceipt(val status: String, val signature: String? = null, val amountBaseUnits: String? = null)
/** [attemptedAtMs] is the wall-clock start of the wallet attempt; null on a deposit saved before the field existed
 * and on one that became attempted only because the server reported a signature. [walletEndedAtMs] is when the
 * wallet step ended (it answered, failed uncertainly, or a signature was first recorded) and [lastValidBlockHeight]
 * is the last block height the prepared payment's blockhash is valid at; both are null on older journals. */
@Serializable data class SavedKeepDeposit(val quote: KeepDepositQuote, val attempted: Boolean = false,
    val signature: String? = null, val receipt: KeepDepositReceipt? = null, val attemptedAtMs: Long? = null,
    val walletEndedAtMs: Long? = null, val lastValidBlockHeight: Long? = null) {
    /** The wallet step ended at [nowMs]; the stamp never moves back. */
    fun walletEnded(nowMs: Long): SavedKeepDeposit = copy(walletEndedAtMs = maxOf(walletEndedAtMs ?: nowMs, nowMs))
    /** Leg 1 of [UnpaidAttempt]: the server ended THIS attempted deposit unpaid. Only `expired` is unpaid: the server
     * marks `failed` when it RECEIVED a transfer it could not credit, and that is never retired. */
    val unpaidEnd: Boolean get() = attempted && receipt?.status == "expired" && receipt.signature == null
    /** Legs 1 and 2. This quote carries no deadline of its own, so a deposit saved without [attemptedAtMs] is old only
     * by [legacyDeadlineMs]: the server's creation time of this deposit plus the catalogue's payment window. */
    fun unpaidAttemptEnded(nowMs: Long, legacyDeadlineMs: Long?): Boolean = unpaidEnd && UnpaidAttempt.oldEnough(attemptedAtMs, walletEndedAtMs, legacyDeadlineMs, nowMs)
}

/** Encrypted, origin/wallet/cluster-bound. Unreadable storage blocks a new transfer instead of forgetting it. */
class KeepDepositStore(private val secret: SecretStore, private val wallet: String, private val origin: String, private val cluster: String) {
    @Synchronized fun read(): SavedKeepDeposit? = secret.read()?.let { raw ->
        Json.decodeFromString<SavedKeepDeposit>(raw).also { saved ->
            saved.quote.validate()
            check(saved.quote.wallet == wallet && saved.quote.origin == origin && saved.quote.cluster == cluster) { "Saved deposit belongs to another account or network." }
            check(saved.signature == null || (saved.attempted && KeepDepositPayment.validSignature(saved.signature)))
            check(saved.attemptedAtMs == null || (saved.attempted && saved.attemptedAtMs >= 0))
            check(saved.walletEndedAtMs == null || (saved.attempted && saved.walletEndedAtMs >= 0))
            check(saved.lastValidBlockHeight == null || (saved.attempted && saved.lastValidBlockHeight > 0))
            saved.receipt?.let { receipt ->
                check(receipt.status in setOf("credited", "expired", "failed"))
                if (receipt.status == "credited") check(saved.attempted && receipt.signature == saved.signature &&
                    receipt.signature != null && receipt.amountBaseUnits == saved.quote.baseUnits.toString())
            }
        }
    }
    @Synchronized fun save(saved: SavedKeepDeposit) {
        saved.quote.validate()
        check(saved.quote.wallet == wallet && saved.quote.origin == origin && saved.quote.cluster == cluster)
        // Reading first is deliberate: a corrupt journal can never be silently replaced by a new deposit.
        read(); secret.write(Json.encodeToString(SavedKeepDeposit.serializer(), saved))
    }
    @Synchronized fun update(id: String, transform: (SavedKeepDeposit) -> SavedKeepDeposit): SavedKeepDeposit {
        val current = requireNotNull(read()); check(current.quote.id == id) { "Saved deposit changed." }
        return transform(current).also { check(it.quote == current.quote); save(it) }
    }
    @Synchronized fun clearUnpaidOrCredited(id: String) {
        val current = requireNotNull(read()); check(current.quote.id == id)
        check(!current.attempted || current.receipt?.status == "credited") { "Check the saved payment before starting another deposit." }
        secret.clear()
    }
    /** The only exit for an attempted deposit that was never credited: every leg of [UnpaidAttempt], checked here
     * again, for the exact id + reference the server just answered for. [landing] is the cluster's verdict on the
     * recorded signature and must be null when none was recorded. */
    @Synchronized fun retireUnpaidAttempt(id: String, reference: String, nowMs: Long, legacyDeadlineMs: Long?, landing: SignatureLanding?) {
        val current = requireNotNull(read()); check(current.quote.id == id && current.quote.reference == reference)
        check(current.unpaidAttemptEnded(nowMs, legacyDeadlineMs) && UnpaidAttempt.cleared(current.signature, landing, current.lastValidBlockHeight)) { "Check the saved payment before starting another deposit." }
        secret.clear()
    }
}
