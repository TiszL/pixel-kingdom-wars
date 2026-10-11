package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.utils.JsonReader
import com.badlogic.gdx.utils.JsonValue
import java.awt.RenderingHints
import java.awt.geom.AffineTransform
import java.awt.image.BufferedImage
import java.io.File
import javax.imageio.ImageIO
import kotlin.math.ceil

internal data class CpuSpriteGeometry(val left: Float,val top: Float,val width: Float,val cropPixels: Int)

/** Mirror the native placement anchor and width together, without reflecting the anchor twice. */
internal fun cpuSpriteGeometry(sourceW: Float,sourceH: Float,trimX: Float,trimY: Float,frameWidth: Int,
    anchorX: Float,anchorY: Float,scale: Float,cropWidth: Float,flipX: Boolean,rotation: Float): CpuSpriteGeometry {
    val width = minOf(frameWidth.toFloat(),cropWidth / scale - trimX).coerceAtLeast(0f)
    val mirroredAnchor = if(flipX) 1f - anchorX else anchorX
    val reflect = flipX && rotation == 0f // Native's rotated draw uses its unflipped region.
    val left = -sourceW * mirroredAnchor + if(reflect) sourceW - trimX else trimX
    return CpuSpriteGeometry(left,-sourceH * anchorY + trimY,if(reflect) -width else width,ceil(width).toInt())
}

/** Explicit service metadata has no static fallback. Malformed legacy rows still fail. */
internal fun cpuStaticBuildingEntries(catalog:JsonValue):List<JsonValue> = catalog.get("entries").filter { entry ->
    if(entry.has("phaseE")) {
        require(catalog.getInt("rendererContractVersion")==15)
        PhaseEServiceArt.entry(entry)
        false
    } else { entry.getString("frameKey");true }
}

internal fun requireCpuLegacyBuildings(buildings:List<RenderBuilding>) {
    require(buildings.none { it.service!=null }) { "CPU proof does not implement service artwork; use the real GL harness" }
}

/** Test-only visual proof of the immutable sprite plan against the actual packed source artwork.
 * This is a CPU rasterization diagnostic, not an OpenGL screenshot or a device performance result. */
