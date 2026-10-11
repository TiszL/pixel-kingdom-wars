package gg.pixelkingdomwars.nativeclient

/** Fixed vocabulary only: never include paths, identities, URLs or failure text. */
internal enum class ContentLoadStage {
    BUNDLE_TRUST, BUNDLE_VERIFY, BUNDLE_EXTRACT, BUNDLE_HEADERS, RESTORE, STORE_TRUST, STORE_VERIFY,
    CATALOGUE_READ, RENDER_HINT, RENDER_READ, RENDER_ADMISSION, RENDER_DECODE,
}

internal data class ContentLoadSample(val stage:ContentLoadStage,val elapsedNanos:Long,
    val files:Int,val bytes:Long,val succeeded:Boolean) {
    fun diagnostic() = "${stage.name}:elapsedNs=$elapsedNanos files=$files bytes=$bytes succeeded=$succeeded"
}

internal inline fun <T> contentLoadWork(stage:ContentLoadStage,noinline sink:((ContentLoadSample)->Unit)?,
    files:Int=0,bytes:Long=0,block:()->T):T {
    val start=System.nanoTime()
    var succeeded=false
    try { return block().also { succeeded=true } }
    finally { sink?.invoke(ContentLoadSample(stage,System.nanoTime()-start,files,bytes,succeeded)) }
}
