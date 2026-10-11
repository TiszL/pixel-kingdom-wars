package gg.pixelkingdomwars.nativeclient.ui.phasee

import gg.pixelkingdomwars.nativeclient.divine.*
import gg.pixelkingdomwars.nativeclient.renderer.BattleScene
import gg.pixelkingdomwars.nativeclient.scene.SceneMapper
import kotlinx.serialization.json.*

/** A local plan has no score or gameplay effect until its exact batch is submitted. */
class DivineTrialPlan(val attempt:JsonObject,val rules:DivineRules) {
 init{rules.attempt(attempt);require(attempt.dt("status")=="admitted")}
 private val planned=mutableListOf<JsonObject>();val placements get()=planned.toList()
 fun remaining(troop:String)=rules.policy.dobj("army").dn(troop).toInt()-planned.count{it.dt("troop")==troop}
 fun place(troop:String,x:Long,y:Long,guard:()->Unit){guard();require(troop in rules.policy.dobj("army").keys&&remaining(troop)>0&&rules.legal(attempt.dobj("encounter"),x,y));planned+=buildJsonObject{put("troop",troop);put("tx",x);put("ty",y);put("tMs",rules.policy.getValue("deployTimeMs"))}}
 fun undo(guard:()->Unit){guard();if(planned.isNotEmpty())planned.removeAt(planned.lastIndex)}
 fun orders()=buildJsonObject{put("deploys",JsonArray(planned))}.also{rules.orders(it,attempt.dobj("encounter"))}
 val complete get()=planned.size==rules.bound("maxDeploys")
}
/** A retained field can become committed or closed while its view stays open. */
fun divineTrialPlanning(attempt:JsonObject,rules:DivineRules):DivineTrialPlan? {
 rules.attempt(attempt);return if(attempt.dt("status")=="admitted")DivineTrialPlan(attempt,rules)else null
}
/** Render-only envelope over the validated dedicated trial original, never an ordinary raid DTO. */
fun divineTrialScene(attempt:JsonObject,rules:DivineRules,catalogue:JsonObject,render:JsonObject):BattleScene {
 rules.attempt(attempt);val e=attempt.dobj("encounter");require(gg.pixelkingdomwars.nativeclient.network.archivedReplaySupported(e.dn("simVersion").toInt(),catalogue.dn("simVersion").toInt(),render)){"Trial playback needs compatible admitted content."}
 val result=attempt.doptional("result");val source=buildJsonObject{
  put("id",attempt.getValue("id"));put("raidId",attempt.getValue("id"));put("revision",result?.getValue("inputSha256")?:e.getValue("inputSha256"));put("lastSequence",0)
  put("simVersion",e.getValue("simVersion"));put("snapshot",e.getValue("snapshot"));put("events",result?.getValue("events")?:JsonArray(emptyList()))
  put("armySnapshot",buildJsonObject{put("counts",e.getValue("army"));put("levels",e.getValue("levels"));put("heroLevels",buildJsonObject{});put("heroLoadouts",buildJsonObject{})})
  if(result!=null)put("timeline",buildJsonObject{put("sha256",result.getValue("inputSha256"))})
 }
 val mapper=SceneMapper(catalogue,render);return (if(result==null)mapper.liveScene(source)else mapper.replayScene(source)).copy(playing=false)
}
