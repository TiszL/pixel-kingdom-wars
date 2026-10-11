package gg.pixelkingdomwars.nativeclient.ui.phasee

import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.data.CharterRecord
import gg.pixelkingdomwars.nativeclient.model.marketSol
import gg.pixelkingdomwars.nativeclient.ui.chrome.PaymentDetail
import gg.pixelkingdomwars.nativeclient.ui.chrome.PaymentPill
import gg.pixelkingdomwars.nativeclient.ui.chrome.PaymentTone
import kotlinx.serialization.json.*

/** Quote rows retain exact server amounts. A sale royalty is inside the price, never added again. */
internal fun charterCostRows(costs: JsonObject): List<PaymentDetail> = listOfNotNull(
    costs["priceLamports"]?.let { PaymentDetail("Sale price", "${marketSol(CharterGrammar.text(it))} SOL") },
    costs["sellerLamports"]?.let { PaymentDetail("Seller receives from sale", "${marketSol(CharterGrammar.text(it))} SOL") },
    costs["royaltyLamports"]?.let { PaymentDetail("Royalty included in sale price", "${marketSol(CharterGrammar.text(it))} SOL") },
    costs["networkFeeLamports"]?.let { PaymentDetail("Network fee", "${marketSol(CharterGrammar.text(it))} SOL") },
    costs["rentLamports"]?.let { PaymentDetail("Account rent", "${marketSol(CharterGrammar.text(it))} SOL") },
    costs["coreCreateFeeLamports"]?.let { PaymentDetail("NFT creation fee", "${marketSol(CharterGrammar.text(it))} SOL") },
)
internal fun charterRole(e: CharterEnvelope): String = when {
    e.kind == "creation" -> "CLAN CREATION"
    e.actor == e.original.charterText("buyer") -> "BUY CLAN LEADERSHIP"
    else -> "SELL CLAN LEADERSHIP"
}
internal fun charterRecordPill(r: CharterRecord, e: CharterEnvelope?): PaymentPill = when {
    r.held || e == null -> PaymentPill("CHECKING", PaymentTone.TROUBLE)
    e.terminal != null -> if (e.status.startsWith("cancel")) PaymentPill("CANCELLED", PaymentTone.CLOSED) else PaymentPill("RECORDED", PaymentTone.DONE)
    e.wire != null -> PaymentPill("READY", PaymentTone.SENT)
    "wallet" in r.attempts && r.ownSignature == null -> PaymentPill("CHECKING", PaymentTone.TROUBLE)
    e.contributions.isNotEmpty() -> PaymentPill("WAITING", PaymentTone.SENT)
    else -> PaymentPill("REVIEW", PaymentTone.OPEN)
}
internal fun charterOriginalDetails(r: CharterRecord, e: CharterEnvelope?): List<PaymentDetail> = listOfNotNull(
    PaymentDetail("Saved request", r.localKey),
    e?.let { PaymentDetail("Original record", it.key) },
    e?.let { PaymentDetail("Original wallet", it.actor) },
    e?.let { PaymentDetail("Server status", it.status) },
) + if (e?.kind == "sale") listOf(
    PaymentDetail("Original seller", e.original.charterText("seller")),
    PaymentDetail("Original buyer", e.original.charterText("buyer")),
) else emptyList()

/** Displayed dates never decide eligibility; the original UTC values remain copyable in Details. */
internal fun tournamentScheduleDetails(event: JsonObject) = listOf("entryStartsAt" to "Entry opens (UTC)",
    "playStartsAt" to "Entry closes / battles open (UTC)", "playEndsAt" to "Battles close (UTC)",
    "occupationEndsAt" to "Occupation ends (UTC)").map { (key, label) -> PaymentDetail(label, event.charterText(key)) }
internal fun tournamentPrizeRows(prize: JsonObject) = prize.charterObject("amounts").map { (id, quantity) ->
    PaymentDetail(islandShareResource(id), CharterGrammar.text(quantity))
}
internal fun tournamentLockConsent(operation: JsonObject): String =
    if (operation.charterObject("original").charterObject("operation").charterText("action") == "set")
        "Approve the original captain and frozen roster for this event. Roster changes and Charter sales stay locked until the captain clears the original lock. Your Charter stays with you."
    else "Approve release of this event’s original captain lock. The completed event and its original roster keep their recorded results and prizes. Your Charter stays with you."

/** The current captain may start an entry; original participant/recovery rights use their saved identities. */
internal fun tournamentCaptainCanEnter(leader: String?, wallet: String?, eventCompleted: Boolean = false, alreadyEntered: Boolean = false) =
    leader != null && wallet != null && leader == wallet && !eventCompleted && !alreadyEntered
