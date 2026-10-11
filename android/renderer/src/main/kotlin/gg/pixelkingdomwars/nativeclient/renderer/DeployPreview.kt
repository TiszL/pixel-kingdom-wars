package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.utils.JsonValue

data class DeployPreviewMark(val id:Long,val key:DeployMarkerKey)
data class DeployPreviewSeat(val mark:DeployPreviewMark,val x:Float,val y:Float,val depth:Float,val count:Int)

/** HeroFx's initial loop is its own primary attack; V2 bodies enter, then stand. */
internal fun deploymentClips(art:CombatArt,hero:Boolean):Pair<AuthoredClip?,AuthoredClip?> {
    val stand=if(hero)art.profile.get("attack")?.get(0)?.asString() else art.profile.getString("stand","idle")
    return (if(hero)null else art.clips[art.profile.getString("spawn","")]) to art.clips[stand]
}
data class DeployPreviewBadge(val rightInset:Float,val topInset:Float,val fontSize:Float,val color:String,val background:String,
    val paddingX:Float,val paddingY:Float,val stroke:String,val strokeThickness:Float) {
    init {
        require(listOf(rightInset,topInset,fontSize,paddingX,paddingY,strokeThickness).all {it.isFinite()&&it>=0}&&fontSize>0)
        require(listOf(color,background,stroke).all {it.matches(Regex("#[0-9a-fA-F]{6}"))})
    }
}

/** BattleScene.deployPreviewOffset, evaluated from the frozen source by the exporter.
 * These offsets change presentation only; the order retains its exact authoritative tile. */
data class DeployPreviewPolicy(val directions:List<Pair<Float,Float>>,val firstRadius:Float,val radiusStep:Float,
                              val maxRadius:Float,val depthStep:Float,val badge:DeployPreviewBadge?=null) {
    init {
        require(directions.isNotEmpty() && directions.all { (x,y)->x.isFinite() && y.isFinite() &&
            x in -1f..1f && y in -1f..1f && (x!=0f || y!=0f) })
        require(firstRadius.isFinite() && firstRadius>0 && radiusStep.isFinite() && radiusStep>0 &&
            maxRadius.isFinite() && maxRadius>=firstRadius && depthStep.isFinite() && depthStep>0)
    }
    fun offset(index:Int,total:Int):Pair<Float,Float> {
        require(index>=0 && index<total)
        if(total==1)return 0f to 0f
        val (x,y)=directions[index%directions.size]
        val radius=(firstRadius+(index/directions.size)*radiusStep).coerceAtMost(maxRadius)
        return x*radius to y*radius
    }
    fun seats(marks:List<DeployPreviewMark>,tile:Float):List<DeployPreviewSeat> {
        require(tile.isFinite() && tile>0 && marks.map {it.id}.distinct().size==marks.size)
        val groups=marks.groupBy {it.key.tx to it.key.ty}
        return groups.values.flatMap { stack->stack.mapIndexed { index,mark->
            val (dx,dy)=offset(index,stack.size)
            val x=(mark.key.tx+.5f)*tile+dx;val y=(mark.key.ty+.5f)*tile+dy
            DeployPreviewSeat(mark,x,y,y+index*depthStep,stack.size)
        } }
    }
    companion object {
        fun parse(value:JsonValue?):DeployPreviewPolicy?=value?.let { v->
            require(v.getInt("version")==1 && v.getString("lifetime")=="scene")
            val b=requireNotNull(v.get("badge"));require(b.getString("fontFamily")=="VT323")
            DeployPreviewPolicy(v.get("directions").map { require(it.isArray && it.size==2);it.getFloat(0) to it.getFloat(1) },
                v.getFloat("firstRadius"),v.getFloat("radiusStep"),v.getFloat("maxRadius"),v.getFloat("depthStep"),
                DeployPreviewBadge(b.getFloat("rightInset"),b.getFloat("topInset"),b.getFloat("fontSize"),b.getString("color"),b.getString("background"),
                    b.getFloat("paddingX"),b.getFloat("paddingY"),b.getString("stroke"),b.getFloat("strokeThickness")))
        }
    }
}
