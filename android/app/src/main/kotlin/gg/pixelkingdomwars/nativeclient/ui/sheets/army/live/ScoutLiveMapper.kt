package gg.pixelkingdomwars.nativeclient.ui.sheets.army.live

import gg.pixelkingdomwars.nativeclient.data.CampaignPreview
import gg.pixelkingdomwars.nativeclient.data.ScoutPreview
import gg.pixelkingdomwars.nativeclient.data.TargetScout
import gg.pixelkingdomwars.nativeclient.network.isTrapType
import gg.pixelkingdomwars.nativeclient.network.string
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.SCOUT_NO_WALLS
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.ScoutSource
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.ScoutUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.TargetUi
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject

/** Same permission as the existing ScoutScreen button, also usable at the callback boundary. */
internal fun scoutLiveCanAttack(preview: ScoutPreview, current: ScoutPreview?, busy: Boolean, loading: Boolean,
    secondsLeft: Int?): Boolean = current === preview && !busy && !loading &&
    (preview.previewSec == null || (secondsLeft != null && secondsLeft > 0)) &&
    (preview as? TargetScout)?.attackUnavailable == null

/** Projects only the displayed owner's snapshot. Scene, countdown, orders and saved-create recovery stay outside. */
internal fun scoutLiveUi(preview: ScoutPreview, current: ScoutPreview?, catalogue: JsonObject?, busy: Boolean,
    loading: Boolean, secondsLeft: Int?): ScoutUi {
    val raw = preview.head.raw
    val snapshot = if (preview is CampaignPreview) raw["snapshot"] as? JsonObject else raw
    val buildings = scoutBuildings(snapshot)
    val reason = when {
        current !== preview -> "This preview was closed or replaced. Scout the target again."
        preview.previewSec != null && (secondsLeft == null || secondsLeft <= 0) -> "This preview has expired. Scout the target again."
        else -> (preview as? TargetScout)?.attackUnavailable
    }
    val state = when {
        reason != null -> CommandState.DISABLED
        busy || loading -> CommandState.BUSY
        else -> CommandState.ENABLED
    }
    return ScoutUi(
        target = TargetUi(preview.title.ifBlank { "Unknown target" },
            preview.keepLevel?.takeIf { it > 0 }?.let { "Lv $it" } ?: "Lv $UNKNOWN",
            crest = null,
            // ScoutReport's legacy parser defaults missing trophies to zero; the raw presence is authoritative.
            trophies = if (preview is TargetScout) groupedAmount(raw.string("trophies")) ?: UNKNOWN else UNKNOWN,
            clan = null),
        // These facts are absent from the current ScoutReport contract. No mock amounts, inferred shield or cost: the
        // overlay then draws no loot plate, no stakes chip and no shield tag (scoutLootVisible / scoutShieldTag).
        lootable = null, trophiesWin = null, trophiesLose = null, shielded = null,
        defences = scoutDefenceCount(buildings, catalogue), wallLevel = scoutWallLevel(buildings),
        // The scene supplies no current building-foot projection or tap-name callback; never fake screen anchors.
        tags = emptyList(), showHint = false, skip = null,
        source = if (preview is CampaignPreview) ScoutSource.CAMPAIGN else ScoutSource.MAP,
        attack = liveCommand(FeatureId("scout.attack"), "ATTACK",
            state, reason, verb = Verb.RED, icon = "attack"),
        home = liveCommand(FeatureId("scout.home"), "HOME", CommandState.ENABLED, primary = false,
            verb = Verb.STONE, icon = "shape:close"),
    )
}

private fun scoutBuildings(snapshot: JsonObject?): List<JsonObject>? {
    val rows = snapshot?.get("buildings") as? JsonArray ?: return null
    return rows.map { row ->
        val building = row as? JsonObject ?: return null
        if (building.string("type").isNullOrBlank()) return null
        building
    }
}

private fun scoutDefenceCount(buildings: List<JsonObject>?, catalogue: JsonObject?): Int? {
    buildings ?: return null
    catalogue ?: return null
    val definitions = (catalogue["constants"] as? JsonObject)?.get("DEFENSES") as? JsonObject ?: return null
    return buildings.count { building ->
        val type = building.string("type") ?: return null
        type in definitions && !isTrapType(catalogue, type)
    }
}

/** "LV 5" / "LV 3–5" from the response's walls; [SCOUT_NO_WALLS] when the layout was sent and has none (a fact, so the
 *  info plate says "no walls" instead of a "…" that never fills); null for an absent or malformed layout. */
private fun scoutWallLevel(buildings: List<JsonObject>?): String? {
    val walls = buildings?.filter { it.string("type") == "wall" } ?: return null
    if (walls.isEmpty()) return SCOUT_NO_WALLS
    val levels = walls.map { it.string("level")?.toIntOrNull()?.takeIf { level -> level > 0 } ?: return null }
    val first = levels.minOrNull() ?: return null
    val last = levels.maxOrNull() ?: return null
    return if (first == last) "LV $first" else "LV $first–$last"
}
