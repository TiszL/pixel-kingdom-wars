package gg.pixelkingdomwars.nativeclient.ui.sheets.map.live

import gg.pixelkingdomwars.nativeclient.data.DivineFragmentCommand
import gg.pixelkingdomwars.nativeclient.data.DivineFragmentState
import gg.pixelkingdomwars.nativeclient.data.DivineTrialState
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.MoneyStage
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.phasee.divineTrialActions
import gg.pixelkingdomwars.nativeclient.ui.phasee.fragmentSourceSummary
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.live.groupedAmount
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.DELIVER_CHECK_FIRST
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.FinePrintSealUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.SealGetUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.SourceState
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull

/*
 * SOLO TRIALS (divine-trials #154) and CRYSTAL FRAGMENTS (divine-fragments #155) act in place (owner 2026-10-06, "every
 * detail of the new interface"). PLAN & FIGHT enters, uses a try or opens the planner through DivineTrialViewModel; DELIVER
 * reviews one earning or one Seeker share through DivineFragmentViewModel and confirms it on the map cluster's
 * FinePrintSeal, which carries ONLY the original review dialog's strings (DivineFragmentScreen). No request, signature or
 * payment starts here: these are pure decisions, and the designed homes call the owners with them. The original screens
 * keep discovery, history, recovery and sponsor prizes.
 */

/** The fragments owner's own wording (DivineFragmentScreen) while new destination actions are off. */
private const val DIVINE_FRAGMENTS_PAUSED = "New destination actions are unavailable. Saved outcomes can still be checked."
/** No kingdom is selected: deliveries land only in the account's selected kingdom, chosen in Your Bases. */
private const val DIVINE_FRAGMENTS_NO_KINGDOM = "Choose a kingdom in Your Bases before delivering."
/** A page is still unread, so "nothing waiting" would be a guess. */
private const val DIVINE_FRAGMENTS_UNREAD = "Your fragment earnings are still being read. Try again in a moment."
/** SPEC Round 2 §E empty state. */
internal const val DIVINE_FRAGMENTS_NOTHING_WAITING = "Nothing waiting · hold a solo area to earn"
/** The trial owner's own wording (DivineTrialScreen) while new trial actions are paused. */
private const val DIVINE_TRIAL_PAUSED = "New trial actions are paused. Saved history and original recovery remain available."
/** The trial owner's own wording (DivineTrialScreen) with no kingdom selected. */
private const val DIVINE_TRIAL_NO_KINGDOM = "Select a kingdom before requesting entry, a new attempt or a fresh prize claim."

private const val DIVINE_AWARD_KEY = "award:"
private const val DIVINE_SHARE_KEY = "share:"
private const val DIVINE_FRAGMENT_ICON = "ui:crystal-fragments"

/** The keys of the WAITING FOR YOU rows the sheet draws READY, in order. The targets below come from these, so DELIVER acts
 *  on exactly what the player sees: a row hidden by a retained receipt or held by a saved request is never a target. */
private fun divineReadyKeys(state: DivineFragmentState?): List<String> =
    divineFragmentsDisplay(state, null, true).waiting.filter { it.ui.state == SourceState.READY }.map { it.key }

/** The earning DELIVER reviews: the first undelivered award the sheet shows READY (a subset of the rows the original screen
 *  offers REVIEW DELIVERY on). Null while the awards page is unread or everything on it is delivered: DELIVER must never
 *  resend an earning that already has a delivery. */
internal fun divineDeliverTarget(state: DivineFragmentState?): String? =
    divineReadyKeys(state).firstOrNull { it.startsWith(DIVINE_AWARD_KEY) }?.removePrefix(DIVINE_AWARD_KEY)

/** The Seeker share DELIVER reviews once no earning is waiting: the exact claims row (the owner admits only a row from its
 *  own page) behind the first READY share. Null when none is READY. */
internal fun divineShareTarget(state: DivineFragmentState?): JsonObject? {
    val key = divineReadyKeys(state).firstOrNull { it.startsWith(DIVINE_SHARE_KEY) } ?: return null
    val rows = (state?.claims?.get("rows") as? JsonArray)?.mapNotNull { it as? JsonObject }.orEmpty()
    return rows.firstOrNull { row ->
        val term = (row["termId"] as? JsonPrimitive)?.takeIf { it.isString }?.content
        val spot = (row["spotId"] as? JsonPrimitive)?.takeUnless { it.isString }?.intOrNull
        term != null && spot != null && "$DIVINE_SHARE_KEY$term:$spot" == key
    }
}

/** What one DELIVER tap does. */
internal sealed interface FragmentDeliverStep {
    /** Review this earning's delivery (`DivineFragmentViewModel.delivery`). */
    data class Deliver(val eventId: String) : FragmentDeliverStep
    /** Review this Seeker share (`DivineFragmentViewModel.claim`). */
    data class Claim(val row: JsonObject) : FragmentDeliverStep
    /** Nothing is sent: say why. */
    data class Explain(val reason: String) : FragmentDeliverStep
}

/** DELIVER moves one waiting item per review (earnings first, then Seeker shares), only with no saved request out, new
 *  destination actions open and a kingdom selected. The owner re-checks every one of these before it saves anything. */
