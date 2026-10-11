package gg.pixelkingdomwars.nativeclient.renderer

/** A fully admitted body in the ACTUAL drawn frame. Burrowed actors own their current
 * underground presentation even when the model's above-ground sprite is hidden. */
data class KegPrimePresentation(val startTick: Float, val detonateTick: Int)

data class BattleAudioActor(val id: Int, val identity: String, val burrowed: Boolean,
    val kegPrime: KegPrimePresentation? = null)

/** Separate from throttled HUD progress. The app may discard queued/superseded frames;
 * it must never use a predicted server/Compose playhead as evidence that a cue was drawn. */
data class BattleAudioRenderFrame(
    val raidId: String, val revision: String, val tick: Float, val playing: Boolean,
    val controlToken: Long, val admissionEpoch: Long, val actors: List<BattleAudioActor>,
)
