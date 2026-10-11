package gg.pixelkingdomwars.nativeclient.ui.sheets.editor

import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi

/*
 * Design component: the pure rules of the BuildingInfo half sheet (design/final/buildings/SPEC.md §2A, info.png; design
 * correction 7): how its primary draws and where a tap on it goes, which stat icons get the portrait frame, how a stat
 * is spoken, and the fold to "All levels". No Compose; JVM-tested in `BuildingInfoLogicTest`.
 */

/** Whether the sheet's data has arrived (SPEC §2A.3). */
enum class InfoLoad {
    /** Stats, cost and primary are the server's. */
    READY,
    /** Header + title from the selection; stats are four "…" skeleton rows; the primary is stone dots "Checking". */
    LOADING,
    /** Stats keep "…", an inline TRY AGAIN; the primary is off with "waiting for the server". */
    ERROR,
}

/** What the primary is (SPEC §2A.2: UPGRADE | FINISH | MAX). */
enum class InfoPrimaryKind {
    /** Green "UPGRADE TO LV n": opens the UPGRADE half sheet (navigation; the spend is confirmed there). */
    UPGRADE,
    /** Gold FINISH priced in Gems while upgrading: opens the Gems Seal (the spend is confirmed there). */
    FINISH,
    /** A charcoal "MAX LEVEL" plate (not a button). */
    MAX,
}

/** Where a tap on the primary goes. */
enum class InfoTap { UPGRADE, FINISH, NEED_MORE, EXPLAIN, NONE }

/** The most stat rows the list shows before the "All levels" row (SPEC §2A.1 "Max 5 rows"). */
const val INFO_MAX_STATS = 5

/** The primary's draw state for the mapper's [state] and [price] (correction 7: CHECKING is enabled navigation,
 *  UNAVAILABLE is disabled, a SHORT FINISH price opens Need-more). An UPGRADE entry stays enabled even when its price is
 *  short or still being checked: it only opens the UPGRADE sheet, which shows the shortfall and never spends from here. */
fun infoDrawState(kind: InfoPrimaryKind, state: CommandState, price: PriceUi?): CommandState = when {
    kind == InfoPrimaryKind.MAX -> CommandState.DISABLED
    state == CommandState.LOCKED || state == CommandState.BUSY || state == CommandState.DISABLED -> state
    price?.status == PriceStatus.UNAVAILABLE -> CommandState.DISABLED
    kind == InfoPrimaryKind.FINISH && (state == CommandState.SHORT || price?.status == PriceStatus.SHORT) -> CommandState.SHORT
    else -> CommandState.ENABLED
}

/** The primary's words and state after the load state (SPEC §2A.3). */
data class InfoPrimaryLook(val label: String, val sub: String?, val state: CommandState, val reason: String?)

fun infoPrimaryLook(load: InfoLoad, kind: InfoPrimaryKind, label: String, sub: String?, state: CommandState, reason: String?, price: PriceUi?): InfoPrimaryLook =
    when (load) {
        InfoLoad.LOADING -> InfoPrimaryLook("Checking", null, CommandState.BUSY, null)
        InfoLoad.ERROR -> InfoPrimaryLook(label, null, CommandState.DISABLED, "waiting for the server")
        InfoLoad.READY -> {
            val drawn = infoDrawState(kind, state, price)
            val why = reason?.takeIf { it.isNotBlank() }
                ?: if (drawn == CommandState.DISABLED && price?.status == PriceStatus.UNAVAILABLE) "price unavailable right now" else null
            InfoPrimaryLook(label, sub, drawn, why)
        }
    }

/** Where a tap on the primary goes. BUSY never acts; an off or locked primary explains itself (never silent). */
fun infoPrimaryTap(load: InfoLoad, kind: InfoPrimaryKind, state: CommandState, price: PriceUi?): InfoTap = when {
    load == InfoLoad.LOADING -> InfoTap.NONE
    load == InfoLoad.ERROR -> InfoTap.EXPLAIN
    kind == InfoPrimaryKind.MAX -> InfoTap.NONE
    else -> when (infoDrawState(kind, state, price)) {
        CommandState.BUSY -> InfoTap.NONE
        CommandState.DISABLED, CommandState.LOCKED -> InfoTap.EXPLAIN
        CommandState.SHORT -> InfoTap.NEED_MORE
        CommandState.ENABLED -> if (kind == InfoPrimaryKind.FINISH) InfoTap.FINISH else InfoTap.UPGRADE
    }
}

/** True for a portrait icon (a troop / building / hero portrait) that the SPEC draws at 28 dp in a 2 dp ink frame; plain
 *  24 px icons draw bare at 24 dp. */
fun statIconFramed(icon: String): Boolean =
    icon.startsWith("ui_portrait_") || icon.startsWith("troop-") || icon.startsWith("building-") || icon.startsWith("hero_")

/** One stat as a screen reader hears it: "Hitpoints: 360, next level 430", "Hits flying troops: yes", "Range: 7 tiles". */
fun statSpoken(label: String, now: String?, next: String?, yesNo: Boolean?): String = when {
    yesNo != null -> "$label: ${if (yesNo) "yes" else "no"}"
    next != null -> "$label: ${now ?: UNKNOWN}, next level $next"
    else -> "$label: ${now ?: UNKNOWN}"
}
