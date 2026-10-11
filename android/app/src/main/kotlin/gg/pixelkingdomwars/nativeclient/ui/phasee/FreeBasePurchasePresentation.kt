package gg.pixelkingdomwars.nativeclient.ui.phasee

import gg.pixelkingdomwars.nativeclient.freebase.*
import gg.pixelkingdomwars.nativeclient.network.fmtN
import gg.pixelkingdomwars.nativeclient.ui.chrome.PaymentDetail
import gg.pixelkingdomwars.nativeclient.ui.chrome.PaymentPill
import gg.pixelkingdomwars.nativeclient.ui.chrome.PaymentTone

internal fun freeBaseSavedPill(operation: FreeBasePurchaseOperation) = when {
    operation.receipt != null -> PaymentPill("ACCEPTED", PaymentTone.DONE)
    operation.attemptRevision != null -> PaymentPill("CHECK OUTCOME", PaymentTone.TROUBLE)
    else -> PaymentPill("SAVED DRAFT", PaymentTone.OPEN)
}

internal fun freeBaseAdmissionMessage(reason: String) = when (reason) {
    "ready" -> "This kingdom meets the current purchase requirements."
    "already-purchased" -> "Your additional free kingdom has already been purchased."
    "development-required" -> "Complete the required building upgrades in this kingdom, then refresh."
    "insufficient-shards" -> "This kingdom needs more SHARDS before you can purchase."
    "being-raided" -> "Wait for the raid on this kingdom to finish, then refresh."
    "source-reserved" -> "Finish this kingdom's pending land action before purchasing."
    "source-not-free" -> "Select your developed free kingdom as the source."
    "full-roster" -> "No eligible free kingdom slot is available."
    "source-unavailable", "source-required" -> "Select an available source kingdom."
    "stable-bases-required" -> "Kingdom purchases are unavailable until your kingdom list is ready."
    else -> "New purchases are paused. Saved receipts can still be checked."
}

/** Confirmation uses frozen consent; a refreshed offer must never change the displayed charge. */
internal fun freeBaseConfirmation(command: FreeBasePurchaseCommand) = "SPEND ${fmtN(command.terms.costShards)} SHARDS"
internal fun freeBaseCommandDetails(command: FreeBasePurchaseCommand) = listOf(
    PaymentDetail("Source kingdom", command.request.sourceBaseId), PaymentDetail("Original request", command.key),
    PaymentDetail("Policy version", command.terms.policyVersion.toString()))
internal fun freeBaseReceiptDetails(receipt: FreeBasePurchaseReceipt) = listOf(
    PaymentDetail("Purchased kingdom", receipt.baseId), PaymentDetail("Source kingdom", receipt.sourceBaseId),
    PaymentDetail("Original request", receipt.idempotencyKey), PaymentDetail("SHARDS debit", receipt.debitTransactionId),
    PaymentDetail("Accepted (UTC)", receipt.acceptedAt))
