package gg.pixelkingdomwars.nativeclient.renderer

import kotlin.math.abs
import kotlin.math.hypot

/** Contact ownership survives the two-finger to one-finger transition. Orphan platform move/up
 * events never create contacts or selections, including after cancellation/backgrounding. */
class GlobeGestureState(private val tapSlop: Double) {
    data class Delta(val dx: Int = 0, val dy: Int = 0, val scale: Double = 1.0)
    data class End(val settled: Boolean, val tap: Boolean)
    private val points=linkedMapOf<Int,Pair<Int,Int>>()
    private var origin=0 to 0
    private var moved=false
    private var distance=0.0
    val contacts: Int get()=points.size
    fun down(pointer:Int,x:Int,y:Int):Boolean {
        if(pointer in points || points.size>=2)return false
        points[pointer]=x to y
        if(points.size==1){origin=x to y;moved=false}
        if(points.size==2){distance=pinchDistance();moved=true}
        return true
    }
    private fun pinchDistance():Double {val p=points.values.toList();return hypot((p[0].first-p[1].first).toDouble(),(p[0].second-p[1].second).toDouble())}
    fun drag(pointer:Int,x:Int,y:Int):Delta? {
        val old=points[pointer] ?: return null
        points[pointer]=x to y
        if(points.size==2) {
            val next=pinchDistance();val scale=if(distance>0)next/distance else 1.0
            distance=next;return Delta(scale=scale)
        }
        if(abs(x-origin.first)+abs(y-origin.second)>tapSlop)moved=true
        return Delta(x-old.first,y-old.second)
    }
    fun up(pointer:Int):End? {
        if(points.remove(pointer)==null)return null
        distance=0.0
        return End(points.isEmpty(),points.isEmpty()&&!moved)
    }
    fun cancel(pointer:Int):Boolean {
        // libGDX dispatches one callback for Android ACTION_CANCEL and clears all platform contacts,
        // even when its named pointer was an ignored third finger. No remaining point is still held.
        val owned=pointer in points
        clear();return owned
    }
    fun clear(){points.clear();moved=true;distance=0.0}
}
