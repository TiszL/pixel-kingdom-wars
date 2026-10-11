package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.utils.JsonValue

/** Current web's historical presentation dispatcher; this is never live SIM admission. */
data class ArchivedMeleePolicy(val selfDescribingSimVersion:Int,val targetAwareSimVersion:Int,
    val positionSnapDistance:Float,val aim:HowlAimArt) {
    init { require(selfDescribingSimVersion>targetAwareSimVersion && targetAwareSimVersion>0)
        require(positionSnapDistance.isFinite() && positionSnapDistance>0) }
    fun automatic(simVersion:Int,id:Int,events:List<Pair<Int,JsonValue>>,art:CombatArt):Boolean {
        if(!art.profile.has("melee") || art.profile.getBoolean("autoAttack",true)==false)return false
        if(events.any { (_,e)->e.getInt("id",-1)==id && e.has("hero") })return false
        return when {
            simVersion>=selfDescribingSimVersion->false
            simVersion>=targetAwareSimVersion->events.none { (_,e)->e.getInt("id",-1)==id && e.getString("e")=="deploy" && e.getString("troop","")=="troll" }
            else->events.none { (_,e)->e.getInt("id",-1)==id && e.getString("e")=="troopAttack" }
        }
    }
    companion object {
        fun parse(value:JsonValue?):ArchivedMeleePolicy?=value?.get("legacyMelee")?.let {
            require(it.getString("mode")=="sourceIdleAttack")
            ArchivedMeleePolicy(it.getInt("selfDescribingSimVersion"),it.getInt("targetAwareSimVersion"),
                it.getFloat("positionSnapDistance"),it.get("aim").let { aim->HowlAimArt(aim.getFloat("minimumDeltaSquared"),aim.getFloat("retainWithinDegrees")) })
        }
    }
}
