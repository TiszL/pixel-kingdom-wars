package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.utils.JsonReader
import org.junit.Test
import kotlin.test.*

class ActorBodyFeedbackTest {
    private fun clip(state:String)=AuthoredClip(state,"atlas/body.json",List(8) { row -> List(4) { "$state-$row-$it" } },
        listOf("s","sw","w","nw","n","ne","e","se"),10f,.5f,1f,1f,32f,32f,false,null,emptyMap())
    private fun art(damaged:Boolean)=CombatArt(listOf("idle","walk","spawn","attack","hit","death","damaged").associateWith(::clip),
        JsonReader().parse("""{"kind":"trp","stand":"idle","move":"walk","spawn":"spawn","hit":"hit","death":"death","attack":["attack"],"melee":{"building":"attack"}${if(damaged)",\"damaged\":\"damaged\"" else ""}}"""),
        emptyMap(),emptyMap(),0f,0f,damagedBody=if(damaged)DamagedBodyArt(100,.5) else null,bodyMoveSnapTiles=1f/256f,
        bodyFacingAim=HowlAimArt(.25f/(256f*256f),32.5f))
    private val deploy="""{"t":0,"e":"deploy","id":1,"troop":"bowman","x":0,"y":0}"""
    private fun hit(t:Int,damage:Int=1)="""{"t":$t,"e":"hit","target":1,"dmg":$damage}"""
    private fun attack(t:Int)="""{"t":$t,"e":"troopAttack","id":1,"targetKind":"building","ix":256,"iy":0}"""
    private fun plan(events:List<String>,damaged:Boolean=false,cold:Float?=null,maxHp:Long?=null):CombatVisualPlan {
        val parsed=events.map(PresentationEvent::fromJson)
        val scene=BattleScene(BaseScene(listOf(RenderBuilding("tower","none",5f,5f,1f,1f)),20,20,256f),
            PresentationRevision("body","fixture",15,0,0,parsed),mapOf("bowman" to "actor"),256f,100f,10,10,
            presentationStart=cold?.let { BattlePresentationStart.ColdPrefix(it) } ?: BattlePresentationStart.Continuous,
            actorMaxHp=maxHp?.let { mapOf(1 to it) } ?: emptyMap())
        return CombatVisualPlan(scene,BattleVisualModel(parsed,10),mapOf("actor" to art(damaged)))
    }
    private fun state(p:CombatVisualPlan,t:Float,name:String)=assertTrue(p.actor(1,t)?.frameKey?.startsWith("$name-")==true,"$t expected $name, got ${p.actor(1,t)?.frameKey}")

    @Test fun `idle hit plays the complete authored flinch and repeated damage cannot restart it`() {
        val p=plan(listOf(deploy,hit(5),hit(6)))
        state(p,4.99f,"idle");state(p,5f,"hit");state(p,8.99f,"hit");state(p,9f,"idle")
        assertEquals(plan(listOf(deploy,hit(5))).actor(1,8f),p.actor(1,8f))
        state(p,5f,"hit");state(plan(listOf(deploy)),5f,"idle")
    }
    @Test fun `spawn and an authored attack cannot be interrupted by hit reactions`() {
        val p=plan(listOf(deploy,hit(1),attack(10),hit(11)))
        state(p,1f,"spawn");state(p,10f,"attack");state(p,13.99f,"attack");state(p,14f,"idle")
        for(events in listOf(listOf(deploy,hit(10),attack(10)),listOf(deploy,attack(10),hit(10))))state(plan(events),10f,"attack")
        val release=plan(listOf(deploy,attack(10),hit(14),hit(15)))
        state(release,14f,"idle");state(release,15f,"hit")
    }
    @Test fun `delivered movement blocks a flinch but movement starting after the same tick hit preserves that body`() {
        val moving="""{"t":10,"e":"pos","id":1,"x":100,"y":0}"""
        state(plan(listOf(deploy,hit(5),moving)),5f,"walk")
        val stationary="""{"t":5,"e":"pos","id":1,"x":0,"y":0}"""
        val later="""{"t":15,"e":"pos","id":1,"x":100,"y":0}"""
        val p=plan(listOf(deploy,stationary,hit(5),later))
        state(p,5f,"hit");state(p,8.99f,"hit");state(p,9f,"walk")
    }
    @Test fun `death wins over an ongoing flinch and cold prefix does not replay transient hit bodies`() {
        state(plan(listOf(deploy,hit(5),"""{"t":6,"e":"troopDeath","id":1}""")),6f,"death")
        state(plan(listOf(deploy,hit(5)),cold=6f),6f,"idle")
    }
    @Test fun `cold entry clears old spawn and attack ownership before its first live idle hit`() {
        state(plan(listOf(deploy,hit(2)),cold=2f),2f,"hit")
        state(plan(listOf(deploy,attack(10),hit(11)),cold=11f),11f,"hit")
    }
    @Test fun `exact half health latches damaged body and healing cannot return it to the healthy art`() {
        val p=plan(listOf(deploy,hit(5,49),hit(10,1),"""{"t":11,"e":"heal","id":1,"amount":99}"""),damaged=true)
        state(p,5f,"hit");state(p,9f,"idle");state(p,10f,"damaged");state(p,12f,"damaged")
        state(p,4f,"idle")
        state(plan(listOf(deploy,hit(5,49)),damaged=true),10f,"idle")
    }
    @Test fun `chain and cold history restore persistent damage without creating a transient flinch`() {
        val chain="""{"t":5,"e":"chain","id":"tower","targets":[1],"dmg":[50]}"""
        val p=plan(listOf(deploy,chain),damaged=true,cold=8f)
        state(p,8f,"damaged")
        state(plan(listOf(deploy,chain)),5f,"idle")
        val unknown=chain.replace("tower","missing")
        state(plan(listOf(deploy,unknown),damaged=true),8f,"idle")
    }
    @Test fun `damage during an attack waits for its complete body and uses frozen equipped maximum`() {
        val p=plan(listOf(deploy,attack(10),hit(11,51)),damaged=true)
        state(p,11f,"attack");state(p,13.99f,"attack");state(p,14f,"damaged")
        assertTrue(p.actor(1,14f)!!.frameKey.endsWith("-0"),"The damaged loop begins at its first authored frame after the attack")
        state(plan(listOf(deploy,hit(5,51)),damaged=true,maxHp=115),9f,"idle")
        state(plan(listOf(deploy,hit(5,58)),damaged=true,maxHp=115),5f,"damaged")
    }
}
