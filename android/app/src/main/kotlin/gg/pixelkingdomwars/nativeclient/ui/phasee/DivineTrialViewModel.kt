package gg.pixelkingdomwars.nativeclient.ui.phasee
import gg.pixelkingdomwars.nativeclient.data.DivineTrialRepository
import gg.pixelkingdomwars.nativeclient.ui.ScreenViewModel
import kotlinx.serialization.json.JsonObject
class DivineTrialViewModel(val repository:DivineTrialRepository):ScreenViewModel() {
 val state=repository.state
 fun local()=run{repository.local()}
 fun discover(cursor:String?=null)=run{repository.discover(cursor)}
 fun select(event:JsonObject)=run{repository.select(event)}
 fun reopen(id:String)=run{repository.reopen(id)}
 fun check()=run{repository.check()}
 fun enter(base:String)=run{repository.enter(base)}
 fun admit(base:String)=run{repository.admit(base)}
 fun submit(attempt:String,orders:JsonObject)=run{repository.submit(attempt,orders)}
 fun abandon(attempt:String)=run{repository.abandon(attempt)}
 fun claim(base:String)=run{repository.claim(base)}
 fun retry(command:String)=run{repository.retry(command)}
 fun closeAbsent(command:String)=run{repository.closeAbsent(command)}
 fun dismiss()=repository.dismiss()
}
