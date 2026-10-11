package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.content.ContentFile
import gg.pixelkingdomwars.nativeclient.network.string
import kotlinx.serialization.json.*
import java.security.MessageDigest

internal data class WorldContentGroup(val id: String, val files: List<ContentFile>) {
    // A code/ground release cannot invalidate unchanged optional pixels. Each group owns an
    // independent active/previous pointer, so installing one region never prunes another region.
    val identity: String = worldContentHash(buildJsonObject {
        put("version", 1); put("id", id)
        put("files", buildJsonArray { files.sortedBy { it.path }.forEach { file -> add(buildJsonObject {
            put("path", file.path); put("sha256", file.sha256); put("size", file.size)
        }) } })
    })
}

internal fun worldContentHash(value: JsonObject): String = MessageDigest.getInstance("SHA-256")
    .digest(value.toString().toByteArray()).joinToString("") { "%02x".format(it) }

/** Old catalogues already pin every byte and supply the same source IDs. Derive their groups
 * identically; new explicit grouping is checked against that contract, never trusted as new pins. */
internal fun worldContentGroups(fantasy: JsonObject): List<WorldContentGroup> {
    val globe = fantasy.getValue("globe").jsonObject
    val files = globe.getValue("files").jsonArray.map { element ->
        val file = element.jsonObject
        ContentFile(requireNotNull(file.string("path")), requireNotNull(file.string("sha256")), file.getValue("size").jsonPrimitive.long)
    }
    require(files.isNotEmpty() && files.map { it.path }.distinct().size == files.size)
    require(files.all { it.path.startsWith("atlas/fantasy/globe/") })
    val byPath = files.associateBy { it.path }
    val used = mutableSetOf<String>()
    val presentation = fantasy.getValue("presentation").jsonObject
    fun collect(key: String, kind: String, suffixes: List<String>): List<WorldContentGroup> =
        (presentation[key] as? JsonArray).orEmpty().map { value ->
            val id = requireNotNull(value.jsonObject.string("id"))
            require(id.matches(Regex("[a-z][a-z0-9-]*"))) { "Invalid world group" }
            WorldContentGroup("$kind-$id", suffixes.map { suffix ->
                val path = "atlas/fantasy/globe/generated/$id$suffix"
                require(used.add(path)) { "World group overlaps" }
                requireNotNull(byPath[path]) { "Incomplete world group: $kind-$id" }
            })
        }
    val regions = collect("regionalDetails", "region", listOf("-detail.png"))
    val chains = collect("chains", "chain", listOf("-detail.png", "-detail-mask.png"))
    val overview = WorldContentGroup("overview", files.filter { it.path !in used })
    require(overview.files.isNotEmpty()) { "World overview is missing" }
    val groups = listOf(overview) + regions + chains
    require(groups.map { it.id }.distinct().size == groups.size)
    globe["groups"]?.let { raw ->
        val explicit=requireNotNull(raw as? JsonObject) { "Invalid world grouping" }
        require(explicit["version"]?.jsonPrimitive?.intOrNull == 1) { "Unsupported world grouping" }
        val entries = listOf(explicit.getValue("overview").jsonObject) +
            explicit.getValue("regions").jsonArray.map { it.jsonObject } + explicit.getValue("chains").jsonArray.map { it.jsonObject }
        val claimed = entries.map { entry -> requireNotNull(entry.string("id")) to entry.getValue("files").jsonArray.map { it.jsonPrimitive.content } }
        require(claimed == groups.map { it.id to it.files.map(ContentFile::path) }) { "World grouping disagrees with pinned presentation" }
    }
    return groups
}
