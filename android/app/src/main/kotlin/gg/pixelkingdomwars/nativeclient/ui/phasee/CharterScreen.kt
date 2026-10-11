package gg.pixelkingdomwars.nativeclient.ui.phasee

import gg.pixelkingdomwars.nativeclient.ui.chrome.SurfaceInk
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.semantics.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.model.MyClan
import gg.pixelkingdomwars.nativeclient.model.marketSol
import gg.pixelkingdomwars.nativeclient.ui.land.solToLamports
import gg.pixelkingdomwars.nativeclient.ui.Palette
import gg.pixelkingdomwars.nativeclient.ui.chrome.DesignedPage
import gg.pixelkingdomwars.nativeclient.ui.chrome.PaymentPlate
import gg.pixelkingdomwars.nativeclient.ui.economy.DisclosurePlate
import gg.pixelkingdomwars.nativeclient.ui.economy.EmptyPlate
import gg.pixelkingdomwars.nativeclient.ui.economy.TitledPlate
import gg.pixelkingdomwars.nativeclient.ui.chrome.OutlinedButton
import gg.pixelkingdomwars.nativeclient.ui.chrome.Button
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import gg.pixelkingdomwars.nativeclient.ui.security.SensitiveMfaDialog
import kotlinx.serialization.json.*

data class CharterControls(val check:Boolean,val accept:Boolean,val pay:Boolean,val prepare:Boolean,val review:Boolean,val approve:Boolean,val publish:Boolean,val deliver:Boolean,val cancel:Boolean,val refund:Boolean,val recoverPreparation:Boolean,val recover:Boolean)
fun charterControls(state:CharterState,allowed:Boolean,running:Boolean=false):CharterControls {
    val r=state.record;val e=state.envelope;val idle=!state.busy&&!running;val current=idle&&allowed&&r?.held!=true&&e?.terminal==null&&e!=null&&state.activity?.raw?.charterObject("newActions")?.get(e.kind)?.let(CharterGrammar::bool)==true
    val sale=e?.kind=="sale";val buyer=sale&&e!!.actor==e.original.charterText("buyer");val seller=sale&&e!!.actor==e.original.charterText("seller")
    val attempts=r?.attempts.orEmpty();val signing=e?.signing!=null;val own=e?.contributions?.any{it.charterText("wallet")==e.actor}==true
    return CharterControls(idle&&r!=null,current&&buyer&&e?.status=="draft"&&"accept" !in attempts,
        current&&seller&&e?.status=="accepted"&&"pay-members" !in attempts,
        current&&e?.status in listOf("funded","admitted","members_paid")&&"prepare" !in attempts,
        current&&signing&&!own&&e?.wire==null&&"wallet" !in attempts,
        current&&signing&&state.reviewed&&"wallet" !in attempts,
        idle&&r?.held!=true&&r?.ownSignature!=null&&!own&&e?.terminal==null,
        current&&e?.wire!=null,
        idle&&seller&&e?.terminal==null,
        idle&&e?.kind=="creation"&&e.status=="cancelled_unpaid",
        idle&&e?.status=="issuing",idle&&e!=null&&e.terminal==null)
}
fun charterEntryAvailable(state:CharterState?,configured:Boolean,unavailable:Boolean)=configured||unavailable||state?.journal?.records?.isNotEmpty()==true||state?.activity?.items?.isNotEmpty()==true
fun charterSolPrice(value:String):String?=runCatching {
    require(value.length in 1..30 && value.matches(Regex("(?:0|[1-9][0-9]*)(?:\\.[0-9]{1,9})?")))
    requireNotNull(solToLamports(value)).toString().also{CharterGrammar.amount(JsonPrimitive(it),true)}
}.getOrNull()
fun charterSummary(e:CharterEnvelope):String=when {e.terminal!=null->"SAVED ${e.status.uppercase().replace('_',' ')} OUTCOME";e.wire!=null->if(e.kind=="sale")"BOTH APPROVALS RETAINED · READY FOR DELIVERY" else "APPROVAL RETAINED · READY FOR DELIVERY";e.contributions.isNotEmpty()->"WAITING FOR THE OTHER WALLET";else->e.status.uppercase().replace('_',' ')}

