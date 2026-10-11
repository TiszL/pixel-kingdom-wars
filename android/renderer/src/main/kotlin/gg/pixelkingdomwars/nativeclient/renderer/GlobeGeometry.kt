package gg.pixelkingdomwars.nativeclient.renderer

import kotlin.math.*

/** Presentation geometry from the production fantasy runtime; never simulation/gameplay math. */
data class GlobeView(val lon: Double = 26.0, val lat: Double = 23.0, val zoom: Double = 1.0) {
    fun normalized() = GlobeView(GlobeGeometry.wrap(lon), lat.coerceIn(-85.0, 85.0), zoom.coerceIn(.8, 256.0))
}
data class GlobePoint(val x: Double, val y: Double, val z: Double)
data class GlobeRect(val x0: Int, val y0: Int, val x1: Int, val y1: Int)
data class GlobeReadScope(val rectangles: List<GlobeRect>, val truncated: Boolean)
data class GlobeViewport(val width: Int, val height: Int) {
    fun radius(view: GlobeView) = min(width, height) * (176.0 / 400.0) * view.zoom
}

object GlobeGeometry {
    private const val RAD = Math.PI / 180
    fun wrap(degrees: Double) = ((degrees + 180) % 360 + 360) % 360 - 180
    fun project(lon: Double, lat: Double, view: GlobeView, viewport: GlobeViewport): GlobePoint {
        val d = (lon - view.lon) * RAD; val cp = cos(lat * RAD); val sp = sin(lat * RAD)
        val s0 = sin(view.lat * RAD); val c0 = cos(view.lat * RAD); val radius = viewport.radius(view)
        return GlobePoint(viewport.width / 2.0 + radius * cp * sin(d), viewport.height / 2.0 - radius * (c0 * sp - s0 * cp * cos(d)), s0 * sp + c0 * cp * cos(d))
    }
    fun unproject(x: Double, y: Double, view: GlobeView, viewport: GlobeViewport): Pair<Double, Double>? {
        val radius = viewport.radius(view)
        if (radius <= 0) return null
        val nx = (x - viewport.width / 2.0) / radius; val up = -(y - viewport.height / 2.0) / radius
        val r2 = nx * nx + up * up; if (r2 > 1) return null
        val z = sqrt(max(0.0, 1 - r2)); val s = sin(view.lat * RAD); val c = cos(view.lat * RAD)
        return wrap(view.lon + atan2(nx, z * c - up * s) / RAD) to asin((up * c + z * s).coerceIn(-1.0, 1.0)) / RAD
    }
    /** Production inspected-cell and authored-patch fit in the actual clear surface. */
    fun focusTile(lon:Double,lat:Double,viewport:GlobeViewport,columns:Int,density:Double):GlobeView {
        val radius=viewport.radius(GlobeView()).coerceAtLeast(1.0)
        return GlobeView(lon,lat,(50*density/(radius*2*Math.PI/columns*cos(lat*RAD))).coerceIn(16.0,256.0)).normalized()
    }
    fun focusIsland(site:GlobeIsland,extent:Double,viewport:GlobeViewport,density:Double):GlobeView {
        val initial=GlobeView(site.lon,site.lat);val radius=viewport.radius(initial).coerceAtLeast(1.0)
        var zoom=(280*density/(2*site.rx*RAD*cos(site.lat*RAD)*radius)).coerceIn(4.0,64.0)
        var x=0.0;var y=0.0
        for(dx in -1..1)for(dy in -1..1) {
            val point=project(site.lon+dx*site.rx*extent,site.lat+dy*site.ry*extent,initial,viewport)
            x=max(x,abs(point.x-viewport.width/2.0));y=max(y,abs(point.y-viewport.height/2.0))
        }
        zoom=minOf(zoom,max(1.0,viewport.width-32*density)/(2*x),max(1.0,viewport.height-32*density)/(2*y))
        return initial.copy(zoom=zoom.coerceIn(.8,64.0)).normalized()
    }
    /** One source of viewport geometry for drawing and fetching. Split dateline before quantizing
     * requests to the server catalogue bounds; pole caps include all longitudes. */
    fun viewportRects(view: GlobeView, viewport: GlobeViewport, columns: Int, rows: Int, quantum: Int, maxCells: Int, maxSpan: Int): List<GlobeRect> {
        require(columns > 0 && rows > 0 && quantum > 0 && maxCells > 0 && maxSpan > 0)
        if (view.zoom < 5 || viewport.width <= 0 || viewport.height <= 0) return emptyList()
        var west = Double.POSITIVE_INFINITY; var east = Double.NEGATIVE_INFINITY
        var south = Double.POSITIVE_INFINITY; var north = Double.NEGATIVE_INFINITY
        for (edge in 0..3) for (n in 0..32) {
            val x = if (edge < 2) n * viewport.width / 32.0 else if (edge == 2) 0.0 else viewport.width.toDouble()
            val y = if (edge >= 2) n * viewport.height / 32.0 else if (edge == 0) 0.0 else viewport.height.toDouble()
            val point = unproject(x, y, view, viewport) ?: continue
            val lon = view.lon + wrap(point.first - view.lon)
            west = min(west, lon); east = max(east, lon); south = min(south, point.second); north = max(north, point.second)
        }
        val radius = viewport.radius(view)
        for (pole in listOf(-1, 1)) {
            val y = viewport.height / 2.0 - pole * radius * cos(view.lat * RAD)
            if (pole * sin(view.lat * RAD) > 0 && y in 0.0..viewport.height.toDouble()) {
                if (pole > 0) north = 90.0 else south = -90.0
                west = view.lon - 180; east = view.lon + 180
            }
        }
        if (!west.isFinite()) return emptyList()
        fun floorQ(value: Double) = floor(value / quantum).toInt() * quantum
        fun ceilQ(value: Double) = ceil(value / quantum).toInt() * quantum - 1
        val left = floorQ(floor((west + 180) * columns / 360) - 2)
        val right = min(left + columns - 1, ceilQ(floor((east + 180) * columns / 360) + 3))
        val top = max(0, floorQ(floor((90 - north) * rows / 180) - 2))
        val bottom = min(rows - 1, ceilQ(floor((90 - south) * rows / 180) + 3))
        val sorted = (left..right).map { ((it % columns) + columns) % columns }.distinct().sorted()
        val ranges = mutableListOf<IntRange>()
        for (x in sorted) { val last = ranges.lastOrNull(); if (last != null && last.last + 1 == x) ranges[ranges.lastIndex] = last.first..x else ranges += x..x }
        val side = min(maxSpan, sqrt(maxCells.toDouble()).toInt()).coerceAtLeast(1)
        return buildList { for (range in ranges) for (y in top..bottom step side) for (x in range step side) add(GlobeRect(x, y, min(range.last, x + side - 1), min(bottom, y + side - 1))) }
    }
    /** Canonical nearest-first request budget (`visibleParcelBounds`). A polar/wide footprint
     * may exceed it; disclose partial coverage rather than drawing a falsely complete world. */
    fun boundedScope(view: GlobeView, viewport: GlobeViewport, columns: Int, rows: Int, quantum: Int, maxCells: Int, maxSpan: Int, maxRequests: Int): GlobeReadScope {
        require(maxRequests > 0)
        val all=viewportRects(view,viewport,columns,rows,quantum,maxCells,maxSpan)
        fun distance(rect: GlobeRect): Double {
            val lon=-180+(rect.x0+rect.x1+1)/2.0*360/columns
            val lat=90-(rect.y0+rect.y1+1)/2.0*180/rows
            val dx=wrap(lon-view.lon)*cos(view.lat*RAD)
            return dx*dx+(lat-view.lat)*(lat-view.lat)
        }
        val nearest=all.sortedWith(compareBy<GlobeRect>{distance(it)}.thenBy{it.y0}.thenBy{it.x0})
        return GlobeReadScope(nearest.take(maxRequests),all.size>maxRequests)
    }
    fun tileAt(lon: Double, lat: Double, columns: Int, rows: Int): Int {
        val x = floor((wrap(lon) + 180) / 360 * columns).toInt().coerceIn(0, columns - 1)
        val y = floor((90 - lat.coerceIn(-90.0, 90.0)) / 180 * rows).toInt().coerceIn(0, rows - 1)
        return y * columns + x
    }
}
