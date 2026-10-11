package gg.pixelkingdomwars.nativeclient.ui.phasee

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.*
import gg.pixelkingdomwars.nativeclient.ui.sheets.money.live.equipmentCraftReviewUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.money.live.equipmentRetainedSheetUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.money.live.equipmentWorkshopSheetUi
import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.network.fmtDur
import gg.pixelkingdomwars.nativeclient.network.fmtN
import gg.pixelkingdomwars.nativeclient.ordinaryequipment.EquipmentView
import gg.pixelkingdomwars.nativeclient.ordinaryequipment.equipmentResourceIds
import gg.pixelkingdomwars.nativeclient.ordinaryequipment.equipmentPaidDestinationSupports
import gg.pixelkingdomwars.nativeclient.starter.paidStarterRealmIds
import gg.pixelkingdomwars.nativeclient.ui.Palette
import gg.pixelkingdomwars.nativeclient.ui.chrome.*
import gg.pixelkingdomwars.nativeclient.ui.chrome.Button
import gg.pixelkingdomwars.nativeclient.ui.chrome.OutlinedButton
import gg.pixelkingdomwars.nativeclient.ui.chrome.AlertDialog
import gg.pixelkingdomwars.nativeclient.ui.chrome.TextButton
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import kotlinx.serialization.json.*

fun equipmentHasUnresolved(state:EquipmentState,base:String?)=state.journal?.pending.orEmpty().any{r->r.request["baseId"]==base?.let(::JsonPrimitive)&&when(r.kind){"craft"->r.response?.get("completion")==null||r.response["completion"]==JsonNull;"starter","advanced"->r.response?.get("return")==null||r.response["return"]==JsonNull;else->r.response==null}}
fun equipmentCanCraft(state:EquipmentState,base:String?,allowed:Boolean):Boolean{val view=state.view?:return false;return allowed&&!state.busy&&view.baseId==base&&view.acceptingJobs&&view.pendingJobs.isEmpty()&&!equipmentHasUnresolved(state,base)&&view.recipes.singleOrNull{it.output.itemId==state.item}?.inputs?.all{input->view.craftingStock.single{it.itemId==input.itemId}.available.toBigInteger()>=input.quantity.toBigInteger()}==true}
fun equipmentCanDepart(state:EquipmentState,base:String?,allowed:Boolean)=allowed&&!state.busy&&state.view?.baseId==base&&state.view?.equipmentStock?.singleOrNull{it.itemId==state.item}?.available?.toBigInteger()?.signum()==1&&!equipmentHasUnresolved(state,base)

internal fun equipmentPaidDestinationReason(state:EquipmentState,realm:String):String?=
 if(equipmentPaidDestinationSupports(state.item,state.resource,realm))null else "Main cargo matches your Lens material. Choose another material or destination."

private enum class EquipmentOverlay { TRIPS, ORIGINALS }
private fun equipmentLabel(value:String)=value.replace('_',' ').replace('-',' ').split(' ').joinToString(" "){it.replaceFirstChar(Char::uppercaseChar)}
internal fun equipmentRecordTitle(record:EquipmentRecord)=when(record.kind){
 "craft"->"Craft ${equipmentLabel(requireNotNull(record.recipe).output.itemId)}"
 "collect"->"Fleet collection"
 else->"${equipmentLabel(requireNotNull(record.preview).charterObject("fitting").charterText("itemId"))} expedition"
}
internal fun equipmentRecordComplete(record:EquipmentRecord)=record.response?.let{response->
 record.kind=="collect"||response[if(record.kind=="craft")"completion"else "return"] is JsonObject
}?:false
internal fun equipmentRecordPill(record:EquipmentRecord)=when{
 record.held->PaymentPill("CHECK NEEDED",PaymentTone.TROUBLE)
 equipmentRecordComplete(record)->PaymentPill("COMPLETE",PaymentTone.DONE)
 record.response?.get("status")==JsonPrimitive("accepted")->PaymentPill(if(record.kind=="craft")"CRAFTING"else "TRAVELLING",PaymentTone.SENT)
 record.discardedUnsent->PaymentPill("DRAFT CLOSED",PaymentTone.CLOSED)
 record.closedRefusal->PaymentPill("DECLINED",PaymentTone.CLOSED)
 record.closedUnknown->PaymentPill("CLOSED",PaymentTone.CLOSED)
 record.refusal!=null->PaymentPill("DECLINED",PaymentTone.TROUBLE)
 !record.attempted->PaymentPill("SAVED DRAFT",PaymentTone.OPEN)
 else->PaymentPill("CHECK NEEDED",PaymentTone.TROUBLE)
}

