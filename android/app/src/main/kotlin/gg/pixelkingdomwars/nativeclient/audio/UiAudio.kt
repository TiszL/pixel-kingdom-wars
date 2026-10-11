package gg.pixelkingdomwars.nativeclient.audio

import java.io.Closeable
import kotlin.coroutines.AbstractCoroutineContextElement
import kotlin.coroutines.CoroutineContext

interface UiAudioSound { val legacy:String; val family:String; val gain:Float }

/** Canonical audio.ts legacy aliases used by current base interactions. These are presentation
 * identifiers, not gameplay outcomes. Unrelated gameplay has no generic fallback mapping. */
enum class UiAudioCue(override val legacy: String, override val family: String, override val gain: Float = 1f) : UiAudioSound {
    TAP("sfx_tap", "sfx_ui_tap"), CONFIRM("sfx_confirm", "sfx_ui_confirm"), ERROR("sfx_error", "sfx_ui_error"),
    CLAIM("sfx_claim_chime", "sfx_ui_claim_chime"),
    // Canonical menu.tsx ClaimScreen plays the coin layer at 0.8.
    COINS("sfx_coin_shower", "sfx_ui_coin_shower", 0.8f),
    QUEST("sfx_quest_done", "sfx_ui_quest_done"), PLACE("sfx_place_thump", "sfx_base_place"),
    WALL("sfx_wall_clink", "sfx_base_wall_place"),
}

/** Main-thread emitter. No queue, replay, sticky state, or decoder-completion callback owns an
 * interaction. The Activity's single audio focus owner updates admission synchronously. */
class UiAudioEmitter(private val visibilityChanged: () -> Unit = {}, private val play: (UiAudioSound, variantKey: String) -> Unit) {
    private var identity: Any? = null
    private var pack: String? = null
    private var allowed = false
    private var current = false
    private val visible = mutableMapOf<UiAudioScope, Any?>()
    val hasVisibleScope: Boolean get() = visible.values.any { it === identity }
    val visibleCues: Set<UiAudioSound> get() = visible.filterValues { it === identity }.keys.flatMap { it.warmCues }.toSet()
    private var epoch = 0L
    private var sequence = 0L
    fun update(identity: Any?, pack: String?, allowed: Boolean, current: Boolean = allowed) {
        if (this.identity !== identity || this.pack != pack || this.allowed != allowed || this.current != current) epoch++
        this.identity = identity; this.pack = pack; this.allowed = allowed; this.current = current
        visibilityChanged()
    }
    internal fun visible(scope: UiAudioScope, identity: Any?, active: Boolean) {
        if (active) visible[scope] = identity else visible.remove(scope)
        visibilityChanged()
    }
    fun scope(baseId: String, identity: Any? = this.identity, warmCues:Set<UiAudioSound> = UiAudioCue.entries.toSet(), currentBase: () -> String?): UiAudioScope = UiAudioScope(this, identity, baseId, currentBase,warmCues)
    internal fun ticket(identity: Any?): Long? = epoch.takeIf { current && this.identity === identity }
    internal fun admitted(identity: Any?, epoch: Long) = current && this.identity === identity && this.epoch == epoch
    internal fun play(cues: List<UiAudioSound>) {
        cues.forEach { cue ->
            val key = "${cue.legacy}:${sequence++}"
            // Web playSfx increments its legacy sequence before the SOUND FX gate.
            // A valid current muted event consumes its key, never a later playback request.
            try { if (allowed) play(cue, key) } catch (_: Exception) { /* Optional media never changes the action. */ }
        }
    }
}

/** A visible base screen owns this lease. Back, a new selection/action, base change, lifecycle
 * pause and disposal invalidate old actions permanently, even if the same screen returns. */
class UiAudioScope internal constructor(private val emitter: UiAudioEmitter, private val identity: Any?,
                                       val baseId: String, private val currentBase: () -> String?, val warmCues:Set<UiAudioSound>) : Closeable {
    private var generation = 0L
    private var active = false
    private var closed = false
    fun active(value: Boolean) {
        if (!closed && active != value) { generation++; active = value; emitter.visible(this, identity, value) }
    }
    fun invalidate() { generation++ }
    fun capture(): BaseAudioAction? {
        val epoch = emitter.ticket(identity) ?: return null
        if (!active || closed || !baseId.equals(currentBase(), ignoreCase = true)) return null
        val ticket = generation
        return BaseAudioAction(identity, baseId, { actor, base -> !closed && active && generation == ticket &&
            actor === identity && baseId.equals(base, ignoreCase = true) && baseId.equals(currentBase(), ignoreCase = true) &&
            emitter.admitted(identity, epoch) }, emitter::play)
    }
    fun shown(cues:List<UiAudioSound>) { capture()?.accepted(identity,baseId,cues) }
    fun tap() { shown(listOf(UiAudioCue.TAP)) }
    override fun close() {
        if (closed) return
        closed = true; active = false; generation++; emitter.visible(this, identity, false)
    }
}

/** Propagated only through the original UI action coroutine. Repository callbacks use the
 * existing durable POST acknowledgement stage; background recovery has no such element. */
class BaseAudioAction internal constructor(val identity: Any?, val baseId: String,
    private val admitted: (Any?, String?) -> Boolean, private val emit: (List<UiAudioSound>) -> Unit,
) : AbstractCoroutineContextElement(Key) {
    private var settled = false
    fun accepted(identity: Any?, baseId: String?, cues: List<UiAudioSound>) {
        if (settled) return
        settled = true
        if (admitted(identity, baseId)) emit(cues)
    }
    fun failed(identity: Any?, baseId: String?) = accepted(identity, baseId, listOf(UiAudioCue.ERROR))
    companion object Key : CoroutineContext.Key<BaseAudioAction>
}
