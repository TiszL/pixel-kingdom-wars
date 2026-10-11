package gg.pixelkingdomwars.nativeclient.ui.economy

import gg.pixelkingdomwars.nativeclient.harvester.*
import gg.pixelkingdomwars.nativeclient.ui.chrome.PaymentDetail
import gg.pixelkingdomwars.nativeclient.ui.chrome.PaymentPill
import gg.pixelkingdomwars.nativeclient.ui.chrome.PaymentTone
import java.math.BigInteger

/** Time passing cannot prove source closure or additional resource delivery. */
internal fun harvesterSavedPill(operation: HarvesterOperation) = when {
    operation.proof?.settlement?.closure != null -> PaymentPill("CLOSED", PaymentTone.CLOSED)
    operation.proof != null -> PaymentPill("ACCEPTED", PaymentTone.SENT)
    operation.refusal != null -> PaymentPill("DECLINED", PaymentTone.TROUBLE)
    operation.attemptRevision != null -> PaymentPill("CHECK OUTCOME", PaymentTone.TROUBLE)
    else -> PaymentPill("SAVED DRAFT", PaymentTone.OPEN)
}

internal fun harvesterSelectionReady(view: HarvesterView, operation: HarvesterOperation?, actionsAllowed: Boolean, busy: Boolean) =
    actionsAllowed && !busy && operation == null && view.acceptingSelections && view.home != null

internal fun harvesterCommandDetails(command: HarvesterCommand) = listOf(
    PaymentDetail("Producing kingdom", command.request.baseId), PaymentDetail("Harvester", command.request.harvesterId),
    PaymentDetail("Original request", command.key), PaymentDetail("Policy version", command.policy.policyVersion.toString()))

internal fun harvesterSourceDetails(source: HarvesterSummary) = listOf(
    PaymentDetail("Producing kingdom", source.baseId), PaymentDetail("Harvester", source.harvesterId), PaymentDetail("Source", source.sourceId))

internal fun harvesterOriginalDetails(operation: HarvesterOperation) = harvesterCommandDetails(operation.command) + listOfNotNull(
    operation.refusal?.let { PaymentDetail("Original refusal", "${it.status} · ${it.code}") },
    operation.proof?.originalReceipt?.source?.let { PaymentDetail("Original Seeker term", it.term.termId) },
    operation.proof?.settlement?.custodyStop?.let { PaymentDetail("Authority cutoff (UTC)", it.cutoffAt) })

internal data class HarvesterObservedAmounts(val gross: String, val delivered: String, val pool: String)
/** Sum only the stored server observations, never projected future earning periods. */
internal fun harvesterObservedAmounts(settlement: HarvesterSettlement) = HarvesterObservedAmounts(
    settlement.events.fold(BigInteger.ZERO) { sum, event -> sum + event.grossQuantity.toBigInteger() }.toString(),
    settlement.events.fold(BigInteger.ZERO) { sum, event -> sum + event.netQuantity.toBigInteger() }.toString(),
    settlement.events.fold(BigInteger.ZERO) { sum, event -> sum + event.islandPoolQuantity.toBigInteger() }.toString())
