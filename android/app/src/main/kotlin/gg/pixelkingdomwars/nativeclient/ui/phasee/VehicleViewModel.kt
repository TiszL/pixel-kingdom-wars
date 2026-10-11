package gg.pixelkingdomwars.nativeclient.ui.phasee
import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.ui.ScreenViewModel
import kotlinx.coroutines.Job
import kotlinx.serialization.json.JsonObject
class VehicleViewModel(private val repository:VehicleRepository,val wallet:VehicleWallet?=null,private val craft:VehicleCraftRepository?=null):ScreenViewModel() {
 val state=repository.state;private var last:Job?=null
 val craftState get()=craft?.state
 fun craftSelection(selection:VehicleCraftSelection?)=craft?.select(selection)
 fun craftHistory(cursor:String?=null)=action{craft?.history(cursor)}
 suspend fun craftForeground(){last?.join();craftHistory()?.join()}
 fun craftQuote()=action{craft?.quote()}
 fun craftRecover(key:String)=action{craft?.recover(key)}
 private fun action(block:suspend ()->Unit)=run(block).also{if(it!=null)last=it}
 suspend fun foreground(){last?.join();refresh()?.join()}
 fun refresh(cursor:String?=null)=action{repository.awaitIdle();repository.open(cursor)}
 fun assets(cursor:String?=null)=action{repository.assets(cursor)}
 fun fleet(base:String)=action{repository.fleet(base)}
 fun select(id:String)=action{repository.select(id)}
 fun history(item:JsonObject)=action{repository.openActivity(item)}
 fun check()=action{repository.check()}
 fun reserve(base:String,berth:String,asset:String)=action{repository.reserve(base,berth,asset)}
 fun service(base:String,installation:String,asset:String,operation:String)=action{repository.service(base,installation,asset,operation)}
 fun retry(id:String)=action{repository.retry(id)}
 fun command(name:String)=action{repository.command(name)}
 fun review()=action{repository.review()}
 fun approve()=action{repository.approve()}
 fun upload()=action{repository.upload()}
 fun deliver()=action{repository.deliver()}
 fun dispatch(base:String,installation:String,route:String,policyVersion:Long?=null)=action{repository.dispatch(base,installation,route,policyVersion)}
 fun collect(base:String)=action{repository.collect(base)}
 fun archive()=action{repository.archive()}
 fun closeUnknown()=action{repository.closeUnknown()}
 fun dismiss(){repository.dismiss();craft?.dismiss()}
}
