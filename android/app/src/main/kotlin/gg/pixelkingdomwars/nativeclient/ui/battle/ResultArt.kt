package gg.pixelkingdomwars.nativeclient.ui.battle

import android.graphics.BitmapFactory
import android.graphics.BitmapRegionDecoder
import android.graphics.Rect
import android.os.Build
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import gg.pixelkingdomwars.nativeclient.data.ContentState
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.serialization.json.*
import java.io.File

internal data class ResultCrop(val image:String,val x:Int,val y:Int,val width:Int,val height:Int) {
    fun inside(width:Int,height:Int)=x>=0&&y>=0&&this.width>0&&this.height>0&&x.toLong()+this.width<=width&&y.toLong()+this.height<=height
    companion object {
        fun star(atlas:JsonObject,key:String):ResultCrop {
            val found=atlas.getValue("textures").jsonArray.flatMap { raw->val page=raw.jsonObject
                page.getValue("frames").jsonArray.map { page to it.jsonObject }
            }.filter { it.second["filename"]?.jsonPrimitive?.content==key }.single()
            val frame=found.second;require(frame["rotated"]?.jsonPrimitive?.boolean==false&&frame["trimmed"]?.jsonPrimitive?.boolean==false)
            val box=frame.getValue("frame").jsonObject;val original=frame.getValue("sourceSize").jsonObject
            fun JsonObject.n(k:String)=getValue(k).jsonPrimitive.int
            require(original.n("w")==box.n("w")&&original.n("h")==box.n("h"))
            val file=found.first.getValue("image").jsonPrimitive.content
            require(file.matches(Regex("ui@1x(?:_[0-9]+)?\\.png")))
            return ResultCrop("atlas/$file",box.n("x"),box.n("y"),box.n("w"),box.n("h"))
        }
    }
}
internal data class ResultArt(val star:ImageBitmap,val effects:Map<String,ImageBitmap>)
/** Only the seven admitted result cells are decoded. No URL, font, whole-atlas bitmap cache
 * or substitute game-v4 FX is introduced; the six tiny PNGs are literal React SVG exports. */
internal suspend fun loadResultArt(content:ContentState,policy:ResultPresentation):ResultArt {
    val assets=requireNotNull(content.assets);val pins=requireNotNull(content.manifest).files.associateBy { it.path }
    val job=currentCoroutineContext()
    fun file(relative:String):File {
        job.ensureActive();val pin=requireNotNull(pins[relative]);val file=File(assets,relative)
        require(file.canonicalFile.toPath().startsWith(assets.canonicalFile.toPath())&&file.isFile&&file.length()==pin.size)
        return file
    }
    val atlas=Json.parseToJsonElement(file(policy.stars.atlas).readText()).jsonObject
    val crop=ResultCrop.star(atlas,policy.stars.key)
    @Suppress("DEPRECATION") // API28–30 compatibility; the API31 overload removes only isShareable.
    val decoder=if(Build.VERSION.SDK_INT>=31)BitmapRegionDecoder.newInstance(file(crop.image).absolutePath)
        else BitmapRegionDecoder.newInstance(file(crop.image).absolutePath,false)
    val star=try {
        val d=requireNotNull(decoder);require(crop.inside(d.width,d.height))
        requireNotNull(d.decodeRegion(Rect(crop.x,crop.y,crop.x+crop.width,crop.y+crop.height),BitmapFactory.Options().apply { inScaled=false })).asImageBitmap()
    } finally { decoder?.recycle() }
    val images=policy.effects.flatMap { it.frames }.distinct().associate { frame->
        val source=file(frame.path);val bounds=BitmapFactory.Options().apply { inJustDecodeBounds=true }
        BitmapFactory.decodeFile(source.absolutePath,bounds);require(bounds.outWidth==frame.width&&bounds.outHeight==frame.height)
        frame.path to requireNotNull(BitmapFactory.decodeFile(source.absolutePath,BitmapFactory.Options().apply { inScaled=false })).asImageBitmap()
    }
    job.ensureActive();return ResultArt(star,images)
}
