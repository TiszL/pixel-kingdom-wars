package gg.pixelkingdomwars.nativeclient.ui.phasee

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.vehicle.*
import gg.pixelkingdomwars.nativeclient.ui.Palette
import gg.pixelkingdomwars.nativeclient.ui.chrome.Button
import gg.pixelkingdomwars.nativeclient.ui.chrome.OutlinedButton
import gg.pixelkingdomwars.nativeclient.ui.chrome.PixelPanel
import kotlinx.serialization.json.*

internal data class OrdinaryRouteChoice(val route:OrdinaryRoute,val preview:JsonObject?,val belowTier:Boolean,val access:String)
internal fun ordinaryRouteChoices(catalogue:OrdinaryRoutes,tier:Long,previews:List<JsonObject>):List<OrdinaryRouteChoice> {
 val current=previews.filter{CharterGrammar.number(it.getValue("policyVersion"))==catalogue.policyVersion}
 val home=current.firstOrNull()?.charterText("homeRealmId")
 require(current.all{it.charterText("homeRealmId")==home})
 return catalogue.routes.map{r->OrdinaryRouteChoice(r,current.singleOrNull{it.charterText("routeId")==r.id},tier<r.grade,
  if(home==null)"Check kingdom HOME and realm access" else if(home==r.realmId)"HOME" else "Paid realm access required")}
}
internal fun ordinaryRouteDispatchable(choice:OrdinaryRouteChoice,available:Boolean)=available&&!choice.belowTier&&choice.preview!=null
private fun label(id:String)=id.replace('-',' ').replace('_',' ').replaceFirstChar{it.uppercase()}

/** All installed entries remain discoverable, including below-tier routes. Only
 * an independently validated server preview can supply a dispatch action. */
@Composable internal fun OrdinaryRouteCatalogue(catalogue:OrdinaryRoutes,tier:Long,previews:List<JsonObject>,available:Boolean,
 art:@Composable (OrdinaryRouteCrop)->Unit,dispatch:(JsonObject)->Unit) {
 val choices=ordinaryRouteChoices(catalogue,tier,previews);val chains=catalogue.routes.map{it.chain}.distinct()
 var chain by rememberSaveable(catalogue.raw.toString()){mutableStateOf(chains.first())}
 var chosen by rememberSaveable(chain){mutableStateOf<String?>(null)}
 Text("ISLAND ROUTES · ${choices.size}",style=MaterialTheme.typography.titleMedium)
 Text("A preview does not verify a current permit. Dispatch checks this kingdom’s HOME, tier, supplies and realm coverage again.",color=Palette.muted)
 Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),horizontalArrangement=Arrangement.spacedBy(6.dp)) {
  chains.forEach{id->OutlinedButton(onClick={chain=id}){Text((if(chain==id)"◆ " else "")+label(id))}}
 }
 val shown=choices.filter{it.route.chain==chain};val selected=shown.singleOrNull{it.route.id==chosen}?:shown.first()
 shown.forEach{choice->OutlinedButton(onClick={chosen=choice.route.id},modifier=Modifier.fillMaxWidth()) {
  Column(Modifier.fillMaxWidth()) {
   Text((if(selected.route.id==choice.route.id)"◆ " else "")+label(choice.route.id)+" · Grade ${choice.route.grade}")
   Text("${label(choice.route.realmId)} · requires tier ${choice.route.grade}"+(if(choice.belowTier)" · upgrade needed" else if(choice.preview==null)" · preview unavailable" else ""),color=Palette.muted)
  }
 }}
 PixelPanel(Modifier.fillMaxWidth()) { Column(verticalArrangement=Arrangement.spacedBy(8.dp)) {
  art(catalogue.crop(selected.route.id))
  Text(label(selected.route.id),style=MaterialTheme.typography.titleMedium)
  Text("${label(selected.route.realmId)} · Grade ${selected.route.grade} · ${selected.access}")
  if(selected.belowTier)Text("Reach vehicle tier ${selected.route.grade} to preview provisions and cargo for this route.",color=Palette.muted)
  else if(selected.preview==null)Text("Refresh the fleet and routes to obtain a current preview.",color=Palette.muted)
  selected.preview?.let{route->
   Text("Duration: ${route["durationSec"]} seconds")
   Text("Provisions: "+route.getValue("supplies").jsonArray.joinToString { val supply=it.jsonObject;"${label(supply.charterText("resourceId"))} ${supply["quantity"]}" })
   Text("Cargo: ${route["grossQuantity"]} gross · ${route["islandPoolQuantity"]} island tax · ${route["netQuantity"]} net ${label(route.charterText("resourceId"))}")
   Button(onClick={dispatch(route)},enabled=ordinaryRouteDispatchable(selected,available)){Text("DISPATCH ${label(selected.route.id).uppercase()}")}
  }
 }}
}