@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable fun CharterScreen(model:CharterViewModel,allowed:Boolean,policy:CharterAppPolicy?,selectedBaseId:String?,clan:MyClan?,onBack:()->Unit,onDissolve:(()->Unit)?=null,onMigrate:(()->Unit)?=null) {
    val state by model.state.collectAsState();val running by model.busy.collectAsState();val notice by model.notice.collectAsState()
    val controls=charterControls(state,allowed,running);val wallet=model.wallet;val mfa=wallet?.mfa?.collectAsState()?.value
    var name by rememberSaveable{mutableStateOf("")};var tag by rememberSaveable{mutableStateOf("")};var invite by rememberSaveable{mutableStateOf(false)}
    var buyer by rememberSaveable{mutableStateOf("")};var price by rememberSaveable{mutableStateOf("")};var leave by rememberSaveable{mutableStateOf(false)}
    var history by rememberSaveable { mutableStateOf(false) }
    var recovery by rememberSaveable(state.selected) { mutableStateOf(false) }
    val selectionLocation=remember { BringIntoViewRequester() }
    LaunchedEffect(state.selected) { if(state.selected!=null) selectionLocation.bringIntoView() }
    val noticeLocation=remember { BringIntoViewRequester() }
    LaunchedEffect(notice,state.error) { if(notice?.error==true||state.error!=null) noticeLocation.bringIntoView() }
    val back={model.dismiss();onBack()}
    BackHandlerAt(BackPriority.SCREEN){back()};BackHandlerAt(BackPriority.CONFIRM,mfa!=null){mfa?.let{wallet?.cancelMfa(it)}}
    DisposableEffect(model){onDispose{model.dismiss()}}
    LaunchedEffect(allowed,selectedBaseId){model.dismiss()}
    DesignedPage("CLAN CHARTER",back) {
        TitledPlate("LEAD YOUR CLAN", gold=true) {
            Text("Create a clan or transfer its leadership with both wallets’ approval.",color=SurfaceInk.text)
            onMigrate?.let { open -> OutlinedButton(enabled=!running&&!state.busy, onClick=open) { Text("Register an existing clan · saved migrations") } }
            onDissolve?.let { open -> OutlinedButton(enabled=!running&&!state.busy, onClick=open) { Text("Dissolution & saved outcomes") } }
            if(!allowed)Text("New Charter actions are paused. Invitations and saved outcomes remain available.",color=SurfaceInk.goldHi)
            if(selectedBaseId==null)Text("Select a kingdom for creation funding or purchase acceptance.",color=SurfaceInk.muted,style=MaterialTheme.typography.bodySmall)
        }
        if(running||state.busy)LinearProgressIndicator(Modifier.fillMaxWidth())
        if(!state.loaded)EmptyPlate("Loading your Charters and saved requests…")
        Column(Modifier.bringIntoViewRequester(noticeLocation).semantics { liveRegion=LiveRegionMode.Polite }) {
            notice?.let{Text(it.message,color=if(it.error)SurfaceInk.danger else SurfaceInk.text)}
            state.error?.let{Text(it,color=SurfaceInk.danger)}
        }
        val record=state.record;val e=state.envelope
        if(record!=null)PaymentPlate(e?.let(::charterRole)?:"SAVED CHARTER REQUEST",modifier=Modifier.bringIntoViewRequester(selectionLocation),pill=charterRecordPill(record,e),
            details=charterOriginalDetails(record,e),footnote="Closing this page keeps your original request and approvals.") {
            Text(e?.let(::charterSummary)?:"Original outcome has not been confirmed.",style=MaterialTheme.typography.titleSmall,color=SurfaceInk.goldHi)
            if(record.held)Text("A response needs verification. Check this original request before continuing.",color=SurfaceInk.goldHi)
            if("wallet" in record.attempts && record.ownSignature==null)Text("Wallet approval may have completed. Another approval is blocked; recover the original.",color=SurfaceInk.goldHi)
            if(record.attempts.any{it.startsWith("deliver:")} && e?.terminal==null)Text("Delivery was attempted. Checking the outcome does not send a transaction.",color=SurfaceInk.muted)
            e?.let { original->
                if(original.kind=="creation") {
                    val clanTerms=original.original.charterObject("clan")
                    Text("${clanTerms.charterText("name")} [${clanTerms.charterText("tag")}]",style=MaterialTheme.typography.titleLarge)
                    Text("${original.original.charterObject("price").charterText("shards")} SHARDS · original creation funding",Modifier.fillMaxWidth(),color=SurfaceInk.goldHi)
                    Text("SOL transaction costs are separate from SHARDS funding.",color=SurfaceInk.muted,style=MaterialTheme.typography.bodySmall)
                } else {
                    Text("${marketSol(original.original.charterText("priceLamports"))} SOL",Modifier.fillMaxWidth(),style=MaterialTheme.typography.headlineSmall,color=SurfaceInk.goldHi)
                    Text("Original leadership sale price",color=SurfaceInk.muted)
                    Text(if(CharterGrammar.bool(original.original.getValue("sellerLeaves")))"The seller leaves the clan when this sale completes." else "The seller remains a clan member when this sale completes.")
                    Text("Accrued rewards belong to the pre-sale members and are paid first.",style=MaterialTheme.typography.bodySmall,color=SurfaceInk.muted)
                }
                original.signing?.charterObject("costs")?.let { costs->
                    Text(if(original.terminal!=null)"ORIGINAL TRANSACTION QUOTE" else "TRANSACTION COST REVIEW",style=MaterialTheme.typography.labelLarge,color=SurfaceInk.goldHi)
                    charterCostRows(costs).forEach { row->Text("${row.label}: ${row.value}",Modifier.fillMaxWidth(),style=MaterialTheme.typography.bodySmall) }
                    Text("${if(original.kind=="sale")"Buyer’s quoted total" else "Quoted SOL total"}: ${marketSol(costs.charterText("totalLamports"))} SOL",Modifier.fillMaxWidth(),style=MaterialTheme.typography.titleMedium,color=SurfaceInk.goldHi)
                    Text("A quote is not a payment receipt.",style=MaterialTheme.typography.bodySmall,color=SurfaceInk.muted)
                }
                if(original.terminal!=null)Text("The server recorded this outcome. Full original details remain available.",color=SurfaceInk.muted)
            }
            if(controls.accept)Button(onClick={selectedBaseId?.let{model.accept(it)}},enabled=selectedBaseId!=null,modifier=Modifier.fillMaxWidth()){Text("ACCEPT WITH SELECTED KINGDOM")}
            if(controls.pay)Button(onClick={model.payMembers()},modifier=Modifier.fillMaxWidth()){Text("PAY FROZEN MEMBER REWARDS")}
            if(controls.prepare)Button(onClick={model.prepare()},modifier=Modifier.fillMaxWidth()){Text("PREPARE TRANSACTION")}
            if(controls.recoverPreparation)OutlinedButton(onClick={model.recoverPreparation()},modifier=Modifier.fillMaxWidth()){Text("CHECK PREPARATION")}
            if(controls.review)OutlinedButton(onClick={model.review()},modifier=Modifier.fillMaxWidth()){Text("REVIEW EXACT TRANSACTION")}
            if(controls.approve)Button(onClick={model.approve()},modifier=Modifier.fillMaxWidth()){Text("APPROVE IN WALLET")}
            if(controls.publish)Button(onClick={model.publish()},modifier=Modifier.fillMaxWidth()){Text("SAVE APPROVAL")}
            if(controls.deliver)Button(onClick={model.deliver()},modifier=Modifier.fillMaxWidth()){Text("DELIVER SAVED TRANSACTION")}
            if(controls.check)OutlinedButton(onClick={model.check()},modifier=Modifier.fillMaxWidth()){Text("CHECK ORIGINAL RECORD")}
            // Dead-end audit 2026-10-06: an offer the server never recorded must not block every new offer.
            if(record.closed)Text("Closed on this device: the server had no record of this offer. A new offer can be saved.",color=SurfaceInk.muted)
            else if(charterClosable(record))OutlinedButton(onClick={model.closeAbsent()},enabled=!running&&!state.busy,modifier=Modifier.fillMaxWidth()){Text("CHECK & CLOSE IF THE SERVER HAS NO RECORD")}
            DisclosurePlate("RECOVERY & CANCELLATION",recovery,{recovery=!recovery}) {
                Text("These actions keep the original request. Cancellation must be verified before any funds or lock can be released.",style=MaterialTheme.typography.bodySmall,color=SurfaceInk.muted)
                if(controls.recover)OutlinedButton(onClick={model.recover()},modifier=Modifier.fillMaxWidth()){Text("CHECK CHAIN OUTCOME")}
                if(controls.cancel)OutlinedButton(onClick={model.cancel()},modifier=Modifier.fillMaxWidth()){Text("REQUEST SAFE CANCELLATION")}
                if(controls.refund)OutlinedButton(onClick={model.refund(selectedBaseId)},modifier=Modifier.fillMaxWidth()){Text("REFUND ORIGINAL CREATION FUNDING")}
            }
        }
        TitledPlate("INVITATIONS & ACTIVITY") {
            OutlinedButton(onClick={model.refresh()},enabled=!running&&!state.busy,modifier=Modifier.fillMaxWidth()){Text("CHECK INVITATIONS & HISTORY")}
            if(state.loaded&&state.activity==null)Text("Activity is unavailable. Saved requests are kept below.",color=SurfaceInk.muted)
            if(state.activity?.items?.isEmpty()==true)Text("No invitations or Charter activity on this page.",color=SurfaceInk.muted)
            state.activity?.items?.forEach{item->OutlinedButton(onClick={model.select(item.charterText("kind"),item.charterText("key"))},enabled=!running&&!state.busy,modifier=Modifier.fillMaxWidth()){
                Column(Modifier.fillMaxWidth(),verticalArrangement=Arrangement.spacedBy(4.dp)) {
                    Text(item["name"]?.takeUnless{it==JsonNull}?.jsonPrimitive?.content?:"Clan Charter",color=SurfaceInk.goldHi)
                    Text("${item.charterText("participantRole").replace('_',' ')} · ${item.charterText("status").replace('_',' ')}",style=MaterialTheme.typography.bodySmall)
                }
            }}
            if(state.activity?.cursor!=null)OutlinedButton(onClick={model.nextPage()},enabled=!running&&!state.busy){Text("MORE HISTORY")}
        }
        if(allowed&&policy!=null) {
            if(clan==null)TitledPlate("CREATE A CLAN",gold=true) {
                Text("${policy.protocol.createCostShards} SHARDS",Modifier.fillMaxWidth(),style=MaterialTheme.typography.headlineSmall,color=SurfaceInk.goldHi)
                Text("Creation funding comes from your selected kingdom. SOL fees are reviewed separately before wallet approval.",color=SurfaceInk.muted)
                OutlinedTextField(name,{if(it.length<=policy.protocol.nameMax)name=it},label={Text("Clan name")},supportingText={Text("${policy.protocol.nameMin}–${policy.protocol.nameMax} characters")},singleLine=true,modifier=Modifier.fillMaxWidth())
                OutlinedTextField(tag,{if(it.length<=policy.protocol.tagMax)tag=it.uppercase()},label={Text("Clan tag")},supportingText={Text("${policy.protocol.tagMin}–${policy.protocol.tagMax} characters")},singleLine=true,modifier=Modifier.fillMaxWidth())
                Row(verticalAlignment=Alignment.CenterVertically){Checkbox(invite,{invite=it});Text("Invite-only membership",Modifier.weight(1f))}
                Button(onClick={selectedBaseId?.let{model.create(it,name,tag,if(invite)"invite" else "open")}},enabled=!running&&!state.busy&&selectedBaseId!=null&&name.length in policy.protocol.nameMin..policy.protocol.nameMax&&tag.length in policy.protocol.tagMin..policy.protocol.tagMax,modifier=Modifier.fillMaxWidth()){Text("FUND CLAN CREATION")}
            } else if(clan.leaderWallet==state.journal?.identity?.wallet)TitledPlate("OFFER CLAN LEADERSHIP",gold=true) {
                Text(clan.name,style=MaterialTheme.typography.titleLarge,color=SurfaceInk.goldHi)
                Text("Choose the buyer and exact sale price. Both wallets must approve; accrued member rewards are paid before transfer.",color=SurfaceInk.muted)
                OutlinedTextField(buyer,{if(it.length<=44)buyer=it},label={Text("Buyer wallet")},singleLine=true,modifier=Modifier.fillMaxWidth())
                OutlinedTextField(price,{if(it.length<=30)price=it},label={Text("Sale price in SOL")},supportingText={Text("Enter the exact SOL amount. Transaction fees are reviewed later.")},singleLine=true,modifier=Modifier.fillMaxWidth())
                charterSolPrice(price)?.let { Text("Offer price: ${marketSol(it)} SOL",Modifier.fillMaxWidth(),style=MaterialTheme.typography.titleMedium,color=SurfaceInk.goldHi) }
                Row(verticalAlignment=Alignment.CenterVertically){Checkbox(leave,{leave=it});Text("Leave the clan after this sale",Modifier.weight(1f))}
                Button(onClick={charterSolPrice(price)?.let{model.sell(clan.id,buyer,it,leave)}},enabled=!running&&!state.busy&&buyer.isNotBlank()&&charterSolPrice(price)!=null,modifier=Modifier.fillMaxWidth()){Text("SAVE SALE OFFER")}
            }
        }
        DisclosurePlate("SAVED REQUESTS (${state.journal?.records?.size?:0})",history,{history=!history}) {
            if(state.journal?.records?.isEmpty()==true)EmptyPlate("No saved Charter requests on this device.")
            state.journal?.records?.forEach{r->OutlinedButton(onClick={model.selectSaved(r.localKey)},enabled=!running&&!state.busy,modifier=Modifier.fillMaxWidth()){
                Text("Saved ${r.kind} · ${r.envelope?.let(CharterEnvelope::from)?.status?.replace('_',' ')?:if(r.closed)"closed · server had no record" else "outcome unknown"}")}}
        }
    }
    if(mfa!=null)SensitiveMfaDialog(mfa,submit={wallet.submitMfa(mfa,it)},cancelRequest={wallet.cancelMfa(mfa)})
}
