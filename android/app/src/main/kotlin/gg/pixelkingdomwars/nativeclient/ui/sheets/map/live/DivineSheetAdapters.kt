package gg.pixelkingdomwars.nativeclient.ui.sheets.map.live

import gg.pixelkingdomwars.nativeclient.data.DivineTrialState
import gg.pixelkingdomwars.nativeclient.ui.army.armyPortrait
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.CommandUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.live.groupedAmount
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.LoadState
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.DivineFragmentsUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.DivineTrialsUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.KingdomPickUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.SourceState
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.TRIALS_STANDINGS
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.divineTrialsTabs
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull

/*
 * The designed SOLO TRIALS (divine-trials #154) and CRYSTAL FRAGMENTS (divine-fragments #155) bodies over the original
 * Divine owners. PLAN & FIGHT and DELIVER act in place (DivineInPlace.kt); the original screens keep discovery, history,
 * recovery, sponsor prizes and every saved request. No week label, countdown, standings or wallet-wide total exists in the
 * retained state, so none is drawn; nothing here reads the device clock.
 */

/** Copy for the locked STANDINGS tab: there is no live standings feed on this server. */
internal const val TRIAL_STANDINGS_CLOSED = "Weekly standings are not open on this server yet. Final results open from History."

/** No event is selected in this view yet; the original screen holds trial discovery. */
private const val TRIAL_NONE_CHOSEN = "No trial chosen on this device yet. PLAN & FIGHT opens the trial list."

/** The design's footnote names a weekday; the retained rules do not, so this keeps only what the original screen says. */
private const val TRIAL_FOOTNOTE = "Your own troops stay home. Your army, energy and raid rewards are unaffected."

/** PLAN & FIGHT acts unless a saved check or no remaining try says no; an admitted attempt is always plannable (its try is
 *  already used). An unknown try count (no selected event or participation yet) still acts: it opens discovery. */
private fun trialPlanPermitted(display: DivineTrialsDisplay): Boolean =
    display.recovery.isEmpty() && (display.planAttemptId != null || display.triesLeft != 0)

/** The primary's sub-line (frame "try 2 of 3 this week"; the rules carry no week, so none is named): the try about to be
 *  used, or the admitted one being planned. Null whenever either count is unknown. */
private fun trialTrySub(display: DivineTrialsDisplay): String? {
    val left = display.triesLeft ?: return null
    val max = display.triesMax ?: return null
    val planning = display.planAttemptId != null
    if (!planning && left <= 0) return null
    val n = if (planning) max - left else max - left + 1
    return if (n in 1..max) "try $n of $max" else null
}

internal fun divineTrialsUi(display: DivineTrialsDisplay, loading: Boolean): DivineTrialsUi {
    val plan = trialPlanPermitted(display)
    // Locked tabs still call back, so the host can say why there are no standings.
    val tabs = divineTrialsTabs().map { if (it.id == TRIALS_STANDINGS) it.copy(locked = true) else it }
    val ui = DivineTrialsUi(
        week = UNKNOWN,
        endsIn = null,
        army = display.army,
        hero = display.hero,
        triesLeft = display.triesLeft,
        triesMax = display.triesMax,
        best = display.best,
        prizeLine = UNKNOWN,
        lastWeek = null,
        primary = CommandUi(FeatureId("island.divine.trials.plan"), "trophy", "PLAN & FIGHT", null, true,
            if (plan) CommandState.ENABLED else CommandState.DISABLED, if (plan) null else display.primary.reason, null, verb = Verb.GOLD,
            sub = if (plan) trialTrySub(display) else null),
        replay = display.replayAttemptId?.let {
            CommandUi(FeatureId("island.divine.trials.best"), "replay", "BEST", null, false, CommandState.ENABLED, null, null)
        },
        standings = null,
        tab = tabs.first().id,
        recovery = display.recovery.firstOrNull(),
        load = if (loading) LoadState.Loading else LoadState.Ready,
        emptyLine = if (!loading && display.eventId == null) TRIAL_NONE_CHOSEN else null,
        tabs = tabs,
        // The design's "500" is a placeholder; the rules' site count is the cutoff (SPEC Round 2 note 3).
        prizeTitle = "WHAT THE TOP ${groupedAmount(display.cutoff?.toString()) ?: UNKNOWN} WIN",
        footnote = TRIAL_FOOTNOTE,
    )
    return display.cutoff?.let { ui.copy(cutoff = it) } ?: ui
}

