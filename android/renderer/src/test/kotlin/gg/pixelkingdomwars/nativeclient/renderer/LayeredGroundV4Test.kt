package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.utils.JsonReader
import com.badlogic.gdx.utils.JsonValue
import com.badlogic.gdx.utils.JsonWriter
import org.junit.Test
import kotlin.test.*

class LayeredGroundV4Test {
    private val images = (1..4).map { byteArrayOf(it.toByte()) }
    private fun fixture(): JsonValue {
        fun asset(id: String, index: Int, width: Int, height: Int, frames: Int = 1): String {
            val hash = LayeredGroundSource.sha256(images[index])
            return """{"id":"$id","path":"atlas/fantasy/layered-ground/assets/$hash.webp","sha256":"$hash","size":1,
                "width":$width,"height":$height,"frameWidth":${width / frames},"frameHeight":$height,"frameCount":$frames,
                "frameDurationMs":100,"anchor":{"x":0,"y":0},"reducedMotionFrame":0}"""
        }
        return JsonReader().parse("""{"schemaVersion":2,"groundRevision":4,"realmId":"thornwake","status":"accepted","tilePixels":32,
            "field":{"x":-1088,"y":-1088,"width":3136,"height":3136},"protectedFrame":{"x":-320,"y":-320,"width":1600,"height":1600},
            "ground":{"asset":"center","sampling":"world","centerRect":{"x":-1500,"y":-1500,"width":4000,"height":4000},
              "exterior":{"asset":"outer","rect":{"x":-4500,"y":-4500,"width":10000,"height":10000}},
              "far":{"asset":"far","origin":{"x":-320,"y":96},"period":{"width":64,"height":128}}},
            "assets":[${asset("center",0,8,8)},${asset("outer",1,8,8)},${asset("far",2,4,4)},${asset("water",3,4,2,2)}],
            "placements":[{"id":"waterfall","asset":"water","x":-700,"y":-700,"width":16,"height":16,"layer":1,"phaseFrame":1,"animated":true,"interactive":false}]}""")
    }
    private fun source(v: JsonValue = fixture()): LayeredGroundSource {
        val bytes = (v.toJson(JsonWriter.OutputType.json) + "\n").toByteArray()
        val hash = LayeredGroundSource.sha256(bytes)
        val section = JsonReader().parse("""{"version":1,"status":"accepted","manifests":[{"realmId":"thornwake","sha256":"$hash","manifestPath":"atlas/fantasy/layered-ground/$hash/manifest.json"}]}""")
        return LayeredGroundSource.read(section, "thornwake", setOf("thornwake"), false) { _, _ -> bytes }
    }
    private fun pixels(encoded: ByteArray, w: Int, h: Int): LayeredRgba = LayeredRgba(w,h,ByteArray(w*h*4) { offset ->
        val x = offset / 4 % w; val y = offset / 4 / w
        if (offset % 4 != 3) 17 else if (encoded[0].toInt() in 1..2 && (x == 0 || y == 0 || x == w - 1 || y == h - 1)) 0 else 255.toByte()
    })
    private val reader: (String, Int) -> ByteArray = { path, maximum ->
        assertEquals(1, maximum); images.single { path.contains(LayeredGroundSource.sha256(it)) }
    }
    @Test fun `larger scenery uses three draws without changing camera field or clean building frame`() {
        val g = LayeredRealmGround(fixture())
        val view = LayeredGroundRect(-20000.0,-20000.0,50000.0,50000.0)
        val plan = g.floorPlan(64.0,view)
        assertEquals(listOf("floor-far","floor-exterior","floor-center"),plan.map { it.id })
        assertEquals(view,plan[0].destination)
        assertEquals(LayeredGroundRect(-9000.0,-9000.0,20000.0,20000.0),plan[1].destination)
        assertEquals(LayeredGroundRect(-3000.0,-3000.0,8000.0,8000.0),plan[2].destination)
        assertEquals(LayeredGroundRect(-2176.0,-2176.0,6272.0,6272.0),g.floorBounds(64.0))
        assertEquals(LayeredGroundRect(-320.0,-320.0,1600.0,1600.0),g.protectedFrame)
        assertEquals(listOf("floor-far"),g.floorPlan(64.0,view.copy(x=100000.0,y=100000.0)).map { it.id })
        assertEquals(3,g.floorPlan(64.0,view.copy(width=1e12,height=1e12)).size)
        assertFailsWith<IllegalArgumentException> { g.floorPlan(64.0,view.copy(x=Double.NaN)) }
    }
    @Test fun `repeat UVs retain phase across pan negative coordinates and renderer scales`() {
        val g=LayeredRealmGround(fixture())
        for (scale in listOf(1.0,2.0)) {
            val view=LayeredGroundRect(-451.0*scale,-163.0*scale,1000.0*scale,300.0*scale)
            val repeat=requireNotNull(g.floorPlan(32.0*scale,view).first().repeat)
            val uv=repeat.uv(view)
            assertEquals((-451.0+320)/64,uv.x);assertEquals((-163.0-96)/128,uv.y)
            assertEquals(1000.0/64,uv.width);assertEquals(300.0/128,uv.height)
            val moved=repeat.uv(view.copy(x=view.x+10*scale,y=view.y+20*scale))
            assertEquals(10.0/64,moved.x-uv.x);assertEquals(20.0/128,moved.y-uv.y)
        }
    }
    @Test fun `emitted SpriteBatch vertices keep top rows upright and independent of viewport height`() {
        val repeat = LayeredGroundRepeat(-320.0,96.0,64.0,128.0)
        val vertices = FloatArray(20)
        for (height in listOf(100.0,300.0,1300.0)) {
            val view = LayeredGroundRect(-451.0,-163.0,1000.0,height)
            repeat.writeQuad(view,vertices)
            for ((offset,x,y) in listOf(Triple(0,view.x,view.y),Triple(5,view.x,view.y+height),
                Triple(10,view.x+view.width,view.y+height),Triple(15,view.x+view.width,view.y))) {
                assertEquals(x.toFloat(),vertices[offset]);assertEquals(y.toFloat(),vertices[offset+1])
                assertEquals(com.badlogic.gdx.graphics.Color.WHITE_FLOAT_BITS,vertices[offset+2])
                assertEquals(((x+320)/64).toFloat(),vertices[offset+3])
                assertEquals(((y-96)/128).toFloat(),vertices[offset+4])
            }
            // Changing only viewport height cannot move the world top's sampled row.
            assertEquals((-259.0/128).toFloat(),vertices[4]);assertEquals(vertices[4],vertices[19])
        }
    }
    @Test fun `r4 rejects incomplete unsafe or aliased floor definitions before decode`() {
        fun reject(mutate:(JsonValue)->Unit) { val v=fixture();mutate(v);assertFailsWith<IllegalArgumentException>{LayeredRealmGround(v)} }
        reject { it.get("schemaVersion").set(1L, null) }
        reject { it.get("protectedFrame").get("width").set(1472L, null) }
        reject { it.get("ground").get("centerRect").get("width").set(3000L, null) }
        reject { it.get("ground").get("exterior").get("rect").get("width").set(4000L, null) }
        reject { it.get("ground").get("far").get("asset").set("outer") }
        reject { it.get("ground").get("far").get("period").get("width").set(0L, null) }
        reject { v -> for(key in listOf("width","frameWidth"))v.get("assets").get(2).get(key).set(3L, null) }
        reject { it.get("placements").get(0).get("asset").set("far") }
        reject { v -> for(key in listOf("width","height","frameWidth","frameHeight"))v.get("assets").get(0).get(key).set(2048L, null) }
        val v=fixture();v.get("assets").get(0).get("size").set(LayeredRealmGround.MAX_COMPRESSED_BYTES-3, null)
        assertFailsWith<IllegalArgumentException>{LayeredRealmGround(v)} // Manifest bytes count too.
    }
    @Test fun `r4 worker verifies center border field opacity far opacity and cancellation within rows`() {
        val s=source();assertTrue(s.identity(64f).startsWith("layered-r4:"))
        val prepared=s.prepare(reader,LayeredImageDecoder(::pixels),{})
        assertEquals(listOf("center","outer","far","water"),prepared.pages.map{it.asset.id})
        for (which in listOf("center-border","center-field","outer-border","far")) {
            assertFailsWith<IllegalArgumentException> { s.prepare(reader,LayeredImageDecoder { bytes,w,h ->
                pixels(bytes,w,h).also { p ->
                    when {
                        which=="center-border" && bytes[0].toInt()==1 -> p.bytes[3]=255.toByte()
                        which=="center-field" && bytes[0].toInt()==1 -> p.bytes[(3*w+3)*4+3]=0
                        which=="outer-border" && bytes[0].toInt()==2 -> p.bytes[3]=255.toByte()
                        which=="far" && bytes[0].toInt()==3 -> p.bytes[3]=0
                    }
                }
            },{}) }
        }
        var checkpoints=0;var decodes=0
        assertFailsWith<IllegalStateException> { s.prepare(reader,LayeredImageDecoder { bytes,w,h -> decodes++;pixels(bytes,w,h) },{
            checkpoints++;if(checkpoints==5)error("superseded during alpha rows")
        }) }
        assertEquals(1,decodes);assertEquals(5,checkpoints)
    }
    @Test fun `r4 clips keep authored timing and stop for reduced motion or background`() {
        val g=LayeredRealmGround(fixture());val view=LayeredGroundRect(-1500.0,-1500.0,200.0,200.0)
        assertEquals(1,g.drawPlan(64.0,view,0,false).single().frame)
        assertEquals(0,g.drawPlan(64.0,view,100,false).single().frame)
        assertEquals(0,g.drawPlan(64.0,view,0,true).single().frame)
        assertTrue(g.drawPlan(64.0,view,0,false,true).isEmpty())
    }
}
