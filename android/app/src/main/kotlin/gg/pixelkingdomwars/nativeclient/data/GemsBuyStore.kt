package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.SecretStore
import gg.pixelkingdomwars.nativeclient.wallet.KeepDepositPayment
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

@Serializable data class GemsBuyDraft(val wallet: String, val origin: String, val cluster: String,
    val idempotencyKey: String, val keepIn: Long)
@Serializable data class SavedGemsBuy(val draft: GemsBuyDraft, val quote: GemsBuyIntent? = null,
    val attempted: Boolean = false, val attemptedAtMs: Long? = null, val walletEndedAtMs: Long? = null,
    val preparedLastValidHeight: Long? = null, val signature: String? = null,
    /** True only for the exact signed-only message. MWA Sent can refresh the blockhash. */
    val signatureUsesPreparedHeight: Boolean = false, val observed: GemsBuyDeposit? = null) {
    fun ended(now: Long) = copy(walletEndedAtMs = maxOf(walletEndedAtMs ?: now, now))
}
@Serializable data class AbandonedGemsBuy(val saved: SavedGemsBuy, val proof: GemsBuyRecovery, val abandonedAtMs: Long)
@Serializable private data class GemsBuyJournal(val version: Int, val current: SavedGemsBuy? = null,
    val abandoned: List<AbandonedGemsBuy> = emptyList())

/** AppGraph shares this object across sessions. Every transition is a CAS on the immutable original draft. */
class GemsBuyStore(private val secret: SecretStore, private val wallet: String, private val origin: String, private val cluster: String) {
    private fun validate(s: SavedGemsBuy) {
        val d = s.draft
        require(d.wallet == wallet && d.origin == origin && d.cluster == cluster)
        require(KeepDepositPayment.validAddress(wallet) && origin.startsWith("https://") && cluster in setOf("devnet", "mainnet-beta"))
        require(d.idempotencyKey.matches(Regex("[a-zA-Z0-9_-]{8,128}")) && d.keepIn in 1..((1L shl 53) - 1))
        s.quote?.let { q -> q.validate(); require(q.wallet == wallet && q.idempotencyKey == d.idempotencyKey && q.keepIn == d.keepIn)
            require(listOf(q.wallet, q.mint, q.reference, q.source, q.destination).all(KeepDepositPayment::validAddress)) }
        require(!s.attempted || s.quote != null)
        require(s.signature == null || (s.attempted && KeepDepositPayment.validSignature(s.signature)))
        require(!s.signatureUsesPreparedHeight || (s.signature != null && s.preparedLastValidHeight != null))
        require(s.preparedLastValidHeight == null || (s.attempted && s.preparedLastValidHeight > 0))
        require(s.attemptedAtMs == null || (s.attempted && s.attemptedAtMs >= 0))
        require(s.walletEndedAtMs == null || (s.attempted && s.walletEndedAtMs >= 0))
        s.observed?.let { o -> o.validate(); require(o.originalIntent == s.quote)
            listOfNotNull(o.paymentSignature, o.txSignature).forEach { require(KeepDepositPayment.validSignature(it)) }
            require(s.attempted || (o.status in setOf("pending", "expired") && o.amount == null && o.paymentSignature == null && o.txSignature == null && o.receipt == null)) }
    }
    private fun mayAbandon(s: SavedGemsBuy, proof: GemsBuyRecovery) {
        check(!s.attempted && s.signature == null) { "An attempted wallet payment cannot be abandoned." }
        proof.validate(wallet, s.draft.idempotencyKey)
        proof.deposit?.let { o ->
            check(o.originalIntent == s.quote && o.status in setOf("pending", "expired"))
            check(o.amount == null && o.paymentSignature == null && o.txSignature == null && o.receipt == null)
        }
        s.observed?.let { o -> check(o.status in setOf("pending", "expired") && o.amount == null && o.paymentSignature == null && o.txSignature == null && o.receipt == null) }
    }
    private fun journal(): GemsBuyJournal {
        val raw = secret.read() ?: return GemsBuyJournal(1)
        val obj = Json.parseToJsonElement(raw).jsonObject
        // The initial, unwired core wrote a single saved record. Preserve it without silently discarding evidence.
        val j = if ("draft" in obj) GemsBuyJournal(1, current = Json.decodeFromJsonElement<SavedGemsBuy>(obj))
            else Json.decodeFromJsonElement<GemsBuyJournal>(obj)
        require(j.version == 1)
        j.current?.let(::validate)
        j.abandoned.forEach { a -> validate(a.saved); mayAbandon(a.saved, a.proof); require(a.abandonedAtMs >= 0) }
        require(j.abandoned.map { it.saved.draft.idempotencyKey }.distinct().size == j.abandoned.size)
        require(j.current == null || j.abandoned.none { it.saved.draft.idempotencyKey == j.current.draft.idempotencyKey })
        return j
    }
    private fun write(j: GemsBuyJournal) = secret.write(Json.encodeToString(GemsBuyJournal.serializer(), j))
    @Synchronized fun read(): SavedGemsBuy? = journal().current
    @Synchronized fun archive(): List<AbandonedGemsBuy> = journal().abandoned.toList()
    @Synchronized fun begin(draft: GemsBuyDraft): SavedGemsBuy {
        val j = journal(); check(j.current == null) { "Recover the original wallet purchase first." }
        check(j.abandoned.none { it.saved.draft.idempotencyKey == draft.idempotencyKey }) { "An archived purchase key cannot be reused." }
        return SavedGemsBuy(draft).also { validate(it); write(j.copy(current = it)) }
    }
    @Synchronized fun update(draft: GemsBuyDraft, transform: (SavedGemsBuy) -> SavedGemsBuy): SavedGemsBuy {
        val j = journal(); val old = requireNotNull(j.current); check(old.draft == draft) { "The saved wallet purchase changed." }
        return transform(old).also { next ->
            check(next.draft == old.draft && (old.quote == null || next.quote == old.quote))
            check(old.signature == null || next.signature == old.signature)
            check(old.observed?.receipt == null || next.observed == old.observed)
            validate(next); write(j.copy(current = next))
        }
    }
    @Synchronized fun finish(draft: GemsBuyDraft, hydrated: Boolean) {
        val j = journal(); val s = requireNotNull(j.current); check(s.draft == draft)
        check(hydrated && s.observed?.receipt != null) { "Recover the original credit and refresh balances first." }
        write(j.copy(current = null))
    }
    /** Explicit cancellation of quote creation, never a money transfer. CAS catches a competing
     * wallet handoff after the fresh GET; original identity and proof remain archived forever. */
    @Synchronized fun abandon(expected: SavedGemsBuy, proof: GemsBuyRecovery, now: Long) {
        val j = journal(); check(j.current == expected) { "The saved purchase changed during its recovery check." }
        mayAbandon(expected, proof); require(now >= 0)
        write(j.copy(current = null, abandoned = j.abandoned + AbandonedGemsBuy(expected, proof, now)))
    }
}
