package gg.pixelkingdomwars.nativeclient.ui.phasee

import gg.pixelkingdomwars.nativeclient.data.MiningTaxClaimsOperation
import gg.pixelkingdomwars.nativeclient.seekerresources.SeekerResourceClaimOperation
import gg.pixelkingdomwars.nativeclient.seekerresources.SeekerResourceEntitlementView
import gg.pixelkingdomwars.nativeclient.ui.chrome.PaymentDetail
import gg.pixelkingdomwars.nativeclient.ui.chrome.PaymentPill
import gg.pixelkingdomwars.nativeclient.ui.chrome.PaymentTone
import java.math.BigInteger
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/** Display only: raw server timestamps remain in each card's Details. No local clock decides a claim. */
internal fun islandShareTime(value: String, zone: ZoneId = ZoneId.systemDefault(), locale: Locale = Locale.getDefault()): String =
    runCatching { Instant.parse(value).atZone(zone).format(DateTimeFormatter.ofPattern("d MMM yyyy, HH:mm z", locale)) }.getOrDefault(value)
internal fun islandShareResource(id: String) = id.split('_').joinToString(" ") { it.replaceFirstChar(Char::uppercaseChar) }

/** Never mix unlike resources or present a paginated subtotal as all outstanding shares. */
internal fun islandResourcePageTotals(view: SeekerResourceEntitlementView?): List<Pair<String, String>>? {
    if (view?.status != "available") return null
    return view.rows.groupBy { it.resourceId }.map { (id, rows) ->
        val amount = rows.fold(BigInteger.ZERO) { total, row -> total + BigInteger(row.dueQuantity) }
        id to amount.toString().reversed().chunked(3).joinToString(",").reversed()
    }
}
internal fun islandResourcePill(op: SeekerResourceClaimOperation) = when {
    op.receipt != null -> PaymentPill("CLAIMED", PaymentTone.DONE)
    op.attemptRevision != null -> PaymentPill("CHECKING", PaymentTone.TROUBLE)
    else -> PaymentPill("REVIEW", PaymentTone.OPEN)
}
internal fun islandKeepPaid(op: MiningTaxClaimsOperation, decimals: Int?): String? = op.settlement
    ?.takeIf { it.status == "settled" }?.settlement?.takeIf { it.claimFinalized && it.receipt.phase == "settled" }
    ?.receipt?.paidKeepBaseUnits?.let { value -> miningClaimsKeepAmount(value, decimals)?.let { "$it KEEP" } ?: "$value KEEP base units" }
internal fun islandKeepDetails(op: MiningTaxClaimsOperation) = listOfNotNull(
    PaymentDetail("Request", op.request.idempotencyKey),
    op.preparation?.let { PaymentDetail("Original wallet", it.wallet) },
    op.preparation?.let { PaymentDetail("Prepared at (UTC)", it.preparedAt) },
    op.preparation?.let { PaymentDetail("Consent expires (UTC)", it.expiresAt) },
    op.continuation?.let { PaymentDetail("Linked request", it.request.idempotencyKey) },
    op.settlement?.settlement?.let { PaymentDetail("Settled at (UTC)", it.settledAt) },
) + op.transactions.mapNotNull { tx -> tx.signed?.let { PaymentDetail("Transaction ${it.ordinal + 1}", it.signature) } }
