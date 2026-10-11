@file:OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
package gg.pixelkingdomwars.nativeclient.ui.phasee

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.keepequipmentmarket.*
import gg.pixelkingdomwars.nativeclient.network.fmtN
import gg.pixelkingdomwars.nativeclient.ui.Palette
import gg.pixelkingdomwars.nativeclient.ui.chrome.*
import gg.pixelkingdomwars.nativeclient.ui.model.TabUi
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import gg.pixelkingdomwars.nativeclient.ui.security.SensitiveMfaDialog
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.MarketOwnerSealDialog
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.MarketSealTap
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.keepMarketFreshCommandReview
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.keepMarketCommandSeal
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import java.math.BigDecimal
import java.math.BigInteger
import kotlinx.serialization.json.*

private enum class MarketPage(val title:String,val icon:String){LISTINGS("Listings","bag"),SELL("Sell","keep"),HISTORY("History","replay")}
internal fun keepMarketName(id:String)=if(id in KeepEquipmentMarketCatalogue.itemIds)id.split('_').joinToString(" "){it.replaceFirstChar(Char::uppercaseChar)}else "Goods"
internal fun keepMarketItems(category:String)=KeepEquipmentMarketCatalogue.itemIds.filter{KeepEquipmentMarketCatalogue.category(it)==category}
internal fun keepMarketStockNote(item:String):String?=if(item=="crystal_fragment")"Protected kingdom stock. Trading moves listed fragments only; unclaimed awards and island shares stay with their original recipients."else null
internal fun keepMarketStockLabels(item:String)=listOf("available" to "Available","reserved" to if(item in KeepEquipmentMarketCatalogue.equipmentIds)"Reserved for trips"else "Reserved",
 "pendingOutput" to "In production","marketOutgoing" to "Listed / buyer holds","marketIncoming" to "Incoming purchases").filterNot{item=="crystal_fragment"&&it.first in setOf("reserved","pendingOutput")}
internal fun keepMarketAmount(units:String,decimals:Int)=BigDecimal(units.toBigInteger(),decimals).stripTrailingZeros().toPlainString()
internal fun keepMarketPrice(value:String,decimals:Int):String?=runCatching{require(value.length in 1..48&&value.matches(Regex("(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?")));val n=BigDecimal(value).movePointRight(decimals).toBigIntegerExact();require(n.signum()>0&&n.bitLength()<=64);n.toString()}.getOrNull()
internal fun keepMarketTitle(r:KeepEquipmentMarketRecord):String {val item=r.response?.let{if(r.kind=="fill")it.charterObject("fill")["itemId"]else it["itemId"]}?:r.request["itemId"]?:r.preview?.get("itemId");val name=item?.let{keepMarketName(CharterGrammar.text(it))}?:"Goods";return when(r.kind){"listing"->"Sell $name";"fill"->"Buy $name";else->"Return unsold $name"}}
internal fun keepMarketPill(r:KeepEquipmentMarketRecord)=when{
 r.held->PaymentPill("CHECK NEEDED",PaymentTone.TROUBLE)
 r.discardedUnsent->PaymentPill("DRAFT CLOSED",PaymentTone.CLOSED)
 r.closedAbsent&&r.response==null->PaymentPill("CLOSED",PaymentTone.CLOSED)
 r.response==null->PaymentPill(if(r.attempts.isEmpty())"SAVED DRAFT"else"CHECK NEEDED",if(r.attempts.isEmpty())PaymentTone.OPEN else PaymentTone.TROUBLE)
 r.kind=="listing"->PaymentPill(if(r.response.amount("availableQuantity").signum()>0)"LISTED"else"CLOSED",PaymentTone.SENT)
 r.kind=="cancellation"->PaymentPill("RETURNED",PaymentTone.DONE)
 r.response["release"]!=null->PaymentPill("RESERVATION CLOSED",PaymentTone.CLOSED)
 r.response["delivery"]!=JsonNull->PaymentPill("DELIVERED",PaymentTone.DONE)
 r.signed!=null||r.response["wire"]!=JsonNull->PaymentPill("PAYMENT SAVED",PaymentTone.SENT)
 "wallet" in r.attempts->PaymentPill("CHECK NEEDED",PaymentTone.TROUBLE)
 else->PaymentPill("PAYMENT NOT RECORDED",PaymentTone.OPEN)
}
internal fun keepMarketCanRecover(r:KeepEquipmentMarketRecord)=r.kind=="fill"&&!r.held&&r.response?.let{it["wire"]!=JsonNull&&it["delivery"]==JsonNull&&it["release"]==null}==true
internal fun keepMarketReleaseAction(r:KeepEquipmentMarketRecord):String? {val v=r.response?:return null;if(r.kind!="fill"||r.held||KeepEquipmentMarketProtocol.terminalPurchase(v))return null;return when{v["preparation"]==JsonNull->"cancel";v["wire"]!=JsonNull||r.signed!=null->"failure";else->null}}
/** One explicit primary action. A lost wallet result never exposes approval again. */
internal fun keepMarketPrimary(state:KeepEquipmentMarketState):String? {
 if(state.commandReview!=null)return "confirm"
 val r=state.selected?:return null;if(r.discardedUnsent)return null
 if(r.held)return "check"
 val v=r.response?:return "check"
 if(r.kind!="fill"||KeepEquipmentMarketProtocol.terminalPurchase(v))return null
 if(r.signed!=null||v["wire"]!=JsonNull)return "send"
 if("wallet" in r.attempts)return "recover"
 if(v["preparation"]==JsonNull)return "prepare"
 return if(state.paymentReview!=null)"approve"else"review"
}

