package gg.pixelkingdomwars.nativeclient.ui.sheets.craft.live

import gg.pixelkingdomwars.nativeclient.model.VisualContext
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull

/*
 * The header-art inputs of the craft sheets (craft/SPEC.md §2 "Header sprite", §4 Harvester header). Both come from the
 * server: the tier from the exported catalogue's `constants.ART_V2` level mapping (the rule the scene mapper and the
 * construction-art admission already require), the harvester key from the selected base's `visualContext`. Nothing is
 * guessed or remapped: a missing or malformed input is null, and the sprite lookups already fail closed on null.
 */

/** The art tier of a building at [level]: min(tiers, (level − 1) / levelsPerTier + 1), with `tiers` and `levelsPerTier`
 *  read from `constants.ART_V2` of the admitted [catalogue]. Null when the level is below 1 or the mapping is missing or
 *  not a positive whole number (never a tier-one default). */
internal fun craftBuildingArtTier(catalogue: JsonObject?, level: Int?): Int? {
    if (level == null || level < 1) return null
    val constants = catalogue?.get("constants") as? JsonObject ?: return null
    val art = constants["ART_V2"] as? JsonObject ?: return null
    val tiers = positiveWhole(art["tiers"]) ?: return null
    val levelsPerTier = positiveWhole(art["levelsPerTier"]) ?: return null
    return minOf(tiers, (level - 1) / levelsPerTier + 1)
}

/** The Harvester header's art key: the selected base's `visualContext.realmId`, exactly as sent. A malformed context is
 *  null. No realm alias is applied here; `harvesterSprite` draws nothing for a key the bundled art does not cover. */
internal fun harvesterHeaderArtKey(baseRaw: JsonObject?): String? =
    try { VisualContext.of(baseRaw)?.realmId } catch (_: IllegalArgumentException) { null }

/** A JSON number (not a string) that is a whole number above zero. */
private fun positiveWhole(value: JsonElement?): Int? =
    (value as? JsonPrimitive)?.takeUnless { it.isString }?.intOrNull?.takeIf { it > 0 }
