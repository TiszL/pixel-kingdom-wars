package gg.pixelkingdomwars.nativeclient.seekerauction

/** Retained evidence from the future N2 signing owner, not fields added to any server DTO.
 * The height belongs only to preparedBlockhash. A changed or opaque signed blockhash makes expiry undecidable.
 * This value is metadata: it does not sign, store, submit or authorize a wallet operation.
 */
data class SeekerAuctionSignedAttempt(val signature: String, val preparedBlockhash: String?,
    val signedBlockhash: String?, val lastValidBlockHeight: String?, val opaqueSend: Boolean = false) {
    fun validate() {
        auctionSignature(signature); preparedBlockhash?.let(::auctionAddress); signedBlockhash?.let(::auctionAddress)
        lastValidBlockHeight?.let(::auctionU64)
        require(lastValidBlockHeight == null || preparedBlockhash != null)
    }
}
enum class SeekerAuctionRecoveryPhase { PENDING, FINALIZED, FAILED, EXPIRED }
@ConsistentCopyVisibility
data class SeekerAuctionRecovery internal constructor(val attempt: SeekerAuctionSignedAttempt, val phase: SeekerAuctionRecoveryPhase,
    val receipt: SeekerAuctionTxStatus?) {
    val nextCheckSignature: String get() = attempt.signature
    /** Only offers explicit re-review. Current registry identity/eligibility/Seal must still be checked by N2. */
    val canOfferFreshIntent: Boolean get() = phase == SeekerAuctionRecoveryPhase.EXPIRED
}

/** SA-4 controller.ts:191-194 predicate, with explicit signed-blockhash custody and retained terminal evidence.
 * A lost POST is signature observation, never re-signing. found:false alone never clears the original intent.
 * The caller must refresh authenticated state before showing an auction result; chain finality is not UI hydration.
 */
fun seekerAuctionRecovery(attempt: SeekerAuctionSignedAttempt, observation: SeekerAuctionTxStatus?,
    previous: SeekerAuctionRecovery? = null): SeekerAuctionRecovery {
    attempt.validate(); require(previous == null || previous.attempt == attempt)
    observation?.let { it.validate(); require(it.signature == attempt.signature) }
    previous?.receipt?.let { it.validate(); require(it.signature == attempt.signature) }
    if (previous?.phase in setOf(SeekerAuctionRecoveryPhase.FINALIZED, SeekerAuctionRecoveryPhase.FAILED)) {
        require(previous?.receipt?.status == (if (previous?.phase == SeekerAuctionRecoveryPhase.FINALIZED) "finalized" else "failed"))
        return requireNotNull(previous) // A missing/stale read cannot erase retained finality.
    }
    val receipt = observation ?: previous?.receipt
    val phase = when (receipt?.status) {
        "finalized" -> SeekerAuctionRecoveryPhase.FINALIZED
        "failed" -> SeekerAuctionRecoveryPhase.FAILED
        else -> {
            val height = attempt.lastValidBlockHeight?.takeIf {
                !attempt.opaqueSend && attempt.preparedBlockhash != null && attempt.signedBlockhash == attempt.preparedBlockhash
            }
            if (receipt?.status == "pending" && receipt.found == false && receipt.finalizedBlockHeight != null && height != null &&
                auctionU64(receipt.finalizedBlockHeight) > auctionU64(height)) SeekerAuctionRecoveryPhase.EXPIRED
            else SeekerAuctionRecoveryPhase.PENDING
        }
    }
    return SeekerAuctionRecovery(attempt, phase, receipt)
}