/** The registered owner keeps its lifecycle, exact saved confirmation and original recovery controls. */
@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable fun EquipmentScreen(model: EquipmentViewModel, selectedBase: String?, allowed: Boolean, back: () -> Unit,
    identity: StarterIdentity, generation: Long, contentIdentity: Any?, isCurrent: () -> Boolean, onHistory: () -> Unit) {
    val state by model.state.collectAsState()
    val running by model.busy.collectAsState()
    val notice by model.notice.collectAsState()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val ownerLifecycleState by lifecycle.currentStateFlow.collectAsState()
    val ownerActive = ownerLifecycleState.isAtLeast(Lifecycle.State.STARTED)
    val current by rememberUpdatedState { isCurrent() && lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED) }
    val openingView = remember(model, identity, selectedBase, generation, contentIdentity, ownerActive) { state.view }
    val renderedView = state.view
    val readCurrent = current() && ownerActive && renderedView != null && renderedView !== openingView
    val offset = remember(renderedView?.serverNow) {
        renderedView?.serverNow?.let { runCatching { Math.subtractExact(java.time.Instant.parse(it).toEpochMilli(), System.currentTimeMillis()) }.getOrNull() }
    }
    val idle = !running && !state.busy
    val host = LocalWorkshopOwnerHost.current
    var overlay by rememberSaveable(identity.wallet, selectedBase) { mutableStateOf<EquipmentOverlay?>(null) }
    var selectedTab by rememberSaveable(identity.wallet, selectedBase) { mutableStateOf(WorkshopTab.EQUIPMENT) }
    // Every refusal is a toast (designed chrome): the sheet keeps its frame and no line of old text sits under it.
    fun observe(action: () -> Unit) {
        if (current()) action() else Toasts.post("Return to the current Workshop before continuing.")
    }
    fun refreshedControls(): Boolean = current() && readCurrent && !model.busy.value && !model.state.value.busy &&
        model.state.value.error == null && model.notice.value?.error != true && model.state.value.view === renderedView &&
        model.state.value.journal?.identity == identity && model.state.value.view?.baseId == selectedBase
    fun choose(recipeId: String) {
        val recipe = renderedView?.recipes?.singleOrNull { it.recipeId == recipeId }
        if (!refreshedControls() || model.state.value.review != null || recipe == null) {
            Toasts.post("Wait for current tools and materials before choosing a recipe.")
            return
        }
        val item = recipe.output.itemId
        val resource = if (item == "survey_lens") model.state.value.resource ?: equipmentResourceIds.first() else null
        if (model.state.value.item != item || model.state.value.resource != resource) model.choose(item, resource)
    }
    fun craft(recipeId: String) {
        val value = model.state.value
        val recipe = value.view?.recipes?.singleOrNull { it.recipeId == recipeId && it.output.itemId == value.item }
        if (refreshedControls() && allowed && value.review == null && recipe != null && equipmentCanCraft(value, selectedBase, allowed)) {
            model.craft()
        } else Toasts.post("Current materials, recipe and kingdom are required before reviewing this craft.")
    }
    // The craft review's START sends exactly what the original confirmation's button sent, behind the same guards.
    fun confirmCraft() {
        val value = model.state.value
        val record = value.review
        if (record == null || equipmentCraftReviewUi(record, false) == null) {
            Toasts.post("Current materials, recipe and kingdom are required before reviewing this craft.")
            return
        }
        when {
            model.busy.value || value.busy -> Unit
            record.request["baseId"] != selectedBase?.let(::JsonPrimitive) -> Toasts.post("Select the original kingdom to confirm this request.")
            !current() -> Toasts.post("Return to the current Workshop before continuing.")
            !allowed -> Toasts.post("Orders are paused on this base")
            else -> model.confirm()
        }
    }
    // BACK keeps the saved draft. The owner's dismiss also drops its read, so a craft review re-reads (GET only) and the
    // sheet returns with that draft as its recovery row instead of an empty "Checking" frame.
    fun closeReview() {
        val craft = model.state.value.review?.let { equipmentCraftReviewUi(it, false) } != null
        model.dismiss()
        if (craft && current()) model.refresh()
    }
    val retained = remember(identity, selectedBase, generation, contentIdentity) { arrayOfNulls<WorkshopToolsUi>(1) }
    val fresh = equipmentWorkshopSheetUi(state, identity, selectedBase, current(), readCurrent, allowed,
        running, notice?.message, notice?.error == true, offset)
    fresh.tools?.let { retained[0] = it }
    val baseUi = equipmentRetainedSheetUi(fresh, retained[0], reading = !idle)
    val review = state.review
    val craftReview = review?.let { equipmentCraftReviewUi(it, sending = !idle) }
    val ui = (if (selectedTab == WorkshopTab.EQUIPMENT) baseUi else WorkshopSheetUi(
        baseUi.frame.copy(selectedTab = selectedTab), baseUi.header,
        observation = WorkshopObservationUi("Open this section from the Workshop on Home. Tools and original equipment requests remain here."),
        destinationsAvailable = false)).copy(review = craftReview)
    val openTrips = { observe { overlay = EquipmentOverlay.TRIPS } }
    BackHandlerAt(BackPriority.SCREEN) { model.dismiss(); back() }
    BackHandlerAt(BackPriority.CONFIRM, review != null) { closeReview() }
    WorkshopSheet(ui, WorkshopSheetActions(onClose = { model.dismiss(); back() },
        onTab = { tab ->
            if (craftReview != null) closeReview()
            if (tab == WorkshopTab.EQUIPMENT) observe { selectedTab = tab }
            else if (host != null) host.onTab(tab)
            else observe { selectedTab = tab }
        },
        // History opens this owner's original requests in place: checks, retries and archives live there (SPEC §5).
        onHistory = { observe { overlay = EquipmentOverlay.ORIGINALS } },
        onRetry = { observe { if (!model.busy.value && !model.state.value.busy && model.state.value.review == null) model.refresh()
            else Toasts.post("Finish the current read or review before checking again.") } },
        onCheckSaved = { key -> observe { overlay = EquipmentOverlay.ORIGINALS
            if (!model.busy.value && !model.state.value.busy && model.state.value.journal?.records?.any { it.key == key } == true) model.select(key) } },
        onReviewBack = ::closeReview, onReviewConfirm = ::confirmCraft,
        tools = WorkshopToolsActions(onSelectTool = ::choose, onCraft = ::craft, onGoLodge = openTrips, onOpenTrips = openTrips)),
        Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing))
    if (review != null && craftReview == null) {
        AlertDialog(onDismissRequest = model::dismiss, title = { Text("ORIGINAL EQUIPMENT REVIEW") }, text = {
            Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                EquipmentConfirmation(review, selectedBase, idle && allowed && current(), model, Modifier)
            }
        }, confirmButton = { TextButton(onClick = model::dismiss) { Text("BACK · KEEP DRAFT") } })
    } else if (overlay != null && review == null) {
        val close = { overlay = null }
        AlertDialog(onDismissRequest = close,
            title = { Text(if (overlay == EquipmentOverlay.TRIPS) "EQUIPMENT EXPEDITIONS" else "ORIGINAL EQUIPMENT REQUESTS") },
            text = {
                Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    notice?.let { Text(it.message, color = if (it.error) Palette.danger else Palette.muted) }
                    state.error?.let { Text(it, color = Palette.danger) }
                    if (overlay == EquipmentOverlay.TRIPS) {
                        EquipmentSelection(state, idle && current(), model)
                        EquipmentExpeditions(state, selectedBase, allowed && current(), idle && current(), model)
                    } else EquipmentHistory(state, selectedBase, allowed && current(), idle && current(), model)
                }
            }, confirmButton = { TextButton(onClick = close) { Text("CLOSE") } },
            // The registration's receipt list stays one tap away from the in-place originals.
            dismissButton = if (overlay == EquipmentOverlay.ORIGINALS) {
                { TextButton(onClick = { overlay = null; observe(onHistory) }) { Text("EQUIPMENT RECEIPTS") } }
            } else null)
    }
}

