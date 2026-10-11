package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.utils.JsonReader
import org.junit.Test
import kotlin.test.*

class BattlefieldInputTest {
    private val fixture = JsonReader().parse(requireNotNull(javaClass.getResourceAsStream("/battlefield.parity.json")))
    private val policy = fixture.get("policy")
    private fun field() = BattlefieldInputPolicy(2,1,2,-34,64,2,28,setOf(14 to 14,15 to 14,14 to 15,15 to 15),1)
    @Test fun `native legality matches the source authoritative frozen parity cases`() {
        val occupied = fixture.get("occupiedRects").flatMap { b ->
            (0 until b.getInt("fh")).flatMap { dy -> (0 until b.getInt("fw")).map { dx -> b.getInt("tx")+dx to b.getInt("ty")+dy } }
        }.toSet()
        for (case in fixture.get("cases")) {
            val context = case.get("context")
            val version = context.getInt("battlefieldVersion",policy.getInt("legacyVersion"))
            val blockers = if(version!=policy.getInt("legacyVersion")) context.get("deploymentBlockers")?.flatMap { b ->
                (0 until b.getInt("fh")).flatMap { dy -> (0 until b.getInt("fw")).map { dx -> b.getInt("tx")+dx to b.getInt("ty")+dy } }
            }.orEmpty() else emptyList()
            val margin = policy.get("marginTilesByVersion").getInt(version.toString())
            val subject = BattlefieldInputPolicy(version,policy.getInt("legacyVersion"),policy.getInt("currentVersion"),
                -margin,30+margin,context.getInt("claimMin",2),context.getInt("claimMax",28),occupied+blockers,policy.getInt("snapRadiusTiles"),
                if(version==3) policy.getInt("deploymentSquareTiles") else null)
            assertEquals(case.getBoolean("legal"),subject.legal(case.getInt("tx"),case.getInt("ty")),case.getString("name"))
        }
    }
    private fun clearanceField(free: Set<Pair<Int,Int>>): BattlefieldInputPolicy {
        val bounds = (-4 until 6).flatMap { y -> (-4 until 6).map { x -> x to y } }.toSet()
        return BattlefieldInputPolicy(3,1,3,-4,6,-2,4,bounds-free,1,policy.getInt("deploymentSquareTiles"))
    }
    @Test fun `each corner of a fully empty square is legal without fixing the tap to its origin`() {
        val square=setOf(0 to 0,1 to 0,0 to 1,1 to 1)
        val subject=clearanceField(square)
        for((x,y) in square) {
            assertTrue(subject.legal(x,y),"Any of the four cells may be selected")
            assertEquals(x to y,subject.nearest(x+.5f,y+.5f))
        }
        assertFalse(subject.legal(2,0))
        assertNull(subject.nearest(4.5f,4.5f))
    }
    @Test fun `isolated holes incomplete squares and one tile corridors cannot deploy troops or heroes`() {
        val layouts=listOf(setOf(0 to 0),setOf(0 to 0,1 to 0,0 to 1),
            (-4 until 6).map {0 to it}.toSet(),(-4 until 6).map {it to 0}.toSet(),
            setOf(0 to 0,1 to 1,2 to 2,3 to 3))
        for(free in layouts) {
            val subject=clearanceField(free)
            for((x,y) in free) {
                assertFalse(subject.legal(x,y))
                assertNull(subject.nearest(x+.5f,y+.5f),"Snapping must use the same clearance as final validation")
                assertTrue(subject.copy(version=2,deploymentSquareTiles=null).legal(x,y),"Archived v2 retains the single-cell rule")
            }
        }
    }
    @Test fun `clearance must fit inside the field and all four field corners stay reachable`() {
        val subject=field().copy(version=3,currentVersion=3,occupied=emptySet(),deploymentSquareTiles=policy.getInt("deploymentSquareTiles"))
        for(x in listOf(subject.minimum,subject.maximum-1)) for(y in listOf(subject.minimum,subject.maximum-1)) {
            assertTrue(subject.legal(x,y))
            val blocked=subject.copy(occupied=setOf((if(x==subject.minimum)x+1 else x-1) to y))
            assertFalse(blocked.legal(x,y),"A square extending beyond the battlefield cannot bypass its blocked inside neighbour")
        }
        assertFalse(subject.legal(subject.minimum-1,0));assertFalse(subject.legal(subject.maximum,0))
        assertFailsWith<IllegalArgumentException> {subject.copy(version=4,currentVersion=4)}
        assertFailsWith<IllegalArgumentException> {subject.copy(deploymentSquareTiles=null)}
        assertFailsWith<IllegalArgumentException> {subject.copy(deploymentSquareTiles=0)}
    }
    @Test fun `nearby placement is deterministic visible and cannot snap an out of field touch`() {
        val f=field()
        assertEquals(13 to 14,f.nearest(14.01f,14.5f))
        assertEquals(14 to 13,f.nearest(14.5f,14.5f))
        assertEquals(13 to 14,f.nearest(14.5f,14.5f) { _,y -> y>=14 })
        assertNull(f.nearest(14.5f,14.5f) { _,_ -> false })
        assertNull(f.nearest(-34.01f,0f));assertNull(f.nearest(64f,0f));assertNull(f.nearest(Float.NaN,0f))
        assertEquals(15 to -7,f.nearest(15.5f,-6.5f))
        assertFailsWith<IllegalArgumentException> {f.copy(version=3)}
    }
    private val mode=BattleDeploymentMode("raid:dragon",260,120,12f,true)
    private fun advance(g:BattleDeploymentGesture,from:Long,to:Long):List<Long> =
        (from..to step 10).filter {g.frame(it,mode)}
    @Test fun `tap and hold drag deploy exactly once per interval with no release duplicate`() {
        val g=BattleDeploymentGesture()
        g.down(0f,0f,0,mode);assertTrue(g.up(2f,1f));assertFalse(g.up(2f,1f))
        g.down(0f,0f,0,mode)
        assertEquals(listOf(260L,380L,500L),advance(g,0,500))
        assertFalse(g.move(90f,80f),"A confirmed hold moves deployment, not camera")
        assertFalse(g.up(90f,80f))
    }
    @Test fun `pan pinch HUD cancellation and selection changes never deploy on lift`() {
        val g=BattleDeploymentGesture()
        g.down(0f,0f,0,mode);assertTrue(g.move(8f,8f));assertTrue(advance(g,0,500).isEmpty());assertFalse(g.up(0f,0f))
        g.down(0f,0f,0,mode);g.pan();assertTrue(g.move(5f,5f));assertTrue(advance(g,0,500).isEmpty());assertFalse(g.up(0f,0f))
        g.down(0f,0f,0,mode);g.cancel();assertFalse(g.up(0f,0f))
        g.down(0f,0f,0,mode);g.sync(mode.copy(identity="raid:hero"));assertFalse(g.up(0f,0f))
    }
    @Test fun `a stalled or interrupted frame cannot replay missed deploy beats`() {
        val g=BattleDeploymentGesture();g.down(0f,0f,0,mode)
        assertFalse(g.frame(1000,mode),"A stalled first frame cannot manufacture a hold")
        assertEquals(listOf(1260L),advance(g,1010,1300))
        assertFalse(g.frame(5000,mode));assertEquals(listOf(5120L),advance(g,5010,5200))
        g.cancel();assertFalse(g.frame(5400,mode));assertFalse(g.up(0f,0f))
    }
    @Test fun `hero hold is single shot and never repeats on drag or release`() {
        val hero=mode.copy(repeat=false);val g=BattleDeploymentGesture();g.down(0f,0f,0,hero)
        val emitted=(0L..1000 step 10).filter {g.frame(it,hero)}
        assertEquals(listOf(260L),emitted);assertFalse(g.up(0f,0f))
    }
    // The authored battle band (fitExpandedBattleFrame) still spans the field; since D-185 (2026-09-27) the scene bounds its zoom-out
    // by the drawn field covering the surface (drawnWorldFrame, DrawnWorldCameraTest) and reaches the field corners by panning.
    @Test fun `expanded camera enters focused and its authored band fits every field corner`() {
        val f=field();val spec=BattleCameraSpec(.14f,1.6f,1.1f,0f,4f)
        for((w,h) in listOf(390 to 844,844 to 390,1080 to 2400)) {
            val inset=CameraInsets(top=60,bottom=80)
            val frame=fitExpandedBattleFrame(f,spec,w,h,1f,64f,inset)
            val visible=inset.visible(w,h)!!
            assertTrue(frame.zoom<frame.maxZoom,"Entry must not open at whole-field scale")
            assertTrue(visible.width*frame.maxZoom >= 98*64-.1f)
            assertTrue(visible.height*frame.maxZoom >= 98*64-.1f)
            assertEquals(15f*64,frame.center)
        }
        assertEquals(15f,clampBattleCameraAxis(400f,120f,-34f,64f))
        assertEquals(59f,clampBattleCameraAxis(400f,10f,-34f,64f))
    }
}
