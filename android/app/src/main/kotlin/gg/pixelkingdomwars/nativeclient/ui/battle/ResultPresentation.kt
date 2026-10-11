package gg.pixelkingdomwars.nativeclient.ui.battle

import gg.pixelkingdomwars.nativeclient.audio.UiAudioSound
import gg.pixelkingdomwars.nativeclient.BattleResultSummary
import gg.pixelkingdomwars.nativeclient.network.LiveBattleState
import gg.pixelkingdomwars.nativeclient.renderer.HapticPattern
import gg.pixelkingdomwars.nativeclient.ui.SensoryContext
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.collect
import kotlinx.serialization.json.*
import java.io.Closeable

internal data class ResultSound(override val legacy:String,override val family:String,override val gain:Float):UiAudioSound
internal data class ResultFeedback(val sounds:List<ResultSound>,val haptics:List<HapticPattern>)
internal data class ResultStars(val atlas:String,val key:String,val size:Float,val gap:Float,val top:Float,val bottom:Float,
                                val opacity:List<Float>,val filledOpacity:List<Float>,val offsetY:List<Float>)
internal data class ResultImage(val path:String,val width:Int,val height:Int)
internal data class ResultFx(val frames:List<ResultImage>,val size:Float,val frameMs:Long,
                             val horizontal:Float,val vertical:Float,val right:Boolean,val bottom:Boolean) {
    fun frame(elapsedMs:Long,reduced:Boolean)=if(reduced)0 else ((elapsedMs.coerceAtLeast(0)/frameMs)%frames.size).toInt()
}
/** Optional metadata captured by executing current results.tsx. No game reward is calculated here. */
internal data class ResultPresentation(val stars:ResultStars,val effects:List<ResultFx>,
                                       val victory:Map<Int,ResultFeedback>,val defeat:ResultFeedback) {
    val sounds:Set<UiAudioSound> get()=(victory.values+defeat).flatMap { it.sounds }.toSet()
    fun feedback(won:Boolean,stars:Int):ResultFeedback=if(won)victory.getValue(stars.coerceIn(victory.keys.min(),victory.keys.max())) else defeat
    companion object {
        fun read(value:JsonObject?):ResultPresentation?=value?.let { v->
            require(v.int("version")==1)
            val s=v.getValue("stars").jsonObject
            val opacity=s.getValue("opacity").jsonArray.map { it.jsonPrimitive.float.also { n->require(n.isFinite()&&n in 0f..1f) } }
            val filled=s.getValue("filledOpacity").jsonArray.map { it.jsonPrimitive.float.also { n->require(n.isFinite()&&n in 0f..1f) } }
            val offsets=s.getValue("offsetY").jsonArray.map { it.jsonPrimitive.float.also { n->require(n.isFinite()) } }
            require(opacity.isNotEmpty()&&opacity.size==offsets.size&&filled.size==opacity.size)
            val stars=ResultStars(s.text("atlasPath").also { require(it=="atlas/ui@1x.json") },s.text("frameKey").also { require(it=="ui_icon_star") },
                s.positive("size"),s.nonnegative("gap"),s.nonnegative("paddingTop"),s.nonnegative("paddingBottom"),opacity,filled,offsets)
            val effects=v.getValue("fx").jsonObject.values.map { raw->
                val f=raw.jsonObject;val style=f.getValue("style").jsonObject
                val right="right" in style;val bottom="bottom" in style
                require(("left" in style)!=right&&("top" in style)!=bottom)
                fun fraction(key:String)=style.text(key).removeSuffix("%").toFloat().div(100f).also {
                    require(style.text(key).endsWith("%")&&it.isFinite()&&it in 0f..1f)
                }
                ResultFx(f.getValue("frames").jsonArray.map { image->val p=image.jsonObject
                    ResultImage(p.text("path").also { require(it.matches(Regex("ui/results/fx_(sparkle|loot)_f[1-9][0-9]*\\.png"))) },
                        p.int("width").also { require(it>0) },p.int("height").also { require(it>0) })
                }.also { require(it.isNotEmpty()) },f.positive("size"),f.getValue("frameMs").jsonPrimitive.long.also {require(it>0)},
                    fraction(if(right)"right" else "left"),fraction(if(bottom)"bottom" else "top"),right,bottom)
            }
            val patterns=v.getValue("patterns").jsonObject.mapValues { HapticPattern(it.value.jsonArray.map { n->n.jsonPrimitive.long }) }
            fun feedback(raw:JsonObject):ResultFeedback=ResultFeedback(raw.getValue("audio").jsonArray.map { item->val a=item.jsonObject
                require(a.text("priority")=="normal")
                ResultSound(a.text("legacy").also {require(it.matches(Regex("sfx_(star_[1-9][0-9]*|shield_up)")))},
                    a.text("family").also { require(it=="sfx_battle_"+a.text("legacy").removePrefix("sfx_")) },
                    a.getValue("gain").jsonPrimitive.float.also { require(it.isFinite()&&it in 0f..1f) })
            },raw.getValue("haptics").jsonArray.map { patterns.getValue(it.jsonPrimitive.content) })
            val victories=v.getValue("victory").jsonArray.associate { raw->raw.jsonObject.let { it.int("stars") to feedback(it) } }
            require(victories.keys== (0..victories.keys.max()).toSet())
            ResultPresentation(stars,effects,victories,feedback(v.getValue("defeat").jsonObject))
        }
    }
}
private fun JsonObject.text(key:String)=getValue(key).jsonPrimitive.content
private fun JsonObject.int(key:String)=getValue(key).jsonPrimitive.int
private fun JsonObject.nonnegative(key:String)=getValue(key).jsonPrimitive.float.also { require(it.isFinite()&&it>=0) }
private fun JsonObject.positive(key:String)=nonnegative(key).also {require(it>0)}