@Composable private fun EquipmentSelection(state:EquipmentState,idle:Boolean,model:EquipmentViewModel){
 var cargoOpen by remember{mutableStateOf(false)}
 EquipmentPanel("Choose your tool"){
  Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.spacedBy(8.dp)){
   OutlinedButton(onClick={model.choose("route_compass")},enabled=idle,modifier=Modifier.weight(1f).semantics{selected=state.item=="route_compass"},contentPadding=PaddingValues(horizontal=8.dp,vertical=10.dp)){
    Text("Route Compass",color=if(state.item=="route_compass")Palette.goldHi else Palette.text)
   }
   if(state.lensAvailable)Box(Modifier.weight(1f)){
    OutlinedButton(onClick={cargoOpen=true},enabled=idle,modifier=Modifier.fillMaxWidth().semantics{selected=state.item=="survey_lens"},contentPadding=PaddingValues(horizontal=8.dp,vertical=10.dp)){
     Text("Survey Lens ▾",color=if(state.item=="survey_lens")Palette.goldHi else Palette.text)
    }
    DropdownMenu(expanded=cargoOpen,onDismissRequest={cargoOpen=false}){
     equipmentResourceIds.forEach{resource->DropdownMenuItem(text={Text(equipmentLabel(resource))},onClick={cargoOpen=false;model.choose("survey_lens",resource)},enabled=idle)}
    }
   }
  }
  if(state.item=="survey_lens"){
   Text("Selected: Survey Lens · ${equipmentLabel(requireNotNull(state.resource))}",color=Palette.goldHi)
   Text("Swap part of your cargo for this common material. Total cargo and journey time stay the same.",color=Palette.muted)
  }else{
   Text("Selected: Route Compass",color=Palette.goldHi)
   Text("A faster return with less cargo. Compare each fitted route before departing.",color=Palette.muted)
  }
 }
}

