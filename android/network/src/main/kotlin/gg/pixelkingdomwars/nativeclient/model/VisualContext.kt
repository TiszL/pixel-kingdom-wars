package gg.pixelkingdomwars.nativeclient.model

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull

/** Realm, historical generation and optional additive ground revision on base, raid, replay,
 * preview and scout payloads (source `packages/shared/src/baseVisual.ts`). */
@Serializable data class VisualContext(val version: Int, val realmId: String, val artVersion: Int, val groundRevision: Int? = null) {
    init { require(version >= 1 && realmId.isNotBlank() && artVersion >= 1) }
    fun describe(): String = "visualContext(version=$version, realm=$realmId, art=v$artVersion${groundRevision?.let { ", groundRevision=$it" } ?: ""})"

    companion object {
        /** Reads the optional context from a DTO; malformed data is refused rather than guessed. */
        fun of(raw: JsonObject?): VisualContext? {
            val value = raw?.get("visualContext") as? JsonObject ?: return null
            val version = (value["version"] as? JsonPrimitive)?.intOrNull
            val realm = (value["realmId"] as? JsonPrimitive)?.contentOrNull
            val art = (value["artVersion"] as? JsonPrimitive)?.intOrNull
            require(version != null && realm != null && art != null) { "Malformed visualContext" }
            // Unknown additive revisions retain the known realm/generation in the renderer, as on web.
            val revision = (value["groundRevision"] as? JsonPrimitive)?.takeUnless { it.isString }?.intOrNull
            return VisualContext(version, realm, art, revision)
        }
    }
}
