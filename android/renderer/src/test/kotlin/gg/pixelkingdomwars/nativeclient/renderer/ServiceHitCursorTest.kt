package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.utils.JsonReader
import kotlin.test.*
import org.junit.Test

class ServiceHitCursorTest {
    private val policy=HitFeedbackPolicy.parse(JsonReader().parse(checkNotNull(javaClass.getResourceAsStream("/hit-feedback/source-reference.json")).bufferedReader().readText()).get("policy"))!!
    private fun cue(ordinal:Int=0,tick:Int=10)=HitFeedbackCue(HitTarget.Building("workshop"),tick,ordinal,80f,160f,ServiceHitAnchor("workshop",ServiceCombatState.IDLE))
    private fun y(height:Float)=160f-minOf(height*policy.buildingHeightFactor,policy.buildingLiftMax)
    @Test fun `emission binds current verified height and later permission loss cannot move the original spark`() {
        val cursor=ServiceHitCursor();val request=Any();assertFalse(cursor.adopt(request))
        var height=112f;var resolves=0
        fun resolve(cue:HitFeedbackCue)=cursor.y(cue,policy) { resolves++;height }
        assertEquals(y(112f),resolve(cue()));height=HIDDEN_SERVICE_BODY_HEIGHT
        assertTrue(cursor.adopt(request),"Permission, source and resume refresh retain their external request owner")
        assertEquals(y(112f),resolve(cue()));assertEquals(1,resolves)
        assertEquals(y(HIDDEN_SERVICE_BODY_HEIGHT),resolve(cue(1,11)),"Only a newly emitted cue sees revoked pixels")
        assertFalse(cursor.adopt(Any()),"External scene or revision cannot inherit an old cue")
        assertEquals(y(HIDDEN_SERVICE_BODY_HEIGHT),resolve(cue()));assertEquals(3,resolves)
    }
    @Test fun `held first emission stays held after admission while expiry seek and base switch release positions`() {
        val cursor=ServiceHitCursor();cursor.adopt(Any());var height=HIDDEN_SERVICE_BODY_HEIGHT
        fun resolve()=cursor.y(cue(),policy) { height }
        assertEquals(y(height),resolve());height=112f;assertEquals(y(HIDDEN_SERVICE_BODY_HEIGHT),resolve())
        cursor.retainVisible(10+policy.starMs/100,0f,100f,policy.starMs);assertEquals(y(112f),resolve())
        height=HIDDEN_SERVICE_BODY_HEIGHT;cursor.clear();assertEquals(y(height),resolve(),"Explicit seek clears binding")
        height=112f;cursor.retainVisible(10f,11f,100f,policy.starMs);assertEquals(y(height),resolve(),"New cold floor excludes old cues")
        height=HIDDEN_SERVICE_BODY_HEIGHT;assertFalse(cursor.adopt(null));assertEquals(y(height),resolve(),"Home/account teardown releases prior battle")
    }
    @Test fun `only visible cues resolve and positions are reused through source frame changes`() {
        val c=cue();val plan=HitFeedbackPlan(policy,listOf(c),100f);val cursor=ServiceHitCursor();var resolves=0
        val output=mutableListOf<CombatSprite>()
        fun draw(tick:Float,from:Float=0f):List<CombatSprite> {
            output.clear();cursor.retainVisible(tick,from,100f,policy.starMs)
            plan.sprites(tick,from,output) { cursor.y(it,policy) { resolves++;112f } };return output.toList()
        }
        assertTrue(draw(9f).isEmpty());assertEquals(0,resolves)
        val first=draw(10f).single();val second=draw(10+policy.starFrameTimes[1]/100).single()
        assertNotEquals(first.frameKey,second.frameKey);assertEquals(first.y,second.y);assertEquals(1,resolves)
        assertEquals(c,first.serviceHit)
        assertTrue(draw(10+policy.starMs/100).isEmpty());assertTrue(draw(10f,11f).isEmpty());assertEquals(1,resolves)
    }
    @Test fun `placeholder dimensions are bound to the pinned source PNG not a gameplay number`() {
        val source=JsonReader().parse(checkNotNull(javaClass.getResourceAsStream("/hit-feedback/hidden-service-body.json")).bufferedReader().readText())
        // 2026-10-10 (D21): 427381a2's hidden pending service body is Phaser's __MISSING image, not the retired __WHITE.
        assertEquals("images.missing",source.getString("image"))
        assertEquals(source.getFloat("height"),HIDDEN_SERVICE_BODY_HEIGHT)
        assertEquals(source.getFloat("width"),HIDDEN_SERVICE_BODY_HEIGHT)
    }
    @Test fun `a hidden service body lifts its star by half the canonical frameless sprite`() {
        // The source lift is min(displayHeight * buildingHeightFactor, HIT_LIFT_MAX_PX) on the 32 px frameless body.
        val cursor=ServiceHitCursor();cursor.adopt(Any())
        val lift=minOf(HIDDEN_SERVICE_BODY_HEIGHT*policy.buildingHeightFactor,policy.buildingLiftMax)
        assertEquals(16f,lift,0f)
        assertEquals(160f-lift,cursor.y(cue(),policy) { HIDDEN_SERVICE_BODY_HEIGHT },0f)
    }
}
