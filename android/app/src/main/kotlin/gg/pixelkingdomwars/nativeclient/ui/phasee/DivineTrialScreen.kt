package gg.pixelkingdomwars.nativeclient.ui.phasee

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.*
import gg.pixelkingdomwars.nativeclient.data.ContentState
import gg.pixelkingdomwars.nativeclient.divine.*
import gg.pixelkingdomwars.nativeclient.network.fmtN
import gg.pixelkingdomwars.nativeclient.ui.Palette
import gg.pixelkingdomwars.nativeclient.ui.chrome.*
import gg.pixelkingdomwars.nativeclient.ui.economy.DisclosurePlate
import gg.pixelkingdomwars.nativeclient.ui.economy.EmptyPlate
import gg.pixelkingdomwars.nativeclient.ui.economy.TitledPlate
import kotlinx.serialization.json.*

@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable fun DivineTrialScreen(model:DivineTrialViewModel,base:String?,allowed:Boolean,visible:Boolean,content:ContentState,identity:String,onBack:()->Unit) {
    val state by model.state.collectAsState();val busy by model.busy.collectAsState();val notice by model.notice.collectAsState();var battleId by remember(identity){mutableStateOf<String?>(null)}
    LaunchedEffect(visible){if(!visible)battleId=null}
    val saved=state.selected;val participant=saved?.participant;val attempts=participant?.drows("attempts").orEmpty();val attempt=attempts.singleOrNull{it.dt("id")==battleId}
    if(attempt!=null&&saved!=null&&visible){DivineTrialBattle(attempt,DivineRules.from(saved.rules),content,allowed&&!busy,{model.submit(attempt.dt("id"),it)},{battleId=null},state.error?:notice?.message);return}
    var history by rememberSaveable(identity) { mutableStateOf(false) }
    var eventStock by rememberSaveable(saved?.id) { mutableStateOf(false) }
    var fixedArmy by rememberSaveable(saved?.id) { mutableStateOf(false) }
    var standings by rememberSaveable(saved?.id) { mutableStateOf(false) }
    val noticeLocation=remember { BringIntoViewRequester() };val eventLocation=remember { BringIntoViewRequester() }
    LaunchedEffect(state.error,notice) { if(state.error!=null||notice?.error==true)noticeLocation.bringIntoView() }
    LaunchedEffect(saved?.id) { if(saved!=null)eventLocation.bringIntoView() }
    DesignedPage("DIVINE TRIALS",onBack) {
        TitledPlate("ONE ARMY. YOUR PLAN.",gold=true) {
            Text("Every entrant plans the same fixed army. Your normal army, energy and ordinary raid rewards are unaffected.")
            Text("Server results decide rank. Equal scores use wallet ASCII order.",style=MaterialTheme.typography.bodySmall,color=SurfaceInk.muted)
            if(!allowed)Text("New trial actions are paused. Saved history and original recovery remain available.",color=SurfaceInk.goldHi)
            if(base==null)Text("Select a kingdom before requesting entry, a new attempt or a fresh prize claim.",color=SurfaceInk.muted)
        }
        if(busy||state.busy)LinearProgressIndicator(Modifier.fillMaxWidth())
        if(state.journal==null)EmptyPlate("Opening saved trial history…")
        Column(Modifier.bringIntoViewRequester(noticeLocation).semantics { liveRegion=LiveRegionMode.Polite }) {
            state.error?.let{Text(it,color=SurfaceInk.danger)}
            if(state.error==null)notice?.let{Text(it.message,color=if(it.error)SurfaceInk.danger else SurfaceInk.text)}
        }
        if(saved!=null) {
            val rules=DivineRules.from(saved.rules);val actions=divineTrialActions(saved)
            val closed=saved.event.doptional("terminal")!=null
            PaymentPlate("YOUR SELECTED TRIAL",modifier=Modifier.bringIntoViewRequester(eventLocation),
                details=listOf(PaymentDetail("Original event",saved.id))+tournamentScheduleDetails(saved.event),
                footnote="Leaving this page keeps your entry, attempts and original requests.") {
                Text(if(closed)"FINAL RESULTS" else "EVENT SCHEDULE",style=MaterialTheme.typography.labelLarge,color=SurfaceInk.goldHi)
                Text("Entry opens: ${islandShareTime(saved.event.dt("entryStartsAt"))}")
                Text("Entry closes / play begins: ${islandShareTime(saved.event.dt("playStartsAt"))}")
                Text("Play ends: ${islandShareTime(saved.event.dt("playEndsAt"))}",color=SurfaceInk.goldHi)
                Text("Occupation ends: ${islandShareTime(saved.event.dt("occupationEndsAt"))}",color=SurfaceInk.muted)
                if(closed)Text("Entry and new attempts are closed. Original results and prizes remain available.",color=SurfaceInk.muted)
                if(saved.held.isNotEmpty())Text("A saved response needs verification. Recover this event before another request.",color=SurfaceInk.goldHi)
                if(saved.commands.any{it.unresolved})Text("An original request is still unresolved. Recover that request before starting another action.",color=SurfaceInk.goldHi)
                OutlinedButton(enabled=!busy,onClick={model.check()},modifier=Modifier.fillMaxWidth()){Text("RECOVER THIS EVENT")}
                DisclosurePlate("FIXED ARMY & SCORING",fixedArmy,{fixedArmy=!fixedArmy}) {
                    rules.policy.dobj("army").forEach { (troop,quantity)->Text("${quantity.jsonPrimitive.content} ${islandShareResource(troop)} · level ${rules.policy.dobj("levels")[troop]}") }
                    Text("At least ${rules.bound("minWinningStars")} stars are required for a winning score. Stars rank first, then destruction, then wallet ASCII order.",color=SurfaceInk.muted,style=MaterialTheme.typography.bodySmall)
                }
                DisclosurePlate("FUNDED SPONSOR STOCK",eventStock,{eventStock=!eventStock}) {
                    Text("This is the event’s funded pool. Your personal entitlement appears separately after settlement.",color=SurfaceInk.muted,style=MaterialTheme.typography.bodySmall)
                    saved.event.dobj("budget").forEach { (item,quantity)->Text("${fmtN(DivineGrammar.text(quantity))} ${islandShareResource(item)}",Modifier.fillMaxWidth()) }
                }
            }
            val entry=participant?.doptional("entry")
            TitledPlate("QUALIFICATION & ENTRY",gold=true) {
                Text("Required: ${rules.bound("minRenown")} personally earned Renown and ${rules.bound("minDaysAttested")} attested days.",color=SurfaceInk.goldHi)
                Text("The server verifies your original qualification. A selected kingdom alone does not establish eligibility.",style=MaterialTheme.typography.bodySmall,color=SurfaceInk.muted)
                when {
                    participant==null -> Text("Participation is unavailable. Recover the selected event to check your entry.",color=SurfaceInk.muted)
                    entry!=null -> {
                        Text("ENTRY CONFIRMED",style=MaterialTheme.typography.titleMedium,color=SurfaceInk.goldHi)
                        Text("${fmtN(entry.dobj("qualification").dt("renown"))} Renown · ${fmtN(entry.dobj("qualification").dt("daysAttested"))} attested days · original qualification")
                        Text("Entered ${islandShareTime(entry.dt("enteredAt"))}",color=SurfaceInk.muted)
                    }
                    !closed -> Text("No accepted entry is recorded for this wallet.",color=SurfaceInk.muted)
                }
                if(participant?.get("entry")==JsonNull)Button(enabled=allowed&&!busy&&base!=null&&actions.enter,onClick={base?.let{model.enter(it)}},modifier=Modifier.fillMaxWidth()){Text("ENTER FROM SELECTED KINGDOM")}
            }
            if(entry!=null)PaymentPlate("YOUR ATTEMPTS",details=listOf(PaymentDetail("Entry kingdom",entry.dt("baseId")),PaymentDetail("Entry",entry.dt("id")),PaymentDetail("Qualification proof",entry.dobj("qualification").dt("sourceSha256")))) {
                Text("${attempts.size} / ${rules.bound("attemptsPerWallet")} attempts admitted",style=MaterialTheme.typography.headlineSmall,color=SurfaceInk.goldHi)
                if(attempts.isEmpty())Text("No attempt has been admitted. Start one to plan the fixed army.",color=SurfaceInk.muted)
                if(attempts.any{it.dt("status") in listOf("admitted","committed")})Text("Finish or recover the current attempt before requesting another.",color=SurfaceInk.muted)
                if(attempts.size>=rules.bound("attemptsPerWallet"))Text("All attempts for this event have been used. Original results remain available.",color=SurfaceInk.muted)
                if(attempts.size<rules.bound("attemptsPerWallet")&&attempts.none{it.dt("status") in listOf("admitted","committed")})Button(enabled=allowed&&!busy&&base!=null&&actions.attempt,onClick={base?.let{model.admit(it)}},modifier=Modifier.fillMaxWidth()){Text("USE ATTEMPT ${attempts.size+1} OF ${rules.bound("attemptsPerWallet")}")}
            }
            for(a in attempts)PaymentPlate("ATTEMPT ${a.dn("ordinal")}",pill=divineAttemptPill(a),details=divineAttemptDetails(a)) {
                a.doptional("result")?.let{Text("${it.dn("stars")} stars · ${it.dn("destruction")}% destroyed",Modifier.fillMaxWidth(),style=MaterialTheme.typography.headlineSmall,color=SurfaceInk.goldHi)}
                Text(when(a.dt("status")) {
                    "admitted" -> "Place the complete fixed army, then submit its original plan once. Returning here preserves this attempt."
                    "committed" -> "The original plan is committed. Recover the event to check its authoritative result."
                    "completed" -> "This is the server’s confirmed result. Replay uses the original battlefield and army."
                    else -> "This attempt closed without a score. Its original record is retained."
                },color=SurfaceInk.muted)
                if(a.dt("status") in listOf("admitted","completed"))Button(enabled=visible&&!busy&&content.ready,onClick={battleId=a.dt("id")},modifier=Modifier.fillMaxWidth()){Text(if(a.dt("status")=="admitted")"PLAN FIXED ARMY" else "WATCH RESULT")}
                if(a.dt("status")=="admitted")OutlinedButton(enabled=visible&&!busy,onClick={model.abandon(a.dt("id"))},modifier=Modifier.fillMaxWidth()){Text("ABANDON ATTEMPT ${a.dn("ordinal")} WITHOUT A SCORE")}
            }
            val pending=saved.commands.filter{it.retryable||it.supersededBy!=null}
            if(pending.isNotEmpty())TitledPlate("ORIGINAL REQUEST RECOVERY") {
                for(c in pending)PaymentPlate(divineCommandLabel(c.kind).uppercase(),details=listOfNotNull(PaymentDetail("Original request",c.id),c.attemptId?.let{PaymentDetail("Original attempt",it)},c.request["baseId"]?.let{PaymentDetail("Original kingdom",DivineGrammar.text(it))})) {
                    c.supersededBy?.let{Text("This saved request was not accepted. The canonical attempt is ${it.dt("status")}. Both originals remain retained.",color=SurfaceInk.muted)}
                    if(c.retryable) {
                        Text("Check this original outcome first. Any retry keeps its exact request and destination.",color=SurfaceInk.muted,style=MaterialTheme.typography.bodySmall)
                        OutlinedButton(enabled=visible&&!busy,onClick={model.retry(c.id)},modifier=Modifier.fillMaxWidth()){Text("CHECK ORIGINAL ${divineCommandLabel(c.kind).uppercase()} & RETRY")}
                        if(c.kind in listOf("entries","attempts")) {
                            Text("If the server has no record of this request and a retry is refused, close it to free this trial. CLOSE checks first.",color=SurfaceInk.muted,style=MaterialTheme.typography.bodySmall)
                            OutlinedButton(enabled=visible&&!busy,onClick={model.closeAbsent(c.id)},modifier=Modifier.fillMaxWidth()){Text("CLOSE IF THE SERVER HAS NO RECORD")}
                        }
                    }
                }
            }
            participant?.doptional("prize")?.let { p->
                val claim=p.doptional("claim");val destination=divinePrizeDestination(saved,base)
                PaymentPlate("YOUR SPONSOR PRIZE",pill=PaymentPill(if(claim==null)"AVAILABLE" else "CLAIMED",if(claim==null)PaymentTone.OPEN else PaymentTone.DONE),
                    details=listOfNotNull(destination?.let{PaymentDetail(if(claim!=null||saved.commands.any{it.kind=="prize"})"Original prize destination" else "Selected prize destination",it)},claim?.let{PaymentDetail("Claimed at (UTC)",it.dt("claimedAt"))})) {
                    divinePrizeRows(p).forEach{row->Text("${row.value} ${row.label}",Modifier.fillMaxWidth(),style=MaterialTheme.typography.titleMedium,color=SurfaceInk.goldHi)}
                    Text("Existing sponsor materials · untaxed. Fragment earnings, when awarded, appear in Fragment rewards.",color=SurfaceInk.muted,style=MaterialTheme.typography.bodySmall)
                    if(claim==null) {
                        if(saved.commands.any{it.kind=="prize"})Text("The prize request keeps its original destination. Use original request recovery above; changing kingdoms does not redirect it.",color=SurfaceInk.goldHi)
                        Button(enabled=visible&&!busy&&base!=null&&actions.claim,onClick={base?.let{model.claim(it)}},modifier=Modifier.fillMaxWidth()){Text("CLAIM INTO SELECTED KINGDOM")}
                    } else Text("Claim confirmed ${islandShareTime(claim.dt("claimedAt"))}. The original destination receipt is retained.",color=SurfaceInk.muted)
                }
            }
            if(participant!=null&&participant.doptional("prize")==null)EmptyPlate("No sponsor prize is recorded for this wallet in the selected event.")
            saved.event.doptional("terminal")?.let { terminal->
                DisclosurePlate("FINAL STANDINGS & OCCUPATIONS",standings,{standings=!standings}) {
                    Text("${terminal.drows("occupations").size} occupied sites. Unfilled sites remain vacant.",color=SurfaceInk.muted)
                    if(terminal.drows("rankings").isEmpty())EmptyPlate("No qualifying winning score was recorded.")
                    terminal.drows("rankings").forEachIndexed { i,row->PaymentPlate("RANK ${i+1}",details=listOf(PaymentDetail("Original wallet",row.dt("wallet")),PaymentDetail("Winning attempt",row.dt("attemptId")))) {
                        Text("${row.dn("stars")} stars · ${row.dn("destruction")}% destroyed",color=SurfaceInk.goldHi)
                    } }
                }
            }
        }
        TitledPlate("WEEKLY TRIALS") {
            OutlinedButton(enabled=!busy,onClick={model.discover()},modifier=Modifier.fillMaxWidth()){Text("DISCOVER WEEKLY TRIALS")}
            if(state.discovery==null&&!busy)Text("Discover events to check the current funded schedule.",color=SurfaceInk.muted)
            if(state.discovery?.drows("events")?.isEmpty()==true)EmptyPlate("No weekly trials on this discovery page.")
            for(event in state.discovery?.drows("events").orEmpty())OutlinedButton(enabled=!busy,onClick={battleId=null;model.select(event)},modifier=Modifier.fillMaxWidth()){Text("Week ${event.dt("entryStartsAt").take(10)} · ${if(event["terminal"]==JsonNull)"EVENT" else "RESULTS"}")}
            state.discovery?.get("nextCursor")?.takeUnless{it==JsonNull}?.let{cursor->OutlinedButton(enabled=!busy,onClick={model.discover(DivineGrammar.text(cursor))}){Text("NEXT EVENTS")}}
        }
        DisclosurePlate("SAVED EVENTS (${state.journal?.events?.size?:0})",history,{history=!history}) {
            if(state.journal?.events?.isEmpty()==true)EmptyPlate("No saved trials on this device.")
            for(e in state.journal?.events.orEmpty())OutlinedButton(enabled=!busy,onClick={battleId=null;model.reopen(e.id)},modifier=Modifier.fillMaxWidth()){Text("${e.event.dt("entryStartsAt").take(10)} · ${e.commands.size} saved actions")}
        }
    }
}
