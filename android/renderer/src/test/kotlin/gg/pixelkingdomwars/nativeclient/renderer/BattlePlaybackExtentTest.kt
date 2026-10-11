package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.utils.JsonReader
import org.junit.Test
import kotlin.test.*

class BattlePlaybackExtentTest {
    private fun clip(name: String, frames: Int = 1, fps: Float = 10f) = AuthoredClip(name,"atlas/fx.json",
        listOf(List(frames) { "$name-$it" }),listOf("s"),fps,.5f,1f,1f,10f,10f,false,null,emptyMap())
    private fun art(clips: Map<String,AuthoredClip>, profile: String = "{}") =
        CombatArt(clips,JsonReader().parse(profile),emptyMap(),emptyMap(),0f,0f)
    private val deploy = """{"t":0,"e":"deploy","id":1,"troop":"theodor","x":0,"y":0}"""
    private fun plan(events: List<String>, actor: CombatArt, buildings: List<RenderBuilding> = emptyList(),
                     library: Map<String,CombatArt> = emptyMap(), wallCatalogue: WallCatalogue? = null): CombatVisualPlan {
        val parsed = events.map(PresentationEvent::fromJson)
        val scene = BattleScene(BaseScene(buildings,16,16,256f),PresentationRevision("raid","revision",14,0,0,parsed),
            mapOf("theodor" to "actor"),256f,100f,5,5)
        val walls = wallCatalogue?.let { WallVisualModel(buildings,it,parsed) }
        return CombatVisualPlan(scene,BattleVisualModel(parsed,5),library + ("actor" to actor),walls=walls)
    }

    @Test fun `last event missing caster effect finishes without a fabricated later event`() {
        val fx = clip("snot",4)
        val actor = art(emptyMap()).copy(heroEffects=mapOf("snotRocket:impact" to
            HeroEffectPhase(listOf(HeroSweep(fx,700f,1f,200f,actorToEventFallbackMs=560f)),false)))
        val plan = plan(listOf("""{"t":1,"e":"heroSkill","id":1,"hero":"theodor","skill":"snotRocket","x":20,"y":30}"""),actor)
        assertEquals(BattlePlaybackExtent(1f,6.6f),plan.playbackExtent)
        val out = mutableListOf<CombatSprite>()
        plan.transientSprites(6.59f,out);assertEquals("snot-3",out.single().frameKey)
        plan.transientSprites(plan.playbackExtent.visualEndTick,out);assertTrue(out.isEmpty())
        plan.transientSprites(1f,out);assertEquals("snot-0",out.single().frameKey)
    }

    @Test fun `projectile endpoint includes impact after final shot and disappears at visual end`() {
        val actor = art(mapOf("attack" to clip("attack")),"""{"attack":["attack"],"ranged":{"state":"attack","projectile":"bolt","releaseFrame":1}}""")
            .copy(projectiles=mapOf("bolt" to ProjectileProfile(clip("bolt"),clip("impact",2),null,350f,0f,1f,0f)))
        val plan = plan(listOf(deploy,"""{"t":1,"e":"troopFire","id":1,"ix":100,"iy":100}"""),actor)
        assertEquals(BattlePlaybackExtent(1f,6.5f),plan.playbackExtent)
        val out = mutableListOf<CombatSprite>()
        plan.transientSprites(5f,out);assertEquals("impact-0",out.single().frameKey)
        plan.transientSprites(6.5f,out);assertTrue(out.isEmpty())
    }

    @Test fun `rounded terminal tick reaches effect expiry instead of retaining its last frame forever`() {
        val actor = art(emptyMap()).copy(heroEffects=mapOf("snotRocket:impact" to
            HeroEffectPhase(listOf(HeroSweep(clip("snot",4),700f,1f,200f,actorToEventFallbackMs=560f)),false)))
        val plan = plan(listOf("""{"t":27,"e":"heroSkill","id":1,"hero":"theodor","skill":"snotRocket","x":20,"y":30}"""),actor)
        val end = plan.playbackExtent.visualEndTick
        assertEquals(27f,plan.playbackExtent.eventEndTick)
        assertTrue(end * 100f >= 3260f)
        assertTrue(Math.nextDown(end) * 100f < 3260f)
        val out = mutableListOf<CombatSprite>()
        plan.transientSprites(Math.nextDown(end),out);assertEquals("snot-3",out.single().frameKey)
        plan.transientSprites(end,out);assertTrue(out.isEmpty())
    }

