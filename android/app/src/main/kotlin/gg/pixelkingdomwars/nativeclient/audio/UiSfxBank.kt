package gg.pixelkingdomwars.nativeclient.audio

import kotlinx.coroutines.*
import java.io.Closeable

/** Native adaptation: unlike the web's cold legacy load().then(play), native never delays a
 * one-shot. Only the currently visible surface's cue families/fallbacks are prewarmed. The SAME
 * AUDIO_RUNTIME decoded-byte, concurrency and ready-deadline limits still govern every byte. */
class UiSfxBank(private val scope: CoroutineScope, private val audio: SfxController,
                private val cues:()->Collection<UiAudioSound> = { UiAudioCue.entries }, private val visible: () -> Boolean) : Closeable {
    private var bank: SfxBank? = null
    private var job: Job? = null
    private var generation = -1L
    private var revision = -1L
    private var epoch = 0L
    private var closed = false
    private var selected = emptySet<UiAudioSound>()
    private fun allowed() = !closed && visible() && audio.isAudible
    fun refresh() {
        if (!allowed()) { release(); return }
        if (generation != audio.contentGeneration) release()
        generation = audio.contentGeneration
        if (bank?.isClosed != false || revision != audio.definitionsRevision || selected != cues().toSet()) replace()
        if (job?.isActive == true) return
        val ticket = epoch
        job = scope.launch {
            audio.awaitDefinitions()
            ensureActive()
            if (ticket == epoch && allowed() && generation == audio.contentGeneration && revision != audio.definitionsRevision) replace()
        }
    }
    private fun replace() {
        bank?.close()
        revision = audio.definitionsRevision; selected = cues().toSet()
        bank = audio.bank(selected.map { it.legacy } + audio.familyIds(selected.map { it.family }))
    }
    private fun release() {
        epoch++; job?.cancel(); job = null; bank?.close(); bank = null; generation = -1; revision = -1; selected = emptySet()
    }
    override fun close() { if (!closed) { closed = true; release() } }
}
