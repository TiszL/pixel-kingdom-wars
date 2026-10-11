package gg.pixelkingdomwars.nativeclient.ui.attack

import android.graphics.BitmapFactory
import android.graphics.BitmapRegionDecoder
import android.graphics.Rect
import android.os.Build
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.ProvideTextStyle
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.*
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.*
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import gg.pixelkingdomwars.nativeclient.R
import gg.pixelkingdomwars.nativeclient.content.ContentLease
import gg.pixelkingdomwars.nativeclient.data.ContentState
import gg.pixelkingdomwars.nativeclient.model.CampaignStage
import gg.pixelkingdomwars.nativeclient.network.fmtN
import gg.pixelkingdomwars.nativeclient.network.string
import gg.pixelkingdomwars.nativeclient.ui.Palette
import gg.pixelkingdomwars.nativeclient.ui.Notice
import gg.pixelkingdomwars.nativeclient.ui.chrome.GameArt
import gg.pixelkingdomwars.nativeclient.ui.chrome.PixelPlate
import gg.pixelkingdomwars.nativeclient.ui.chrome.PixelPanel
import gg.pixelkingdomwars.nativeclient.ui.chrome.Button
import gg.pixelkingdomwars.nativeclient.ui.chrome.OutlinedButton
import gg.pixelkingdomwars.nativeclient.ui.chrome.TextButton
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.LocalReducedMotion
import androidx.compose.animation.core.*
import kotlinx.coroutines.*
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*
import java.io.File
import gg.pixelkingdomwars.nativeclient.data.WorldContentPhase
import gg.pixelkingdomwars.nativeclient.data.WorldContentProgress
import gg.pixelkingdomwars.nativeclient.ui.chrome.CircularProgressIndicator

/** Exact source campaign.ts + authored campaign-presentation.json. This metadata has no progress or costs. */
@Serializable internal data class CampaignChapterArt(val id:Int,val region:String,val name:String,val epithet:String,val lore:String,val landmark:String,val names:List<String>)
@Serializable internal data class CampaignRegionArt(val name:String,val color:String,val crop:List<Int>,val points:List<List<Int>>,val ground:String) {
    fun inside(width:Int,height:Int)=crop.size==4 && crop[0]>=0 && crop[1]>=0 && crop[2]>0 && crop[3]>0 && crop[0].toLong()+crop[2]<=width && crop[1].toLong()+crop[3]<=height
}
@Serializable internal data class CampaignArtwork(val chapters:List<CampaignChapterArt>,val regions:Map<String,CampaignRegionArt>) {
    fun chapter(stage:CampaignStage)=chapters.find { it.id==stage.act }
    fun name(stage:CampaignStage,perAct:Int?)=perAct?.takeIf { it>0 }?.let { chapter(stage)?.names?.getOrNull((stage.stage-1).mod(it)) } ?: stage.name
    fun point(stage:CampaignStage,perAct:Int?):Pair<Float,Float>? {
        val region=chapter(stage)?.let { regions[it.region] } ?: return null
        val point=perAct?.takeIf { it>0 }?.let { region.points.getOrNull((stage.stage-1).mod(it)) } ?: return null
        return (point[0]-region.crop[0]).toFloat()/region.crop[2] to (point[1]-region.crop[1]).toFloat()/region.crop[3]
    }
    companion object { fun read(text:String)=Json.decodeFromString<CampaignArtwork>(text).also { art->
        require(art.chapters.isNotEmpty()&&art.chapters.map { it.id }.distinct().size==art.chapters.size)
        require(art.chapters.all { it.id>0&&it.region in art.regions&&it.names.isNotEmpty() })
        require(art.regions.values.all { it.inside(Int.MAX_VALUE,Int.MAX_VALUE)&&it.points.all { p->p.size==2&&p[0]>it.crop[0]&&p[0]<it.crop[0]+it.crop[2]&&p[1]>it.crop[1]&&p[1]<it.crop[1]+it.crop[3] } })
    } }
}
internal fun campaignStageState(stage:CampaignStage)=if(stage.bestStars>0)"cleared" else if(stage.unlocked)"available" else "locked"
internal fun campaignFrontier(stages:List<CampaignStage>)=stages.firstOrNull { it.unlocked&&it.bestStars==0 } ?: stages.lastOrNull()
internal fun campaignSelection(stages:List<CampaignStage>,selected:Int?)=stages.firstOrNull { it.stage==selected } ?: campaignFrontier(stages)
internal fun campaignReward(constants:JsonObject?,stage:CampaignStage):String? = stage.keepLevel?.takeIf { it>0 }?.let {
    ((constants?.get("CAMPAIGN") as? JsonObject)?.get("firstThreeStarShardsByKeep") as? JsonArray)?.getOrNull(it-1)?.jsonPrimitive?.content
}
internal fun campaignFlow(width:Float,height:Float)=width<=1000&&(height>480||width<600)

