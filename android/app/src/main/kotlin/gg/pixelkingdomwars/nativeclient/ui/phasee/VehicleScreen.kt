package gg.pixelkingdomwars.nativeclient.ui.phasee

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
import gg.pixelkingdomwars.nativeclient.vehicle.*
import gg.pixelkingdomwars.nativeclient.model.marketSol
import gg.pixelkingdomwars.nativeclient.ui.Palette
import gg.pixelkingdomwars.nativeclient.ui.chrome.GamePage
import gg.pixelkingdomwars.nativeclient.ui.chrome.PaymentPlate
import gg.pixelkingdomwars.nativeclient.ui.chrome.PaymentDetail
import gg.pixelkingdomwars.nativeclient.ui.chrome.PaymentTone
import gg.pixelkingdomwars.nativeclient.ui.economy.DisclosurePlate
import gg.pixelkingdomwars.nativeclient.ui.economy.EmptyPlate
import gg.pixelkingdomwars.nativeclient.ui.economy.PlateTabs
import gg.pixelkingdomwars.nativeclient.ui.economy.TitledPlate
import gg.pixelkingdomwars.nativeclient.network.fmtDur
import gg.pixelkingdomwars.nativeclient.network.fmtN
import gg.pixelkingdomwars.nativeclient.ui.chrome.OutlinedButton
import gg.pixelkingdomwars.nativeclient.ui.chrome.Button
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import gg.pixelkingdomwars.nativeclient.ui.security.SensitiveMfaDialog
import kotlinx.serialization.json.*