@Composable private fun EquipmentExpeditions(state:EquipmentState,selectedBase:String?,allowed:Boolean,idle:Boolean,model:EquipmentViewModel){
 val canDepart=idle&&equipmentCanDepart(state,selectedBase,allowed)
 if(state.view?.baseId==selectedBase&&state.view?.equipmentStock?.singleOrNull{it.itemId==state.item}?.available=="0")Text("No selected tool is available. Craft one in the Workshop or wait for a travelling tool to return.",color=Palette.muted)
 state.starter?.takeIf{it.charterText("baseId")==selectedBase}?.let{starter->
  val installed=starter.charterOptional("installation")
  val ready=CharterGrammar.bool(starter.getValue("acceptingDepartures"))&&starter["flight"]==JsonNull&&starter["lodgeCompletedAt"]!=JsonNull&&installed!=null
  EquipmentPanel("Starter boat"){
   if(installed==null)Text("Install your Starter Boat before departing.")
   if(starter["lodgeCompletedAt"]==JsonNull)Text("Complete an Exploration Lodge to unlock departures.")
   if(!CharterGrammar.bool(starter.getValue("acceptingDepartures")))Text("New starter departures are paused.",color=Palette.muted)
   starter.charterOptional("flight")?.let{Text("Boat travelling · returns ${equipmentTime(it.charterText("returnsAt"))}",color=Palette.goldHi)}
   Text("Small introductory routes cannot use fittings. A Lens needs a second material different from the route’s main cargo.",color=Palette.muted)
   val routes=starter.getValue("routes").jsonArray
   if(routes.isEmpty())Text("No starter routes match this fitting. Try another tool or Lens material.")
   routes.forEach{value->val route=value.jsonObject
    EquipmentRouteCard(route){Button(onClick={model.trip("starter",requireNotNull(installed).charterText("installationId"),route)},enabled=canDepart&&ready,modifier=Modifier.fillMaxWidth()){Text("REVIEW DEPARTURE")}}
   }
   HorizontalDivider()
   var realmOpen by remember{mutableStateOf(false)}
   Box{
    OutlinedButton(onClick={realmOpen=true},enabled=idle,modifier=Modifier.fillMaxWidth()){Text("CHECK A PAID-REALM ROUTE ▾")}
    DropdownMenu(expanded=realmOpen,onDismissRequest={realmOpen=false}){
     paidStarterRealmIds.forEachIndexed{index,realm->
      val reason=equipmentPaidDestinationReason(state,realm)
      DropdownMenuItem(text={Column{Text(equipmentLabel(realm));if(reason!=null)Text(reason,style=MaterialTheme.typography.bodySmall,color=Palette.muted)}},onClick={realmOpen=false;model.paid(index.toString())},enabled=idle&&reason==null)
     }
    }
   }
   state.paid?.takeIf{it.charterText("baseId")==selectedBase&&CharterGrammar.number(it.getValue("realm")).toString()==state.paidRealm}?.let{paid->
    val route=paid.charterObject("route");val access=paid.charterObject("coverage").charterText("status")
    EquipmentRouteCard(route){
     Text(when(access){"covered"->"Destination access is active.";"blocked"->"An active permit is required for this destination.";else->"Destination access is unavailable."},color=Palette.muted)
     Button(onClick={model.trip("starter",requireNotNull(installed).charterText("installationId"),route,CharterGrammar.number(paid.getValue("realm")).toString())},enabled=canDepart&&ready&&CharterGrammar.bool(paid.getValue("acceptingDepartures"))&&access=="covered",modifier=Modifier.fillMaxWidth()){Text("REVIEW PAID-REALM DEPARTURE")}
    }
   }
  }
 }
 state.fleet?.takeIf{it.charterText("baseId")==selectedBase}?.let{fleet->
  val routes=state.routes?.takeIf{it.charterText("baseId")==selectedBase}
  val vehicles=fleet.getValue("vehicles").jsonArray
  Text("Advanced fleet",style=MaterialTheme.typography.titleLarge,color=Palette.goldHi)
  if(vehicles.isEmpty())Text("No advanced vehicles are installed in this kingdom.",color=Palette.muted)
  vehicles.forEach{v->val vehicle=v.jsonObject;val id=vehicle.charterText("installationId")
   val away=CharterGrammar.bool(vehicle.getValue("away"));val servicing=CharterGrammar.bool(vehicle.getValue("pendingService"))
   val ready=CharterGrammar.bool(fleet.getValue("acceptingNewActions"))&&!away&&!servicing&&CharterGrammar.number(vehicle.getValue("remainingUses"))>0
   EquipmentPanel(equipmentLabel(vehicle.charterText("family"))){
    Text("Tier ${vehicle["tier"]} · ${vehicle["remainingUses"]} uses left · ${if(away)"travelling"else if(servicing)"service pending"else "in port"}",color=Palette.muted)
    val previews=routes?.getValue("items")?.jsonArray?.map{it.jsonObject}?.singleOrNull{it.charterText("installationId")==id}?.getValue("previews")?.jsonArray
    if(previews.isNullOrEmpty())Text("No fitted routes available. Refresh or choose another fitting.",color=Palette.muted)
    previews?.forEach{value->val route=value.jsonObject
     EquipmentRouteCard(route){Button(onClick={model.trip("advanced",id,route)},enabled=canDepart&&ready,modifier=Modifier.fillMaxWidth()){Text("REVIEW DEPARTURE")}}
    }
   }
  }
  OutlinedButton(onClick={model.collect()},enabled=idle&&selectedBase!=null,modifier=Modifier.fillMaxWidth()){Text("COLLECT COMPLETED TRIPS")}
 }
 if(state.starter==null&&state.fleet==null)Text("Refresh to check fitted routes for this kingdom.",color=Palette.muted)
}

