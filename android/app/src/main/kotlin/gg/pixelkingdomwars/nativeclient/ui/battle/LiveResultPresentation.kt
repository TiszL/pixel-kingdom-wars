package gg.pixelkingdomwars.nativeclient.ui.battle

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import gg.pixelkingdomwars.nativeclient.BattleResultSummary
import gg.pixelkingdomwars.nativeclient.data.ContentState
import gg.pixelkingdomwars.nativeclient.network.BattleCoordinator
import gg.pixelkingdomwars.nativeclient.ui.*
import kotlinx.coroutines.*
import kotlinx.serialization.json.*

internal class LiveResultUi(val policy:ResultPresentation?,val art:ResultArt?,val error:String?,val won:Boolean,
                             val owner:ResultCueOwner,val dismiss:()->Unit)

/** Mounted only by LiveBattleScreen. Replay, spectator and history cards have no celebration owner. */
@Composable internal fun rememberLiveResult(model:BattleViewModel,coordinator:BattleCoordinator,content:ContentState,result:JsonObject?,raid:String?):LiveResultUi {
    val sensory=LocalNativeSensory.current;val device=LocalDeviceExperience.current;val audio=LocalNativeAudio.current
    val lifecycle=LocalLifecycleOwner.current.lifecycle
    val parsed=remember(content.renderCatalogue) { runCatching { ResultPresentation.read(content.renderCatalogue?.get("resultPresentation") as? JsonObject) } }
    val policy=parsed.getOrNull()
    val assets=content.assets
    val deviceOwner=remember(coordinator) { Any() }
    val owner=remember(coordinator,sensory,assets) {
        ResultCueOwner(model.feedbackIdentity,content.catalogue,{
            val now=assets?.let { sensory?.context(it) } ?: SensoryContext(null,null,false,false,0)
            now.copy(identity=now.identity.takeIf { model.battle.state.value.coordinator===coordinator },
                foreground=now.foreground&&lifecycle.currentState==Lifecycle.State.RESUMED)
        },{device?.cancelHaptics(deviceOwner)})
    }
    val sound=remember(owner,audio,policy) {
        policy?.let { audio?.ui?.scope(coordinator.baseId,model.feedbackIdentity,it.sounds) {
            coordinator.baseId.takeIf { owner.isCurrent()&&model.battle.state.value.coordinator===coordinator }
        } }
    }
    var art by remember(owner,policy) { mutableStateOf<ResultArt?>(null) }
    var error by remember(owner,policy) { mutableStateOf<String?>(if(parsed.isFailure)"Some result visuals couldn’t load." else null) }
    val dismiss=remember(owner,sound) { {owner.close();sound?.close();Unit} }
    DisposableEffect(owner,sound,lifecycle) {
        fun refresh(){owner.environmentChanged();sound?.active(owner.isCurrent())}
        val observer=LifecycleEventObserver { _,_->refresh() }
        lifecycle.addObserver(observer);refresh()
        val observation=sensory?.observe { refresh() }
        onDispose {lifecycle.removeObserver(observer);observation?.cancel();dismiss()}
    }
    LaunchedEffect(owner,coordinator) {
        observeResultKeys(coordinator.state,owner)
    }
    // Only current visible reads may publish these seven images. No decoder callback owns a cue.
    LaunchedEffect(owner,policy,lifecycle) {
        if(policy==null)return@LaunchedEffect
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            if(art==null&&owner.isCurrent())try {
                val loaded=withContext(Dispatchers.IO){loadResultArt(content,policy)}
                ensureActive();if(owner.isCurrent()){art=loaded;error=null}
            } catch(error:CancellationException){throw error}
            catch(_:Exception){if(owner.isCurrent())error="Some result visuals couldn’t load."}
        }
    }
    val summary=result?.let { BattleResultSummary.read(it) }
    val key=resultCueKey(raid,result)
    LaunchedEffect(owner,key) {
        if(key!=null&&owner.shown(key)&&policy!=null) {
            val feedback=policy.feedback(key.won,key.stars)
            sound?.shown(feedback.sounds)
            feedback.haptics.forEach { if(owner.isCurrent())device?.patternHaptic(deviceOwner,it) }
        }
    }
    return LiveResultUi(policy,art,error,summary?.won==true,owner,dismiss)
}

@Composable internal fun ResultStarRow(result:LiveResultUi,filled:Int) {
    val policy=result.policy?.stars ?: return
    val image=result.art?.star ?: return
    Row(Modifier.fillMaxWidth().padding(top=policy.top.dp,bottom=policy.bottom.dp)
        .semantics { contentDescription="$filled of ${policy.opacity.size} stars" },
        horizontalArrangement=Arrangement.spacedBy(policy.gap.dp,androidx.compose.ui.Alignment.CenterHorizontally)) {
        policy.opacity.indices.forEach { i->
            Image(image,null,Modifier.size(policy.size.dp).offset(y=policy.offsetY[i].dp),
                alpha=if(i<filled)policy.filledOpacity[i] else policy.opacity[i],filterQuality=FilterQuality.None)
        }
    }
}

/** The old result's corner FX. Not composed under the designed result card (BattleResultCardV2 draws its own rays and
 * sparkles); the cue owner above still plays the result sounds and haptics for it. */
@Composable internal fun ResultDecorations(result:LiveResultUi) {
    val policy=result.policy ?: return;val art=result.art ?: return
    if(!result.won)return
    BoxWithConstraints(Modifier.fillMaxSize().clearAndSetSemantics {}) {
        policy.effects.forEach { fx->
            val reduced=LocalReducedMotion.current;val lifecycle=LocalLifecycleOwner.current.lifecycle
            var frame by remember(result.owner,fx) { mutableLongStateOf(0L) }
            LaunchedEffect(result.owner,fx,reduced,lifecycle) {
                if(reduced)return@LaunchedEffect
                lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
                    while(result.owner.isCurrent()){delay(fx.frameMs);if(result.owner.isCurrent())frame+=fx.frameMs}
                }
            }
            val index=fx.frame(frame,reduced)
            val image=art.effects[fx.frames[index].path] ?: return@forEach
            val x=if(fx.right)maxWidth*(1f-fx.horizontal)-fx.size.dp else maxWidth*fx.horizontal
            val y=if(fx.bottom)maxHeight*(1f-fx.vertical)-fx.size.dp else maxHeight*fx.vertical
            Image(image,null,Modifier.offset(x,y).size(fx.size.dp),filterQuality=FilterQuality.None)
        }
    }
}
