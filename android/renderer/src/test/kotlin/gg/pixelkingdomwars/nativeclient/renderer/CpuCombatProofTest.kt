package gg.pixelkingdomwars.nativeclient.renderer

import org.junit.Test
import kotlin.test.*
import com.badlogic.gdx.utils.JsonReader

class CpuCombatProofTest {
    @Test fun `legacy CPU proof excludes validated metadata-only services but never ignores malformed legacy art`() {
        val marker="""{"type":"workshop","level":1,"footprintWidth":2,"footprintHeight":2,"phaseE":{"facility":"workshop","tier":1}}"""
        fun catalogue(entry:String)=JsonReader().parse("""{"rendererContractVersion":15,"entries":[{"frameKey":"legacy"},$entry]}""")
        assertEquals(listOf("legacy"),cpuStaticBuildingEntries(catalogue(marker)).map { it.getString("frameKey") })
        assertFailsWith<IllegalArgumentException> { cpuStaticBuildingEntries(catalogue("""{"type":"cannon"}""")) }
        assertFailsWith<IllegalArgumentException> { cpuStaticBuildingEntries(catalogue(marker.replace("\"footprintWidth\":2","\"footprintWidth\":1"))) }
        val service=RenderBuilding("w","service:workshop:1",0f,0f,2f,2f,service=RenderServiceIdentity("workshop",1))
        assertFailsWith<IllegalArgumentException> { requireCpuLegacyBuildings(listOf(service)) }
        requireCpuLegacyBuildings(listOf(service.copy(service=null,frameKey="legacy")))
    }
    @Test fun `asymmetric anchors mirror once at the same native world coordinate`() {
        val flipped=cpuSpriteGeometry(100f,80f,10f,5f,20,0.25f,0.75f,1f,Float.POSITIVE_INFINITY,true,0f)
        assertEquals(15f,flipped.left)
        assertEquals(-20f,flipped.width)
        assertEquals(-55f,flipped.top)
        // The old negative-global-scale formula is equivalent; mirroring that anchor again is wrong.
        assertEquals(-(-100f*0.25f+10f),flipped.left)
    }
    @Test fun `fractional crop retains its final source texel without widening the native destination`() {
        val cropped=cpuSpriteGeometry(100f,80f,10f,5f,20,0.25f,0.75f,2f,24.5f,false,0f)
        assertEquals(3,cropped.cropPixels)
        assertEquals(2.25f,cropped.width)
        assertEquals(-15f,cropped.left)
    }
}
