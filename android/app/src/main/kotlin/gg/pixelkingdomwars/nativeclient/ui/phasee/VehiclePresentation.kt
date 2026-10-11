package gg.pixelkingdomwars.nativeclient.ui.phasee

import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.data.VehicleRecord
import gg.pixelkingdomwars.nativeclient.model.marketSol
import gg.pixelkingdomwars.nativeclient.network.fmtN
import gg.pixelkingdomwars.nativeclient.ui.chrome.PaymentDetail
import gg.pixelkingdomwars.nativeclient.ui.chrome.PaymentPill
import gg.pixelkingdomwars.nativeclient.ui.chrome.PaymentTone
import gg.pixelkingdomwars.nativeclient.vehicle.*
import kotlinx.serialization.json.*

internal data class VehicleServiceChoice(val allowed: Boolean, val reason: String)

/** Presentation gate only. Unknown or mismatched stock never offers service; the server rechecks on reserve. */
internal fun vehicleServiceChoice(row: JsonObject, asset: JsonObject?, policy: VehiclePolicy?, operation: String): VehicleServiceChoice = runCatching {
    if(policy==null) return VehicleServiceChoice(false,"Service rules are unavailable. Check again before reserving.")
    if(operation !in listOf("upgrade","restore_uses")) return VehicleServiceChoice(false,"This service is unavailable.")
    val tier=CharterGrammar.number(row.getValue("tier"));val remaining=CharterGrammar.number(row.getValue("remainingUses"))
    if(tier !in policy.tiers) return VehicleServiceChoice(false,"This vehicle tier needs current service rules.")
    if(operation=="upgrade"&&tier==policy.tiers.last()) return VehicleServiceChoice(false,"This vehicle is already at the maximum tier.")
    if(operation=="restore_uses"&&remaining!=0L) return VehicleServiceChoice(false,"Use restoration is available when this vehicle is exhausted.")
    if(asset==null) return VehicleServiceChoice(false,"Choose an owned asset to burn for this service.")
    if(asset.charterText("family")!=row.charterText("family")||CharterGrammar.number(asset.getValue("tier"))!=tier)
        return VehicleServiceChoice(false,"Choose a ${islandShareResource(row.charterText("family"))} asset at tier $tier.")
    VehicleServiceChoice(true,if(operation=="upgrade")"Upgrade preserves the remaining use allowance." else "Restoration renews the exhausted use allowance.")
}.getOrElse { VehicleServiceChoice(false,"Service details are unavailable. Refresh the fleet and owned assets.") }

/** Completion copy comes only from the retained receipt, never a clock or a successful wallet prompt. */
internal fun vehicleRecordPill(r: VehicleRecord): PaymentPill {
    if(r.closedUnknown!=null) return PaymentPill("CLOSED",PaymentTone.CLOSED)
    if(r.held||r.response==null) return PaymentPill("CHECKING",PaymentTone.TROUBLE)
    val v=r.response
    return when(r.kind) {
        "installation","service" -> when {
            VehicleProtocol.terminal(v)!=null -> PaymentPill(if(r.kind=="installation")"INSTALLED" else "APPLIED",PaymentTone.DONE)
            v.charterObject("record").charterOptional("signed")!=null||r.signed!=null -> PaymentPill("APPROVED",PaymentTone.SENT)
            "wallet" in r.attempts -> PaymentPill("CHECKING",PaymentTone.TROUBLE)
            else -> PaymentPill("REVIEW",PaymentTone.OPEN)
        }
        "expedition" -> when {
            v.charterOptional("return")!=null -> PaymentPill("RETURNED",PaymentTone.DONE)
            v.charterOptional("receipt")!=null -> PaymentPill("AWAY",PaymentTone.SENT)
            else -> PaymentPill("CHECKING",PaymentTone.TROUBLE)
        }
        else -> PaymentPill("CHECKED",PaymentTone.DONE)
    }
}
/** RETRY for a saved original the server has not confirmed; never for one already closed on this device. */
internal fun vehicleRetryable(r: VehicleRecord): Boolean = r.closedUnknown==null&&(r.response==null||r.kind=="expedition"&&vehicleUnknownExpedition(r))
/** CLOSE door (owner rule 2026-10-06): an unconfirmed original that a by-key read can show the server does not know. The
 * repository re-reads before closing; a collect has no by-key read. */
