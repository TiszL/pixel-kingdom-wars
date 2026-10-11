package gg.pixelkingdomwars.nativeclient.renderer

import kotlin.math.*

data class GlobeIsland(val chain: Int, val slot: Int, val lon: Double, val lat: Double, val rx: Double, val ry: Double)
data class GlobeIslandHit(val island: GlobeIsland, val x: Int, val y: Int)
data class GlobePick(val lon:Double,val lat:Double,val realm:Int?=null,val chain:Int?=null,val island:Int?=null,val deedEligible:Boolean=false)
data class GlobeSelection(val selected:Int?=null,val owned:Set<Int> = emptySet(),val occupied:Set<Int> = emptySet())
data class GlobeCloudBank(val lon: Double, val lat: Double, val width: Double, val height: Double)
data class GlobeArt(
    val chainIds: List<String>, val islands: List<GlobeIsland>, val cell: Int, val atlas: Int, val extent: Double,
    val oceanPath: String, val oceanWidth: Int, val oceanHeight: Int, val oceanStops: List<FloatArray>,
    val cloudPath: String, val cloudWidth: Int, val cloudHeight: Int, val clouds: List<GlobeCloudBank>,
    val effectsPath: String, val columns:Int, val rows:Int, val eligible:(Int)->Boolean, val genesisCell:(Int)->Boolean, val genesis: (Double,Double)->Boolean,
) {
    /** Exact authored atlas coordinates; a candidate rectangle is not evidence of visible land. */
    fun islandAt(lon: Double, lat: Double): GlobeIslandHit? {
        for (island in islands) {
            val dx=GlobeGeometry.wrap(lon-island.lon)/island.rx;val dy=(lat-island.lat)/island.ry
            if(abs(dx)>=extent || abs(dy)>=extent)continue
            val u=floor((dx/extent+1)*cell/2).toInt();val v=floor((1-dy/extent)*cell/2).toInt()
            return GlobeIslandHit(island,island.slot%3*cell+u,island.slot/3*cell+v)
        }
        return null
    }
}

/** Production cloud compositor: one alpha maximum, not repeated alpha accumulation. Reuses its
 * output buffer; only authored nontransparent samples are projected, and hidden time never advances. */
class GlobeCloudRaster(private val art: GlobeArt, private val pixels: IntArray, private val sourceWidth: Int) {
    private var frame=IntArray(0)
    fun draw(view: GlobeView, viewport: GlobeViewport, elapsedMs: Double, motion: Boolean, cssScale: Double): IntArray {
        if(frame.size!=viewport.width*viewport.height)frame=IntArray(viewport.width*viewport.height) else frame.fill(0)
        val radius=viewport.radius(view);val rad=Math.PI/180;val phase=if(motion)elapsedMs/16000 else 0.0
        val opacity=if(radius*.00872664626*cos(38*rad)*cssScale>=44)25 else 114
        for(layer in 0..1)for((n,bank)in art.clouds.withIndex())for(y in 0 until art.cloudHeight)for(x in 0 until art.cloudWidth) {
            val rgba=pixels[y*sourceWidth+n*art.cloudWidth+x];val alpha=rgba and 255
            if(alpha<32)continue
            val lon=bank.lon+(x.toDouble()/art.cloudWidth-.5)*bank.width+sin(phase+n)*.55
            val lat=bank.lat+(.5-y.toDouble()/art.cloudHeight)*bank.height+sin(phase*.7+n)*.18
            if(!art.genesis(lon,lat))continue
            val p=GlobeGeometry.project(lon,lat,view,viewport);if(p.z<=.12)continue
            val cy=p.y+if(layer==0)2.0 else -min(9.0,3+radius/500)
            val size=max(1.0,ceil(radius*rad*bank.width/art.cloudWidth))
            if(p.x+size<0||cy+size<0||p.x-size>=viewport.width||cy-size>=viewport.height)continue
            val a=(opacity*alpha/255.0*(if(layer==0).28 else 1.0)).roundToInt()
            val color=if(layer==0)0x4a2f5800 else rgba and -256
            for(py in max(0,floor(cy-size/2).toInt()) until min(viewport.height,ceil(cy+size/2).toInt()))
                for(px in max(0,floor(p.x-size/2).toInt()) until min(viewport.width,ceil(p.x+size/2).toInt())) {
                    if((px-viewport.width/2.0).pow(2)+(py-viewport.height/2.0).pow(2)>radius*radius)continue
                    val index=py*viewport.width+px
                    if(a>(frame[index] and 255))frame[index]=color or a
                }
        }
        return frame
    }
}
