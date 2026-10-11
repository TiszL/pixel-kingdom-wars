package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.utils.JsonReader
import org.junit.Test
import kotlin.test.*

class CombatSpecialsTest {
    private fun event(s: String) = PresentationEvent.fromJson(s)
    private fun clip(key: String, n: Int = 6, fps: Float = 10f) = AuthoredClip(key,"atlas/fx.json",
        listOf(List(n) { "$key-${it + 1}" }),listOf("e"),fps,.5f,1f,1f,10f,20f,false,null,emptyMap())
    private fun plan(type: String, art: CombatArt, events: List<String>): CombatVisualPlan {
        val all = events.map(::event)
        val scene = BattleScene(BaseScene(emptyList(),10,10,256f),PresentationRevision("raid","revision",14,0,0,all),
            mapOf(type to "actor"),256f,100f,10,10)
        return CombatVisualPlan(scene,BattleVisualModel(all,10),mapOf("actor" to art))
    }
    private fun snotArt()=CombatArt(mapOf("idle" to clip("idle").copy(anchorX=.25f,anchorY=.75f)),
        JsonReader().parse("""{"stand":"idle","move":"idle"}"""),emptyMap(),emptyMap(),0f,0f,
        heroBodyDefaultTicks=mapOf("default" to 5),heroEffects=mapOf("snotRocket:impact" to HeroEffectPhase(listOf(
            HeroSweep(clip("snot",4,1000f/90f),700f,99f,200f,actorToEventFallbackMs=560f)),false)))
    private val snotDeploy="""{"t":0,"e":"deploy","id":1,"troop":"giant","hero":"theodor","x":0,"y":0}"""
    private val snotCast="""{"t":2,"e":"heroSkill","id":1,"hero":"theodor","skill":"snotRocket","phase":"impact","x":200,"y":300,"fromX":-900,"fromY":-901,"toX":-902,"toY":-903}"""
    @Test fun `Snot Rocket captures moving caster sprite origin and server target through seek and replacement`() {
        val all=listOf(snotDeploy,snotCast,"""{"t":5,"e":"pos","id":1,"x":100,"y":200}""").map(::event)
        val scene=BattleScene(BaseScene(emptyList(),10,10,256f),PresentationRevision("raid","revision",14,0,0,all),
            mapOf("theodor" to "actor"),256f,100f,5,5)
        val p=CombatVisualPlan(scene,BattleVisualModel(all,5),mapOf("actor" to snotArt()))
        val out=mutableListOf<CombatSprite>()
        p.transientSprites(2f,out);assertEquals(40f,out.single().x);assertEquals(80f,out.single().y)
        p.transientSprites(4.5f,out);assertEquals(120f,out.single().x);assertEquals(190f,out.single().y)
        assertFalse(out.single().flipX);assertEquals(0f,out.single().rotation);val middle=out.toList()
        p.transientSprites(8.99f,out);assertEquals(200f,out.single().x);assertEquals("snot-4",out.single().frameKey)
        p.transientSprites(9f,out);assertTrue(out.isEmpty())
        p.transientSprites(4.5f,out);assertEquals(middle,out)
        plan("theodor",snotArt(),listOf(snotDeploy)).transientSprites(4.5f,out);assertTrue(out.isEmpty())
        plan("theodor",snotArt(),listOf(snotDeploy,snotCast.replace("\"x\":200","\"x\":-200"))).transientSprites(4.5f,out)
        assertEquals(-100f,out.single().x);assertFalse(out.single().flipX)
    }
    @Test fun `Snot Rocket uses stationary fallback only for caster unavailable before its event ordinal`() {
        val death="""{"t":2,"e":"troopDeath","id":1}"""
        val out=mutableListOf<CombatSprite>()
        for(events in listOf(listOf(snotCast),listOf(snotDeploy,death,snotCast))) {
            val p=plan("theodor",snotArt(),events)
            p.transientSprites(2f,out);assertEquals(200f,out.single().x);assertEquals(300f,out.single().y)
            p.transientSprites(7.59f,out);assertEquals("snot-4",out.single().frameKey)
            p.transientSprites(7.6f,out);assertTrue(out.isEmpty())
        }
        val p=plan("theodor",snotArt(),listOf(snotDeploy,snotCast,death))
        p.transientSprites(4.5f,out);assertEquals(100f,out.single().x);assertEquals(150f,out.single().y)
        p.transientSprites(8f,out);assertEquals(200f,out.single().x)
        val teleport="""{"t":2,"e":"emerge","id":1,"x":200,"y":300}"""
        plan("theodor",snotArt(),listOf(snotDeploy,teleport,snotCast)).transientSprites(4.5f,out)
        assertEquals(200f,out.single().x);assertEquals(300f,out.single().y)
        plan("theodor",snotArt(),listOf(snotDeploy,snotCast,teleport)).transientSprites(2f,out)
        assertEquals(0f,out.single().x);assertEquals(0f,out.single().y)
    }
    private fun brownArt()=snotArt().copy(heroEffects=mapOf("brownNote:impact" to HeroEffectPhase(listOf(
        HeroSweep(clip("gasburst",4,10f).copy(scale=2f),700f,99f,200f,actorToEventFallbackMs=600f)),false)))
    private val brownCast=snotCast.replace("snotRocket","brownNote").replace("\"fromX\":-900","\"target\":\"wall\",\"fromX\":-900")
    @Test fun `Brown Note wall destruction remains authoritative before independent travelling gas art`() {
        val events=listOf(snotDeploy,"""{"t":2,"e":"hit","target":"wall","dmg":99}""",
            """{"t":2,"e":"destroyed","id":"wall"}""",brownCast,
            """{"t":5,"e":"pos","id":1,"x":100,"y":200}""").map(::event)
        val wall=RenderBuilding("wall","wall",0f,0f,1f,1f)
        val scene=BattleScene(BaseScene(listOf(wall),10,10,256f),PresentationRevision("raid","revision",14,0,0,events),
            mapOf("theodor" to "actor"),256f,100f,5,5)
        val wallArt=CombatArt(mapOf("collapse" to clip("collapse")),JsonReader().parse("""{"death":"collapse"}"""),emptyMap(),emptyMap(),0f,0f)
        val model=BattleVisualModel(events,5)
        val p=CombatVisualPlan(scene,model,mapOf("actor" to brownArt(),"wall" to wallArt))
        val out=mutableListOf<CombatSprite>()
        assertEquals(2,model.destroyedTick("wall"));assertEquals("collapse-1",p.building("wall",2f)!!.frameKey)
        p.transientSprites(2f,out);assertEquals(40f,out.single().x);assertEquals("gasburst-1",out.single().frameKey)
        p.transientSprites(4.5f,out);assertEquals(120f,out.single().x);assertEquals(190f,out.single().y)
        assertEquals("gasburst-3",out.single().frameKey);val midpoint=out.toList()
        p.transientSprites(8.99f,out);assertEquals(200f,out.single().x);assertEquals("gasburst-4",out.single().frameKey)
        p.transientSprites(9f,out);assertTrue(out.isEmpty())
        p.transientSprites(4.5f,out);assertEquals(midpoint,out);assertEquals(2,model.destroyedTick("wall"))
        plan("theodor",brownArt(),listOf(snotDeploy)).transientSprites(4.5f,out);assertTrue(out.isEmpty())
        plan("theodor",brownArt(),listOf(snotDeploy,brownCast.replace("\"x\":200","\"x\":-200"))).transientSprites(4.5f,out)
        assertEquals(-100f,out.single().x);assertFalse(out.single().flipX)
    }
    @Test fun `Brown Note absent caster holds at event target for its distinct fallback clock`() {
        val out=mutableListOf<CombatSprite>();val death="""{"t":2,"e":"troopDeath","id":1}"""
        for(events in listOf(listOf(brownCast),listOf(snotDeploy,death,brownCast))) {
            val p=plan("theodor",brownArt(),events)
            p.transientSprites(4.5f,out);assertEquals(200f,out.single().x);assertEquals(300f,out.single().y)
            p.transientSprites(7.99f,out);assertEquals("gasburst-4",out.single().frameKey)
            p.transientSprites(8f,out);assertTrue(out.isEmpty())
        }
        plan("theodor",brownArt(),listOf(snotDeploy,brownCast,death)).transientSprites(4.5f,out)
        assertEquals(100f,out.single().x,"A death after casting must not retroactively move the launch to the target")
    }
    @Test fun `rally is recognized without inventing a world animation absent from the canonical scene`() {
        val art=CombatArt(emptyMap(),JsonReader().parse("{}"),emptyMap(),emptyMap(),0f,0f)
        val p=plan("vex",art,listOf("""{"e":"rally","t":0,"x":100,"y":100}"""))
        val out=mutableListOf<CombatSprite>();p.transientSprites(0f,out)
        assertTrue(out.isEmpty());assertTrue(p.missingCoverage.isEmpty())
    }
    @Test fun `hero external sweep holds its final frame and survives body death until its own expiry`() {
        val effect=clip("coin",3,10f).copy(anchorY=.5f)
        val art=CombatArt(mapOf("idle" to clip("idle")),JsonReader().parse("""{"stand":"idle"}"""),emptyMap(),emptyMap(),0f,0f,
            heroEffects=mapOf("doubleOrNothingTails:impact" to HeroEffectPhase(listOf(HeroSweep(effect,500f,99f)),false)))
        val events=listOf("""{"t":0,"e":"deploy","id":1,"troop":"highlander","hero":"vex","x":100,"y":100}""",
            """{"t":1,"e":"heroSkill","id":1,"skill":"doubleOrNothingTails","phase":"impact","x":200,"y":300}""",
            """{"t":2,"e":"troopDeath","id":1}""","""{"t":10,"e":"star","n":1}""")
        val p=plan("vex",art,events);val out=mutableListOf<CombatSprite>()
        p.transientSprites(.99f,out);assertTrue(out.isEmpty())
        p.transientSprites(1f,out);assertEquals("coin-1",out.single().frameKey)
        p.transientSprites(5.99f,out);assertEquals("coin-3",out.single().frameKey);val hold=out.toList()
        assertEquals(200f,out.single().x);assertEquals(300f,out.single().y)
        p.transientSprites(6f,out);assertTrue(out.isEmpty())
        p.transientSprites(5.99f,out);assertEquals(hold,out)
        assertFalse(p.missingCoverage.any { it.startsWith("heroEffects:") })
        val replaced=plan("vex",art,events.map { it.replace("\"x\":200","\"x\":250") })
        replaced.transientSprites(1f,out);assertEquals(250f,out.single().x)
    }
    @Test fun `dash position and final-frame hold reconstruct across seek and prediction replacement`() {
        val trail=clip("trail",3,12.5f)
        val art=CombatArt(mapOf("idle" to clip("idle")),JsonReader().parse("""{"stand":"idle"}"""),emptyMap(),emptyMap(),0f,0f,
            heroBodyDefaultTicks=mapOf("default" to 5),heroEffects=mapOf("crimsonDash:impact" to HeroEffectPhase(listOf(HeroSweep(trail,700f,99f,200f)),false)))
        val deployment="""{"t":0,"e":"deploy","id":1,"troop":"highlander","hero":"vex","x":100,"y":100}"""
        val dash="""{"t":1,"e":"heroSkill","id":1,"skill":"crimsonDash","phase":"impact","x":100,"y":100,"fromX":100,"fromY":100,"toX":300,"toY":200}"""
        val p=plan("vex",art,listOf(deployment,dash))
        val out=mutableListOf<CombatSprite>()
        p.transientSprites(3.5f,out);assertEquals(200f,out.single().x);assertEquals(150f,out.single().y)
        p.transientSprites(7f,out);assertEquals(300f,out.single().x);assertEquals("trail-3",out.single().frameKey)
        p.transientSprites(2f,out);assertEquals(140f,out.single().x)
        p.transientSprites(8f,out);assertTrue(out.isEmpty())
        plan("vex",art,listOf(deployment)).transientSprites(3.5f,out);assertTrue(out.isEmpty())
    }

