package gg.pixelkingdomwars.nativeclient.ui.phasee

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.*
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.divinefragments.*
import gg.pixelkingdomwars.nativeclient.ui.Palette
import gg.pixelkingdomwars.nativeclient.ui.chrome.*
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import kotlinx.serialization.json.*

internal fun fragmentPill(c:DivineFragmentCommand)=when{c.receipt!=null->PaymentPill("DELIVERED",PaymentTone.DONE);c.closed&&c.sent->PaymentPill("CLOSED",PaymentTone.CLOSED);c.closed->PaymentPill("DRAFT CLOSED",PaymentTone.CLOSED);c.sent->PaymentPill("CHECK OUTCOME",PaymentTone.TROUBLE);else->PaymentPill("SAVED REVIEW",PaymentTone.OPEN)}
internal fun fragmentCanReview(c:DivineFragmentCommand,base:String?,allowed:Boolean,busy:Boolean)=c.unresolved&&c.base==base&&allowed&&!busy
private enum class FragmentTab(val label:String){EARNINGS("Earnings"),SHARES("Seeker shares"),HISTORY("History")}
@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable fun DivineFragmentScreen(model:DivineFragmentViewModel,selectedBase:String?,allowed:Boolean,onBack:()->Unit){
 val state by model.state.collectAsState();val notice by model.notice.collectAsState();val running by model.busy.collectAsState();val busy=state.busy||running
 var tab by rememberSaveable{mutableStateOf(FragmentTab.EARNINGS)};val error=remember{BringIntoViewRequester()};val commands=state.journal?.commands.orEmpty();val pending=commands.singleOrNull{it.unresolved};val review=state.review;val reviewed=commands.singleOrNull{it.key==review?.key}
 LaunchedEffect(notice){if(notice?.error==true)error.bringIntoView()}
 BackHandlerAt(BackPriority.SCREEN){model.dismiss();onBack()};BackHandlerAt(BackPriority.CONFIRM,review!=null){model.dismiss()}
 DesignedPage("CRYSTAL FRAGMENTS",{model.dismiss();onBack()}){
  Text("Earned for your kingdom",style=MaterialTheme.typography.titleLarge,color=SurfaceInk.goldHi)
  Text("Deliver Divine earnings and permanent Seeker shares into protected kingdom stock.",color=SurfaceInk.muted)
  PaymentPlate("KINGDOM STOCK",pill=PaymentPill(if(selectedBase==null)"SELECT KINGDOM" else "PROTECTED",PaymentTone.OPEN)){
   val stock=state.stock?.takeIf{it.ft("baseId")==selectedBase};Text(stock?.let{"${it.ft("available")} Crystal Fragments"}?:"Refresh the selected kingdom to see its current stock.",color=SurfaceInk.goldHi,style=MaterialTheme.typography.titleLarge)
   Text("Stored fragments stay with their kingdom. Undelivered earnings remain yours.",color=SurfaceInk.muted)
   OutlinedButton(onClick={model.stock()},enabled=!busy&&selectedBase!=null){Text("REFRESH STOCK")}
  }
  if(!allowed)Text("New destination actions are unavailable. Saved outcomes can still be checked.",color=SurfaceInk.muted)
  notice?.let{Text(it.message,Modifier.bringIntoViewRequester(error).semantics{liveRegion=LiveRegionMode.Polite},color=if(it.error)SurfaceInk.danger else SurfaceInk.success)}
  state.notice?.let{Text(it,color=SurfaceInk.success)}
  if(busy)LinearProgressIndicator(Modifier.fillMaxWidth())
  pending?.let{c->PaymentPlate(if(c.kind=="delivery")"SAVED EARNING DELIVERY" else "SAVED SEEKER SHARE",pill=fragmentPill(c),details=fragmentDetails(c)){
   if(c.kind=="delivery")Text(fragmentSourceSummary(c.consent.fo("award")),color=SurfaceInk.goldHi)
   Text(if(c.sent)"This exact request may already be accepted. Check its outcome before another action." else "Your destination and original entitlement are saved.",color=SurfaceInk.muted)
   OutlinedButton(onClick={model.check(c.key)},enabled=!busy){Text("CHECK SAVED OUTCOME")}
   if(fragmentCanReview(c,selectedBase,allowed,busy))Button(onClick={model.review(c.key)}){Text(if(c.sent)"REVIEW ORIGINAL RETRY" else "REVIEW SAVED REQUEST")}
   if(!c.sent)TextButton(onClick={model.abandon(c.key)},enabled=!busy){Text("CLOSE UNSENT DRAFT")}
   else{Text("If the server has no record of this request, close it to free new deliveries and claims. CLOSE checks first.",color=SurfaceInk.muted)
    TextButton(onClick={model.closeAbsent(c.key)},enabled=!busy){Text("CLOSE IF THE SERVER HAS NO RECORD")}}
  }}
  Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.spacedBy(4.dp)){FragmentTab.entries.forEach{t->OutlinedButton(onClick={tab=t},modifier=Modifier.weight(1f),enabled=!busy){Text(t.label,color=if(tab==t)SurfaceInk.goldHi else SurfaceInk.muted,style=MaterialTheme.typography.labelSmall)}}}
  when(tab){
   FragmentTab.EARNINGS->{OutlinedButton(onClick={model.discover("awards")},enabled=!busy){Text("REFRESH EARNINGS")};val page=state.awards
    if(page==null)Text("Check your settled Divine earnings. Existing sponsored prizes stay in Divine Trials.",color=SurfaceInk.muted)
    else{if(page.fr("rows").isEmpty())Text("No settled fragment earnings on this page.",color=SurfaceInk.muted);page.fr("rows").forEach{row->val a=row.fo("award");val delivered=row["delivery"]!=JsonNull
     PaymentPlate(fragmentSourceTitle(a),pill=PaymentPill(if(delivered)"DELIVERED" else "READY",if(delivered)PaymentTone.DONE else PaymentTone.OPEN),details=fragmentAwardDetails(a)){
      Text("${a.ft("net")} Crystal Fragments",color=SurfaceInk.goldHi,style=MaterialTheme.typography.titleLarge);Text(fragmentSourceSummary(a),color=SurfaceInk.muted);Text("${a.ft("gross")} earned · ${a.ft("tax")} original Seeker share · ${a.ft("net")} yours",color=SurfaceInk.muted)
      if(a.ft("poolDisposition")=="held_zero_winners")Text("The Seeker share stays held with its original term.",color=SurfaceInk.muted)
      if(!delivered)Button(onClick={model.delivery(a.ft("eventId"))},enabled=allowed&&!busy&&pending==null&&selectedBase!=null){Text("REVIEW DELIVERY")}
     }};page.getValue("nextCursor").takeUnless{it==JsonNull}?.let{next->OutlinedButton(onClick={model.discover("awards",next.jsonPrimitive.content)},enabled=!busy){Text("NEXT EARNINGS")}}}
   }
   FragmentTab.SHARES->{OutlinedButton(onClick={model.discover("claims")},enabled=!busy){Text("REFRESH FROM FIRST TERM")};val page=state.claims
    if(page==null)Text("Original winning spots keep their fragment rights after their operating term ends.",color=SurfaceInk.muted)
    else{if(page.fr("rows").isEmpty())Text("No retained fragment shares on this page.",color=SurfaceInk.muted);page.fr("rows").forEach{r->PaymentPlate("SEEKER SPOT ${r.fn("spotId")+1}",details=listOf(PaymentDetail("Term",r.ft("termId")),PaymentDetail("Original term ended",r.ft("endsAt")))){
     Text("${r.ft("claimable")} currently available",color=SurfaceInk.goldHi,style=MaterialTheme.typography.titleLarge);Text("${r.ft("previousTotal")} claimed · ${r.ft("cumulativeTotal")} cumulative share",color=SurfaceInk.muted)
     Button(onClick={model.claim(r)},enabled=allowed&&!busy&&pending==null&&selectedBase!=null&&r.fa("claimable").signum()>0){Text("REVIEW FRAGMENT SHARE")}
    }};page.getValue("nextCursor").takeUnless{it==JsonNull}?.let{next->OutlinedButton(onClick={model.discover("claims",next.jsonPrimitive.content)},enabled=!busy){Text("NEXT TERM")}}}
   }
   FragmentTab.HISTORY->{if(commands.none{!it.unresolved})Text("Original receipts will appear here after delivery.",color=SurfaceInk.muted);commands.asReversed().filter{!it.unresolved}.forEach{c->PaymentPlate(if(c.kind=="delivery")"EARNING DELIVERY" else "SEEKER SHARE",pill=fragmentPill(c),details=fragmentDetails(c)){
    if(c.kind=="delivery")Text(fragmentSourceSummary(c.consent.fo("award")),color=SurfaceInk.muted)
    if(c.closed&&c.sent)Text("Closed on this device: the server had no record of this request.",color=SurfaceInk.muted)
    c.receipt?.let{Text("${it.ft("quantity")} fragments delivered to the original kingdom.",color=SurfaceInk.goldHi);OutlinedButton(onClick={model.check(c.key)},enabled=!busy){Text("CHECK ORIGINAL RECEIPT")}}
   }}}
  }
 }
 if(review!=null&&reviewed!=null)AlertDialog(onDismissRequest={model.dismiss()},title={Text(if(reviewed.kind=="delivery")"DELIVER CRYSTAL FRAGMENTS" else "CLAIM FRAGMENT SHARE")},text={Column(verticalArrangement=Arrangement.spacedBy(8.dp)){
  Text(if(reviewed.kind=="delivery")"Deliver ${reviewed.consent.fo("award").ft("net")} fragments from this original earning." else "Claim the amount currently due to this original Seeker spot. The server computes the cumulative share.")
  if(reviewed.kind=="delivery")Text(fragmentSourceSummary(reviewed.consent.fo("award")),color=SurfaceInk.goldHi)
  Text("Destination kingdom",color=SurfaceInk.muted);Text(reviewed.base,color=SurfaceInk.goldHi);Text("Stored fragments stay with this kingdom if its ownership changes.",color=SurfaceInk.muted)
 }},confirmButton={Button(onClick={model.confirm(review)},enabled=!busy&&fragmentCanReview(reviewed,selectedBase,allowed,busy)){Text(if(reviewed.kind=="delivery")"DELIVER FRAGMENTS" else "CLAIM FRAGMENT SHARE")}},dismissButton={TextButton(onClick={model.dismiss()}){Text("BACK")}})
}
internal fun fragmentSourceTitle(award:JsonObject)=if("clan" in award)"DIVINE CLAN EARNING" else "DIVINE INDIVIDUAL EARNING"
internal fun fragmentSourceSummary(award:JsonObject):String {
 val clan=award["clan"]?.jsonObject ?: return "Original individual occupation"
 return "Original clan roster · ${clan.fn("rosterSize")} members · ${award.ft("gross")} gross per member from ${clan.ft("siteGross")} site allowance"
}
internal fun fragmentAwardDetails(award:JsonObject):List<PaymentDetail> {
 val common=listOf(PaymentDetail("Event",award.ft("eventId")),PaymentDetail("Earned (UTC)",award.ft("earnedAt")),PaymentDetail("Site",award.ft("site")),PaymentDetail("Seeker term",award.ft("termId")),PaymentDetail("Source hash",award.ft("sourceHash")))
 val clan=award["clan"]?.jsonObject ?: return common
 return common+listOf(PaymentDetail("Original clan",clan.ft("clanId")),PaymentDetail("Tournament entry",clan.ft("entryId")),PaymentDetail("Frozen roster hash",clan.ft("rosterHash")))+clan.fo("tournamentDomain").map{(key,value)->PaymentDetail("Tournament $key",value.jsonPrimitive.content)}
}
private fun fragmentDetails(c:DivineFragmentCommand)=listOf(PaymentDetail("Original kingdom",c.base),PaymentDetail("Request",c.key),PaymentDetail("Wallet",c.consent.ft("wallet")))+
 if(c.kind=="delivery")fragmentAwardDetails(c.consent.fo("award"))else listOf(PaymentDetail("Term",c.consent.fo("request").ft("termId")))
