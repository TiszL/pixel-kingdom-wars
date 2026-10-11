package gg.pixelkingdomwars.nativeclient.renderer

import org.junit.Assert.*
import org.junit.Test

class GlobeArtTest {
    private fun art(islands:List<GlobeIsland> = emptyList(),genesis:(Double,Double)->Boolean={_,_->true})=GlobeArt(
        listOf("test"),islands,320,1024,1.12,"depth",256,128,emptyList(),"cloud",64,32,
        listOf(GlobeCloudBank(-120.0,42.0,9.0,4.0),GlobeCloudBank(-110.0,36.0,8.5,3.8),GlobeCloudBank(-117.0,32.0,8.0,3.6)),"effects",720,360,{true},{true},genesis)
    @Test fun `island atlas uses exact wrapping and authored cells rather than an elliptical land claim`() {
        val geometry=art(listOf(GlobeIsland(0,4,179.0,20.0,5.0,3.0)))
        val hit=geometry.islandAt(-179.0,20.0)!!
        assertEquals(GlobeIslandHit(geometry.islands.single(),537,480),hit)
        assertNull(geometry.islandAt(170.0,20.0))
        assertNotNull(geometry.islandAt(179.0+5*1.11,20.0+3*1.11)) // Rectangle still requires authored mask before picking.
    }
    @Test fun `overlapping authored patches keep first canonical candidate and exact boundary is excluded`() {
        val first=GlobeIsland(0,0,0.0,0.0,1.0,1.0);val second=first.copy(chain=1)
        val geometry=art(listOf(first,second))
        assertEquals(first,geometry.islandAt(0.0,0.0)!!.island)
        assertNull(geometry.islandAt(0.0,1.12))
    }
    @Test fun `cloud overlap caps alpha and never puts a cloud outside Genesis membership`() {
        val pixels=IntArray(192*32){0xffddeeFF.toInt()};val view=GlobeView(-115.0,38.0,12.0);val viewport=GlobeViewport(400,400)
        val frame=GlobeCloudRaster(art(),pixels,192).draw(view,viewport,0.0,false,1.0)
        assertTrue(frame.any {it and 255==114});assertTrue(frame.all {it and 255<=114})
        val empty=GlobeCloudRaster(art(genesis={_,_->false}),pixels,192).draw(view,viewport,0.0,false,1.0)
        assertTrue(empty.all {it==0})
    }
    @Test fun `reduced motion freezes source geometry and zoomed parcel inspection reduces cloud opacity`() {
        val raster=GlobeCloudRaster(art(),IntArray(192*32){-1},192)
        val view=GlobeView(-115.0,38.0,12.0);val viewport=GlobeViewport(400,400)
        val static=raster.draw(view,viewport,0.0,false,1.0).clone()
        assertArrayEquals(static,raster.draw(view,viewport,999_999.0,false,1.0))
        assertFalse(static.contentEquals(raster.draw(view,viewport,16_000.0,true,1.0)))
        assertTrue(raster.draw(view.copy(zoom=80.0),viewport,0.0,false,1.0).all {it and 255<=25})
    }
    @Test fun `island inspection fits authored corners in portrait and landscape without hiding coastline`() {
        val site=GlobeIsland(0,0,179.0,53.0,4.0,3.0)
        for(viewport in listOf(GlobeViewport(390,280),GlobeViewport(900,300),GlobeViewport(300,800))) {
            val focus=GlobeGeometry.focusIsland(site,1.12,viewport,1.0)
            for(dx in -1..1)for(dy in -1..1) {
                val p=GlobeGeometry.project(site.lon+dx*site.rx*1.12,site.lat+dy*site.ry*1.12,focus,viewport)
                assertTrue(p.x in 15.99..viewport.width-15.99);assertTrue(p.y in 15.99..viewport.height-15.99)
            }
        }
    }
    @Test fun `tile inspection adjusts for latitude and display density rather than fixing a misleading zoom`() {
        val viewport=GlobeViewport(1200,1600)
        val equator=GlobeGeometry.focusTile(0.0,0.0,viewport,720,3.0)
        val north=GlobeGeometry.focusTile(0.0,65.0,viewport,720,3.0)
        assertTrue(north.zoom>equator.zoom)
        assertEquals(150.0,viewport.radius(equator)*2*Math.PI/720,0.001)
    }
    @Test fun `authored feature phases preserve falling water negative modulo and stationary beacons`() {
        assertTrue(GlobeIslandEffects.active("fall",0,0,6));assertFalse(GlobeIslandEffects.active("fall",0,0,1))
        for(phase in 0..7)assertTrue(GlobeIslandEffects.active("beacon",17,23,phase))
        assertEquals(.95,GlobeIslandEffects.opacity("beacon",4),0.0)
        assertFalse(GlobeIslandEffects.active("unknown",0,0,0))
    }
}
