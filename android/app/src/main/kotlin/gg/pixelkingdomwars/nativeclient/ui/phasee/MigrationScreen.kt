package gg.pixelkingdomwars.nativeclient.ui.phasee

import androidx.compose.foundation.layout.*
import androidx.compose.material3.Checkbox
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.*
import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.model.marketSol
import gg.pixelkingdomwars.nativeclient.ui.Palette
import gg.pixelkingdomwars.nativeclient.ui.chrome.*
import gg.pixelkingdomwars.nativeclient.ui.economy.*
import gg.pixelkingdomwars.nativeclient.ui.nav.*
import gg.pixelkingdomwars.nativeclient.ui.security.SensitiveMfaDialog
import kotlinx.serialization.json.*

fun migrationEntryAvailable(state:MigrationState?,configured:Boolean,unavailable:Boolean)=configured||unavailable||state?.error!=null||state?.journal?.records?.isNotEmpty()==true||state?.activity?.get("items")?.jsonArray?.isNotEmpty()==true

data class MigrationControls(val prepare:Boolean,val review:Boolean,val approve:Boolean,val upload:Boolean,val deliver:Boolean,val recover:Boolean,val cancel:Boolean,val retry:Boolean)
fun migrationControls(s:MigrationState,allowed:Boolean,running:Boolean=false):MigrationControls {
 val r=s.record;val idle=!s.busy&&!running;val active=idle&&r!=null&&!r.held&&!r.terminal;val fresh=active&&allowed;val status=r?.response?.charterText("status");val attempts=r?.attempts.orEmpty()
 return MigrationControls(fresh&&status=="pending",fresh&&status=="prepared"&&r?.signed==null&&"wallet" !in attempts,
  fresh&&s.reviewed&&status=="prepared"&&"wallet" !in attempts,active&&r?.signed!=null&&r.response?.charterOptional("wire")==null,
  fresh&&r?.response?.charterOptional("wire")!=null,idle&&r?.remoteId!=null&&!r.terminal,active&&r?.response!=null,fresh&&r?.response==null)
}
fun migrationStatus(r:MigrationRecord)=when {
 r.held->"OUTCOME NEEDS VERIFICATION"
 r.response==null->"REQUEST SAVED · OUTCOME UNKNOWN"
 r.response.charterText("status")=="controlled"->"CHARTER REGISTERED"
 r.response.charterText("status")=="cancelled"->"MIGRATION CANCELLED · CLAN RETAINED"
 r.signed!=null||r.response.charterOptional("wire")!=null->"APPROVAL SAVED · CHECK DELIVERY"
 "wallet" in r.attempts->"WALLET OUTCOME UNKNOWN"
 r.response.charterText("status")=="prepared"->"READY FOR COST REVIEW"
 r.response.charterText("status")=="issuing"->"ORIGINAL PREPARATION SAVED"
 else->"CLAN SNAPSHOT SAVED"
}
@Composable fun MigrationScreen(model:MigrationViewModel,allowed:Boolean,onBack:()->Unit){
 val state by model.state.collectAsState();val running by model.busy.collectAsState();val notice by model.notice.collectAsState();val r=state.record;val controls=migrationControls(state,allowed,running)
 var startConsent by rememberSaveable(state.activity?.charterOptional("currentClan")?.get("id")){mutableStateOf(false)};var signConsent by rememberSaveable(r?.key){mutableStateOf(false)};var history by rememberSaveable{mutableStateOf(false)}
 val wallet=model.wallet;val mfa=wallet?.mfa?.collectAsState()?.value;val back={model.dismiss();onBack()};BackHandlerAt(BackPriority.SCREEN){back()};BackHandlerAt(BackPriority.CONFIRM,mfa!=null){mfa?.let{wallet?.cancelMfa(it)}}
 LaunchedEffect(allowed){model.dismiss();startConsent=false;signConsent=false};DisposableEffect(model){onDispose{model.dismiss()}}
 DesignedPage("REGISTER CLAN CHARTER",back){
  TitledPlate("KEEP YOUR CLAN",gold=true){Text("Give your existing clan a Charter under its current leader. Its name, members, balances and accrued rewards stay with the same clan.",color=SurfaceInk.text)
   Text("No second creation SHARDS payment. SOL network fees, account rent and the Charter creation fee are reviewed separately.",color=SurfaceInk.goldHi)
   if(!allowed)Text("New approvals are paused. Saved requests and original recovery remain available.",color=SurfaceInk.muted)
  }
  if(running||state.busy)LinearProgressIndicator(Modifier.fillMaxWidth())
  Column(Modifier.semantics{liveRegion=LiveRegionMode.Polite}){notice?.let{Text(it.message,color=if(it.error)SurfaceInk.danger else SurfaceInk.text)};state.error?.let{Text(it,color=SurfaceInk.danger)}}
  if(r!=null)TitledPlate(migrationStatus(r),gold=true){
   val m=r.response
   m?.charterObject("snapshot")?.let{s->val c=s.charterObject("clan");Text("${c.charterText("name")} [${c.charterText("tag")}]",style=MaterialTheme.typography.headlineSmall,color=SurfaceInk.goldHi)
    Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceBetween){Text("${CharterGrammar.number(s.getValue("memberCount"))} members");Text("${s.charterText("chestShards")} SHARDS · clan chest")}
    Text("Snapshot captured ${s.charterText("capturedAt")}. Existing rewards are preserved; migration does not pay or redistribute them.",style=MaterialTheme.typography.bodySmall,color=SurfaceInk.muted)
   }
   if("wallet" in r.attempts&&r.signed==null&&m?.charterOptional("wire")==null)Text("Wallet approval may already have completed. Check this saved original; another approval is blocked.",color=SurfaceInk.goldHi)
   OutlinedButton(onClick={model.check()},enabled=!running&&!state.busy,modifier=Modifier.fillMaxWidth()){Text("CHECK SAVED OUTCOME")}
   if(controls.retry)OutlinedButton(onClick={model.retry()},modifier=Modifier.fillMaxWidth()){Text("RETRY SAME SAVED REQUEST")}
   if(controls.prepare)Button(onClick={model.command("prepare")},modifier=Modifier.fillMaxWidth()){Text("PREPARE CHARTER & COSTS")}
   m?.charterOptional("signing")?.charterObject("costs")?.let{costs->
    Text("${marketSol(costs.charterText("totalLamports"))} SOL · quoted total",style=MaterialTheme.typography.titleLarge,color=SurfaceInk.goldHi)
    charterCostRows(costs).forEach{Text("${it.label}: ${it.value}",style=MaterialTheme.typography.bodySmall)}
    Text("A quote is not a payment receipt.",color=SurfaceInk.muted,style=MaterialTheme.typography.bodySmall)
   }
   if(controls.review)OutlinedButton(onClick={signConsent=false;model.review()},modifier=Modifier.fillMaxWidth()){Text("REVIEW EXACT REGISTRATION")}
   if(controls.approve){MigrationConsent(signConsent,{signConsent=it},"Register this clan’s Charter and approve the quoted SOL transaction.");Button(onClick={model.approve()},enabled=signConsent,modifier=Modifier.fillMaxWidth()){Text("APPROVE IN WALLET")}}
   if(controls.upload)Button(onClick={model.upload()},modifier=Modifier.fillMaxWidth()){Text("SAVE APPROVAL TO SERVER")}
   if(controls.deliver)Button(onClick={model.deliver()},modifier=Modifier.fillMaxWidth()){Text("DELIVER SAVED APPROVAL")}
   if(controls.recover)OutlinedButton(onClick={model.command(if(m?.charterText("status")=="issuing"&&!r.held)"recover-preparation" else "recover")},modifier=Modifier.fillMaxWidth()){Text("RECOVER ORIGINAL RESULT")}
   if(controls.cancel)OutlinedButton(onClick={model.command("cancel")},modifier=Modifier.fillMaxWidth()){Text("CANCEL IF SAFE")}
   Text("The clan stays frozen until registration is confirmed or cancellation is proven safe. Closing keeps the original request and approval.",color=SurfaceInk.muted,style=MaterialTheme.typography.bodySmall)
  }
  TitledPlate("YOUR CLAN & HISTORY"){
   OutlinedButton(onClick={model.refresh()},enabled=!running&&!state.busy,modifier=Modifier.fillMaxWidth()){Text("CHECK CLAN & MIGRATION HISTORY")}
   val a=state.activity;val clan=a?.charterOptional("currentClan");val unfinished=state.journal?.records?.any{it.clanId==clan?.charterText("id")&&(!it.terminal||it.held)}==true
   if(clan!=null){Text("${clan.charterText("name")} [${clan.charterText("tag")}]",style=MaterialTheme.typography.titleLarge)
    when(clan.charterText("authority")){
     "legacy"->{Text("Freeze membership and new raids while the server captures this clan’s current roster and obligations.",color=SurfaceInk.muted)
      if(CharterGrammar.bool(a.getValue("newActions"))&&!unfinished){MigrationConsent(startConsent,{startConsent=it},"Keep this clan frozen while I review its Charter registration.");Button(onClick={model.begin(clan.charterText("id"))},enabled=allowed&&state.loaded&&!running&&!state.busy&&startConsent,modifier=Modifier.fillMaxWidth()){Text("FREEZE & REVIEW THIS CLAN")}}
     }
     "pending"->OutlinedButton(onClick={model.selectRemote(clan.charterText("migrationId"))},enabled=!running&&!state.busy,modifier=Modifier.fillMaxWidth()){Text("OPEN EXISTING MIGRATION")}
     "controlled"->Text("This clan already has Charter authority.",color=SurfaceInk.muted)
    }
   }else if(a!=null)Text("No existing clan is available to migrate for this leader.",color=SurfaceInk.muted)
   a?.get("items")?.jsonArray?.forEach{raw->val item=raw.jsonObject;OutlinedButton(onClick={model.selectRemote(item.charterText("id"))},enabled=!running&&!state.busy,modifier=Modifier.fillMaxWidth()){Column{Text(item.charterText("name"));Text(item.charterText("status").uppercase(),style=MaterialTheme.typography.bodySmall)}}}
  }
  DisclosurePlate("SAVED MIGRATIONS (${state.journal?.records?.size?:0})",history,{history=!history}){state.journal?.records?.forEach{saved->OutlinedButton(onClick={signConsent=false;model.select(saved.key)},enabled=!running&&!state.busy,modifier=Modifier.fillMaxWidth()){Column{Text(saved.response?.charterObject("snapshot")?.charterObject("clan")?.charterText("name")?:"Saved clan request");Text(migrationStatus(saved),style=MaterialTheme.typography.bodySmall)}}};if(state.journal?.records?.isEmpty()==true)EmptyPlate("No migrations saved on this device.")}
 }
 if(mfa!=null)SensitiveMfaDialog(mfa,submit={wallet.submitMfa(mfa,it)},cancelRequest={wallet.cancelMfa(mfa)})
}
@Composable private fun MigrationConsent(value:Boolean,change:(Boolean)->Unit,label:String){Row(verticalAlignment=Alignment.CenterVertically){Checkbox(value,change);Text(label,Modifier.weight(1f))}}
