package gg.pixelkingdomwars.nativeclient.boundcosmetics

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

/** Prospective original appearance only. The separate versioned sidecar represents
 * legacy absence explicitly; unavailable and a captured off selection are distinct. */
@Serializable data class BoundCosmeticWakeVisual(val version: Int, val wake: BoundCosmeticAppearance?) {
    fun validate() {
        require(version == 1)
        wake?.let { it.validate(); require(it.outputId == "aurora_wake") }
    }
}
@Serializable data class BoundCosmeticWakeRead(val state: String, val visual: BoundCosmeticWakeVisual?) {
    fun validate() {
        when (state) {
            "available" -> requireNotNull(visual).validate()
            "unavailable" -> require(visual == null)
            else -> error("Unknown expedition Wake projection")
        }
    }
    companion object {
        fun from(raw: JsonElement) = cosmeticDecode(raw, serializer()).also { it.validate() }
    }
}
