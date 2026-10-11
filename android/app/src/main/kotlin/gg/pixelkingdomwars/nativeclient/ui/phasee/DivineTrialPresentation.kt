package gg.pixelkingdomwars.nativeclient.ui.phasee

import gg.pixelkingdomwars.nativeclient.data.DivineSavedEvent
import gg.pixelkingdomwars.nativeclient.divine.*
import gg.pixelkingdomwars.nativeclient.network.fmtN
import gg.pixelkingdomwars.nativeclient.ui.chrome.PaymentDetail
import gg.pixelkingdomwars.nativeclient.ui.chrome.PaymentPill
import gg.pixelkingdomwars.nativeclient.ui.chrome.PaymentTone
import kotlinx.serialization.json.*

internal data class DivineTrialActions(val enter: Boolean, val attempt: Boolean, val claim: Boolean)

/** Echo existing server/journal fences. Device time and the current kingdom never reopen a saved event. */
internal fun divineTrialActions(saved: DivineSavedEvent): DivineTrialActions {
    val p=saved.participant ?: return DivineTrialActions(false,false,false)
    val ready=saved.held.isEmpty()&&saved.commands.none{it.unresolved}
    val open=saved.event.doptional("terminal")==null
    val entry=p.doptional("entry");val attempts=p.drows("attempts");val prize=p.doptional("prize")
    return DivineTrialActions(
        ready&&open&&entry==null,
        ready&&open&&entry!=null&&attempts.size<DivineRules.from(saved.rules).bound("attemptsPerWallet")&&attempts.none{it.dt("status") in listOf("admitted","committed")},
        ready&&prize!=null&&prize.doptional("claim")==null,
    )
}
internal fun divinePrizeDestination(saved: DivineSavedEvent, current: String?): String? =
    saved.participant?.doptional("prize")?.doptional("claim")?.dt("baseId")
        ?:saved.commands.lastOrNull{it.kind=="prize"}?.request?.dt("baseId")?:current
internal fun divinePrizeRows(prize: JsonObject) = prize.dobj("amounts").map{(item,quantity)->PaymentDetail(islandShareResource(item),fmtN(DivineGrammar.text(quantity)))}
internal fun divineAttemptPill(attempt: JsonObject) = when(attempt.dt("status")) {
    "completed" -> PaymentPill("RESULT",PaymentTone.DONE)
    "committed" -> PaymentPill("CHECKING",PaymentTone.SENT)
    "admitted" -> PaymentPill("READY",PaymentTone.OPEN)
    else -> PaymentPill("CLOSED",PaymentTone.CLOSED)
}
internal fun divineAttemptDetails(attempt: JsonObject) = listOfNotNull(
    PaymentDetail("Original attempt",attempt.dt("id")),PaymentDetail("Original kingdom",attempt.dt("baseId")),
    PaymentDetail("Original wallet",attempt.dt("wallet")),PaymentDetail("Admitted at (UTC)",attempt.dt("admittedAt")),
    attempt["completedAt"]?.takeUnless{it==JsonNull}?.let{PaymentDetail("Completed at (UTC)",DivineGrammar.text(it))},
    attempt.doptional("result")?.let{PaymentDetail("Result proof",it.dt("inputSha256"))},
)
internal fun divineCommandLabel(kind: String) = when(kind) {
    "entries" -> "Entry"
    "attempts" -> "Attempt admission"
    "submit" -> "Battle plan"
    "abandon" -> "Abandonment"
    "prize" -> "Prize claim"
    else -> kind.replace('_',' ')
}
