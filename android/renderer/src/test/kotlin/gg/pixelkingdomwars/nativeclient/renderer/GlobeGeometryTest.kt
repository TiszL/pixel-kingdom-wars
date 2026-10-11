package gg.pixelkingdomwars.nativeclient.renderer

import org.junit.Assert.*
import org.junit.Test

class GlobeGeometryTest {
    @Test fun `projection inverse keeps parcel selection under the visible finger`() {
        val viewport=GlobeViewport(430,620)
        for(view in listOf(GlobeView(),GlobeView(179.0,40.0,8.0),GlobeView(-175.0,-50.0,16.0))) {
            for(offset in listOf(-1.0,0.0,1.0)) {
                val lon=GlobeGeometry.wrap(view.lon+offset);val lat=view.lat+offset
                val point=GlobeGeometry.project(lon,lat,view,viewport)
                val picked=GlobeGeometry.unproject(point.x,point.y,view,viewport)!!
                assertEquals(lon,picked.first,1e-7);assertEquals(lat,picked.second,1e-7)
            }
        }
    }
    @Test fun `ocean outside silhouette is never a world address`() {
        assertNull(GlobeGeometry.unproject(0.0,0.0,GlobeView(),GlobeViewport(400,400)))
        assertNull(GlobeGeometry.unproject(0.0,0.0,GlobeView(),GlobeViewport(0,0)))
    }
    @Test fun `overview cannot issue a full world parcel scan`() {
        assertTrue(GlobeGeometry.viewportRects(GlobeView(),GlobeViewport(400,400),720,360,8,4096,256).isEmpty())
    }
    @Test fun `dateline reads are split in bounded ordinary database rectangles`() {
        val rects=GlobeGeometry.viewportRects(GlobeView(179.0,0.0,8.0),GlobeViewport(400,600),720,360,8,4096,256)
        assertTrue(rects.any{it.x0==0});assertTrue(rects.any{it.x1==719})
        assertTrue(rects.all{it.x0<=it.x1 && it.y0<=it.y1 && (it.x1-it.x0+1)*(it.y1-it.y0+1)<=4096})
    }
    @Test fun `a visible polar cap includes every longitude without exceeding server bounds`() {
        val rects=GlobeGeometry.viewportRects(GlobeView(30.0,85.0,5.0),GlobeViewport(400,600),720,360,8,4096,256)
        assertEquals((0 until 720).toSet(),rects.filter{it.y0==0}.flatMap{(it.x0..it.x1).toList()}.toSet())
        assertTrue(rects.all{(it.x1-it.x0+1)*(it.y1-it.y0+1)<=4096 && it.x1-it.x0<256})
    }
    @Test fun `frozen tile indexing wraps the dateline and clamps the south pole`() {
        assertEquals(GlobeGeometry.tileAt(-180.0,0.0,720,360),GlobeGeometry.tileAt(180.0,0.0,720,360))
        assertEquals(359*720,GlobeGeometry.tileAt(-180.0,-90.0,720,360))
    }
    @Test fun `polar dateline wide and zoomed views obey nearest first request budget and disclose omitted coverage`() {
        for((view,viewport) in listOf(
            GlobeView(30.0,85.0,5.0) to GlobeViewport(915,311),
            GlobeView(179.0,0.0,8.0) to GlobeViewport(390,844),
            GlobeView(26.0,23.0,5.0) to GlobeViewport(2000,200),
            GlobeView(26.0,23.0,64.0) to GlobeViewport(390,844))) {
            val raw=GlobeGeometry.viewportRects(view,viewport,720,360,8,4096,256)
            val scoped=GlobeGeometry.boundedScope(view,viewport,720,360,8,4096,256,4)
            assertTrue(scoped.rectangles.size<=4)
            assertEquals(raw.size>4,scoped.truncated)
            assertTrue(scoped.rectangles.all{(it.x1-it.x0+1)*(it.y1-it.y0+1)<=4096})
            val centre=GlobeGeometry.tileAt(view.lon,view.lat,720,360)
            assertTrue(scoped.rectangles.any{centre%720 in it.x0..it.x1 && centre/720 in it.y0..it.y1})
        }
    }
}
