package gg.pixelkingdomwars.nativeclient.renderer

/** Finite presentation time never changes the authoritative event or outcome boundary. */
data class BattlePlaybackExtent(val eventEndTick: Float, val visualEndTick: Float) {
    init {
        require(eventEndTick.isFinite() && eventEndTick >= 0)
        require(visualEndTick.isFinite() && visualEndTick >= eventEndTick)
    }
}

/** Identity accompanies queued UI delivery so a replaced scene cannot publish stale progress. */
data class BattlePlaybackFrame(val raidId: String, val revision: String, val playheadTick: Float,
    val extent: BattlePlaybackExtent)

/** Scene replacement is not a seek. A terminal revision must not restart an already playing tail. */
internal fun initialBattleTick(scene: BattleScene, extent: BattlePlaybackExtent, previous: BattlePlaybackFrame?): Float {
    if(scene.retainPlaybackTick && previous?.raidId == scene.revision.raidId) {
        return previous.playheadTick.coerceIn(0f,extent.visualEndTick)
    }
    return scene.playheadTick.coerceAtMost(extent.visualEndTick)
}
