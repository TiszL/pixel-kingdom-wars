package gg.pixelkingdomwars.nativeclient.ui.phasee
import gg.pixelkingdomwars.nativeclient.data.DivineTrialFixtures as F
import gg.pixelkingdomwars.nativeclient.divine.*
import gg.pixelkingdomwars.nativeclient.renderer.*
import com.badlogic.gdx.utils.JsonReader
import java.io.File
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
class DivineTrialBattleTest {
 private fun json(path:String)=Json.parseToJsonElement(File(path).readText()).jsonObject
 private val catalogue=json("src/main/assets/native/catalogue.json");private val render=json("src/main/assets/native/render-catalog.json")
 @Test fun `actual stage5 canonical events render with frozen level1 army and original attempt identity`() {for(p in F.vector.drows("plans")){val a=p.dobj("attempt");val scene=divineTrialScene(a,F.rules,catalogue,render);assertEquals(a.dt("id"),scene.revision.raidId);assertEquals(a.dobj("result").dt("inputSha256"),scene.revision.revision);assertFalse(scene.playing);assertEquals(a.dobj("result").drows("events").size,scene.revision.events.size);val model=BattleVisualModel(scene.revision.events,scene.positionCadenceTicks,scene.summonedPositionCadenceTicks);assertTrue(model.unsupportedEventTypes.all{it in setOf("attackRun","fire","trap")});val artRoot=JsonReader().parse(render.toString());val art=CombatArt.catalogue(artRoot);val visual=CombatVisualPlan(scene,model,art,artRoot.getFloat("buildingDamageThreshold"),WallVisualModel(scene.base.buildings,WallCatalogue(artRoot),scene.revision.events));val sprites=mutableListOf<CombatSprite>();for(tick in listOf(0f,100f,scene.revision.events.last().t.toFloat())){visual.transientSprites(tick,sprites);assertTrue(sprites.all{it.x.isFinite()&&it.y.isFinite()});scene.base.buildings.forEach{visual.building(it.id,tick)}};assertEquals(F.rules.bound("maxDeploys"),model.actorIds.size);assertEquals(F.rules.policy.dobj("army").keys,model.actorIdentities)}}
 @Test fun `planning uses actual frozen field and cannot create extra troops or submit a partial army`() {val plan=DivineTrialPlan(F.admitted,F.rules);assertTrue(runCatching{plan.orders()}.isFailure);for(d in F.complete.dobj("orders").drows("deploys"))plan.place(d.dt("troop"),d.dn("tx"),d.dn("ty"),{});assertTrue(plan.complete);assertEquals(F.complete["orders"],plan.orders());val d=F.complete.dobj("orders").drows("deploys").first();assertTrue(runCatching{plan.place(d.dt("troop"),d.dn("tx"),d.dn("ty"),{})}.isFailure);plan.undo{};assertFalse(plan.complete)}
 @Test fun `retired admission cannot change or undo a local plan`() {val p=DivineTrialPlan(F.admitted,F.rules);val d=F.complete.dobj("orders").drows("deploys").first();p.place(d.dt("troop"),d.dn("tx"),d.dn("ty"),{});val old=p.placements;assertTrue(runCatching{p.undo{error("retired")}}.isFailure);assertTrue(runCatching{p.place(d.dt("troop"),d.dn("tx"),d.dn("ty")){error("retired")}}.isFailure);assertEquals(old,p.placements)}
 @Test fun `planning and replay require admitted compatible content and never substitute current player state`() {val planning=divineTrialScene(F.admitted,F.rules,catalogue,render);assertTrue(planning.revision.events.isEmpty());assertFalse(planning.playing);assertEquals(F.admitted.dobj("encounter").dobj("snapshot").drows("buildings").map{it.dt("id")}.toSet(),planning.base.buildings.map{it.id}.toSet());assertTrue(runCatching{divineTrialScene(F.complete,F.rules,JsonObject(catalogue+("simVersion" to JsonPrimitive(999))),render)}.isFailure)}
 @Test fun `an open admitted field can become committed then replay without rebuilding a planning model`() {
  val first=requireNotNull(divineTrialPlanning(F.admitted,F.rules));val d=F.complete.dobj("orders").drows("deploys").first();first.place(d.dt("troop"),d.dn("tx"),d.dn("ty"),{})
  var current=F.admitted;val submitGuard={check(current.dt("status")=="admitted")}
  current=F.committed;assertNull(divineTrialPlanning(current,F.rules));assertTrue(runCatching{first.undo(submitGuard)}.isFailure);assertEquals(1,first.placements.size)
  current=F.complete;assertNull(divineTrialPlanning(current,F.rules));assertTrue(divineTrialScene(current,F.rules,catalogue,render).revision.events.isNotEmpty())
 }
 @Test fun `open field closure has neither planning actions nor a fabricated replay`() {
  assertNotNull(divineTrialPlanning(F.admitted,F.rules))
  for(status in listOf("expired","abandoned")){
   val closed=JsonObject(F.admitted+mapOf("status" to JsonPrimitive(status),"completedAt" to JsonPrimitive("2035-01-08T00:00:00.000Z")))
   assertNull(divineTrialPlanning(closed,F.rules));assertNull(closed.doptional("result"));assertNull(closed.doptional("orders"))
  }
 }

}
