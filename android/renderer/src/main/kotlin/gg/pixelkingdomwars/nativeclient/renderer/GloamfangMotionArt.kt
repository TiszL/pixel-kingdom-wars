package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.utils.JsonValue

/** Choreography exported from the canonical controller; no combat decisions live here. */
data class LeapMotionArt(val bodyState:String,val durationMs:Float,val heightRatio:Float,val aim:HowlAimArt,val positionSnapDistance:Float) {
    companion object {
        fun parse(value:JsonValue,clips:JsonValue):LeapMotionArt {
            require(value.getString("position")=="castToEventTargetParabola")
            require(value.getString("easing")=="linear" && value.getString("depth")=="groundY")
            require(value.getString("ordinaryPosition")=="preserveBodyAndCounter" && value.getBoolean("ownedCancellation"))
            return LeapMotionArt(value.getString("bodyState"),value.getFloat("durationMs"),value.getFloat("heightRatio"),motionAim(value),value.getFloat("positionSnapDistance")).also {
                require(it.bodyState=="leap" && it.durationMs.isFinite() && it.durationMs>0)
                require(it.heightRatio.isFinite() && it.heightRatio>=0)
                require(it.positionSnapDistance.isFinite() && it.positionSnapDistance>0)
                motionBody(clips,it.bodyState)
            }
        }
    }
}

data class LungeMotionArt(val bodyState:String,val aim:HowlAimArt) {
    companion object {
        fun parse(value:JsonValue,clips:JsonValue):LungeMotionArt {
            require(value.getString("position")=="nextDeliveredPositionSnap" && value.getString("landing")=="standOnDelivery")
            return LungeMotionArt(value.getString("bodyState"),motionAim(value)).also {
                require(it.bodyState=="lunge")
                motionBody(clips,it.bodyState)
            }
        }
    }
}

private fun motionAim(value:JsonValue):HowlAimArt {
    require(value.getString("facing")=="retainUnlessAimed" && value.getString("missingTarget")=="snapOnly")
    val aim=requireNotNull(value.get("aim")) { "Motion aiming contract missing" }
    return HowlAimArt(aim.getFloat("minimumDeltaSquared"),aim.getFloat("retainWithinDegrees"))
}

private fun motionBody(clips:JsonValue,state:String) {
    val body=AuthoredClip.parse(requireNotNull(clips.get(state)) { "Motion body clip missing: $state" })
    require(body.fps>0 && !body.loop) { "Motion body must be a finite authored sequence" }
}
