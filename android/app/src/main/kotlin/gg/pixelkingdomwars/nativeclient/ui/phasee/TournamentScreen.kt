package gg.pixelkingdomwars.nativeclient.ui.phasee

import gg.pixelkingdomwars.nativeclient.ui.chrome.SurfaceInk
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.semantics.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.model.MyClan
import gg.pixelkingdomwars.nativeclient.model.marketSol
import gg.pixelkingdomwars.nativeclient.ui.Palette
import gg.pixelkingdomwars.nativeclient.ui.chrome.DesignedPage
import gg.pixelkingdomwars.nativeclient.ui.chrome.PaymentPlate
import gg.pixelkingdomwars.nativeclient.ui.chrome.PaymentDetail
import gg.pixelkingdomwars.nativeclient.ui.chrome.PaymentPill
import gg.pixelkingdomwars.nativeclient.ui.chrome.PaymentTone
import gg.pixelkingdomwars.nativeclient.ui.economy.DisclosurePlate
import gg.pixelkingdomwars.nativeclient.ui.economy.EmptyPlate
import gg.pixelkingdomwars.nativeclient.ui.economy.TitledPlate
import gg.pixelkingdomwars.nativeclient.ui.chrome.OutlinedButton
import gg.pixelkingdomwars.nativeclient.ui.chrome.Button
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import gg.pixelkingdomwars.nativeclient.ui.security.SensitiveMfaDialog
import kotlinx.serialization.json.*