@Composable private fun EquipmentConfirmation(record:EquipmentRecord,selectedBase:String?,canConfirm:Boolean,model:EquipmentViewModel,modifier:Modifier){
 PaymentPlate(title=if(record.kind=="craft")"Review crafting"else "Review departure",modifier=modifier,art="ui_compass",
  details=listOf(PaymentDetail("Receiving kingdom",record.request.charterText("baseId")),PaymentDetail("Request",record.key)),
  footnote="The result stays with its receiving kingdom if ownership changes."){
  Text(equipmentRecordTitle(record),style=MaterialTheme.typography.titleLarge,color=Palette.goldHi)
  EquipmentSavedTerms(record)
  if(record.request["baseId"]!=selectedBase?.let(::JsonPrimitive))Text("Select the original kingdom to confirm this request.",color=Palette.muted)
  Button(onClick={model.confirm()},enabled=canConfirm&&record.request["baseId"]==selectedBase?.let(::JsonPrimitive),modifier=Modifier.fillMaxWidth()){
   Text(if(record.kind=="craft")"CRAFT WITH THESE MATERIALS"else "EQUIP & DISPATCH")
  }
 }
}

@Composable private fun EquipmentHistory(state:EquipmentState,selectedBase:String?,allowed:Boolean,idle:Boolean,model:EquipmentViewModel){
 Text("Saved requests",style=MaterialTheme.typography.titleLarge,color=Palette.goldHi)
 Text("Check a craft or trip after a lost reply. Your saved terms and receiving kingdom remain unchanged.",color=Palette.muted)
 OutlinedButton(onClick={model.check()},enabled=idle,modifier=Modifier.fillMaxWidth()){Text("CHECK SAVED REQUESTS")}
 state.selected?.let{record->
  val terminal=equipmentRecordComplete(record)
  PaymentPlate(title=equipmentRecordTitle(record),pill=equipmentRecordPill(record),
   details=listOf(PaymentDetail("Request",record.key),PaymentDetail("Receiving kingdom",record.request.charterText("baseId"))),
   footnote="Checking keeps the saved request. An uncertain outcome must be recovered before starting again."){
   if(record.request["baseId"]!=selectedBase?.let(::JsonPrimitive))Text("This request belongs to another kingdom. Its destination will not change.",color=Palette.muted)
   EquipmentSavedTerms(record)
   record.response?.get("receipt")?.takeUnless{it==JsonNull}?.jsonObject?.let{receipt->Text(if(record.kind=="craft")"Ready ${equipmentTime(receipt.charterText("readyAt"))}"else "Returns ${equipmentTime(receipt.charterText("returnsAt"))}")}
   if(terminal)Text("The server confirmed completion. Tools and cargo stay in the receiving kingdom.",color=Palette.success)
   else if(record.response==null||record.response["status"]==JsonPrimitive("unknown"))Text(if(record.attempted)"The outcome is not confirmed yet. Check before trying again."else "This draft has not been sent.",color=Palette.muted)
   record.refusal?.let{Text("Request declined: ${equipmentLabel(it.code)}. Check the saved result before archiving.",color=Palette.muted)}
   if(record.held)Text("A reply could not be verified. The saved request is preserved.",color=MaterialTheme.colorScheme.error)
   if(record.closedUnknown)Text("Closed on this device after the server had no record of this request.",color=Palette.muted)
   if(!record.discardedUnsent&&!record.closedRefusal&&!record.closedUnknown&&record.refusal==null&&(record.response==null||record.kind!="collect"&&record.response.charterText("status")=="unknown"))OutlinedButton(onClick={model.retry(record.key)},enabled=idle&&!record.held&&(allowed||record.kind=="collect"),modifier=Modifier.fillMaxWidth()){Text("RETRY SAVED REQUEST")}
   // Owner rule 2026-10-06: a sent original the server does not know may close after a fresh check, so it never blocks play forever.
   if(record.kind!="collect"&&record.response?.get("status")!=JsonPrimitive("accepted")&&state.journal?.pending?.any{it.key==record.key}==true)OutlinedButton(onClick={model.discard(record.key)},enabled=idle&&!record.held,modifier=Modifier.fillMaxWidth()){Text(if(record.refusal!=null)"CHECK & ARCHIVE DECLINED REQUEST"else if(record.attempted)"CHECK & CLOSE IF NOT FOUND"else "ARCHIVE UNSENT DRAFT")}
   if(terminal&&state.journal?.pending?.any{it.key==record.key}==true)OutlinedButton(onClick={model.archive(record.key)},enabled=idle&&!record.held,modifier=Modifier.fillMaxWidth()){Text("ARCHIVE COMPLETED REQUEST")}
  }
 }
 val records=state.journal?.records.orEmpty()
 if(records.isEmpty())Text("No saved crafts or expeditions yet.",color=Palette.muted)
 records.forEach{record->OutlinedButton(onClick={model.select(record.key)},enabled=idle,modifier=Modifier.fillMaxWidth().semantics{selected=state.selectedKey==record.key}){
  Column(Modifier.fillMaxWidth(),verticalArrangement=Arrangement.spacedBy(4.dp)){
   Text(equipmentRecordTitle(record))
   Text(equipmentRecordPill(record).label,style=MaterialTheme.typography.labelSmall,color=Palette.muted)
  }
 }}
}