@Composable fun KeepEquipmentMarketScreen(model:KeepEquipmentMarketViewModel,selectedBase:String?,allowed:Boolean,configured:Boolean,back:()->Unit){
 val state by model.state.collectAsState();val running by model.busy.collectAsState();val notice by model.notice.collectAsState();val idle=!running&&!state.busy
 val mfa=model.wallet?.mfa?.collectAsState()?.value
 val sealReview=keepMarketFreshCommandReview(state).takeIf{mfa==null}
 val lifecycle=LocalLifecycleOwner.current.lifecycle
 val currentlyAllowed by rememberUpdatedState(allowed)
 var page by rememberSaveable{mutableStateOf(MarketPage.LISTINGS)};val scroll=rememberScrollState();val selected=state.selected
 val reviewKey=state.paymentReview?.charterObject("current")?.charterText("messageSha256");var rentAccepted by remember(reviewKey){mutableStateOf(false)}
 val primary=keepMarketPrimary(state);val create=selected?.response?.charterOptional("preparation")?.charterObject("original")?.let{!CharterGrammar.bool(it.getValue("sellerAtaExists"))}==true
 LaunchedEffect(page,state.selectedKey,state.commandReview?.key,reviewKey){scroll.scrollTo(0)}
 LaunchedEffect(state.commandReview?.key){if(state.commandReview!=null)page=MarketPage.HISTORY}
 BackHandlerAt(BackPriority.SCREEN){model.dismiss();back()}
 // Second old-screen sweep (owner 2026-10-06): the designed TALL sheet with the kit tab strip; the one primary is its
 // pinned footer. Every sentence, control and gate below is unchanged (the consent wording lives here).
 val footer:(@Composable ColumnScope.()->Unit)?=if(primary!=null&&sealReview==null)({
   val fresh=primary in setOf("confirm","prepare","review","approve","send");val needsWallet=primary in setOf("prepare","review","approve","send")
   Button(onClick={when(primary){"confirm"->model.confirm();"prepare"->model.command("prepare");"review"->model.reviewPayment();"approve"->model.approve(rentAccepted);"send"->model.send();"recover"->model.command("recover");else->model.check()}},enabled=idle&&(!fresh||allowed)&&(!needsWallet||configured)&&(primary!="approve"||!create||rentAccepted),modifier=Modifier.fillMaxWidth().heightIn(min=54.dp)){
    Text(when(primary){"confirm"->when(state.commandReview?.kind){"listing"->"LIST GOODS";"fill"->"RESERVE PURCHASE";else->"RETURN UNSOLD STOCK"};"prepare"->"PREPARE PAYMENT";"review"->"REVIEW PAYMENT";"approve"->"APPROVE IN WALLET";"send"->"SEND SAVED PAYMENT";else->"CHECK SAVED PAYMENT"})
   }
   Text(if(primary=="approve")"Signs the exact payment shown above. Sending is a separate step."else if(primary=="send")"Sends only the saved signed payment."else "Your original request is preserved in History.",style=MaterialTheme.typography.labelSmall,color=SurfaceInk.muted)
  })else null
 DesignedPage("KEEP MARKET",{model.dismiss();back()},tabs=MarketPage.entries.map{TabUi(it.name,it.icon,it.title.uppercase(),null,false)},
  selectedTab=page.name,onTab={id->MarketPage.entries.firstOrNull{it.name==id}?.let{page=it}},scrollState=scroll,footer=footer){
  if(!idle)LinearProgressIndicator(Modifier.fillMaxWidth())
   Row(verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.spacedBy(10.dp)){GameArt("bag",Modifier.size(40.dp));Column{Text("Trade kingdom supplies",style=MaterialTheme.typography.titleMedium,color=SurfaceInk.goldHi);Text("Trade refined resources, Crystal Fragments and crafted items with wallet KEEP.",color=SurfaceInk.muted)}}
   Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.spacedBy(6.dp)){for((category,label)in listOf("resources" to "Resources","items" to "Items"))OutlinedButton(
    onClick={model.browse(category)},enabled=idle,modifier=Modifier.weight(1f).semantics{this.selected=state.category==category}){Text(label,color=if(state.category==category)SurfaceInk.goldHi else SurfaceInk.text)}}
   if(selectedBase==null)Text("Select a deeded kingdom to list or buy. Saved history stays available.",color=SurfaceInk.muted)
   if(!configured)Text("Wallet payments are not available in this build. Your saved requests remain recoverable.",color=SurfaceInk.muted)
   notice?.let{Text(it.message,color=if(it.error)SurfaceInk.danger else SurfaceInk.muted)};state.error?.let{Text(it,color=SurfaceInk.danger)};state.notice?.let{Text(it,color=SurfaceInk.goldHi)}
   state.commandReview?.takeIf{sealReview==null}?.let{MarketCommandReview(it,selectedBase)}
   if(selected!=null&&state.commandReview==null)MarketSaved(selected,state,selectedBase,idle,allowed,model,create,rentAccepted,{rentAccepted=it})
   when(page){
    MarketPage.LISTINGS->{
     val offers=state.listings?.getValue("items")?.jsonArray.orEmpty();if(offers.isEmpty())MarketPanel(if(state.listings==null)"Listings unavailable"else "No ${state.category} listed"){Text("Refresh to check this category, or list available stock from your kingdom in Sell.",color=SurfaceInk.muted)}
     offers.forEach{MarketOffer(it.jsonObject,state.policy,selectedBase,state.journal?.identity?.wallet,idle&&allowed,configured,model)}
     if(state.listings?.get("nextCursor") is JsonObject)OutlinedButton(onClick={model.page("listings")},enabled=idle,modifier=Modifier.fillMaxWidth()){Text("MORE LISTINGS")}
    }
    MarketPage.SELL->MarketSell(state,selectedBase,idle&&allowed,model)
    MarketPage.HISTORY->MarketHistory(state,idle,model)
   }
   OutlinedButton(onClick={model.refresh()},enabled=idle,modifier=Modifier.fillMaxWidth()){Text("REFRESH MARKET")}
   Text("Purchases arrive in the kingdom saved with the order. Changing kingdoms or closing this screen keeps that destination.",style=MaterialTheme.typography.bodySmall,color=SurfaceInk.muted)
 }
 sealReview?.let{review->
  val armedAt=remember(review){System.currentTimeMillis()}
  val tap=remember(review){MarketSealTap(review)}
  MarketOwnerSealDialog(keepMarketCommandSeal(review,selectedBase,armedAt,allowed,!idle),
   onConfirm={
    val current=keepMarketFreshCommandReview(model.state.value)
    val admitted=currentlyAllowed&&!model.busy.value&&!model.state.value.busy&&model.wallet?.mfa?.value==null&&lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)
    if(tap.take(current,admitted))model.confirm()
   },onBack={if(!model.busy.value&&!model.state.value.busy&&model.state.value.commandReview==review)model.dismiss()})
 }
 model.wallet?.let{wallet->val mfa by wallet.mfa.collectAsState();val request=mfa;if(request!=null){BackHandlerAt(BackPriority.CONFIRM){wallet.cancelMfa(request)};SensitiveMfaDialog(request,submit={wallet.submitMfa(request,it)},cancelRequest={wallet.cancelMfa(request)})}}
}