private data class CampaignImage(val generation:File,val region:String,val bitmap:ImageBitmap)

/** The same verified optional globe generation as World; decode/cache only four small region crops. */
private suspend fun campaignCrop(lease:ContentLease,region:CampaignRegionArt):ImageBitmap=withContext(Dispatchers.IO) {
    ensureActive()
    val relative="atlas/fantasy/globe/realm-texture.png"
    val pin=requireNotNull(lease.manifest?.files?.singleOrNull { it.path==relative })
    val file=File(lease.directory,relative)
    require(file.canonicalFile.toPath().startsWith(lease.directory.canonicalFile.toPath())&&file.isFile&&file.length()==pin.size)
    @Suppress("DEPRECATION")
    val decoder=if(Build.VERSION.SDK_INT>=31)BitmapRegionDecoder.newInstance(file.absolutePath) else BitmapRegionDecoder.newInstance(file.absolutePath,false)
    try {
        requireNotNull(decoder);require(region.inside(decoder.width,decoder.height))
        val c=region.crop
        val image=requireNotNull(decoder.decodeRegion(Rect(c[0],c[1],c[0]+c[2],c[1]+c[3]),BitmapFactory.Options().apply { inScaled=false }))
        ensureActive();image.asImageBitmap()
    } finally { decoder?.recycle() }
}

