package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.utils.JsonValue

/** Source-probed choreography, never a rule for damage, targeting or legal movement. */
data class BurrowMotionArt(val enterState:String,val tunnelState:String,val surfaceState:String,
    val positionSnapDistance:Float,val aim:HowlAimArt,val soilDepthOffset:Float) {
    companion object {
        fun parse(value:JsonValue,combat:JsonValue):BurrowMotionArt {
            val policies=mapOf("controller" to "v2Burrow","movement" to "linearPreserveVerb",
                "enterMovement" to "retain","emergeMovement" to "coordinatesKillRetainMovingFlagOtherwiseRetain",
                "identicalRegistration" to "preservePhaseAndCallbacks","rowRegistration" to "preservePhaseReplaceCallbacks",
                "soilOwnership" to "scene","coldPrefix" to "stableBurrowOrEmergeWithoutHistoricalCues")
            policies.forEach { (key,expected)->require(value.getString(key,null)==expected) { "Unsupported Burrow policy: $key" } }
            val aim=requireNotNull(value.get("aim")) { "Burrow aiming contract missing" }
            val result=BurrowMotionArt(value.getString("enterState"),value.getString("tunnelState"),value.getString("surfaceState"),
                value.getFloat("positionSnapDistance"),HowlAimArt(aim.getFloat("minimumDeltaSquared"),aim.getFloat("retainWithinDegrees")),value.getFloat("soilDepthOffset"))
            require(result.positionSnapDistance.isFinite() && result.positionSnapDistance>0 && result.soilDepthOffset.isFinite())
            val profile=requireNotNull(combat.get("profile"));val burrow=requireNotNull(profile.get("burrow")) { "Burrow profile missing" }
            require(burrow.getString("enter")==result.enterState && burrow.getString("tunnel")==result.tunnelState && burrow.getString("surface")==result.surfaceState)
            val clips=requireNotNull(combat.get("clips"))
            fun clip(state:String)=AuthoredClip.parse(requireNotNull(clips.get(state)) { "Burrow body clip missing: $state" })
            val enter=clip(result.enterState);val surface=clip(result.surfaceState);val tunnel=clip(result.tunnelState)
            require(enter.fps>0 && surface.fps>0 && !enter.loop && !surface.loop && tunnel.fps>0 && tunnel.loop)
            listOf(enter,surface,tunnel).forEach { require(it.durationMs.isFinite() && it.durationMs>0) { "Burrow body duration must be finite" } }
            listOf(profile.getString("stand"),profile.getString("battleMove",null) ?: profile.getString("move"),profile.getString("death")).forEach { clip(it) }
            val bodyStates=listOf(profile.getString("stand"),profile.getString("battleMove",null) ?: profile.getString("move"),profile.getString("death")) +
                (profile.get("melee")?.map { it.asString() } ?: emptyList()) + listOfNotNull(profile.getString("hit",null))
            require(profile.get("melee")?.getString("troop",null)!=null && profile.get("melee")?.getString("building",null)!=null) { "Burrow melee profile missing" }
            for(state in bodyStates.distinct()) {
                val body=clip(state)
                require(body.fps>0 && body.durationMs.isFinite() && body.durationMs>0) { "Burrow controller body must animate: $state" }
                body.effectByCue.values.forEach { key->
                    val effect=AuthoredClip.parse(requireNotNull(combat.get("effects")?.get(key)) { "Burrow contact effect missing: $key" })
                    require(effect.fps>0 && !effect.loop && effect.durationMs.isFinite() && effect.durationMs>0)
                }
            }
            for(body in listOf(enter,surface)) {
                val frames=body.fxCues["soil"].orEmpty()
                require(frames.isNotEmpty() && frames.all { n->n>0 && body.frames.all { n<=it.size } }) { "Burrow soil keys missing or invalid" }
                val key=requireNotNull(body.effectByCue["soil"]) { "Burrow soil art missing" }
                val effect=AuthoredClip.parse(requireNotNull(combat.get("effects")?.get(key)) { "Burrow soil effect missing" })
                require(effect.fps>0 && !effect.loop && effect.durationMs.isFinite() && effect.durationMs>0) { "Burrow soil must expire" }
            }
            return result
        }
    }
}