data class TournamentControls(val prepare:Boolean,val review:Boolean,val approve:Boolean,val upload:Boolean,val deliver:Boolean,val recover:Boolean)
fun tournamentControls(state:TournamentState,allowed:Boolean,running:Boolean=false):TournamentControls {
 val r=state.operation;val v=r?.response;val idle=!state.busy&&!running;val current=idle&&allowed&&r?.held==false&&v!=null&&v.charterOptional("terminal")==null
 val wallet="wallet" in r?.attempts.orEmpty();val ready=v?.charterOptional("preparation")!=null;val signed=v?.charterOptional("signed")!=null
 return TournamentControls(current&&v?.charterText("status")=="draft",current&&ready&&!wallet&&!signed,current&&ready&&state.reviewed&&!wallet&&!signed,
  idle&&r?.held==false&&r.signed!=null&&!signed&&v?.charterOptional("terminal")==null,current&&signed,idle&&v!=null&&v.charterOptional("terminal")==null)
}
@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable fun TournamentScreen(model:TournamentViewModel,allowed:Boolean,selectedBase:String?,clan:MyClan?,back:()->Unit) {
    val state by model.state.collectAsState();val running by model.busy.collectAsState();val notice by model.notice.collectAsState();val idle=!running&&!state.busy;val c=tournamentControls(state,allowed,running)
    val wallet=model.wallet;val mfa=wallet?.mfa?.collectAsState()?.value
    var history by rememberSaveable { mutableStateOf(false) }
    var rankings by rememberSaveable(state.eventId) { mutableStateOf(false) }
    var fundedStock by rememberSaveable(state.eventId) { mutableStateOf(false) }
    var recovery by rememberSaveable(state.selectedOperation) { mutableStateOf(false) }
    var roster by rememberSaveable(state.selectedOperation) { mutableStateOf(false) }
    val selectionLocation=remember { BringIntoViewRequester() }
    LaunchedEffect(state.eventId) { if(state.eventId!=null) selectionLocation.bringIntoView() }
    val noticeLocation=remember { BringIntoViewRequester() }
    LaunchedEffect(notice,state.error) { if(notice?.error==true||state.error!=null) noticeLocation.bringIntoView() }
    BackHandlerAt(BackPriority.SCREEN){model.dismiss();back()};BackHandlerAt(BackPriority.CONFIRM,mfa!=null){mfa?.let{wallet?.cancelMfa(it)}}
    LaunchedEffect(allowed,selectedBase){model.dismiss()}
    DesignedPage("CLAN TOURNAMENT",{model.dismiss();back()}) {
        TitledPlate("COMPETE WITH YOUR CLAN",gold=true) {
            Text("Battle with your original roster for Divine sites and sponsor-funded crafting materials.")
            if(!allowed)Text("New entry, signing and matches are paused. Saved entries, approvals and prizes remain readable.",color=SurfaceInk.goldHi)
            if(selectedBase==null)Text("Select a kingdom to start a match or claim a prize.",color=SurfaceInk.muted,style=MaterialTheme.typography.bodySmall)
        }
        if(!idle)LinearProgressIndicator(Modifier.fillMaxWidth())
        if(!state.loaded)EmptyPlate("Loading tournaments and original participation…")
        Column(Modifier.bringIntoViewRequester(noticeLocation).semantics { liveRegion=LiveRegionMode.Polite }) {
            notice?.let{Text(it.message,color=if(it.error)SurfaceInk.danger else SurfaceInk.text)}
            state.error?.let{Text(it,color=SurfaceInk.danger)}
        }
        state.event?.let { event->
            PaymentPlate("SELECTED TOURNAMENT",modifier=Modifier.bringIntoViewRequester(selectionLocation),pill=event.charterOptional("terminal")?.let { PaymentPill("RESULTS",PaymentTone.DONE) },
                details=listOf(PaymentDetail("Event",event.charterText("id")))+tournamentScheduleDetails(event)) {
                Text("Entry opens: ${islandShareTime(event.charterText("entryStartsAt"))}")
                Text("Entry closes / battles open: ${islandShareTime(event.charterText("playStartsAt"))}",color=SurfaceInk.goldHi)
                Text("Battles close: ${islandShareTime(event.charterText("playEndsAt"))}")
                Text("Occupation ends: ${islandShareTime(event.charterText("occupationEndsAt"))}",color=SurfaceInk.muted)
                Text("${event.charterObject("policy")["raidsPerWallet"]} free matched raids per frozen member, across all kingdoms. Entry freezes the captain and roster until the original lock is cleared.",style=MaterialTheme.typography.bodySmall)
                Text("No entry fee. Sponsor prizes use existing materials and are untaxed. Any clan fragment earnings appear in Fragment rewards.",color=SurfaceInk.muted,style=MaterialTheme.typography.bodySmall)
                if(clan==null)Text("Join a clan to enter with its captain. Original roster rights remain tied to the saved event.",color=SurfaceInk.muted)
                else {
                    val completed=event.charterOptional("terminal")!=null
                    val entered=state.participation?.charterOptional("entry")!=null
                    val captain=tournamentCaptainCanEnter(clan.leaderWallet,state.journal?.identity?.wallet,completed,entered)
                    when {
                        completed -> Text("Entry is closed. Results and original participation remain available below.",color=SurfaceInk.muted)
                        entered -> Text("Your original roster is already entered. Continue with its saved participation below.",color=SurfaceInk.muted)
                        !captain -> Text("Only your current clan captain can enter the clan. Frozen members can use their original participation below.",color=SurfaceInk.muted)
                    }
                    Button(onClick={model.enter(clan.id)},enabled=idle&&allowed&&captain,modifier=Modifier.fillMaxWidth()){Text("ENTER AS CLAN CAPTAIN")}
                }
                OutlinedButton(onClick={model.check()},enabled=idle,modifier=Modifier.fillMaxWidth()){Text("CHECK ORIGINAL PARTICIPATION")}
                DisclosurePlate("SPONSOR PRIZE STOCK",fundedStock,{fundedStock=!fundedStock}) {
                    Text("Funded event stock; your personal award appears separately after results.",color=SurfaceInk.muted,style=MaterialTheme.typography.bodySmall)
                    event.charterObject("budget").forEach { (item,quantity)->Text("${islandShareResource(item)}: ${CharterGrammar.text(quantity)}",Modifier.fillMaxWidth()) }
                }
                OutlinedButton(onClick={model.closeEvent()},enabled=idle,modifier=Modifier.fillMaxWidth()){Text("CHECK FINAL RESULTS")}
            }
        }
        state.operation?.let { r->
            val v=r.response
            val action=v?.charterObject("original")?.charterObject("operation")?.charterText("action")
            PaymentPlate(if(action=="clear")"RELEASE ORIGINAL CAPTAIN LOCK" else "CAPTAIN LOCK APPROVAL",
                details=listOfNotNull(PaymentDetail("Saved request",r.key),PaymentDetail("Original event",r.eventId),
                    v?.let { PaymentDetail("Original captain",it.charterObject("operationTerms").charterText("leader")) },
                    v?.let { PaymentDetail("Lock",it.charterObject("operationTerms").charterText("lockId")) },
                    v?.charterOptional("signed")?.let { PaymentDetail("Transaction",it.charterText("signature")) }),
                footnote="Closing this page keeps the original approval and lock record.") {
                Text(v?.charterText("status")?.replace('_',' ')?.uppercase()?:"OUTCOME UNKNOWN",style=MaterialTheme.typography.titleSmall,color=SurfaceInk.goldHi)
                v?.let { Text(tournamentLockConsent(it)) }
                v?.charterOptional("attempt")?.charterObject("quote")?.charterObject("costs")?.let { cost->
                    Text("ORIGINAL TRANSACTION QUOTE",style=MaterialTheme.typography.labelLarge,color=SurfaceInk.goldHi)
                    charterCostRows(cost).forEach { row->Text("${row.label}: ${row.value}",Modifier.fillMaxWidth(),style=MaterialTheme.typography.bodySmall) }
                    Text("${marketSol(cost.charterText("totalLamports"))} SOL · quoted total",Modifier.fillMaxWidth(),style=MaterialTheme.typography.headlineSmall,color=SurfaceInk.goldHi)
                    Text("Network fee and account rent for this lock. A quote is not a payment receipt.",style=MaterialTheme.typography.bodySmall,color=SurfaceInk.muted)
                }
                if("wallet" in r.attempts&&r.signed==null)Text("Wallet approval may have completed. Another wallet prompt is blocked; recover the original.",color=SurfaceInk.goldHi)
                if(r.held)Text("An original response needs verification before another action.",color=SurfaceInk.goldHi)
                v?.let { op->DisclosurePlate("FROZEN ROSTER (${op.charterObject("operationTerms").getValue("roster").jsonArray.size})",roster,{roster=!roster}) {
                    op.charterObject("operationTerms").getValue("roster").jsonArray.forEach { Text(CharterGrammar.text(it),Modifier.fillMaxWidth(),style=MaterialTheme.typography.bodySmall) }
                } }
                if(c.prepare)Button(onClick={model.command("prepare")},modifier=Modifier.fillMaxWidth()){Text("PREPARE EXACT LOCK")}
                if(v?.charterText("status")=="issuing")OutlinedButton(onClick={model.command("recover-preparation")},enabled=idle,modifier=Modifier.fillMaxWidth()){Text("RECOVER EXISTING PREPARATION")}
                if(c.review)Button(onClick={model.review()},modifier=Modifier.fillMaxWidth()){Text("REVIEW EXACT TRANSACTION")}
                if(c.approve)Button(onClick={model.approve()},modifier=Modifier.fillMaxWidth()){Text("APPROVE WITH ORIGINAL CAPTAIN WALLET")}
                if(c.upload)Button(onClick={model.upload()},modifier=Modifier.fillMaxWidth()){Text("SAVE EXISTING WALLET APPROVAL")}
                if(c.deliver)Button(onClick={model.deliver()},modifier=Modifier.fillMaxWidth()){Text("DELIVER EXACT SIGNED TRANSACTION")}
                if(c.recover)DisclosurePlate("ORIGINAL LOCK RECOVERY",recovery,{recovery=!recovery}) {
                    Text("Recovery checks the saved operation. Lock cancellation requires verified expiry and an unused approval.",style=MaterialTheme.typography.bodySmall,color=SurfaceInk.muted)
                    OutlinedButton(onClick={model.command("recover")},modifier=Modifier.fillMaxWidth()){Text("RECOVER ORIGINAL OUTCOME")}
                    OutlinedButton(onClick={model.command("cancel")},modifier=Modifier.fillMaxWidth()){Text("CHECK STRICT EXPIRY CANCELLATION")}
                }
            }
        }
        state.participation?.charterOptional("entry")?.let { entry->
            PaymentPlate("YOUR TOURNAMENT MATCHES",details=listOf(PaymentDetail("Original captain",entry.charterText("leader")),PaymentDetail("Original entry",entry.charterText("entryId")))) {
                Text("${entry.getValue("roster").jsonArray.size} frozen members",style=MaterialTheme.typography.titleMedium,color=SurfaceInk.goldHi)
                Text("Your original roster keeps its participation rights for this event. The server verifies remaining matches and free raid energy.",color=SurfaceInk.muted)
                Button(onClick={selectedBase?.let{model.raid(it)}},enabled=idle&&allowed&&selectedBase!=null,modifier=Modifier.fillMaxWidth()){Text("FIND AUTOMATIC TOURNAMENT MATCH")}
            }
        }
        state.participation?.charterOptional("prize")?.let { prize->
            val claim=prize.charterOptional("claim")
            PaymentPlate("YOUR SPONSOR PRIZE",pill=PaymentPill(if(claim==null)"AVAILABLE" else "CLAIMED",if(claim==null)PaymentTone.OPEN else PaymentTone.DONE),
                details=listOfNotNull(claim?.let { PaymentDetail("Original destination",it.charterText("baseId")) },claim?.let { PaymentDetail("Claimed at (UTC)",it.charterText("claimedAt")) })) {
                tournamentPrizeRows(prize).forEach { row->Text("${row.value} ${row.label}",Modifier.fillMaxWidth(),style=MaterialTheme.typography.titleMedium,color=SurfaceInk.goldHi) }
                Text("Existing sponsor materials · untaxed · assigned to your original wallet.",color=SurfaceInk.muted,style=MaterialTheme.typography.bodySmall)
                if(claim==null)Button(onClick={selectedBase?.let{model.claim(it)}},enabled=idle&&allowed&&selectedBase!=null,modifier=Modifier.fillMaxWidth()){Text("CLAIM TO SELECTED KINGDOM")}
                else Text("Claimed ${islandShareTime(claim.charterText("claimedAt"))}. Your original destination receipt is kept.",color=SurfaceInk.muted)
            }
        }
        if(state.event!=null&&state.participation!=null&&state.participation?.charterOptional("prize")==null)EmptyPlate("No sponsor prize is recorded for this wallet in this event.")
        state.journal?.records?.filter{it.eventId==state.eventId&&it.kind!="operation"}?.forEach { r->
            PaymentPlate("SAVED ${r.kind.uppercase()}",details=listOfNotNull(PaymentDetail("Saved request",r.key),
                if(r.kind in listOf("raid","prize"))PaymentDetail("Original kingdom",r.body.charterText("baseId")) else null)) {
                Text(r.response?.get("status")?.jsonPrimitive?.content?.replace('_',' ')?:if(r.response!=null)"Recorded" else if(r.closed)"Closed · the server had no record" else "Outcome unknown",style=MaterialTheme.typography.titleMedium,color=SurfaceInk.goldHi)
                if(r.held)Text("A saved response needs verification. Keep this original request and recover its outcome.",color=SurfaceInk.goldHi)
                if(r.kind=="raid"&&r.response?.charterText("status")=="admitted"&&selectedBase!=r.body.charterText("baseId"))Text("Select the original attacking kingdom to resume this battle. Its full identity is in Details.",color=SurfaceInk.muted)
                OutlinedButton(onClick={model.recover(r.key)},enabled=idle,modifier=Modifier.fillMaxWidth()){Text("CHECK ORIGINAL")}
                if(!r.closed&&(r.response==null||r.kind=="raid"&&r.response.charterText("status")=="requested"))OutlinedButton(onClick={model.retry(r.key)},enabled=idle&&allowed&&!r.held,modifier=Modifier.fillMaxWidth()){Text("RETRY SAME REQUEST")}
                // Dead-end audit 2026-10-06: an entry or match request the server never recorded must not block the event forever.
                if(r.kind in listOf("entry","raid")&&r.response==null&&!r.closed)OutlinedButton(onClick={model.closeAbsent(r.key)},enabled=idle&&!r.held,modifier=Modifier.fillMaxWidth()){Text("CHECK & CLOSE IF THE SERVER HAS NO RECORD")}
                if(r.kind=="entry"&&r.response?.charterText("status") in listOf("entered","nonparticipating"))Button(onClick={model.clear()},enabled=idle&&allowed,modifier=Modifier.fillMaxWidth()){Text("PREPARE ORIGINAL LOCK CLEAR")}
                if(r.kind=="raid") {
                    if(r.response?.charterText("status")=="requested")OutlinedButton(onClick={model.cancelRaid(r.key)},enabled=idle,modifier=Modifier.fillMaxWidth()){Text("CANCEL UNADMITTED MATCH REQUEST")}
                    if(r.response?.charterText("status")=="admitted")Button(onClick={model.play(r.key)},enabled=idle&&allowed&&selectedBase==r.body.charterText("baseId"),modifier=Modifier.fillMaxWidth()){Text("RESUME ORIGINAL BATTLE")}
                }
            }
        }
        state.event?.charterOptional("terminal")?.let { end->
            DisclosurePlate("FINAL RANKINGS",rankings,{rankings=!rankings}) {
                val rows=end.getValue("rankings").jsonArray
                if(rows.isEmpty())EmptyPlate("No qualifying clans in this event.")
                rows.forEachIndexed { i,row->val r=row.jsonObject
                    PaymentPlate("RANK ${i+1}",details=listOf(PaymentDetail("Clan",r.charterText("clanId")))) {
                        Text("${r["stars"]} stars · ${r["rosterSize"]} members",color=SurfaceInk.goldHi)
                        Text("${r["destruction"]} total destruction",color=SurfaceInk.muted)
                    }
                }
            }
        }
        TitledPlate("FUNDED TOURNAMENTS") {
            OutlinedButton(onClick={model.refresh()},enabled=idle,modifier=Modifier.fillMaxWidth()){Text("CHECK TOURNAMENTS & HISTORY")}
            if(state.loaded&&state.events==null)Text("Event discovery is unavailable. Saved event history remains below.",color=SurfaceInk.muted)
            if(state.events?.getValue("events")?.jsonArray?.isEmpty()==true)Text("No funded tournaments on this page.",color=SurfaceInk.muted)
            state.events?.getValue("events")?.jsonArray?.forEach { raw->val event=raw.jsonObject
                OutlinedButton(onClick={model.select(event.charterText("id"))},enabled=idle,modifier=Modifier.fillMaxWidth()) {
                    Column(Modifier.fillMaxWidth(),verticalArrangement=Arrangement.spacedBy(4.dp)) {
                        Text(if(event.charterOptional("terminal")!=null)"TOURNAMENT RESULTS" else "CLAN TOURNAMENT",color=SurfaceInk.goldHi)
                        Text("Battles open ${islandShareTime(event.charterText("playStartsAt"))}",style=MaterialTheme.typography.bodySmall)
                    }
                }
            }
            state.events?.get("nextCursor")?.takeUnless{it==JsonNull}?.let{cursor->OutlinedButton(onClick={model.refresh(CharterGrammar.text(cursor))},enabled=idle){Text("MORE TOURNAMENTS")}}
        }
        val savedEvents=state.journal?.records.orEmpty().map{it.eventId}.distinct()
        DisclosurePlate("SAVED EVENTS & LOCKS (${savedEvents.size})",history,{history=!history}) {
            if(savedEvents.isEmpty())EmptyPlate("No saved tournament requests on this device.")
            savedEvents.forEach{id->OutlinedButton(onClick={model.select(id)},enabled=idle,modifier=Modifier.fillMaxWidth()){Text("OPEN SAVED TOURNAMENT · $id")}}
            state.journal?.records?.filter{it.kind=="operation"&&it.eventId==state.eventId}?.forEach{r->OutlinedButton(onClick={model.operation(r.key)},enabled=idle,modifier=Modifier.fillMaxWidth()){Text("${r.response?.charterObject("original")?.charterObject("operation")?.charterText("action")?.uppercase()?:"ORIGINAL"} LOCK · ${r.response?.charterText("status")?:"unknown"}")}}
        }
    }
    if(mfa!=null)SensitiveMfaDialog(mfa,submit={wallet.submitMfa(mfa,it)},cancelRequest={wallet.cancelMfa(mfa)})
}