internal fun vehicleClosableUnknown(r: VehicleRecord): Boolean = r.closedUnknown==null&&r.consent==null&&r.signed==null&&when(r.kind) {
    "expedition" -> r.response==null||vehicleUnknownExpedition(r)
    "installation","service" -> r.response==null
    else -> false
}
private fun vehicleUnknownExpedition(r: VehicleRecord): Boolean = r.response?.let { v -> runCatching { v.charterText("status")=="unknown" }.getOrDefault(false) } == true
internal fun vehicleOriginalBase(r: VehicleRecord): String? = when {
    r.response!=null&&r.kind in listOf("installation","service") -> VehicleProtocol.destination(r.response).charterText("baseId")
    r.destination!=null -> r.destination.charterText("baseId")
    else -> r.request["baseId"]?.let(CharterGrammar::text)
}
internal fun vehicleOriginalDetails(r: VehicleRecord): List<PaymentDetail> {
    val details=mutableListOf(PaymentDetail("Saved request",r.key))
    vehicleOriginalBase(r)?.let{details+=PaymentDetail("Original kingdom",it)}
    val v=r.response
    if(v!=null&&r.kind in listOf("installation","service")) {
        val identity=VehicleProtocol.original(v).charterObject("identity")
        details+=PaymentDetail("Original wallet",VehicleProtocol.actor(v))
        details+=PaymentDetail("Original berth",VehicleProtocol.destination(v).charterText("berthId"))
        details+=PaymentDetail("Original asset",identity.charterText("assetId"))
        details+=PaymentDetail("Collection",identity.charterText("collection"))
        VehicleProtocol.original(v).charterOptional("state")?.let{details+=PaymentDetail("Original installed vehicle",it.charterText("installationId"))}
        v.charterOptional("burnReceipt")?.let { receipt->
            details+=PaymentDetail("Burn transaction",receipt.charterText("signature"))
            details+=PaymentDetail("Finalized slot",receipt.getValue("slot").toString())
        }
    } else {
        r.request["installationId"]?.let{details+=PaymentDetail("Original installed vehicle",CharterGrammar.text(it))}
        r.request["assetId"]?.let{details+=PaymentDetail("Original asset",CharterGrammar.text(it))}
        (r.destination?.get("berthId")?:r.request["berthId"])?.let{details+=PaymentDetail("Original berth",CharterGrammar.text(it))}
        v?.charterOptional("receipt")?.let{details+=PaymentDetail("Scheduled return (UTC)",it.charterText("returnsAt"))}
        v?.charterOptional("return")?.let{details+=PaymentDetail("Returned at (UTC)",it.charterText("returnedAt"))}
    }
    return details
}
internal fun vehicleFinalFee(r: VehicleRecord): String? = r.response?.takeIf { r.kind in listOf("installation","service")&&VehicleProtocol.terminal(it)!=null }
    ?.charterOptional("burnReceipt")?.let { "${marketSol(it.charterText("feeLamports"))} SOL" }
internal fun vehicleCargoRows(route: JsonObject): List<PaymentDetail> = (listOf(route)+listOfNotNull(route.charterOptional("secondaryOutput"))).flatMap { cargo->
    val resource=islandShareResource(cargo.charterText("resourceId"))
    listOf(PaymentDetail("$resource · net cargo",fmtN(cargo.charterText("netQuantity"))),
        PaymentDetail("$resource · gross / island share","${fmtN(cargo.charterText("grossQuantity"))} / ${fmtN(cargo.charterText("islandPoolQuantity"))}"))
}