internal fun divineFragmentDeliverStep(state: DivineFragmentState?, selectedBase: String?, allowed: Boolean): FragmentDeliverStep {
    if (state?.journal?.commands.orEmpty().any { it.unresolved }) return FragmentDeliverStep.Explain(DELIVER_CHECK_FIRST)
    if (!allowed) return FragmentDeliverStep.Explain(DIVINE_FRAGMENTS_PAUSED)
    if (selectedBase == null) return FragmentDeliverStep.Explain(DIVINE_FRAGMENTS_NO_KINGDOM)
    divineDeliverTarget(state)?.let { return FragmentDeliverStep.Deliver(it) }
    divineShareTarget(state)?.let { return FragmentDeliverStep.Claim(it) }
    return FragmentDeliverStep.Explain(if (state?.awards == null || state?.claims == null) DIVINE_FRAGMENTS_UNREAD else DIVINE_FRAGMENTS_NOTHING_WAITING)
}

/**
 * The DELIVER / CLAIM Seal, built only from the original review dialog (DivineFragmentScreen): its title, its sentence, the
 * earning's source summary, the destination kingdom and the ownership line, and its confirm label. Nothing is paid from a
 * wallet; the pay token is the fragments the request moves ("…" for a share, whose amount only the server computes).
 * [busy] is the owner's running request (the money sequence's Sending); [canConfirm] false while not busy means new
 * destination actions are off, which the Seal says instead of a silent primary.
 */
internal fun divineFragmentSealUi(command: DivineFragmentCommand, kingdomName: String?, armedAtMs: Long, busy: Boolean,
    canConfirm: Boolean): FinePrintSealUi {
    val delivery = command.kind == "delivery"
    val award = command.consent["award"] as? JsonObject
    val net = (award?.get("net") as? JsonPrimitive)?.takeIf { it.isString }?.content
    val amount = if (delivery) groupedAmount(net) else null
    return FinePrintSealUi(
        title = if (delivery) "DELIVER CRYSTAL FRAGMENTS" else "CLAIM FRAGMENT SHARE",
        pay = PriceUi(Currency.ITEM, amount, if (amount != null) PriceStatus.OK else PriceStatus.CHECKING, icon = DIVINE_FRAGMENT_ICON),
        gets = SealGetUi(null, kingdomName?.uppercase() ?: UNKNOWN),
        lines = listOf(if (delivery) "Deliver ${net ?: UNKNOWN} fragments from this original earning."
            else "Claim the amount currently due to this original Seeker spot. The server computes the cumulative share."),
        secondary = if (delivery && award != null) fragmentSourceSummary(award) else null,
        finePrint = listOf("Destination kingdom: ${kingdomName ?: command.base}", "Stored fragments stay with this kingdom if its ownership changes."),
        confirmLabel = if (delivery) "DELIVER FRAGMENTS" else "CLAIM FRAGMENT SHARE",
        armedAtMs = armedAtMs,
        stage = if (busy) MoneyStage.SENDING else MoneyStage.READY,
        canArm = canConfirm && !busy,
        waitLine = if (!busy && !canConfirm) DIVINE_FRAGMENTS_PAUSED else null,
    )
}

/** What PLAN & FIGHT does (the original screen's ENTER / USE ATTEMPT / PLAN FIXED ARMY buttons, in their order). */
internal enum class TrialPlanStep {
    /** No trial or participation in this view: the original screen holds discovery and the participation refresh. */
    DISCOVER,
    /** `enter(base)`: request entry from the selected kingdom. */
    ENTER,
    /** `admit(base)`: use the next try, then plan it. */
    ADMIT,
    /** Open the planner on the admitted attempt; nothing is requested. */
    PLAN,
    /** Nothing is requested: say why ([divineTrialPlanReason]). */
    EXPLAIN,
}

/** Mirrors DivineTrialScreen: an admitted attempt is only ever planned (a tap must never spend a try it should only open the
 *  planner for); entry and a new try follow the saved event's own fences (`divineTrialActions`). */
internal fun divineTrialPlanStep(state: DivineTrialState?, selectedBase: String?, allowed: Boolean): TrialPlanStep {
    val saved = state?.selected ?: return TrialPlanStep.DISCOVER
    if (!allowed || selectedBase == null) return TrialPlanStep.EXPLAIN
    if (divineTrialsDisplay(state).planAttemptId != null) return TrialPlanStep.PLAN
    val participant = saved.participant ?: return TrialPlanStep.DISCOVER
    val actions = runCatching { divineTrialActions(saved) }.getOrNull() ?: return TrialPlanStep.EXPLAIN
    return when {
        participant["entry"] == JsonNull -> if (actions.enter) TrialPlanStep.ENTER else TrialPlanStep.EXPLAIN
        actions.attempt -> TrialPlanStep.ADMIT
        else -> TrialPlanStep.EXPLAIN
    }
}

/** The EXPLAIN line: the trial owner's pause / kingdom wording first, then the mapper's reason for this event. */
internal fun divineTrialPlanReason(state: DivineTrialState?, selectedBase: String?, allowed: Boolean): String = when {
    !allowed -> DIVINE_TRIAL_PAUSED
    selectedBase == null -> DIVINE_TRIAL_NO_KINGDOM
    else -> divineTrialsDisplay(state).primary.reason
}
