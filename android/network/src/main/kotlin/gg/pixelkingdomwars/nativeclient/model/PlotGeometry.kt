package gg.pixelkingdomwars.nativeclient.model

import kotlinx.serialization.json.*

/** Source PLOT_GEOMETRY: plot extents are independent of footprints, combat and artwork.
 * A missing version is historical geometry, never the current catalogue default. */
data class PlotGeometry(val version: Int, val min: Int, val max: Int) {
    val size: Int get() = Math.subtractExact(max, min)
    init { require(version in 1..2 && max > min); Math.subtractExact(max, min) }
    fun contains(x: Int, y: Int, width: Int = 1, height: Int = 1): Boolean =
        width > 0 && height > 0 && x >= min && y >= min && x.toLong() + width <= max && y.toLong() + height <= max
    val json: JsonObject get() = buildJsonObject { put("version", version); put("min", min); put("max", max) }
    companion object {
        private val supported by lazy { Json.parseToJsonElement(requireNotNull(PlotGeometry::class.java.classLoader!!.getResourceAsStream("plot-geometry.json")).bufferedReader().use { it.readText() }).jsonObject }
        fun supported(version: Int): PlotGeometry {
            require(version in 1..2) { "Update the app to use this plot" }
            val bounds = supported.getValue("boundsByVersion").jsonObject.getValue(version.toString()).jsonObject
            return PlotGeometry(version, integer(bounds, "min"), integer(bounds, "max"))
        }
        fun from(catalogue: JsonObject, version: Int? = null): PlotGeometry {
            val constants = requireNotNull(catalogue["constants"] as? JsonObject)
            val v = version ?: 1
            require(v in 1..2) { "Update the app to use this plot" }
            val policy = constants["PLOT_GEOMETRY"] as? JsonObject
            if (policy == null) {
                require(v == 1) { "The content pack does not support this plot" }
                return supported(v).also { require(it.min == 0 && it.size == integer(requireNotNull(constants["GRID"] as? JsonObject), "plotTiles")) }
            }
            require(integer(policy, "legacyVersion") == 1 && integer(policy, "currentVersion") == 2)
            val bounds = requireNotNull((policy["boundsByVersion"] as? JsonObject)?.get(v.toString()) as? JsonObject)
            return supported(v).also { require(it.min == integer(bounds, "min") && it.max == integer(bounds, "max")) { "Unsupported plot bounds" } }
        }
        /** An encrypted original intent carries its original bounds; today's content must not reinterpret it. */
        fun saved(raw: JsonObject): PlotGeometry {
            require(raw.keys == setOf("version", "min", "max"))
            return supported(integer(raw, "version")).also { require(it.min == integer(raw, "min") && it.max == integer(raw, "max")) { "Saved plot bounds do not match their version" } }
        }
        private fun integer(raw: JsonObject, key: String): Int = requireNotNull(raw[key] as? JsonPrimitive).let {
            require(!it.isString); requireNotNull(it.intOrNull)
        }
    }
}
