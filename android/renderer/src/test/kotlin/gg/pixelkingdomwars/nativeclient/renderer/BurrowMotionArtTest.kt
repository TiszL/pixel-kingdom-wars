package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.utils.JsonReader
import com.badlogic.gdx.utils.JsonValue
import java.io.File
import kotlin.test.*
import org.junit.Test

/** Keep the refusal fixture tied to the parser's source guard, not a stale version literal. */
internal fun firstUnsupportedCombatRendererVersion():Int {
    val source=File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/renderer/CombatVisualPlan.kt").readText()
    val guards=Regex("""require\(root\.getInt\("rendererContractVersion",\s*\d+\)\s+in\s+\d+\.\.(\d+)\)\s*\{\s*"Unsupported combat renderer contract"\s*\}""").findAll(source).toList()
    assertEquals(1,guards.size,"Update the combat version probe when the parser's range guard changes")
    return Math.addExact(guards.single().groupValues[1].toInt(),1)
}

class BurrowMotionArtTest {
    private val reader=JsonReader()
    private fun clip(name:String,loop:Boolean=false,soil:Boolean=false)="""{"key":"$name","atlasPath":"$name.json","frames":[["$name-1","$name-2","$name-3"]],"rowOrder":["s"],"fps":10,"anchor":[0.5,0.5],"scale":1,"cellWidth":10,"cellHeight":10,"loop":$loop${if(soil)",\"fxCues\":[{\"fx\":\"soil\",\"frames\":[2],\"effectKey\":\"soil\"}]" else ""}}"""
    private fun combat()=reader.parse("""{
      "profile":{"burrow":{"enter":"burrow","tunnel":"tunnel","surface":"surface"},"stand":"idle","move":"walk","death":"death","hit":"hit","melee":{"troop":"attack","building":"attack"}},
      "clips":{"burrow":${clip("burrow",soil=true)},"surface":${clip("surface",soil=true)},"tunnel":${clip("tunnel",true)},"idle":${clip("idle",true)},"walk":${clip("walk",true)},"death":${clip("death")},"hit":${clip("hit")},"attack":${clip("attack")}},
      "effects":{"soil":${clip("soil")}},
      "burrowMotion":{"controller":"v2Burrow","enterState":"burrow","tunnelState":"tunnel","surfaceState":"surface","positionSnapDistance":1,"aim":{"minimumDeltaSquared":0.25,"retainWithinDegrees":32.5},"soilDepthOffset":-1,
        "movement":"linearPreserveVerb","enterMovement":"retain","emergeMovement":"coordinatesKillRetainMovingFlagOtherwiseRetain","identicalRegistration":"preservePhaseAndCallbacks","rowRegistration":"preservePhaseReplaceCallbacks","soilOwnership":"scene","coldPrefix":"stableBurrowOrEmergeWithoutHistoricalCues"}}
    """)
    private fun catalogue(version:Int,body:JsonValue):JsonValue {
        val root=reader.parse("""{"rendererContractVersion":$version,"actors":[{"type":"tunneler","frameKey":"actor"}]}""")
        root.get("actors").get(0).addChild("combat",body);return root
    }
    @Test fun `renderer twelve admits source burrow and all body and soil residency`() {
        val art=CombatArt.catalogue(catalogue(12,combat())).getValue("actor")
        assertNotNull(art.burrowMotion)
        assertTrue(art.atlases.containsAll(listOf("burrow.json","surface.json","tunnel.json","soil.json","idle.json","walk.json","death.json")))
        val serviceCompatible=CombatArt.catalogue(catalogue(15,combat())).getValue("actor")
        assertNotNull(serviceCompatible.burrowMotion)
        assertEquals(art.atlases,serviceCompatible.atlases,"Service catalogue support preserves actor residency")
        // Admitted content-mount contract 17 inherits the existing combat metadata unchanged.
        val contentMountCompatible=CombatArt.catalogue(catalogue(17,combat())).getValue("actor")
        assertNotNull(contentMountCompatible.burrowMotion)
        assertEquals(art.atlases,contentMountCompatible.atlases,"Content-mount support preserves actor residency")
        val unsupportedVersion=firstUnsupportedCombatRendererVersion()
        assertEquals("Unsupported combat renderer contract",assertFailsWith<IllegalArgumentException> {
            CombatArt.catalogue(catalogue(unsupportedVersion,combat()))
        }.message)
    }
    @Test fun `missing controller rejects new content while previous renderer eleven stays admissible`() {
        val missing=combat();missing.remove("burrowMotion")
        assertNotNull(CombatArt.catalogue(catalogue(11,missing))["actor"])
        assertFailsWith<IllegalArgumentException> { CombatArt.catalogue(catalogue(12,missing)) }
    }
    @Test fun `hash valid unsupported policy or missing finite soil cannot reach first scene`() {
        val policy=combat();policy.get("burrowMotion").get("soilOwnership").set("actor")
        assertFailsWith<IllegalArgumentException> { CombatArt.parse(policy) }
        val missing=combat();missing.get("effects").remove("soil")
        assertFailsWith<IllegalArgumentException> { CombatArt.parse(missing) }
        val loop=combat();loop.get("effects").get("soil").get("loop").set(true)
        assertFailsWith<IllegalArgumentException> { CombatArt.parse(loop) }
    }
    @Test fun `invalid locomotion threshold and cue reject at admission`() {
        val missing=combat();missing.get("clips").remove("walk")
        assertFailsWith<IllegalArgumentException> { CombatArt.parse(missing) }
        val threshold=combat();threshold.get("burrowMotion").remove("positionSnapDistance");threshold.get("burrowMotion").addChild("positionSnapDistance",JsonValue(0.0))
        assertFailsWith<IllegalArgumentException> { CombatArt.parse(threshold) }
        val cue=combat();cue.get("clips").get("burrow").get("fxCues").get(0).get("frames").get(0).set("100")
        assertFailsWith<IllegalArgumentException> { CombatArt.parse(cue) }
    }    @Test fun `missing declared melee or flinch art cannot disable admitted combat silently`() {
        for(state in listOf("attack","hit")) {
            val missing=combat();missing.get("clips").remove(state)
            assertFailsWith<IllegalArgumentException> { CombatArt.parse(missing) }
        }
    }
    @Test fun `positive FPS that overflows derived body or soil duration is rejected before activation`() {
        for((group,state) in listOf("clips" to "burrow","clips" to "attack","effects" to "soil")) {
            val invalid=combat();val clip=invalid.get(group).get(state)
            clip.remove("fps");clip.addChild("fps",JsonValue(1e-38))
            assertFailsWith<IllegalArgumentException> { CombatArt.parse(invalid) }
        }
    }

}
