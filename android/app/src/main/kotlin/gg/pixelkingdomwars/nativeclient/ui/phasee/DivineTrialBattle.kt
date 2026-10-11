package gg.pixelkingdomwars.nativeclient.ui.phasee

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.data.ContentState
import gg.pixelkingdomwars.nativeclient.divine.*
import gg.pixelkingdomwars.nativeclient.renderer.*
import gg.pixelkingdomwars.nativeclient.scene.SceneInputScope
import gg.pixelkingdomwars.nativeclient.scene.SceneSurface
import gg.pixelkingdomwars.nativeclient.ui.chrome.OutlinedButton
import gg.pixelkingdomwars.nativeclient.ui.chrome.Surface
import gg.pixelkingdomwars.nativeclient.ui.chrome.blockSceneInput
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.*
import kotlin.math.floor

/** Existing GL surface, isolated dedicated-trial controller and render-only callbacks. */
@Composable fun DivineTrialBattle(attempt:JsonObject,rules:DivineRules,content:ContentState,allowed:Boolean,onSubmit:(JsonObject)->Unit,onBack:()->Unit,error:String?) {
 val id=attempt.dt("id");val completed=attempt.dt("status")=="completed"
 val currentStatus by rememberUpdatedState(attempt.dt("status"))
 val plan=remember(id,attempt["encounter"],attempt.dt("status")){divineTrialPlanning(attempt,rules)}
 BackHandlerAt(BackPriority.BATTLE,onBack=onBack)
 if(plan==null&&!completed){
  Surface(Modifier.fillMaxSize().blockSceneInput()){Column(Modifier.padding(16.dp)){
   Text("DIVINE TRIAL · ATTEMPT ${attempt.dn("ordinal")} · ${attempt.dt("status")}")
   Text(if(attempt.dt("status")=="committed")"The original batch is committed. Return to the trial to recover its authoritative result." else "This attempt is closed without a score. Its original remains saved.")
   error?.let{Text(it)}
   OutlinedButton(onClick=onBack){Text("Back to trial · recover original")}
  }}
  return
 }
 var selection by remember(id){mutableStateOf(rules.policy.dobj("army").keys.first())};var revision by remember(id){mutableIntStateOf(0)}
 var mapped by remember(id,content.assets){mutableStateOf<BattleScene?>(null)};var failed by remember(id){mutableStateOf<String?>(null)};var ready by remember(id,content.assets){mutableStateOf(false)}
 var replayKey by remember(id){mutableIntStateOf(0)};var top by remember{mutableIntStateOf(0)};var bottom by remember{mutableIntStateOf(0)}
 val owner=remember(id,content.assets){Any()};var active by remember(owner){mutableStateOf(true)};val currentAllowed by rememberUpdatedState(allowed)
 val admission=remember(owner,selection,allowed,ready,attempt.dt("status"),revision){Any()}
 val currentAdmission by rememberUpdatedState(admission)
 DisposableEffect(owner){onDispose{active=false}}
 LaunchedEffect(id,attempt["result"],content.assets,content.catalogue,content.renderCatalogue){ready=false;mapped=null;failed=null;try{mapped=withContext(Dispatchers.Default){divineTrialScene(attempt,rules,requireNotNull(content.catalogue),requireNotNull(content.renderCatalogue))}}catch(e:Exception){failed=e.message?:"Battlefield could not be prepared"}}
 val guard={check(active&&currentAllowed&&ready&&plan!=null&&currentStatus=="admitted"){"The trial planning view is no longer active."}}
 val mode=if(allowed&&ready&&plan!=null&&plan.remaining(selection)>0)BattleDeploymentMode("$id:$selection:$revision",content.catalogue!!.dobj("constants").dobj("RAID_CAMERA").dn("holdConfirmMs"),content.catalogue!!.dobj("constants").dobj("RAID_RULES").dn("deployHoldRepeatMs"),content.catalogue!!.dobj("constants").dobj("RAID_CAMERA").getValue("panThresholdPx").jsonPrimitive.float,true,admission,BattleDeploymentTarget(id,"deploy",selection))else null
 SceneInputScope {Box(Modifier.fillMaxSize()){
  val scene=mapped;val assets=content.assets
  if(scene!=null&&assets!=null){val playing=scene.copy(playing=completed&&ready,playheadTick=0f)
   SceneSurface(assets,playing.base,Modifier.fillMaxSize(),battle=playing,playbackKey=replayKey+if(ready)1 else 0,
    cameraInsets=CameraInsets(top=top,bottom=bottom),onPresentationReady={ready=it},deploymentMode=mode,deploymentAdmission=admission.takeIf{mode!=null},
    highlights=plan?.placements.orEmpty().map{SceneHighlight(it.dn("tx").toFloat(),it.dn("ty").toFloat(),1f,1f,0xffc792,0.6f)},
    onBattleGround={target,x,y->if(target.raidId==id&&target.kind=="deploy"&&currentAdmission===admission&&x.isFinite()&&y.isFinite())runCatching{plan?.place(target.unit,floor(x).toLong(),floor(y).toLong(),guard);revision++}.onFailure{failed=it.message}})
  }
  Surface(Modifier.align(Alignment.TopCenter).fillMaxWidth().onSizeChanged{top=it.height}.blockSceneInput()) {Column(Modifier.padding(12.dp)){
   Text("DIVINE TRIAL · ATTEMPT ${attempt.dn("ordinal")}");Text(if(completed)"Authoritative result replay" else "Place every fixed troop, then submit this one batch.")
   OutlinedButton(onClick=onBack){Text("Back to trial · keep original")}
   (failed?:error)?.let{Text(it)}
  }}
  Surface(Modifier.align(Alignment.BottomCenter).fillMaxWidth().onSizeChanged{bottom=it.height}.blockSceneInput()){Column(Modifier.heightIn(max=240.dp).verticalScroll(rememberScrollState()).padding(12.dp)){
   if(!ready)Text("Preparing the admitted battlefield…")
   if(plan!=null){for(troop in rules.policy.dobj("army").keys)OutlinedButton(enabled=allowed&&ready&&plan.remaining(troop)>0,onClick={selection=troop}){Text("${if(selection==troop)"✓ " else ""}$troop · ${plan.remaining(troop)} left")}
    Text("${plan.placements.size} / ${rules.bound("maxDeploys")} placed")
    OutlinedButton(enabled=allowed&&ready&&plan.placements.isNotEmpty(),onClick={runCatching{plan.undo(guard);revision++}.onFailure{failed=it.message}}){Text("Undo last placement")}
    OutlinedButton(enabled=allowed&&ready&&plan.complete,onClick={runCatching{guard();onSubmit(plan.orders())}.onFailure{failed=it.message}}){Text("Submit fixed plan once")}
   }else {attempt.doptional("result")?.let{Text("${it.dn("stars")} stars · ${it.dn("destruction")}% destroyed")};OutlinedButton(enabled=ready,onClick={replayKey+=2}){Text("Watch again")}}
  }}
 }}
}
