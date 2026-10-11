package gg.pixelkingdomwars.nativeclient.ui.phasee
import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.ui.ScreenViewModel
import kotlinx.serialization.json.JsonObject
class DivineFragmentViewModel(val repository:DivineFragmentRepository):ScreenViewModel(){
 val state=repository.state
 fun local()=run{repository.local()}
 fun foreground()=run{repository.local();repository.discoverEntry()}
 fun discover(kind:String,cursor:String?=null)=run{repository.discover(kind,cursor)}
 fun stock()=run{repository.stock()}
 fun delivery(event:String)=run{repository.reviewDelivery(event)}
 fun claim(row:JsonObject)=run{repository.reviewClaim(row)}
 fun review(key:String)=run{repository.reviewSaved(key)}
 fun check(key:String)=run{repository.check(key)}
 fun confirm(review:DivineFragmentReview)=run{repository.confirm(review)}
 fun abandon(key:String)=run{repository.abandonDraft(key)}
 fun closeAbsent(key:String)=run{repository.closeAbsent(key)}
 fun dismiss()=repository.dismiss()
}