data class VehicleControls(val prepare:Boolean,val review:Boolean,val approve:Boolean,val upload:Boolean,val deliver:Boolean,val recover:Boolean,val archive:Boolean)
fun vehicleControls(state:VehicleState,allowed:Boolean,configured:Boolean,running:Boolean=false):VehicleControls {
 val r=state.selected;val v=r?.response;val burn=r?.kind in listOf("installation","service");val record=if(burn)v?.charterObject("record") else null
 val terminal=v!=null&&when(r?.kind){"installation","service"->VehicleProtocol.terminal(v)!=null;"expedition"->v.charterOptional("return")!=null;"collect"->true;else->false}
 val idle=!running&&!state.busy;val safe=idle&&r!=null&&!r.held;val fresh=safe&&allowed&&configured&&burn&&!terminal&&record!=null
 val wallet="wallet" in r?.attempts.orEmpty();val signed=record?.charterOptional("signed")!=null;val prepared=record?.charterOptional("preparation")!=null
 return VehicleControls(fresh&&!prepared,fresh&&prepared&&!wallet&&!signed,fresh&&prepared&&state.review!=null&&!wallet&&!signed,
  safe&&burn&&!terminal&&r?.signed!=null&&!signed,fresh&&signed,idle&&burn&&v!=null&&!terminal,safe&&terminal&&state.journal?.pending?.any{it.id==r?.id}==true)
}
@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable fun VehicleScreen(model:VehicleViewModel,allowed:Boolean,configured:Boolean,selectedBase:String?,berths:List<String>,back:()->Unit,policy:VehiclePolicy?=null,routeArt:@Composable (OrdinaryRouteCrop)->Unit={Text("Island artwork is unavailable in this content pack.",color=Palette.muted)},initialPage:String="fleet") {
    val state by model.state.collectAsState();val running by model.busy.collectAsState();val notice by model.notice.collectAsState();val idle=!state.busy&&!running
    val controls=vehicleControls(state,allowed,configured,running);val wallet=model.wallet;val mfa=wallet?.mfa?.collectAsState()?.value
    var asset by rememberSaveable(selectedBase){mutableStateOf<String?>(null)};var berth by rememberSaveable(selectedBase){mutableStateOf<String?>(null)}
    var page by rememberSaveable(initialPage) { mutableStateOf(initialPage.takeIf { it in setOf("fleet","craft") } ?: "fleet") }
    var ownedOpen by rememberSaveable(selectedBase) { mutableStateOf(false) }
    val owned=state.assets?.getValue("items")?.jsonArray?.map{it.jsonObject.charterObject("identity")}
    val chosenAsset=owned?.singleOrNull{it.charterText("assetId")==asset}
    val noticeLocation=remember { BringIntoViewRequester() };val originalLocation=remember { BringIntoViewRequester() }
    LaunchedEffect(notice,state.error) { if(notice?.error==true||state.error!=null)noticeLocation.bringIntoView() }
    LaunchedEffect(state.selectedId) { if(state.selectedId!=null)originalLocation.bringIntoView() }
    BackHandlerAt(BackPriority.SCREEN){model.dismiss();back()};BackHandlerAt(BackPriority.CONFIRM,mfa!=null){mfa?.let{wallet?.cancelMfa(it)}}
    LaunchedEffect(allowed,configured,selectedBase){model.dismiss()}
    GamePage("VEHICLES & EXPEDITIONS",{model.dismiss();back()}) {
        PaymentPlate("YOUR ADVANCED FLEET",details=listOfNotNull(selectedBase?.let{PaymentDetail("Current kingdom",it)})) {
            Text("Install a vehicle, send it on expeditions, or service an existing installation.")
            if(selectedBase==null)Text("Select a kingdom to view its berths and fleet.",color=Palette.goldHi)
            if(!configured)Text("Vehicle burn approval is unavailable. Existing fleet and saved operations remain accessible.",color=Palette.goldHi)
            if(!allowed)Text("New actions are paused. Check saved originals to recover their outcomes.",color=Palette.goldHi)
        }
        if(!idle)LinearProgressIndicator(Modifier.fillMaxWidth())
        if(!state.loaded)EmptyPlate("Loading vehicle activity and saved originals…")
        Column(Modifier.bringIntoViewRequester(noticeLocation).semantics { liveRegion=LiveRegionMode.Polite }) {
            notice?.let{Text(it.message,color=if(it.error)Palette.danger else Palette.text)}
            state.error?.let{Text(it,color=Palette.danger)}
        }
        state.selected?.let { r->
            PaymentPlate("ORIGINAL ${r.kind.uppercase()}",modifier=Modifier.bringIntoViewRequester(originalLocation),pill=vehicleRecordPill(r),
                details=vehicleOriginalDetails(r),footnote="Closing this page keeps your original request, destination and approvals.") {
                if(r.held)Text("An original response needs verification. Keep this request and check its outcome.",color=Palette.goldHi)
                if("wallet" in r.attempts&&r.signed==null&&vehicleRecordPill(r).tone!=PaymentTone.DONE)Text("Wallet approval may have completed. Another prompt is blocked; recover this original.",color=Palette.goldHi)
                vehicleOriginalBase(r)?.let { base->Text(if(base==selectedBase)"Saved destination: currently selected kingdom." else "Saved destination: an earlier kingdom. Current selection does not move this operation.",color=Palette.muted) }
                r.response?.let { v->when(r.kind) {
                    "installation","service" -> {
                        val original=VehicleProtocol.original(v);val identity=original.charterObject("identity")
                        val terminal=VehicleProtocol.terminal(v)
                        Text("${islandShareResource(identity.charterText("family"))} · tier ${identity["tier"]}",style=MaterialTheme.typography.titleLarge,color=Palette.goldHi)
                        Text("Status: ${v.charterObject("record").charterText("status").replace('_',' ')}",color=Palette.muted)
                        Text(if(terminal==null)"Approval permanently burns this original asset. Its committed kingdom and berth stay fixed, including after a kingdom sale." else "The original burn and destination are confirmed by the saved receipt.")
                        if(r.kind=="service") {
                            val effect=VehiclePolicy.from(r.policy).serviceEffect(original.charterObject("state"))
                            Text("${if(terminal==null)"On completion" else "Applied result"}: ${if(effect.charterText("operation")=="upgrade")"tier upgrade" else "use restoration"} · tier ${effect["tierAfter"]} · ${effect["remainingUses"]} uses remaining",Modifier.fillMaxWidth(),style=MaterialTheme.typography.titleMedium,color=Palette.goldHi)
                        }
                        if(terminal==null) {
                            state.review?.charterOptional("observation")?.let { Text("${marketSol(it.charterText("networkFeeLamports"))} SOL · reviewed network fee",Modifier.fillMaxWidth(),style=MaterialTheme.typography.headlineSmall,color=Palette.goldHi) }
                                ?: Text("Review this original burn to obtain its exact current network fee before approval.",color=Palette.muted)
                        }
                        vehicleFinalFee(r)?.let { Text("$it · finalized network fee",Modifier.fillMaxWidth(),style=MaterialTheme.typography.titleMedium,color=Palette.goldHi) }
                        v.charterOptional("burnReceipt")?.let { Text("${marketSol(it.charterText("assetRefundLamports"))} SOL · asset rent returned",color=Palette.muted) }
                    }
                    "expedition" -> {
                        v.charterOptional("receipt")?.let { Text("Scheduled return: ${islandShareTime(it.charterText("returnsAt"))}",color=Palette.goldHi) }
                        val returned=v.charterOptional("return")
                        if(returned!=null)Text("Returned ${islandShareTime(returned.charterText("returnedAt"))} · ${returned["completedTotal"]} completed uses",color=Palette.goldHi)
                        else Text("A scheduled return time is not a completed delivery. Check the original or collect completed expeditions.",color=Palette.muted)
                        (v.charterOptional("receipt")?.charterObject("route")?:r.preview)?.let { route->
                            Text("ORIGINAL CARGO & PROVISIONS",style=MaterialTheme.typography.labelLarge,color=Palette.goldHi)
                            VehicleRouteAmounts(route)
                        }
                    }
                    "collect" -> Text("Collected ${v["returned"]} completed returns. Individual expedition receipts preserve each original result.")
                } }
                if(vehicleRetryable(r))OutlinedButton(onClick={model.retry(r.id)},enabled=idle&&(allowed||r.kind=="collect")&&!r.held,modifier=Modifier.fillMaxWidth()){Text("RETRY SAME ORIGINAL REQUEST")}
                if(vehicleClosableUnknown(r))OutlinedButton(onClick={model.closeUnknown()},enabled=idle&&!r.held,modifier=Modifier.fillMaxWidth()){Text("CLOSE IF THE SERVER HAS NO RECORD")}
                if(r.closedUnknown!=null)Text("Closed on this device: the server had no record of this request.",color=Palette.muted)
                if(controls.prepare)Button(onClick={model.command("prepare")},modifier=Modifier.fillMaxWidth()){Text("PREPARE ORIGINAL BURN")}
                if(controls.review)Button(onClick={model.review()},modifier=Modifier.fillMaxWidth()){Text("REVIEW ORIGINAL BURN & FEE")}
                if(controls.approve)Button(onClick={model.approve()},modifier=Modifier.fillMaxWidth()){Text("APPROVE ORIGINAL BURN")}
                if(controls.upload)Button(onClick={model.upload()},modifier=Modifier.fillMaxWidth()){Text("SAVE EXISTING WALLET APPROVAL")}
                if(controls.deliver)Button(onClick={model.deliver()},modifier=Modifier.fillMaxWidth()){Text("DELIVER ORIGINAL SIGNED BURN")}
                if(controls.recover)OutlinedButton(onClick={model.command("recover")},modifier=Modifier.fillMaxWidth()){Text("RECOVER ORIGINAL BURN OUTCOME")}
                if(controls.archive)OutlinedButton(onClick={model.archive()},modifier=Modifier.fillMaxWidth()){Text("ARCHIVE VERIFIED ORIGINAL")}
            }
        }
        OutlinedButton(onClick={model.check()},enabled=idle,modifier=Modifier.fillMaxWidth()){Text("RECOVER SAVED ORIGINALS")}
        PlateTabs(listOf("fleet" to "FLEET","craft" to "CRAFT","install" to "INSTALL","history" to "HISTORY"),page,onSelect={page=it})
        if(page=="craft")VehicleCraftPanel(model,selectedBase,policy?.tiers.orEmpty())
        if(page!="history"&&page!="craft") {
            DisclosurePlate(if(chosenAsset==null)"CHOOSE AN OWNED ASSET" else "SELECTED ASSET · ${islandShareResource(chosenAsset.charterText("family"))}",ownedOpen,{ownedOpen=!ownedOpen}) {
                Text("This is the asset to burn for installation or service. A saved operation always keeps its own original asset.",color=Palette.muted,style=MaterialTheme.typography.bodySmall)
                OutlinedButton(onClick={model.assets()},enabled=idle,modifier=Modifier.fillMaxWidth()){Text("CHECK OWNED VEHICLE ASSETS")}
                if(owned==null)Text("Check owned assets to load current choices.",color=Palette.muted)
                else if(owned.isEmpty())EmptyPlate("No owned vehicle assets on this page.")
                else Text("${owned.size} assets on this page",color=Palette.muted)
                owned?.forEach { identity->val id=identity.charterText("assetId")
                    OutlinedButton(onClick={asset=id},enabled=idle,modifier=Modifier.fillMaxWidth().semantics { selected=asset==id }) {
                        Text((if(asset==id)"Selected · " else "")+islandShareResource(identity.charterText("family"))+" · tier ${identity["tier"]}")
                    }
                    if(asset==id)PaymentPlate("SELECTED ASSET",details=listOf(PaymentDetail("Asset",id),PaymentDetail("Collection",identity.charterText("collection")))) {
                        Text("${islandShareResource(identity.charterText("family"))} · tier ${identity["tier"]}",color=Palette.goldHi)
                        state.assets?.getValue("items")?.jsonArray?.map{it.jsonObject}?.singleOrNull{it.charterObject("identity").charterText("assetId")==id}?.let{Text(vehicleCandidateSource(it),color=Palette.muted)}
                    }
                }
                state.assets?.get("nextCursor")?.takeUnless{it==JsonNull}?.let{cursor->OutlinedButton(onClick={model.assets(CharterGrammar.text(cursor))},enabled=idle){Text("MORE OWNED ASSETS")}}
            }
            if(asset!=null&&chosenAsset==null)Text("The selected asset is not on this discovery page. Refresh or return to its page to verify service eligibility.",color=Palette.goldHi)
        }
        if(page=="install")TitledPlate("INSTALL IN THE SELECTED KINGDOM",gold=true) {
            Text("Installation permanently burns the selected vehicle asset. The server verifies ownership and an eligible vacant berth before accepting the reservation.")
            Text("${berths.size} empty berths in this kingdom",color=Palette.muted)
            if(berths.isEmpty())EmptyPlate("An empty Berth is required. Place a new Berth on your base, then reserve here.")
            LaunchedEffect(berths){if(berth !in berths)berth=berths.singleOrNull()}
            berths.forEachIndexed { index,id->OutlinedButton(onClick={berth=id},enabled=idle,modifier=Modifier.fillMaxWidth().semantics { selected=berth==id }){Text((if(berth==id)"SELECTED · " else "")+"BERTH ${index+1}")} }
            berth?.let { PaymentPlate("INSTALLATION DESTINATION",details=listOfNotNull(selectedBase?.let{PaymentDetail("Selected kingdom",it)},PaymentDetail("Selected berth",it),asset?.let{PaymentDetail("Selected asset",it)})) {
                Text("${chosenAsset?.let { identity->islandShareResource(identity.charterText("family"))+" · tier ${identity["tier"]}" }?:"Choose an owned vehicle asset"}",color=Palette.goldHi)
                Text("The accepted reservation fixes this kingdom, berth and asset. Network fees are reviewed separately before wallet approval.",style=MaterialTheme.typography.bodySmall,color=Palette.muted)
            } }
            Button(onClick={model.reserve(requireNotNull(selectedBase),requireNotNull(berth),requireNotNull(asset))},enabled=idle&&allowed&&configured&&selectedBase!=null&&asset!=null&&berth in berths,modifier=Modifier.fillMaxWidth()){Text("RESERVE THIS INSTALLATION")}
        }
        if(page=="fleet") {
            TitledPlate("INSTALLED FLEET",gold=true) {
                Text("Routes and services below belong to the currently selected kingdom.",color=Palette.muted)
                OutlinedButton(onClick={selectedBase?.let{model.fleet(it)}},enabled=idle&&selectedBase!=null,modifier=Modifier.fillMaxWidth()){Text("CHECK EXISTING FLEET & ROUTES")}
                Button(onClick={selectedBase?.let{model.collect(it)}},enabled=idle&&selectedBase!=null,modifier=Modifier.fillMaxWidth()){Text("COLLECT COMPLETED EXPEDITIONS")}
            }
            val fleet=state.fleet?.takeIf{it.charterText("baseId")==selectedBase}
            if(fleet==null)EmptyPlate("Check the selected kingdom’s fleet to load installed vehicles and route previews.")
            else if(fleet.getValue("vehicles").jsonArray.isEmpty())EmptyPlate("No advanced vehicles are installed in this kingdom. Open Install to reserve one.")
            fleet?.let { current->current.getValue("vehicles").jsonArray.forEach { raw->
                val row=raw.jsonObject;val id=row.charterText("installationId");val available=CharterGrammar.bool(current.getValue("acceptingNewActions"))&&!CharterGrammar.bool(row.getValue("away"))&&!CharterGrammar.bool(row.getValue("pendingService"))
                var serviceOpen by rememberSaveable(id) { mutableStateOf(false) }
                PaymentPlate(islandShareResource(row.charterText("family")).uppercase(),details=listOf(PaymentDetail("Installed vehicle",id),PaymentDetail("Original berth",row.charterText("berthId")))) {
                    Text("Tier ${row["tier"]} · ${row["remainingUses"]} uses remaining",style=MaterialTheme.typography.titleLarge,color=Palette.goldHi)
                    Text(if(CharterGrammar.bool(row.getValue("away")))"Away on expedition" else if(CharterGrammar.bool(row.getValue("pendingService")))"Original service pending" else "At berth",color=Palette.muted)
                    if(!CharterGrammar.bool(current.getValue("acceptingNewActions")))Text("This kingdom’s new vehicle actions are paused.",color=Palette.goldHi)
                    val previews=state.routes?.takeIf{it.charterText("baseId")==selectedBase}?.getValue("items")?.jsonArray?.map{it.jsonObject}?.singleOrNull{it.charterText("installationId")==id}?.getValue("previews")?.jsonArray?.map{it.jsonObject}.orEmpty()
                    val catalogue=policy?.ordinaryRoutes
                    if(catalogue!=null)OrdinaryRouteCatalogue(catalogue,CharterGrammar.number(row.getValue("tier")),previews,idle&&allowed&&available&&CharterGrammar.number(row.getValue("remainingUses"))>0,routeArt){route->model.dispatch(requireNotNull(selectedBase),id,route.charterText("routeId"),CharterGrammar.number(route.getValue("policyVersion")))}
                    else {
                        if(previews.isEmpty())Text("No route preview is available. Check fleet and routes again.",color=Palette.muted)
                        previews.forEach { route->
                            TitledPlate(islandShareResource(route.charterText("routeId").replace('-','_'))) {
                                VehicleRouteAmounts(route)
                                Button(onClick={model.dispatch(requireNotNull(selectedBase),id,route.charterText("routeId"),CharterGrammar.number(route.getValue("policyVersion")))},enabled=idle&&allowed&&available&&CharterGrammar.number(row.getValue("remainingUses"))>0,modifier=Modifier.fillMaxWidth()){Text("DISPATCH THIS ROUTE")}
                            }
                        }
                    }
                    DisclosurePlate("UPGRADE & RESTORE USES",serviceOpen,{serviceOpen=!serviceOpen}) {
                        Text("Burn one owned asset matching this vehicle’s current family and tier. Service keeps this installed vehicle and berth.",style=MaterialTheme.typography.bodySmall,color=Palette.muted)
                        for(op in listOf("upgrade","restore_uses")) {
                            val choice=vehicleServiceChoice(row,chosenAsset,policy,op)
                            Text(choice.reason,color=if(choice.allowed)Palette.muted else Palette.goldHi,style=MaterialTheme.typography.bodySmall)
                            Button(onClick={model.service(requireNotNull(selectedBase),id,requireNotNull(asset),op)},enabled=idle&&allowed&&configured&&available&&asset!=null&&choice.allowed,modifier=Modifier.fillMaxWidth()){Text(if(op=="upgrade")"RESERVE TIER UPGRADE" else "RESERVE USE RESTORATION")}
                        }
                    }
                }
            } }
        }
        if(page=="history")TitledPlate("SAVED OPERATIONS & ACTIVITY") {
            Text("Open an original to recover its exact asset, destination, approval or expedition receipt.",color=Palette.muted)
            OutlinedButton(onClick={model.refresh()},enabled=idle,modifier=Modifier.fillMaxWidth()){Text("CHECK VEHICLE HISTORY")}
            if(state.activity==null&&state.loaded)Text("Activity is unavailable. Saved records remain below.",color=Palette.muted)
            if(state.activity?.getValue("items")?.jsonArray?.isEmpty()==true)Text("No vehicle activity on this page.",color=Palette.muted)
            state.activity?.getValue("items")?.jsonArray?.forEach { raw->val item=raw.jsonObject
                OutlinedButton(onClick={model.history(item)},enabled=idle,modifier=Modifier.fillMaxWidth()){Text("${islandShareResource(item.charterText("kind"))} · ${item.charterText("status").replace('_',' ')}")}
            }
            state.activity?.get("nextCursor")?.takeUnless{it==JsonNull}?.let{cursor->OutlinedButton(onClick={model.refresh(CharterGrammar.text(cursor))},enabled=idle){Text("MORE HISTORY")}}
            Text("SAVED ON THIS DEVICE",style=MaterialTheme.typography.labelLarge,color=Palette.goldHi)
            if(state.journal?.records?.isEmpty()==true)EmptyPlate("No saved vehicle operations on this device.")
            state.journal?.records?.forEach { r->OutlinedButton(onClick={model.select(r.id)},enabled=idle,modifier=Modifier.fillMaxWidth()){Text("${islandShareResource(r.kind)} · ${vehicleRecordPill(r).label.lowercase()}")} }
        }
    }
    if(mfa!=null)SensitiveMfaDialog(mfa,submit={wallet.submitMfa(mfa,it)},cancelRequest={wallet.cancelMfa(mfa)})
}

@Composable private fun VehicleRouteAmounts(route:JsonObject) {
    Text("Duration: ${fmtDur(CharterGrammar.number(route.getValue("durationSec")))}",color=Palette.goldHi)
    vehicleCargoRows(route).forEach { row->Text("${row.label}: ${row.value}",Modifier.fillMaxWidth(),style=MaterialTheme.typography.bodySmall) }
    Text("Provisions: "+route.getValue("supplies").jsonArray.joinToString { val s=it.jsonObject;"${fmtN(s.charterText("quantity"))} ${islandShareResource(s.charterText("resourceId"))}" },color=Palette.muted,style=MaterialTheme.typography.bodySmall)
}
