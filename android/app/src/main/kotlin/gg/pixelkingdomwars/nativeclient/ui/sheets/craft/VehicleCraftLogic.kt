package gg.pixelkingdomwars.nativeclient.ui.sheets.craft

import gg.pixelkingdomwars.nativeclient.charter.CharterGrammar
import gg.pixelkingdomwars.nativeclient.charter.charterObject
import gg.pixelkingdomwars.nativeclient.charter.charterText
import gg.pixelkingdomwars.nativeclient.data.longValueExactCompat
import gg.pixelkingdomwars.nativeclient.model.marketSol
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.TabUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.phasee.islandShareResource
import gg.pixelkingdomwars.nativeclient.ui.phasee.islandShareTime
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.VehicleFamily
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.vehicleIdleArt
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import java.math.BigInteger
import java.util.Locale

/*
 * The pure rules of the designed vehicle crafting sheet (VehicleCraftSheet): the craft cluster's grammar (craft/SPEC.md
 * §1 CraftSheet, §2.1 RecipeCard / IngredientRow / one primary row, §2.7 TierPicker + PreviewCard) applied to the existing
 * read-only vehicle crafting owner (VehicleCraftRepository: quote, history, recover). It replaces the old dark
 * "VEHICLE RECIPE PREVIEW" plate. No Compose, JVM-tested in VehicleCraftLogicTest.
 *
 * Money honesty: every number (odds, application fee, required / available / held) comes from the server's quote or
 * saved record; nothing is computed or guessed here. New vehicle crafting is not offered by the server ABI (every
 * capability flag is false), so the craft primary is honestly off with that reason; the check and the original outcome
 * recovery are the only verbs, both reads.
 */

/** The sheet's two tabs (side by side, like the Harvester: SPEC 0.1 keeps stacked tabs for four). */
object VehicleCraftTab {
    const val CRAFT = "CRAFT"
    const val HISTORY = "HISTORY"
}

fun vehicleCraftTabs(): List<TabUi> = listOf(
    TabUi(VehicleCraftTab.CRAFT, "ui:workshop-menu", "CRAFT", null, false),
    TabUi(VehicleCraftTab.HISTORY, "replay", "HISTORY", null, false),
)

/** The server's crafting item id for the Divine Isle fragment (VehicleCraftProtocol `leaf`). */
private const val FRAGMENT_ID = "crystal_fragment"

/** Existing status sentences reused by the sheet (moved verbatim from VehicleCraftPanel; no new risk wording). */
const val VEHICLE_PREVIEW_LINE = "Choose a family and target tier to check the selected kingdom's ingredients. A preview does not hold or spend anything."
const val VEHICLE_NOT_QUOTED_LINE = "Oracle, account rent and network costs are not quoted. The application fee is not a complete total."
const val VEHICLE_OUTCOME_LINE = "An ordinary unsuccessful result consumes its original materials. A pending result stays held."
const val VEHICLE_NO_BASE_LINE = "Select an owned kingdom to check available ingredients."
const val VEHICLE_NO_CATALOGUE_LINE = "Vehicle recipe selection needs the current content catalogue."
const val VEHICLE_HISTORY_LINE = "Saved outcomes keep their original kingdom, materials and selected vehicle. Changing kingdoms cannot move them."
const val VEHICLE_MINTED_LINE = "Check owned assets in INSTALL to verify current ownership and choose a berth."
const val VEHICLE_UNAVAILABLE_LINE = "Vehicle crafting history is unavailable."
/** The craft primary's reason: the server ABI offers no new vehicle crafting (VehicleCraftPanel's sentence, pointing at the
 *  HISTORY tab instead of "below"). */
const val VEHICLE_CRAFT_OFF_LINE = "New vehicle crafting is unavailable. Original outcomes can still be checked in HISTORY."

/** "Survey Balloon" for "survey_balloon". */
fun vehicleFamilyName(family: String): String = islandShareResource(family)

/** The voyage art family of a server family id; null for an id the art does not cover. */
fun vehicleFamilyArt(family: String): VehicleFamily? = when (family) {
    "survey_balloon" -> VehicleFamily.SURVEY_BALLOON
    "cargo_cutter" -> VehicleFamily.CARGO_CUTTER
    "courier_airship" -> VehicleFamily.COURIER_AIRSHIP
    "expedition_barge" -> VehicleFamily.EXPEDITION_BARGE
    else -> null
}

