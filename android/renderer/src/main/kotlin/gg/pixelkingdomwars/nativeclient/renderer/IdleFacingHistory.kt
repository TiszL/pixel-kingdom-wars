package gg.pixelkingdomwars.nativeclient.renderer

/** tickAttack updates controller direction after the Clock/ticker batch. Automatic body rows
 * remain registered until the next clip, while a later verb or keyed emitter reads this direction. */
internal class IdleFacingHistory {
    private val changes=mutableMapOf<Int,MutableList<Pair<Float,String>>>()
    fun record(owner:Int,ms:Float,facing:String) {
        val list=changes.getOrPut(owner) { mutableListOf() }
        require(list.lastOrNull()?.first?.let { it<=ms }!=false)
        if(list.lastOrNull()?.first==ms)list[list.lastIndex]=ms to facing else list+=ms to facing
    }
    fun before(owner:Int,ms:Float,initial:String):String {
        val list=changes[owner] ?: return initial
        var lo=0;var hi=list.size
        while(lo<hi) { val mid=(lo+hi) ushr 1;if(list[mid].first<ms)lo=mid+1 else hi=mid }
        return list.getOrNull(lo-1)?.second ?: initial
    }
}