/** DELIVER reviews one waiting item in place only with no saved request out, deliveries open, a kingdom selected and
 *  something READY (SPEC §E empty: off, "Nothing waiting"); otherwise it explains with the mapper's reason. It never
 *  carries a total: the controller's pages are not the whole wallet. A kingdom name is drawn only when the host knows it. */
internal fun divineFragmentsUi(display: DivineFragmentsDisplay, kingdomName: String, loading: Boolean,
    featureOn: Boolean, selectedBaseId: String?): DivineFragmentsUi {
    // A read still running is not proof that nothing is waiting.
    val nothing = !loading && display.waiting.none { it.ui.state == SourceState.READY }
    val deliver = display.recovery.isEmpty() && featureOn && selectedBaseId != null && !nothing
    val named = kingdomName.takeUnless { it.isBlank() || it == UNKNOWN }
    val destination = when {
        selectedBaseId == null -> KingdomPickUi(kingdomName, "No kingdom selected", null)
        named != null -> KingdomPickUi(named, "Your selected kingdom", null)
        else -> KingdomPickUi("Your selected kingdom", "Choose another in Your Bases", null)
    }
    val reason = when {
        deliver -> null
        display.recovery.isEmpty() && featureOn && selectedBaseId != null -> DIVINE_FRAGMENTS_NOTHING_WAITING
        else -> display.primary.reason
    }
    return DivineFragmentsUi(
        inKingdom = display.inKingdom,
        kingdomName = kingdomName,
        waiting = display.waiting.map { it.ui },
        destination = destination,
        primary = CommandUi(FeatureId("island.divine.fragments.deliver"), "ui:crystal-fragments", "DELIVER", null, true,
            if (deliver) CommandState.ENABLED else CommandState.DISABLED, reason, null,
            sub = if (deliver) named?.let { "into $it's stores" } else null),
        recovery = display.recovery.firstOrNull(),
        load = if (loading) LoadState.Loading else LoadState.Ready,
        waitingLine = null,
        // A read still running is not proof the feature is off.
        featureOff = display.featureOff && !loading,
    )
}

/** The original screen owns any retained check and whatever the player asked it for. An admitted attempt is planned in
 *  place on the designed sheet (owner 2026-10-06), so it no longer forces the original. */
internal fun divineTrialsOriginalRequired(display: DivineTrialsDisplay, review: Boolean): Boolean =
    review || display.recovery.isNotEmpty()

/** Recovery is checked before featureOff: a switched-off feature must never hide a saved original. */
internal fun divineFragmentsOriginalRequired(display: DivineFragmentsDisplay, review: Boolean): Boolean =
    review || display.recovery.isNotEmpty()

/** An unclaimed sponsor prize is claimed only in the original screen, so the designed sheet never stands in front of it. */
internal fun divineTrialPrizeWaiting(state: DivineTrialState?): Boolean {
    val prize = state?.selected?.participant?.get("prize") as? JsonObject ?: return false
    return prize["claim"] !is JsonObject
}

/** The fixed army's portraits through the same level-to-tier rule the Army screen uses (a level is not an art tier). */
internal fun divineTrialPortraits(state: DivineTrialState?, catalogue: JsonObject?): Map<String, String> {
    val policy = state?.selected?.rules?.get("policy") as? JsonObject ?: return emptyMap()
    val levels = policy["levels"] as? JsonObject
    return (policy["army"] as? JsonObject)?.keys?.associateWith { troop ->
        armyPortrait(catalogue, troop, (levels?.get(troop) as? JsonPrimitive)?.takeUnless { it.isString }?.intOrNull)
    }.orEmpty()
}

/** A routine re-read keeps the last view the player saw: LoadState.Loading would redraw shown counts and amounts as UNKNOWN. */
internal fun <T : Any> divineRoutineUi(last: T?, fresh: T, loading: Boolean): T = if (loading && last != null) last else fresh
