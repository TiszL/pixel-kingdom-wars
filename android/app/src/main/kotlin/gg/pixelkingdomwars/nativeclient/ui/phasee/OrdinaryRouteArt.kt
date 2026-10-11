package gg.pixelkingdomwars.nativeclient.ui.phasee

import android.graphics.BitmapFactory
import android.graphics.BitmapRegionDecoder
import android.graphics.Rect
import android.os.Build
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.*
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import gg.pixelkingdomwars.nativeclient.AppGraph
import gg.pixelkingdomwars.nativeclient.SessionGraph
import gg.pixelkingdomwars.nativeclient.data.ContentState
import gg.pixelkingdomwars.nativeclient.data.WorldContentSession
import gg.pixelkingdomwars.nativeclient.data.worldContentGroups
import gg.pixelkingdomwars.nativeclient.vehicle.OrdinaryRouteCrop
import gg.pixelkingdomwars.nativeclient.ui.Palette
import kotlinx.coroutines.*
import kotlinx.serialization.json.jsonObject
import java.io.File

/** Reuses admitted optional-content leases. No renderer/exporter, generated image,
 * remote URL or replacement pack is introduced. Only the selected cell is decoded. */
@Composable internal fun OrdinaryRouteArtwork(graph:AppGraph,session:SessionGraph,content:ContentState,
 body:@Composable ((@Composable (OrdinaryRouteCrop)->Unit))->Unit) {
 val lifecycle=LocalLifecycleOwner.current.lifecycle
 var source by remember(content.assets,content.renderCatalogue){mutableStateOf<WorldContentSession?>(null)}
 LaunchedEffect(content.assets,content.renderCatalogue,lifecycle) {
  lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
   try {
    val acquired=graph.worldContent.open(content,session.api)
    try {ensureActive();source=acquired;awaitCancellation()}
    finally {if(source===acquired)source=null;acquired.close()}
   }catch(cancelled:CancellationException){throw cancelled}catch(_:Exception){source=null}
  }
 }
 body {crop->OrdinaryRouteImage(source,content,crop)}
}

private data class RouteImage(val source:WorldContentSession,val crop:OrdinaryRouteCrop,val bitmap:ImageBitmap)
@Composable private fun OrdinaryRouteImage(source:WorldContentSession?,content:ContentState,crop:OrdinaryRouteCrop) {
 val decoded by produceState<RouteImage?>(null,source,crop) {
  value=null;val active=source?:return@produceState
  try {val bitmap=loadOrdinaryRouteCrop(active,content,crop);ensureActive();value=RouteImage(active,crop,bitmap)}
  catch(cancelled:CancellationException){throw cancelled}catch(_:Exception){value=null}
 }
 val image=decoded?.takeIf{it.source===source&&it.crop==crop}?.bitmap
 if(image==null)Text("Island artwork is unavailable in this content pack. Route details remain available.",color=Palette.muted)
 else Image(image,crop.path.substringAfterLast('/').removeSuffix("-detail.png")+" island",Modifier.fillMaxWidth().height(152.dp),contentScale=ContentScale.Fit)
}

internal suspend fun loadOrdinaryRouteCrop(source:WorldContentSession,content:ContentState,crop:OrdinaryRouteCrop):ImageBitmap=withContext(Dispatchers.IO) {
 val context=currentCoroutineContext();context.ensureActive()
 val groups=worldContentGroups(requireNotNull(content.renderCatalogue).getValue("fantasy").jsonObject)
 val group=groups.single{g->g.files.any{it.path==crop.path}}
 val pin=group.files.single{it.path==crop.path}
 val lease=source.assets.acquire(group.id){context.ensureActive()}
 try {
  context.ensureActive();val directory=lease.directory.file();val file=File(directory,crop.path)
  require(file.canonicalFile.toPath().startsWith(directory.canonicalFile.toPath())&&file.isFile&&file.length()==pin.size)
  @Suppress("DEPRECATION")
  val decoder=if(Build.VERSION.SDK_INT>=31)BitmapRegionDecoder.newInstance(file.absolutePath) else BitmapRegionDecoder.newInstance(file.absolutePath,false)
  try {
   requireNotNull(decoder);require(decoder.width==crop.atlas&&decoder.height==crop.atlas&&crop.x>=0&&crop.y>=0&&crop.cell>0&&crop.x.toLong()+crop.cell<=decoder.width&&crop.y.toLong()+crop.cell<=decoder.height)
   val image=requireNotNull(decoder.decodeRegion(Rect(crop.x,crop.y,crop.x+crop.cell,crop.y+crop.cell),BitmapFactory.Options().apply{inScaled=false}))
   context.ensureActive();image.asImageBitmap()
  }finally{decoder?.recycle()}
 }finally{lease.close()}
}