@Composable private fun EquipmentSavedTerms(record:EquipmentRecord){
 record.recipe?.let{recipe->
  recipe.inputs.forEach{input->EquipmentValue(equipmentLabel(input.itemId),fmtN(input.quantity))}
  EquipmentValue("Produces","${fmtN(recipe.output.quantity)} ${equipmentLabel(recipe.output.itemId)}")
  EquipmentValue("Crafting time",fmtDur(recipe.durationSec))
  Text("Materials are consumed when crafting starts. The accepted job cannot be cancelled.",color=Palette.muted)
 }
 record.preview?.let{route->EquipmentRouteCard(route){Text("One ${equipmentLabel(route.charterObject("fitting").charterText("itemId"))} stays reserved until this trip returns.",color=Palette.muted)}}
}

@Composable private fun EquipmentPanel(title:String,content:@Composable ColumnScope.()->Unit){
 PixelPanel(Modifier.fillMaxWidth()){
  Column(Modifier.fillMaxWidth().padding(horizontal=12.dp,vertical=14.dp),verticalArrangement=Arrangement.spacedBy(10.dp)){
   Text(title,style=MaterialTheme.typography.titleLarge,color=Palette.goldHi)
   content()
  }
 }
}
@Composable private fun EquipmentStockAmount(label:String,amount:String,modifier:Modifier){
 Column(modifier,verticalArrangement=Arrangement.spacedBy(2.dp)){
  Text(fmtN(amount),style=MaterialTheme.typography.titleLarge,color=Palette.gold)
  Text(label,style=MaterialTheme.typography.bodySmall,color=Palette.muted)
 }
}
@Composable private fun EquipmentValue(label:String,value:String,warning:Boolean=false){
 Column(Modifier.fillMaxWidth(),verticalArrangement=Arrangement.spacedBy(2.dp)){
  Text(label,style=MaterialTheme.typography.labelMedium,color=Palette.muted)
  Text(value,color=if(warning)Palette.danger else Palette.text)
 }
}
@Composable private fun EquipmentRouteCard(route:JsonObject,actions:@Composable ()->Unit){
 Column(Modifier.fillMaxWidth().padding(vertical=8.dp),verticalArrangement=Arrangement.spacedBy(8.dp)){
  HorizontalDivider()
  Text(equipmentLabel(route.charterText("routeId")),style=MaterialTheme.typography.titleMedium,color=Palette.goldHi)
  Row(verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.spacedBy(6.dp)){
   GameArt("timer",Modifier.size(20.dp))
   Text(fmtDur(CharterGrammar.number(route.getValue("durationSec"))),style=MaterialTheme.typography.titleMedium)
  }
  EquipmentCargo(route)
  route["secondaryOutput"]?.takeUnless{it==JsonNull}?.jsonObject?.let{EquipmentCargo(it)}
  route["fitting"]?.jsonObject?.let{fitting->Text("Without fitting: ${fmtDur(CharterGrammar.number(fitting.getValue("originalDurationSec")))} · ${fmtN(fitting.charterText("originalGrossQuantity"))} gross cargo",style=MaterialTheme.typography.bodySmall,color=Palette.muted)}
  route["supplies"]?.jsonArray?.let{supplies->Text("Supplies: "+supplies.joinToString{val s=it.jsonObject;"${fmtN(s.charterText("quantity"))} ${equipmentLabel(s.charterText("resourceId"))}"},color=Palette.muted)}
  actions()
 }
}
@Composable private fun EquipmentCargo(cargo:JsonObject){
 Text("${fmtN(cargo.charterText("netQuantity"))} ${equipmentLabel(cargo.charterText("resourceId"))} delivered",style=MaterialTheme.typography.titleSmall)
 Text("${fmtN(cargo.charterText("grossQuantity"))} gross · ${fmtN(cargo.charterText("islandPoolQuantity"))} island tax",style=MaterialTheme.typography.bodySmall,color=Palette.muted)
}
private fun equipmentTime(iso:String)=runCatching{java.time.Instant.parse(iso).atZone(java.time.ZoneId.systemDefault()).format(java.time.format.DateTimeFormatter.ofPattern("d MMM, HH:mm:ss z"))}.getOrDefault(iso)
