package gg.pixelkingdomwars.nativeclient.network

import kotlinx.serialization.json.*

/** Read-only archived event admission. This never changes live SIM, protocol, or content compatibility. */
data class ArchivedReplayPolicy(val minimumSimVersion:Int,val maximumSimVersion:Int) {
    init {require(minimumSimVersion>0 && maximumSimVersion>=minimumSimVersion)}
    fun supports(simVersion:Int,currentSimVersion:Int)=maximumSimVersion==currentSimVersion && simVersion in minimumSimVersion..maximumSimVersion
    companion object {
        fun from(value:JsonObject?):ArchivedReplayPolicy?=value?.let {
            require(it["version"]==JsonPrimitive(1) && it.string("mode")=="currentWebArchive")
            val legacy=requireNotNull(it["legacyMelee"] as? JsonObject)
            require(legacy.string("mode")=="sourceIdleAttack")
            val self=requireNotNull(legacy["selfDescribingSimVersion"]?.jsonPrimitive?.intOrNull)
            val target=requireNotNull(legacy["targetAwareSimVersion"]?.jsonPrimitive?.intOrNull)
            require(target>0 && self>target && self<=requireNotNull(it["maximumSimVersion"]?.jsonPrimitive?.intOrNull))
            require(legacy["positionSnapDistance"]?.jsonPrimitive?.floatOrNull?.let { n->n.isFinite()&&n>0 }==true)
            require(legacy["aim"] is JsonObject)
            ArchivedReplayPolicy(requireNotNull(it["minimumSimVersion"]?.jsonPrimitive?.intOrNull),requireNotNull(it["maximumSimVersion"]?.jsonPrimitive?.intOrNull))
        }
    }
}

fun archivedReplaySupported(simVersion:Int,currentSimVersion:Int?,renderCatalogue:JsonObject?):Boolean {
    if(currentSimVersion==null)return false
    if(simVersion==currentSimVersion)return true
    return ArchivedReplayPolicy.from(renderCatalogue?.get("archivePresentation") as? JsonObject)?.supports(simVersion,currentSimVersion)==true
}
