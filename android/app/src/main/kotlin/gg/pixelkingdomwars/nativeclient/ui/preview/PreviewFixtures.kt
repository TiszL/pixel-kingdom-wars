package gg.pixelkingdomwars.nativeclient.ui.preview

import gg.pixelkingdomwars.nativeclient.network.objects
import gg.pixelkingdomwars.nativeclient.network.string
import java.time.Instant
import kotlinx.serialization.json.*

/** Debug-only decoration of the offline base fixture (`--es preview base` plus `--es previewRealm
 * frostveil --ei previewArt 2 --ez previewWalls true --ez previewJob true`), so the composed five-tier
 * walls, the Builder Workman and a realm ground can be photographed without an account, network
 * gameplay or spending. Nothing here is player data; it never reaches an account session. */
data class PreviewOptions(val realm: String? = null, val artVersion: Int? = null, val walls: Boolean = false, val job: Boolean = false,
    /** `--es previewArmy partial|training|full|over`: two camps, two barracks and a synthetic `armyStatus`, so every
     * army-chip state can be photographed over the pack's current terrain without training a real troop.
     * Explicit previewRealm/previewArt flags retain the historical-art preview behavior. */
    val army: String? = null) {
    val active: Boolean get() = realm != null || walls || job || army != null
    companion object {
        @Volatile var current = PreviewOptions()
        val ARMY_STATES = setOf("partial", "training", "full", "over")
        fun fromExtras(realm: String?, artVersion: Int, walls: Boolean, job: Boolean, army: String? = null) =
            PreviewOptions(realm?.takeIf { it.isNotBlank() }, artVersion.takeIf { it > 0 }, walls, job, army?.takeIf { it in ARMY_STATES })
    }
}

object PreviewFixtures {
    const val JOB_ID = "preview-job"
    /** The preview job starts a little after decoration so the Workman's 1.2 s walk from the Keep gate
     * is still ahead once the offline scene has loaded; the timer chip is not part of the preview. */
    const val JOB_DELAY_MS = 8_000L
    /** Synthetic presentation health for the damaged preview walls: the fractions sit just under the
     * catalogue's light/heavy thresholds; the renderer never reads a threshold from here. */
    private const val PREVIEW_MAX_HP = 1000L

