package gg.pixelkingdomwars.nativeclient.ui.phasee

import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.ui.ScreenViewModel
import kotlinx.coroutines.Job
import kotlinx.serialization.json.JsonObject

class KeepEquipmentMarketViewModel(private val repository:KeepEquipmentMarketRepository,val wallet:VehicleWallet?=null):ScreenViewModel(){
 val state=repository.state;private var last:Job?=null
 private fun action(block:suspend()->Unit)=run(block).also{if(it!=null)last=it}
 suspend fun foreground(){last?.join();refresh()?.join()}
 fun refresh()=action{repository.awaitIdle();repository.open()}
 fun page(kind:String)=action{repository.page(kind)}
 fun browse(category:String)=action{repository.browse(category)}
 fun check()=action{repository.check()}
 fun select(key:String)=action{repository.selectSaved(key)}
 fun history(row:JsonObject)=action{repository.openHistory(row)}
 fun list(item:String,quantity:String,price:String)=action{repository.reviewListing(item,quantity,price)}
 fun buy(listing:JsonObject,quantity:String)=action{repository.reviewFill(listing,quantity)}
 fun cancel(listing:JsonObject)=action{repository.reviewCancel(listing)}
 fun confirm()=action{repository.confirm()}
 fun retry(key:String)=action{repository.retry(key)}
 fun reviewSaved(key:String)=action{repository.reviewSaved(key)}
 fun command(name:String)=action{repository.command(name)}
 fun reviewPayment()=action{repository.reviewPayment()}
 fun approve(acceptRentCap:Boolean)=action{repository.approve(acceptRentCap)}
 fun send()=action{repository.send()}
 fun release()=action{repository.release()}
 fun discard(key:String)=action{repository.discard(key)}
 fun archive(key:String)=action{repository.archive(key)}
 fun dismiss()=repository.dismiss()
}
