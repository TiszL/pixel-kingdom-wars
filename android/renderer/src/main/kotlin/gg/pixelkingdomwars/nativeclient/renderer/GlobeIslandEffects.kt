package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.files.FileHandle
import com.badlogic.gdx.utils.JsonReader
import com.badlogic.gdx.utils.JsonValue
import kotlin.math.*

/** Authored anchors exported from island-effects.mjs. Display pixels never change parcel membership. */
class GlobeIslandEffects(file: FileHandle, private val art: GlobeArt) {
    private data class Point(val lon:Double,val lat:Double,val u:Int=0,val v:Int=0)
    private data class Feature(val kind:String,val color:Int,val points:List<Point>)
    private data class Site(val shore:List<Point>,val features:List<Feature>)
    private val sites:List<Site>
    init {
        fun points(array:JsonValue):List<Point> = array.map { p -> Point(p.getDouble("lon")*180/Math.PI,p.getDouble("lat")*180/Math.PI,p.getInt("u",0),p.getInt("v",0)) }
        sites=JsonReader().parse(file).map { site ->
            Site(points(site.get("shore")),site.get("features").map { f ->
                val kind=f.getString("kind")
                val color=when(kind){"fall"->"d4f2ed";"beacon"->f.getString("tint",if(f.getString("group")=="aurora")"d9ecff" else "fff0bd").removePrefix("#");"vent"->"ffc18a";"spore"->"d6e9bb";else->error("Unknown authored island effect")}
                Feature(kind,color.toInt(16),points(f.get("pixels")))
            })
        }
        require(sites.size==art.islands.size)
    }
    private fun visible(island:GlobeIsland,view:GlobeView,viewport:GlobeViewport,cssScale:Double):Boolean {
        val p=GlobeGeometry.project(island.lon,island.lat,view,viewport);val radius=viewport.radius(view)
        return p.z>.2 && 2*island.rx*Math.PI/180*cos(island.lat*Math.PI/180)*radius*cssScale*p.z>=48 && p.x> -30 && p.x<viewport.width+30 && p.y> -30 && p.y<viewport.height+30
    }
    fun visible(view:GlobeView,viewport:GlobeViewport,cssScale:Double)=art.islands.any { visible(it,view,viewport,cssScale) }
    fun draw(frame:IntArray,view:GlobeView,viewport:GlobeViewport,elapsedMs:Double,motion:Boolean,cssScale:Double) {
        val radius=viewport.radius(view);val phase=if(motion)floor(elapsedMs/125).toInt()%8 else 0
        fun pixel(point:Point,color:Int,w:Int=2,h:Int=1,alpha:Double=1.0) {
            val p=GlobeGeometry.project(point.lon,point.lat,view,viewport);if(p.z<=.2)return
            val x=p.x.roundToInt();val y=p.y.roundToInt()
            for(py in max(0,y) until min(viewport.height,y+h))for(px in max(0,x) until min(viewport.width,x+w)) {
                val index=py*viewport.width+px;val before=frame[index];val oldAlpha=(before and 255)/255.0
                val a=alpha+oldAlpha*(1-alpha)
                fun channel(shift:Int)=((((color ushr shift) and 255)*alpha+((before ushr (shift+8)) and 255)*oldAlpha*(1-alpha))/a).roundToInt().coerceIn(0,255)
                frame[index]=(channel(16) shl 24) or (channel(8) shl 16) or (channel(0) shl 8) or (a*255).roundToInt()
            }
        }
        for((index,island)in art.islands.withIndex()) {
            if(!visible(island,view,viewport,cssScale))continue
            val site=sites[index]
            site.shore.forEachIndexed { n,p -> if((n+phase)%3!=0)pixel(p,0xbbd8d1) }
            val size=max(1,(radius*Math.PI/180*2*art.extent*max(island.rx*cos(island.lat*Math.PI/180),island.ry)/art.cell).roundToInt())
            for(feature in site.features)for(point in feature.points) {
                if(!active(feature.kind,point.u,point.v,phase))continue
                pixel(point,feature.color,size,size,opacity(feature.kind,phase))
            }
        }
    }
    companion object {
        // Production featureFrame; modulo stays positive for the falling-water frames.
        internal fun active(kind:String,u:Int,v:Int,phase:Int):Boolean = when(kind){"beacon"->true;"fall"->((v-phase*2)%12+12)%12<3;"vent"->(v+phase*2)%10<4;"spore"->(u*3+v+phase)%11<2;else->false}
        internal fun opacity(kind:String,phase:Int)=when(kind){"beacon"->doubleArrayOf(.25,.4,.6,.85,.95,.75,.55,.35)[phase%8];"vent"->.6;else->.75}
    }
}