    /** Returns the decorated fixture plus the `buildingHealth` rows the mapper accepts. */
    fun decorate(base: JsonObject, renderCatalogue: JsonObject, options: PreviewOptions, nowMs: Long): Pair<JsonObject, List<JsonObject>> {
        if (!options.active) return base to emptyList()
        val fields = base.toMutableMap()
        val health = mutableListOf<JsonObject>()
        if (options.army != null && options.realm == null && options.artVersion == null) {
            // The bundled simulation fixture predates visualContext. Leaving it absent silently selected legacy
            // Crownlands v1, making current UI evidence look like a terrain regression. Preserve the full declared
            // current context, including its groundRevision; never infer a revision from an art-version number.
            fields["visualContext"] = requireNotNull((renderCatalogue["ground"] as? JsonObject)?.get("currentVisual") as? JsonObject) {
                "The content pack does not declare current terrain for the army preview"
            }
        }
        options.realm?.let { realm ->
            fields["visualContext"] = buildJsonObject { put("version", 1); put("realmId", realm); put("artVersion", options.artVersion ?: 2) }
        }
        val buildings = base.objects("buildings").toMutableList()
        if (options.walls) {
            val walls5 = requireNotNull(renderCatalogue["walls5"] as? JsonObject) { "The bundled pack has no walls5 section to preview" }
            val constants = requireNotNull(walls5["constants"] as? JsonObject)
            val tiers = requireNotNull(constants.string("tiers")).toInt(); val levelsPerTier = requireNotNull(constants.string("levelsPerTier")).toInt()
            val stages = requireNotNull(walls5["damageStages"] as? JsonObject)
            val light = requireNotNull((stages["light"] as? JsonObject)?.string("below")).toDouble()
            val heavy = requireNotNull((stages["heavy"] as? JsonObject)?.string("below")).toDouble()
            val occupied = buildings.map { it.string("tx")!!.toInt() to it.string("ty")!!.toInt() }.toSet()
            // One continuous rampart along the south of the fixture: three cells per tier, the second
            // lightly and the third heavily damaged, ending in a corner so every shoulder kind appears.
            val row = 16; val startX = 2
            fun wall(id: String, x: Int, y: Int, level: Int) {
                require((x to y) !in occupied) { "Preview wall overlaps fixture building at $x,$y" }
                buildings += buildJsonObject { put("id", id); put("type", "wall"); put("level", level); put("tx", x); put("ty", y); put("underConstruction", false) }
            }
            for (tier in 1..tiers) {
                val level = (tier - 1) * levelsPerTier + 1
                for (slot in 0 until 3) {
                    val x = startX + (tier - 1) * 3 + slot
                    val id = "preview-wall-t$tier-$slot"
                    wall(id, x, row, level)
                    val fraction = when (slot) { 1 -> light * 0.8; 2 -> heavy * 0.8; else -> 1.0 }
                    if (fraction < 1.0) health += buildJsonObject { put("id", id); put("initialHp", (PREVIEW_MAX_HP * fraction).toLong()); put("maxHp", PREVIEW_MAX_HP) }
                }
            }
            val endX = startX + tiers * 3 - 1; val topLevel = (tiers - 1) * levelsPerTier + 1
            wall("preview-wall-corner-1", endX, row - 1, topLevel); wall("preview-wall-corner-2", endX, row - 2, topLevel)
            wall("preview-wall-tee", startX + 4, row - 1, levelsPerTier + 1)
        }
        options.army?.let { army ->
            fun add(id: String, type: String, level: Int, x: Int, y: Int) { buildings += buildJsonObject { put("id", id); put("type", type); put("level", level); put("tx", x); put("ty", y); put("underConstruction", false) } }
            add("preview-camp", "camp", 6, 12, 4); add("preview-camp-2", "camp", 1, 15, 4)
            add("preview-barracks", "barracks", 6, 5, 12); add("preview-barracks-2", "barracks", 1, 5, 14)
            // A first deed's claim, so the default zoom is the claim fit a player opens Home at.
            fields["baseId"] = JsonPrimitive("preview-base"); fields["claim"] = buildJsonObject { put("min", 1); put("max", 19) }
            fields["player"] = buildJsonObject { put("keepLevel", requireNotNull(base.string("keepLevel")).toInt()) }
            val (ready, training) = when (army) { "training" -> 42 to 18; "full" -> 90 to 18; "over" -> 112 to 0; else -> 42 to 0 }
            fields["armyStatus"] = buildJsonObject {
                put("readyTroopCount", ready / 6); put("readyPts", ready); put("campCapacityPts", 108)
                put("trainingTroopCount", training / 6); put("trainingPts", training); put("barracksQueuePts", 65)
                put("allReadyAt", if (training > 0) JsonPrimitive(Instant.ofEpochMilli(nowMs + (if (army == "full") 93_600_000L else 252_000L)).toString()) else JsonNull)
            }
        }
        fields["buildings"] = JsonArray(buildings)
        if (options.job) {
            val target = buildings.firstOrNull { it.string("type") == "mine" } ?: buildings.first { it.string("type") != "keep" }
            val jobs = base.objects("jobs").toMutableList()
            jobs += buildJsonObject {
                put("id", JOB_ID); put("kind", "upgrade"); put("buildingId", requireNotNull(target.string("id"))); put("obstacleId", JsonNull)
                put("startedAt", Instant.ofEpochMilli(nowMs + JOB_DELAY_MS).toString()); put("finishesAt", Instant.ofEpochMilli(nowMs + JOB_DELAY_MS + 10 * 60_000L).toString())
            }
            fields["jobs"] = JsonArray(jobs)
        }
        return JsonObject(fields) to health
    }
}
