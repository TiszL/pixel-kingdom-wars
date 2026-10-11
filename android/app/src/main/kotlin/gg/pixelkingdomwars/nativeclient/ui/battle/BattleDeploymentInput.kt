package gg.pixelkingdomwars.nativeclient.ui.battle

import gg.pixelkingdomwars.nativeclient.network.LiveBattleState
import gg.pixelkingdomwars.nativeclient.renderer.BattleDeploymentMode
import gg.pixelkingdomwars.nativeclient.renderer.BattleDeploymentTarget
import kotlinx.serialization.json.*

internal fun battleDeploymentMode(selection: Pair<String, String>?, live: LiveBattleState,
    constants: JsonObject?, interactive: Boolean): BattleDeploymentMode? {
    if (!interactive || !live.connected || live.blocked || live.terminal) return null
    val raid = live.pending?.raidId ?: return null
    val chosen = selection ?: return null
    if (when (chosen.first) {
        "deploy" -> live.available(chosen.second) <= 0
        "hero" -> live.reserved("hero", "hero", chosen.second)
        else -> true
    }) return null
    val camera = constants?.get("RAID_CAMERA") as? JsonObject ?: return null
    val rules = constants["RAID_RULES"] as? JsonObject ?: return null
    return BattleDeploymentMode("$raid:${chosen.first}:${chosen.second}",
        camera.getValue("holdConfirmMs").jsonPrimitive.long,
        rules.getValue("deployHoldRepeatMs").jsonPrimitive.long,
        camera.getValue("panThresholdPx").jsonPrimitive.float, chosen.first == "deploy",
        target = BattleDeploymentTarget(raid, chosen.first, chosen.second))
}
