package gg.pixelkingdomwars.nativeclient.ui

import androidx.compose.runtime.*
import gg.pixelkingdomwars.nativeclient.network.BattleCommandFeedback
import gg.pixelkingdomwars.nativeclient.network.LiveBattleState
import gg.pixelkingdomwars.nativeclient.network.string
import gg.pixelkingdomwars.nativeclient.renderer.*
import java.io.Closeable
import java.io.File
import kotlinx.serialization.json.*

/** Source scene marks: FIFO by troop/hero/tile, processed-event dedup, no timeout or durable storage.
 * The visual plan separately owns the source current-actor-ID admission rule. */
class BattleDeployFeedback(private val identity:Any,private val pack:Any,private val raid:String,
                          private val current:()->SensoryContext,alreadyPresent:Set<PresentationEvent> = emptySet(),
                          restoredActors:List<DeployMarkerKey> = emptyList()):Closeable {
    private val seen=alreadyPresent.toMutableSet()
    private val marks=mutableListOf<Ticket>()
    private val restoredCommands=mutableSetOf<String>()
    private val restoredActorCounts=restoredActors.groupingBy {it}.eachCount().toMutableMap()
    private var closed=false
    @Synchronized private fun valid():Boolean {
        val now=current()
        if(now.identity!==identity || now.pack!==pack)close()
        return !closed
    }
    @Synchronized fun environmentChanged() {valid()}
    /** A detached immutable list; the GL thread never sees mutable tickets or command authority. */
    @Synchronized fun preview(raid:String):List<DeployPreviewMark> =
        if(valid() && raid==this.raid && current().foreground) marks.map { DeployPreviewMark(it.previewId,it.key) } else emptyList()
    private var nextPreviewId=0L
    @Synchronized fun mark(key:DeployMarkerKey):Ticket? {
        if(!valid() || !current().foreground)return null
        return Ticket(key).also {marks+=it}
    }
    /** Only accepted pre-start commands can restore artwork. Uncertain local writes are not orders. */
    @Synchronized fun restore(state:LiveBattleState,constants:JsonObject?) {
        val clock=state.clock?.value ?: return
        if(!valid() || state.pending?.raidId!=raid || clock.anchorWallAt!=null || state.terminal)return
        state.commands.sortedBy { it.string("sequence")?.toLongOrNull() ?: Long.MAX_VALUE }.forEach { command->
            val id=command.string("clientCommandId") ?: return@forEach
            if(!restoredCommands.add(id))return@forEach
            if(marks.any {it.writeId==id})return@forEach
            val kind=command.string("kind") ?: return@forEach
            val payload=command["payload"] as? JsonObject ?: return@forEach
            val type=payload.string(if(kind=="hero")"hero" else "troop") ?: return@forEach
            val tx=payload.string("tx")?.toIntOrNull() ?: return@forEach
            val ty=payload.string("ty")?.toIntOrNull() ?: return@forEach
            val key=deployMarkerKey(kind to type,tx,ty,constants) ?: return@forEach
            val represented=restoredActorCounts[key] ?: 0
            if(represented>0) {restoredActorCounts[key]=represented-1;return@forEach}
            marks+=Ticket(key).also {it.writeId=id;it.enter()}
        }
    }
    @Synchronized fun observed(raid:String,cue:DeployHaptic):Boolean {
        if(!valid() || raid!=this.raid)return true
        if(!seen.add(cue.source))return true
        val index=marks.indexOfFirst {it.key==cue.key}
        if(index<0)return false
        marks.removeAt(index);return true
    }
    @Synchronized override fun close() {closed=true;marks.clear();seen.clear();restoredCommands.clear();restoredActorCounts.clear()}
    inner class Ticket internal constructor(internal val key:DeployMarkerKey):BattleCommandFeedback {
        internal val previewId=++nextPreviewId
        private var entered=false
        internal var writeId:String?=null
        fun enter()=synchronized(this@BattleDeployFeedback) {entered=true}
        /** The repository's preflight did not enter the command at all. */
        fun actionFinished()=synchronized(this@BattleDeployFeedback) {if(!entered)marks.remove(this);Unit}
        override fun notEnqueued()=synchronized(this@BattleDeployFeedback) {if(valid())marks.remove(this);Unit}
        override fun enqueued(id:String)=synchronized(this@BattleDeployFeedback) {if(valid()) {writeId=id;restoredCommands+=id};Unit}
        override fun refused(id:String)=synchronized(this@BattleDeployFeedback) {
            if(valid() && writeId==id)marks.remove(this)
            Unit
        }
    }
}

@Composable fun rememberDeployFeedback(identity:Any?,pack:Any?,assets:File,scene:BattleScene,enabled:Boolean):BattleDeployFeedback? {
    val sensory=LocalNativeSensory.current
    val raid=scene.revision.raidId
    val owner=remember(identity,pack,assets,raid,sensory,enabled) {
        if(identity==null || pack==null || sensory==null || !enabled)null
        else {
            // A restored prefix already belongs to the source troop map. It must
            // not consume a new tap before the first resident GL frame hydrates it.
            val actors=restoredDeployEvents(scene)
            val keys=actors.mapNotNull {event->
                val value=Json.parseToJsonElement(event.json).jsonObject
                val troop=value["troop"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null
                val x=value["x"]?.jsonPrimitive?.floatOrNull ?: return@mapNotNull null
                val y=value["y"]?.jsonPrimitive?.floatOrNull ?: return@mapNotNull null
                DeployMarkerKey(troop,value["hero"]?.jsonPrimitive?.contentOrNull,kotlin.math.floor(x/scene.simUnitsPerTile).toInt(),kotlin.math.floor(y/scene.simUnitsPerTile).toInt())
            }
            BattleDeployFeedback(identity,pack,raid,{sensory.context(assets)},actors,keys)
        }
    }
    DisposableEffect(owner,sensory) {
        val observation=owner?.let {sensory?.observe(it::environmentChanged)}
        onDispose {observation?.cancel();owner?.close()}
    }
    return owner
}

/** Hero deployment matches its exported combat donor, never the hero display label. */
fun deployMarkerKey(chosen:Pair<String,String>,tx:Int,ty:Int,constants:JsonObject?):DeployMarkerKey?=when(chosen.first) {
    "deploy"->DeployMarkerKey(chosen.second,null,tx,ty)
    "hero"->((constants?.get("HERO_COMBAT") as? JsonObject)?.get(chosen.second) as? JsonObject)
        ?.get("donor")?.jsonPrimitive?.contentOrNull?.let {DeployMarkerKey(it,chosen.second,tx,ty)}
    else->null
}

internal fun restoredDeployEvents(scene:BattleScene):Set<PresentationEvent> =
    if(scene.playheadTick==0f && scene.presentationStart==BattlePresentationStart.Continuous)emptySet()
    else scene.revision.events.filterTo(linkedSetOf()) {it.e=="deploy" && it.t<=scene.playheadTick}