/** The vehicle's authored idle sprite (`voyage:veh-<family>-t<n>`), or the visible "?" glyph for an unknown family. */
fun vehicleCraftArt(family: String, tier: Long?): String =
    vehicleFamilyArt(family)?.let { vehicleIdleArt(it, tier?.coerceIn(1L, 4L)?.toInt()) } ?: "shape:unknown"

/** A recipe input's icon: the fragment uses the bundled crystal fragments, refined items the craft inventory art. */
fun vehicleIngredientIcon(itemId: String): String =
    if (itemId == FRAGMENT_ID) "ui:crystal-fragments" else craftItemIcon(itemId)

/** True for an input the Workshop refines (a GO can open REFINE for it); the Divine Isle fragment is not refined. */
fun vehicleIngredientRefinable(itemId: String): Boolean = itemId != FRAGMENT_ID

/** "SURVEY BALLOON T2". */
fun vehicleCraftTitle(family: String, tier: Long?): String =
    "${vehicleFamilyName(family).uppercase(Locale.US)} T${tier ?: UNKNOWN_TIER}"

private const val UNKNOWN_TIER = "…"

/** A server amount as a Long; null when it is not a decimal that fits (never a guessed 0). */
private fun amountOrNull(value: String): Long? = runCatching { BigInteger(value).longValueExactCompat() }.getOrNull()

/** The checked recipe of the current selection, as the sheet shows it. */
data class VehicleQuoteUi(
    /** "45%" (the server's basis points, exact). */
    val odds: String,
    /** "0.05 SOL" (the server's application fee). */
    val fee: String,
    /** "6 Oct 2026, 10:00 UTC" (the server's time of the check). */
    val checkedAt: String,
    /** One "YOU NEED" row per recipe input: have = available, need = required. */
    val lines: List<IngredientLine>,
) {
    /** True when every input is available. */
    val ready: Boolean get() = lines.isNotEmpty() && lines.all { it.ok }
}

/**
 * The quote for exactly ([baseId], [family], [tier]); null when there is none, it belongs to another selection, or a
 * field cannot be read (the protocol already validated it; a read failure shows nothing rather than a wrong number).
 */
fun vehicleQuoteUi(quote: JsonObject?, baseId: String?, family: String, tier: Long?): VehicleQuoteUi? = runCatching {
    if (quote == null || baseId == null || tier == null) return@runCatching null
    val recipe = quote.charterObject("recipe")
    if (quote.charterText("baseId") != baseId || recipe.charterText("family") != family ||
        CharterGrammar.number(recipe.getValue("tier")) != tier) return@runCatching null
    val odds = CharterGrammar.number(recipe.getValue("oddsBps")).toBigDecimal().movePointLeft(2).stripTrailingZeros().toPlainString() + "%"
    val fee = marketSol(quote.charterText("applicationFeeLamports")) + " SOL"
    val lines = quote.getValue("ingredients").jsonArray.map { raw ->
        val row = raw.jsonObject
        val itemId = row.charterText("itemId")
        val need = requireNotNull(amountOrNull(row.charterText("required")))
        val have = amountOrNull(row.charterText("available"))
        val held = amountOrNull(row.charterText("held")) ?: 0L
        val source = when {
            held > 0L -> "${groupDigits(held)} held in original crafting"
            row.charterText("kind") == "refined" -> "Refined at the Workshop"
            else -> ""
        }
        IngredientLine(itemId, vehicleIngredientIcon(itemId), islandShareResource(itemId), source, have, need,
            have?.let { (need - it).coerceAtLeast(0L) }, null)
    }
    VehicleQuoteUi(odds, fee, islandShareTime(quote.charterText("serverNow")), lines)
}.getOrNull()

/** Why the sheet cannot check yet: no catalogue tiers, then no selected kingdom; null when it can. */
fun vehicleCheckBlocked(selectedBase: String?, tiers: List<Long>): String? = when {
    tiers.isEmpty() -> VEHICLE_NO_CATALOGUE_LINE
    selectedBase == null -> VEHICLE_NO_BASE_LINE
    else -> null
}