@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable internal fun FantasyCampaignScreen(model:AttackViewModel,stages:List<CampaignStage>,content:ContentState?,scopeKey:Any?,busy:Boolean,error:String?,
    onWorld:()->Unit,onBack:()->Unit,onHistory:()->Unit,onChooser:()->Unit,chooserEnabled:Boolean) {
    val context=LocalContext.current
    val lifecycle=LocalLifecycleOwner.current.lifecycle
    val constants=content?.catalogue?.get("constants") as? JsonObject
    val rules=constants?.get("CAMPAIGN") as? JsonObject
    val perAct=rules?.string("stagesPerAct")?.toIntOrNull()
    val cadence=(constants?.get("WORLD") as? JsonObject)?.string("mapPollSec")?.toLongOrNull()?.takeIf { it>0&&it<=Long.MAX_VALUE/1000 }?.times(1000)
    var readError by remember(scopeKey) { mutableStateOf<String?>(null) }
    LaunchedEffect(scopeKey,lifecycle,cadence) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            while(isActive) {
                try { model.readCampaign();readError=null }
                catch(cancelled:CancellationException){throw cancelled}
                catch(_:Exception){readError="Campaign progress could not refresh. Previously shown values may be out of date."}
                if(cadence==null)awaitCancellation() else delay(cadence)
            }
        }
    }
    val artwork by produceState<CampaignArtwork?>(null) { value=withContext(Dispatchers.IO) { context.resources.openRawResource(R.raw.pkw_campaign_presentation).bufferedReader().use { CampaignArtwork.read(it.readText()) } } }
    var selection by remember(scopeKey) { mutableStateOf<Int?>(null) }
    var detailsOpen by remember(scopeKey) { mutableStateOf(true) }
    var inspect by remember(scopeKey) { mutableIntStateOf(0) }
    var artAttempt by remember(scopeKey) { mutableIntStateOf(0) }
    var lease by remember(scopeKey,content?.assets) { mutableStateOf<ContentLease?>(null) }
    var artError by remember(scopeKey,content?.assets) { mutableStateOf(false) }
    LaunchedEffect(scopeKey,content?.assets,content?.renderCatalogue,lifecycle,artAttempt) {
        val generation=content ?: return@LaunchedEffect
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            try {
                val acquired=model.acquireCampaignArt(generation)
                try { ensureActive();lease=acquired;artError=false;awaitCancellation() }
                finally { if(lease===acquired)lease=null;acquired.close() }
            } catch(cancelled:CancellationException){throw cancelled} catch(_:Exception){artError=true}
        }
    }
    val selected=campaignSelection(stages,selection)
    val chapter=if(selected!=null)artwork?.chapter(selected) else artwork?.chapters?.firstOrNull()
    val region=chapter?.let { artwork?.regions?.get(it.region) }
    val chapterStages=stages.filter { it.act==chapter?.id }
    val cache=remember(lease) { mutableMapOf<String,ImageBitmap>() }
    val decoded by produceState<CampaignImage?>(null,lease,chapter?.region) {
        value=null
        val active=lease ?: return@produceState;val current=region ?: return@produceState;val key=chapter?.region ?: return@produceState
        try { val bitmap=cache[key] ?: campaignCrop(active,current).also { cache[key]=it };ensureActive();value=CampaignImage(active.directory,key,bitmap) }
        catch(cancelled:CancellationException){throw cancelled} catch(_:Exception){artError=true}
    }
    // Never display the prior region/generation while the new crop is decoding.
    val image=decoded?.takeIf { it.generation==lease?.directory&&it.region==chapter?.region }?.bitmap
    val artProgress by model.campaignArtProgress.collectAsState()
    val bodyScroll=rememberScrollState();val detailTarget=remember { BringIntoViewRequester() };val scope=rememberCoroutineScope()
    BoxWithConstraints(Modifier.fillMaxSize().background(Palette.backdrop)) {
        val viewportWidth=maxWidth
        val flow=campaignFlow(viewportWidth.value,maxHeight.value)
        val short=viewportWidth>=600.dp&&maxHeight<=480.dp
        fun pick(id:Int,show:Boolean=false) { if(stages.none { it.stage==id })return;selection=id;detailsOpen=!flow||show;if(show&&flow)inspect++ }
        LaunchedEffect(inspect) { if(inspect>0&&flow&&detailsOpen)detailTarget.bringIntoView() }
        val chapters:@Composable (Boolean)->Unit={ vertical->
            val items:@Composable ()->Unit={ artwork?.chapters?.forEach { c->
                val reveal=remember(c.id) { BringIntoViewRequester() }
                LaunchedEffect(chapter?.id) { if(chapter?.id==c.id)reveal.bringIntoView() }
                CampaignTab(onClick={stages.firstOrNull { it.act==c.id }?.let { pick(it.stage) }},enabled=stages.isNotEmpty(),
                    selected=chapter?.id==c.id,modifier=Modifier.bringIntoViewRequester(reveal).width(if(short)168.dp else 178.dp).heightIn(min=if(short)46.dp else 54.dp),contentPadding=PaddingValues(7.dp)) {
                    Text(c.id.toString().padStart(2,'0'),fontSize=20.sp,color=if(chapter?.id==c.id)Palette.goldHi else Palette.textFaint)
                    Column(Modifier.weight(1f)) { Text(c.name,fontSize=15.sp);Text("${artwork?.regions?.get(c.region)?.name} · ${stages.count { it.act==c.id&&it.bestStars>0 }}/${perAct ?: "—"}",fontSize=12.sp,color=Palette.muted) }
                }
            } }
            if(vertical)Column(Modifier.width(if(viewportWidth>1150.dp)210.dp else 180.dp).fillMaxHeight().background(Palette.ink).verticalScroll(rememberScrollState()).padding(6.dp),verticalArrangement=Arrangement.spacedBy(6.dp)){items()}
            else Row(Modifier.fillMaxWidth().background(Palette.ink).horizontalScroll(rememberScrollState()).padding(6.dp),horizontalArrangement=Arrangement.spacedBy(6.dp)){items()}
        }
        val expedition:@Composable ()->Unit={
            Column(Modifier.fillMaxWidth().padding(if(short)8.dp else 12.dp),horizontalAlignment=Alignment.CenterHorizontally,verticalArrangement=Arrangement.spacedBy(8.dp)) {
                Text("CHAPTER ${chapter?.id ?: "—"} · ${region?.name.orEmpty()}",fontSize=13.sp,letterSpacing=2.sp,color=Palette.gold)
                Text(chapter?.name.orEmpty(),fontSize=if(short)24.sp else 29.sp,textAlign=TextAlign.Center)
                Text(chapter?.epithet.orEmpty(),fontSize=16.sp,color=Palette.muted,textAlign=TextAlign.Center)
                if(artwork!=null&&region!=null)CampaignRoute(requireNotNull(artwork),region,image,chapterStages,selected?.stage,perAct,chapter?.landmark.orEmpty(),campaignArtStatus(image!=null,artError,lease!=null,artProgress)){pick(it,true)}
                Row(Modifier.widthIn(max=620.dp).fillMaxWidth().horizontalScroll(rememberScrollState()),horizontalArrangement=Arrangement.spacedBy(5.dp)) { chapterStages.forEach { stage->
                    CampaignTab(onClick={pick(stage.stage,true)},selected=selected?.stage==stage.stage,modifier=Modifier.widthIn(min=44.dp).alpha(if(stage.unlocked||stage.bestStars>0)1f else .55f),contentPadding=PaddingValues(horizontal=6.dp,vertical=3.dp)) { Column(horizontalAlignment=Alignment.CenterHorizontally) {Text(stage.stage.toString(),fontSize=16.sp);Text("★".repeat(stage.bestStars.coerceIn(0,3)).ifEmpty { "·" },fontSize=10.sp,color=Palette.gold)} }
                } }
                Text(chapter?.lore.orEmpty(),Modifier.widthIn(max=620.dp),fontSize=16.sp,lineHeight=21.sp,color=Palette.muted)
                if(perAct==null)Text("Game content update needed for campaign route positions.",fontSize=14.sp)
                if(artError) { Text("Couldn’t load the campaign map. You can still choose a stage.",fontSize=14.sp);SecondaryButton("RETRY MAP",{artAttempt++},verb=Verb.BLUE) }
            }
        }
        val details:@Composable ()->Unit={
            PixelPanel(Modifier.fillMaxWidth().bringIntoViewRequester(detailTarget)) {
                CampaignTab(onClick={detailsOpen=!detailsOpen},modifier=Modifier.fillMaxWidth(),contentPadding=PaddingValues(10.dp)) {
                    Text(selected?.let { "STAGE ${it.stage} · ${artwork?.name(it,perAct) ?: it.name}" } ?: "STAGE DETAILS",Modifier.weight(1f),fontSize=16.sp,color=Palette.gold);Text(if(detailsOpen)"−" else "+",color=Palette.gold)
                }
                if(detailsOpen)Column(Modifier.padding(if(short)10.dp else 14.dp),verticalArrangement=Arrangement.spacedBy(10.dp)) {
                    if(busy)Text("Reading campaign progress…",fontSize=14.sp)
                    (error ?: readError)?.let { Notice(it,true);SecondaryButton("RETRY",{model.refresh()},verb=Verb.BLUE,enabled=!busy) }
                    if(selected==null&&!busy) {Text("Campaign stages will appear once your base has loaded.");SecondaryButton("REFRESH",{model.refresh()},verb=Verb.BLUE) }
                    selected?.let { stage->
                        Text("STAGE ${stage.stage.toString().padStart(3,'0')} · ${if(stage.threat=="standard")stage.profile.orEmpty() else stage.threat?.replace('_',' ').orEmpty()}",fontSize=12.sp,color=Palette.muted)
                        Text(artwork?.name(stage,perAct) ?: stage.name,fontSize=if(short)27.sp else 34.sp,lineHeight=36.sp)
                        Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceBetween) { Text(campaignStageState(stage).uppercase(),color=Palette.gold);Text("★".repeat(stage.bestStars.coerceIn(0,3))+"☆".repeat(3-stage.bestStars.coerceIn(0,3)),color=Palette.goldHi) }
                        Text(stage.tactic.orEmpty(),fontSize=18.sp)
                        val stats=listOf("KEEP LEVEL" to (stage.keepLevel?.toString() ?: "—"),"RECOMMENDED ARMY" to "${stage.recommendedArmyPoints ?: "—"} pts","ARMY CAPACITY" to "${stage.maxArmyPoints ?: "—"} pts","GARRISON" to (stage.defenderHero?.uppercase() ?: "—"))
                        stats.chunked(2).forEach { row ->
                            Row(horizontalArrangement=Arrangement.spacedBy(8.dp)) {
                                row.forEach { (title,value) ->
                                    PixelPlate("tab",Modifier.weight(1f),PaddingValues(9.dp)) { Column {
                                        Text(title,fontSize=11.sp,color=Palette.muted)
                                        Text(value,fontSize=23.sp)
                                    } }
                                }
                            }
                        }
                        PixelPlate("shard",Modifier.fillMaxWidth(),PaddingValues(12.dp)) { Row(verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.spacedBy(8.dp)) {
                            GameArt("shard",Modifier.size(24.dp));Column {Text("${campaignReward(constants,stage)?.let(::fmtN) ?: "—"} SHARDS",fontSize=22.sp,color=Palette.goldHi);Text(if(stage.firstThreeStarClaimed)"CLAIMED" else "FIRST 3★ · ONE TIME",fontSize=12.sp,color=Palette.muted)}
                        } }
                        if(stage.unlocked) {
                            SecondaryButton(if(busy)"READING STRONGHOLD…" else "SCOUT STRONGHOLD",{model.scout(stage.stage)},Modifier.fillMaxWidth(),icon="scout",enabled=!busy)
                            SecondaryButton(if(stage.bestStars>0)"REPLAY STAGE" else "ATTACK",{model.attack(stage.stage)},Modifier.fillMaxWidth(),verb=Verb.RED,icon="attack",enabled=!busy)
                            Text(if(stage.firstThreeStarClaimed)"Stars can still be improved. The first 3★ reward has already been claimed." else "Retries are free. The first 3★ victory awards the reward once.",fontSize=15.sp,color=Palette.muted)
                        } else {Text("Clear stage ${stage.stage-1} to open this road.");SecondaryButton("PREVIOUS STAGE",{pick(stage.stage-1)},Modifier.fillMaxWidth(),enabled=stages.any { it.stage==stage.stage-1 }) }
                    }
                    if(flow)SecondaryButton("BACK TO ROUTE",{detailsOpen=false;scope.launch { bodyScroll.scrollTo(0) }},Modifier.fillMaxWidth())
                }
            }
        }
        Column(Modifier.fillMaxSize()) {
            val compact=PaddingValues(horizontal=8.dp,vertical=4.dp)
            // c-gap-army 2026-10-06: the bars use kit plates and buttons (no old chrome text buttons on the player path).
            Plate(PlateKind.CHARCOAL,Modifier.fillMaxWidth()) {
                Row(Modifier.fillMaxWidth(),verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.spacedBy(6.dp)) {
                    SecondaryButton("BASE",onBack,icon="close")
                    PkwText(if(viewportWidth<420.dp)"CAMPAIGN" else "THE FOUR REALM CAMPAIGN",PkwTokens.Type.label,Modifier.weight(1f),color=PkwTokens.Colors.gold.hi,outline=1.dp)
                    SecondaryButton("WORLD",onWorld,verb=Verb.BLUE,icon="map")
                    SecondaryButton("LOG",onHistory,icon="replay",contentDescription="RAID LOG")
                }
            }
            Row(Modifier.fillMaxWidth().background(Palette.ink).horizontalScroll(rememberScrollState()).padding(horizontal=8.dp,vertical=4.dp),verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.spacedBy(8.dp)) {
                PixelPlate("shard",contentPadding=PaddingValues(horizontal=8.dp,vertical=3.dp)) { Row(verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.spacedBy(6.dp)) {
                    GameArt("star",Modifier.size(14.dp));Text("${stages.count { it.bestStars>0 }}/${stages.size.takeIf { it>0 }?.toString() ?: rules?.string("totalStages") ?: "—"} CLEARED · ${stages.sumOf { it.bestStars }} ★",fontSize=14.sp,color=Palette.goldHi)
                } }
                if(viewportWidth>1000.dp)Text("FREE · YOUR BASE IS NEVER AT RISK",fontSize=15.sp,color=Palette.muted)
                campaignFrontier(stages)?.let { SecondaryButton("NEXT STAGE",{pick(it.stage)}) }
                SecondaryButton("RAID",onChooser,verb=Verb.RED,icon="attack",enabled=chooserEnabled)
            }
            if(flow)Column(Modifier.weight(1f).verticalScroll(bodyScroll)) {chapters(false);expedition();Box(Modifier.padding(horizontal=12.dp,vertical=8.dp)){details()}}
            else if(short)Column(Modifier.weight(1f)){Box(Modifier.height(64.dp)){chapters(false)};Row(Modifier.weight(1f)){Box(Modifier.weight(.64f).verticalScroll(rememberScrollState())){expedition()};Box(Modifier.weight(.36f).widthIn(min=220.dp).verticalScroll(rememberScrollState())){details()}}}
            else Row(Modifier.weight(1f)){chapters(true);Box(Modifier.weight(1f).verticalScroll(rememberScrollState())){expedition()};Box(Modifier.width(if(viewportWidth>1150.dp)310.dp else 280.dp).verticalScroll(rememberScrollState())){details()}}
        }
    }
}

