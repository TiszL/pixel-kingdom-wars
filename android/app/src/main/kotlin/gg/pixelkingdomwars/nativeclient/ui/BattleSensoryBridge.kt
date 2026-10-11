package gg.pixelkingdomwars.nativeclient.ui

import android.os.Handler
import android.os.Looper
import androidx.compose.runtime.*
import gg.pixelkingdomwars.nativeclient.AppGraph
import gg.pixelkingdomwars.nativeclient.renderer.*
import java.io.Closeable
import java.io.File
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.collect

/** Independent from media focus/SFX preferences. Every read checks the original wallet and pack. */
data class SensoryContext(val identity:Any?,val pack:Any?,val foreground:Boolean,val reducedMotion:Boolean,val lifecycleEpoch:Long,val haptics:Boolean=true)
class BattleSensoryBridge(private val current:()->SensoryContext,private val post:(()->Unit)->Unit,
                          private val haptic:(HapticPattern)->Unit,private val cancel:()->Unit={},private val onClose:()->Unit={},private val deployment:BattleDeployFeedback?=null):Closeable {
    private val bound=current()
    private var expected:Triple<String,String,Long>?=null
    private var epoch=tokens.incrementAndGet()
    private var observed=bound
    private var closed=false
    private var pending:SensoryFrame?=null
    private var posted=false
    private var gap=false
    @Synchronized fun expect(scene:BattleScene?,token:Long,revisionReplacement:Boolean=false,publish:()->Unit={}) {
        environmentChanged()
        val continuity=revisionReplacement && scene!=null && expected?.first==scene.revision.raidId
        expected=scene?.let { Triple(it.revision.raidId,it.revision.revision,token) }
        // Only the GL cursor can prove unchanged actual history. Keep its environment
        // epoch here, but fence every old rendered/queued delivery by the new exact token.
        if(!continuity)epoch=tokens.incrementAndGet()
        pending=null;gap=false;cancel()
        // Publish the renderer generation before any admission can observe the new
        // expected token. Its following generation read then freezes an old frame.
        publish()
    }
    @Synchronized fun environmentChanged() {
        val now=current()
        if(now!=observed) {observed=now;epoch=tokens.incrementAndGet();pending=null;gap=false;cancel()}
    }
    @Synchronized fun admission(raid:String,revision:String,token:Long):Long {
        environmentChanged()
        val now=observed
        return if(!closed && expected==Triple(raid,revision,token) && bound.identity!=null && bound.pack!=null &&
            now.identity===bound.identity && now.pack===bound.pack && now.foreground && !now.reducedMotion)epoch else -1
    }
    /** Cold/disabled frames may hydrate markers, but an obsolete scene token may not consume them. */
    @Synchronized fun deployed(raid:String,revision:String,token:Long,cue:DeployHaptic):Boolean {
        environmentChanged()
        if(closed || expected!=Triple(raid,revision,token))return true
        return deployment?.observed(raid,cue) ?: false
    }
    /** Artwork follows the same scene token as event consumption, independently of haptic preferences. */
    @Synchronized fun deployPreview(raid:String,revision:String,token:Long):List<DeployPreviewMark> {
        environmentChanged()
        if(closed || expected!=Triple(raid,revision,token))return emptyList()
        return deployment?.preview(raid).orEmpty()
    }
    @Synchronized private fun accepts(value:SensoryFrame):Boolean {
        val e=expected ?: return false
        return value.token==e.third && value.epoch>=0 && admission(e.first,e.second,e.third)==value.epoch
    }
    @Synchronized fun offer(value:SensoryFrame) {
        if(!accepts(value))return
        if(pending!=null)gap=true
        pending=value
        if(!posted) {posted=true;post(::drain)}
    }
    private fun drain() {
        val value=synchronized(this) {
            val frame=pending;val skipped=gap;pending=null;posted=false;gap=false
            frame?.takeUnless { skipped }
        } ?: return
        synchronized(this) {
            if(accepts(value))value.haptics.forEach { if(accepts(value))haptic(it) }
        }
    }
    @Synchronized override fun close() {
        if(closed)return
        closed=true;expected=null;pending=null;epoch=tokens.incrementAndGet();cancel();onClose()
    }
    companion object { private val tokens=AtomicLong();fun nextToken()=tokens.incrementAndGet() }
}
class NativeSensoryExperience(private val graph:AppGraph,private val device:DeviceExperience,private val scope:CoroutineScope) {
    fun context(assets:File):SensoryContext {
        val content=graph.content.state.value;val system=device.state.value
        return SensoryContext(graph.holder.current ?: graph.takeIf { it.mode.offline },
            content.catalogue.takeIf { content.ready && content.assets==assets },system.foreground,
            effectiveReducedMotion(graph.preferences.state.value,system),device.sensoryEpoch,graph.preferences.state.value.haptics)
    }
    fun observe(changed:()->Unit):Job=scope.launch {
        combine(graph.holder.session,graph.content.state,graph.preferences.state,device.state) { _,_,_,_->Unit }
            .collect { changed() }
    }
    fun bridge(assets:File,deployment:BattleDeployFeedback?=null):BattleSensoryBridge {
        val main=Handler(Looper.getMainLooper());val owner=Any()
        var observation:Job?=null
        val bridge=BattleSensoryBridge({context(assets)},
            {main.post(it);Unit},{device.patternHaptic(owner,it)},{device.cancelHaptics(owner)},{observation?.cancel()},deployment)
        observation=observe { bridge.environmentChanged() }
        return bridge
    }
}
val LocalNativeSensory=staticCompositionLocalOf<NativeSensoryExperience?> { null }
val LocalDeviceExperience=staticCompositionLocalOf<DeviceExperience?> { null }
@Composable fun rememberNativeSensoryExperience(graph:AppGraph):NativeSensoryExperience? {
    val device=LocalDeviceExperience.current
    // A still-mounted old surface never rebinds merely because another wallet signs in.
    val scope=rememberCoroutineScope()
    return remember(graph,device,scope) { device?.let { NativeSensoryExperience(graph,it,scope) } }
}
