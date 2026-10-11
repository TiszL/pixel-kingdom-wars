package gg.pixelkingdomwars.nativeclient.ui.phasee
import gg.pixelkingdomwars.nativeclient.data.EquipmentRepository
import gg.pixelkingdomwars.nativeclient.ui.ScreenViewModel
import kotlinx.coroutines.Job
import kotlinx.serialization.json.JsonObject
class EquipmentViewModel(private val repository:EquipmentRepository):ScreenViewModel(){
 val state=repository.state;private var last:Job?=null
 private fun action(block:suspend()->Unit)=run(block).also{if(it!=null)last=it}
 suspend fun foreground(){last?.join();refresh()?.join()}
 fun refresh()=action{repository.awaitIdle();repository.open()}
 fun check()=action{repository.check()}
 fun choose(item:String,resource:String?=null)=action{repository.choose(item,resource)}
 fun craft()=action{repository.reviewCraft()}
 fun trip(kind:String,installation:String,preview:JsonObject,realm:String?=null)=action{repository.reviewTrip(kind,installation,preview,realm)}
 fun paid(realm:String)=action{repository.paid(realm)}
 fun confirm()=action{repository.confirm()}
 fun retry(key:String)=action{repository.retry(key)}
 fun select(key:String)=action{repository.select(key)}
 fun collect()=action{repository.collect()}
 fun discard(key:String)=action{repository.discard(key)}
 fun archive(key:String)=action{repository.archive(key)}
 fun dismiss()=repository.dismiss()
}
