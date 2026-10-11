package gg.pixelkingdomwars.nativeclient.renderer

import java.util.concurrent.Executor
import org.junit.Test
import kotlin.test.*

class GlobeDetailPreparationTest {
    private class Fixture {
        val tasks = ArrayDeque<Runnable>()
        val decoded = mutableListOf<Int>()
        val released = mutableListOf<Int>()
        var wakes = 0
        var duringDecode: (Int) -> Unit = {}
        val work = GlobeDetailPreparation(Executor(tasks::addLast), { index, _ ->
            decoded += index; duringDecode(index); index
        }, released::add, { wakes++ })
        fun run() = tasks.removeFirst().run()
    }
    @Test fun `overview schedules no decode and visible textures yield at every upload hand-off`() {
        val f = Fixture();f.work.request(emptyList());assertTrue(f.tasks.isEmpty())
        f.work.request(listOf(0,1,2,3,4));assertEquals(1,f.tasks.size)
        f.run();assertTrue(f.tasks.isEmpty());assertEquals(1,f.work.pendingCount())
        repeat(100) { f.work.request(listOf(0,1,2,3,4)) }
        assertTrue(f.tasks.isEmpty(), "GL must consume one prepared texture before another decode")
        assertEquals(0,f.work.take()!!.value.getOrThrow())
        f.work.request(listOf(1,2,3,4));f.run()
        assertEquals(listOf(0,1),f.decoded);assertEquals(1,f.work.take()!!.index)
        assertEquals(2,f.wakes)
    }
    @Test fun `rapid camera changes replace dependencies without building an executor backlog`() {
        val f = Fixture()
        f.duringDecode = { repeat(50) { f.work.request(listOf(1,2)) };f.work.request(listOf(4)) }
        f.work.request(listOf(0,1));f.run()
        assertEquals(listOf(0),f.released);assertNull(f.work.take());assertEquals(1,f.tasks.size)
        f.duringDecode = {};f.run()
        assertEquals(listOf(0,4),f.decoded);assertEquals(4,f.work.take()!!.index)
    }
    @Test fun `prepared invisible pixels are disposed and pause fences the active decode`() {
        val f = Fixture();f.work.request(listOf(0));f.run()
        f.work.request(emptyList());assertEquals(listOf(0),f.released)
        f.work.request(listOf(1));f.duringDecode = { f.work.pause();f.work.resume();f.work.request(listOf(1)) }
        f.run();assertEquals(listOf(0,1),f.released);assertNull(f.work.take())
        assertEquals(1,f.tasks.size);f.duringDecode = {};f.run()
        assertEquals(1,f.work.take()!!.index)
    }
    @Test fun `dispose returns while decoding and releases the scene lease only after stale pixels`() {
        val f = Fixture();var closed = 0
        f.duringDecode = { f.work.close { assertEquals(listOf(0),f.released);closed++ };assertEquals(0,closed) }
        f.work.request(listOf(0,1));f.run()
        assertEquals(1,closed);assertEquals(0,f.wakes);assertTrue(f.tasks.isEmpty())
        f.work.close { closed++ };f.work.request(listOf(2));assertEquals(1,closed);assertTrue(f.tasks.isEmpty())
    }
    @Test fun `decode errors are delivered once and retry does not replace a valid scene`() {
        val f = Fixture();f.duringDecode = { error("bad pixels") }
        f.work.request(listOf(0));f.run();assertTrue(f.work.take()!!.value.isFailure)
        repeat(20) { f.work.request(listOf(0)) };assertTrue(f.tasks.isEmpty());assertEquals(1,f.wakes)
        f.work.pause();f.work.resume();f.duringDecode = {};f.work.request(listOf(0));f.run()
        assertEquals(0,f.work.take()!!.value.getOrThrow())
    }
    @Test fun `closing before the worker starts never decodes or wakes a dead world`() {
        val f = Fixture();var closed=false
        f.work.request(listOf(0));f.work.close { closed=true }
        assertFalse(closed);f.run()
        assertTrue(closed);assertTrue(f.decoded.isEmpty());assertEquals(0,f.wakes)
    }
    @Test fun `upload errors are fenced until explicit retry`() {
        val f = Fixture();f.work.request(listOf(0));f.run();f.work.take()
        f.work.fail(0);f.work.request(listOf(0));assertTrue(f.tasks.isEmpty())
        f.work.pause();f.work.resume();f.work.request(listOf(0));assertEquals(1,f.tasks.size)
    }
    @Test fun `pause cancels network work and checkpoint prevents decode after acquisition`() {
        val tasks=ArrayDeque<Runnable>();var cancelled=0;var decoded=false
        lateinit var work:GlobeDetailPreparation<Int>
        work=GlobeDetailPreparation(Executor(tasks::addLast),{ _,checkpoint ->
            work.pause();checkpoint();decoded=true;1
        },{}, {}, {cancelled++})
        work.request(listOf(0));tasks.removeFirst().run()
        assertEquals(1,cancelled);assertFalse(decoded);assertNull(work.take())
    }
    @Test fun `obsolete camera work cancels acquisition while visible groups stay bounded`() {
        val tasks=ArrayDeque<Runnable>();var cancelled=0
        val work=GlobeDetailPreparation(Executor(tasks::addLast),{ index,checkpoint ->checkpoint();index},{},{},{cancelled++})
        work.request(listOf(0));work.request(listOf(1));assertEquals(1,cancelled)
        tasks.removeFirst().run();assertEquals(1,tasks.size)
        tasks.removeFirst().run();assertEquals(1,work.take()!!.index)
    }
    @Test fun `visible island groups retain the three atlas bound and distant islands wait`() {
        val islands=(0..6).map { GlobeIsland(it,0,it.toDouble(),0.0,2.0,2.0) } + GlobeIsland(8,0,180.0,0.0,2.0,2.0)
        val viewport=GlobeViewport(1080,2400)
        assertTrue(visibleGlobeChains(islands,1.0,GlobeView(),GlobeViewport(100,100),768).isEmpty())
        val visible=visibleGlobeChains(islands,1.0,GlobeView(0.0,0.0,4.0),viewport,768)
        assertEquals(listOf(0,1,2),visible)
        assertFalse(8 in visible)
    }
    private val sources = listOf(
        GlobeDetailSource("heartlands",-92f,99f,-63f,83f,2048,1536,.20278f),
        GlobeDetailSource("solana",-142f,-88f,16f,60f,2048,2048,.05625f),
        GlobeDetailSource("stormcairn",115f,200f,-22f,65f,1536,1536,.12083f),
        GlobeDetailSource("thornwake",-170f,-115f,-46f,12f,1536,1536,.08056f),
        GlobeDetailSource("cinderfall",-182f,-123f,-72f,-41f,2048,1152,.06146f),
    )
    @Test fun `zoomed realm centres admit their detail but overview stays coarse`() {
        val viewport=GlobeViewport(1080,2400)
        assertTrue(visibleGlobeDetails(sources,GlobeView(),GlobeViewport(200,400),768).isEmpty())
        for((index,source) in sources.withIndex()) {
            val view=GlobeView((source.west+source.east)/2.0,(source.south+source.north)/2.0,32.0).normalized()
            assertTrue(index in visibleGlobeDetails(sources,view,viewport,768),source.id)
        }
        assertEquals(listOf(0),visibleGlobeDetails(sources,GlobeView(26.0,23.0,64.0),viewport,768))
        assertTrue(visibleGlobeDetails(sources,GlobeView(26.0,23.0,64.0),GlobeViewport(0,0),768).isEmpty())
    }
    @Test fun `spherical culling preserves visible patch samples at dateline poles and landscape edges`() {
        for(viewport in listOf(GlobeViewport(1080,2400),GlobeViewport(2400,1080)))
            for(lon in listOf(-179.0,-120.0,-30.0,26.0,120.0,179.0))
                for(lat in listOf(-80.0,-45.0,0.0,45.0,80.0))
                    for(zoom in listOf(4.0,16.0,128.0)) {
                        val view=GlobeView(lon,lat,zoom)
                        val admitted=visibleGlobeDetails(sources,view,viewport,768)
                        for((index,source) in sources.withIndex()) for(y in 0..20) for(x in 0..20) {
                            val point=GlobeGeometry.project(source.west+(source.east-source.west)*x/20.0,
                                source.south+(source.north-source.south)*y/20.0,view,viewport)
                            if(point.z>0 && point.x in 0.0..viewport.width.toDouble() && point.y in 0.0..viewport.height.toDouble())
                                assertTrue(index in admitted,"${source.id} at $view in $viewport must retain visible artwork")
                        }
                    }
    }
}
