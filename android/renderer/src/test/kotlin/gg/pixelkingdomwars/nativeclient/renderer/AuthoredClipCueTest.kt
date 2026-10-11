package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.utils.JsonReader
import org.junit.Test
import kotlin.test.*

class AuthoredClipCueTest {
    private fun parse(cues: String? = null): AuthoredClip = AuthoredClip.parse(JsonReader().parse("""{
        "key":"body","atlasPath":"atlas/body.json","frames":[["f1","f2","f3","f4","f5","f6","f7","f8"]],
        "rowOrder":["s"],"fps":13,"anchor":[0.5,1],"scale":1,"cellWidth":160,"cellHeight":148
        ${cues?.let { ",\"fxCues\":$it" } ?: ""}
    }"""))

    @Test fun `leap launch and landing dust both survive repeated authored cue names`() {
        // Canonical Leap parses dust@1 and dust@7 as separate one-based entries.
        val body = parse("""[{"fx":"dust","frames":[2],"effectKey":"dust-art"},
            {"fx":"dust","frames":[8],"effectKey":"dust-art"}]""")
        assertEquals(listOf(2,8),body.fxCues.getValue("dust"))
        val effect=body.copy(key="dust",frames=listOf(listOf("dust-frame")),fps=100f,fxCues=emptyMap(),effectByCue=emptyMap())
        val art=CombatArt(mapOf("leap" to body),JsonReader().parse("{}"),emptyMap(),mapOf("dust-art" to effect),0f,0f)
        val events=listOf("""{"t":0,"e":"deploy","id":1,"troop":"gloamfang","x":0,"y":0}""",
            """{"t":1,"e":"troopAbility","id":1,"ability":"leap","x":0,"y":0,"ix":100,"iy":100}""").map(PresentationEvent::fromJson)
        val scene=BattleScene(BaseScene(emptyList(),16,16,256f),PresentationRevision("r","v",14,0,0,events),mapOf("gloamfang" to "actor"),256f,100f,5,5)
        val plan=CombatVisualPlan(scene,BattleVisualModel(events,5),mapOf("actor" to art))
        val sprites=mutableListOf<CombatSprite>()
        for(frame in listOf(2,8)) {
            val releaseMs=100f+(frame-1)*1000f/body.fps
            plan.transientSprites((releaseMs+effect.durationMs/2)/100f,sprites)
            assertEquals("dust-frame",sprites.single().frameKey,"Both authored release episodes must render")
        }
        plan.transientSprites(4f,sprites);assertTrue(sprites.isEmpty())
    }

    @Test fun `lunge preserves both fist contact release frames`() {
        val clip=parse("""[{"fx":"rend","frames":[2],"effectKey":"rend-art"},
            {"fx":"rend","frames":[4],"effectKey":"rend-art"}]""")
        assertEquals(listOf(2,4),clip.fxCues.getValue("rend"))
        assertEquals(mapOf("rend" to "rend-art"),clip.effectByCue)
    }

    @Test fun `repeated cues preserve encounter order and separately authored coincident releases`() {
        val clip=parse("""[{"fx":"dust","frames":[5,2]},
            {"fx":"rend","frames":[4]}, {"fx":"dust","frames":[2,8]}]""")
        assertEquals(listOf("dust","rend"),clip.fxCues.keys.toList())
        assertEquals(listOf(5,2,2,8),clip.fxCues.getValue("dust"))
        assertTrue(clip.effectByCue.isEmpty())
    }

    @Test fun `unmapped repetitions do not erase a compatible resolved effect`() {
        val clip=parse("""[{"fx":"dust","frames":[2]},
            {"fx":"dust","frames":[4],"effectKey":"dust-art"},
            {"fx":"dust","frames":[8]}]""")
        assertEquals(listOf(2,4,8),clip.fxCues.getValue("dust"))
        assertEquals(mapOf("dust" to "dust-art"),clip.effectByCue)
    }

    @Test fun `unique and absent cues retain their existing meaning`() {
        val clip=parse("""[{"fx":"arrow","frames":[3]},{"fx":"flash","frames":[3],"effectKey":"flash-art"}]""")
        assertEquals(mapOf("arrow" to listOf(3),"flash" to listOf(3)),clip.fxCues)
        assertEquals(mapOf("flash" to "flash-art"),clip.effectByCue)
        assertTrue(parse().fxCues.isEmpty());assertTrue(parse().effectByCue.isEmpty())
    }

    @Test fun `conflicting effects cannot silently retarget earlier cue frames`() {
        val failure=assertFailsWith<IllegalArgumentException> {
            parse("""[{"fx":"dust","frames":[2],"effectKey":"first-art"},
                {"fx":"dust","frames":[4]}, {"fx":"dust","frames":[8],"effectKey":"other-art"}]""")
        }
        assertEquals("Conflicting effect keys for cue dust",failure.message)
    }
}