    @Test fun `death tail includes authored hold and fade while idle loops remain bounded`() {
        val actor = art(mapOf("death" to clip("death",4),"idle" to clip("idle",10000)),"""{"stand":"idle"}""")
            .copy(deathHoldMs=100f,deathFadeMs=200f)
        val death = plan(listOf(deploy,"""{"t":1,"e":"troopDeath","id":1}"""),actor)
        assertEquals(BattlePlaybackExtent(1f,8f),death.playbackExtent)
        assertNotNull(death.actor(1,7.9f));assertNull(death.actor(1,8f))
        val idle = plan(listOf(deploy,"""{"t":1,"e":"rally","x":0,"y":0}"""),actor)
        assertEquals(BattlePlaybackExtent(1f,1f),idle.playbackExtent)
    }

    @Test fun `replaced burnfield cannot extend the tail past its replacement extinguish frames`() {
        val actor = art(emptyMap()).copy(burnfield=BurnfieldArt(clip("burn",4),listOf(1,2),listOf(3,4)))
        val plan = plan(listOf(deploy,"""{"t":1,"e":"burnfield","id":1,"x":0,"y":0,"until":20}""",
            """{"t":2,"e":"burnfield","id":1,"x":0,"y":0,"until":3}"""),actor)
        assertEquals(BattlePlaybackExtent(2f,5f),plan.playbackExtent)
        val out = mutableListOf<CombatSprite>()
        plan.transientSprites(4.9f,out);assertEquals("burn-3",out.single().frameKey)
        plan.transientSprites(5f,out);assertTrue(out.isEmpty())
    }

    @Test fun `destroyed wall uses its actual connected collapse clip for the endpoint`() {
        val catalogue = WallCatalogue(JsonReader().parse("""{"walls":[${(0..15).joinToString { """{"level":1,"mask":$it,"frameKey":"w$it"}""" }}]}"""))
        val buildings = listOf(RenderBuilding("a","w0",0f,0f,1f,1f),RenderBuilding("b","w0",1f,0f,1f,1f))
        val library = (0..15).associate { "w$it" to art(mapOf("collapse" to clip("collapse$it",if(it==2) 6 else 1))) }
        val plan = plan(listOf("""{"t":1,"e":"destroyed","id":"a"}"""),art(emptyMap()),buildings,library,catalogue)
        assertEquals(BattlePlaybackExtent(1f,7f),plan.playbackExtent)
        assertEquals("collapse2-5",plan.building("a",7f,frameKey="w2")!!.frameKey)
    }

    @Test fun `invalid extents cannot create endless or negative playback`() {
        for((event,end) in listOf(-1f to 1f,1f to 0f,0f to Float.POSITIVE_INFINITY,Float.NaN to 2f))
            assertFailsWith<IllegalArgumentException> { BattlePlaybackExtent(event,end) }
    }

    @Test fun `terminal replacement reconstructs at actual progress without replaying an in progress tail`() {
        val events = listOf(PresentationEvent.fromJson("""{"t":70,"e":"rally","x":0,"y":0}"""))
        val terminal = BattleScene(BaseScene(emptyList(),16,16,256f),PresentationRevision("raid","terminal",14,0,0,events),
            emptyMap(),256f,100f,5,5,playheadTick=70f,retainPlaybackTick=true)
        val extent = BattlePlaybackExtent(70f,78f)
        fun previous(revision: String, tick: Float, raid: String="raid") = BattlePlaybackFrame(raid,revision,tick,BattlePlaybackExtent(80f,88f))
        assertEquals(65f,initialBattleTick(terminal,extent,previous("prediction",65f)))
        assertEquals(75f,initialBattleTick(terminal,extent,previous("prediction",75f)))
        assertEquals(75f,initialBattleTick(terminal,extent,previous("terminal",75f)))
        assertEquals(78f,initialBattleTick(terminal,extent,previous("prediction",85f)))
        assertEquals(72f,initialBattleTick(terminal,BattlePlaybackExtent(70f,72f),previous("prediction",75f)))
        assertEquals(70f,initialBattleTick(terminal,extent,previous("prediction",65f,"other")))
        assertEquals(70f,initialBattleTick(terminal,extent,null))
        assertEquals(0f,initialBattleTick(terminal.copy(playheadTick=0f,retainPlaybackTick=false),extent,previous("terminal",75f)))
    }
}