@Composable private fun MarketOffer(offer:JsonObject,policy:JsonObject?,base:String?,wallet:String?,enabled:Boolean,configured:Boolean,model:KeepEquipmentMarketViewModel){
 var quantity by rememberSaveable(offer.charterText("id")){mutableStateOf("1")};val decimals=policy?.number("decimals")?.toInt();val q=quantity.toBigIntegerOrNull();val total=q?.let{it*offer.amount("unitPriceBaseUnits")};val ready=q!=null&&q.signum()>0&&q<=offer.amount("availableQuantity")&&total!!.bitLength()<=64&&policy!=null&&total>=policy.amount("minFillBaseUnits")
 MarketPanel(keepMarketName(offer.charterText("itemId"))){
  keepMarketStockNote(offer.charterText("itemId"))?.let{Text(it,color=SurfaceInk.muted)}
  Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceBetween){Text("${fmtN(offer.charterText("availableQuantity"))} available",color=SurfaceInk.goldHi);Text(if(decimals==null)"Price unavailable"else "${keepMarketAmount(offer.charterText("unitPriceBaseUnits"),decimals)} KEEP each")}
  if(offer.charterText("sellerBaseId")==base){Text("Listed from this kingdom",color=SurfaceInk.muted);OutlinedButton(onClick={model.cancel(offer)},enabled=enabled&&offer.amount("availableQuantity").signum()>0,modifier=Modifier.fillMaxWidth()){Text("REVIEW UNSOLD RETURN")}}
  else if(offer.charterText("sellerWallet")==wallet)Text("Your listing · open the original kingdom to manage it.",color=SurfaceInk.muted)
  else{
   OutlinedTextField(quantity,{if(it.length<=19&&it.all(Char::isDigit))quantity=it},label={Text("Quantity")},singleLine=true,keyboardOptions=KeyboardOptions(keyboardType=KeyboardType.Number),enabled=enabled,modifier=Modifier.fillMaxWidth())
   if(total!=null&&decimals!=null)Text("Total ${keepMarketAmount(total.toString(),decimals)} KEEP",color=SurfaceInk.goldHi)
   policy?.let{if(!ready)Text("Minimum purchase ${keepMarketAmount(it.charterText("minFillBaseUnits"),it.number("decimals").toInt())} KEEP; quantity must be available.",style=MaterialTheme.typography.bodySmall,color=SurfaceInk.muted)}
   Button(onClick={model.buy(offer,quantity)},enabled=enabled&&configured&&base!=null&&ready,modifier=Modifier.fillMaxWidth()){Text("REVIEW PURCHASE")}
  }
 }
}
@Composable private fun MarketSell(state:KeepEquipmentMarketState,base:String?,enabled:Boolean,model:KeepEquipmentMarketViewModel){
 val choices=keepMarketItems(state.category);var item by rememberSaveable(base,state.category){mutableStateOf(choices.first())};var quantity by rememberSaveable(base){mutableStateOf("1")};var price by rememberSaveable(base){mutableStateOf("")};var chooseItem by remember(base,state.category){mutableStateOf(false)}
 val stock=state.stock?.takeIf{it.charterText("baseId")==base};val policy=stock?.charterObject("policy");val current=stock?.getValue("items")?.jsonArray?.singleOrNull{it.jsonObject.charterText("itemId")==item}?.jsonObject
 MarketPanel("From this kingdom"){
  keepMarketStockNote(item)?.let{Text(it,color=SurfaceInk.muted)}
  Box{OutlinedButton(onClick={chooseItem=true},enabled=enabled,modifier=Modifier.fillMaxWidth().heightIn(min=48.dp)){Text(keepMarketName(item))}
   DropdownMenu(expanded=chooseItem,onDismissRequest={chooseItem=false}){choices.forEach{choice->DropdownMenuItem(text={Text(keepMarketName(choice))},onClick={item=choice;chooseItem=false})}}}
  if(current==null)Text("Select and refresh an owned deeded kingdom to see stock for ${keepMarketName(item)}.",color=SurfaceInk.muted)else{
   FlowRow(horizontalArrangement=Arrangement.spacedBy(16.dp),verticalArrangement=Arrangement.spacedBy(8.dp)){for((key,label)in keepMarketStockLabels(item)){Column{Text(fmtN(current.charterText(key)),color=SurfaceInk.goldHi,style=MaterialTheme.typography.titleMedium);Text(label,style=MaterialTheme.typography.labelSmall,color=SurfaceInk.muted)}}}
   HorizontalDivider();OutlinedTextField(quantity,{if(it.length<=19&&it.all(Char::isDigit))quantity=it},label={Text("Quantity to list")},singleLine=true,keyboardOptions=KeyboardOptions(keyboardType=KeyboardType.Number),enabled=enabled,modifier=Modifier.fillMaxWidth())
   OutlinedTextField(price,{if(it.length<=40&&it.all{c->c.isDigit()||c=='.'})price=it},label={Text("Price per item · KEEP")},singleLine=true,keyboardOptions=KeyboardOptions(keyboardType=KeyboardType.Decimal),enabled=enabled,modifier=Modifier.fillMaxWidth())
   val units=policy?.let{keepMarketPrice(price,it.number("decimals").toInt())};val q=quantity.toBigIntegerOrNull();val ready=units!=null&&q!=null&&q.signum()>0&&q<=current.amount("available")
   Text("Listed units leave available stock. You can return only units that buyers have not reserved.",style=MaterialTheme.typography.bodySmall,color=SurfaceInk.muted)
   Button(onClick={model.list(item,quantity,requireNotNull(units))},enabled=enabled&&ready,modifier=Modifier.fillMaxWidth()){Text("REVIEW LISTING")}
  }
 }
}
@Composable private fun MarketCommandReview(r:KeepEquipmentMarketRecord,base:String?){
 val item=r.request["itemId"]?:r.preview?.get("itemId");val quantity=r.request["quantity"]?:r.preview?.get("availableQuantity");val target=r.request["baseId"]?:r.request["buyerBaseId"]?:r.preview?.get("sellerBaseId")
 PaymentPlate(keepMarketTitle(r),pill=PaymentPill("REVIEW",PaymentTone.OPEN),details=listOf(PaymentDetail("Request",r.key),PaymentDetail("Original kingdom",target?.jsonPrimitive?.content.orEmpty())),footnote="Changing current choices will not change this saved request."){
  Text("${quantity?.jsonPrimitive?.content.orEmpty()} × ${item?.let{keepMarketName(CharterGrammar.text(it))}.orEmpty()}",style=MaterialTheme.typography.titleMedium,color=SurfaceInk.goldHi)
  Text(if(target==base?.let(::JsonPrimitive))"Original destination: this kingdom"else"Original destination: another saved kingdom",color=SurfaceInk.muted)
  if(r.kind!="cancellation"){val unit=r.request["unitPriceBaseUnits"]?:r.preview?.get("unitPriceBaseUnits");if(unit!=null&&quantity!=null)Text("Total ${keepMarketAmount((CharterGrammar.amount(unit)*CharterGrammar.amount(quantity)).toString(),r.policy.number("decimals").toInt())} KEEP",color=SurfaceInk.goldHi)}
  Text(when(r.kind){"listing"->"Confirm to move these available units into the market.";"fill"->"Confirm to reserve these units. You will review wallet payment next. An unresolved reservation remains saved.";else->"Returns only the unreserved remainder to its original kingdom. Existing purchases stay reserved."},color=SurfaceInk.muted)
 }
}
@Composable private fun MarketSaved(r:KeepEquipmentMarketRecord,state:KeepEquipmentMarketState,base:String?,idle:Boolean,allowed:Boolean,model:KeepEquipmentMarketViewModel,create:Boolean,rentAccepted:Boolean,onRent:(Boolean)->Unit){
 val purchase=r.response?.takeIf{r.kind=="fill"};val fill=purchase?.charterObject("fill");val p=purchase?.charterOptional("preparation");val release=purchase?.get("release")?.jsonObject;val c=if(release!=null)null else state.paymentReview?.charterObject("current")?.charterObject("costs")?:p?.charterObject("costs");val total=fill?.charterText("totalBaseUnits");val decimals=r.policy.number("decimals").toInt()
 val details=mutableListOf(PaymentDetail("Request",r.key));fill?.let{details+=PaymentDetail("Original receiving kingdom",it.charterText("buyerBaseId"));details+=PaymentDetail("Seller wallet",it.charterText("sellerWallet"))};p?.let{details+=PaymentDetail("Payment message",it.charterText("messageSha256"));details+=PaymentDetail("KEEP mint",it.charterText("expectedKeepMint"));details+=PaymentDetail("Network",it.charterText("expectedGenesisHash"))};(r.signed?:purchase?.charterOptional("wire"))?.let{details+=PaymentDetail("Signature",it.charterText("signature"))}
 PaymentPlate(keepMarketTitle(r),pill=keepMarketPill(r),amount=total?.let{keepMarketAmount(it,decimals)},unit="KEEP",amountArt="keep",details=details,footnote="Closing this view preserves the original payment and receiving kingdom."){
  if(fill==null&&r.response==null){
   val qty=r.request["quantity"]?:r.preview?.get("availableQuantity");val item=r.request["itemId"]?:r.preview?.get("itemId")
   if(qty!=null&&item!=null)Text("${fmtN(CharterGrammar.text(qty))} × ${keepMarketName(CharterGrammar.text(item))}",style=MaterialTheme.typography.titleMedium,color=SurfaceInk.goldHi)
   (r.request["unitPriceBaseUnits"]?:r.preview?.get("unitPriceBaseUnits"))?.let{Text("${keepMarketAmount(CharterGrammar.text(it),decimals)} KEEP each",color=SurfaceInk.muted)}
  }
  if(fill!=null){Text("${fmtN(fill.charterText("quantity"))} × ${keepMarketName(fill.charterText("itemId"))}",style=MaterialTheme.typography.titleMedium,color=SurfaceInk.goldHi);Text(if(release!=null)"Original receiving kingdom preserved in this record"else if(fill.charterText("buyerBaseId")==base)"Arrives in this kingdom"else"Arrives in the original saved kingdom",color=SurfaceInk.muted)
   val gross=fill.amount("totalBaseUnits");val seller=gross*r.policy.number("sellerBps").toBigInteger()/r.policy.number("basisPoints").toBigInteger();Text(if(release!=null)"No KEEP paid to the seller · No KEEP burned"else"Seller receives ${keepMarketAmount(seller.toString(),decimals)} KEEP · ${keepMarketAmount((gross-seller).toString(),decimals)} KEEP is burned",style=MaterialTheme.typography.bodySmall,color=SurfaceInk.muted)
  }
  c?.let{HorizontalDivider();MarketValue("Network fee",keepMarketAmount(it.charterText("feeLamports"),9)+" SOL");MarketValue("Account creation allowance",keepMarketAmount(it.charterText("rentLamports"),9)+" SOL");MarketValue("Total SOL required",keepMarketAmount(it.charterText("totalLamports"),9)+" SOL")}
  if(create&&p!=null&&release==null){val cap=keepMarketAmount(p.charterObject("original").charterText("sellerAtaRentCapLamports"),9);Text("Seller account creation: up to $cap SOL. This app checks your cap; the blockchain instruction has no rent maximum. Unexpected paid outcomes stay held for recovery.",style=MaterialTheme.typography.bodySmall,color=SurfaceInk.muted);if(state.paymentReview!=null&&r.signed==null)Row(verticalAlignment=Alignment.CenterVertically){Checkbox(rentAccepted,onCheckedChange=onRent,enabled=idle);Text("I accept the account creation cost up to $cap SOL",Modifier.weight(1f))}}
  if(release!=null){Text("Reservation closed. These items returned to the seller's original kingdom. No goods were delivered to you.",color=SurfaceInk.goldHi)
   if(release.charterText("reason")=="finalized_failed")Text("The saved payment finalized as failed. Network fee paid: ${keepMarketAmount(release.charterObject("proof").charterText("feeLamports"),9)} SOL. KEEP and account creation effects were rolled back.",style=MaterialTheme.typography.bodySmall,color=SurfaceInk.muted)
   else Text("The reservation closed before a payment was prepared.",style=MaterialTheme.typography.bodySmall,color=SurfaceInk.muted)
  }
  keepMarketReleaseAction(r)?.let{action->
   Text(if(action=="cancel")"Cancel this reservation to return the items to the seller's original kingdom. No payment has been prepared."else"Check whether the saved payment finalized as failed. Missing or unresolved history keeps the reservation held.",style=MaterialTheme.typography.bodySmall,color=SurfaceInk.muted)
   OutlinedButton(onClick={model.release()},enabled=idle,modifier=Modifier.fillMaxWidth()){Text(if(action=="cancel")"CANCEL RESERVATION"else"CHECK FAILED PAYMENT")}
  }
  if(r.kind=="fill"&&p!=null&&purchase["wire"]==JsonNull&&r.signed==null&&release==null)Text("A payment was prepared. Cancellation remains unavailable until its original outcome can be established.",style=MaterialTheme.typography.bodySmall,color=SurfaceInk.muted)
  if(r.held)Text("The saved evidence needs checking. A replacement payment is blocked.",color=SurfaceInk.danger)
  if("wallet" in r.attempts&&r.signed==null&&purchase?.get("wire")==JsonNull)Text("The wallet outcome is uncertain. Check this original payment; another approval is blocked.",color=SurfaceInk.muted)
  if(r.kind=="listing"&&r.response!=null){MarketValue("Still available",r.response.charterText("availableQuantity"));MarketValue("Buyer reservations",r.response.charterText("reservedQuantity"));MarketValue("Returned",r.response.charterText("cancelledQuantity"));OutlinedButton(onClick={model.cancel(r.response)},enabled=idle&&allowed&&r.response.charterText("sellerBaseId")==base&&r.response.amount("availableQuantity").signum()>0,modifier=Modifier.fillMaxWidth()){Text("REVIEW UNSOLD RETURN")}}
  if(r.kind=="cancellation"&&r.response!=null)Text("${fmtN(r.response.charterText("quantity"))} units returned to the original kingdom.",color=SurfaceInk.goldHi)
  Column(verticalArrangement=Arrangement.spacedBy(8.dp)){
   OutlinedButton(onClick={model.select(r.key)},enabled=idle,modifier=Modifier.fillMaxWidth()){Text("CHECK RECORD")}
   if(keepMarketCanRecover(r))OutlinedButton(onClick={model.command("recover")},enabled=idle,modifier=Modifier.fillMaxWidth()){Text("CHECK SAVED PAYMENT")}
   if(r.response==null&&!r.discardedUnsent&&!r.closedAbsent)OutlinedButton(onClick={if(r.attempts.isEmpty())model.reviewSaved(r.key)else model.retry(r.key)},enabled=idle&&allowed&&!r.held,modifier=Modifier.fillMaxWidth()){Text(if(r.attempts.isEmpty())"REVIEW SAVED REQUEST"else"RETRY ORIGINAL")}
  }
  if(r.closedAbsent&&r.response==null)Text("Closed on this device after the server had no record of this request.",color=SurfaceInk.muted)
  // Owner rule 2026-10-06: a sent request the server does not know may close after a fresh check, so it never blocks trading forever.
  if(r.response==null&&r.attempts.all{it.startsWith("post:")}&&r.signed==null&&!r.discardedUnsent&&!r.closedAbsent)OutlinedButton(onClick={model.discard(r.key)},enabled=idle&&!r.held){Text(if(r.attempts.isEmpty())"CLOSE UNSENT DRAFT"else"CHECK & CLOSE IF NOT FOUND")}
  if(state.journal?.pending?.any{it.key==r.key}==true&&r.response!=null&&(r.kind!="fill"||purchase?.let(KeepEquipmentMarketProtocol::terminalPurchase)==true))OutlinedButton(onClick={model.archive(r.key)},enabled=idle&&!r.held){Text("ARCHIVE COMPLETED RECORD")}
 }
}
@Composable private fun MarketHistory(state:KeepEquipmentMarketState,idle:Boolean,model:KeepEquipmentMarketViewModel){
 MarketPanel("Saved on this device"){
  Text("Original requests from both categories stay here, including after you change the current category.",color=SurfaceInk.muted,style=MaterialTheme.typography.bodySmall)
  val records=state.journal?.records.orEmpty();if(records.isEmpty())Text("Your original listings, purchases and returns will appear here.",color=SurfaceInk.muted)
  records.asReversed().forEach{r->OutlinedButton(onClick={model.select(r.key)},enabled=idle,modifier=Modifier.fillMaxWidth()){Column(Modifier.weight(1f)){Text(keepMarketTitle(r));Text(keepMarketPill(r).label,style=MaterialTheme.typography.labelSmall,color=SurfaceInk.muted)}}}
 }
 MarketPanel("Account history"){
  val rows=state.history?.getValue("items")?.jsonArray.orEmpty();if(rows.isEmpty())Text("No recorded market activity on this page.",color=SurfaceInk.muted)
  rows.forEach{row->val r=row.jsonObject;OutlinedButton(onClick={model.history(r)},enabled=idle,modifier=Modifier.fillMaxWidth()){Column(Modifier.weight(1f)){Text(keepMarketName(r.charterText("itemId"))+" · "+when(r.charterText("kind")){"listing"->"Listing";"fill"->"Purchase";else->"Unsold return"});Text(r.charterText("createdAt").substringBefore('T'),style=MaterialTheme.typography.labelSmall,color=SurfaceInk.muted)}}}
  if(state.history?.get("nextCursor") is JsonObject)OutlinedButton(onClick={model.page("history")},enabled=idle,modifier=Modifier.fillMaxWidth()){Text("OLDER ACTIVITY")}
 }
}
@Composable private fun MarketPanel(title:String,content:@Composable ColumnScope.()->Unit){PixelPanel(Modifier.fillMaxWidth()){Column(Modifier.fillMaxWidth().padding(12.dp),verticalArrangement=Arrangement.spacedBy(10.dp)){Text(title,style=MaterialTheme.typography.titleMedium,color=SurfaceInk.goldHi);content()}}}
@Composable private fun MarketValue(label:String,value:String){Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.spacedBy(12.dp)){Text(label,Modifier.weight(1f),color=SurfaceInk.muted);Text(value,color=SurfaceInk.goldHi)}}