/** Web world.css chapter/stage tabs on the forged tab plate: sunk when selected, dimmed when disabled. */
@Composable private fun CampaignTab(onClick:()->Unit,modifier:Modifier=Modifier,enabled:Boolean=true,selected:Boolean=false,
    contentPadding:PaddingValues=PaddingValues(horizontal=11.dp,vertical=7.dp),content:@Composable RowScope.()->Unit) {
    val interaction=remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    PixelPlate(if(selected||pressed)"tab-sunk" else "tab",modifier.defaultMinSize(minHeight=42.dp).alpha(if(enabled)1f else .5f)
        .semantics { this.selected=selected }.clickable(interactionSource=interaction,indication=null,enabled=enabled,role=Role.Button,onClick=onClick),contentPadding) {
        Row(Modifier.fillMaxWidth(),verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.spacedBy(8.dp,Alignment.CenterHorizontally)) {
            CompositionLocalProvider(LocalContentColor provides if(selected)Palette.goldHi else Palette.text) {
                ProvideTextStyle(TextStyle(fontSize=17.sp)) { content() }
            }
        }
    }
}

/** What the route says while its region crop is not on screen yet (owner 2026-09-17: the Seeker showed the bare ground
 * colour for minutes with no hint that the optional globe generation was still downloading). Null once the art shows. */
