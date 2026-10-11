package gg.pixelkingdomwars.nativeclient

/** One immutable view of the metadata used by an update check. Main owns publication/reads. */
internal data class ContentUpdateContext(val bundledVersion:String,val simVersion:Int,val rendererVersion:Int)
internal class ContentUpdateReadiness {
    var current:ContentUpdateContext?=null
        private set
    private var startupFinished=false
    private var lastCheck:Long?=null
    fun finishStartup() { startupFinished=true }
    fun beginCheck(force:Boolean,now:Long):Boolean {
        if(current==null || !startupFinished) return false
        if(!force && lastCheck?.let { now-it<300_000_000_000L }==true) return false
        lastCheck=now
        return true
    }
    /** Main permits one active update job, so only that job can release its throttle. */
    fun sessionSuperseded() { lastCheck=null }
    suspend fun load(block:suspend ()->ContentUpdateContext) {
        // Keep resume checks closed across every suspension, including a failed retry.
        current=null
        current=block()
    }
}
