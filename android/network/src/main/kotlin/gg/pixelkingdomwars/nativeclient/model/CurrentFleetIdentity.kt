package gg.pixelkingdomwars.nativeclient.model

import java.util.Collections
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** The current installed identity of ONE berth: the real installed reservation id, the wire family and the exact tier (null = starter). */
data class CurrentFleetInstallation(val berthId: String, val installationId: String, val family: String, val tier: Int?)

/** CONTINUITY: strict current-only identity of every installed berth in ONE `/base` body — the starter from `starterFleet.installation`,
 *  advanced craft from the `advancedFleetIdentity` sibling — each validated against the SAME response's visual facts. Null means unknown
 *  (absent, malformed, partial, duplicate, cross-family or contradictory): continuity is refused while ordinary base/HUD reads succeed.
 *  Never derived from frozen battle facts, events or any other endpoint. */
class CurrentFleetIdentity private constructor(val installations: List<CurrentFleetInstallation>) {
    fun installation(berthId: String): CurrentFleetInstallation? = installations.singleOrNull { it.berthId == berthId }

    companion object {
        private val UUID = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
        fun current(raw: JsonObject, baseId: String?, starter: BaseServicePresentation?, advanced: AdvancedServicePresentation?): CurrentFleetIdentity? =
            runCatching { parse(raw, requireNotNull(baseId), starter, advanced) }.getOrNull()

        private fun text(value: JsonElement?): String = requireNotNull((value as? JsonPrimitive)?.takeIf { it.isString }?.content)
        private fun uuid(value: JsonElement?): String = text(value).also { require(UUID.matches(it)) { "Not an installation identity" } }
        private fun parse(raw: JsonObject, baseId: String, starter: BaseServicePresentation?, advanced: AdvancedServicePresentation?): CurrentFleetIdentity {
            val rows = ArrayList<CurrentFleetInstallation>()
            val starterOccupied = starter?.berths?.filter { it.installation != null } ?: emptyList()
            val installed = (raw["starterFleet"] as? JsonObject)?.get("installation")?.takeIf { it !is JsonNull }
            if (installed != null) {
                val row = requireNotNull(installed as? JsonObject)
                val id = uuid(row["installationId"]); val berth = uuid(row["berthId"])
                require(text(row["baseId"]) == baseId && text(row["family"]) == "starter") { "Starter identity belongs elsewhere" }
                val visual = requireNotNull(starterOccupied.singleOrNull()) { "Starter identity without its single visual berth" }
                require(visual.buildingId == berth && visual.installation?.family == "starter") { "Starter identity contradicts its visual facts" }
                rows += CurrentFleetInstallation(berth, id, "starter", null)
            } else require(starterOccupied.isEmpty()) { "Occupied starter berth without its identity" }
            val identity = raw["advancedFleetIdentity"]
            val visualBerths = advanced?.berths
            if (identity != null && identity !is JsonNull) {
                val obj = requireNotNull(identity as? JsonObject)
                require(obj.keys == setOf("version", "berths") && obj["version"] == JsonPrimitive(1)) { "Unsupported advanced identity" }
                val berths = requireNotNull(obj["berths"] as? JsonArray); val visual = requireNotNull(visualBerths) { "Advanced identity without its appearance" }
                require(berths.size == visual.size) { "Advanced identity differs from its appearance" }
                berths.forEachIndexed { index, element ->
                    val row = requireNotNull(element as? JsonObject); require(row.keys == setOf("buildingId", "installation"))
                    val berth = uuid(row["buildingId"]); val sibling = visual[index]; require(sibling.buildingId == berth) { "Advanced identity berth order differs" }
                    val installation = row["installation"]
                    if (installation == null || installation is JsonNull) { require(sibling.installation == null) { "Identity null where the appearance is installed" }; return@forEachIndexed }
                    val fields = requireNotNull(installation as? JsonObject); require(fields.keys == setOf("installationId", "family", "tier"))
                    val appearance = requireNotNull(sibling.installation) { "Identity where the appearance is empty" }
                    val family = text(fields["family"]); val tier = requireNotNull((fields["tier"] as? JsonPrimitive)?.takeIf { !it.isString }?.content?.toIntOrNull())
                    require(family != "starter" && family == appearance.family && tier == appearance.tier) { "Advanced identity contradicts its appearance" }
                    rows += CurrentFleetInstallation(berth, uuid(fields["installationId"]), family, tier)
                }
            } else require(visualBerths == null || visualBerths.all { it.installation == null }) { "Installed advanced berth without its identity" }
            require(rows.map { it.berthId }.toSet().size == rows.size) { "One berth cannot hold two installations" }
            require(rows.map { it.installationId }.toSet().size == rows.size) { "One installation cannot occupy two berths" }
            return CurrentFleetIdentity(Collections.unmodifiableList(rows))
        }
    }
}
