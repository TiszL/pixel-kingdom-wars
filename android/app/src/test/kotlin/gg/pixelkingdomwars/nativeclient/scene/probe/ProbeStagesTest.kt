package gg.pixelkingdomwars.nativeclient.scene.probe

import com.badlogic.gdx.graphics.GL20
import com.badlogic.gdx.graphics.GL30
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * GLOBE-NATIVE-PLAN §5.3 step 4, §8.3 and D-171: `glProgramBinary` and first-draw ms PER PRODUCTION PROGRAM come from
 * the owner's one Seeker session, so the probe must find every exported program and never time a draw that measured
 * nothing (a sampler left on a unit of another kind is GL_INVALID_OPERATION at the draw).
 */
class ProbeStagesTest {
    /** The shape `tools/world-shaders.mjs` writes (schema 2): realm `programs`, globe `globe`. */
    private val index = """
        {"schema":2,"provisional":false,"source":{"commit":"3266f7109bb3ddfb52358fc99815c2ce2c4a6137"},
         "programs":[
           {"name":"rm-map","defines":{},"bake":false,"module":"ground.js","vs":{"path":"rm-map.vs.glsl","sha256":"a"},"fs":{"path":"rm-map.fs.glsl","sha256":"b"}},
           {"name":"life-stand-merged","defines":{"STAND_MERGED":1},"vs":{"path":"life-stand-merged+STAND_MERGED=1.vs.glsl"},"fs":{"path":"life-stand-merged+STAND_MERGED=1.fs.glsl"}}
         ],
         "globe":[
           {"name":"globe-terrain2","site":"S.TERRAIN2_FS","vs":{"path":"globe-terrain2.vs.glsl"},"fs":{"path":"globe-terrain2.fs.glsl"}}
         ]}
    """.trimIndent()

    @Test fun `every realm and globe program is found with both stage paths and the pin`() {
        val parsed = ProbeStages.parse(index)
        assertEquals(listOf("rm-map", "life-stand-merged", "globe-terrain2"), parsed.stages.map { it.name })
        assertEquals(listOf("programs", "programs", "globe"), parsed.stages.map { it.group })
        assertEquals("life-stand-merged+STAND_MERGED=1.fs.glsl", parsed.stages[1].fsPath)
        assertEquals(2, parsed.schema)
        assertEquals("3266f7109bb3ddfb52358fc99815c2ce2c4a6137", parsed.pin)
        assertEquals(emptyList<String>(), parsed.errors)
    }

    @Test fun `an entry without a stage path is reported, never silently dropped`() {
        val broken = ProbeStages.parse("""{"schema":2,"programs":[{"name":"rm-true","vs":{"path":"rm-true.vs.glsl"}},{"vs":{},"fs":{}}],"globe":"x"}""")
        assertEquals(emptyList<ProbeStage>(), broken.stages)
        assertEquals(3, broken.errors.size)
        assertTrue(broken.errors.toString(), broken.errors.any { "programs[0]" in it } && broken.errors.any { "globe" in it })
        assertEquals(listOf("index.json is not a JSON object"), ProbeStages.parse("not json").errors)
        assertEquals(listOf("index.json lists no programs"), ProbeStages.parse("""{"schema":2}""").errors)
    }

    @Test fun `every sampler kind the exported stages use gets a texture of its own kind`() {
        // sampler2D, sampler2DArray, samplerCube, usampler2D, usampler2DArray: the kinds in the chosen pin's stages
        val used = mapOf(
            GL20.GL_SAMPLER_2D to (GL20.GL_TEXTURE_2D to false), GL30.GL_SAMPLER_2D_ARRAY to (GL30.GL_TEXTURE_2D_ARRAY to false),
            GL20.GL_SAMPLER_CUBE to (GL20.GL_TEXTURE_CUBE_MAP to false), GL30.GL_UNSIGNED_INT_SAMPLER_2D to (GL20.GL_TEXTURE_2D to true),
            GL30.GL_UNSIGNED_INT_SAMPLER_2D_ARRAY to (GL30.GL_TEXTURE_2D_ARRAY to true),
        )
        for ((type, want) in used) {
            val dummy = ProbeStages.dummyFor(type)!!
            assertEquals("0x${Integer.toHexString(type)}", want.first, dummy.target)
            val integer = dummy.format == GL30.GL_RGBA_INTEGER
            assertEquals("an integer sampler needs an integer texture (and a float one a float texture)", want.second, integer)
            assertTrue(ProbeStages.isSampler(type))
        }
        assertEquals(GL30.GL_RGBA16UI, ProbeStages.dummyFor(GL30.GL_UNSIGNED_INT_SAMPLER_2D)!!.internal)
        assertEquals(GL30.GL_RGBA16I, ProbeStages.dummyFor(GL30.GL_INT_SAMPLER_2D)!!.internal)
    }

    @Test fun `a sampler the probe has no texture for skips the draw instead of binding nothing`() {
        for (type in listOf(GL30.GL_SAMPLER_2D_SHADOW, GL30.GL_SAMPLER_3D, GL30.GL_UNSIGNED_INT_SAMPLER_CUBE)) {
            assertNull(ProbeStages.dummyFor(type))
            assertTrue("0x${Integer.toHexString(type)} is still a sampler: the draw must be skipped", ProbeStages.isSampler(type))
        }
        for (type in listOf(GL20.GL_FLOAT_VEC4, GL30.GL_UNSIGNED_INT_VEC4, GL20.GL_INT)) assertTrue(!ProbeStages.isSampler(type))
    }

    @Test fun `sampler arrays bind element by element`() {
        assertEquals("uTex", ProbeStages.elementName("uTex", 1, 0))
        assertEquals("uKit[0]", ProbeStages.elementName("uKit[0]", 4, 0))
        assertEquals("uKit[3]", ProbeStages.elementName("uKit[0]", 4, 3))
    }

    @Test fun `the summary counts failures and skipped draws and keeps the worst times`() {
        val summary = ProbeStages.summary(listOf(
            mapOf("compileLinkMs" to JsonPrimitive(40.0), "programBinaryMs" to JsonPrimitive(2.0), "firstDrawMs" to JsonPrimitive(3.0)),
            mapOf("compileLinkMs" to JsonPrimitive(120.0), "programBinaryMs" to JsonPrimitive(5.0), "drawSkipped" to JsonPrimitive("x")),
            mapOf("compileLinkMs" to JsonPrimitive(1.0), "error" to JsonPrimitive("link: bad")),
        ))
        assertEquals(JsonPrimitive(3), summary["programs"]); assertEquals(JsonPrimitive(1), summary["failed"])
        assertEquals(JsonPrimitive(1), summary["drawSkipped"])
        assertEquals(JsonPrimitive(120.0), summary["compileLinkMsMax"]); assertEquals(JsonPrimitive(161.0), summary["compileLinkMsSum"])
        assertEquals(JsonPrimitive(3.0), summary["firstDrawMsMax"])
    }

    @Test fun `every uniform block fits the zeroed buffer on any ES 3 device`() {
        assertEquals("GL_MAX_UNIFORM_BLOCK_SIZE is at least 16384 in ES 3.0", 16384, ProbeStages.ZERO_UBO_BYTES)
        assertEquals("world/shaders/index.json", ProbeStages.INDEX)
    }
}