    @Test fun `radial hero nova and crescents preserve world facing and reconstruct without duplicate spokes`() {
        val crescent=clip("crescent",3,1000f/90f)
        val nova=clip("nova",4,1000f/90f)
        val offsets=listOf(0f to -384f,-271.5f to 271.5f,384f to 0f)
        val art=CombatArt(mapOf("idle" to clip("idle")),JsonReader().parse("""{"stand":"idle"}"""),emptyMap(),emptyMap(),0f,0f,
            heroBodyDefaultTicks=mapOf("default" to 5),heroEffects=mapOf("omegaShardstorm:impact" to HeroEffectPhase(
                listOf(HeroSweep(nova,560f,99f))+offsets.map { HeroSweep(crescent,700f,99f,200f,it) },false)))
        val deployed="""{"t":0,"e":"deploy","id":1,"troop":"highlander","hero":"vex","x":100,"y":100}"""
        val cast="""{"t":1,"e":"heroSkill","id":1,"skill":"omegaShardstorm","phase":"impact","x":200,"y":300,"toX":0,"toY":0}"""
        val p=plan("vex",art,listOf(deployed,cast))
        val out=mutableListOf<CombatSprite>()
        p.transientSprites(.99f,out);assertTrue(out.isEmpty())
        p.transientSprites(3.5f,out)
        assertEquals(4,out.size);assertEquals(200f,out.single { it.clip==nova }.x)
        val travel=out.filter { it.clip==crescent }
        offsets.zip(travel).forEach { (offset,sprite) ->
            assertEquals(200f+offset.first/2,sprite.x);assertEquals(300f+offset.second/2,sprite.y)
            assertFalse(sprite.flipX,"Canonical image sweeps do not mirror with caster facing")
        }
        val middle=out.toList()
        p.transientSprites(7f,out);assertEquals(3,out.size)
        offsets.zip(out).forEach { (offset,sprite) ->
            assertEquals(200f+offset.first,sprite.x);assertEquals(300f+offset.second,sprite.y)
            assertEquals("crescent-3",sprite.frameKey)
        }
        p.transientSprites(8f,out);assertTrue(out.isEmpty())
        p.transientSprites(3.5f,out);assertEquals(middle,out)
        plan("vex",art,listOf(deployed)).transientSprites(3.5f,out);assertTrue(out.isEmpty())
        plan("vex",art,listOf(deployed,cast.replace("\"x\":200","\"x\":500"))).transientSprites(3.5f,out)
        assertEquals(middle.map { it.x+300f },out.map { it.x })
    }

