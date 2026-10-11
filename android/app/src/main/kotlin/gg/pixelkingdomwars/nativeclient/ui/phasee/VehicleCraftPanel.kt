package gg.pixelkingdomwars.nativeclient.ui.phasee

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.*
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.data.VehicleCraftSelection
import gg.pixelkingdomwars.nativeclient.model.marketSol
import gg.pixelkingdomwars.nativeclient.ui.Palette
import gg.pixelkingdomwars.nativeclient.ui.chrome.OutlinedButton
import gg.pixelkingdomwars.nativeclient.ui.chrome.PaymentDetail
import gg.pixelkingdomwars.nativeclient.ui.chrome.PaymentPlate
import gg.pixelkingdomwars.nativeclient.ui.economy.EmptyPlate
import gg.pixelkingdomwars.nativeclient.ui.economy.TitledPlate
import gg.pixelkingdomwars.nativeclient.vehicle.VehicleCraftProtocol
import kotlinx.serialization.json.*

fun vehicleCraftStatus(status:String)=when(status){
    "held"->"MATERIALS HELD"
    "paid_loss"->"UNSUCCESSFUL · MATERIALS CONSUMED"
    "won_unminted"->"WON · NFT MINT PENDING"
    "minted"->"NFT MINT CONFIRMED"
    else->error("Unknown crafting status")
}
fun vehicleCandidateSource(item:JsonObject)=when(item.charterObject("provenance").charterText("kind")){
    "finalized_issuance"->"Finalized original mint verified. Current ownership is checked separately."
    "owner_attested"->"Historical owner-attested registry. This entry does not prove its original mint."
    else->error("Unknown vehicle provenance")
}