internal fun campaignArtStatus(hasImage:Boolean,artError:Boolean,leased:Boolean,progress:WorldContentProgress?):String? = when {
    hasImage||artError -> null
    !leased -> when(progress?.phase) {
        null,WorldContentPhase.CHECKING_CACHE,WorldContentPhase.CHECKING_RELEASE -> "PREPARING MAP ART"
        WorldContentPhase.DOWNLOADING -> "DOWNLOADING MAP ART · ${progress.verifiedFiles}/${progress.totalFiles}"
        WorldContentPhase.VERIFYING -> "VERIFYING MAP ART · ${progress.verifiedFiles}/${progress.totalFiles}"
        WorldContentPhase.READY -> "OPENING MAP ART"
    }
    else -> "DRAWING THE ROAD"
}

@Composable private fun CampaignRoute(art:CampaignArtwork,region:CampaignRegionArt,image:ImageBitmap?,stages:List<CampaignStage>,selectedStage:Int?,perAct:Int?,landmark:String,artStatus:String?,onPick:(Int)->Unit) {
    BoxWithConstraints(Modifier.widthIn(max=620.dp).fillMaxWidth().aspectRatio(640f/520f).background(Color(android.graphics.Color.parseColor(region.ground))).border(3.dp,Palette.borderLt).border(1.dp,Palette.ink)) {
        Canvas(Modifier.fillMaxSize()) {
            image?.let { drawImage(it,dstSize=IntSize(size.width.toInt(),size.height.toInt()),filterQuality=FilterQuality.None) }
            scale(size.width/640f,size.height/520f,pivot=Offset.Zero) {
                stages.zipWithNext().forEach { (previous,stage)->
                    val a=art.point(previous,perAct) ?: return@forEach;val b=art.point(stage,perAct) ?: return@forEach
                    val ax=a.first*640;val ay=a.second*520;val bx=b.first*640;val by=b.second*520
                    val path=Path().apply {moveTo(ax,ay);quadraticBezierTo((ax+bx)/2+(by-ay)*.14f,(ay+by)/2-(bx-ax)*.14f,bx,by)}
                    drawPath(path,Palette.ink.copy(alpha=.75f),style=Stroke(11f,cap=StrokeCap.Round,join=StrokeJoin.Round))
                    drawPath(path,if(stage.bestStars>0)Palette.goldHi else if(stage.unlocked)Palette.text else Palette.textFaint,
                        style=Stroke(if(stage.bestStars>0)5f else 4f,cap=StrokeCap.Round,join=StrokeJoin.Round,pathEffect=if(stage.bestStars>0)null else PathEffect.dashPathEffect(floatArrayOf(3f,8f))))
                }
            }
        }
        // The frontier (first open, uncleared) stage pulses gold; locked roads are dimmed; the selection carries a gold ring.
        val frontier=campaignFrontier(stages)?.stage
        val reduced=LocalReducedMotion.current
        val pulse=if(reduced)null else rememberInfiniteTransition(label="frontier").animateFloat(.35f,1f,infiniteRepeatable(tween(900,easing=FastOutSlowInEasing),RepeatMode.Reverse),label="frontier")
        stages.forEach { stage->art.point(stage,perAct)?.let { point->
            val state=campaignStageState(stage)
            val stars=stage.bestStars.coerceIn(0,3)
            val current=stage.stage==frontier&&state=="available"
            Column(Modifier.offset(maxWidth*point.first-24.dp,maxHeight*point.second-24.dp).width(48.dp).alpha(if(state=="locked")0.85f else 1f)
                .semantics { contentDescription="Stage ${stage.stage}: ${art.name(stage,perAct)}, $state";this.selected=selectedStage==stage.stage }.clickable {onPick(stage.stage)},horizontalAlignment=Alignment.CenterHorizontally) {
                Box(Modifier.size(48.dp).border(3.dp,if(selectedStage==stage.stage)Palette.goldHi else if(current)Palette.gold.copy(alpha=pulse?.value ?: 1f) else Color.Transparent).padding(3.dp)) {
                    PixelPlate(if(state=="cleared")"gold" else if(state=="locked")"tab" else "shard",Modifier.fillMaxSize()) { Column(Modifier.fillMaxSize(),verticalArrangement=Arrangement.Center,horizontalAlignment=Alignment.CenterHorizontally) {
                        Text(stage.stage.toString(),fontSize=18.sp,lineHeight=18.sp,color=if(state=="cleared")Palette.ink else if(state=="locked")Palette.muted else Palette.text)
                        if(stars>0)Text("★".repeat(stars),fontSize=9.sp,lineHeight=9.sp,color=Palette.goldDp)
                    } }
                }
                if(stage.threat!=null&&stage.threat!="standard")PixelPlate("shard",contentPadding=PaddingValues(horizontal=4.dp,vertical=1.dp)){Text(if(stage.threat=="boss")"BOSS" else "ELITE",fontSize=10.sp,lineHeight=11.sp,color=if(stage.threat=="boss")Palette.danger else Palette.goldHi)}
            }
        } }
        artStatus?.let { status->
            PixelPlate("shard",Modifier.align(Alignment.TopCenter).padding(top=8.dp).semantics { contentDescription="Campaign map art: $status" },PaddingValues(horizontal=10.dp,vertical=4.dp)) {
                Row(horizontalArrangement=Arrangement.spacedBy(8.dp),verticalAlignment=Alignment.CenterVertically) {
                    CircularProgressIndicator(Modifier.size(14.dp),strokeWidth=2.dp)
                    Text(status,fontSize=12.sp,lineHeight=14.sp,letterSpacing=1.sp,color=Palette.goldHi)
                }
            }
        }
        Text(landmark,Modifier.align(Alignment.BottomCenter).padding(8.dp).fillMaxWidth().background(Palette.ink.copy(alpha=.72f)),fontSize=13.sp,letterSpacing=2.sp,color=Palette.text,textAlign=TextAlign.Center)
    }
}
