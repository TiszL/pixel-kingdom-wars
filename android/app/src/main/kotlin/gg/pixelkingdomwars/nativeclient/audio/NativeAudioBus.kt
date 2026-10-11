package gg.pixelkingdomwars.nativeclient.audio

import kotlinx.coroutines.CoroutineScope
import kotlinx.serialization.json.JsonObject
import java.io.Closeable

/** The Activity's one focus owner publishes synchronously here. Bridges share admission and
 * verified content, but each surface owns its own event cursor and actor-loop leases. */
class NativeAudioBus(private val scope: CoroutineScope, private val sfx: SfxController,
                     private val post: (() -> Unit) -> Unit) : Closeable {
    val ui: UiAudioEmitter = UiAudioEmitter(visibilityChanged = { uiBank.refresh() }) { cue, key ->
        sfx.playFamily(cue.family, key, cue.legacy, cue.gain); Unit
    }
    private val uiBank: UiSfxBank = UiSfxBank(scope, sfx, cues={ui.visibleCues}) { !closed && ui.hasVisibleScope }
    private val gate = AudioFrameGate()
    private val bridges = mutableSetOf<BattleAudioBridge>()
    private var context: MusicContext? = null
    private var focused = false
    private var closed = false
    private var catalogue: JsonObject? = null
    fun content(value: JsonObject?) {
        if (catalogue === value || closed) return
        catalogue = value
        gate.change(false)
        bridges.forEach { it.environmentChanged() }
        gate.change(sfx.isAudible && context?.screen == "battle")
    }
    fun admission(value: MusicContext?, hasFocus: Boolean, explicitRetry: Boolean) {
        if (closed) return
        val old = context
        val replaced = old?.identity !== value?.identity || old?.pack?.identity != value?.pack?.identity
        val changed = replaced ||
            old?.foreground != value?.foreground || old?.soundFx != value?.soundFx ||
            old?.screen != value?.screen || focused != hasFocus || (!sfx.isAudible && explicitRetry)
        if (changed) {
            gate.change(false)
            bridges.forEach { if (replaced) it.sourceReplaced() else it.environmentChanged() }
        }
        if (replaced || old?.foreground != value?.foreground || old?.soundFx != value?.soundFx ||
            focused != hasFocus || (!sfx.isAudible && explicitRetry)) ui.update(value?.identity, value?.pack?.identity, false)
        context = value; focused = hasFocus
        sfx.update(value, hasFocus, explicitRetry)
        ui.update(value?.identity, value?.pack?.identity, sfx.isAudible,
            current = value?.foreground == true && value.pack != null && (hasFocus || (!value.music && !value.soundFx)))
        if (changed || gate.epoch() < 0) gate.change(sfx.isAudible && value?.screen == "battle")
    }
    fun bridge(): BattleAudioBridge {
        check(!closed)
        return BattleAudioBridge(scope, gate, { catalogue }, {
            context?.pack?.runtime?.takeIf { sfx.isAudible && gate.epoch() >= 0 }?.let { BattleSfxPlayback(sfx, it) }
        }, post).also { bridges += it }
    }
    fun release(bridge: BattleAudioBridge) { bridges.remove(bridge); bridge.close() }
    override fun close() {
        if (closed) return
        closed = true; gate.change(false); ui.update(null, null, false); uiBank.close()
        bridges.forEach { it.close() }; bridges.clear(); sfx.close(); catalogue = null; context = null
    }
}
