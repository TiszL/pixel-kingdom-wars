package gg.pixelkingdomwars.nativeclient.ui.phasee

import gg.pixelkingdomwars.nativeclient.data.MiningClaimsOperation
import gg.pixelkingdomwars.nativeclient.data.MiningClaimsState
import gg.pixelkingdomwars.nativeclient.ui.chrome.PaymentDetail
import gg.pixelkingdomwars.nativeclient.ui.chrome.PaymentPill
import gg.pixelkingdomwars.nativeclient.ui.chrome.PaymentTone

internal data class MiningClaimsAllocation(val amount: String?, val pill: PaymentPill, val message: String)

/** Current allocation is an observation, never a wallet balance or a saved claim payout. */
internal fun miningClaimsAllocation(state: MiningClaimsState): MiningClaimsAllocation {
    val status = state.status
    val (pill, message) = when (status?.state) {
        "ready" -> PaymentPill("READY", PaymentTone.OPEN) to "This mining allocation is ready for a claim."
        "no_allocation" -> PaymentPill("NO ALLOCATION", PaymentTone.CLOSED) to "There is no KEEP in this allocation for your wallet."
        "delayed" -> PaymentPill("WAITING", PaymentTone.CLOSED) to "This allocation is waiting for its claim window. Refresh to check when it opens."
        "paused" -> PaymentPill("PAUSED", PaymentTone.CLOSED) to "New claims are paused. Saved claims and receipts remain available."
        "revoked" -> PaymentPill("WITHDRAWN", PaymentTone.CLOSED) to "This allocation was withdrawn. Check any saved claim for its original outcome."
        "claimed" -> PaymentPill("CLAIMED", PaymentTone.DONE) to "This allocation has already been claimed. Saved receipts show the amounts paid."
        else -> PaymentPill("UNAVAILABLE", PaymentTone.CLOSED) to "Current allocation could not be verified. Refresh to check again; saved claims remain below."
    }
    return MiningClaimsAllocation(miningClaimsKeepAmount(status?.claimableBaseUnits, miningClaimsDecimals(state)), pill, message)
}

internal fun miningClaimsSavedPill(op: MiningClaimsOperation): PaymentPill = when {
    op.ordered?.held==true -> PaymentPill("CHECKING", PaymentTone.TROUBLE)
    op.ordered?.continuation!=null -> PaymentPill("CONTINUED", PaymentTone.CLOSED)
    op.claim?.state == "settled" -> PaymentPill("FINALIZED", PaymentTone.DONE)
    op.claim?.state == "failed" -> PaymentPill("FAILED", PaymentTone.TROUBLE)
    op.claim?.state == "retained" -> PaymentPill("RECORDED", PaymentTone.SENT)
    op.ordered?.signed?.isNotEmpty()==true && op.claim?.signature==null -> PaymentPill("APPROVED", PaymentTone.OPEN)
    op.ordered?.signingStarted?.isNotEmpty()==true && op.claim?.signature==null -> PaymentPill("CHECKING", PaymentTone.TROUBLE)
    op.submitAttempted -> PaymentPill("CHECKING", PaymentTone.TROUBLE)
    op.signed != null -> PaymentPill("APPROVED", PaymentTone.OPEN)
    op.prepareRefusal != null -> PaymentPill("REFUSED", PaymentTone.CLOSED)
    op.preparation == null || op.signingStarted -> PaymentPill("CHECKING", PaymentTone.TROUBLE)
    else -> PaymentPill("REVIEW", PaymentTone.OPEN)
}

/** A cumulative leaf or a signature does not prove how much this claim actually paid. */
internal fun miningClaimsPaidKeep(op: MiningClaimsOperation): String? = op.claim
    ?.takeIf { it.state == "settled" && it.landing == "finalized" && op.ordered?.held!=true }
    ?.settledBaseUnits?.let { miningClaimsKeepAmount(it, op.policy.tokenDecimals) }

internal fun miningClaimsSavedDetails(op: MiningClaimsOperation): List<PaymentDetail> = listOfNotNull(
    PaymentDetail("Request", op.request.idempotencyKey),
    op.preparation?.let { PaymentDetail("Original wallet", it.wallet) },
    op.preparation?.let { PaymentDetail("Claim", it.claimId) },
    op.prepareRefusal?.let { PaymentDetail("Refusal", it.code) },
    (op.claim?.signature ?: op.signed?.signature)?.let { PaymentDetail("Signature", it) },
    op.ordered?.parent?.let { PaymentDetail("Previous claim", it.parentClaimId) },
    op.ordered?.continuation?.let { PaymentDetail("Remaining claim", it.childClaimId) },
) + (op.ordered?.signed?.map { PaymentDetail("Transaction ${it.ordinal+1} signature", it.signature) } ?: emptyList())