internal data class ResultCueKey(val raid:String,val won:Boolean,val stars:Int)
internal fun resultCueKey(raid:String?,result:JsonObject?):ResultCueKey? {
    if(raid==null||result==null)return null
    val summary=BattleResultSummary.read(result)
    return ResultCueKey(raid,summary.won,summary.stars?.toIntOrNull()?:0)
}
/** STOP pauses Compose frames, not this existing flow collector. Consume offscreen
 * arrivals now so the first visible composition cannot turn them into a late cue. */
internal suspend fun observeResultKeys(states:Flow<LiveBattleState>,owner:ResultCueOwner) {
    states.collect { state->
        val key=resultCueKey(state.pending?.raidId,state.result)
        if(key!=null)owner.observe(key)
    }
}
/** Mount/stars-change semantics, with current native visibility. A muted/background event is
 * consumed, never retained behind loading or focus. Process recovery can mount a fresh owner. */
internal class ResultCueOwner(private val identity:Any?,private val pack:Any?,private val readContext:()->SensoryContext,
                              private val cancel:()->Unit):Closeable {
    private var last:ResultCueKey?=null
    private var arrival:Pair<ResultCueKey,Long>?=null
    private var context=readContext()
    private var closed=false
    fun isCurrent():Boolean {
        environmentChanged()
        return !closed&&identity!=null&&pack!=null&&context.identity===identity&&context.pack===pack&&context.foreground
    }
    fun shown(key:ResultCueKey):Boolean {
        if(closed||key==last)return false
        last=key
        return isCurrent()&&(arrival?.takeIf { it.first==key }?.second?:context.lifecycleEpoch)==context.lifecycleEpoch
    }
    fun observe(key:ResultCueKey) {
        if(closed||key==last)return
        if(!isCurrent()){shown(key);return}
        // A result may arrive before its first Compose frame. PAUSE/RESUME must
        // not renew that delivery opportunity, even after a reward-only refresh.
        if(arrival?.first!=key)arrival=key to context.lifecycleEpoch
    }
    fun environmentChanged() { val next=readContext();if(next!=context||next.identity!==context.identity||next.pack!==context.pack){context=next;if(next.identity!==identity||next.pack!==pack)closed=true;cancel()} }
    override fun close(){if(!closed){closed=true;cancel()}}
}
