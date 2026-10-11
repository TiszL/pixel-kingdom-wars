package gg.pixelkingdomwars.nativeclient.scene

import gg.pixelkingdomwars.nativeclient.network.objects
import gg.pixelkingdomwars.nativeclient.network.string
import gg.pixelkingdomwars.nativeclient.renderer.BaseScene
import gg.pixelkingdomwars.nativeclient.renderer.BattlefieldInputPolicy
import kotlinx.serialization.json.*

/** Kotlin adapter of shared/battlefield; the pack supplies every numeric policy value. */
internal fun battlefieldPolicy(snapshot: JsonObject, base: BaseScene, constants: JsonObject): BattlefieldInputPolicy {
    val rules = constants.getValue("RAID_RULES").jsonObject
    val grid = constants.getValue("GRID").jsonObject
    val policy = constants["RAID_BATTLEFIELD"] as? JsonObject
    // The old admitted pack only supports absent/1. Never infer support for a future version.
    val legacy = policy?.get("legacyVersion")?.jsonPrimitive?.int ?: 1
    val current = policy?.get("currentVersion")?.jsonPrimitive?.int ?: legacy
    val version = snapshot["battlefieldVersion"]?.jsonPrimitive?.int ?: legacy
    require(version in setOf(legacy, 2, 3) && version <= current) { "Update the app to open this battlefield" }
    val margin = policy?.get("marginTilesByVersion")?.jsonObject?.get(version.toString())?.jsonPrimitive?.int
        ?: rules.getValue("deployMarginTiles").jsonPrimitive.int
    val claimMin = snapshot.string("claimMin")?.toInt() ?: grid.getValue("deployRingTiles").jsonPrimitive.int
    val claimMax = snapshot.string("claimMax")?.toInt() ?: claimMin + grid.getValue("claimTiles").jsonPrimitive.int
    val occupied = mutableSetOf<Pair<Int, Int>>()
    fun add(x: Int, y: Int, width: Int, height: Int) {
        require(width > 0 && height > 0 && width <= base.columns && height <= base.rows)
        for (dy in 0 until height) for (dx in 0 until width) occupied += x + dx to y + dy
    }
    base.buildings.forEach { add(it.tileX.toInt(), it.tileY.toInt(), it.footprintWidth.toInt(), it.footprintHeight.toInt()) }
    if (version != legacy) snapshot.objects("deploymentBlockers").forEach {
        add(it.getValue("tx").jsonPrimitive.int, it.getValue("ty").jsonPrimitive.int,
            it.getValue("fw").jsonPrimitive.int, it.getValue("fh").jsonPrimitive.int)
    }
    val square = if (version == 3) requireNotNull(policy?.get("deploymentSquareTiles")) {
        "Update the app to open this battlefield"
    }.jsonPrimitive.int else null
    return BattlefieldInputPolicy(version, legacy, current, -margin, grid.getValue("plotTiles").jsonPrimitive.int + margin, claimMin, claimMax,
        occupied.toSet(), policy?.get("snapRadiusTiles")?.jsonPrimitive?.int ?: 0, square)
}
