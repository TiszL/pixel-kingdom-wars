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
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.model.MyClan
import gg.pixelkingdomwars.nativeclient.model.marketSol
import gg.pixelkingdomwars.nativeclient.ui.Palette
import gg.pixelkingdomwars.nativeclient.ui.chrome.*
import gg.pixelkingdomwars.nativeclient.ui.economy.*
import gg.pixelkingdomwars.nativeclient.ui.nav.*
import gg.pixelkingdomwars.nativeclient.ui.security.SensitiveMfaDialog
import kotlinx.serialization.json.*

fun retirementEntryAvailable(state:RetirementState?,unavailable:Boolean)=unavailable||state?.error!=null||state?.journal?.records?.isNotEmpty()==true

data class RetirementControls(val pay:Boolean,val prepare:Boolean,val review:Boolean,val approve:Boolean,val upload:Boolean,val deliver:Boolean,val recover:Boolean,val cancel:Boolean,val retry:Boolean)
fun retirementControls(s:RetirementState,allowed:Boolean,running:Boolean=false):RetirementControls {
 val r=s.record;val idle=!s.busy&&!running;val active=idle&&r!=null&&!r.held&&!r.terminal;val fresh=active&&allowed;val op=r?.operation;val attempts=r?.attempts.orEmpty()
 return RetirementControls(fresh&&r?.response!=null&&op==null,
  fresh&&op?.charterText("status")=="cleared"&&op.charterOptional("attempt")==null,
  fresh&&op?.charterText("status")=="prepared"&&r?.signed==null&&"wallet" !in attempts,
  fresh&&s.reviewed&&op?.charterText("status")=="prepared"&&"wallet" !in attempts,
  active&&r?.signed!=null&&op?.charterOptional("signed")==null,
  fresh&&op?.charterOptional("signed")!=null,
  active&&r?.response!=null,active&&r?.response!=null,fresh&&r?.response==null)
}
fun retirementStatus(r:RetirementRecord)=when {
 r.held->"OUTCOME NEEDS VERIFICATION"
 r.response==null->"REQUEST SAVED · OUTCOME UNKNOWN"
 CharterGrammar.bool(r.response.getValue("cancelled"))->"DRAFT CANCELLED · CLAN RETAINED"
 r.operation?.charterText("status")=="completed"->"CLAN DISSOLVED"
 r.operation?.charterText("status")=="cancelled"->"DISSOLUTION CANCELLED · CLAN RETAINED"
 r.signed!=null||r.operation?.charterOptional("signed")!=null->"APPROVAL SAVED · CHECK DELIVERY"
 "wallet" in r.attempts->"WALLET OUTCOME UNKNOWN"
 r.operation?.charterText("status")=="prepared"->"READY FOR FINAL REVIEW"
 r.response.charterOptional("memberPayment")!=null->"MEMBER REWARDS PAID"
 else->"MEMBERS FROZEN · REVIEW PAYOUT"
}
@Composable fun RetirementScreen(model:RetirementViewModel,allowed:Boolean,actor:String,clan:MyClan?,onBack:()->Unit){
 val state by model.state.collectAsState();val running by model.busy.collectAsState();val notice by model.notice.collectAsState();val r=state.record;val controls=retirementControls(state,allowed,running)
 var freezeConsent by rememberSaveable(clan?.id){mutableStateOf(false)};var payoutConsent by rememberSaveable(r?.key){mutableStateOf(false)};var finalConsent by rememberSaveable(r?.key){mutableStateOf(false)}
 var history by rememberSaveable{mutableStateOf(false)};val wallet=model.wallet;val mfa=wallet?.mfa?.collectAsState()?.value
 val back={model.dismiss();onBack()};BackHandlerAt(BackPriority.SCREEN){back()};BackHandlerAt(BackPriority.CONFIRM,mfa!=null){mfa?.let{wallet?.cancelMfa(it)}}
 LaunchedEffect(allowed){model.dismiss();payoutConsent=false;finalConsent=false};DisposableEffect(model){onDispose{model.dismiss()}}
 DesignedPage("DISSOLVE CLAN",back){
  TitledPlate("A PERMANENT END",gold=true){Text("Pay the members’ accrued rewards, then retire this clan’s Charter. The clan and membership are removed only after the signed retirement is confirmed.",color=SurfaceInk.text)
   Text("The frozen Charter stays with its final leader as a keepsake. It cannot lead another clan.",color=SurfaceInk.muted,style=MaterialTheme.typography.bodySmall)
   if(!allowed)Text("New dissolution actions are paused. Saved originals and recovery remain available.",color=SurfaceInk.goldHi)
  }
  if(running||state.busy)LinearProgressIndicator(Modifier.fillMaxWidth())
  Column(Modifier.semantics{liveRegion=LiveRegionMode.Polite}){notice?.let{Text(it.message,color=if(it.error)SurfaceInk.danger else SurfaceInk.text)};state.error?.let{Text(it,color=SurfaceInk.danger)}}
  if(r!=null)TitledPlate(retirementStatus(r),gold=true){
   val draft=r.response;val op=r.operation
   if(draft!=null){Text("${draft.charterObject("clan").charterText("name")} [${draft.charterObject("clan").charterText("tag")}]",style=MaterialTheme.typography.headlineSmall,color=SurfaceInk.goldHi)
    Text("${draft.charterText("totalShards")} SHARDS · total accrued member rewards",style=MaterialTheme.typography.titleMedium)
    draft.getValue("shares").jsonArray.forEach{row->val share=row.jsonObject;val address=share.charterText("wallet");Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceBetween){Text(if(address==actor)"You" else address.take(6)+"…"+address.takeLast(6),Modifier.weight(1f));Text("${share.charterText("shards")} SHARDS")}}
    if(draft.charterOptional("memberPayment")!=null)Text("Member payout is recorded. Cancelling dissolution does not undo this payment.",color=SurfaceInk.muted)
   }
   if("wallet" in r.attempts&&r.signed==null&&op?.charterOptional("signed")==null)Text("The wallet may already have approved. A second approval is blocked; check the saved outcome.",color=SurfaceInk.goldHi)
   OutlinedButton(onClick={model.check()},enabled=!running&&!state.busy,modifier=Modifier.fillMaxWidth()){Text("CHECK SAVED OUTCOME")}
   if(controls.retry)OutlinedButton(onClick={model.retry()},modifier=Modifier.fillMaxWidth()){Text("RETRY SAME SAVED REQUEST")}
   if(controls.pay){val paid=draft?.charterOptional("memberPayment")!=null;ConsentRow(payoutConsent,{payoutConsent=it},if(paid)"Resume this recorded payout and finish preparing the clan’s retirement." else "Pay these exact accrued rewards to the captured members.");Button(onClick={model.command("pay-members")},enabled=payoutConsent,modifier=Modifier.fillMaxWidth()){Text(if(paid)"RESUME PAID DISSOLUTION" else "PAY MEMBER REWARDS")}}
   if(controls.prepare)Button(onClick={model.command("prepare")},modifier=Modifier.fillMaxWidth()){Text("PREPARE FINAL RETIREMENT")}
   op?.charterOptional("attempt")?.charterObject("quote")?.charterObject("costs")?.let{costs->Text("${marketSol(costs.charterText("totalLamports"))} SOL · network fee and account rent",style=MaterialTheme.typography.titleMedium,color=SurfaceInk.goldHi);Text("Network fee ${marketSol(costs.charterText("networkFeeLamports"))} SOL · rent ${marketSol(costs.charterText("rentLamports"))} SOL",style=MaterialTheme.typography.bodySmall)}
   if(controls.review)OutlinedButton(onClick={model.review()},modifier=Modifier.fillMaxWidth()){Text("REVIEW EXACT RETIREMENT")}
   if(controls.approve){ConsentRow(finalConsent,{finalConsent=it},"Permanently dissolve this clan and retire its Charter.");Button(onClick={model.approve()},enabled=finalConsent,modifier=Modifier.fillMaxWidth()){Text("APPROVE PERMANENT DISSOLUTION")}}
   if(controls.upload)Button(onClick={model.upload()},modifier=Modifier.fillMaxWidth()){Text("SAVE APPROVAL TO SERVER")}
   if(controls.deliver)Button(onClick={model.deliver()},modifier=Modifier.fillMaxWidth()){Text("DELIVER SAVED APPROVAL")}
   if(controls.recover)OutlinedButton(onClick={model.command(if(op?.charterText("status")=="issuing")"recover-preparation" else "recover")},modifier=Modifier.fillMaxWidth()){Text("RECOVER ORIGINAL RESULT")}
   if(controls.cancel)OutlinedButton(onClick={model.command("cancel")},modifier=Modifier.fillMaxWidth()){Text("CANCEL IF SAFE")}
   Text("Closing keeps the request and its approval. An uncertain network reply never creates a replacement.",color=SurfaceInk.muted,style=MaterialTheme.typography.bodySmall)
  }
  val unfinished=state.journal?.records?.any{it.clanId==clan?.id&&(!it.terminal||it.held)}==true
  if(clan!=null&&clan.leaderWallet==actor&&!unfinished)TitledPlate("START DISSOLUTION"){
   Text(clan.name,style=MaterialTheme.typography.titleLarge);Text("First, freeze membership and raid admission so the server can capture the final member payout. This step does not dissolve the clan.",color=SurfaceInk.muted)
   ConsentRow(freezeConsent,{freezeConsent=it},"Freeze this clan while I review its final payout.")
   Button(onClick={model.begin(clan.id)},enabled=allowed&&state.loaded&&!running&&!state.busy&&freezeConsent,modifier=Modifier.fillMaxWidth()){Text("FREEZE & REVIEW MEMBERS")}
  }
  DisclosurePlate("SAVED DISSOLUTIONS (${state.journal?.records?.size?:0})",history,{history=!history}){state.journal?.records?.forEach{saved->OutlinedButton(onClick={model.select(saved.key)},enabled=!running&&!state.busy,modifier=Modifier.fillMaxWidth()){Column{Text(saved.response?.charterObject("clan")?.charterText("name")?:"Saved clan request");Text(retirementStatus(saved),style=MaterialTheme.typography.bodySmall)}}};if(state.journal?.records?.isEmpty()==true)EmptyPlate("No dissolution requests saved on this device.")}
 }
 if(mfa!=null)SensitiveMfaDialog(mfa,submit={wallet.submitMfa(mfa,it)},cancelRequest={wallet.cancelMfa(mfa)})
}
@Composable private fun ConsentRow(value:Boolean,change:(Boolean)->Unit,label:String){Row(verticalAlignment=Alignment.CenterVertically){Checkbox(value,change);Text(label,Modifier.weight(1f))}}