    @Test fun `repeated hero wall attacks keep authored phase and mirror west`() {
        val art = CombatArt(mapOf("attack_e" to clip("attack",6,4f),"idle" to clip("idle")),
            JsonReader().parse("""{"stand":"idle","attack":["attack_e"]}"""),emptyMap(),emptyMap(),0f,0f)
        val events = listOf("""{"t":0,"e":"deploy","id":1,"troop":"highlander","hero":"vex","x":100,"y":100}""") +
            (0..6).map { """{"t":$it,"e":"heroAttack","id":1,"ix":0,"iy":100,"recoveryUntil":${it+3}}""" }
        val p = plan("vex",art,events)
        assertEquals("attack-3",p.actor(1,6f)!!.frameKey)
        assertTrue(p.actor(1,6f)!!.flipX)
    }

    private fun moonArt()=CombatArt(mapOf("idle" to clip("idle").copy(anchorX=.25f,anchorY=.75f)),
        JsonReader().parse("""{"stand":"idle","move":"idle"}"""),emptyMap(),emptyMap(),0f,0f,
        heroBodyDefaultTicks=mapOf("default" to 5),heroEffects=mapOf("moonsunderWave:impact" to HeroEffectPhase(listOf(
            HeroSweep(clip("wave",3,1000f/90f),700f,99f,200f,rangePx=100f),
            HeroSweep(clip("bleed",2,1000f/120f),440f,99f,targetActorCenterAtCast=true)),false)))
    private val moonDeploy="""{"t":0,"e":"deploy","id":1,"troop":"highlander","hero":"vex","x":10,"y":20}"""
    private val victimDeploy="""{"t":0,"e":"deploy","id":2,"troop":"highlander","hero":"vex","x":200,"y":300}"""
    private val moonCast="""{"t":1,"e":"heroSkill","id":1,"skill":"moonsunderWave","phase":"impact","x":10,"y":20,"toX":13,"toY":24,"target":2}"""
    @Test fun `Moonsunder projects to authored range without mirroring and reconstructs replacement or zero direction`() {
        val out=mutableListOf<CombatSprite>();val p=plan("vex",moonArt(),listOf(moonDeploy,victimDeploy,moonCast))
        p.transientSprites(3.5f,out)
        val wave=out.single { it.clip.key=="wave" }
        assertEquals(40f,wave.x);assertEquals(60f,wave.y);assertFalse(wave.flipX)
        val middle=out.toList()
        p.transientSprites(7f,out);assertEquals(70f,out.single().x);assertEquals(100f,out.single().y)
        p.transientSprites(8f,out);assertTrue(out.isEmpty())
        p.transientSprites(3.5f,out);assertEquals(middle,out)
        plan("vex",moonArt(),listOf(moonDeploy,victimDeploy,moonCast.replace("\"toX\":13","\"toX\":7").replace("\"toY\":24","\"toY\":16"))).transientSprites(3.5f,out)
        assertEquals(-20f,out.single { it.clip.key=="wave" }.x);assertEquals(-20f,out.single { it.clip.key=="wave" }.y)
        plan("vex",moonArt(),listOf(moonDeploy,victimDeploy,moonCast.replace("\"toX\":13","\"toX\":10").replace("\"toY\":24","\"toY\":20"))).transientSprites(3.5f,out)
        assertEquals(10f,out.single { it.clip.key=="wave" }.x);assertEquals(20f,out.single { it.clip.key=="wave" }.y)
        plan("vex",moonArt(),listOf(moonDeploy,victimDeploy)).transientSprites(3.5f,out);assertTrue(out.isEmpty())
    }
    @Test fun `bleed captures only a living named troop center at its exact event order and never follows later movement`() {
        val out=mutableListOf<CombatSprite>()
        val moved="""{"t":1,"e":"emerge","id":2,"x":500,"y":600}"""
        val dead="""{"t":1,"e":"troopDeath","id":2}"""
        val p=plan("vex",moonArt(),listOf(moonDeploy,victimDeploy,moonCast,moved,dead))
        p.transientSprites(4f,out)
        assertEquals(202.5f,out.single { it.clip.key=="bleed" }.x)
        assertEquals(295f,out.single { it.clip.key=="bleed" }.y)
        p.transientSprites(5.4f,out);assertTrue(out.none { it.clip.key=="bleed" })
        p.transientSprites(1f,out);assertEquals(202.5f,out.single { it.clip.key=="bleed" }.x)
        for(events in listOf(listOf(moonDeploy,victimDeploy,dead,moonCast),
            listOf(moonDeploy,victimDeploy,moonCast.replace("\"target\":2","\"target\":\"2\"")),
            listOf(moonDeploy,moonCast,victimDeploy.replace("\"t\":0","\"t\":1")))) {
            plan("vex",moonArt(),events).transientSprites(1f,out);assertTrue(out.none { it.clip.key=="bleed" })
        }
        plan("vex",moonArt(),listOf(moonDeploy,victimDeploy,moved,moonCast)).transientSprites(1f,out)
        assertEquals(502.5f,out.single { it.clip.key=="bleed" }.x)
    }
    @Test fun `bleed captures the visible cadence-limited tween position rather than its last recorded endpoint`() {
        val out=mutableListOf<CombatSprite>()
        val victim=victimDeploy.replace("\"x\":200","\"x\":0").replace("\"y\":300","\"y\":0")
        fun capture(castTick: Int,endTick: Int): Pair<Float,Float> {
            val events=listOf(moonDeploy,victim,moonCast.replace("\"t\":1","\"t\":$castTick"),
                """{"t":$endTick,"e":"pos","id":2,"x":100,"y":200}""").map(::event)
            val scene=BattleScene(BaseScene(emptyList(),10,10,256f),PresentationRevision("raid","revision",14,0,0,events),
                mapOf("vex" to "actor"),256f,100f,5,5)
            val p=CombatVisualPlan(scene,BattleVisualModel(events,5),mapOf("actor" to moonArt()))
            p.transientSprites(castTick.toFloat()+1,out)
            val bleed=out.single { it.clip.key=="bleed" };val fixed=bleed.x to bleed.y
            p.transientSprites(castTick.toFloat()+4,out)
            assertEquals(fixed,out.single { it.clip.key=="bleed" }.let { it.x to it.y },"The cast captures a center; later movement must not drag bleed")
            return fixed
        }
        assertEquals(42.5f to 75f,capture(2,5),"Canonical five-tick movement is 40% complete at cast tick2")
        assertEquals(102.5f to 195f,capture(5,5),"Normal same-tick endpoint was already tweening before the cast")
        assertEquals(2.5f to -5f,capture(10,20),"A long idle gap must not smear movement before the final cadence")
        assertEquals(42.5f to 75f,capture(17,20))
    }
    @Test fun `hero fake death body wins over attacks and completes all frames inside canonical lock`() {
        val art = CombatArt(mapOf("attack_e" to clip("attack"),"playdead" to clip("fake",5,4f),"idle" to clip("idle")),
            JsonReader().parse("""{"stand":"idle","attack":["attack_e"],"heroSkills":{"rageQuit:fakeDeath":{"state":"playdead","priority":4,"once":true}}}"""),
            emptyMap(),emptyMap(),0f,0f,heroBodyDefaultTicks=mapOf("default" to 5))
        val p=plan("theodor",art,listOf(
            """{"t":0,"e":"deploy","id":1,"troop":"highlander","hero":"theodor","x":100,"y":100}""",
            """{"t":1,"e":"heroSkill","id":1,"skill":"rageQuit","phase":"fakeDeath","until":6}""",
            """{"t":2,"e":"heroAttack","id":1,"ix":0,"iy":100,"recoveryUntil":4}""",
            """{"t":10,"e":"star","n":1}"""))
        assertEquals("fake-1",p.actor(1,1f)!!.frameKey)
        assertEquals("fake-5",p.actor(1,5.99f)!!.frameKey)
        assertTrue(p.actor(1,6f)!!.frameKey.startsWith("idle"))
    }
    @Test fun `dragon stream connects to target only in authored release window and reconstructs on seek`() {
        val body=clip("breath",8,10f).copy(fxCues=mapOf("breath" to listOf(3,4,5)))
        val breath=BreathArt(30f,clip("root"),clip("mid").copy(anchorX=0f),clip("tip"),clip("close"),clip("burn"))
        val art=CombatArt(mapOf("breath" to body,"hover" to clip("hover")),
            JsonReader().parse("""{"stand":"hover","attack":["breath"]}"""),emptyMap(),emptyMap(),0f,0f,breathStream=breath)
        val p=plan("dragon",art,listOf(
            """{"t":0,"e":"deploy","id":1,"troop":"dragon","x":100,"y":100}""",
            """{"t":1,"e":"troopFire","id":1,"ix":200,"iy":100}""",
            """{"t":12,"e":"star","n":1}"""))
        val out= mutableListOf<CombatSprite>()
        p.transientSprites(2.99f,out);assertTrue(out.isEmpty())
        p.transientSprites(3f,out)
        assertEquals(1,out.count { it.clip.key=="root" });assertEquals(1,out.count { it.clip.key=="tip" })
        assertEquals(200f,out.single { it.clip.key=="tip" }.x)
        val first=out.toList();p.transientSprites(10f,out);assertTrue(out.isEmpty())
        p.transientSprites(3f,out);assertEquals(first,out)
        p.transientSprites(6f,out);assertTrue(out.none { it.clip.key in setOf("root","mid","tip") })
    }
    @Test fun `same cast burnfields coexist while next cast replaces old patches and expiry uses authored tail`() {
        val art=CombatArt(mapOf("hover" to clip("hover")),JsonReader().parse("""{"stand":"hover"}"""),emptyMap(),emptyMap(),0f,0f,
            burnfield=BurnfieldArt(clip("fire",4,10f),listOf(1,2),listOf(3,4)))
        val p=plan("direwyvern",art,listOf(
            """{"t":0,"e":"deploy","id":1,"troop":"direwyvern","x":100,"y":100}""",
            """{"t":1,"e":"burnfield","id":1,"x":10,"y":10,"until":20}""",
            """{"t":1,"e":"burnfield","id":1,"x":20,"y":10,"until":20}""",
            """{"t":5,"e":"burnfield","id":1,"x":30,"y":10,"until":8}""",
            """{"t":15,"e":"burnfield","id":1,"x":40,"y":10,"until":18}""",
            """{"t":30,"e":"star","n":1}"""))
        val out= mutableListOf<CombatSprite>();p.transientSprites(2f,out);assertEquals(2,out.size)
        p.transientSprites(5f,out);assertEquals(1,out.size);assertEquals(30f,out.single().x)
        p.transientSprites(8f,out);assertEquals("fire-3",out.single().frameKey)
        p.transientSprites(9f,out);assertEquals("fire-4",out.single().frameKey)
        p.transientSprites(10f,out);assertTrue(out.isEmpty())
        p.transientSprites(2f,out);assertEquals(2,out.size)
    }
}