internal class CpuCombatProof(private val root: File) {
    private data class Frame(val image: File, val x: Int, val y: Int, val w: Int, val h: Int,
        val sourceW: Float, val sourceH: Float, val trimX: Float, val trimY: Float)
    private val frames = mutableMapOf<String,Frame>()
    private val atlases = mutableSetOf<String>()
    private val textures = mutableMapOf<File,BufferedImage>()
    fun write(scene: BattleScene, model: BattleVisualModel, plan: CombatVisualPlan, catalog: JsonValue, tick: Float, name: String, walls: WallVisualModel? = null, pixels: Int = 1024): File {
        requireCpuLegacyBuildings(scene.base.buildings)
        val staticEntries=cpuStaticBuildingEntries(catalog)
        val image=BufferedImage(pixels,pixels,BufferedImage.TYPE_INT_ARGB)
        val g=image.createGraphics();g.setRenderingHint(RenderingHints.KEY_INTERPOLATION,RenderingHints.VALUE_INTERPOLATION_NEAREST_NEIGHBOR)
        g.color=java.awt.Color(9,14,10);g.fillRect(0,0,image.width,image.height)
        g.scale(image.width/(scene.base.columns*scene.base.tilePixels).toDouble(),image.height/(scene.base.rows*scene.base.tilePixels).toDouble())
        val terrain=catalog.get("terrain");load(terrain.getString("atlasPath"))
        val terrainFrame=frames.getValue(terrain.getString("frameKey"));val ground=textures.getOrPut(terrainFrame.image) { ImageIO.read(terrainFrame.image) }
        for(y in 0 until scene.base.rows) for(x in 0 until scene.base.columns) {
            val size=scene.base.tilePixels.toInt();g.drawImage(ground,x*size,y*size,(x+1)*size,(y+1)*size,
                terrainFrame.x,terrainFrame.y,terrainFrame.x+terrainFrame.w,terrainFrame.y+terrainFrame.h,null)
        }
        data class Paint(val sprite: CombatSprite,val building: Boolean=false)
        val sprites=mutableListOf<Paint>()
        for(building in scene.base.buildings) {
            val animated=plan.building(building.id,tick,frameKey=walls?.frameAt(building.id,tick),frameSinceTick=walls?.frameSinceTick(building.id,tick) ?: 0)
            if(animated!=null) sprites+=Paint(animated,true)
            else if(!model.isDestroyed(building.id,tick)) {
                val key=walls?.frameAt(building.id,tick) ?: building.frameKey
                val entry=(staticEntries+catalog.get("walls").toList()).first { it.getString("frameKey")==key }
                load(entry.getString("atlasPath"));val f=frames.getValue(key)
                val clip=AuthoredClip(key,entry.getString("atlasPath"),listOf(listOf(key)),listOf("s"),0f,
                    entry.get("anchor").getFloat(0),1f,entry.getFloat("scale"),f.sourceW,f.sourceH,false,null,emptyMap())
                sprites+=Paint(CombatSprite(clip,key,(building.tileX+building.footprintWidth/2)*scene.base.tilePixels,
                    (building.tileY+building.footprintHeight)*scene.base.tilePixels,(building.tileY+building.footprintHeight)*scene.base.tilePixels),true)
            }
        }
        model.actorIds.mapNotNull { plan.actor(it,tick) }.forEach { sprites+=Paint(it) }
        val fx=mutableListOf<CombatSprite>();plan.transientSprites(tick,fx);fx.forEach { sprites+=Paint(it) }
        val strokes=mutableListOf<CombatStroke>();plan.transientStrokes(tick,strokes)
        val ordered=(sprites.map { it.sprite.depth to it } + strokes.map { it.depth to it }).sortedBy { it.first }
        for((_,item) in ordered) {
            if(item is CombatStroke) {
                val old=g.composite
                g.composite=java.awt.AlphaComposite.getInstance(java.awt.AlphaComposite.SRC_OVER,item.alpha)
                g.color=java.awt.Color(item.color);g.stroke=java.awt.BasicStroke(item.width,java.awt.BasicStroke.CAP_BUTT,java.awt.BasicStroke.JOIN_MITER)
                g.draw(java.awt.geom.Line2D.Float(item.fromX,item.fromY,item.toX,item.toY));g.composite=old
                continue
            }
            val paint=item as Paint
            val s=paint.sprite;load(s.clip.atlasPath);val f=frames.getValue(s.frameKey)
            val texture=textures.getOrPut(f.image) { ImageIO.read(f.image) }
            val geometry=cpuSpriteGeometry(f.sourceW,f.sourceH,f.trimX,f.trimY,f.w,s.clip.anchorX,
                if(paint.building)1f else s.clip.anchorY,s.horizontalScale,s.cropWidth,s.flipX,s.rotation)
            if(geometry.cropPixels==0)continue
            val old=g.transform;val oldComposite=g.composite
            g.translate(s.x.toDouble(),s.y.toDouble());g.rotate(Math.toRadians(s.rotation.toDouble()))
            g.scale(s.horizontalScale.toDouble(),s.clip.scale.toDouble())
            g.composite=java.awt.AlphaComposite.getInstance(java.awt.AlphaComposite.SRC_OVER,s.alpha)
            val transform=AffineTransform.getTranslateInstance(geometry.left.toDouble(),geometry.top.toDouble())
            transform.scale((geometry.width/geometry.cropPixels).toDouble(),1.0)
            g.drawImage(texture.getSubimage(f.x,f.y,geometry.cropPixels,f.h),transform,null)
            g.transform=old;g.composite=oldComposite
        }
        g.dispose();val output=File("../.reports/visual/combat/$name.png");output.parentFile.mkdirs();ImageIO.write(image,"png",output)
        return output
    }
    /** One authored facing per row, with comparable release/mid/last-pin/expiry columns.
     * Individual full-resolution files remain available; a contact sheet is only an index. */
    fun contactSheet(captures: List<Pair<String,File>>, columns: Int, title: String, name: String): File {
        val cell=384;val label=28;val rows=(captures.size+columns-1)/columns
        val sheet=BufferedImage(columns*cell,rows*(cell+label)+label,BufferedImage.TYPE_INT_ARGB)
        val g=sheet.createGraphics();g.color=java.awt.Color(16,20,24);g.fillRect(0,0,sheet.width,sheet.height)
        g.font=java.awt.Font(java.awt.Font.MONOSPACED,java.awt.Font.PLAIN,14)
        g.color=java.awt.Color.WHITE;g.drawString(title,8,19)
        g.setRenderingHint(RenderingHints.KEY_INTERPOLATION,RenderingHints.VALUE_INTERPOLATION_NEAREST_NEIGHBOR)
        for((index,capture) in captures.withIndex()) {
            val x=index%columns*cell;val y=index/columns*(cell+label)+label
            g.color=java.awt.Color.WHITE;g.drawString(capture.first,x+8,y+19)
            g.drawImage(ImageIO.read(capture.second),x,y+label,cell,cell,null)
        }
        g.dispose();val output=File("../.reports/visual/combat/$name.png");output.parentFile.mkdirs();ImageIO.write(sheet,"png",output)
        return output
    }
    fun writeBase(scene: BaseScene, model: BaseVisualModel, catalog: JsonValue, nowMs: Long, name: String) {
        requireCpuLegacyBuildings(scene.buildings)
        val staticEntries=cpuStaticBuildingEntries(catalog)
        val image=BufferedImage(1024,(1024L*scene.rows/scene.columns).toInt().coerceAtLeast(1),BufferedImage.TYPE_INT_ARGB)
        val g=image.createGraphics();g.setRenderingHint(RenderingHints.KEY_INTERPOLATION,RenderingHints.VALUE_INTERPOLATION_NEAREST_NEIGHBOR)
        g.color=java.awt.Color(9,14,10);g.fillRect(0,0,image.width,image.height)
        val worldScale=image.width/(scene.columns*scene.tilePixels).toDouble()
        g.scale(worldScale,worldScale) // A rectangular world must not stretch authored pixel art.
        val terrain=catalog.get("terrain");load(terrain.getString("atlasPath"))
        val ground=frames.getValue(terrain.getString("frameKey"));val groundImage=textures.getOrPut(ground.image) { ImageIO.read(ground.image) }
        for(y in 0 until scene.rows) for(x in 0 until scene.columns) {
            val size=scene.tilePixels.toInt();g.drawImage(groundImage,x*size,y*size,(x+1)*size,(y+1)*size,
                ground.x,ground.y,ground.x+ground.w,ground.y+ground.h,null)
        }
        val sprites=mutableListOf<BaseVisualSprite>()
        val entries=(staticEntries+catalog.get("walls").toList()+catalog.get("basePresentation").get("obstacles").toList())
            .associateBy { it.getString("frameKey") }
        val scenery=scene.obstacles.map { RenderBuilding(it.id,it.frameKey,it.tileX,it.tileY,it.footprintWidth,it.footprintHeight) }
        val walls=WallVisualModel(scene.buildings,WallCatalogue(catalog))
        for(original in scene.buildings+scenery) {
            val b=original.copy(frameKey=walls.frameAt(original.id,0f) ?: original.frameKey)
            val animated=model.building(b.id,nowMs)
            if(animated!=null) { sprites+=animated;continue }
            val entry=entries.getValue(b.frameKey);load(entry.getString("atlasPath"));val f=frames.getValue(b.frameKey)
            val clip=AuthoredClip(b.frameKey,entry.getString("atlasPath"),listOf(listOf(b.frameKey)),listOf("s"),0f,
                entry.get("anchor").getFloat(0),1f,entry.getFloat("scale"),f.sourceW,f.sourceH,false,null,emptyMap())
            val placement=placeBuilding(b,scene.tilePixels,f.sourceW,f.sourceH,clip.scale,clip.anchorX,entry.getFloat("offsetX",0f),entry.getFloat("offsetY",0f))
            sprites+=BaseVisualSprite(clip,b.frameKey,placement.left+placement.width*clip.anchorX,placement.top+placement.height,
                placement.width,placement.height,clip.anchorX,1f,model.structureDepth(placement.depth))
        }
        val jobs=mutableListOf<BaseVisualSprite>();model.jobs(nowMs,jobs);sprites+=jobs
        for(sprite in sprites.sortedBy { it.depth }) {
            load(sprite.clip.atlasPath);val f=frames.getValue(sprite.frameKey)
            val texture=textures.getOrPut(f.image) { ImageIO.read(f.image) }
            val sx=sprite.width/f.sourceW;val sy=sprite.height/f.sourceH
            val transform=AffineTransform.getTranslateInstance((sprite.x-sprite.width*sprite.anchorX+f.trimX*sx).toDouble(),
                (sprite.y-sprite.height*sprite.anchorY+f.trimY*sy).toDouble())
            transform.scale(sx.toDouble(),sy.toDouble())
            g.drawImage(texture.getSubimage(f.x,f.y,f.w,f.h),transform,null)
        }
        g.dispose();val output=File("../.reports/visual/base/$name.png");output.parentFile.mkdirs();ImageIO.write(image,"png",output)
    }
    private fun load(path:String) {
        if(!atlases.add(path))return
        val file=root.resolve(path)
        for(page in JsonReader().parse(file.readText()).get("textures")) for(f in page.get("frames")) {
            val b=f.get("frame");val source=f.get("sourceSize");val trim=f.get("spriteSourceSize")
            frames[f.getString("filename")]=Frame(file.parentFile.resolve(page.getString("image")),b.getInt("x"),b.getInt("y"),b.getInt("w"),b.getInt("h"),
                source.getFloat("w"),source.getFloat("h"),trim.getFloat("x"),trim.getFloat("y"))
        }
    }
}