/** Existing admitted game plates only; no invented vehicle artwork or signing. */
@Composable fun VehicleCraftPanel(model:VehicleViewModel,selectedBase:String?,tiers:List<Long>){
    val flow=model.craftState
    if(flow==null){EmptyPlate("Vehicle crafting history is unavailable.");return}
    val state by flow.collectAsState();val running by model.busy.collectAsState();val idle=!state.busy&&!running
    var family by rememberSaveable{mutableStateOf(VehicleCraftProtocol.families.first())}
    var tier by rememberSaveable{mutableStateOf<Long?>(null)}
    var familyOpen by remember{mutableStateOf(false)}
    val selectedTier=tier?.takeIf{it in tiers}?:tiers.firstOrNull()
    LaunchedEffect(selectedBase,family,selectedTier){model.craftSelection(if(selectedBase!=null&&selectedTier!=null)VehicleCraftSelection(selectedBase,family,selectedTier)else null)}
    LaunchedEffect(model){model.craftForeground()}
    TitledPlate("VEHICLE RECIPE PREVIEW",gold=true){
        Text("Choose a family and target tier to check the selected kingdom's ingredients. A preview does not hold or spend anything.")
        Box{
            OutlinedButton(onClick={familyOpen=true},enabled=idle,modifier=Modifier.fillMaxWidth().heightIn(min=48.dp)){Text(islandShareResource(family))}
            DropdownMenu(expanded=familyOpen,onDismissRequest={familyOpen=false}){VehicleCraftProtocol.families.forEach{value->DropdownMenuItem(text={Text(islandShareResource(value))},onClick={family=value;familyOpen=false})}}
        }
        Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.spacedBy(4.dp)){tiers.forEach{value->OutlinedButton(onClick={tier=value},enabled=idle,modifier=Modifier.weight(1f).heightIn(min=48.dp).semantics{selected=value==selectedTier}){Text("Tier $value")}}}
        if(selectedBase==null)Text("Select an owned kingdom to check available ingredients.",color=Palette.goldHi)
        if(tiers.isEmpty())Text("Vehicle recipe selection needs the current content catalogue.",color=Palette.goldHi)
        OutlinedButton(onClick={model.craftQuote()},enabled=idle&&selectedBase!=null&&selectedTier!=null,modifier=Modifier.fillMaxWidth().heightIn(min=48.dp)){Text("CHECK INGREDIENTS")}
        Text("New vehicle crafting is unavailable. Original outcomes can still be checked below.",color=Palette.goldHi)
    }
    if(state.busy)LinearProgressIndicator(Modifier.fillMaxWidth())
    state.error?.let{Text(it,Modifier.semantics{liveRegion=LiveRegionMode.Polite},color=Palette.goldHi)}
    state.quote?.takeIf{it.charterText("baseId")==selectedBase&&it.charterObject("recipe").charterText("family")==family&&CharterGrammar.number(it.charterObject("recipe").getValue("tier"))==selectedTier}?.let{quote->
        val recipe=quote.charterObject("recipe")
        PaymentPlate("${islandShareResource(family).uppercase()} · TIER $selectedTier",details=listOf(
            PaymentDetail("Success chance",CharterGrammar.number(recipe.getValue("oddsBps")).toBigDecimal().movePointLeft(2).stripTrailingZeros().toPlainString()+"%"),
            PaymentDetail("Application fee",marketSol(quote.charterText("applicationFeeLamports"))+" SOL"))) {
            Text("Oracle, account rent and network costs are not quoted. The application fee is not a complete total.",color=Palette.muted)
            Text("Ingredients last checked ${islandShareTime(quote.charterText("serverNow"))}.",color=Palette.muted)
            Text("An ordinary unsuccessful result consumes its original materials. A pending result stays held.",color=Palette.muted)
        }
        quote.getValue("ingredients").jsonArray.forEach{value->val input=value.jsonObject
            val missing=(CharterGrammar.amount(input.getValue("required"))-CharterGrammar.amount(input.getValue("available"))).max(java.math.BigInteger.ZERO)
            PaymentPlate(islandShareResource(input.charterText("itemId")).uppercase(),details=listOf(
                PaymentDetail("Required",input.charterText("required")),PaymentDetail("Available",input.charterText("available")),PaymentDetail("Held in original crafting",input.charterText("held")))){
                Text(if(missing.signum()>0)"Missing $missing" else "Enough available",color=if(missing.signum()>0)Palette.goldHi else Palette.muted)
            }
        }
    }
    TitledPlate("ORIGINAL CRAFTING HISTORY",gold=true){
        Text("Saved outcomes keep their original kingdom, materials and selected vehicle. Changing kingdoms cannot move them.",color=Palette.muted)
        OutlinedButton(onClick={model.craftHistory()},enabled=idle,modifier=Modifier.fillMaxWidth().heightIn(min=48.dp)){Text("REFRESH ORIGINAL HISTORY")}
        if(!state.loaded)Text("Loading saved originals…",color=Palette.muted)
        else if(state.records.isEmpty())EmptyPlate("No original crafting records have been loaded.")
        state.records.sortedByDescending{it.charterText("reservedAt")}.forEach{record->
            val identity=record.charterObject("identity")
            PaymentPlate("${islandShareResource(identity.charterText("family")).uppercase()} · TIER ${identity["tier"]}",details=listOf(
                PaymentDetail("Status",vehicleCraftStatus(record.charterText("status"))),PaymentDetail("Original kingdom",record.charterText("baseId")),
                PaymentDetail("Reserved",islandShareTime(record.charterText("reservedAt"))))) {
                record.charterObject("recipe").getValue("inputs").jsonArray.forEach{v->val input=v.jsonObject;Text("${islandShareResource(input.charterText("itemId"))} · ${input.charterText("quantity")}")}
                if(record.charterText("status")=="minted")Text("Check owned assets in INSTALL to verify current ownership and choose a berth.",color=Palette.goldHi)
                OutlinedButton(onClick={model.craftRecover(record.charterText("idempotencyKey"))},enabled=idle,modifier=Modifier.fillMaxWidth().heightIn(min=48.dp)){Text("CHECK ORIGINAL OUTCOME")}
            }
        }
        state.nextCursor?.let{cursor->OutlinedButton(onClick={model.craftHistory(cursor)},enabled=idle,modifier=Modifier.fillMaxWidth()){Text("MORE ORIGINAL HISTORY")}}
    }
}
