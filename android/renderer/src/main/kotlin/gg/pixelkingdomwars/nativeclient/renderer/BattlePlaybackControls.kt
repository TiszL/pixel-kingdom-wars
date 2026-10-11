package gg.pixelkingdomwars.nativeclient.renderer

import java.util.concurrent.atomic.AtomicReference

/** The longest time one frame may add to a battle. A stalled frame (texture upload, GC, app switch) must not
 * fast-forward the bodies (owner 2026-10-11, Seeker code 33: the battle played "accelerated"); as GoldForgeScene. */
internal const val MAX_BATTLE_FRAME_MS = 100f

/** A live clock correction under this eases in; a larger one (resume, reconnect) is still a seek. */
internal const val LIVE_EASE_LIMIT_MS = 1_000f

/** The largest share of a frame's own advance an easing correction adds or removes: a live battle runs within 10%
 * of its clock's rate while it corrects, and never backwards. */
internal const val LIVE_EASE_SHARE = 0.1f

/** Ticks one frame advances at [rate], its time capped at [MAX_BATTLE_FRAME_MS]. */
internal fun battleFrameTicks(deltaSeconds: Float, tickDurationMs: Float, rate: Float): Float =
    deltaSeconds.coerceIn(0f, MAX_BATTLE_FRAME_MS / 1000f) * 1000f / tickDurationMs * rate

/** A playing live battle eases a small clock correction. A hard seek moves every body at once and drops the cues it
 * skips; a paused frame, a replay or a large correction still seeks exactly. */
internal fun easesLiveCorrection(scene: BattleScene, correctionTicks: Float): Boolean =
    scene.liveClock && scene.playing && kotlin.math.abs(correctionTicks * scene.tickDurationMs) < LIVE_EASE_LIMIT_MS

/** The part of an outstanding correction one frame absorbs. */
internal fun liveEaseTicks(frameTicks: Float, correctionTicks: Float): Float =
    correctionTicks.coerceIn(-frameTicks * LIVE_EASE_SHARE, frameTicks * LIVE_EASE_SHARE)

internal data class BattlePlaybackControl(val tick: Float?, val rate: Float?, val playing: Boolean, val token: Long, val audioToken: Long = 0)

/** Main-thread controls are consumed on GL. A mode change cancels an unapplied
 * clock correction: a result receipt must hold the actual frame, not predicted time. */
internal class BattlePlaybackControls {
    private val pending = AtomicReference<BattlePlaybackControl?>()
    fun seek(tick: Float, rate: Float, playing: Boolean, token: Long, audioToken: Long = 0) {
        pending.set(BattlePlaybackControl(tick,rate,playing,token,audioToken))
    }
    fun playing(value: Boolean, token: Long, audioToken: Long = 0, rate: Float? = null) {
        require(rate == null || (rate.isFinite() && rate > 0))
        pending.set(BattlePlaybackControl(null,rate,value,token,audioToken))
    }
    fun take(generation: Long, sceneToken: Long): BattlePlaybackControl? {
        val control = pending.get() ?: return null
        if(control.token != generation) { pending.compareAndSet(control,null); return null }
        if(control.token != sceneToken) return null
        return control.takeIf { pending.compareAndSet(it,null) }
    }
}