/**
 * The CRAFT tab's one primary. A blocked check is off with its reason; a running check is busy; without a quote the
 * primary is the blue CHECK INGREDIENTS (a read: blue = info, it spends nothing); with a quote it is the honest, off
 * CRAFT VEHICLE (the server offers no new vehicle crafting), its sub carrying the server's chance.
 */
fun vehicleCraftPrimary(selectedBase: String?, tiers: List<Long>, busy: Boolean, quote: VehicleQuoteUi?, family: String,
    tier: Long?): CraftPrimaryUi {
    val sub = "${vehicleFamilyName(family)} T${tier ?: UNKNOWN_TIER}"
    vehicleCheckBlocked(selectedBase, tiers)?.let { return offPrimary("CHECK INGREDIENTS", null, it) }
    return when {
        busy -> busyPrimary(CHECKING_TEXT)
        quote == null -> CraftPrimaryUi("CHECK INGREDIENTS", sub, CommandState.ENABLED, Verb.BLUE, null, null, PrimaryAction.START)
        else -> offPrimary("CRAFT VEHICLE", "$sub · ${quote.odds} chance", VEHICLE_CRAFT_OFF_LINE)
    }
}

/** The header's live chip. */
fun vehicleCraftLive(busy: Boolean, quote: VehicleQuoteUi?): CraftLiveUi = when {
    busy -> CraftLiveUi("timer", CHECKING_TEXT)
    quote != null -> CraftLiveUi("ui:ready-status", "Chance", quote.odds, ready = quote.ready)
    else -> CraftLiveUi("ui:workshop-menu", "Choose a vehicle")
}

/** One saved original crafting record on the HISTORY tab. */
data class VehicleCraftRecordUi(
    /** The idempotency key handed back to CHECK (recover). */
    val key: String,
    val art: String,
    /** "SURVEY BALLOON T2". */
    val title: String,
    /** The short state tag and its colour. */
    val tag: String,
    val tagVerb: Verb,
    /** The existing status sentence ("MATERIALS HELD"). */
    val status: String,
    /** "Reserved 6 Oct 2026, 10:00 UTC". */
    val reserved: String,
    /** "Frostglass 4 · Crystal Fragment 1". */
    val inputs: String,
    /** The minted next step, or null. */
    val note: String?,
    /** Sort key: the server's reservation time. */
    val reservedAt: String,
)

/** The saved status sentence (VehicleCraftPanel's `vehicleCraftStatus` wording, kept here so this sheet does not depend on
 *  the old panel's file); an unknown status reads as unknown instead of failing the row. */
private fun recordStatus(status: String): String = when (status) {
    "held" -> "MATERIALS HELD"
    "paid_loss" -> "UNSUCCESSFUL · MATERIALS CONSUMED"
    "won_unminted" -> "WON · NFT MINT PENDING"
    "minted" -> "NFT MINT CONFIRMED"
    else -> "UNKNOWN STATUS"
}

private fun recordTag(status: String): Pair<String, Verb> = when (status) {
    "held" -> "HELD" to Verb.STONE
    "paid_loss" -> "UNSUCCESSFUL" to Verb.RED
    "won_unminted" -> "WON" to Verb.GOLD
    "minted" -> "MINTED" to Verb.GREEN
    else -> "UNKNOWN" to Verb.STONE
}

/** The saved records, newest first; a record that cannot be read is left out rather than drawn with guessed values. */
fun vehicleCraftRecords(records: List<JsonObject>): List<VehicleCraftRecordUi> = records.mapNotNull { record ->
    runCatching {
        val identity = record.charterObject("identity")
        val family = identity.charterText("family")
        val tier = CharterGrammar.number(identity.getValue("tier"))
        val status = record.charterText("status")
        val (tag, verb) = recordTag(status)
        val inputs = record.charterObject("recipe").getValue("inputs").jsonArray.joinToString(" · ") {
            val input = it.jsonObject
            "${islandShareResource(input.charterText("itemId"))} ${input.charterText("quantity")}"
        }
        val reservedAt = record.charterText("reservedAt")
        VehicleCraftRecordUi(record.charterText("idempotencyKey"), vehicleCraftArt(family, tier), vehicleCraftTitle(family, tier),
            tag, verb, recordStatus(status), "Reserved ${islandShareTime(reservedAt)}", inputs,
            if (status == "minted") VEHICLE_MINTED_LINE else null, reservedAt)
    }.getOrNull()
}.sortedByDescending { it.reservedAt }
